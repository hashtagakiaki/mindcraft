import { io } from 'socket.io-client';
import convoManager from './conversation.js';
import { setSettings } from './settings.js';
import { getFullState } from './library/full_state.js';
import { PlaceRpcError, requestPlaceRpc } from '../mindcraft/place_rpc.js';

const PLACE_RPC_TIMEOUT_MS = 5000;

// agent's individual connection to the mindserver
// always connect to localhost

class MindServerProxy {
    constructor() {
        if (MindServerProxy.instance) {
            return MindServerProxy.instance;
        }
        
        this.socket = null;
        this.connected = false;
        this.agents = [];
        MindServerProxy.instance = this;
    }

    async connect(name, port) {
        if (this.connected) return;
        
        this.name = name;
        this.socket = io(`http://localhost:${port}`);

        await new Promise((resolve, reject) => {
            this.socket.on('connect', resolve);
            this.socket.on('connect_error', (err) => {
                console.error('Connection failed:', err);
                reject(err);
            });
        });

        this.connected = true;
        console.log(name, 'connected to MindServer');

        this.socket.on('disconnect', () => {
            console.log('Disconnected from MindServer');
            this.connected = false;
            if (this.agent) {
                this.agent.cleanKill('Disconnected from MindServer. Killing agent process.');
            }
        });

        this.socket.on('chat-message', (agentName, json) => {
            convoManager.receiveFromBot(agentName, json);
        });

        this.socket.on('agents-status', (agents) => {
            this.agents = agents;
            convoManager.updateAgents(agents);
            if (this.agent?.task) {
                console.log(this.agent.name, 'updating available agents');
                this.agent.task.updateAvailableAgents(agents);
            }
        });

        this.socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            this.agent.cleanKill();
        });
		
        this.socket.on('send-message', (data) => {
            try {
                this.agent.respondFunc(data.from, data.message);
            } catch (error) {
                console.error('Error: ', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            }
        });

        this.socket.on('get-full-state', (callback) => {
            try {
                const state = getFullState(this.agent);
                callback(state);
            } catch (error) {
                console.error('Error getting full state:', error);
                callback(null);
            }
        });

        // Request settings and wait for response
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Settings request timed out after 5 seconds'));
            }, 5000);

            this.socket.emit('get-settings', name, (response) => {
                clearTimeout(timeout);
                if (response.error) {
                    return reject(new Error(response.error));
                }
                setSettings(response.settings);
                this.socket.emit('connect-agent-process', name);
                resolve();
            });
        });
    }

    setAgent(agent) {
        this.agent = agent;
    }

    getAgents() {
        return this.agents;
    }

    getNumOtherAgents() {
        return this.agents.length - 1;
    }

    login() {
        this.socket.emit('login-agent', this.agent.name);
    }

    shutdown() {
        this.socket.emit('shutdown');
    }

    getSocket() {
        return this.socket;
    }

    requestPlace(operation, payload = {}, expectedRevision) {
        if (!this.connected || !this.socket) return Promise.reject(new PlaceRpcError('DISCONNECTED', 'MindServer is not connected'));
        return requestPlaceRpc(this.socket, operation, payload, expectedRevision, PLACE_RPC_TIMEOUT_MS);
    }

    async queryPlaces(criteria = {}) {
        return (await this.requestPlace('query', criteria)).value;
    }

    async getPlace(placeId) {
        return (await this.requestPlace('get', { placeId })).value;
    }

    async inspectPlace(placeId) {
        return (await this.requestPlace('inspect', { placeId })).value;
    }

    async resolvePlaceAlias(alias) {
        return (await this.requestPlace('resolve_alias', { alias })).value;
    }

    async getPlacePreferences() {
        return (await this.requestPlace('preferences')).value;
    }

    async rememberPlace(place, { alias, expectedRevision } = {}) {
        return this.requestPlace('remember', { place, alias }, expectedRevision);
    }

    async updatePlaceObservation(observation, expectedRevision) {
        return this.requestPlace('observation', observation, expectedRevision);
    }

    async recordPlaceVisit(visit, expectedRevision) {
        return this.requestPlace('visit', visit, expectedRevision);
    }

    async setPlaceRelation(relation, expectedRevision) {
        return this.requestPlace('relation', relation, expectedRevision);
    }

    async setPlaceAlias(alias, placeId, expectedRevision) {
        return this.requestPlace('alias', { alias, placeId }, expectedRevision);
    }

    async setPlacePreference(preference, expectedRevision) {
        return this.requestPlace('preference', preference, expectedRevision);
    }
}

// Create and export a singleton instance
export const serverProxy = new MindServerProxy();

// for chatting with other bots
export function sendBotChatToServer(agentName, json) {
    serverProxy.getSocket().emit('chat-message', agentName, json);
}

// for sending general output to server for display
export function sendOutputToServer(agentName, message) {
    serverProxy.getSocket().emit('bot-output', agentName, message);
}
