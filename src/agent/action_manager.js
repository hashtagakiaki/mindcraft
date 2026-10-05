import { createOperationContext, runOwnedOperation, operationResult } from './library/operation_context.js';

export class ActionManager {
    constructor(agent) {
        this.agent = agent;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
        this.resume_func = null;
        this.resume_name = '';
        this.last_action_time = 0;
        this.recent_action_counter = 0;
        this.transition = Promise.resolve();
        this.actionId = 0;
        this.timeoutEscalations = new Map();
        this.currentAction = null;
        this.userStopped = false;
        this.shuttingDown = false;
        this.managementPaused = Boolean(agent.managementPaused);
        this.managementIntentRequired = Boolean(agent._managementInterruption);
        this.managementStopFailed = false;
        this.intentEpoch = 0;
        this.recoveryPaused = false;
        this.recoveryAttempts = 0;
        this.recoveryEventId = 0;
        this.notifiedRecoveryActions = new Set();
    }

    beginUserIntent() {
        if (this.shuttingDown) return this.intentEpoch;
        if (this.managementPaused) return this.intentEpoch;
        this.intentEpoch++;
        this.userStopped = false;
        this.managementIntentRequired = false;
        this.recoveryPaused = false;
        this.recoveryAttempts = 0;
        this.recent_action_counter = 0;
        this.cancelResume();
        return this.intentEpoch;
    }

    nextRecoveryEventId() { return ++this.recoveryEventId; }

    pauseForRecovery() {
        this.recoveryPaused = true;
        this.cancelResume();
        return this.recoveryAttempts;
    }

    recordRecoveryAttempt() {
        this.recoveryPaused = true;
        this.cancelResume();
        this.recoveryAttempts++;
        return this.recoveryAttempts;
    }

    clearRecoveryAfterProgress() {
        this.recoveryPaused = false;
        this.recoveryAttempts = 0;
        this.recent_action_counter = 0;
    }

    pauseForManagement(reason = 'management') {
        this.managementPaused = true;
        this.managementIntentRequired = true;
        this.intentEpoch++;
        this.cancelResume();
        return this.stop(reason);
    }

    beginShutdown() {
        if (this.shuttingDown) return this.currentAction ? this.stop('shutdown') : Promise.resolve({ stopped: true, reason: 'shutdown', actionId: null, phase: null });
        this.shuttingDown = true;
        this.userStopped = true;
        this.intentEpoch++;
        this.cancelResume();
        this.agent.self_prompter?.stopForRecovery?.();
        return this.stop('shutdown');
    }

    restoreManagement(meta) {
        if (!meta?.isCurrentConnection?.() || this.managementStopFailed || this.currentAction) return false;
        this.managementPaused = false;
        return true;
    }

    getCancellationContext(actionId = this.currentAction?.id) {
        const action = this.currentAction;
        if (!action || action.id !== actionId) return null;
        const context = {
            actionId: action.id,
            signal: action.controller.signal,
            settled: action.settled.promise
        };
        Object.defineProperties(context, {
            phase: { enumerable: true, get: () => action.phase },
            reason: { enumerable: true, get: () => action.reason }
        });
        return context;
    }

    setPhase(phase, actionId = this.currentAction?.id) {
        const action = this.currentAction;
        if (!action || action.id !== actionId || action.settledState) return false;
        action.phase = String(phase);
        return true;
    }

    async resumeAction(actionLabel, actionFn, timeout) {
        if (this.shuttingDown) return this._rejectedResult('shutdown');
        if (this.managementPaused) return this._rejectedResult('management-paused');
        if (this.managementIntentRequired) return this._rejectedResult('management-intent-required');
        if (this.agent.bot?.inventoryUnconfirmed) return this._rejectedResult('inventory-unconfirmed');
        if (this.recoveryPaused) return this._rejectedResult('recovery-paused');
        return this._executeResume(actionLabel, actionFn, timeout);
    }

    async runAction(actionLabel, actionFn, { timeout, resume = false, stallTimeoutMs = 0, outputLimit = MAX_OUTPUT_LENGTH, taskId = null } = {}) {
        if (this.shuttingDown) return this._rejectedResult('shutdown');
        if (this.managementPaused) return this._rejectedResult('management-paused');
        if (this.managementIntentRequired) return this._rejectedResult('management-intent-required');
        if (this.agent.bot?.inventoryUnconfirmed) return this._rejectedResult('inventory-unconfirmed');
        const recoveryAdmissionId = this.agent._recoveryPromptCommand && actionLabel.startsWith('action:')
            ? this.agent._recoveryAdmissionId
            : null;
        if (this.recoveryPaused && !this.isRecoveryAdmission(actionLabel, recoveryAdmissionId)) return this._rejectedResult('recovery-paused');
        if (resume) return this._executeResume(actionLabel, actionFn, timeout);
        const epoch = this.intentEpoch;
        if (this.userStopped) return this._rejectedResult('user-stop');
        return this._executeAction(actionLabel, actionFn, timeout, epoch, recoveryAdmissionId, { stallTimeoutMs, outputLimit, taskId });
    }

