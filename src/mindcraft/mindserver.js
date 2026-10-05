import { resolveMessageTargets, parseAddressedMessage } from '../utils/message_targets.js';
import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import * as mindcraft from './mindcraft.js';
import { readFileSync, mkdirSync, writeFileSync, chmodSync, rmSync, linkSync, statSync, realpathSync } from 'fs';
import settings from '../../settings.js';
import { attachPlaceStoreLifecycle, PlaceStore } from './place_store.js';
import { attachPlaceRpc } from './place_rpc.js';
import { createHash, randomUUID, randomBytes, timingSafeEqual } from 'crypto';
import { createStatePoller } from './state_poller.js';
import { readBotOutputHistory } from './bot_output_history.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mindserver is:
// - central hub for communication between all agent processes
// - api to control from other languages and remote users 
// - host for webapp

let io;
let server;
let placeStorePromise = null;
let placeStoreError = null;
const managementGeneration = randomUUID();
const agent_connections = {};
const agent_listeners = [];
let protectedMode = false;
const botTokens = new Map();
let sessionFile = null;

const settings_spec = JSON.parse(readFileSync(path.join(__dirname, 'public/settings_spec.json'), 'utf8'));

class AgentConnection {
    constructor(settings, viewer_port) {
        this.socket = null;
        this.connectionGeneration = null;
        this.lastConnectionGeneration = null;
        this.settings = settings;
        this.in_game = false;
        this.full_state = null;
        this.viewer_port = viewer_port;
    }
    setSettings(settings) {
        this.settings = settings;
    }
}

export function registerAgent(settings, viewer_port) {
    let agentConnection = new AgentConnection(settings, viewer_port);
    agent_connections[settings.profile.name] = agentConnection;
    return agentConnection;
}

export function logoutAgent(agentName) {
    if (agent_connections[agentName]) {
        agent_connections[agentName].in_game = false;
        agentsStatusUpdate();
    }
}

export function unregisterAgent(agentName, expectedConnection = null) {
    if (!agent_connections[agentName] || (expectedConnection && agent_connections[agentName] !== expectedConnection)) return false;
    delete agent_connections[agentName];
    botTokens.delete(agentName);
    agentsStatusUpdate();
    return true;
}

