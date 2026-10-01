import { createMindServer, registerAgent, unregisterAgent, numStateListeners } from './mindserver.js';
import { AgentProcess } from '../process/agent_process.js';
import { getServer } from './mcserver.js';
import { getBotViewerPort } from '../utils/viewer_ports.js';
import open from 'open';

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

export async function init(host_public=false, port=8080, auto_open_ui=true) {
    if (connected) {
        console.error('Already initiliazed!');
        return;
    }
    mindserver = createMindServer(host_public, port);
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

export async function createAgent(settings) {
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
        return await createReservedAgent(settings, agent_name, creationToken);
    } finally {
        if (pendingAgentCreations.get(agent_name) === creationToken) pendingAgentCreations.delete(agent_name);
    }
}

async function createReservedAgent(settings, agent_name, creationToken) {
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
            onTaskEnding: outcome => taskEndingHandler?.(outcome)
        });
        agent_processes[settings.profile.name] = agentProcess;
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
        return agent_processes[agentName].forceRestart();
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
