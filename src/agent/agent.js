import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { createPlacesFacade } from './places.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';

const MAX_AUTOMATIC_RECOVERY_PLANS = 2;
const MAX_RECOVERY_OUTPUT_CHARS = 500;
const MAX_RECOVERY_EVENTS = 128;
const AGENT_SHUTDOWN_STOP_GRACE_MS = 2800;
const STANDALONE_EXIT_INTENT_FLUSH_MS = 500;
const SHUTDOWN_MESSAGE_MAX_CHARS = 1000;

async function sendStandaloneExitIntent(outcome) {
    if (typeof process.send !== 'function' || process.connected !== true) return;
    await new Promise(resolve => {
        let settled = false;
        const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
        const timer = setTimeout(finish, STANDALONE_EXIT_INTENT_FLUSH_MS);
        try { process.send({ type: 'mindcraft:exit-intent', ...outcome }, finish); } catch { finish(); }
    });
}
const RECOVERY_NON_REPLAN_REASONS = new Set(['user', 'user-stop', 'superseded', 'death', 'management', 'inventory-unconfirmed']);

function inventorySummary(bot) {
    if (bot?.inventoryUnconfirmed) return 'unknown (inventory state is unconfirmed)';
    try {
        if (typeof bot?.inventory?.items !== 'function') return 'unknown (inventory view unavailable)';
        const counts = new Map();
        for (const item of bot.inventory.items()) counts.set(item.name || String(item.type), (counts.get(item.name || String(item.type)) || 0) + item.count);
        return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, count]) => `${name} x${count}`).join(', ') || 'empty';
    } catch { return 'unknown (inventory view unavailable)'; }
}

function positionSummary(bot) {
    const position = bot?.entity?.position;
    if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return 'unknown';
    return `x=${position.x.toFixed(2)}, y=${position.y.toFixed(2)}, z=${position.z.toFixed(2)}`;
}

function actionResultOutput(event) {
    const result = event.actionResult || event.stopResult?.actionResult || event.recoveryResult;
    if (!result?.message) return 'none available';
    const message = String(result.message);
    return message.length > MAX_RECOVERY_OUTPUT_CHARS
        ? `${message.slice(0, MAX_RECOVERY_OUTPUT_CHARS / 2)} ... ${message.slice(-MAX_RECOVERY_OUTPUT_CHARS / 2)}`
        : message;
}

export class Agent {
    constructor() {
        this.managementPaused = false;
        this._managementInterruption = false;
        this._managementGeneration = 0;
        this._managementStopFailed = false;
        this._managementWaiters = new Set();
        this._shutdownStarted = false;
        this._shutdownPromise = null;
        this._botEnded = false;
    }

    isShutdownStarted() { return this._shutdownStarted; }