// Initialize the server
export function createMindServer(host_public = false, port = 8080) {
    if (settings.management_auth_mode !== undefined && !['legacy', 'protected'].includes(settings.management_auth_mode)) {
        throw new Error('management_auth_mode must be legacy or protected');
    }
    protectedMode = settings.management_auth_mode === 'protected';
    if (protectedMode) {
        const target = process.env.MINDCRAFT_SESSION_FILE ? path.resolve(process.env.MINDCRAFT_SESSION_FILE) : null;
        if (!target) {
            throw new Error('Protected MindServer requires MINDCRAFT_SESSION_FILE outside the static root');
        }
        const directory = path.dirname(path.resolve(target));
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const publicRoot = realpathSync(path.join(__dirname, 'public'));
        const realDirectory = realpathSync(directory);
        if (realDirectory === publicRoot || realDirectory.startsWith(`${publicRoot}${path.sep}`)) {
            throw new Error('Protected MindServer session path must be outside the static root');
        }
        if ((statSync(directory).mode & 0o777) !== 0o700) throw new Error('MINDCRAFT_SESSION_FILE parent directory must be private (0700)');
        const credentials = { operator: randomBytes(32).toString('hex'), observer: randomBytes(32).toString('hex') };
        const temporary = `${target}.${randomUUID()}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(credentials)}\n`, { mode: 0o600, flag: 'wx' });
        try {
            chmodSync(temporary, 0o600);
            linkSync(temporary, target);
        } finally { rmSync(temporary, { force: true }); }
        chmodSync(target, 0o600);
        sessionFile = path.resolve(target);
        protectedSessions.operator = credentials.operator;
        protectedSessions.observer = credentials.observer;
    }

    const app = express();
    server = http.createServer(app);
    io = new Server(server);

    io.use((socket, next) => {
        if (!protectedMode) { socket.data.identity = { role: 'legacy' }; return next(); }
        const token = socket.handshake.auth?.token;
        const identity = typeof token === 'string' ? authenticateToken(token) : null;
        if (!identity) return next(new Error('MindServer authentication required'));
        socket.data.identity = identity;
        next();
    });

    placeStorePromise = null;
    placeStoreError = null;
    let placeStoreLifecycle = null;
    let placeRpcClosing = false;
    let hubClosing = false;
    if (Boolean(settings.place_state_dir) !== Boolean(settings.place_world_id)) {
        placeStoreError = Object.assign(new Error('place_state_dir and place_world_id must be configured together'), { code: 'INVALID_CONFIG' });
        console.error('Place store configuration is incomplete:', placeStoreError.message);
    } else if (settings.place_state_dir && settings.place_world_id) {
        placeStorePromise = PlaceStore.open({ stateDir: settings.place_state_dir, worldId: settings.place_world_id });
        placeStorePromise.catch((error) => {
            placeStoreError = error;
            console.error('Place store failed to initialize:', error.message);
        });
    }

    // Serve static files
    app.use(express.static(path.join(__dirname, 'public')));

    // Socket.io connection handling
    io.on('connection', (socket) => {
        let curAgentName = null;
        let processAgentName = null;
        console.log('Client connected');

        if (protectedMode && socket.data.identity.role === 'observer') {
            socket.on('readiness', callback => {
                if (!allowed(socket, ['observer'])) return deny(callback);
                callback?.({ ready: true, agents: Object.entries(agent_connections).map(([name, connection]) => ({
                    name, ready: Boolean(connection.in_game && connection.socket?.connected)
                })) });
            });
            return;
        }

        attachPlaceRpc(socket, {
            getAgentName: () => processAgentName && allowedBot(socket, processAgentName)
                && agent_connections[processAgentName]?.socket === socket ? processAgentName : null,
            getPlaceStore: async () => {
                if (placeStoreError) throw placeStoreError;
                return placeStorePromise;
            },
            isClosing: () => placeRpcClosing
        });

        agentsStatusUpdate(socket);

        socket.on('create-agent', async (settings, callback) => {
            if (!allowed(socket, ['operator', 'legacy'])) return deny(callback);
            if (hubClosing) {
                callback?.({ success: false, accepted: false, error: 'MindServer is shutting down' });
                return;
            }
            console.log('API create agent...');
            for (let key in settings_spec) {
                if (!(key in settings)) {
                    if (settings_spec[key].required) {
                        callback?.({ success: false, accepted: false, error: `Setting ${key} is required` });
                        return;
                    }
                    else {
                        settings[key] = settings_spec[key].default;
                    }
                }
            }
            for (let key in settings) {
                if (!(key in settings_spec)) {
                    delete settings[key];
                }
            }
            if (settings.profile?.name) {
                if (settings.profile.name in agent_connections) {
                    callback?.({ success: false, accepted: false, error: 'Agent already exists' });
                    return;
                }
                let returned = await mindcraft.createAgent(settings);
                callback?.({ success: returned.success, accepted: returned.success, error: returned.error });
                agentsStatusUpdate();
            }
            else {
                console.error('Agent name is required in profile');
                callback?.({ success: false, accepted: false, error: 'Agent name is required in profile' });
            }
        });

        socket.on('get-settings', (agentName, callback) => {
            if (!allowedBotOrOperator(socket, agentName)) return deny(callback);
            if (agent_connections[agentName]) {
                const agentSettings = settingsForAgent(agent_connections[agentName].settings);
                callback({
                    settings: agentSettings,
                    management: {
                        generation: managementGeneration,
                        agentName,
                        spawnId: socket.data.identity.role === 'bot' ? socket.data.identity.spawnId : null,
                        placeMemoryEnabled: agentSettings.place_memory_enabled,
                        placeWorldId: agentSettings.place_world_id,
                        settingsFingerprint: settingsFingerprint(agentSettings)
                    }
                });
            } else {
                callback({ error: `Agent '${agentName}' not found.` });
            }
        });

        socket.on('connect-agent-process', (agentName, metadataOrCallback, acknowledgement) => {
            const metadata = typeof metadataOrCallback === 'object' && metadataOrCallback !== null ? metadataOrCallback : null;
            const callback = typeof metadataOrCallback === 'function' ? metadataOrCallback : acknowledgement;
            const connection = agent_connections[agentName];
            const requestedGeneration = metadata?.connectionGeneration;
            const staleRegistration = protectedMode && Number.isInteger(requestedGeneration)
                && Number.isInteger(connection?.lastConnectionGeneration)
                && requestedGeneration <= connection.lastConnectionGeneration
                && connection.socket !== socket;
            if (allowedBot(socket, agentName) && connection && !staleRegistration) {
                connection.socket = socket;
                connection.connectionGeneration = Number.isInteger(requestedGeneration) ? requestedGeneration : null;
                if (Number.isInteger(requestedGeneration)) connection.lastConnectionGeneration = requestedGeneration;
                processAgentName = agentName;
                agentsStatusUpdate();
                callback?.({ accepted: true, agentName, spawnId: socket.data.identity.role === 'bot' ? socket.data.identity.spawnId : null,
                    connectionGeneration: connection.connectionGeneration });
            } else callback?.({ accepted: false, error: 'MindServer rejected agent registration' });
        });

        socket.on('login-agent', (agentName, callback) => {
            if (allowedBot(socket, agentName) && agent_connections[agentName]
                && (!protectedMode || agent_connections[agentName].socket === socket)) {
                agent_connections[agentName].socket = socket;
                agent_connections[agentName].in_game = true;
                curAgentName = agentName;
                processAgentName = agentName;
                agentsStatusUpdate();
                callback?.({ accepted: true, agentName, spawnId: socket.data.identity.role === 'bot' ? socket.data.identity.spawnId : null });
            }
            else {
                console.warn(`Unregistered agent ${agentName} tried to login`);
                callback?.({ accepted: false, error: 'MindServer rejected agent login' });
            }
        });

        socket.on('disconnect', () => {
            const disconnectedName = curAgentName ?? processAgentName;
            if (disconnectedName && agent_connections[disconnectedName]?.socket === socket) {
                console.log(`Agent ${disconnectedName} disconnected`);
                agent_connections[disconnectedName].in_game = false;
                agent_connections[disconnectedName].socket = null;
                agent_connections[disconnectedName].connectionGeneration = null;
                agentsStatusUpdate();
            }
            if (agent_listeners.includes(socket)) {
                removeListener(socket);
            }
        });

        socket.on('chat-message', (agentName, json, acknowledge) => {
            if (!allowedBot(socket, socket.data.identity.agentName)) {
                acknowledge?.({ accepted: false, error: 'sender identity is no longer current' });
                return;
            }
            if (protectedMode && socket.data.identity.role !== 'bot') {
                acknowledge?.({ accepted: false, error: 'authenticated bot identity required' });
                return;
            }
            if (!agent_connections[agentName]) {
                console.warn(`Agent ${agentName} tried to send a message but is not logged in`);
                acknowledge?.({ accepted: false, error: 'recipient is unavailable' });
                return;
            }
            const sender = socket.data.identity.role === 'bot' ? socket.data.identity.agentName : curAgentName;
            console.log(`${sender} sending message to ${agentName}`);
            const receiver = agent_connections[agentName].socket;
            if (!receiver?.connected) {
                acknowledge?.({ accepted: false, error: 'recipient is unavailable' });
                return;
            }
            if (json?.nativeMessage) {
                const native = json.nativeMessage;
                const identity = socket.data.identity;
                if (!protectedMode || identity?.role !== 'bot' || !identity.spawnId
                    || agent_connections[identity.agentName]?.socket !== socket
                    || agent_connections[identity.agentName]?.connectionGeneration !== native.senderConnectionGeneration
                    || !allowedBot(receiver, agentName) || agent_connections[agentName].socket !== receiver
                    || typeof native.id !== 'string' || !native.id
                    || typeof native.senderTaskId !== 'string' || !native.senderTaskId
                    || typeof native.senderActionId !== 'string' || !native.senderActionId
                    || !Number.isInteger(native.senderConnectionGeneration)
                    || !Number.isInteger(native.senderManagementGeneration)) {
                    acknowledge?.({ accepted: false, error: 'native peer identity or task scope is invalid' });
                    return;
                }
                const routed = { ...json, nativeMessage: { ...native, senderAgent: identity.agentName,
                    senderSpawnId: identity.spawnId, receiverConnectionGeneration: agent_connections[agentName].connectionGeneration,
                    hubGeneration: managementGeneration } };
                receiver.emit('chat-message', sender, routed, result => {
                    if (result?.accepted === true && result.messageId === native.id && result.taskId === native.senderTaskId)
                        acknowledge?.({ accepted: true, messageId: native.id, taskId: native.senderTaskId,
                            receiverTaskId: result.receiverTaskId ?? null });
                    else acknowledge?.({ accepted: false, error: result?.error || 'recipient did not accept inbox message' });
                });
                return;
            }
            receiver.emit('chat-message', sender, json);
        });

        socket.on('set-agent-settings', (agentName, settings, callback) => {
            if (!allowed(socket, ['operator', 'legacy'])) return deny(callback);
            if (hubClosing) return deny(callback);
            const agent = agent_connections[agentName];
            if (agent) {
                try {
                    validateAgentSettings(settings);
                    agent.setSettings(settingsForAgent(settings));
                } catch (error) {
                    callback?.({ success: false, accepted: false, error: error?.message || 'Invalid agent settings' });
                    return;
                }
                void reportAgentOperation(mindcraft.startAgent(agentName), `Restart agent after settings update (${agentName})`, callback, agentName);
            } else deny(callback);
        });

        socket.on('restart-agent', (agentName, callback) => {
            if (!allowed(socket, ['operator', 'legacy'])) return deny(callback);
            if (hubClosing) return deny(callback);
            console.log(`Restarting agent: ${agentName}`);
            void reportAgentOperation(mindcraft.startAgent(agentName), `Restart agent (${agentName})`, callback, agentName);
        });

        socket.on('stop-agent', (agentName, callback) => {
            if (!allowed(socket, ['operator', 'legacy'])) return deny(callback);
            void reportAgentOperation(mindcraft.stopAgent(agentName), `Stop agent (${agentName})`, callback, agentName);
        });

        socket.on('start-agent', (agentName, callback) => {
            if (!allowed(socket, ['operator', 'legacy'])) return deny(callback);
            if (hubClosing) return deny(callback);
            void reportAgentOperation(mindcraft.startAgent(agentName), `Start agent (${agentName})`, callback, agentName);
        });

        socket.on('destroy-agent', (agentName, callback) => {
            if (!allowed(socket, ['operator', 'legacy'])) return deny(callback);
            if (agent_connections[agentName]) {
                void reportAgentOperation(mindcraft.destroyAgent(agentName), `Destroy agent (${agentName})`, callback, agentName);
                delete agent_connections[agentName];
            } else {
                void reportAgentOperation(mindcraft.destroyAgent(agentName), `Cancel pending agent creation (${agentName})`, callback, agentName);
            }
            agentsStatusUpdate();
        });

        socket.on('stop-all-agents', callback => {
            if (!allowed(socket, ['operator', 'legacy'])) return deny(callback);
            console.log('Killing all agents');
            void reportAgentOperation(mindcraft.stopAllAgents('ui-stop-all'), 'Stop all agents', callback);
        });

        socket.on('shutdown', callback => {
            if (!allowed(socket, ['operator', 'legacy'])) return deny(callback);
            console.log('Shutting down');
            callback?.({ success: true, accepted: true, settled: false });
            setImmediate(() => { void mindcraft.shutdown({ reason: 'ui-shutdown' }); });
            
        });

        socket.on('send-message', (targets, data, callback) => {
            if (!allowed(socket, ['operator', 'legacy'])) return deny(callback);
            try {
                if (!data || typeof data.message !== 'string' || !data.message.trim()
                    || (!protectedMode && (typeof data.from !== 'string' || !data.from.trim()))) {
                    throw new Error('Sender and message are required.');
                }
                const identity = socket.data.identity;
                if (data.taskId != null && (typeof data.taskId !== 'string' || !data.taskId.trim())) throw new Error('Task ID is malformed.');
                const agents = Object.entries(agent_connections).map(([name, conn]) => ({
                    name, in_game: conn.in_game, socket_connected: !!conn.socket?.connected
                }));
                const addressed = parseAddressedMessage(data.message, agents);
                const recipients = addressed?.recipients || resolveMessageTargets(targets, agents);
                if (data.taskId && recipients.length !== 1) throw new Error('Task ID dispatch requires exactly one authenticated recipient.');
                const sender = identity.role === 'bot' ? identity.agentName : identity.role === 'operator' ? 'ADMIN' : data.from;
                const payload = { from: sender, message: addressed?.message || data.message, recipients, taskId: data.taskId ?? null };
                if (data.taskId && typeof callback === 'function') {
                    let settled = false;
                    const timer = setTimeout(() => {
                        if (settled) return;
                        settled = true;
                        callback({ success: false, accepted: false, taskId: data.taskId, error: 'task acceptance acknowledgement timed out' });
                    }, 5000);
                    for (const name of recipients) {
                        agent_connections[name].socket.emit('send-message', payload, acknowledgement => {
                            if (settled) return;
                            clearTimeout(timer);
                            settled = true;
                            if (acknowledgement?.accepted && acknowledgement.taskId === data.taskId)
                                callback({ success: true, accepted: true, recipients, taskId: data.taskId });
                            else callback({ success: false, accepted: false, taskId: data.taskId, error: acknowledgement?.error || 'agent did not accept task' });
                        });
                    }
                } else {
                    for (const name of recipients) agent_connections[name].socket.emit('send-message', payload);
                    if (typeof callback === 'function') callback({ success: true, queued: true, recipients });
                }
            } catch (error) {
                if (typeof callback === 'function') callback({ success: false, error: error.message });
                else console.warn('Cannot send message:', error.message);
            }
        });

        socket.on('bot-output', (agentName, message) => {
            if (allowedBot(socket, agentName)) {
                if (!protectedMode) io.emit('bot-output', agentName, message);
                else for (const recipient of io.sockets.sockets.values()) if (recipient.data.identity?.role !== 'observer') recipient.emit('bot-output', agentName, message);
            }
        });

        socket.on('get-bot-output-log', callback => {
            if (!allowed(socket, ['operator', 'legacy'])) return deny(callback);
            const entries = readBotOutputHistory(process.cwd(), Object.keys(agent_connections));
            if (typeof callback === 'function') callback({ success: true, entries });
        });

        socket.on('listen-to-agents', () => {
            if (!allowed(socket, ['operator', 'legacy'])) return;
            addListener(socket);
        });
    });

    if (host_public) {
        console.log('Public hosting not supported yet. Using localhost.');
    }
    const host = 'localhost';
    server.listen(port, host, () => {
        console.log(`MindServer running on port ${port} on host ${host}`);
    });

    placeStoreLifecycle = attachPlaceStoreLifecycle({
        server,
        socketServer: io,
        storePromise: placeStorePromise,
        beforeClose: async reason => {
            hubClosing = true;
            statePoller?.stop();
            statePoller = null;
            agent_listeners.splice(0, agent_listeners.length);
            placeRpcClosing = true;
            botTokens.clear();
            protectedSessions.operator = null;
            protectedSessions.observer = null;
            if (sessionFile) { try { rmSync(sessionFile, { force: true }); } catch {} sessionFile = null; }
            return mindcraft.stopAllAgents(reason || 'parent-shutdown', { closing: true });
        }
    });
    mindcraft.setShutdownHandler(request => placeStoreLifecycle?.shutdown(request));
    mindcraft.setTaskEndingHandler(outcome => {
        void mindcraft.shutdown({ reason: 'task-ending', exitCode: outcome.code });
    });

    return server;
}

