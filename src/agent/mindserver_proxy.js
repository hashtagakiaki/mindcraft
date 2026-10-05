import { io } from 'socket.io-client';
import { createHash } from 'crypto';
import convoManager from './conversation.js';
import { setSettings } from './settings.js';
import { getFullState } from './library/full_state.js';
import { PlaceRpcError, requestPlaceRpc } from '../mindcraft/place_rpc.js';

const PLACE_RPC_TIMEOUT_MS = 5000;

function settingsFingerprint(value) {
    const stable = (item) => Array.isArray(item)
        ? item.map(stable)
        : item && typeof item === 'object'
            ? Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])]))
            : item;
    return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

// agent's individual connection to the mindserver
// always connect to localhost
export class MindServerProxy {
    constructor({ ioFactory = io } = {}) {
        if (MindServerProxy.instance) return MindServerProxy.instance;
        this.ioFactory = ioFactory;
        this.socket = null;
        this.connected = false;
        this.managementReady = false;
        this.agents = [];
        this.connectionGeneration = 0;
        this.serverGeneration = null;
        this.pendingAgents = null;
        this.settingsFingerprint = null;
        this.managementScope = null;
        this.loggedIn = false;
        this.managementPause = Promise.resolve();
        this.managementPaused = false;
        MindServerProxy.instance = this;
    }

    async connect(name, port) {
        if (this.socket) return this.readyPromise;
        this.name = name;
        this.socket = this.ioFactory(`http://localhost:${port}`);
        this._installListeners();
        this.readyPromise = new Promise((resolve, reject) => {
            this.initialResolve = resolve;
            this.initialReject = reject;
        });
        this.socket.on('connect', () => { void this._synchronizeManagement(); });
        this.socket.on('connect_error', (err) => {
            console.error('Connection failed:', err.message);
        });
        return this.readyPromise;
    }

    _installListeners() {
        this.socket.on('disconnect', () => {
            this.connected = false;
            this.managementReady = false;
            this.connectionGeneration++;
            this.pendingAgents = null;
            // Socket.IO retains emits made while disconnected. Never let an old action
            // cross the management boundary when the transport reconnects.
            this.socket.sendBuffer?.splice(0);
            console.log('Disconnected from MindServer; waiting for management recovery');
            this._pauseManagement(true);
        });
        this.socket.on('chat-message', (agentName, json) => {
            if (this.managementReady) convoManager.receiveFromBot(agentName, json);
        });
        this.socket.on('agents-status', (agents) => {
            if (!this.managementReady) {
                this.pendingAgents = agents;
                return;
            }
            this.agents = agents;
            convoManager.updateAgents(agents);
            if (this.agent?.task) this.agent.task.updateAvailableAgents(agents);
        });
        this.socket.on('restart-agent', () => {
            if (!this.managementReady) return;
            console.log(`Restarting agent: ${this.agent?.name}`);
            if (this.agent?.requestShutdown) this.agent.requestShutdown('explicit-restart', { restartIntent: true, code: 0 });
            else this.agent?.cleanKill?.('Explicit restart requested.', 0);
        });
        this.socket.on('send-message', (data, acknowledge) => {
            if (!this.managementReady) return;
            try {
                const onAccepted = result => { if (typeof acknowledge === 'function') acknowledge(result); };
                this.agent.respondFunc(data.from, data.message, data.recipients, { taskId: data.taskId }, onAccepted);
            }
            catch (error) { console.error('Error: ', JSON.stringify(error, Object.getOwnPropertyNames(error))); }
        });
        this.socket.on('get-full-state', (callback) => {
            try { callback(this.managementReady ? getFullState(this.agent) : null); }
            catch (error) { console.error('Error getting full state:', error); callback(null); }
        });
    }

    _pauseManagement(force = false) {
        if (this.managementPaused && !force) return this.managementPause;
        if (!this.agent?.pauseManagement) return this.managementPause;
        this.managementPaused = true;
        try {
            this.managementPause = Promise.resolve(this.agent.pauseManagement('management')).catch(error => {
                console.error('Could not stop the current action after management loss:', error.message);
                return { stopped: false, error };
            });
        } catch (error) {
            console.error('Could not stop the current action after management loss:', error.message);
            this.managementPause = Promise.resolve({ stopped: false, error });
        }
        return this.managementPause;
    }

