import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { authorizeAndStart, getCodexEnvironment } from '../models/codex.js';

const REQUEST_TIMEOUT_MS = 120000;
const helperPath = fileURLToPath(new URL('./owned_cli.js', import.meta.url));

// JSON-RPC transport only. The existing helper registers and reaps its owned CLI.
export class CodexSession {
    constructor({ model, effort = 'medium', record = () => {}, execute, onMessage = () => {} }) {
        Object.assign(this, { model, effort, record, execute, onMessage });
        this.pending = new Map();
        this.seq = 0;
        this.closed = false;
    }

    async open(instructions, signal) {
        this.signal = signal;
        this.requestId = randomUUID();
        this.cwd = await mkdtemp(path.join(tmpdir(), 'mindcraft-codex-'));
        await writeFile(path.join(this.cwd, '.mindcraft-codex-owner'), this.requestId, { flag: 'wx', mode: 0o600 });
        if (signal?.aborted) throw new Error('Session cancelled');
        const args = ['app-server', '--listen', 'stdio://', '--disable', 'shell_tool', '-c', 'web_search="disabled"'];
        this.child = spawn(process.execPath, [helperPath, this.requestId,
            process.env.MINDCRAFT_CODEX_BIN || 'codex', JSON.stringify(args), this.cwd],
        { cwd: this.cwd, env: getCodexEnvironment(), stdio: ['pipe', 'pipe', 'ignore', 'ipc'], detached: process.platform !== 'win32' });
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
        const response = await this.request('thread/start', {
            model: this.model, cwd: this.cwd, allowProviderModelFallback: false,
            config: { model_reasoning_effort: this.effort }, approvalPolicy: 'never', sandbox: 'read-only',
            ephemeral: true, environments: [], selectedCapabilityRoots: [], baseInstructions: instructions,
            dynamicTools: [{ type: 'function', name: 'minecraft_execute',
                description: 'Execute compound JavaScript with the Minecraft SDK. The host pauses this model turn while the operation runs and sends its completed result in the next turn of the same thread.',
                inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false } }],
        });
        if (response.model !== this.model || response.reasoningEffort !== this.effort) throw new Error('Codex model or reasoning effort mismatch');
        this.threadId = response.thread.id;
        this.record('thread_started', { threadId: this.threadId, model: response.model, effort: response.reasoningEffort });
    }

    send(message) {
        if (this.closed || this.signal?.aborted) throw new Error('Codex session is closed');
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
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
        this.pending.clear();
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
            if (p.tool !== 'minecraft_execute' || typeof p.arguments?.code !== 'string' || this.operation) {
                throw new Error('Only one Minecraft operation may run at a time');
            }
            this.record('tool_call', { code: p.arguments.code });
            // Install the promise before acknowledging or interrupting, including fast completion.
            this.operation = Promise.resolve().then(() => this.execute(p.arguments.code));
            this.operation.catch(() => {});
            this.pausedTurn = p.turnId;
            this.send({ id: message.id, result: { contentItems: [{ type: 'inputText', text: '{"status":"running","host_will_resume":true}' }], success: true } });
            // Pause inference only. The ActionManager operation deliberately continues.
            await this.request('turn/interrupt', { threadId: p.threadId, turnId: p.turnId });
        } else if (message.id !== undefined) {
            this.send({ id: message.id, error: { code: -32601, message: 'Only minecraft_execute is supported' } });
        } else if (message.method === 'item/started' && ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(message.params.item.type)) {
            throw new Error('Unexpected non-Minecraft tool');
        } else if (message.method === 'item/completed' && message.params.item.type === 'agentMessage') {
            this.messages.push(message.params.item.text);
            this.record('model_message', { text: message.params.item.text });
            this.onMessage(message.params.item.text);
        } else if (message.method === 'turn/completed') {
            const turn = message.params.turn;
            this.record('turn_completed', { id: turn.id, status: turn.status });
            if (turn.status === 'completed' || (turn.id === this.pausedTurn && turn.status === 'interrupted')) this.turn?.resolve();
            else this.turn?.reject(new Error(JSON.stringify(turn)));
        } else if (message.method === 'thread/tokenUsage/updated') this.record('token_usage', message.params);
    }

    async runTurn(input) {
        if (this.turn) throw new Error('Concurrent model turns are not supported');
        this.operation = null;
        this.pausedTurn = null;
        this.messages = [];
        let timer;
        const done = new Promise((resolve, reject) => {
            this.turn = { resolve, reject };
            timer = setTimeout(() => reject(new Error('Model turn timed out')), REQUEST_TIMEOUT_MS);
        });
        done.catch(() => {});
        try {
            await this.request('turn/start', { threadId: this.threadId, effort: this.effort, input: [{ type: 'text', text: input }] });
            await done;
            return { operation: this.operation, messages: this.messages };
        } finally { clearTimeout(timer); this.turn = null; }
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
            if (this.cwd) await rm(this.cwd, { recursive: true, force: true });
        })();
        return this.closing;
    }
}