const protectedSessions = { operator: null, observer: null };
export function issueBotCredential(agentName, spawnId, token) {
    if (!protectedMode) return;
    if (!agent_connections[agentName] || typeof spawnId !== 'string' || typeof token !== 'string') throw new Error('Invalid bot credential registration');
    const previous = botTokens.get(agentName);
    if (previous && previous.spawnId !== spawnId) {
        const connection = agent_connections[agentName];
        if (connection) {
            connection.socket = null;
            connection.connectionGeneration = null;
            connection.lastConnectionGeneration = null;
            connection.in_game = false;
        }
    }
    botTokens.set(agentName, { spawnId, token });
}
export function revokeBotCredential(agentName, spawnId) {
    if (botTokens.get(agentName)?.spawnId !== spawnId) return false;
    botTokens.delete(agentName);
    return true;
}

function authenticateToken(token) {
    for (const [agentName, registered] of botTokens) {
        if (safeTokenEqual(token, registered.token)) return { role: 'bot', agentName, spawnId: registered.spawnId };
    }
    for (const role of ['operator', 'observer']) {
        if (protectedSessions[role] && safeTokenEqual(token, protectedSessions[role])) return { role };
    }
    return null;
}
function safeTokenEqual(left, right) {
    const a = Buffer.from(left); const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}
