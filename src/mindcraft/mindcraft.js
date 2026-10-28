import { createMindServer, registerAgent, unregisterAgent, numStateListeners, issueBotCredential, revokeBotCredential } from './mindserver.js';
import { AgentProcess } from '../process/agent_process.js';
import { getServer } from './mcserver.js';
import { getBotViewerPort } from '../utils/viewer_ports.js';
import { spawn } from 'node:child_process';
import open from 'open';
import rootSettings from '../../settings.js';
import { DiagnosticWriter } from '../agent/diagnostics_store.js';

let mindserver;
let connected = false;
let agent_processes = {};
let agent_count = 0;
let mindserver_port = 8080;
let shuttingDown = false;
let taskEndingHandler = null;
let shutdownHandler = null;
const pendingAgentStops = new Map();
const pendingAgentCreations = new Map();
let consoleDiagnosticWriter = null;
let maintenanceDiagnosticWriter = null;
let originalConsoleWrite = null;
let diagnosticsMaintenanceTimer = null;
let diagnosticsMaintenanceChild = null;
let diagnosticsMaintenancePromise = null;
const consoleLineBuffers = new Map();

function noteConsoleWriteFailure(error, detail) {
    consoleDiagnosticWriter.writeError ||= String(error);
    try { maintenanceDiagnosticWriter?.append('diagnostic_write_failure', { failedPool: 'console', ...detail,
        error: String(error).slice(0, 2000) }); } catch {}
}

function saveConsoleChunk(type, stream, text, identity = {}) {
    const key = `${identity.bot ?? 'parent'}:${stream}`;
    const previous = consoleLineBuffers.get(key) || { text: '', dropping: false };
    previous.type = type;
    previous.stream = stream;
    previous.identity = identity;
    let incoming = String(text);
    while (incoming.length) {
        if (previous.dropping) {
            const newline = incoming.indexOf('\n');
            if (newline < 0) { consoleLineBuffers.set(key, previous); return; }
            incoming = incoming.slice(newline + 1);
            previous.dropping = false;
        }
        const newline = incoming.indexOf('\n');
        const part = newline < 0 ? incoming : incoming.slice(0, newline + 1);
        previous.text += part;
        incoming = newline < 0 ? '' : incoming.slice(newline + 1);
        if (Buffer.byteLength(previous.text) > 64 * 1024) {
            try { consoleDiagnosticWriter.append('console_line_truncated', { stream, ...identity,
                bytesAtLimit: Buffer.byteLength(previous.text) }); }
            catch (error) { noteConsoleWriteFailure(error, { source: identity.bot ?? 'parent', stream }); }
            previous.text = '';
            previous.dropping = newline < 0;
            continue;
        }
        if (newline >= 0) {
            try { consoleDiagnosticWriter.append(type, { stream, ...identity, text: previous.text }); }
            catch (error) { noteConsoleWriteFailure(error, { source: identity.bot ?? 'parent', stream }); }
            previous.text = '';
        }
    }
    consoleLineBuffers.set(key, previous);
}

function initializeConsoleDiagnostics() {
    const diagnostics = rootSettings.diagnostics;
    if (!diagnostics) return;
    if (diagnostics.schema_version !== 1 || typeof diagnostics.root !== 'string')
        throw new Error('Invalid diagnostics settings for console storage');
    if (Number.isSafeInteger(diagnostics.console_limit_bytes) && diagnostics.console_limit_bytes > 0)
        consoleDiagnosticWriter = new DiagnosticWriter({ root: diagnostics.root, pool: 'console',
            limitBytes: diagnostics.console_limit_bytes,
            ownerRoot: diagnostics.owner_root ?? diagnostics.root,
            ownerLimitBytes: diagnostics.owner_limit_bytes ?? diagnostics.console_limit_bytes,
            runLimitBytes: diagnostics.run_limit_bytes ?? diagnostics.console_limit_bytes,
            retentionDays: diagnostics.retention_days ?? null,
            identity: { ...diagnostics.identity, bot: 'mindcraft-parent' } });
    if (Number.isSafeInteger(diagnostics.maintenance_limit_bytes) && diagnostics.maintenance_limit_bytes > 0)
        maintenanceDiagnosticWriter = new DiagnosticWriter({ root: diagnostics.root, pool: 'maintenance',
            limitBytes: diagnostics.maintenance_limit_bytes,
            ownerRoot: diagnostics.owner_root ?? diagnostics.root,
            ownerLimitBytes: diagnostics.owner_limit_bytes ?? diagnostics.maintenance_limit_bytes,
            runLimitBytes: diagnostics.run_limit_bytes ?? diagnostics.maintenance_limit_bytes,
            retentionDays: diagnostics.retention_days ?? null,
            identity: { ...diagnostics.identity, bot: 'mindcraft-parent' }, segmentBytes: 1024 * 1024 });
    originalConsoleWrite = { stdout: process.stdout.write, stderr: process.stderr.write };
    for (const stream of ['stdout', 'stderr']) {
        const destination = process[stream];
        const original = originalConsoleWrite[stream];
        destination.write = function (chunk, encoding, callback) {
            const result = original.call(destination, chunk, encoding, callback);
            saveConsoleChunk('parent_console_chunk', stream, Buffer.isBuffer(chunk)
                ? chunk.toString(typeof encoding === 'string' ? encoding : undefined) : String(chunk));
            return result;
        };
    }
    process.once('exit', () => {
        for (const item of consoleLineBuffers.values()) if (item.text && !item.dropping) {
            try { consoleDiagnosticWriter?.append(item.type, { stream: item.stream, ...item.identity, text: item.text }); }
            catch { /* The process is exiting; the writer's error state remains available before this point. */ }
        }
        try { consoleDiagnosticWriter?.close(); } catch {}
        try { maintenanceDiagnosticWriter?.close(); } catch {}
    });
}

