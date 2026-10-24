import { createHash, randomUUID } from 'node:crypto';

const MAX_TASKS = 128;
const MAX_EVENTS_PER_TASK = 64;

const taskHash = message => createHash('sha256').update(message).digest('hex');
const terminalStates = new Set(['completed', 'error', 'cancelled', 'rejected']);

export class WorkerTaskRegistry {
    constructor(hubGeneration) {
        this.hubGeneration = hubGeneration;
        this.tasks = new Map();
        this.requests = new Map();
        this.waiters = new Set();
    }

    begin({ bot, requestId, message, connectionGeneration }) {
        const key = requestId;
        const hash = taskHash(message);
        const previous = this.requests.get(key);
        if (previous) {
            if (previous.handle.bot !== bot || previous.contentHash !== hash)
                return { accepted: false, error: 'request ID was already used with a different bot or task content' };
            return { accepted: true, duplicate: true, record: previous };
        }
        if (this.tasks.size >= MAX_TASKS) return { accepted: false, error: 'worker task retention capacity reached' };
        const record = {
            handle: { id: randomUUID(), bot, taskId: randomUUID(), requestId,
                hubGeneration: this.hubGeneration, connectionGeneration, cursor: 0 },
            contentHash: hash,
            status: 'accepting',
            accepted: false,
            events: [],
            sequence: 0,
            terminal: false,
            lastReport: null,
            lastOutcome: null,
        };
        this.tasks.set(record.handle.id, record);
        this.requests.set(key, record);
        return { accepted: true, duplicate: false, record };
    }

    find({ handle, bot, requestId }) {
        let record;
        if (handle && typeof handle.id === 'string') record = this.tasks.get(handle.id);
        else if (typeof requestId === 'string') {
            record = this.requests.get(requestId);
            if (record && bot && record.handle.bot !== bot) return null;
        }
        if (!record) return null;
        if (handle && !this.matches(record, handle)) return null;
        return record;
    }

    matches(record, handle) {
        const expected = record.handle;
        return handle?.id === expected.id && handle?.bot === expected.bot
            && handle?.taskId === expected.taskId && handle?.requestId === expected.requestId
            && handle?.hubGeneration === expected.hubGeneration
            && handle?.connectionGeneration === expected.connectionGeneration;
    }

    accept(record) {
        if (record.terminal) return this.snapshot(record);
        if (record.status === 'running') return this.snapshot(record);
        record.status = 'running';
        record.accepted = true;
        this.append(record, 'accepted', {});
        return this.snapshot(record);
    }

    reject(record, error, admission = null) {
        if (!record.terminal) {
            record.status = 'rejected';
            record.terminal = true;
            record.lastOutcome = { status: 'rejected', error, ...(admission ? { admission } : {}) };
            this.append(record, 'terminal', { outcome: record.lastOutcome });
        }
        return this.snapshot(record);
    }

    acceptanceUnknown(record) {
        if (!record.terminal) {
            record.status = 'unknown';
            this.append(record, 'unknown', { reason: 'agent acceptance acknowledgement timed out; query by request ID, do not replay' });
        }
        return this.snapshot(record);
    }

