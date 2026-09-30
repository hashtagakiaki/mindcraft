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
    }

    async resumeAction(actionLabel, actionFn, timeout) {
        return this._executeResume(actionLabel, actionFn, timeout);
    }

    async runAction(actionLabel, actionFn, { timeout, resume = false } = {}) {
        if (resume) {
            return this._executeResume(actionLabel, actionFn, timeout);
        } else {
            return this._executeAction(actionLabel, actionFn, timeout);
        }
    }

    async stop() {
        if (!this.executing) return;
        const timeout = setTimeout(() => {
            this.agent.cleanKill('Code execution refused stop after 10 seconds. Killing process.');
        }, 10000);
        while (this.executing) {
            this.agent.requestInterrupt();
            console.log('waiting for code to finish executing...');
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        clearTimeout(timeout);
    } 

    cancelResume() {
        this.resume_func = null;
        this.resume_name = null;
    }

    async _executeResume(actionLabel = null, actionFn = null, timeout = 10) {
        const new_resume = actionFn != null;
        if (new_resume) { // start new resume
            if (actionLabel == null) throw new Error('actionLabel is required for new resume');
            this.resume_func = actionFn;
            this.resume_name = actionLabel;
        }
        if (this.resume_func != null && (this.agent.isIdle() || new_resume) && (!this.agent.self_prompter.isActive() || new_resume)) {
            this.currentActionLabel = this.resume_name;
            let res = await this._executeAction(this.resume_name, this.resume_func, timeout);
            this.currentActionLabel = '';
            return res;
        } else {
            return { success: false, message: null, interrupted: false, timedout: false };
        }
    }

    async _executeAction(actionLabel, actionFn, timeout = 10) {
        let timeoutHandle;
        let actionId;
        try {
            if (this.last_action_time > 0) {
                let time_diff = Date.now() - this.last_action_time;
                if (time_diff < 20) {
                    this.recent_action_counter++;
                }
                else {
                    this.recent_action_counter = 0;
                }
                if (this.recent_action_counter > 3) {
                    console.warn('Fast action loop detected, cancelling resume.');
                    this.cancelResume(); // likely cause of repetition
                }
                if (this.recent_action_counter > 5) {
                    console.error('Infinite action loop detected, shutting down.');
                    this.agent.cleanKill('Infinite action loop detected, shutting down.');
                    return { success: false, message: 'Infinite action loop detected, shutting down.', interrupted: false, timedout: false };
                }
            }
            this.last_action_time = Date.now();
            console.log('executing code...\n');

            // Serialize transitions only. The action body remains outside the
            // transition chain so a later action can interrupt it.
            let releaseTransition;
            const previousTransition = this.transition;
            this.transition = new Promise(resolve => { releaseTransition = resolve; });
            await previousTransition;
            try {
                if (this.executing) {
                    console.log(`action "${actionLabel}" trying to interrupt current action "${this.currentActionLabel}"`);
                }
                await this.stop();
                this.agent.clearBotLogs();
                this.timedout = false;
                this.executing = true;
                actionId = ++this.actionId;
                this.currentActionLabel = actionLabel;
                this.currentActionFn = actionFn;
                if (timeout > 0) timeoutHandle = this._startTimeout(timeout, actionId);
            } finally {
                releaseTransition();
            }

            // start the action
            await actionFn();

            // mark action as finished + cleanup
            // get bot activity summary
            let output = this.getBotOutputSummary();
            let interrupted = this.agent.bot.interrupt_code;
            let timedout = this.timedout;
            this.agent.clearBotLogs();
            this._finishAction(actionId, timeoutHandle);

            // if not interrupted and not generating, emit idle event
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }

            // return action status report
            return { success: true, message: output, interrupted, timedout };
        } catch (err) {
            this._finishAction(actionId, timeoutHandle);
            this.cancelResume();
            console.error("Code execution triggered catch:", err);
            // Log the full stack trace
            console.error(err.stack);
            await this.stop();
            err = err.toString();

            let message = this.getBotOutputSummary() +
                '!!Code threw exception!!\n' +
                'Error: ' + err + '\n' +
                'Stack trace:\n' + err.stack+'\n';

            let interrupted = this.agent.bot.interrupt_code;
            this.agent.clearBotLogs();
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }
            return { success: false, message, interrupted, timedout: false };
        }
    }

    getBotOutputSummary() {
        const { bot } = this.agent;
        if (bot.interrupt_code && !this.timedout) return '';
        let output = bot.output;
        const MAX_OUT = 500;
        if (output.length > MAX_OUT) {
            output = `Action output is very long (${output.length} chars) and has been shortened.\n
          First outputs:\n${output.substring(0, MAX_OUT / 2)}\n...skipping many lines.\nFinal outputs:\n ${output.substring(output.length - MAX_OUT / 2)}`;
        }
        else {
            output = 'Action output:\n' + output.toString();
        }
        bot.output = '';
        return output;
    }

    _finishAction(actionId, timeoutHandle) {
        clearTimeout(timeoutHandle);
        clearTimeout(this.timeoutEscalations.get(actionId));
        this.timeoutEscalations.delete(actionId);
        if (this.actionId !== actionId) return;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
    }

    _startTimeout(TIMEOUT_MINS = 10, actionId = this.actionId) {
        return setTimeout(async () => {
            if (!this.executing || this.actionId !== actionId) return;
            console.warn(`Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            this.timedout = true;
            this.agent.history.add('system', `Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            this.agent.requestInterrupt();
            const escalation = setTimeout(() => {
                this.timeoutEscalations.delete(actionId);
                if (this.executing && this.actionId === actionId) {
                    this.agent.cleanKill('Code execution refused stop after 10 seconds. Killing process.');
                }
            }, 10000);
            this.timeoutEscalations.set(actionId, escalation);
        }, TIMEOUT_MINS * 60 * 1000);
    }

}