function forwardAgentConsole(stream, chunk, identity) {
    const destination = process[stream];
    const result = originalConsoleWrite?.[stream]
        ? originalConsoleWrite[stream].call(destination, chunk) : destination.write(chunk);
    if (consoleDiagnosticWriter) saveConsoleChunk('agent_console_chunk', stream,
        Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk), identity);
    return result;
}

function runDiagnosticsMaintenance() {
    if (diagnosticsMaintenancePromise) return diagnosticsMaintenancePromise;
    const cli = rootSettings.diagnostics?.maintenance_cli;
    if (typeof cli !== 'string' || !cli.startsWith('/')) return Promise.reject(new Error('Diagnostics maintenance CLI path is invalid'));
    const child = spawn('python3', [cli, 'diagnostics', 'prune', '--summary'], { stdio: ['ignore', 'pipe', 'pipe'] });
    diagnosticsMaintenanceChild = child;
    let stdout = '';
    let stderr = '';
    diagnosticsMaintenancePromise = new Promise(resolve => {
        child.stdout.on('data', chunk => { if (stdout.length < 16_384) stdout += chunk.toString('utf8').slice(0, 16_384 - stdout.length); });
        child.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += chunk.toString('utf8').slice(0, 4000 - stderr.length); });
        child.once('error', error => { stderr = String(error); });
        child.once('close', code => {
            diagnosticsMaintenanceChild = null;
            diagnosticsMaintenancePromise = null;
            try {
                const result = code === 0 ? JSON.parse(stdout) : null;
                const type = result ? 'diagnostics_cleanup_completed' : 'diagnostics_cleanup_failed';
                maintenanceDiagnosticWriter?.append(type, result ? {
                    deletedCount: result.deletedCount ?? 0, deletedBytes: result.deletedBytes ?? 0,
                    protectedOrUnknownBytes: result.protectedOrUnknownBytes ?? null,
                    unresolvedOverageBytes: result.unresolvedOverageBytes ?? null,
                } : { exitCode: code, stderr: stderr.slice(0, 2000) });
                resolve(Boolean(result));
            } catch (error) { consoleDiagnosticWriter.writeError ||= String(error); resolve(false); }
        });
    });
    return diagnosticsMaintenancePromise;
}

function startDiagnosticsMaintenance() {
    if (rootSettings.diagnostics?.maintenance_cli === null) return;
    if (typeof rootSettings.diagnostics?.maintenance_cli !== 'string'
        || !rootSettings.diagnostics.maintenance_cli.startsWith('/'))
        throw new Error('Diagnostics maintenance CLI path is invalid');
    void runDiagnosticsMaintenance();
    diagnosticsMaintenanceTimer = setInterval(() => { void runDiagnosticsMaintenance(); }, 60_000);
    diagnosticsMaintenanceTimer.unref();
}

export async function init(host_public=false, port=8080, auto_open_ui=true) {
    if (connected) {
        console.error('Already initiliazed!');
        return;
    }
    mindserver = createMindServer(host_public, port);
    initializeConsoleDiagnostics();
    if (rootSettings.diagnostics) startDiagnosticsMaintenance();
    mindserver_port = port;
    connected = true;
    if (auto_open_ui) {
        setTimeout(() => {
            // check if browser listener is already open
            if (numStateListeners() === 0) {
                open('http://localhost:'+port);
            }
        }, 3000);
    }
}