function allowed(socket, roles) { return isCurrentIdentity(socket) && roles.includes(socket.data.identity?.role); }
function allowedBot(socket, agentName) {
    const identity = socket.data.identity;
    return identity?.role === 'legacy' || (identity?.role === 'bot' && isCurrentIdentity(socket) && identity.agentName === agentName
        && botTokens.get(agentName)?.spawnId === identity.spawnId);
}
function isCurrentIdentity(socket) {
    const identity = socket.data.identity;
    if (!protectedMode) return identity?.role === 'legacy';
    if (identity?.role === 'operator') return protectedSessions.operator !== null;
    if (identity?.role === 'observer') return protectedSessions.observer !== null;
    if (identity?.role === 'bot') return botTokens.get(identity.agentName)?.spawnId === identity.spawnId;
    return false;
}
function allowedBotOrOperator(socket, agentName) {
    return allowed(socket, ['operator', 'legacy']) || allowedBot(socket, agentName);
}
function deny(callback) { callback?.({ success: false, error: 'MindServer authorization denied' }); return false; }

function reportAgentOperation(operation, label, callback, agentName = null) {
    return Promise.resolve(operation).then(outcome => {
        const success = outcome !== null && outcome !== undefined;
        callback?.({ success, accepted: success, ...(agentName ? { agentName } : {}), state: outcome?.state ?? null,
            settled: success && (outcome?.groupsGone === true || outcome?.state === 'running') });
        return outcome;
    }).catch(error => {
        console.error(`${label} failed:`, error?.message || error);
        callback?.({ success: false, accepted: false, ...(agentName ? { agentName } : {}), error: error?.message || String(error) });
        return null;
    });
}

