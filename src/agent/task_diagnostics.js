// Bounded projection of the existing native task/operation records. No replay or log reader.
import settings from './settings.js';

const VERSION = 1;
const MAX_OPERATIONS = 6;
const MAX_TEXT = 1000;
const MAX_ENTRIES = 12;

function text(value, limit = MAX_TEXT) {
    if (value == null) return null;
    const string = String(value);
    return string.length > limit ? string.slice(0, limit) + '…[truncated]' : string;
}

function bounded(value, depth = 0, budget = { chars: 4000, nodes: 120 }) {
    if (--budget.nodes < 0 || budget.chars <= 0) return '[truncated budget]';
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
        const result = text(value, Math.min(MAX_TEXT, budget.chars));
        budget.chars -= result.length;
        return result;
    }
    if (depth >= 5) return '[truncated depth]';
    if (Array.isArray(value)) return value.slice(-MAX_ENTRIES).map(item => bounded(item, depth + 1, budget));
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 20)
        .map(([key, item]) => [text(key, 80), bounded(item, depth + 1, budget)]));
    return text(value);
}

export function diagnosticScope(agent) {
    return { bot: typeof agent?.name === 'string' && agent.name ? agent.name : null,
        worldId: typeof settings.place_world_id === 'string' && settings.place_world_id ? settings.place_world_id : null };
}

export function readTaskDiagnostics(agent, snapshot = agent.history?.taskDiagnostics) {
    const scope = diagnosticScope(agent);
    if (!scope.bot || !scope.worldId) return { available: false, reason: 'current bot/world scope unavailable' };
    if (!snapshot) return { available: false, reason: 'no previous native task diagnostic' };
    if (JSON.stringify(snapshot).length > 256000)
        return { available: false, reason: 'native task diagnostic exceeds retention bound' };
    if (snapshot.version !== VERSION || !snapshot.scope || !Array.isArray(snapshot.operations) || snapshot.operations.length > MAX_OPERATIONS)
        return { available: false, reason: 'invalid native task diagnostic' };
    if (snapshot.scope.bot !== scope.bot || snapshot.scope.worldId !== scope.worldId)
        return { available: false, reason: 'previous diagnostic belongs to a different bot/world' };
    return { available: true, snapshot: JSON.parse(JSON.stringify(snapshot)) };
}

export function createTaskDiagnostics(agent, taskId) {
    const now = new Date().toISOString();
    return { version: VERSION, scope: diagnosticScope(agent), taskId: text(taskId, 200), startedAt: now,
        updatedAt: now, status: 'running', operations: [], lastFailure: null, terminal: null,
        coverage: 'Public SDK facts only; raw bot/plugin mutations may be untracked. Historical observations are not current world state.' };
}

export function appendOperationDiagnostic(snapshot, code, result) {
    const exceptionMarker = '!!Code threw exception!!\nError: ';
    const failure = result.error ?? (result.success === false
        ? String(result.message ?? '').split(exceptionMarker).pop() : null);
    const skillResults = bounded((result.skillResults ?? []).slice(-MAX_ENTRIES).map(call => ({
        skill: call.skill, status: call.status, error: call.error, reason: call.reason,
        returnValue: call.returnValue, startedAt: call.startedAt, endedAt: call.endedAt,
    })));
    const entry = { observedAt: new Date().toISOString(), code: text(code, 6000),
        codeTruncated: String(code).length > 6000,
        executionStatus: result.executionStatus ?? null, success: result.success ?? null,
        error: text(failure, 4000),
        output: text(result.message, 3000), skillResults,
        confirmedChanges: bounded(result.confirmedChanges ?? []),
        unconfirmedChanges: bounded(result.unconfirmedChanges ?? []),
        changesTruncated: (result.confirmedChanges?.length ?? 0) > MAX_ENTRIES || (result.unconfirmedChanges?.length ?? 0) > MAX_ENTRIES,
        skillResultsTruncated: (result.skillResults?.length ?? 0) > MAX_ENTRIES,
        observed: bounded(result.observed), operationSettlement: result.operationSettlement ?? null,
    };
    snapshot.operations.push(entry);
    if (snapshot.operations.length > MAX_OPERATIONS) {
        snapshot.operations.shift();
        snapshot.operationsTruncated = true;
    }
    if (entry.success === false || (result.skillResults ?? []).some(call => ['error', 'rejected', 'cancelled', 'returned_false'].includes(call.status)))
        snapshot.lastFailure = entry;
    snapshot.updatedAt = entry.observedAt;
}

export function finishTaskDiagnostics(snapshot, terminal) {
    snapshot.status = terminal.status;
    snapshot.updatedAt = new Date().toISOString();
    snapshot.terminal = bounded({ status: terminal.status, completion: terminal.completion,
        terminationReason: terminal.terminationReason, error: terminal.error,
        operationSettlement: terminal.operationSettlement, response: terminal.response,
        reportedAt: terminal.reportedAt, cleanupError: terminal.cleanupError });
}