export async function createAgent(settings, { startStopped = false } = {}) {
    if (shuttingDown) return { success: false, error: 'MindServer is shutting down' };
    if (!settings.profile.name) {
        console.error('Agent name is required in profile');
        return {
            success: false,
            error: 'Agent name is required in profile'
        };
    }
    settings = JSON.parse(JSON.stringify(settings));
    let agent_name = settings.profile.name;
    if (pendingAgentStops.has(agent_name) || agent_processes[agent_name] || pendingAgentCreations.has(agent_name)) {
        return { success: false, error: `Agent '${agent_name}' is still stopping or already exists` };
    }
    const creationToken = Symbol(agent_name);
    pendingAgentCreations.set(agent_name, creationToken);
    try {
        return await createReservedAgent(settings, agent_name, creationToken, startStopped);
    } finally {
        if (pendingAgentCreations.get(agent_name) === creationToken) pendingAgentCreations.delete(agent_name);
    }
}

async function createReservedAgent(settings, agent_name, creationToken, startStopped) {
    const agentIndex = agent_count++;
    const viewer_port = getBotViewerPort(agentIndex);
    let load_memory = settings.load_memory || false;
    let init_message = settings.init_message || null;

    let registration = null;
    let agentProcess = null;
    try {
        try {
            const server = await getServer(settings.host, settings.port, settings.minecraft_version);
            settings.host = server.host;
            settings.port = server.port;
            settings.minecraft_version = server.version;
        } catch (error) {
            console.warn(`Error getting server:`, error);
            if (settings.minecraft_version === "auto") {
                settings.minecraft_version = null;
            }
            console.warn(`Attempting to connect anyway...`);
        }

        if (shuttingDown || pendingAgentStops.has(agent_name) || pendingAgentCreations.get(agent_name) !== creationToken) {
            return { success: false, error: 'MindServer is shutting down or the previous agent is still stopping' };
        }

        registration = registerAgent(settings, viewer_port);
        agentProcess = new AgentProcess(agent_name, mindserver_port, {
            onTaskEnding: outcome => taskEndingHandler?.(outcome),
            managementAuthMode: rootSettings.management_auth_mode || 'legacy',
            registerBotCredential: issueBotCredential,
            revokeBotCredential,
            onConsoleChunk: (stream, chunk, identity) => forwardAgentConsole(stream, chunk, identity)
        });
        agent_processes[settings.profile.name] = agentProcess;
        if (startStopped) {
            agentProcess.initialStartOptions = { load_memory, init_message, agentIndex };
            return { success: true, error: null };
        }
        const started = await agentProcess.start(load_memory, init_message, agentIndex);
        const creationCancelled = shuttingDown
            || pendingAgentCreations.get(agent_name) !== creationToken
            || agent_processes[agent_name] !== agentProcess
            || agentProcess.desiredState !== 'running';
        if (started?.state !== 'running' || creationCancelled) {
            if (agentProcess.outcome?.groupsGone !== true) {
                await trackAgentStop(agent_name, agentProcess, creationCancelled ? 'creation-cancelled' : 'creation-failed');
            }
            if (agent_processes[agent_name] === agentProcess && agentProcess.outcome?.groupsGone === true) {
                delete agent_processes[agent_name];
            }
            unregisterAgent(agent_name, registration);
            return { success: false, error: started?.error || started?.reason || 'Agent process did not start' };
        }
    } catch (error) {
        console.error(`Error creating agent ${agent_name}:`, error);
        if (agentProcess) {
            const stopped = await trackAgentStop(agent_name, agentProcess, 'creation-failed');
            if (stopped?.groupsGone === true && agent_processes[agent_name] === agentProcess) delete agent_processes[agent_name];
        }
        if (registration) unregisterAgent(agent_name, registration);
        return {
            success: false,
            error: error.message
        };
    }
    return {
        success: true,
        error: null
    };
}

export function getAgentProcess(agentName) {
    return agent_processes[agentName];
}

