import { spawn } from 'child_process';
import { promises as fsPromises, readFileSync } from 'fs';
import { randomBytes, randomUUID } from 'crypto';

const SHUTDOWN_TIMEOUT_MS = 5000;
const TERMINATE_TIMEOUT_MS = 2000;
const KILL_TIMEOUT_MS = 2000;
const GROUP_POLL_MS = 50;
const RESTART_WINDOW_MS = 60_000;
const MINIMUM_RESTART_LIFETIME_MS = 10_000;
const MAX_ABNORMAL_RESTARTS = 2;
const RESTART_BACKOFF_BASE_MS = 1000;
const RESTART_BACKOFF_MAX_MS = 5000;

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function readProcessIdentityNow(pid) {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        if (fields.length <= 19 || !Number.isSafeInteger(Number(fields[2])) || !Number.isSafeInteger(Number(fields[3])) || !/^\d+$/.test(fields[19])) {
            return { unknown: true, error: new Error('Could not parse /proc process identity') };
        }
        return { pid, pgid: Number(fields[2]), sid: Number(fields[3]), starttime: fields[19] };
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
        return { unknown: true, error };
    }
}

async function readProcessIdentity(pid) {
    try {
        // Linux /proc stat: after the final ')' are state, ppid, pgrp, session, ...
        const stat = await fsPromises.readFile(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        if (fields.length <= 19 || !Number.isSafeInteger(Number(fields[1])) || !Number.isSafeInteger(Number(fields[2])) || !Number.isSafeInteger(Number(fields[3])) || !/^\d+$/.test(fields[19])) {
            return { unknown: true, error: new Error('Could not parse /proc process identity') };
        }
        return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), sid: Number(fields[3]), starttime: fields[19] };
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
        return { unknown: true, error };
    }
}

async function hasOwnedSessionMember(pid) {
    let entries;
    try { entries = await fsPromises.readdir('/proc'); }
    catch (error) { return error.code === 'ENOENT' || error.code === 'ESRCH' ? false : null; }
    let unknownMember = false;
    for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        const identity = await readProcessIdentity(Number(entry));
        if (identity?.unknown) {
            unknownMember = true;
            continue;
        }
        if (identity?.pgid === pid && identity.sid === pid) return true;
    }
    return unknownMember ? null : false;
}

export class AgentProcess {
    constructor(name, port, options = {}) {
        this.name = name;
        this.port = port;
        this.spawnProcess = options.spawn || spawn;
        this.entrypoint = options.entrypoint || 'src/process/init_agent.js';
        this.readIdentity = options.readIdentity || readProcessIdentity;
        this.notifyLogout = options.logoutAgent || (name => import('../mindcraft/mindserver.js').then(({ logoutAgent }) => logoutAgent(name)));
        this.onTaskEnding = options.onTaskEnding || null;
        this.shutdownTimeout = options.shutdownTimeout ?? SHUTDOWN_TIMEOUT_MS;
        this.terminateTimeout = options.terminateTimeout ?? TERMINATE_TIMEOUT_MS;
        this.killTimeout = options.killTimeout ?? KILL_TIMEOUT_MS;
        this.restartWindow = options.restartWindowMs ?? RESTART_WINDOW_MS;
        this.minimumRestartLifetime = options.minimumRestartLifetimeMs ?? MINIMUM_RESTART_LIFETIME_MS;
        this.maxAbnormalRestarts = options.maxAbnormalRestarts ?? MAX_ABNORMAL_RESTARTS;
        this.restartBackoffBase = options.restartBackoffBaseMs ?? RESTART_BACKOFF_BASE_MS;
        this.restartBackoffMax = options.restartBackoffMaxMs ?? RESTART_BACKOFF_MAX_MS;
        this.managementAuthMode = options.managementAuthMode || 'legacy';
        this.registerBotCredential = options.registerBotCredential || (() => {});
        this.revokeBotCredential = options.revokeBotCredential || (() => {});
        this.authCredentials = new Map();
        this.desiredState = 'stopped';
        this.outcome = null;
        this.ownedGroups = new Map();
        this.generation = 0;
        this.restartTimes = [];
        this.desiredVersion = 0;
        this.transition = Promise.resolve();
        this.stoppingGenerations = new Set();
        this.registrationTasks = new Map();
    }

