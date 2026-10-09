import { AsyncLocalStorage } from 'node:async_hooks';

const ownership = new AsyncLocalStorage();
export const NATIVE_EXECUTION_WINDOW_MS = 45_000;

export function operationContext() { return ownership.getStore()?.operation ?? null; }

export function createOperationContext(action, agent, manager, taskId = null) {
    return {
        actionId: action.id, taskId: taskId ?? agent.currentTaskId ?? agent.task?.data?.task_id ?? null, intentEpoch: manager.intentEpoch,
        managementGeneration: agent._managementGeneration ?? null,
        connectionGeneration: agent.bot?.getActionCancellationContext?.()?.connectionGeneration ?? null,
        dimension: agent.bot?.game?.dimension ?? null,
        signal: action.controller.signal, bot: agent.bot,
        cancellation: agent.bot?.getActionCancellationContext?.() ?? null,
        accepting: true, closed: false, sequence: 0, waitSequence: 0,
        calls: [], facts: [], uncertain: [], diagnostics: [], pending: new Set(),
        root: { id: null, activeChild: null, closed: false, phase: 'main' },
    };
}

export async function runOwnedOperation(operation, body) {
    let value, error;
    try { value = await ownership.run({ operation, call: operation.root }, body); }
    catch (caught) { error = caught; }
    finally {
        operation.accepting = false;
        operation.root.closed = true;
        if (error && operation.pending.size && !operation.signal.aborted) operation.requestStop?.('body-error');
        // A child can delegate further owned work while draining. Repeat until all settle.
        while (operation.pending.size) await Promise.allSettled([...operation.pending]);
        operation.closed = true;
    }
    if (error) throw error;
    return value;
}

export function recordConfirmation(detail) {
    const store = ownership.getStore();
    if (!store) return;
    const { operation, call } = store;
    const event = { eventId: `${operation.actionId}:fact:${operation.facts.length + 1}`,
        actionId: operation.actionId, taskId: operation.taskId, callId: call.id,
        parentCallId: call.parentCallId ?? null, phase: store.phase ?? call.phase,
        observedAt: new Date().toISOString(), dimension: operation.dimension,
        connectionGeneration: operation.connectionGeneration, ...detail };
    if (operation.closed || call.closed) operation.diagnostics.push({ kind: 'late_confirmation', event });
    else operation.facts.push(event);
}

export function recordUncertainty(detail) {
    const store = ownership.getStore();
    if (!store) return;
    const { operation, call } = store;
    const event = { eventId: `${operation.actionId}:uncertainty:${operation.uncertain.length + 1}`,
        actionId: operation.actionId, taskId: operation.taskId, callId: call.id, parentCallId: call.parentCallId ?? null,
        phase: store.phase ?? call.phase, observedAt: new Date().toISOString(), dimension: operation.dimension,
        connectionGeneration: operation.connectionGeneration, ...detail };
    (operation.closed || call.closed ? operation.diagnostics : operation.uncertain).push(event);
}

export function recordOwnedWait(detail) {
    const store = ownership.getStore();
    if (!store) return;
    const { operation, call } = store;
    if (operation.closed || call.closed) return;
    if (!call.waits) call.waits = [];
    call.waits.push({
        waitId: `${call.id}:wait:${++operation.waitSequence}`,
        actionId: operation.actionId, taskId: operation.taskId, callId: call.id,
        parentCallId: call.parentCallId ?? null,
        phase: detail.phase ?? store.phase ?? call.phase,
        ...detail,
    });
}

export function beginOwnedWait(detail) {
    const store = ownership.getStore();
    if (!store) return null;
    const { operation, call } = store;
    if (operation.closed || call.closed) return null;
    if (!call.waits) call.waits = [];
    const wait = {
        waitId: `${call.id}:wait:${++operation.waitSequence}`,
        actionId: operation.actionId, taskId: operation.taskId, callId: call.id,
        parentCallId: call.parentCallId ?? null,
        phase: detail.phase ?? store.phase ?? call.phase,
        progressCount: 0, status: 'waiting', ...detail,
    };
    call.waits.push(wait);
    call.activeWait = wait;
    return wait;
}

export function markOwnedWaitProgress(wait) {
    const store = ownership.getStore();
    if (!wait || !store || store.operation.closed || store.call.closed || wait.status !== 'waiting') return;
    wait.progressCount++;
    wait.lastProgressAt = new Date().toISOString();
}

export function finishOwnedWait(wait, detail) {
    const store = ownership.getStore();
    if (!wait || !store || store.operation.closed || store.call.closed) return;
    Object.assign(wait, detail, { status: detail.outcome ?? 'settled', endedAt: detail.endedAt ?? new Date().toISOString() });
    if (store.call.activeWait === wait) store.call.activeWait = null;
}

export function withSkillPhase(phase, body) {
    const store = ownership.getStore();
    return store ? ownership.run({ ...store, phase }, body) : body();
}

export function registerOwnedPromise(promise) {
    const operation = operationContext();
    if (!operation || !promise?.then) return promise;
    operation.pending.add(promise);
    promise.then(() => operation.pending.delete(promise), () => operation.pending.delete(promise));
    return promise;
}