    isRecoveryAdmission(actionLabel, recoveryAdmissionId) {
        return !!recoveryAdmissionId && actionLabel.startsWith('action:') &&
            recoveryAdmissionId === this.agent._activeRecoveryId;
    }

    stop(reason = 'user') {
        if (reason === 'user') {
            this.userStopped = true;
            this.intentEpoch++;
            this.cancelResume();
            if (this.agent.self_prompter?.stop) this.agent.self_prompter.stop(false);
        }
        const action = this.currentAction;
        if (!action) return Promise.resolve({ stopped: true, reason, actionId: null, phase: null });
        if (action.stopPromise) {
            if (reason === 'user' || !action.reason) action.reason = reason;
            return action.stopPromise;
        }
        action.reason = reason;
        action.stopRequestedPhase = action.phase;
        action.phaseStatus = `stopping:${reason}`;
        action.controller.abort(reason);
        this.agent.requestInterrupt(reason);
        action.stopPromise = new Promise(resolve => {
            let finished = false;
            const finish = result => {
                if (finished) return;
                finished = true;
                clearTimeout(watchdog);
                resolve(result);
            };
            const watchdog = setTimeout(() => {
                if (this.currentAction !== action) return;
                const finalReason = action.reason || reason;
                if (finalReason === 'management') this.managementStopFailed = true;
                action.watchdogAtPhase = action.phase;
                action.phaseStatus = `stop-failed:${finalReason}`;
                this.agent.cleanKill(`Action ${action.id} did not settle after stop request (${finalReason}); status=${action.phaseStatus}; stopRequestedPhase=${action.stopRequestedPhase || 'unknown'}; watchdogAtPhase=${action.watchdogAtPhase || 'unknown'}.`);
                finish({
                    stopped: false, reason: finalReason, actionId: action.id,
                    phase: action.phaseStatus, actionPhase: action.phase,
                    stopRequestedPhase: action.stopRequestedPhase, watchdogAtPhase: action.watchdogAtPhase,
                });
            }, STOP_WATCHDOG_MS);
            action.settled.promise.then(settled => finish({
                stopped: true,
                reason: action.reason || reason,
                actionId: action.id,
                phase: settled.phase,
                actionPhase: settled.actionPhase,
                stopRequestedPhase: action.stopRequestedPhase,
                watchdogAtPhase: null,
                actionResult: settled.result || null,
            }));
        });
        return action.stopPromise;
    }

    cancelResume() {
        this.resume_func = null;
        this.resume_name = null;
    }

    async _executeResume(actionLabel = null, actionFn = null, timeout = 10) {
        if (this.shuttingDown) return this._rejectedResult('shutdown');
        const newResume = actionFn != null;
        if (this.managementPaused) return this._rejectedResult('management-paused');
        if (this.managementIntentRequired) return this._rejectedResult('management-intent-required');
        if (this.agent.bot?.inventoryUnconfirmed) return this._rejectedResult('inventory-unconfirmed');
        if (this.recoveryPaused) return this._rejectedResult('recovery-paused');
        if (this.userStopped) return this._rejectedResult('user-stop');
        if (newResume) {
            if (actionLabel == null) throw new Error('actionLabel is required for new resume');
            this.resume_func = actionFn;
            this.resume_name = actionLabel;
        }
        if (this.resume_func != null && (this.agent.isIdle() || newResume) && (!this.agent.self_prompter.isActive() || newResume)) {
            const epoch = this.intentEpoch;
            return this._executeAction(this.resume_name, this.resume_func, timeout, epoch, null);
        }
        return this._rejectedResult('not-idle');
    }

