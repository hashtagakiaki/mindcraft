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
        this.intentEpoch = 0;
    }

    beginUserIntent() {
        this.intentEpoch++;
        this.userStopped = false;
        this.cancelResume();
        return this.intentEpoch;
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
        if (this.agent.bot?.inventoryUnconfirmed) return this._rejectedResult('inventory-unconfirmed');
        return this._executeResume(actionLabel, actionFn, timeout);
    }

    async runAction(actionLabel, actionFn, { timeout, resume = false } = {}) {
        if (this.agent.bot?.inventoryUnconfirmed) return this._rejectedResult('inventory-unconfirmed');
        if (resume) return this._executeResume(actionLabel, actionFn, timeout);
        const epoch = this.intentEpoch;
        if (this.userStopped) return this._rejectedResult('user-stop');
        return this._executeAction(actionLabel, actionFn, timeout, epoch);
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
        action.phase = `stopping:${reason}`;
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
                action.phase = `stop-failed:${finalReason}`;
                this.agent.cleanKill(`Action ${action.id} did not settle after stop request (${finalReason}); phase=${action.phase}.`);
                finish({ stopped: false, reason: finalReason, actionId: action.id, phase: action.phase });
            }, STOP_WATCHDOG_MS);
            action.settled.promise.then(result => finish({
                stopped: true,
                reason: action.reason || reason,
                actionId: action.id,
                phase: result.phase
            }));
        });
        return action.stopPromise;
    }

    cancelResume() {
        this.resume_func = null;
        this.resume_name = null;
    }

    async _executeResume(actionLabel = null, actionFn = null, timeout = 10) {
        const newResume = actionFn != null;
        if (this.agent.bot?.inventoryUnconfirmed) return this._rejectedResult('inventory-unconfirmed');
        if (this.userStopped) return this._rejectedResult('user-stop');
        if (newResume) {
            if (actionLabel == null) throw new Error('actionLabel is required for new resume');
            this.resume_func = actionFn;
            this.resume_name = actionLabel;
        }
        if (this.resume_func != null && (this.agent.isIdle() || newResume) && (!this.agent.self_prompter.isActive() || newResume)) {
            const epoch = this.intentEpoch;
            return this._executeAction(this.resume_name, this.resume_func, timeout, epoch);
        }
        return this._rejectedResult('not-idle');
    }

    async _executeAction(actionLabel, actionFn, timeout = 10, intentEpoch = this.intentEpoch) {
        let releaseTransition;
        const previousTransition = this.transition;
        this.transition = new Promise(resolve => { releaseTransition = resolve; });
        await previousTransition;

        let action;
        let timeoutHandle;
        try {
            // A stop or newer user instruction invalidates actions that were
            // queued before it. Resume is never allowed to reopen a user stop.
            if (this.agent.bot?.inventoryUnconfirmed) return this._rejectedResult('inventory-unconfirmed');
            if (this.userStopped || intentEpoch !== this.intentEpoch) return this._rejectedResult(this.userStopped ? 'user-stop' : 'superseded');
            if (this.currentAction) {
                const stopped = await this.stop('superseded');
                if (!stopped.stopped) return this._rejectedResult('stop-failed', stopped);
            }
            if (this.agent.bot?.inventoryUnconfirmed) return this._rejectedResult('inventory-unconfirmed');
            if (this.userStopped || intentEpoch !== this.intentEpoch) return this._rejectedResult(this.userStopped ? 'user-stop' : 'superseded');

            if (this.last_action_time > 0) {
                const timeDiff = Date.now() - this.last_action_time;
                this.recent_action_counter = timeDiff < FAST_ACTION_WINDOW_MS ? this.recent_action_counter + 1 : 0;
                if (this.recent_action_counter > MAX_FAST_ACTIONS_BEFORE_CANCEL) {
                    console.warn('Fast action loop detected, cancelling resume.');
                    this.cancelResume();
                }
                if (this.recent_action_counter > MAX_FAST_ACTIONS_BEFORE_STOP) {
                    this.cancelResume();
                    return this._rejectedResult('rapid-repeat');
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
                reason: null,
                settled: createDeferred(),
                settledState: false,
                stopPromise: null
            };
            this.currentAction = action;
            this.executing = true;
            this.currentActionLabel = actionLabel;
            this.currentActionFn = actionFn;
            if (timeout > 0) timeoutHandle = this._startTimeout(timeout, action.id);
        } finally {
            releaseTransition();
        }

        try {
            await actionFn();
            const output = this.getBotOutputSummary();
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
                phase: action.phase
            };
            action.settledState = true;
            action.settled.resolve({ phase: action.phase, reason: action.reason });
            if (!interrupted && !this.userStopped) this.agent.bot.emit('idle');
            return result;
        } catch (error) {
            console.error('Code execution triggered catch:', error);
            const message = `${this.getBotOutputSummary()}!!Code threw exception!!\nError: ${error?.stack || String(error)}\n`;
            this.cancelResume();
            this.agent.clearBotLogs();
            this._finishAction(action, timeoutHandle);
            action.phase = action.reason ? `stopped:${action.reason}` : 'failed';
            action.settledState = true;
            action.settled.resolve({ phase: action.phase, reason: action.reason });
            if (!this.agent.bot.interrupt_code && !this.userStopped) this.agent.bot.emit('idle');
            return {
                success: false,
                message,
                interrupted: !!action.reason || this.agent.bot.interrupt_code,
                timedout: this.timedout,
                reason: action.reason || 'error',
                actionId: action.id,
                phase: action.phase
            };
        }
    }

    _finishAction(action, timeoutHandle) {
        clearTimeout(timeoutHandle);
        clearTimeout(this.timeoutEscalations.get(action.id));
        this.timeoutEscalations.delete(action.id);
        if (this.currentAction !== action) return;
        action.phase = action.reason ? `stopped:${action.reason}` : 'completed';
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
        return { success: false, message: null, interrupted: true, timedout: false, reason, actionId: detail?.actionId ?? null, phase: detail?.phase ?? null };
    }

    getBotOutputSummary() {
        const { bot } = this.agent;
        let output = bot.output;
        bot.output = '';
        if (bot.interrupt_code && !this.timedout) {
            if (!output) return '';
            output = `Action output before interruption:\n${output}`;
        }
        if (output.length > MAX_OUTPUT_LENGTH) {
            output = `Action output is very long (${output.length} chars) and has been shortened.\nFirst outputs:\n${output.substring(0, MAX_OUTPUT_LENGTH / 2)}\n...skipping many lines.\nFinal outputs:\n${output.substring(output.length - MAX_OUTPUT_LENGTH / 2)}`;
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
