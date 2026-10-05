import { readFileSync, mkdirSync, writeFileSync} from 'fs';
import { Examples } from '../utils/examples.js';
import { getCommandDocs } from '../agent/commands/index.js';
import { SkillLibrary } from "../agent/library/skill_library.js";
import { stringifyTurns } from '../utils/text.js';
import { getCommand } from '../agent/commands/index.js';
import settings from '../agent/settings.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { selectAPI, createModel } from './_model_map.js';
import { randomUUID } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class Prompter {
    constructor(agent, profile) {
        this.agent = agent;
        this.profile = profile;
        let default_profile = JSON.parse(readFileSync('./profiles/defaults/_default.json', 'utf8'));
        let base_fp = '';
        if (settings.base_profile.includes('survival')) {
            base_fp = './profiles/defaults/survival.json';
        } else if (settings.base_profile.includes('assistant')) {
            base_fp = './profiles/defaults/assistant.json';
        } else if (settings.base_profile.includes('creative')) {
            base_fp = './profiles/defaults/creative.json';
        } else if (settings.base_profile.includes('god_mode')) {
            base_fp = './profiles/defaults/god_mode.json';
        }
        let base_profile = JSON.parse(readFileSync(base_fp, 'utf8'));

        // first use defaults to fill in missing values in the base profile
        for (let key in default_profile) {
            if (base_profile[key] === undefined)
                base_profile[key] = default_profile[key];
        }
        // then use base profile to fill in missing values in the individual profile
        for (let key in base_profile) {
            if (this.profile[key] === undefined)
                this.profile[key] = base_profile[key];
        }
        // base overrides default, individual overrides base

        this.convo_examples = null;
        this.coding_examples = null;
        
        let name = this.profile.name;
        this.cooldown = this.profile.cooldown ? this.profile.cooldown : 0;
        this.last_prompt_time = 0;
        this.awaiting_coding = false;

        // for backwards compatibility, move max_tokens to params
        let max_tokens = null;
        if (this.profile.max_tokens)
            max_tokens = this.profile.max_tokens;

        let chat_model_profile = selectAPI(this.profile.model);
        this.chat_model = createModel(chat_model_profile);

        if (this.profile.code_model) {
            let code_model_profile = selectAPI(this.profile.code_model);
            this.code_model = createModel(code_model_profile);
        }
        else {
            this.code_model = this.chat_model;
        }

        if (this.profile.vision_model) {
            let vision_model_profile = selectAPI(this.profile.vision_model);
            this.vision_model = createModel(vision_model_profile);
        }
        else {
            this.vision_model = this.chat_model;
        }

        
        let embedding_model_profile = null;
        if (this.profile.embedding) {
            try {
                embedding_model_profile = selectAPI(this.profile.embedding);
            } catch (e) {
                embedding_model_profile = null;
            }
        }
        if (embedding_model_profile) {
            this.embedding_model = createModel(embedding_model_profile);
        }
        else {
            this.embedding_model = createModel({api: chat_model_profile.api});
        }

        this.skill_libary = new SkillLibrary(agent, this.embedding_model);
        mkdirSync(`./bots/${name}`, { recursive: true });
        writeFileSync(`./bots/${name}/last_profile.json`, JSON.stringify(this.profile, null, 4), (err) => {
            if (err) {
                throw new Error('Failed to save profile:', err);
            }
            console.log("Copy profile saved.");
        });
    }

    getName() {
        return this.profile.name;
    }

    getInitModes() {
        return this.profile.modes;
    }

    async initExamples() {
        try {
            this.convo_examples = new Examples(this.embedding_model, settings.num_examples);
            this.coding_examples = new Examples(this.embedding_model, settings.num_examples);
            
            // Wait for both examples to load before proceeding
            await Promise.all([
                this.convo_examples.load(this.profile.conversation_examples),
                this.coding_examples.load(this.profile.coding_examples),
                this.skill_libary.initSkillLibrary()
            ]).catch(error => {
                // Preserve error details
                console.error('Failed to initialize examples. Error details:', error);
                console.error('Stack trace:', error.stack);
                throw error;
            });

            console.log('Examples initialized.');
        } catch (error) {
            console.error('Failed to initialize examples:', error);
            console.error('Stack trace:', error.stack);
            throw error; // Re-throw with preserved details
        }
    }

    async withBotRules(prompt) {
        const rulesPath = settings.bot_rules_file;
        if (rulesPath == null) return prompt;
        if (typeof rulesPath !== 'string' || !path.isAbsolute(rulesPath)) {
            throw new Error('bot_rules_file must be an absolute path or null');
        }
        let rules;
        try {
            rules = (await fs.readFile(rulesPath, 'utf8')).trim();
        } catch (error) {
            throw new Error(`Cannot read shared bot rules ${rulesPath}: ${error.message}`, { cause: error });
        }
        if (!rules) return prompt;
        return `${prompt}\n\nSHARED BOT RULES\nThese operator rules apply to every bot, including you. Follow them when choosing goals, planning actions, and writing code. They take precedence over conflicting individual profile preferences and old conversation or memory. A current explicit operator instruction may make an exception.\n\n${rules}`;
    }

    async replaceStrings(prompt, messages, examples=null, to_summarize=[], last_goals=null) {
        prompt = prompt.replaceAll('$NAME', this.agent.name);

        if (prompt.includes('$STATS')) {
            let stats = await getCommand('!stats').perform(this.agent) + '\n';
            stats += await getCommand('!entities').perform(this.agent) + '\n';
            stats += await getCommand('!nearbyBlocks').perform(this.agent);
            prompt = prompt.replaceAll('$STATS', stats);
        }
        if (prompt.includes('$INVENTORY')) {
            let inventory = await getCommand('!inventory').perform(this.agent);
            prompt = prompt.replaceAll('$INVENTORY', inventory);
        }
        if (prompt.includes('$ACTION')) {
            prompt = prompt.replaceAll('$ACTION', this.agent.actions.currentActionLabel);
        }
        if (prompt.includes('$COMMAND_DOCS'))
            prompt = prompt.replaceAll('$COMMAND_DOCS', getCommandDocs(this.agent));
        if (prompt.includes('$CODE_DOCS')) {
            const code_task_content = messages.slice().reverse().find(msg =>
                msg.role !== 'system' && msg.content.includes('!newAction(')
            )?.content?.match(/!newAction\((.*?)\)/)?.[1] || '';

            const codeDocs = await this.skill_libary.getRelevantSkillDocs(code_task_content, settings.relevant_docs_count);
            const placeDocs = this.agent.places?.isEnabled() ? `
#### PLACE MEMORY SDK
The ` + '`places`' + ` object is a restricted, async SDK. It does not expose the bot, socket, filesystem, or state directory.
- ` + '`places.find(text, options?)`' + ` searches this dimension and returns stable IDs, with purpose/kind filters.
- ` + '`places.inspect(placeId)`' + ` returns verification and output-storage details; inspect candidates before choosing.
- ` + '`places.rememberHere(name, kind?, purpose?)`' + ` records the bot's current point (kind ` + '`base`' + ` is only a representative point).
- ` + '`places.rememberObservedAt(name, kind, purpose, position)`' + ` records a currently loaded block only when it matches the kind (farm=farmland, storage=chest/trapped chest).
- ` + '`places.rememberReported(name, kind, purpose, {x,y,z}, dimension?)`' + ` records coordinates as unverified.
- ` + '`places.verify(placeId)`' + ` requires a loaded target block in the current dimension.
- ` + '`places.goTo(placeId)`' + ` and ` + '`places.tendFarm(farmId, options?)`' + ` use existing movement and farm actions by stable ID.
- ` + '`places.setOutputStorage(fromId, storageId)`' + ` sets an explicit same-dimension relation to a storage record.
Treat missing or stale observations as uncertain. Do not claim reported coordinates were observed, and do not invent IDs; search or inspect first.` : '';
            prompt = prompt.replaceAll(
                '$CODE_DOCS',
                codeDocs + placeDocs
            );
        }
        if (prompt.includes('$EXAMPLES') && examples !== null)
            prompt = prompt.replaceAll('$EXAMPLES', await examples.createExampleMessage(messages));
        if (prompt.includes('$MEMORY'))
            prompt = prompt.replaceAll('$MEMORY', this.agent.history.memory);
        if (prompt.includes('$TO_SUMMARIZE'))
            prompt = prompt.replaceAll('$TO_SUMMARIZE', stringifyTurns(to_summarize));
        if (prompt.includes('$CONVO'))
            prompt = prompt.replaceAll('$CONVO', 'Recent conversation:\n' + stringifyTurns(messages));
        if (prompt.includes('$SELF_PROMPT')) {
            // if active or paused, show the current goal
            let self_prompt = !this.agent.self_prompter.isStopped() ? `YOUR CURRENT ASSIGNED GOAL: "${this.agent.self_prompter.prompt}"\n` : '';
            prompt = prompt.replaceAll('$SELF_PROMPT', self_prompt);
        }
        if (prompt.includes('$LAST_GOALS')) {
            let goal_text = '';
            for (let goal in last_goals) {
                if (last_goals[goal])
                    goal_text += `You recently successfully completed the goal ${goal}.\n`
                else
                    goal_text += `You recently failed to complete the goal ${goal}.\n`
            }
            prompt = prompt.replaceAll('$LAST_GOALS', goal_text.trim());
        }
        if (prompt.includes('$BLUEPRINTS')) {
            if (this.agent.npc.constructions) {
                let blueprints = '';
                for (let blueprint in this.agent.npc.constructions) {
                    blueprints += blueprint + ', ';
                }
                prompt = prompt.replaceAll('$BLUEPRINTS', blueprints.slice(0, -2));
            }
        }

        // check if there are any remaining placeholders with syntax $<word>
        let remaining = prompt.match(/\$[A-Z_]+/g);
        if (remaining !== null) {
            console.warn('Unknown prompt placeholders:', remaining.join(', '));
        }
        return prompt;
    }

    async checkCooldown(signal=null) {
        let elapsed = Date.now() - this.last_prompt_time;
        if (elapsed < this.cooldown && this.cooldown > 0) {
            const waited = signal
                ? await waitForCooldown(this.cooldown - elapsed, signal)
                : await new Promise(resolve => setTimeout(resolve, this.cooldown - elapsed));
            if (waited === REQUEST_CANCELLED || signal?.aborted) return REQUEST_CANCELLED;
        }
        if (signal?.aborted) return REQUEST_CANCELLED;
        this.last_prompt_time = Date.now();
    }

    async promptConvo(messages) {
        this.most_recent_msg_time = Date.now();
        let current_msg_time = this.most_recent_msg_time;
        this.conversationController?.abort('superseded conversation request');
        const conversationController = new AbortController();
        this.conversationController = conversationController;
        const finishConversation = result => {
            if (this.conversationController === conversationController) this.conversationController = null;
            return result;
        };

        for (let i = 0; i < 3; i++) { // try 3 times to avoid hallucinations
            const cooldown = await this.checkCooldown(conversationController.signal);
            if (cooldown === REQUEST_CANCELLED || conversationController.signal.aborted || current_msg_time !== this.most_recent_msg_time) {
                return finishConversation('');
            }

            let prompt = this.profile.conversing;
            prompt = await this.replaceStrings(prompt, messages, this.convo_examples);
            prompt = await this.withBotRules(prompt);
            if (this.agent.places) prompt += `\n\nPLACE MEMORY CONTEXT\n${this.agent.places.getPromptContext()}`;
            let generation;

            try {
                generation = await this.chat_model.sendRequest(messages, prompt, '***', this._requestOptions('conversation', null, conversationController.signal));
                if (conversationController.signal.aborted) return finishConversation('');
                if (typeof generation !== 'string') {
                    console.error('Error: Generated response is not a string', generation);
                    throw new Error('Generated response is not a string');
                }
                console.log("Generated response:", generation);
                await this._saveLog(prompt, messages, generation, 'conversation');

            } catch (error) {
                if (conversationController.signal.aborted) return finishConversation('');
                console.error('Error during message generation or file writing:', error);
                continue;
            }

            // Check for hallucination or invalid output
            if (generation?.includes('(FROM OTHER BOT)')) {
                console.warn('LLM hallucinated message as another bot. Trying again...');
                continue;
            }

            if (current_msg_time !== this.most_recent_msg_time) {
                console.warn(`${this.agent.name} received new message while generating, discarding old response.`);
                return finishConversation('');
            }

            if (generation?.includes('</think>')) {
                const [_, afterThink] = generation.split('</think>')
                generation = afterThink
            }

            return finishConversation(generation);
        }

        return finishConversation('');
    }

    async promptCoding(messages, cancellationContext=null) {
        if (this.awaiting_coding) {
            console.warn('Already awaiting coding response, returning no response.');
            return '```//no response```';
        }
        this.awaiting_coding = true;
        const context = cancellationContext || this.agent.actions.getCancellationContext?.() || null;
        const signal = context?.signal;
        try {
            if (signal?.aborted) return null;
            if (signal) {
                const cooldownResult = await this.checkCooldown(signal);
                if (cooldownResult === REQUEST_CANCELLED || signal.aborted) return null;
            } else {
                await this.checkCooldown();
            }
            if (signal?.aborted) return null;
            let prompt = this.profile.coding;
            const promptPreparation = this.replaceStrings(prompt, messages, this.coding_examples)
                .then(prepared => this.withBotRules(prepared));
            prompt = signal
                ? await awaitRequestOrCancellation(promptPreparation, signal)
                : await promptPreparation;
            if (prompt === REQUEST_CANCELLED) return null;
            if (signal?.aborted) return null;
            if (this.agent.places) prompt += `\n\nPLACE MEMORY CONTEXT\n${this.agent.places.getPromptContext()}`;

            const request = this.code_model.sendRequest(messages, prompt, '***', this._requestOptions('coding', context, signal));
            let resp;
            if (signal && this.code_model.constructor.prefix !== 'codex') {
                resp = await awaitRequestOrCancellation(request, signal);
                if (resp === REQUEST_CANCELLED) return null;
            } else {
                // Codex owns a process group and does not reject until that
                // group is gone; awaiting it keeps tempdir cleanup inside the
                // action's settlement boundary.
                resp = await request;
            }
            if (signal?.aborted) return null;
            await this._saveLog(prompt, messages, resp, 'coding');
            if (signal?.aborted) return null;
            return resp;
        } finally {
            this.awaiting_coding = false;
        }
    }

    async promptMemSaving(to_summarize, options={}) {
        const cooldown = await this.checkCooldown(options.signal);
        if (cooldown === REQUEST_CANCELLED || options.signal?.aborted) return null;
        if (options.signal?.aborted) return null;
        let prompt = this.profile.saving_memory;
        prompt = await this.replaceStrings(prompt, null, null, to_summarize);
        if (options.signal?.aborted) return null;
        let resp = await this.chat_model.sendRequest([], prompt, '***', this._requestOptions('memory-summary', null, options.signal, options.requestId));
        if (options.signal?.aborted) return null;
        await this._saveLog(prompt, to_summarize, resp, 'memSaving');
        if (resp?.includes('</think>')) {
            const [_, afterThink] = resp.split('</think>')
            resp = afterThink;
        }
        return resp;
    }

    async promptShouldRespondToBot(new_message) {
        await this.checkCooldown();
        let prompt = this.profile.bot_responder;
        let messages = this.agent.history.getHistory();
        messages.push({role: 'user', content: new_message});
        prompt = await this.replaceStrings(prompt, null, null, messages);
        prompt = await this.withBotRules(prompt);
        let res = await this.chat_model.sendRequest([], prompt);
        return res.trim().toLowerCase() === 'respond';
    }

    async promptVision(messages, imageBuffer, options={}) {
        const cooldown = await this.checkCooldown(options.signal);
        if (cooldown === REQUEST_CANCELLED || options.signal?.aborted) return null;
        let prompt = this.profile.image_analysis;
        prompt = await this.replaceStrings(prompt, messages, null, null, null);
        if (options.signal?.aborted) return null;
        return await this.vision_model.sendVisionRequest(messages, prompt, imageBuffer,
            this._requestOptions('vision', options.context ?? null, options.signal, options.requestId));
    }

    _requestOptions(purpose, context=null, signal=null, requestId=null) {
        const action = context || this.agent.actions?.getCancellationContext?.() || null;
        const scope = {
            requestId: requestId || randomUUID(), purpose,
            taskId: action?.taskId ?? (this.agent.codexRuntime?.active ? this.agent.codexRuntime.taskId : null),
            actionId: action?.actionId ?? null,
        };
        return { ...scope, signal, onUsage: detail => {
            // Usage metadata is diagnostic only. Keep the request-start scope;
            // never look up the possibly replaced task after the await.
            console.info('Model usage', { ...scope, usage: detail.usage, elapsedMs: detail.elapsedMs,
                provider: detail.provider, attempt: detail.attempt });
        } };
    }

    async promptGoalSetting(messages, last_goals) {
        // deprecated
        let system_message = this.profile.goal_setting;
        system_message = await this.replaceStrings(system_message, messages);
        system_message = await this.withBotRules(system_message);

        let user_message = 'Use the below info to determine what goal to target next\n\n';
        user_message += '$LAST_GOALS\n$STATS\n$INVENTORY\n$CONVO'
        user_message = await this.replaceStrings(user_message, messages, null, null, last_goals);
        let user_messages = [{role: 'user', content: user_message}];

        let res = await this.chat_model.sendRequest(user_messages, system_message);

        let goal = null;
        try {
            let data = res.split('```')[1].replace('json', '').trim();
            goal = JSON.parse(data);
        } catch (err) {
            console.log('Failed to parse goal:', res, err);
        }
        if (!goal || !goal.name || !goal.quantity || isNaN(parseInt(goal.quantity))) {
            console.log('Failed to set goal:', res);
            return null;
        }
        goal.quantity = parseInt(goal.quantity);
        return goal;
    }

    async _saveLog(prompt, messages, generation, tag) {
        if (!settings.log_all_prompts)
            return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        let logEntry;
        let task_id = this.agent.task.task_id;
        if (task_id == null) {
            logEntry = `[${timestamp}] \nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        } else {
            logEntry = `[${timestamp}] Task ID: ${task_id}\nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        }
        const logFile = `${tag}_${timestamp}.txt`;
        await this._saveToFile(logFile, logEntry);
    }

    async _saveToFile(logFile, logEntry) {
        let task_id = this.agent.task.task_id;
        let logDir;
        if (task_id == null) {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs`);
        } else {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs/${task_id}`);
        }

        await fs.mkdir(logDir, { recursive: true });

        logFile = path.join(logDir, logFile);
        await fs.appendFile(logFile, String(logEntry), 'utf-8');
    }
}

const REQUEST_CANCELLED = Symbol('coding request cancelled');

async function awaitRequestOrCancellation(request, signal) {
    let onAbort;
    const cancelled = new Promise(resolve => {
        onAbort = () => resolve(REQUEST_CANCELLED);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
    });
    try {
        return await Promise.race([request, cancelled]);
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}

function waitForCooldown(delayMs, signal) {
    return new Promise(resolve => {
        let timer;
        const finish = result => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            resolve(result);
        };
        const onAbort = () => finish(REQUEST_CANCELLED);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
            onAbort();
            return;
        }
        timer = setTimeout(() => finish(), delayMs);
    });
}