export function trackSkill(name, body) {
    const tracked = function (...args) {
        const store = ownership.getStore();
        if (!store) return body.apply(this, args); // reflex/raw paths outside an action remain explicit noncoverage.
        const { operation, call: parent } = store;
        const call = { id: `${operation.actionId}:skill:${++operation.sequence}`,
            parentCallId: parent.id, skill: name, phase: store.phase ?? parent.phase,
            startedAt: new Date().toISOString(), closed: false, accepting: true, activeChild: null };
        const reject = reason => {
            const rejected = { ...call, status: 'rejected', reason, endedAt: new Date().toISOString() };
            if (operation.closed || parent.closed) operation.diagnostics.push({ kind: 'late_sdk_call', call: rejected });
            else operation.calls.push(rejected);
            const promise = Promise.reject(new Error(reason));
            promise.catch(() => {}); // host records rejection even if generated code ignores its promise.
            return promise;
        };
        if (operation.closed || parent.closed || parent.accepting === false || (!operation.accepting && parent === operation.root)) return reject('SDK call after owner body closed');
        if (operation.signal.aborted || operation.bot.interrupt_code) return reject('Action cancelled');
        if (parent.activeChild) return reject('Parallel SDK calls are not supported; await the current call');
        parent.activeChild = call;
        operation.calls.push(call);
        const pending = ownership.run({ operation, call }, async () => {
            try {
                const value = await body.apply(this, args);
                call.returnValue = typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' ? value : null;
                call.status = operation.signal.aborted ? 'cancelled' : value === false ? 'returned_false' : value === true ? 'returned_true' : 'returned';
                return value;
            } catch (error) {
                call.status = operation.signal.aborted ? 'cancelled'
                    : name === 'generated_code' && error === operation.executionYieldError ? 'yielded' : 'error';
                call.error = String(error);
                throw error;
            } finally {
                call.accepting = false;
                // A parent skill returning does not make its own unawaited child disappear.
                if (call.activeChild?.promise) await Promise.allSettled([call.activeChild.promise]);
                call.closed = true;
                call.endedAt = new Date().toISOString();
                if (parent.activeChild === call) parent.activeChild = null;
            }
        });
        call.promise = pending;
        operation.pending.add(pending);
        pending.then(() => operation.pending.delete(pending), () => operation.pending.delete(pending));
        return pending;
    };
    Object.defineProperty(tracked, 'name', { value: body.name });
    tracked.toString = () => body.toString(); // existing docHelper keeps the source-owned JSDoc.
    return tracked;
}

export function operationResult(operation) {
    return {
        taskId: operation.taskId,
        operationSettlement: 'settled',
        skillResults: operation.calls.map(({ promise, activeChild, activeWait, closed, accepting, ...call }) => ({ ...call })),
        confirmedChanges: operation.facts.map(event => ({ ...event })),
        unconfirmedChanges: operation.uncertain.map(event => ({ ...event })),
        trackingScope: 'public SDK calls; raw bot/plugin work is not fully tracked',
        lateDiagnostics: operation.diagnostics,
        ...(operation.sdkFailure ? { sdkFailure: operation.sdkFailure } : {}),
        ...(operation.executionYield ? { executionYield: operation.executionYield } : {}),
    };
}

// Legacy commands return a string to chat/model history. Project the same
// settled events into that string without creating a second fact ledger.
export function operationFactsSummary(result) {
    const lines = [];
    const outcomes = [];
    if (result && typeof result === 'object' && ('success' in result || result.executionStatus || result.domainReturn !== undefined)) {
        outcomes.push(`executor=${result.success === true ? 'success' : result.success === false ? 'failure' : 'unknown'}`);
        if (result.executionStatus) outcomes.push(`execution=${result.executionStatus}`);
        if (result.domainReturn !== undefined) outcomes.push(`domain=${result.domainReturn === false ? 'returned false' : result.domainReturn === true ? 'returned true (not goal verification)' : String(result.domainReturn)}`);
    }
    for (const call of result?.skillResults ?? []) {
        if (['returned_false', 'error', 'rejected', 'cancelled'].includes(call.status)) {
            outcomes.push(`skill ${call.skill ?? 'unknown'}=${call.status}${call.error || call.reason ? ` (${call.error ?? call.reason})` : ''}`);
        }
    }
    if (outcomes.length) lines.push(`operation outcome: ${outcomes.join('; ')}`);
    const targetText = target => {
        if (target == null) return 'target unknown';
        if (typeof target !== 'object') return String(target);
        return Object.entries(target).map(([key, value]) => `${key}=${value != null && typeof value === 'object' ? JSON.stringify(value) : value}`).join(', ') || 'target unknown';
    };
    const identity = fact => fact.eventId ? `; event=${fact.eventId}; call=${fact.callId ?? 'unknown'}` : '';
    for (const fact of result?.confirmedChanges ?? []) {
        const quantity = fact.quantity == null ? 'amount unknown' : `${fact.quantity} ${fact.unit ?? 'units'}`;
        lines.push(`confirmed ${quantity}; ${targetText(fact.target)}; phase=${fact.phase ?? 'unknown'}; at=${fact.observedAt ?? 'unknown'}${identity(fact)}; evidence=${fact.evidence ?? 'unspecified'}`);
    }
    for (const fact of result?.unconfirmedChanges ?? []) {
        const quantity = fact.confirmedQuantity == null ? 'amount unknown' : `${fact.confirmedQuantity} ${fact.unit ?? 'units'}`;
        lines.push(`unconfirmed ${quantity}; ${targetText(fact.target)}; phase=${fact.phase ?? 'unknown'}; at=${fact.observedAt ?? 'unknown'}${identity(fact)}; evidence=${fact.evidence ?? fact.reason ?? 'unspecified'}`);
    }
    return lines.length ? `\nOperation facts from settled SDK calls:\n${lines.map(line => `- ${line}`).join('\n')}` : '';
}