    async _executeAction(actionLabel, actionFn, timeout = 10, intentEpoch = this.intentEpoch, recoveryAdmissionId = null, options = {}) {
        let releaseTransition;
        const previousTransition = this.transition;
        this.transition = new Promise(resolve => { releaseTransition = resolve; });
        await previousTransition;

        let action;
        let timeoutHandle;
        try {
            // A stop or newer user instruction invalidates actions that were
            // queued before it. Resume is never allowed to reopen a user stop.
            if (this.managementPaused) return this._rejectedResult('management-paused');
            if (this.shuttingDown) return this._rejectedResult('shutdown');
            if (this.managementIntentRequired) return this._rejectedResult('management-intent-required');
            if (this.agent.bot?.inventoryUnconfirmed) return this._rejectedResult('inventory-unconfirmed');
            if (this.recoveryPaused && !this.isRecoveryAdmission(actionLabel, recoveryAdmissionId)) return this._rejectedResult('recovery-paused');
            if (this.userStopped || intentEpoch !== this.intentEpoch) return this._rejectedResult(this.userStopped ? 'user-stop' : 'superseded');
            if (this.currentAction) {
                const stopped = await this.stop('superseded');
                if (!stopped.stopped) return this._rejectedResult('stop-failed', stopped);
            }
            if (this.managementPaused) return this._rejectedResult('management-paused');
            if (this.shuttingDown) return this._rejectedResult('shutdown');
            if (this.managementIntentRequired) return this._rejectedResult('management-intent-required');
            if (this.agent.bot?.inventoryUnconfirmed) return this._rejectedResult('inventory-unconfirmed');
            if (this.recoveryPaused && !this.isRecoveryAdmission(actionLabel, recoveryAdmissionId)) return this._rejectedResult('recovery-paused');
            if (this.userStopped || intentEpoch !== this.intentEpoch) return this._rejectedResult(this.userStopped ? 'user-stop' : 'superseded');

            if (this.last_action_time > 0 && !this.isRecoveryAdmission(actionLabel, recoveryAdmissionId)) {
                const timeDiff = Date.now() - this.last_action_time;
                this.recent_action_counter = timeDiff < FAST_ACTION_WINDOW_MS ? this.recent_action_counter + 1 : 0;
                if (this.recent_action_counter > MAX_FAST_ACTIONS_BEFORE_CANCEL) {
                    console.warn('Fast action loop detected, cancelling resume.');
                    this.cancelResume();
                }
                if (this.recent_action_counter > MAX_FAST_ACTIONS_BEFORE_STOP) {
                    this.cancelResume();
                    const result = this._rejectedResult('rapid-repeat');
                    this.agent.onRecoveryResult?.({
                        eventId: this.nextRecoveryEventId(), kind: 'rapid-repeat', reason: 'rapid-repeat',
                        interruptedAction: actionLabel, interruptedActionId: null,
                        stopResult: null, recoveryResult: result,
                    });
                    return result;
                }
            }
            this.last_action_time = Date.now();
            console.log('executing code...\n');
            this.agent.clearBotLogs();
            this.timedout = false;
            action = {
                id: ++this.actionId,
                label: actionLabel,
                fn: actionFn,
                controller: new AbortController(),
                phase: 'running',
                phaseStatus: 'running',
                reason: null,
                stopRequestedPhase: null,
                watchdogAtPhase: null,
                settled: createDeferred(),
                settledState: false,
                stopPromise: null,
                recoveryAdmissionId,
                progressBefore: captureObservedProgress(this.agent.bot),
            };
            this.currentAction = action;
            this.executing = true;
            this.currentActionLabel = actionLabel;
            this.currentActionFn = actionFn;
            action.operation = createOperationContext(action, this.agent, this, options.taskId);
            action.operation.requestStop = reason => { void this.stop(reason); };
            if (action.recoveryAdmissionId) this.agent.onRecoveryPlanActionStarted?.({ recoveryId: action.recoveryAdmissionId, actionId: action.id, actionLabel });
            if (timeout > 0) timeoutHandle = this._startTimeout(timeout, action.id);
            if (options.stallTimeoutMs > 0) {
                let last = captureObservedProgress(this.agent.bot);
                let progressedAt = Date.now();
                let navigationPhaseActive = false;
                let navigationWaitProgress = 0;
                action.stallTimer = setInterval(() => {
                    if (this.currentAction !== action || action.reason) return;
                    const now = captureObservedProgress(this.agent.bot);
                    if (action.phase === 'navigation') {
                        const wait = currentOwnedWait(action.operation);
                        if (!navigationPhaseActive) {
                            navigationPhaseActive = true;
                            navigationWaitProgress = 0;
                            progressedAt = Date.now();
                        }
                        if (wait && wait.progressCount > navigationWaitProgress) {
                            navigationWaitProgress = wait.progressCount;
                            progressedAt = Date.now();
                        }
                        if (Date.now() - progressedAt >= options.stallTimeoutMs) void this.stop('stall');
                        last = now;
                        return;
                    }
                    if (navigationPhaseActive) {
                        // Do not turn navigation distance accumulated under its own detector into progress for the next phase.
                        navigationPhaseActive = false;
                        navigationWaitProgress = 0;
                        last = now;
                        progressedAt = Date.now();
                        return;
                    }
                    const moved = last.position && now.position && Math.hypot(...now.position.map((v, i) => v - last.position[i])) >= MIN_PROGRESS_DISTANCE;
                    if (moved || JSON.stringify(last.inventory) !== JSON.stringify(now.inventory)) {
                        last = now;
                        progressedAt = Date.now();
                    }
                    if (Date.now() - progressedAt >= options.stallTimeoutMs) void this.stop('stall');
                }, Math.min(1000, options.stallTimeoutMs));
            }
        } finally {
            releaseTransition();
        }

        try {
            const domainReturn = await runOwnedOperation(action.operation, actionFn);
            const output = this.getBotOutputSummary(options.outputLimit);
            const timedout = this.timedout;
            const interrupted = !!action.reason || this.agent.bot.interrupt_code;
            this.agent.clearBotLogs();
            this._finishAction(action, timeoutHandle);
            const result = {
                success: !interrupted,
                message: output,
                interrupted,
                timedout,
                reason: action.reason,
                actionId: action.id,
                phase: action.phaseStatus,
                actionPhase: action.actionPhase || action.phase,
                stopRequestedPhase: action.stopRequestedPhase,
                watchdogAtPhase: action.watchdogAtPhase,
                executionStatus: interrupted ? 'interrupted' : 'completed',
                domainReturn: typeof domainReturn === 'boolean' || typeof domainReturn === 'string' || typeof domainReturn === 'number' ? domainReturn : null,
                ...operationResult(action.operation),
            };
            action.settledState = true;
            const progressObserved = observeActionProgress(this, action, result);
            result.progressObserved = progressObserved;
            action.settled.resolve({ phase: action.phaseStatus, actionPhase: result.actionPhase, reason: action.reason, result });
            this.notifyRecoverySettled(action, result);
            if (!interrupted && !this.userStopped) this.agent.bot.emit('idle');
            return result;
        } catch (error) {
            console.error('Code execution triggered catch:', error);
            const message = `${this.getBotOutputSummary(options.outputLimit)}!!Code threw exception!!\nError: ${error?.stack || String(error)}\n`;
            this.cancelResume();
            this.agent.clearBotLogs();
            this._finishAction(action, timeoutHandle);
            action.phaseStatus = action.reason ? `stopped:${action.reason}` : 'failed';
            action.settledState = true;
            const result = {
                success: false,
                message,
                interrupted: !!action.reason || this.agent.bot.interrupt_code,
                timedout: this.timedout,
                reason: action.reason || 'error',
                actionId: action.id,
                phase: action.phaseStatus,
                actionPhase: action.actionPhase || action.phase,
                stopRequestedPhase: action.stopRequestedPhase,
                watchdogAtPhase: action.watchdogAtPhase,
                executionStatus: action.reason ? 'interrupted' : 'error',
                domainReturn: null,
                ...operationResult(action.operation),
            };
            result.progressObserved = observeActionProgress(this, action, result);
            action.settled.resolve({ phase: action.phaseStatus, actionPhase: result.actionPhase, reason: action.reason, result });
            this.notifyRecoverySettled(action, result);
            if (!this.agent.bot.interrupt_code && !this.userStopped) this.agent.bot.emit('idle');
            return result;
        }
    }

