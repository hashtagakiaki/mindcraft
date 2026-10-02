import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import * as mindcraft from './mindcraft.js';
import { readFileSync } from 'fs';
import settings from '../../settings.js';
import { attachPlaceStoreLifecycle, PlaceStore } from './place_store.js';
import { attachPlaceRpc } from './place_rpc.js';
import { createHash, randomUUID } from 'crypto';
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

const settings_spec = JSON.parse(readFileSync(path.join(__dirname, 'public/settings_spec.json'), 'utf8'));

class AgentConnection {
    constructor(settings, viewer_port) {
        this.socket = null;
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
    agentsStatusUpdate();
    return true;
}

// Initialize the server
export function createMindServer(host_public = false, port = 8080) {
    const app = express();
    server = http.createServer(app);
    io = new Server(server);

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
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    app.use(express.static(path.join(__dirname, 'public')));

    // Socket.io connection handling
    io.on('connection', (socket) => {
        let curAgentName = null;
        let processAgentName = null;
        console.log('Client connected');

        attachPlaceRpc(socket, {
            getAgentName: () => processAgentName && agent_connections[processAgentName]?.socket === socket ? processAgentName : null,
            getPlaceStore: async () => {
                if (placeStoreError) throw placeStoreError;
                return placeStorePromise;
            },
            isClosing: () => placeRpcClosing
        });

        agentsStatusUpdate(socket);

        socket.on('create-agent', async (settings, callback) => {
            if (hubClosing) {
                callback?.({ success: false, error: 'MindServer is shutting down' });
                return;
            }
            console.log('API create agent...');
            for (let key in settings_spec) {
                if (!(key in settings)) {
                    if (settings_spec[key].required) {
                        callback({ success: false, error: `Setting ${key} is required` });
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
                    callback({ success: false, error: 'Agent already exists' });
                    return;
                }
                let returned = await mindcraft.createAgent(settings);
                callback({ success: returned.success, error: returned.error });
                agentsStatusUpdate();
            }
            else {
                console.error('Agent name is required in profile');
                callback({ success: false, error: 'Agent name is required in profile' });
            }
        });

        socket.on('get-settings', (agentName, callback) => {
            if (agent_connections[agentName]) {
                const agentSettings = settingsForAgent(agent_connections[agentName].settings);
                callback({
                    settings: agentSettings,
                    management: {
                        generation: managementGeneration,
                        agentName,
                        placeMemoryEnabled: agentSettings.place_memory_enabled,
                        placeWorldId: agentSettings.place_world_id,
                        settingsFingerprint: settingsFingerprint(agentSettings)
                    }
                });
            } else {
                callback({ error: `Agent '${agentName}' not found.` });
            }
        });

        socket.on('connect-agent-process', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                processAgentName = agentName;
                agentsStatusUpdate();
            }
        });

        socket.on('login-agent', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agent_connections[agentName].in_game = true;
                curAgentName = agentName;
                processAgentName = agentName;
                agentsStatusUpdate();
            }
            else {
                console.warn(`Unregistered agent ${agentName} tried to login`);
            }
        });

        socket.on('disconnect', () => {
            const disconnectedName = curAgentName ?? processAgentName;
            if (disconnectedName && agent_connections[disconnectedName]?.socket === socket) {
                console.log(`Agent ${disconnectedName} disconnected`);
                agent_connections[disconnectedName].in_game = false;
                agent_connections[disconnectedName].socket = null;
                agentsStatusUpdate();
            }
            if (agent_listeners.includes(socket)) {
                removeListener(socket);
            }
        });

        socket.on('chat-message', (agentName, json) => {
            if (!agent_connections[agentName]) {
                console.warn(`Agent ${agentName} tried to send a message but is not logged in`);
                return;
            }
            console.log(`${curAgentName} sending message to ${agentName}: ${json.message}`);
            agent_connections[agentName].socket.emit('chat-message', curAgentName, json);
        });

        socket.on('set-agent-settings', (agentName, settings) => {
            if (hubClosing) return;
            const agent = agent_connections[agentName];
            if (agent) {
                agent.setSettings(settingsForAgent(settings));
                void reportAgentOperation(mindcraft.startAgent(agentName), `Restart agent after settings update (${agentName})`);
            }
        });