export function startAgent(agentName) {
    if (shuttingDown || pendingAgentStops.has(agentName) || pendingAgentCreations.has(agentName)) {
        console.warn(`Cannot start agent ${agentName}; shutdown or prior stop is still active`);
        return Promise.resolve({ state: 'stopped', reason: 'shutdown-or-stop-in-progress' });
    }
    if (agent_processes[agentName]) {
        const process = agent_processes[agentName];
        if (process.initialStartOptions) {
            const { load_memory, init_message, agentIndex } = process.initialStartOptions;
            delete process.initialStartOptions;
            return process.start(load_memory, init_message, agentIndex);
        }
        return process.forceRestart();
    }
    else {
        console.error(`Cannot start agent ${agentName}; not found`);
        return Promise.resolve(null);
    }
}

export function stopAgent(agentName) {
    const pendingCreation = pendingAgentCreations.has(agentName);
    if (pendingCreation) pendingAgentCreations.delete(agentName);
    if (agent_processes[agentName]) {
        return trackAgentStop(agentName, agent_processes[agentName], 'ui-stop');
    }
    if (pendingCreation) return Promise.resolve({ state: 'stopped', reason: 'pending-create-cancelled', groupsGone: true });
    return pendingAgentStops.get(agentName)?.promise || Promise.resolve(null);
}

export function destroyAgent(agentName) {
    if (pendingAgentCreations.has(agentName)) pendingAgentCreations.delete(agentName);
    if (agent_processes[agentName]) {
        const agentProcess = agent_processes[agentName];
        delete agent_processes[agentName];
        return trackAgentStop(agentName, agentProcess, 'ui-destroy');
    }
    return pendingAgentStops.get(agentName)?.promise || Promise.resolve(null);
}

export function setTaskEndingHandler(handler) {
    taskEndingHandler = typeof handler === 'function' ? handler : null;
}

export function setShutdownHandler(handler) {
    shutdownHandler = typeof handler === 'function' ? handler : null;
}

export function shutdown(request = 'parent-shutdown') {
    if (shutdownHandler) return shutdownHandler(request);
    return stopAllAgents(typeof request === 'string' ? request : request?.reason, { closing: true });
}

export async function stopAllAgents(reason = 'shutdown', { closing = false } = {}) {
    if (closing) shuttingDown = true;
    for (const agentName of pendingAgentCreations.keys()) pendingAgentCreations.delete(agentName);
    const stopByAgent = new Map();
    for (const [agentName, entry] of pendingAgentStops) {
        stopByAgent.set(agentName, trackAgentStop(agentName, entry.agentProcess, reason));
    }
    for (const [agentName, agentProcess] of Object.entries(agent_processes)) {
        if (!stopByAgent.has(agentName)) stopByAgent.set(agentName, trackAgentStop(agentName, agentProcess, reason));
    }
    const entries = [...stopByAgent.entries()];
    const settled = await Promise.allSettled(entries.map(([, promise]) => promise));
    const outcomes = settled.map((result, index) => ({
        agentName: entries[index][0],
        ...(result.status === 'fulfilled' ? { outcome: result.value } : { error: result.reason?.message || String(result.reason) })
    }));
    const incomplete = outcomes.filter(item => item.error || item.outcome?.groupsGone !== true);
    if (incomplete.length) {
        const details = incomplete.map(item => {
            const cause = item.error || item.outcome?.reason || 'cleanup not confirmed';
            const groupErrors = item.outcome?.cleanupErrors?.map(cleanup => `${cleanup.pid}: ${cleanup.message}`).join(', ');
            return `${item.agentName} (${cause}${groupErrors ? `; ${groupErrors}` : ''})`;
        });
        const error = new Error(`Agent process cleanup incomplete for ${details.join(', ')}`);
        error.code = 'AGENT_CLEANUP_INCOMPLETE';
        error.outcomes = outcomes;
        throw error;
    }
    if (closing && rootSettings.diagnostics) {
        if (diagnosticsMaintenanceTimer) clearInterval(diagnosticsMaintenanceTimer);
        await runDiagnosticsMaintenance();
    }
    return { groupsGone: true, outcomes };
}

function trackAgentStop(agentName, agentProcess, reason) {
    const current = pendingAgentStops.get(agentName);
    if (current && !current.settled) return current.promise;
    const entry = { agentProcess, settled: false, outcome: null, promise: null };
    const promise = Promise.resolve(agentProcess.shutdown(reason)).then(outcome => {
        entry.settled = true;
        entry.outcome = outcome;
        if (outcome?.groupsGone === true && pendingAgentStops.get(agentName) === entry) pendingAgentStops.delete(agentName);
        return outcome;
    }, error => {
        entry.settled = true;
        entry.error = error;
        throw error;
    });
    entry.promise = promise;
    pendingAgentStops.set(agentName, entry);
    return promise;
}