    recordAgentEvent(record, payload, { bot, connectionGeneration, hubGeneration }) {
        if (!record || record.terminal || payload?.bot !== bot
            || payload?.taskId !== record.handle.taskId
            || payload?.handleId !== record.handle.id
            || payload?.hubGeneration !== hubGeneration
            || payload?.hubGeneration !== this.hubGeneration
            || payload?.connectionGeneration !== record.handle.connectionGeneration
            || connectionGeneration !== record.handle.connectionGeneration
            || typeof payload.type !== 'string') return { accepted: false, error: 'worker task scope is stale or mismatched' };
        if (!['accepted', 'progress', 'report', 'support', 'stopping', 'terminal'].includes(payload.type))
            return { accepted: false, error: 'unsupported worker task event' };
        if (['report', 'support'].includes(payload.type)
            && (typeof payload.message !== 'string' || !payload.message.trim() || payload.message.length > 4000))
            return { accepted: false, error: 'worker report must be 1-4000 characters' };
        if (payload.type === 'report' && payload.phase !== 'final_answer')
            return { accepted: false, error: 'only final worker answers are forwarded as reports' };
        if (payload.type === 'progress' && (!payload.progress || typeof payload.progress.kind !== 'string'
            || JSON.stringify(payload.progress).length > 1000))
            return { accepted: false, error: 'worker progress is malformed or too large' };
        if (payload.type === 'terminal' && JSON.stringify(payload.outcome).length > 8000)
            return { accepted: false, error: 'worker terminal outcome is too large' };
        if (payload.type === 'accepted' && record.status === 'running') return { accepted: true, duplicate: true, cursor: record.sequence };
        if (payload.type === 'terminal') {
            const status = payload.outcome?.status;
            if (!['completed', 'error', 'cancelled', 'unknown'].includes(status))
                return { accepted: false, error: 'terminal outcome is malformed' };
            record.status = status;
            record.terminal = terminalStates.has(status);
            record.lastOutcome = payload.outcome;
        } else if (payload.type === 'accepted') { record.status = 'running'; record.accepted = true; }
        else if (payload.type === 'stopping') record.status = 'stopping';
        else if (payload.type === 'report' || payload.type === 'support') {
            record.status = 'running';
            record.lastReport = { type: payload.type, message: payload.message, phase: payload.phase };
        } else if (payload.type === 'progress') record.lastProgress = payload.progress;
        this.append(record, payload.type, payload.type === 'terminal' ? { outcome: payload.outcome }
            : payload.type === 'progress' ? { progress: payload.progress } : { message: payload.message, phase: payload.phase });
        return { accepted: true, cursor: record.sequence };
    }

    markDisconnected(bot, connectionGeneration) {
        for (const record of this.tasks.values()) {
            if (record.handle.bot !== bot || record.handle.connectionGeneration !== connectionGeneration || record.terminal) continue;
            record.status = 'unknown';
            record.terminal = true;
            this.append(record, 'unknown', { reason: 'receiver-disconnected; runtime outcome is unknown' });
        }
    }

    snapshot(record, cursor = record.sequence) {
        const oldest = record.events[0]?.sequence ?? record.sequence + 1;
        return { handle: { ...record.handle, cursor: record.sequence }, status: record.status,
            accepted: record.accepted, terminal: record.terminal, cursor: record.sequence, eventsTruncated: cursor < oldest - 1,
            report: record.lastReport, progress: record.lastProgress, outcome: record.lastOutcome,
            events: record.events.filter(event => event.sequence > cursor).map(event => ({ ...event })) };
    }

    async wait(handles, timeoutMs) {
        const snapshots = () => handles.map(handle => {
            const record = this.find({ handle });
            return record ? this.snapshot(record, Number.isSafeInteger(handle.cursor) ? handle.cursor : 0)
                : { handle, status: 'unknown', terminal: true, cursor: 0, eventsTruncated: true, events: [] };
        });
        const wakeTypes = new Set(['report', 'support', 'stopping', 'terminal', 'unknown']);
        const changed = values => values.some(value => value.status === 'unknown'
            || value.events.some(event => wakeTypes.has(event.type)));
        let current = snapshots();
        if (changed(current) || timeoutMs === 0) return { timedOut: !changed(current), tasks: current };
        let wake;
        const waitPromise = new Promise(resolve => { wake = resolve; });
        const waiter = () => {
            current = snapshots();
            if (changed(current)) wake();
        };
        this.waiters.add(waiter);
        // Recheck after subscription so an event cannot land in the snapshot/subscribe gap.
        waiter();
        let timer;
        try {
            await Promise.race([waitPromise, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
        } finally {
            clearTimeout(timer);
            this.waiters.delete(waiter);
        }
        current = snapshots();
        return { timedOut: !changed(current), tasks: current };
    }

    append(record, type, detail) {
        const event = { handle: { ...record.handle }, sequence: ++record.sequence,
            type, at: new Date().toISOString(), ...detail };
        record.events.push(event);
        if (record.events.length > MAX_EVENTS_PER_TASK) record.events.splice(0, record.events.length - MAX_EVENTS_PER_TASK);
        for (const wake of this.waiters) wake();
        return event;
    }
}