    async _synchronizeManagement() {
        const socket = this.socket;
        const connectionGeneration = ++this.connectionGeneration;
        this.connected = false;
        this.managementReady = false;
        const pause = this._pauseManagement();
        try {
            const response = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Settings request timed out after 5 seconds')), PLACE_RPC_TIMEOUT_MS);
                socket.emit('get-settings', this.name, (value) => {
                    clearTimeout(timeout);
                    if (value?.error) reject(new Error(value.error));
                    else if (!value?.settings || !value.management) reject(new Error('MindServer returned incomplete management metadata'));
                    else resolve(value);
                });
            });
            if (socket !== this.socket || connectionGeneration !== this.connectionGeneration || !socket.connected) return;
            const pauseResult = await pause;
            if (socket !== this.socket || connectionGeneration !== this.connectionGeneration || !socket.connected) return;
            if (pauseResult?.stopped === false) throw new Error('Current action did not stop safely; management remains paused');
            const { settings, management } = response;
            const scope = { placeMemoryEnabled: Boolean(settings.place_memory_enabled), placeWorldId: settings.place_world_id ?? null };
            const fingerprint = management.settingsFingerprint;
            if (management.agentName !== this.name || settings.profile?.name !== this.name || management.placeMemoryEnabled !== scope.placeMemoryEnabled || management.placeWorldId !== scope.placeWorldId) {
                throw new Error('MindServer management namespace mismatch');
            }
            if (typeof management.generation !== 'string' || !management.generation || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
                throw new Error('MindServer management generation or settings fingerprint is missing or invalid');
            }
            if (settingsFingerprint(settings) !== fingerprint) throw new Error('MindServer settings fingerprint does not match its settings payload');
            if ((scope.placeMemoryEnabled && typeof scope.placeWorldId !== 'string') || (!scope.placeMemoryEnabled && scope.placeWorldId !== null)) {
                throw new Error('MindServer place namespace is malformed');
            }
            if (this.settingsFingerprint !== null && (this.settingsFingerprint !== fingerprint || this.managementScope.placeMemoryEnabled !== scope.placeMemoryEnabled || this.managementScope.placeWorldId !== scope.placeWorldId)) {
                throw new Error('MindServer settings or place namespace changed; agent remains paused');
            }
            if (this.settingsFingerprint === null) {
                this.settingsFingerprint = fingerprint;
                this.managementScope = scope;
                setSettings(settings);
            }
            // Registration and login are repeated on every transport connection. These
            // events are idempotent on the server and carry no world-changing command.
            socket.emit('connect-agent-process', this.name);
            if (this.loggedIn) socket.emit('login-agent', this.name);
            if (socket !== this.socket || connectionGeneration !== this.connectionGeneration || !socket.connected) return;
            const isCurrentConnection = () => socket === this.socket && connectionGeneration === this.connectionGeneration && socket.connected;
            const restoreResult = await this.agent?.restoreManagement?.({
                generation: management.generation,
                connectionToken: connectionGeneration,
                isCurrentConnection,
                ...scope
            });
            if (restoreResult === false || restoreResult?.restored === false || restoreResult?.ready === false) {
                throw new Error('Agent rejected management recovery; agent remains paused');
            }
            if (!isCurrentConnection()) {
                this._pauseManagement(true);
                return;
            }
            this.serverGeneration = management.generation;
            this.connected = true;
            this.managementReady = true;
            this.managementPaused = false;
            if (this.pendingAgents) {
                this.agents = this.pendingAgents;
                this.pendingAgents = null;
                convoManager.updateAgents(this.agents);
                if (this.agent?.task) this.agent.task.updateAvailableAgents(this.agents);
            }
            console.log(this.name, 'connected to MindServer');
            this.initialResolve?.();
            this.initialResolve = null;
            this.initialReject = null;
        } catch (error) {
            if (connectionGeneration === this.connectionGeneration) {
                this.connected = false;
                this.managementReady = false;
                console.error('MindServer management synchronization failed:', error.message);
            }
            this.initialReject?.(error);
        }
    }

    setAgent(agent) {
        this.agent = agent;
        if (!this.managementReady) {
            this.managementPaused = false;
            this._pauseManagement();
        }
    }
    getAgents() {
        return this.agents;
    }

    getNumOtherAgents() {
        return this.agents.length - 1;
    }

    login() {
        this.loggedIn = true;
        if (this.managementReady) this.socket.emit('login-agent', this.agent.name);
    }

    shutdown() {
        if (this.managementReady) this.socket.emit('shutdown');
    }

    getSocket() {
        return this.socket;
    }

    requestPlace(operation, payload = {}, expectedRevision) {
        if (!this.managementReady || !this.socket?.connected) return Promise.reject(new PlaceRpcError('DISCONNECTED', 'MindServer management is not ready'));
        const socket = this.socket;
        const generation = this.connectionGeneration;
        return requestPlaceRpc(socket, operation, payload, expectedRevision, PLACE_RPC_TIMEOUT_MS).then(response => {
            if (!this.managementReady || socket !== this.socket || generation !== this.connectionGeneration) {
                throw new PlaceRpcError('RESULT_UNKNOWN', `Place request '${operation}' crossed a management reconnect; observe state before retrying`);
            }
            return response;
        }).catch(error => {
            if (socket !== this.socket || generation !== this.connectionGeneration) {
                throw new PlaceRpcError('RESULT_UNKNOWN', `Place request '${operation}' crossed a management reconnect; observe state before retrying`);
            }
            throw error;
        });
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
    if (serverProxy.managementReady) serverProxy.getSocket().emit('chat-message', agentName, json);
}

// for sending general output to server for display
export function sendOutputToServer(agentName, message) {
    if (serverProxy.managementReady) serverProxy.getSocket().emit('bot-output', agentName, message);
}