    notifyRecoverySettled(action, result) {
        if (!action.reason || action.recoveryAdmissionId || this.notifiedRecoveryActions.has(action.id)) return;
        if (!['timeout'].includes(action.reason)) return;
        // Modes own their full recovery outcome, including a timeout in the
        // mode action itself. Notifying here as well would spend two plans.
        if (action.label === 'mode:unstuck') return;
        this.notifiedRecoveryActions.add(action.id);
        if (this.notifiedRecoveryActions.size > MAX_RECOVERY_DEDUPE) this.notifiedRecoveryActions.delete(this.notifiedRecoveryActions.values().next().value);
        this.agent.onRecoveryResult?.({
            eventId: this.nextRecoveryEventId(), kind: action.reason, reason: action.reason,
            interruptedAction: action.label, interruptedActionId: action.id,
            actionResult: result, stopResult: { stopped: true, reason: action.reason, actionId: action.id, phase: result.phase, actionResult: result },
            recoveryResult: null,
        });
    }

    _finishAction(action, timeoutHandle) {
        clearTimeout(timeoutHandle);
        clearInterval(action.stallTimer);
        clearTimeout(this.timeoutEscalations.get(action.id));
        this.timeoutEscalations.delete(action.id);
        if (this.currentAction !== action) return;
        action.actionPhase = action.phase;
        action.phaseStatus = action.reason ? `stopped:${action.reason}` : 'completed';
        action.settledState = true;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.currentAction = null;
    }