    shutdown(reason = 'shutdown', options = {}) {
        if (this._shutdownPromise) return this._shutdownPromise;
        const intent = {
            reason: String(reason || 'shutdown'),
            restartIntent: options.restartIntent === true,
            code: Number.isInteger(options.code) ? options.code : 0,
            message: typeof options.message === 'string' ? options.message.slice(0, SHUTDOWN_MESSAGE_MAX_CHARS) : null,
        };
        this._shutdownStarted = true;
        this._shutdownIntent = intent;
        this._managementGeneration++;
        this._messageGeneration = (this._messageGeneration || 0) + 1;
        this._activeRecoveryId = null;
        this._recoveryPromptCommand = false;
        this._recoveryAdmissionId = null;
        if (this.npc?.data) {
            this.npc.data.goals = [];
            this.npc.data.curr_goal = null;
            this.npc.data.do_set_goal = false;
            this.npc.temp_goals = [];
        }
        for (const resolve of (this._managementWaiters || [])) resolve(false);
        this._managementWaiters?.clear?.();
        if (this._idleResumeTimer) { clearTimeout(this._idleResumeTimer); this._idleResumeTimer = null; }
        if (this.npc?.idleTimer) { clearTimeout(this.npc.idleTimer); this.npc.idleTimer = null; }
        this.self_prompter?.stopForRecovery?.();
        clearTimeout(this._spawnTimeout);
        clearTimeout(this._updateLoopTimer);
        this.history?.beginShutdown?.();

        this._shutdownPromise = Promise.resolve().then(async () => {
            let stopResult = { stopped: true, reason: 'shutdown', actionId: null, phase: null };
            try {
                const stopping = this.actions?.beginShutdown?.() ?? this.actions?.stop?.('shutdown');
                if (stopping) {
                    let timer;
                    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), AGENT_SHUTDOWN_STOP_GRACE_MS); });
                    const settled = await Promise.race([Promise.resolve(stopping), deadline]);
                    clearTimeout(timer);
                    if (settled) stopResult = settled;
                    else {
                        const context = this.actions?.getCancellationContext?.();
                        stopResult = {
                            stopped: false,
                            reason: context?.reason || 'shutdown-timeout',
                            actionId: context?.actionId ?? this.actions?.currentAction?.id ?? null,
                            phase: this.actions?.currentAction?.phaseStatus || context?.phase || 'unknown',
                            actionPhase: context?.phase || this.actions?.currentAction?.phase || 'unknown',
                            stopRequestedPhase: this.actions?.currentAction?.stopRequestedPhase || context?.phase || 'unknown',
                            watchdogAtPhase: this.actions?.currentAction?.watchdogAtPhase || null,
                        };
                    }
                }
            } catch (error) {
                stopResult = { stopped: false, reason: 'shutdown-error', error: String(error?.message || error), actionId: this.actions?.currentAction?.id ?? null, phase: this.actions?.currentAction?.phase || 'unknown' };
            }
            const safeOutcome = { reason: intent.reason, restartIntent: intent.restartIntent, code: intent.code, message: intent.message || null, taskResult: this.taskResult || null, stopped: stopResult.stopped, stopResult };
            let saveResult = { saved: false, skipped: 'history unavailable' };
            try { saveResult = await (this.history?.saveShutdownRecord?.(intent.reason, safeOutcome) ?? saveResult); }
            catch (error) { saveResult = { saved: false, error: String(error?.message || error) }; }
            let ended = false;
            if (!this._botEnded && this.bot?.end) {
                this._botEnded = true;
                try { this.bot.end(`Agent shutdown: ${intent.reason}`); ended = true; }
                catch (error) { console.error('Could not end Minecraft connection:', error); }
            }
            return { ...safeOutcome, saveResult, ended };
        });
        return this._shutdownPromise;
    }

    cleanKill(message = 'Agent stopped.', code = 1) {
        const taskEnding = code > 1;
        const explicitRestart = code === 0;
        const reason = explicitRestart ? 'explicit-restart' : 'stop-failed';
        const intent = { reason, restartIntent: explicitRestart || !taskEnding, code, message: String(message || '') };
        if (this.requestShutdown) return this.requestShutdown(intent.reason, intent);
        return this.shutdown(intent.reason, intent).then(async outcome => {
            if (typeof process.send === 'function' && process.connected) {
                await sendStandaloneExitIntent(outcome);
            }
            process.exit(code);
            return outcome;
        });
    }

    pauseManagement(reason = 'management') {
        if (this._shutdownStarted) return Promise.resolve({ stopped: false, reason: 'shutdown' });
        this.managementPaused = true;
        this._managementInterruption = true;
        this._managementGeneration++;
        this._messageGeneration = (this._messageGeneration || 0) + 1;
        this._activeRecoveryId = null;
        this._recoveryPromptCommand = false;
        this._recoveryAdmissionId = null;
        if (this.npc?.data) {
            this.npc.data.goals = [];
            this.npc.data.curr_goal = null;
            this.npc.data.do_set_goal = false;
            this.npc.temp_goals = [];
        }
        if (this.npc?.idleTimer) {
            clearTimeout(this.npc.idleTimer);
            this.npc.idleTimer = null;
        }
        const actionStop = this.actions?.pauseForManagement(reason);
        this.self_prompter?.pauseForManagement();
        if (this._idleResumeTimer) {
            clearTimeout(this._idleResumeTimer);
            this._idleResumeTimer = null;
        }
        const stop = actionStop ?? Promise.resolve({ stopped: true, reason, actionId: null, phase: null });
        return Promise.resolve(stop).then(result => {
            if (result?.stopped === false) this._managementStopFailed = true;
            return result;
        }, error => {
            this._managementStopFailed = true;
            return { stopped: false, reason, error };
        });
    }

    restoreManagement(meta) {
        if (this._shutdownStarted) return false;
        if (!meta?.isCurrentConnection?.() || this._managementStopFailed) return false;
        if (this.actions && !this.actions.restoreManagement(meta)) return false;
        if (!meta.isCurrentConnection()) {
            this.pauseManagement('management');
            return false;
        }
        this.managementPaused = false;
        for (const resolve of this._managementWaiters) resolve(true);
        this._managementWaiters.clear();
        return true;
    }

    waitForManagementReady() {
        if (this._shutdownStarted) return Promise.resolve(false);
        if (!this.managementPaused) return Promise.resolve(true);
        return new Promise(resolve => this._managementWaiters.add(resolve));
    }

    async start(load_mem=false, init_message=null, count_id=0) {
        if (this._shutdownStarted) return;
        this.last_sender = null;
        this.count_id = count_id;
        this._disconnectHandled = false;
        this._userIntentGeneration = 0;
        this._messageGeneration = 0;
        this._recoverySeen = new Set();
        this._activeRecoveryId = null;
        this._recoveryPromptCommand = false;
        this._recoveryAdmissionId = null;

        // Initialize components
        this.actions = new ActionManager(this);
        if (this.managementPaused) this.actions.pauseForManagement();
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);
        
        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            if (this.requestShutdown) await this.requestShutdown('startup-error', { restartIntent: true, code: 1 });
            else await this.shutdown('startup-error', { restartIntent: true, code: 1 });
            return;
        }
        
        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.places = createPlacesFacade(this, serverProxy);
        this.memory_bank = new MemoryBank(serverProxy, this.name, () => this.places.isEnabled());
        this.self_prompter = new SelfPrompter(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();
        if (this._shutdownStarted || !(await this.waitForManagementReady())) return;

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        console.log(this.name, 'logging into minecraft...');
        if (this._shutdownStarted || !(await this.waitForManagementReady())) return;
        if (this._shutdownStarted) return;
        this.bot = initBot(this.name);
        Object.defineProperty(this.bot, 'inventoryUnconfirmed', {
            configurable: true,
            enumerable: false,
            writable: true,
            value: false,
        });
        Object.defineProperty(this.bot, 'getActionCancellationContext', {
            configurable: true,
            enumerable: false,
            value: () => {
                const context = this.actions.getCancellationContext();
                if (!context) return null;
                return Object.defineProperties({
                    actionId: context.actionId,
                    signal: context.signal,
                    settled: context.settled,
                    setPhase: phase => this.actions.setPhase(phase, context.actionId),
                }, {
                    phase: { enumerable: true, get: () => context.phase },
                    reason: { enumerable: true, get: () => context.reason },
                });
            },
        });
        
        // Connection Handler
        const onDisconnect = (event, reason) => {
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;

            // Log and Analyze
            // handleDisconnection handles logging to console and server
            const { type } = handleDisconnection(this.name, reason);
     
            if (this.requestShutdown) void this.requestShutdown('connection-lost', { restartIntent: true, code: 1 });
            else void this.shutdown('connection-lost', { restartIntent: true, code: 1 });
        };
        
        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                 onDisconnect('Error', err);
            } else {
                 log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        initModes(this);

        this.bot.on('login', () => {
            if (this._shutdownStarted) return;
            console.log(this.name, 'logged in!');
            serverProxy.login();
            if (this.managementPaused) return;
            
            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            if (this.prompter.profile.skin)
                this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                this.bot.chat(`/skin clear`);
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        this._spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            if (this.requestShutdown) void this.requestShutdown('startup-error', { restartIntent: true, code: 1 });
            else void this.shutdown('startup-error', { restartIntent: true, code: 1 });
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(this._spawnTimeout);
                this._spawnTimeout = null;
                if (this._shutdownStarted || !(await this.waitForManagementReady())) return;
                addBrowserViewer(this.bot, count_id);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                if (this._shutdownStarted || !(await this.waitForManagementReady())) return;
                
                console.log(`${this.name} spawned.`);
                this.clearBotLogs();
              
                await this._setupEventHandlers(save_data, init_message);
                if (this._shutdownStarted || !(await this.waitForManagementReady())) return;
                this.startEvents();
              
                if (!load_mem) {
                    if (settings.task && !this._managementInterruption) {
                        const initialized = await this.task.initBotTask();
                        if (initialized === false || this._shutdownStarted) return;
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task && !this._managementInterruption) {
                        const goalSet = await this.task.setAgentGoal();
                        if (goalSet === false || this._shutdownStarted) return;
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                if (this._shutdownStarted || !(await this.waitForManagementReady())) return;
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                if (this.requestShutdown) void this.requestShutdown('startup-error', { restartIntent: true, code: 1 });
                else void this.shutdown('startup-error', { restartIntent: true, code: 1 });
            }
        });
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message) => {
            if (this._shutdownStarted) return;
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            const managementGeneration = this._managementGeneration || 0;
            const managementPausedAtReceipt = this.managementPaused || this.actions?.managementPaused;
            const preserveStopCommand = message === '!stop' || message === '!restart';
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??')
                }
                else {
                    if (preserveStopCommand) {
                        await this.handleMessage(username, message);
                        return;
                    }
                    let translation = await handleEnglishTranslation(message);
                    if (this._shutdownStarted || managementPausedAtReceipt || managementGeneration !== (this._managementGeneration || 0)) return;
                    await this.handleMessage(username, translation);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

		this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);
        
        this.bot.on('chat', (username, message) => {
            if (serverProxy.getNumOtherAgents() > 0) return;
            // only respond to open chat messages when there are no other agents
            respondFunc(username, message);
        });

        // Set up auto-eat
        this.bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        };

        if (save_data?.self_prompt) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            if (this._managementInterruption && save_data.self_prompting_state === 1) {
                this.self_prompter.setPromptPaused(save_data.self_prompt);
            } else {
                await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
            }
            if (this._shutdownStarted) return;
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            await this.handleMessage('system', init_message, 2);
            if (this._shutdownStarted) return;
        }
        else {
            this.openChat("Hello world! I am "+this.name);
        }
    }

    checkAllPlayersPresent() {
        if (this._shutdownStarted) return;
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    onRecoveryResult(event) {
        if (this._shutdownStarted || this.managementPaused || this.actions.managementIntentRequired) return false;
        const eventId = event.eventId ?? this.actions.nextRecoveryEventId();
        if (this._recoverySeen.has(eventId)) return false;
        this._recoverySeen.add(eventId);
        if (this._recoverySeen.size > MAX_RECOVERY_EVENTS) this._recoverySeen.delete(this._recoverySeen.values().next().value);

        const reason = event.reason || event.stopResult?.reason || event.actionResult?.reason || event.recoveryResult?.reason || 'unknown';
        if (this.actions.userStopped || RECOVERY_NON_REPLAN_REASONS.has(reason)) return false;
        if (event.stopResult && !event.stopResult.stopped) return false;
        if (this.actions.recoveryPaused && this._activeRecoveryId) return false;

        this.actions.pauseForRecovery();
        this.self_prompter?.stopForRecovery();
        const recoveryId = `recovery-${eventId}`;
        this._activeRecoveryId = recoveryId;
        const attempts = this.actions.recordRecoveryAttempt();
        if (this.bot?.inventoryUnconfirmed) {
            this._reportRecoveryPaused('Inventory state is unconfirmed; no recovery action was started. Confirm inventory state or use explicit !restart as a last resort.');
            return true;
        }
        if (attempts > MAX_AUTOMATIC_RECOVERY_PLANS) {
            this._reportRecoveryPaused(`Automatic recovery limit (${MAX_AUTOMATIC_RECOVERY_PLANS}) reached after ${reason}. The connection is still active; waiting for an explicit instruction.`);
            return true;
        }
        void this._launchRecoveryPrompt(event, recoveryId, attempts).catch(error => {
            console.error('Recovery prompt failed:', error);
            this._reportRecoveryPaused(`Recovery planning failed (${error?.message || String(error)}). The connection is still active; waiting for an explicit instruction.`);
        });
        return true;
    }

    onRecoveryPlanActionStarted({ recoveryId }) {
        if (this._shutdownStarted) return;
        if (recoveryId === this._activeRecoveryId) this._recoveryActionStartedId = recoveryId;
    }

    onRecoveryPlanActionSettled(event) {
        if (this._shutdownStarted) return;
        queueMicrotask(() => {
            void this._finishRecoveryPlanAction(event).catch(error => {
                console.error('Recovery action completion failed:', error);
                this._reportRecoveryPaused(`Recovery action completion could not be verified (${error?.message || String(error)}). Waiting for an explicit instruction.`);
            });
        });
    }

    async _launchRecoveryPrompt(event, recoveryId, attempts) {
        if (this._shutdownStarted || this.managementPaused || this.actions.managementIntentRequired) return false;
        if (this.actions.userStopped || recoveryId !== this._activeRecoveryId) return false;
        if (this.bot?.inventoryUnconfirmed) {
            this._reportRecoveryPaused('Inventory state is unconfirmed; no recovery action was started. Confirm inventory state or use explicit !restart as a last resort.');
            return false;
        }
        const reason = event.reason || event.stopResult?.reason || event.actionResult?.reason || event.recoveryResult?.reason || 'unknown';
        const phase = event.actionResult?.actionPhase || event.stopResult?.actionPhase || event.recoveryResult?.actionPhase || event.actionResult?.phase || event.stopResult?.phase || event.recoveryResult?.phase || 'unknown';
        const prompt = `A previous action stopped safely and needs one bounded recovery plan.\n` +
            `Reason: ${reason}; phase: ${phase}; automatic recovery plan ${attempts}/${MAX_AUTOMATIC_RECOVERY_PLANS}.\n` +
            `Interrupted action: ${event.interruptedAction || 'unknown'} (id ${event.interruptedActionId ?? 'unknown'}).\n` +
            `Observed position: ${positionSummary(this.bot)}.\n` +
            `Current inventory view: ${inventorySummary(this.bot)}.\n` +
            `Partial action output: ${actionResultOutput(event)}\n` +
            `Make one safe next plan from this observed state. Do not repeat the same failed operation without new evidence. Do not use !restart; the Minecraft connection is active.`;
        const generation = ++this._messageGeneration;
        this._recoveryActionStartedId = null;
        const usedCommand = await this.handleMessage('system', prompt, 1, { recoveryId, generation });
        if (!this._shutdownStarted && recoveryId === this._activeRecoveryId && generation === this._messageGeneration && !this._recoveryActionStartedId) {
            this._reportRecoveryPaused(usedCommand
                ? 'Recovery response did not start a new action. The connection is still active; waiting for an explicit instruction.'
                : 'No recovery action was proposed. The connection is still active; waiting for an explicit instruction.');
        }
        return usedCommand;
    }

    async _finishRecoveryPlanAction(event) {
        if (this._shutdownStarted || this.managementPaused || this.actions.managementIntentRequired) return;
        if (event.recoveryId !== this._activeRecoveryId || this.actions.userStopped) return;
        if (this.bot?.inventoryUnconfirmed) {
            this.actions.pauseForRecovery();
            this._reportRecoveryPaused('Inventory state became unconfirmed during recovery; no further action was started. Confirm state or use explicit !restart as a last resort.');
            return;
        }
        if (event.progressObserved) {
            this.actions.clearRecoveryAfterProgress();
            this._activeRecoveryId = null;
            this._recoveryActionStartedId = null;
            return;
        }
        const result = event.result || {};
        const reason = result.reason || (result.success ? 'no-observed-progress' : 'recovery-action-failed');
        if (RECOVERY_NON_REPLAN_REASONS.has(reason)) {
            this._activeRecoveryId = null;
            return;
        }
        const attempts = this.actions.recordRecoveryAttempt();
        const nextEvent = {
            eventId: `followup-${event.recoveryId}-${event.actionId}`,
            kind: 'recovery-followup',
            reason,
            interruptedAction: event.actionLabel,
            interruptedActionId: event.actionId,
            actionResult: result,
            stopResult: null,
        };
        if (attempts > MAX_AUTOMATIC_RECOVERY_PLANS) {
            this._reportRecoveryPaused(`Automatic recovery limit (${MAX_AUTOMATIC_RECOVERY_PLANS}) reached after ${reason}. No observed position or inventory progress; the connection is still active and waiting for an explicit instruction.`);
            return;
        }
        await this._launchRecoveryPrompt(nextEvent, event.recoveryId, attempts);
    }

    _reportRecoveryPaused(message) {
        if (this._shutdownStarted) return;
        if (this._recoveryReportId === this._activeRecoveryId) return;
        this._recoveryReportId = this._activeRecoveryId;
        const report = `${message}\nCurrent position: ${positionSummary(this.bot)}. Current inventory view: ${inventorySummary(this.bot)}.`;
        console.warn(report);
        void this.openChat(report).catch(error => console.error('Recovery status report failed:', error));
    }

    async handleMessage(source, message, max_responses=null, internalOptions={}) {
        if (this._shutdownStarted) return false;
        const isHumanMessage = !!source && source !== 'system' && source !== this.name && !convoManager.isOtherAgent(source);
        const incomingCommand = isHumanMessage && typeof message === 'string' ? containsCommand(message) : null;
        const isUserStop = isHumanMessage && incomingCommand === '!stop';
        const isUserRestart = isHumanMessage && incomingCommand === '!restart';
        const isUserStfu = isHumanMessage && incomingCommand === '!stfu';
        const isSafeQuery = isHumanMessage && !!incomingCommand && commandExists(incomingCommand) && !isAction(incomingCommand);
        if (isUserRestart) {
            void this.cleanKill('Explicit restart requested.', 0);
            return true;
        }
        const isHumanIntent = isHumanMessage && !!message && !isUserStop && !isUserStfu &&
            (!incomingCommand || (commandExists(incomingCommand) && isAction(incomingCommand)));
        if (this.managementPaused && !isUserStop && !isUserRestart && !isSafeQuery) return false;
        if (this.actions?.managementIntentRequired && !isHumanIntent && !isUserStop && !isUserRestart && !isSafeQuery) return false;
        let generation = internalOptions.generation ?? this._messageGeneration;
        if (isHumanIntent) {
            this._userIntentGeneration = (this._userIntentGeneration || 0) + 1;
            generation = ++this._messageGeneration;
            this._activeRecoveryId = null;
            this._recoveryReportId = null;
            this.actions.beginUserIntent();
        } else if (isUserStop) {
            generation = ++this._messageGeneration;
        }
        const recoveryId = internalOptions.recoveryId || null;
        const managementGeneration = this._managementGeneration || 0;
        const isCurrent = () => !this._shutdownStarted && generation === this._messageGeneration && (!recoveryId || recoveryId === this._activeRecoveryId) &&
            (isUserStop || isUserRestart || isSafeQuery || ((!this.managementPaused && !this.actions?.managementPaused) && managementGeneration === (this._managementGeneration || 0)));
        if (!this.managementPaused && !this.actions?.managementIntentRequired) await this.checkTaskDone();
        if (this._shutdownStarted || !isCurrent()) return false;
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);

        if ((self_prompt || from_other_bot) && this.actions.userStopped)
            return false;

        if (isHumanIntent && this.actions.executing) {
            const stopped = await this.actions.stop('superseded');
            if (!isCurrent() || !stopped.stopped) return false;
        }
        if (isUserStop) {
            this._activeRecoveryId = null;
            this._recoveryReportId = null;
        }

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    // all user-initiated commands are ignored by the bot except for this one
                    // add the preceding message to the history to give context for newAction
                    this.history.add(source, message);
                }
                let execute_res;
                const previousRecoveryCommand = this._recoveryPromptCommand;
                const previousAdmissionId = this._recoveryAdmissionId;
                if (recoveryId && isAction(user_command_name)) {
                    this._recoveryPromptCommand = true;
                    this._recoveryAdmissionId = recoveryId;
                }
                try { execute_res = await executeCommand(this, message); }
                finally {
                    this._recoveryPromptCommand = previousRecoveryCommand;
                    this._recoveryAdmissionId = previousAdmissionId;
                }
                if (!isCurrent()) return false;
                if (execute_res)
                    this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;

        // Now translate the message
        message = await handleEnglishTranslation(message);
        if (!isCurrent()) return false;
        console.log('received message from', source, ':', message);

        const checkInterrupt = () => this._shutdownStarted || this.managementPaused || this.actions.managementPaused || this.actions.managementIntentRequired || (!recoveryId && this.self_prompter.shouldInterrupt(self_prompt)) || this.shut_up || convoManager.responseScheduledFor(source) || this.actions.userStopped;
        
        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
            if (!isCurrent()) return false;
        }

        // Handle other user messages
        await this.history.add(source, message);
        if (!isCurrent()) return false;
        this.history.save();

        if (!self_prompt && this.self_prompter.isActive()) // message is from user during self-prompting
            max_responses = 1; // force only respond to this message, then let self-prompting take over
        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            let history = this.history.getHistory();
            let res = await this.prompter.promptConvo(history);
            if (!isCurrent()) return false;
            if (checkInterrupt()) break;

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                console.warn('no response')
                break; // empty response ends loop
            }

            let command_name = containsCommand(res);

            if (command_name) { // contains query or command
                res = truncCommandMessage(res); // everything after the command is ignored
                this.history.add(this.name, res);
                
                if (!commandExists(command_name)) {
                    this.history.add('system', `Command ${command_name} does not exist.`);
                    console.warn('Agent hallucinated command:', command_name)
                    continue;
                }

                if (command_name === '!restart') {
                    if (recoveryId) this._reportRecoveryPaused('Automatic recovery cannot restart the agent. The connection is active and waiting for an explicit user instruction.');
                    else console.warn('Ignored model-generated !restart; only an explicit human !restart command may restart the agent.');
                    break;
                }

                if (checkInterrupt()) break;
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.show_command_syntax === "full") {
                    this.routeResponse(source, res);
                }
                else if (settings.show_command_syntax === "shortened") {
                    // show only "used !commandname"
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.routeResponse(source, chat_message);
                }
                else {
                    // no command at all
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    if (pre_message.trim().length > 0)
                        this.routeResponse(source, pre_message);
                }

                let execute_res;
                const previousRecoveryCommand = this._recoveryPromptCommand;
                const previousAdmissionId = this._recoveryAdmissionId;
                if (recoveryId && isAction(command_name)) {
                    this._recoveryPromptCommand = true;
                    this._recoveryAdmissionId = recoveryId;
                }
                try { execute_res = await executeCommand(this, res); }
                finally {
                    this._recoveryPromptCommand = previousRecoveryCommand;
                    this._recoveryAdmissionId = previousAdmissionId;
                }
                if (!isCurrent()) return false;

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                used_command = true;

                if (execute_res)
                    this.history.add('system', execute_res);
                else
                    break;
            }
            else { // conversation response
                this.history.add(this.name, res);
                this.routeResponse(source, res);
                break;
            }
            
            this.history.save();
        }

        return used_command;
    }

    async routeResponse(to_player, message) {
        if (this._shutdownStarted || this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            // this is for when the agent is prompted by system while still in conversation
            // so it can respond to events like death but be routed back to the last sender
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            convoManager.sendToBot(to_player, message);
        }
        else {
            // otherwise, use open chat
            this.openChat(message);
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }

    async openChat(message) {
        if (this._shutdownStarted) return;
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        if (this._shutdownStarted) return;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');
        sendOutputToServer(this.name, message);

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
            if (settings.speak) {
                speak(to_translate, this.prompter.profile.speak_model);
            }
            if (settings.chat_ingame) {this.bot.chat(message);}
        }
    }

    startEvents() {
        if (this._shutdownStarted) return;
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
            }
            prev_health = this.bot.health;
        });
        // Logging callbacks
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });
        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason) => {
            if (!this._disconnectHandled) {
                this._disconnectHandled = true;
                const { msg } = handleDisconnection(this.name, reason);
                if (this.requestShutdown) void this.requestShutdown('connection-lost', { restartIntent: true, code: 1 });
                else void this.shutdown('connection-lost', { restartIntent: true, code: 1 });
            }
        });
        this.bot.on('death', () => {
            this.actions.cancelResume();
            this.actions.stop('death');
        });
        this.bot.on('kicked', (reason) => {
            if (!this._disconnectHandled) {
                this._disconnectHandled = true;
                const { msg } = handleDisconnection(this.name, reason);
                if (this.requestShutdown) void this.requestShutdown('connection-lost', { restartIntent: true, code: 1 });
                else void this.shutdown('connection-lost', { restartIntent: true, code: 1 });
            }
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity?.position;
                let death_pos_text = null;
                let deathPlaceSaved = false;
                if (death_pos && ['x', 'y', 'z'].every((axis) => Number.isFinite(death_pos[axis]))) {
                    try {
                        await this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z, {
                            dimension: this.bot.game.dimension,
                            kind: 'other',
                            purpose: 'death location'
                        });
                        deathPlaceSaved = true;
                    } catch (error) {
                        console.error('Failed to save death location:', error.message);
                    }
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                }
                let dimension = this.bot.game.dimension;
                this.handleMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimension} dimension with the final message: '${message}'. ${deathPlaceSaved ? "Your place of death is saved as 'last_death_position' if you want to return." : 'The death location could not be confirmed or saved.'} Previous actions were stopped and you have respawned.`);
            }
        });
        this.bot.on('idle', () => {
            if (this._shutdownStarted || this.managementPaused || this.actions.managementIntentRequired) return;
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            if (this._idleResumeTimer) return;
            this._idleResumeTimer = setTimeout(() => {
                this._idleResumeTimer = null;
                if (!this._shutdownStarted && !this.managementPaused && !this.actions.managementIntentRequired && this.isIdle()) {
                    this.actions.resumeAction().catch(error => console.error('Resume action failed:', error));
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        this._updateLoopTimer = setTimeout(async () => {
            while (!this._shutdownStarted) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0 && !this._shutdownStarted) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        if (this._shutdownStarted || this.managementPaused || this.actions.managementIntentRequired) return;
        await this.bot.modes.update();
        if (this._shutdownStarted || this.managementPaused || this.actions.managementIntentRequired) return;
        this.self_prompter.update(delta);
        if (!this.managementPaused && !this.actions.managementIntentRequired) await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }
    

    async checkTaskDone() {
        if (this._shutdownStarted || this.managementPaused || this.actions?.managementIntentRequired) return;
        if (this.task.data) {
            let res = this.task.isDone();
            if (res) {
                console.log('Task finished:', res.message);
                this.taskResult = { score: res.score, message: String(res.message || '') };
                this.killAll(`Task ended with score: ${res.score}. ${res.message || ''}`);
            }
        }
    }

    killAll(message = 'Task complete.') {
        const intent = { restartIntent: false, code: 0, message: String(message || '') };
        if (this.requestShutdown) return this.requestShutdown('task-complete', intent);
        return this.shutdown('task-complete', intent).then(async outcome => {
            if (typeof process.send === 'function' && process.connected) await sendStandaloneExitIntent(outcome);
            process.exit(0);
            return outcome;
        });
    }
}