function settingsForAgent(agentSettings) {
    const result = { ...agentSettings };
    delete result.management_auth_mode;
    delete result.place_state_dir;
    delete result.place_world_id;
    delete result.place_memory_enabled;
    result.place_memory_enabled = Boolean(settings.place_state_dir && settings.place_world_id);
    result.place_world_id = result.place_memory_enabled ? settings.place_world_id : null;
    result.bot_rules_file = settings.bot_rules_file ?? null;
    return result;
}

function validateAgentSettings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent settings must be an object');
    for (const key of Object.keys(value)) {
        if (!Object.hasOwn(settings_spec, key)) throw new Error(`Unknown agent setting: ${key}`);
    }
    for (const [key, spec] of Object.entries(settings_spec)) {
        if (!Object.hasOwn(value, key)) {
            if (spec.required) throw new Error(`Setting ${key} is required`);
            continue;
        }
        const item = value[key];
        if (item === null && spec.default === null) continue;
        const validType = spec.type === 'array' ? Array.isArray(item)
            : spec.type === 'object' ? item !== null && typeof item === 'object' && !Array.isArray(item)
                : spec.type === 'number' ? typeof item === 'number' && Number.isFinite(item)
                    : typeof item === spec.type;
        if (!validType) throw new Error(`Invalid type for agent setting ${key}`);
        if (spec.options && !spec.options.includes(item)) throw new Error(`Invalid value for agent setting ${key}`);
    }
    if (typeof value.profile?.name !== 'string' || !value.profile.name.trim()) throw new Error('Agent profile name is required');
}