    get running() {
        return Boolean(this.process && this.desiredState === 'running');
    }

    start(load_memory = false, init_message = null, count_id = 0) {
        this.count_id = count_id;
        this.desiredState = 'running';
        this.desiredVersion += 1;
        this.outcome = null;
        return this.#enqueue(async () => {
            if (this.process) await this.#stopGeneration('replaced', false);
            if (this.outcome?.groupsGone === false) this.desiredState = 'stopped';
            if (this.desiredState !== 'running') return this.outcome;
            if (!this.#spawnGeneration(load_memory, init_message, count_id)) return this.outcome;
            return { state: 'running', generation: this.generation };
        });
    }

    stop(reason = 'explicit-stop') {
        this.desiredState = 'stopped';
        this.desiredVersion += 1;
        return this.#enqueue(async () => {
            if (this.process) await this.#stopGeneration(reason, false);
            else this.outcome = { state: 'stopped', reason, groupsGone: true };
            return this.outcome;
        });
    }

    shutdown(reason = 'parent-shutdown') {
        return this.stop(reason);
    }

    forceRestart() {
        if (this.restartPromise) return this.restartPromise;
        this.desiredState = 'running';
        this.desiredVersion += 1;
        const operation = this.#enqueue(async () => {
            if (this.process) await this.#stopGeneration('explicit-restart', true);
            if (this.desiredState !== 'running' || this.outcome?.groupsGone === false) {
                this.desiredState = 'stopped';
                return this.outcome;
            }
            if (!this.#spawnGeneration(true, 'Agent process restarted.', this.count_id || 0)) return this.outcome;
            return { state: 'running', generation: this.generation };
        });
        this.restartPromise = operation.finally(() => {
            if (this.restartPromise === wrapped) this.restartPromise = null;
        });
        const wrapped = this.restartPromise;
        return wrapped;
    }

    #enqueue(operation) {
        this.transition = this.transition.then(operation, operation);
        return this.transition;
    }

    #spawnGeneration(load_memory, init_message, count_id) {
        const args = [this.entrypoint, this.name, '-n', this.name, '-c', String(count_id)];
        if (this.managementAuthMode === 'protected') args.push('--management-auth-required');
        if (load_memory) args.push('-l', String(load_memory));
        if (init_message) args.push('-m', init_message);
        args.push('-p', String(this.port));

        let child;
        try {
            child = this.spawnProcess(process.execPath, args, {
                detached: true,
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            });
        } catch (error) {
            this.desiredState = 'stopped';
            this.outcome = { state: 'stopped', reason: 'spawn-error', error: error.message, groupsGone: true };
            console.error('Agent process error:', error);
            return false;
        }
        const generation = ++this.generation;
        this.childExitIntent = null;
        this.spawnError = null;
        if (Number.isSafeInteger(child.pid) && child.pid > 1) {
            const group = this.#makeOwnedGroup(child.pid, generation, child);
            this.ownedGroups.set(`bot:${generation}`, group);
        }
        this.process = child;
        this.runningSince = Date.now();
        this.exitPromise = new Promise(resolve => {
            child.once('close', (code, signal) => resolve({ code, signal }));
        });
        this.registrationTasks.set(generation, new Set());
        if (this.managementAuthMode === 'protected') {
            const credential = { spawnId: randomUUID(), token: randomBytes(32).toString('hex') };
            this.authCredentials.set(generation, credential);
            this.registerBotCredential(this.name, credential.spawnId, credential.token);
            child.once('spawn', () => {
                if (generation !== this.generation || child !== this.process || !child.connected) return;
                try { child.send({ type: 'mindcraft:management-auth', ...credential }); }
                catch (error) { console.error('Could not deliver private MindServer credential to agent child'); }
            });
        }
        child.on('message', message => {
            const tasks = this.registrationTasks.get(generation);
            const task = this.#handleChildMessage(message, generation);
            tasks?.add(task);
            task.finally(() => tasks?.delete(task));
        });
        child.once('error', error => {
            this.spawnError = error;
            console.error('Agent process error:', error);
        });
        this.exitPromise.then(exit => this.#enqueue(() => this.#onExit(child, generation, exit)));
        return true;
    }

    async #handleChildMessage(message, generation) {
        if (!message || typeof message !== 'object' || generation !== this.generation) return;
        if (message.type === 'mindcraft:exit-intent') {
            this.childExitIntent = message;
            if (message.restartIntent === false && this.desiredState === 'running') this.desiredState = 'stopped';
            return;
        }
        if (message.type !== 'mindcraft:owned-process' || message.role !== 'cli') return;
        const child = this.process;
        const requestId = typeof message.requestId === 'string' ? message.requestId : null;
        const deny = () => this.#replyOwnership(child, message, false);
        if (!requestId || this.desiredState !== 'running' || this.stoppingGenerations.has(generation)) {
            deny();
            return;
        }
        const pid = Number(message.pid);
        if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isSafeInteger(child?.pid)) {
            deny();
            return;
        }
        const childIdentity = await this.readIdentity(child.pid);
        const identity = await this.readIdentity(pid);
        // An IPC sender can only register a private session descended from its own session.
        // Validate both session/group identity and ancestry before retaining any signal target.
        if (!childIdentity || childIdentity.unknown || !identity || identity.unknown || identity.pgid !== pid || identity.sid !== pid || this.desiredState !== 'running' || this.stoppingGenerations.has(generation)) {
            deny();
            return;
        }
        if (!(await this.#isDescendantOf(pid, child.pid)) || this.desiredState !== 'running' || this.stoppingGenerations.has(generation)) {
            deny();
            return;
        }
        const group = this.#makeOwnedGroup(pid, generation, null, identity.starttime);
        this.ownedGroups.set(`cli:${generation}:${pid}`, group);
        this.#replyOwnership(child, message, true);
    }

    #replyOwnership(child, message, accepted) {
        if (!child?.connected || typeof message.requestId !== 'string') return;
        try {
            child.send({
                type: 'mindcraft:owned-process-ack',
                role: 'cli',
                pid: message.pid,
                requestId: message.requestId,
                accepted,
            });
        } catch {}
    }

    async #isDescendantOf(pid, ancestor) {
        let current = pid;
        const visited = new Set();
        while (current > 1 && !visited.has(current)) {
            if (current === ancestor) return true;
            visited.add(current);
            const identity = await this.readIdentity(current);
            if (!identity) return false;
            current = identity.ppid;
        }
        return false;
    }

    #makeOwnedGroup(pid, generation, leader, starttime = null) {
        const initialIdentity = starttime ? null : readProcessIdentityNow(pid);
        if (!starttime) starttime = initialIdentity?.starttime || null;
        const capturedIdentity = { pid, generation, starttime };
        let signalError = null;
        return {
            ...capturedIdentity,
            leader,
            timeout: this.killTimeout,
            exists: async () => {
                let identity;
                try { identity = await this.readIdentity(pid); }
                catch { return this.#probeGroup(pid); }
                if (identity?.unknown) return this.#probeGroup(pid);
                if (identity && starttime && identity.starttime !== starttime) return false;
                return this.#probeGroup(pid);
            },
            signal: async signal => {
                signalError = null;
                if (!starttime) {
                    signalError = new Error('Could not capture process starttime for owned group');
                    return;
                }
                let identity;
                try { identity = await this.readIdentity(pid); }
                catch (error) { signalError = error; return; }
                if (identity?.unknown) { signalError = identity.error || new Error('Process identity is unknown'); return; }
                if (identity && (!starttime || identity.starttime !== starttime || identity.pgid !== pid || identity.sid !== pid)) return;
                if (!identity) {
                    const matchingSession = await hasOwnedSessionMember(pid);
                    if (matchingSession === null) {
                        signalError = new Error('Could not verify owned process group membership');
                        return;
                    }
                    if (!matchingSession) return;
                }
                try { process.kill(-pid, signal); }
                catch (error) {
                    if (error.code !== 'ESRCH') signalError = error;
                }
            },
            get error() { return signalError; },
        };
    }

    #probeGroup(pid) {
        try { process.kill(-pid, 0); return true; }
        catch (error) { return error.code !== 'ESRCH'; }
    }


    async #stopGeneration(reason, restartIntent) {
        const child = this.process;
        const generation = this.generation;
        if (!child) return;
        const spawnError = this.spawnError;
        this.#revokeCredential(generation);
        const cleanupErrors = [];
        this.stoppingGenerations.add(generation);
        if (child.connected) {
            try { child.send({ type: 'mindcraft:shutdown', reason, restartIntent }); } catch {}
        }
        const exit = this.exitPromise;
        await Promise.race([exit, delay(this.shutdownTimeout)]);
        await this.#settleRegistrations(generation);
        let groupsGone = await this.#groupsGone(generation);
        if (!groupsGone) {
            cleanupErrors.push(...await this.#signalGroups(generation, 'SIGTERM'));
            await this.#waitGroups(generation, this.terminateTimeout);
            groupsGone = await this.#groupsGone(generation);
        }
        if (!groupsGone) {
            cleanupErrors.push(...await this.#signalGroups(generation, 'SIGKILL'));
            await this.#waitGroups(generation, this.killTimeout);
            groupsGone = await this.#groupsGone(generation);
        }
        if (!exit) return;
        if (!(await this.#childClosed(child))) {
            try { child.kill('SIGKILL'); } catch {}
        }
        await Promise.race([exit, delay(this.killTimeout)]);
        if (this.process === child && groupsGone) this.process = null;
        if (groupsGone) this.#forgetGroups(generation);
        this.stoppingGenerations.delete(generation);
        this.outcome = { state: restartIntent ? 'restarting' : 'stopped', reason, restartIntent, groupsGone, ...(cleanupErrors.length ? { cleanupErrors } : {}) };
        this.#logoutAgent();
        if (spawnError) {
            this.desiredState = 'stopped';
            this.outcome = { state: 'stopped', reason: 'spawn-error', error: spawnError.message, groupsGone };
            this.spawnError = null;
            return;
        }
    }

    async #childClosed(child) {
        return child.exitCode !== null || child.signalCode !== null;
    }

    async #groupsGone(generation) {
        const groups = [...this.ownedGroups.values()].filter(group => group.generation === generation);
        const statuses = await Promise.all(groups.map(group => group.exists()));
        return statuses.every(exists => !exists);
    }

    async #settleRegistrations(generation) {
        const tasks = this.registrationTasks.get(generation);
        while (tasks?.size) await Promise.allSettled([...tasks]);
    }

    async #signalGroups(generation, signal) {
        const groups = [...this.ownedGroups.values()].filter(group => group.generation === generation);
        await Promise.all(groups.map(group => group.signal(signal)));
        return groups.filter(group => group.error).map(group => ({ pid: group.pid, message: group.error.message }));
    }

    async #waitGroups(generation, timeout) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline && !(await this.#groupsGone(generation))) await delay(GROUP_POLL_MS);
    }

    #forgetGroups(generation) {
        for (const [key, group] of this.ownedGroups) if (group.generation === generation) this.ownedGroups.delete(key);
        this.registrationTasks.delete(generation);
    }

    #logoutAgent() {
        Promise.resolve()
            .then(() => this.notifyLogout(this.name))
            .catch(error => console.error(`Failed to update MindServer status for ${this.name}:`, error));
    }

    async #onExit(child, generation, { code, signal }) {
        if (generation !== this.generation || this.process !== child) return;
        if (this.stoppingGenerations.has(generation)) return;
        this.#revokeCredential(generation);
        await this.#settleRegistrations(generation);
        const cleanupErrors = [];
        const groupsGone = await this.#groupsGone(generation);
        if (!groupsGone) {
            cleanupErrors.push(...await this.#signalGroups(generation, 'SIGTERM'));
            await this.#waitGroups(generation, this.terminateTimeout);
            if (!(await this.#groupsGone(generation))) {
                cleanupErrors.push(...await this.#signalGroups(generation, 'SIGKILL'));
                await this.#waitGroups(generation, this.killTimeout);
            }
        }
        const clean = await this.#groupsGone(generation);
        const spawnError = this.spawnError;
        if (clean) {
            this.#forgetGroups(generation);
            this.process = null;
        }
        this.#logoutAgent();
        if (spawnError) {
            this.desiredState = 'stopped';
            this.outcome = { state: 'stopped', reason: 'spawn-error', error: spawnError.message, groupsGone: clean };
            this.spawnError = null;
            return;
        }
        const taskCompleted = this.childExitIntent?.reason === 'task-complete';
        if (code > 1 || taskCompleted) {
            const exitCode = taskCompleted
                ? Number.isInteger(code) ? code : signal ? 1 : 0
                : code;
            this.desiredState = 'stopped';
            this.outcome = {
                state: 'task-ending',
                reason: taskCompleted ? 'task-complete' : 'child-exit',
                code: exitCode,
                childCode: code,
                signal,
                groupsGone: clean,
                ...(cleanupErrors.length ? { cleanupErrors } : {}),
            };
            console.log('Ending task');
            process.exitCode = exitCode;
            if (this.onTaskEnding) {
                try {
                    Promise.resolve(this.onTaskEnding(this.outcome)).catch(error => {
                        console.error(`Parent shutdown request failed for ${this.name}:`, error);
                    });
                } catch (error) {
                    console.error(`Parent shutdown request failed for ${this.name}:`, error);
                }
            }
            return;
        }
        if (this.desiredState !== 'running') {
            this.outcome = { state: 'stopped', reason: this.childExitIntent?.reason || 'child-exit', code, signal, groupsGone: clean };
            return;
        }
        const childRestartIntent = this.childExitIntent?.restartIntent === true;
        const explicitChildRestart = childRestartIntent && this.childExitIntent.reason === 'explicit-restart';
        if (explicitChildRestart) {
            this.outcome = { state: 'restarting', reason: 'explicit-restart', restartIntent: true, groupsGone: clean };
            if (clean) this.#spawnGeneration(true, 'Agent process restarted.', this.count_id || 0);
            else this.desiredState = 'stopped';
            return;
        }
        if ((!childRestartIntent && code === 0) || signal === 'SIGINT' || !clean) {
            this.desiredState = 'stopped';
            this.outcome = { state: 'stopped', reason: !clean ? 'owned-group-not-gone' : 'normal-exit', code, signal, groupsGone: clean, ...(cleanupErrors.length ? { cleanupErrors } : {}) };
            return;
        }
        const now = Date.now();
        this.restartTimes = this.restartTimes.filter(time => now - time < this.restartWindow);
        if (this.restartTimes.length >= this.maxAbnormalRestarts || now - this.runningSince < this.minimumRestartLifetime) {
            this.desiredState = 'stopped';
            this.outcome = { state: 'stopped', reason: 'restart-budget-exhausted', code, signal, groupsGone: clean };
            return;
        }
        const backoff = Math.min(this.restartBackoffBase * (2 ** this.restartTimes.length), this.restartBackoffMax);
        this.restartTimes.push(now);
        this.outcome = {
            state: 'backoff',
            reason: childRestartIntent ? (this.childExitIntent.reason || 'child-automatic-restart') : 'abnormal-exit',
            code,
            signal,
            backoffMs: backoff,
            restartIntent: childRestartIntent,
            groupsGone: clean,
        };
        const desiredVersion = this.desiredVersion;
        await delay(backoff);
        if (this.desiredState === 'running' && this.desiredVersion === desiredVersion && !this.process) this.#spawnGeneration(true, 'Agent process restarted.', this.count_id || 0);
    }

    #revokeCredential(generation) {
        const credential = this.authCredentials.get(generation);
        if (!credential) return;
        this.authCredentials.delete(generation);
        this.revokeBotCredential(this.name, credential.spawnId);
    }
}