    _startTimeout(timeoutMins = 10, actionId = this.actionId) {
        return setTimeout(async () => {
            const action = this.currentAction;
            if (!action || !this.executing || action.id !== actionId) return;
            this.timedout = true;
            this.agent.history.add('system', `Code execution timed out after ${timeoutMins} minutes. Attempting cooperative stop.`);
            await this.stop('timeout');
        }, timeoutMins * 60 * 1000);
    }

    _rejectedResult(reason, detail = null) {
        return { success: false, message: null, interrupted: true, timedout: false, reason, actionId: detail?.actionId ?? null, phase: detail?.phase ?? null,
            executionStatus: 'rejected', domainReturn: null, operationSettlement: 'not_started', skillResults: [], confirmedChanges: [], unconfirmedChanges: [] };
    }

    getBotOutputSummary(limit = MAX_OUTPUT_LENGTH) {
        const { bot } = this.agent;
        let output = bot.output;
        bot.output = '';
        if (bot.interrupt_code && !this.timedout) {
            if (!output) return '';
            output = `Action output before interruption:\n${output}`;
        }
        if (output.length > limit) {
            output = `Action output is very long (${output.length} chars) and has been shortened.\nFirst outputs:\n${output.substring(0, limit / 2)}\n...skipping many lines.\nFinal outputs:\n${output.substring(output.length - limit / 2)}`;
        } else {
            output = 'Action output:\n' + output.toString();
        }
        return output;
    }
}

function createDeferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

const STOP_WATCHDOG_MS = 10000;
const FAST_ACTION_WINDOW_MS = 20;
const MAX_FAST_ACTIONS_BEFORE_CANCEL = 3;
const MAX_FAST_ACTIONS_BEFORE_STOP = 5;
const MAX_OUTPUT_LENGTH = 500;
const MAX_RECOVERY_DEDUPE = 64;
const MIN_PROGRESS_DISTANCE = 0.5;

function currentOwnedWait(operation) {
    let call = operation?.root;
    while (call?.activeChild) call = call.activeChild;
    return call?.activeWait ?? null;
}

function captureObservedProgress(bot) {
    if (!bot) return { position: null, inventory: null };
    const position = bot.entity?.position;
    const observedPosition = position && [position.x, position.y, position.z].every(Number.isFinite)
        ? [position.x, position.y, position.z]
        : null;
    let inventory = null;
    try {
        if (typeof bot.inventory?.items === 'function') {
            const totals = new Map();
            for (const item of bot.inventory.items()) {
                const key = `${item.type}:${item.metadata ?? 0}`;
                totals.set(key, (totals.get(key) || 0) + item.count);
            }
            inventory = [...totals.entries()].sort(([left], [right]) => left.localeCompare(right));
        }
    } catch {}
    return { position: observedPosition, inventory };
}

function observeActionProgress(manager, action, result) {
    const after = captureObservedProgress(manager.agent.bot);
    const before = action.progressBefore;
    const movedMeaningfully = before.position && after.position &&
        Math.hypot(before.position[0] - after.position[0], before.position[1] - after.position[1], before.position[2] - after.position[2]) >= MIN_PROGRESS_DISTANCE;
    const progressed = !!result.success && !result.interrupted && !action.label.startsWith('mode:') && (
        movedMeaningfully ||
        JSON.stringify(before.inventory) !== JSON.stringify(after.inventory));
    if (progressed && !manager.agent.bot?.inventoryUnconfirmed) manager.clearRecoveryAfterProgress();
    if (action.recoveryAdmissionId) {
        try {
            manager.agent.onRecoveryPlanActionSettled?.({
                recoveryId: action.recoveryAdmissionId,
                actionLabel: action.label,
                actionId: action.id,
                result,
                progressObserved: progressed,
                state: after,
            });
        } catch (error) { console.warn('Recovery action result hook failed:', error); }
    }
    return progressed;
}