function settingsFingerprint(value) {
    const stable = (item) => Array.isArray(item)
        ? item.map(stable)
        : item && typeof item === 'object'
            ? Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])]))
            : item;
    return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function agentsStatusUpdate(socket) {
    let agents = [];
    for (let agentName in agent_connections) {
        const conn = agent_connections[agentName];
        agents.push({
            name: agentName, 
            in_game: conn.in_game,
            viewerPort: conn.viewer_port,
            socket_connected: !!conn.socket
        });
    };
    if (socket) socket.emit('agents-status', agents);
    else if (!protectedMode) io.emit('agents-status', agents);
    else for (const recipient of io.sockets.sockets.values()) if (recipient.data.identity?.role !== 'observer') recipient.emit('agents-status', agents);
}


let statePoller = null;
function addListener(listener_socket) {
    if (agent_listeners.includes(listener_socket)) return;
    agent_listeners.push(listener_socket);
    if (agent_listeners.length === 1) {
        statePoller = createStatePoller({
            getConnections: () => agent_connections,
            emit: states => { for (const listener of agent_listeners) listener.emit('state-update', states); },
        });
        statePoller.start();
    }
}

function removeListener(listener_socket) {
    const index = agent_listeners.indexOf(listener_socket);
    if (index < 0) return;
    agent_listeners.splice(index, 1);
    if (agent_listeners.length === 0) {
        statePoller?.stop();
        statePoller = null;
    }
}

// Optional: export these if you need access to them from other files
export const getIO = () => io;
export const getServer = () => server;
export const numStateListeners = () => agent_listeners.length;