        socket.on('restart-agent', (agentName) => {
            if (hubClosing) return;
            console.log(`Restarting agent: ${agentName}`);
            void reportAgentOperation(mindcraft.startAgent(agentName), `Restart agent (${agentName})`);
        });

        socket.on('stop-agent', (agentName) => {
            void reportAgentOperation(mindcraft.stopAgent(agentName), `Stop agent (${agentName})`);
        });

        socket.on('start-agent', (agentName) => {
            if (hubClosing) return;
            void reportAgentOperation(mindcraft.startAgent(agentName), `Start agent (${agentName})`);
        });

        socket.on('destroy-agent', (agentName) => {
            if (agent_connections[agentName]) {
                void reportAgentOperation(mindcraft.destroyAgent(agentName), `Destroy agent (${agentName})`);
                delete agent_connections[agentName];
            } else {
                void reportAgentOperation(mindcraft.destroyAgent(agentName), `Cancel pending agent creation (${agentName})`);
            }
            agentsStatusUpdate();
        });

        socket.on('stop-all-agents', () => {
            console.log('Killing all agents');
            void reportAgentOperation(mindcraft.stopAllAgents('ui-stop-all'), 'Stop all agents');
        });

        socket.on('shutdown', () => {
            console.log('Shutting down');
            void mindcraft.shutdown({ reason: 'ui-shutdown' });
            
        });

		socket.on('send-message', (agentName, data) => {
			if (!agent_connections[agentName]) {
				console.warn(`Agent ${agentName} not in game, cannot send message via MindServer.`);
				return
			}
			try {
				agent_connections[agentName].socket.emit('send-message', data)
			} catch (error) {
				console.error('Error: ', error);
			}
		});

        socket.on('bot-output', (agentName, message) => {
            io.emit('bot-output', agentName, message);
        });

        socket.on('listen-to-agents', () => {
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
            placeRpcClosing = true;
            return mindcraft.stopAllAgents(reason || 'parent-shutdown', { closing: true });
        }
    });
    mindcraft.setShutdownHandler(request => placeStoreLifecycle?.shutdown(request));
    mindcraft.setTaskEndingHandler(outcome => {
        void mindcraft.shutdown({ reason: 'task-ending', exitCode: outcome.code });
    });

    return server;
}

function reportAgentOperation(operation, label) {
    return Promise.resolve(operation).catch(error => {
        console.error(`${label} failed:`, error?.message || error);
        return null;
    });
}

function settingsForAgent(agentSettings) {
    const result = { ...agentSettings };
    delete result.place_state_dir;
    delete result.place_world_id;
    delete result.place_memory_enabled;
    result.place_memory_enabled = Boolean(settings.place_state_dir && settings.place_world_id);
    result.place_world_id = result.place_memory_enabled ? settings.place_world_id : null;
    result.bot_rules_file = settings.bot_rules_file ?? null;
    return result;
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
    if (!socket) {
        socket = io;
    }
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
    socket.emit('agents-status', agents);
}


let listenerInterval = null;
function addListener(listener_socket) {
    if (agent_listeners.includes(listener_socket)) return;
    agent_listeners.push(listener_socket);
    if (agent_listeners.length === 1) {
        listenerInterval = setInterval(async () => {
            const states = {};
            for (let agentName in agent_connections) {
                let agent = agent_connections[agentName];
                if (agent.in_game) {
                    try {
                        const state = await new Promise((resolve) => {
                            agent.socket.emit('get-full-state', (s) => resolve(s));
                        });
                        states[agentName] = state;
                    } catch (e) {
                        states[agentName] = { error: String(e) };
                    }
                }
            }
            for (let listener of agent_listeners) {
                listener.emit('state-update', states);
            }
        }, 1000);
    }
}

function removeListener(listener_socket) {
    const index = agent_listeners.indexOf(listener_socket);
    if (index < 0) return;
    agent_listeners.splice(index, 1);
    if (agent_listeners.length === 0) {
        clearInterval(listenerInterval);
        listenerInterval = null;
    }
}

// Optional: export these if you need access to them from other files
export const getIO = () => io;
export const getServer = () => server;
export const numStateListeners = () => agent_listeners.length;
