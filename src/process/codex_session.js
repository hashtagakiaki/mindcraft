import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { authorizeAndStart, getCodexEnvironment } from '../models/codex.js';

const REQUEST_TIMEOUT_MS = 120000;
const BOT_SKILL_CATALOG_TOKEN_LIMIT = 1;
const instructionsPath = new URL('./codex/AGENTS.md', import.meta.url);
const helperPath = fileURLToPath(new URL('./owned_cli.js', import.meta.url));

// JSON-RPC transport only. The existing helper registers and reaps its owned CLI.
export class CodexSession {
    constructor({ model, effort = 'medium', record = () => {}, execute, tools = [], catalog = '', readDocumentation,
        prepareResult = async result => ({ contentItems: [{ type: 'inputText', text: JSON.stringify(result) }], success: result.success !== false }),
        onMessage = () => {}, threadId = null, persistent = false }) {
        Object.assign(this, { model, effort, record, execute, tools, catalog, readDocumentation, prepareResult, onMessage, threadId, persistent });
        this.pending = new Map();
        this.seq = 0;
        this.closed = false;
        this.toolWork = Promise.resolve();
        this.waitingTools = 0;
    }

    async open(signal) {
        this.signal = signal;
        this.requestId = randomUUID();
        this.cwd = await mkdtemp(path.join(tmpdir(), 'mindcraft-codex-'));
        await writeFile(path.join(this.cwd, '.mindcraft-codex-owner'), this.requestId, { flag: 'wx', mode: 0o600 });
        // Let Codex discover fixed gameplay guidance through its standard workspace loader.
        const instructions = await readFile(instructionsPath, 'utf8');
        await writeFile(path.join(this.cwd, 'AGENTS.md'), instructions + (this.catalog ? '\n' + this.catalog + '\n' : ''));
        if (signal?.aborted) throw new Error('Session cancelled');
        const args = ['app-server', '--strict-config', '--listen', 'stdio://', '--disable', 'shell_tool', '-c', 'web_search="disabled"',
            '-c', 'features.code_mode.direct_only_tool_namespaces=["functions"]',
            '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.multi_agent=false',
            '-c', 'agents.enabled=false', '-c', 'cli_auth_credentials_store="file"',
            '-c', 'features.skill_search=false',
            '-c', `skills.max_context_tokens=${BOT_SKILL_CATALOG_TOKEN_LIMIT}`];
        // Share only existing file auth/config and durable rollouts, never global AGENTS/skills.
        // Keep normal credential refresh writing through the auth symlink.
        const env = getCodexEnvironment();
        const sourceHome = path.resolve(env.CODEX_HOME || path.join(homedir(), '.codex'));
        this.codexHome = await mkdtemp(path.join(this.cwd, 'codex-home-'));
        await mkdir(path.join(sourceHome, 'sessions'), { recursive: true });
        for (const name of ['auth.json', 'config.toml', 'sessions']) {
            await symlink(path.join(sourceHome, name), path.join(this.codexHome, name));
        }
        env.CODEX_HOME = this.codexHome;
        this.child = spawn(process.execPath, [helperPath, this.requestId,
            process.env.MINDCRAFT_CODEX_BIN || 'codex', JSON.stringify(args), this.cwd],
        { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'ignore', 'ipc'], detached: process.platform !== 'win32' });
        this.record('helper_started', { pid: this.child.pid });
        this.exited = new Promise(resolve => this.child.once('close', resolve));
        this.child.on('close', code => { this.closed = true; this.fail(new Error(`Codex session exited (${code})`)); });
        this.child.on('error', error => this.fail(error));
        this.child.on('message', message => {
            if (message.type === 'owned-cli-error') this.fail(new Error(message.message));
        });
        this.child.stdin.on('error', error => this.fail(error));
        this.lines = createInterface({ input: this.child.stdout });
        this.lines.on('line', line => {
            try { void this.receive(JSON.parse(line)).catch(error => this.fail(error)); }
            catch (error) { this.fail(error); }
        });
        this.onAbort = () => { this.fail(new Error('Session cancelled')); void this.close(); };
        signal?.addEventListener('abort', this.onAbort, { once: true });
        await authorizeAndStart(this.child, this.requestId, signal);
        await this.request('initialize', { clientInfo: { name: 'mindcraft_session', version: '0.1.0' }, capabilities: { experimentalApi: true } });
        this.send({ method: 'initialized' });
        const params = {
            model: this.model, cwd: this.cwd, allowProviderModelFallback: false,
            // Keep execution directly visible even when model metadata requests code_mode_only.
            // Deferred SDK documentation/search still uses Codex's native code-mode harness.
            config: { model_reasoning_effort: this.effort },
            approvalPolicy: 'never', sandbox: 'read-only',
        };
        let response;
        if (this.threadId) {
            response = await this.request('thread/resume', { ...params, threadId: this.threadId });
            this.resumed = true;
        } else response = await this.request('thread/start', { ...params,
            ephemeral: !this.persistent, selectedCapabilityRoots: [],
            dynamicTools: [{ type: 'function', name: 'minecraft_execute',
                description: 'Execute compound JavaScript with the Minecraft SDK. Await the actual completed result in this tool call; partial mutations survive failure. Discover SDK documentation before using unfamiliar methods.',
                inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false } }, ...this.tools],
        });
        if (response.model !== this.model || response.reasoningEffort !== this.effort) throw new Error('Codex model or reasoning effort mismatch');
        this.threadId = response.thread.id;
        this.record(this.resumed ? 'thread_resumed' : 'thread_started', { threadId: this.threadId, model: response.model,
            effort: response.reasoningEffort, instructionSources: response.instructionSources });
    }

    send(message) {
        if (this.closed || this.failure || this.signal?.aborted) throw new Error('Codex session is closed');
        this.child.stdin.write(JSON.stringify(message) + '\n');
    }

    request(method, params) {
        return new Promise((resolve, reject) => {
            const id = ++this.seq;
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, REQUEST_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            try { this.send({ id, method, params }); }
            catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
        });
    }

    fail(error) {
        this.failure ||= error;
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
        this.pending.clear();
        clearTimeout(this.modelTimer);
        this.turn?.reject(error);
    }

    async receive(message) {
        if (message.id !== undefined && !message.method) {
            const pending = this.pending.get(message.id);
            if (pending) {
                clearTimeout(pending.timer); this.pending.delete(message.id);
                message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
            }
            return;
        }
        if (message.method === 'item/tool/call') {
            const p = message.params;
            if (!this.turn || p.threadId !== this.threadId) throw new Error('Tool call outside the current thread');
            this.waitingTools++;
            clearTimeout(this.modelTimer);
            // Serialize parallel model calls: the host still owns one game operation at a time.
            const work = this.toolWork.then(async () => {
                if (this.signal?.aborted || this.closed || this.failure) throw new Error('Stale tool call');
                let result;
                if (!p.namespace && p.tool === 'minecraft_execute' && typeof p.arguments?.code === 'string') {
                    this.record('tool_call', { code: p.arguments.code });
                    result = await this.execute(p.arguments.code);
                } else if (p.namespace === 'minecraft_sdk' && this.readDocumentation) {
                    this.record('documentation_read', { name: p.tool });
                    result = { documentation: this.readDocumentation(p.tool) };
                } else result = { success: false, error: 'Unknown Minecraft SDK tool or invalid arguments' };
                // Fresh rules and inbox context belong in the actual tool result, before inference resumes.
                const response = await this.prepareResult(result);
                this.send({ id: message.id, result: response });
            });
            this.toolWork = work.catch(error => this.fail(error)).finally(() => {
                this.waitingTools--;
                if (!this.waitingTools) this.armModelTimer();
            });
            await this.toolWork;
        } else if (message.id !== undefined) {
            this.send({ id: message.id, error: { code: -32601, message: 'Only Minecraft execution/documentation calls are supported' } });
        } else if (message.method === 'item/started' && ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(message.params.item.type)) {
            throw new Error('Unexpected non-Minecraft tool');
        } else if (message.method === 'item/completed' && message.params.item.type === 'agentMessage') {
            const { text, phase } = message.params.item;
            if (phase !== 'commentary') this.messages.push(text);
            this.record('model_message', { text, phase });
            this.onMessage(text, phase);
        } else if (message.method === 'turn/completed') {
            const turn = message.params.turn;
            this.record('turn_completed', { id: turn.id, status: turn.status });
            if (turn.status === 'completed') this.turn?.resolve();
            else this.fail(new Error(JSON.stringify(turn)));
        } else if (message.method === 'thread/tokenUsage/updated') this.record('token_usage', message.params);
    }

    armModelTimer() {
        clearTimeout(this.modelTimer);
        if (this.turn && !this.failure && !this.waitingTools) this.modelTimer = setTimeout(() => this.fail(new Error('Model turn timed out')), REQUEST_TIMEOUT_MS);
    }

    async runTurn(input) {
        if (this.failure) throw this.failure;
        if (this.turn) throw new Error('Concurrent model turns are not supported');
        this.messages = [];
        const done = new Promise((resolve, reject) => {
            this.turn = { resolve, reject };
        });
        this.armModelTimer();
        done.catch(() => {});
        try {
            await this.request('turn/start', { threadId: this.threadId, effort: this.effort, input: [{ type: 'text', text: input }] });
            await done;
            return { messages: this.messages };
        } finally { clearTimeout(this.modelTimer); this.turn = null; }
    }

    close() {
        if (this.closing) return this.closing;
        this.closing = (async () => {
            this.signal?.removeEventListener('abort', this.onAbort);
            this.fail(new Error('Codex session closed'));
            if (this.child && !this.closed) {
                // Cancellation is sent to the verified helper, which kills and reaps its own group.
                try { this.child.send({ type: 'cancel', requestId: this.requestId }); } catch {}
                this.child.stdin.end();
                await this.exited;
            }
            this.lines?.close();
            await this.toolWork;
            if (this.cwd) await rm(this.cwd, { recursive: true, force: true });
        })();
        return this.closing;
    }
}
