import { writeFile, readFile, mkdirSync } from 'fs';
import { makeCompartment, lockdown } from './library/lockdown.js';
import * as skills from './library/skills.js';
import * as world from './library/world.js';
import settings from './settings.js';
import { Vec3 } from 'vec3';
import {ESLint} from "eslint";
import { trackSkill, operationContext, registerOwnedPromise, NATIVE_EXECUTION_WINDOW_MS } from './library/operation_context.js';

export class Coder {
    constructor(agent) {
        this.agent = agent;
        this.file_counter = 0;
        this.fp = '/bots/'+agent.name+'/action-code/';
        this.code_template = '';
        this.code_lint_template = '';

        readFile('./bots/execTemplate.js', 'utf8', (err, data) => {
            if (err) throw err;
            this.code_template = data;
        });
        readFile('./bots/lintTemplate.js', 'utf8', (err, data) => {
            if (err) throw err;
            this.code_lint_template = data;
        });
        mkdirSync('.' + this.fp, { recursive: true });
    }

    // Execute already selected code; the caller owns reasoning and ActionManager.
    async executeCode(code) {
        const context = this.agent.actions.getCancellationContext();
        const check = () => {
            if (context?.signal.aborted || this.agent.bot.interrupt_code) throw new Error('Action cancelled');
        };
        const safety = settings.agent_runtime === 'codex-session'
            ? nativeExecutionSafety(settings.codex_session?.execution_window_ms ?? NATIVE_EXECUTION_WINDOW_MS) : null;
        lockdown();
        check();
        this.agent.actions.setPhase('staging', context?.actionId);
        const staged = await this._stageCode(code, check, safety);
        check();
        this.agent.actions.setPhase('linting', context?.actionId);
        if (!staged) throw new Error('Could not stage code');
        const error = await this._lintCode(staged.src_lint_copy);
        check();
        if (error) throw new Error(error);
        this.agent.actions.setPhase('executing', context?.actionId);
        safety?.start();
        try {
            await trackSkill('generated_code', () => staged.func.main(this.agent.bot, staged.places))();
            check();
            safety?.finish();
        } catch (error) {
            check();
            if (!safety?.isYield(error)) throw error;
            skills.log(this.agent.bot, 'SDK execution window reached; yielding with completed changes retained.');
        }
        check();
    }

    async generateCode(agent_history) {
        const context = this.agent.actions.getCancellationContext?.() || null;
        const actionId = context?.actionId;
        const isCancelled = () => !!context?.signal?.aborted || this.agent.bot.interrupt_code;
        const setPhase = phase => {
            if (context) this.agent.actions.setPhase(phase, actionId);
        };
        lockdown();
        // this message history is transient and only maintained in this function
        let messages = agent_history.getHistory();
        messages.push({role: 'system', content: 'Code generation started. Write code in codeblock in your response:'});

        const MAX_ATTEMPTS = 5;
        const MAX_NO_CODE = 3;

        let code = null;
        let no_code_failures = 0;
        for (let i=0; i<MAX_ATTEMPTS; i++) {
            if (isCancelled()) return null;
            setPhase('generating');
            const messages_copy = JSON.parse(JSON.stringify(messages));
            let res = await this.agent.prompter.promptCoding(messages_copy, context);
            if (isCancelled()) return null;
            if (typeof res !== 'string') return null;
            let contains_code = res.indexOf('```') !== -1;
            if (!contains_code) {
                if (res.indexOf('!newAction') !== -1) {
                    messages.push({
                        role: 'assistant',
                        content: res.substring(0, res.indexOf('!newAction'))
                    });
                    continue; // using newaction will continue the loop
                }

                if (no_code_failures >= MAX_NO_CODE) {
                    console.warn("Action failed, agent would not write code.");
                    return 'Action failed, agent would not write code.';
                }
                messages.push({
                    role: 'system',
                    content: 'Error: no code provided. Write code in codeblock in your response. ``` // example ```'}
                );
                console.warn("No code block generated. Trying again.");
                no_code_failures++;
                continue;
            }
            code = res.substring(res.indexOf('```')+3, res.lastIndexOf('```'));
            if (isCancelled()) return null;
            setPhase('staging');
            const result = await this._stageCode(code);
            if (isCancelled()) return null;
            if (!result) {
                console.warn("Failed to stage code, something is wrong.");
                return 'Failed to stage code, something is wrong.';
            }
            const executionModule = result.func;
            setPhase('linting');
            const lintResult = await this._lintCode(result.src_lint_copy);
            if (isCancelled()) return null;
            if (lintResult) {
                const message = 'Error: Code lint error:'+'\n'+lintResult+'\nPlease try again.';
                console.warn("Linting error:"+'\n'+lintResult+'\n');
                messages.push({ role: 'system', content: message });
                continue;
            }
            if (!executionModule) {
                console.warn("Failed to stage code, something is wrong.");
                return 'Failed to stage code, something is wrong.';
            }

            try {
                setPhase('executing');
                if (isCancelled()) return null;
                console.log('Executing code...');
                await trackSkill('generated_code', () => executionModule.main(this.agent.bot, this.agent.places?.sdk))();

                const code_output = this.agent.actions.getBotOutputSummary();
                const summary = "Agent wrote this code: \n```" + this._sanitizeCode(code) + "```\nCode Output:\n" + code_output;
                return summary;
            } catch (e) {
                if (isCancelled())
                    return null;

                console.warn('Generated code threw error: ' + e.toString());
                console.warn('trying again...');

                const code_output = this.agent.actions.getBotOutputSummary();

                messages.push({
                    role: 'assistant',
                    content: res
                });
                messages.push({
                    role: 'system',
                    content: `Code Output:\n${code_output}\nCODE EXECUTION THREW ERROR: ${e.toString()}\n Please try again:`
                });
            }
        }
        return `Code generation failed after ${MAX_ATTEMPTS} attempts.`;
    }
    
    async  _lintCode(code) {
        let result = '#### CODE ERROR INFO ###\n';
        const codeNoComments = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const skillRegex = /((?:skills|world|places|vision|communication|diagnostics)\.(.*?))\(/g;
        const skills = [];
        let match;
        while ((match = skillRegex.exec(codeNoComments)) !== null) {
            skills.push(match[1]);
        }
        const allDocs = settings.agent_runtime === 'codex-session'
            ? (await import('./library/native_sdk.js')).getNativeSdkDocs(settings)
            : await this.agent.prompter.skill_libary.getAllSkillDocs();
        const knownSkills = new Set(allDocs.map(doc => doc.split('\n')[0]));
        const missingSkills = skills.filter(skill => !knownSkills.has(skill));
        if (missingSkills.length > 0) {
            result += 'These functions do not exist:\n';
            result += missingSkills.join('\n');
            console.log(result)
            return result;
        }

        const eslint = new ESLint();
        const results = await eslint.lintText(code);
        const codeLines = code.split('\n');
        const exceptions = results.map(r => r.messages).flat();

        if (exceptions.length > 0) {
            exceptions.forEach((exc, index) => {
                if (exc.line && exc.column ) {
                    const errorLine = codeLines[exc.line - 1]?.trim() || 'Unable to retrieve error line content';
                    result += `#ERROR ${index + 1}\n`;
                    result += `Message: ${exc.message}\n`;
                    result += `Location: Line ${exc.line}, Column ${exc.column}\n`;
                    result += `Related Code Line: ${errorLine}\n`;
                }
            });
            result += 'The code contains exceptions and cannot continue execution.';
        } else {
            return null;//no error
        }

        return result ;
    }
    // write custom code to file and import it
    // write custom code to file and prepare for evaluation
    async _stageCode(code, check = null, safety = null) {
        code = this._sanitizeCode(code);
        let src = '';
        code = code.replaceAll('console.log(', 'log(bot,');
        code = code.replaceAll('log("', 'log(bot,"');

        console.log(`Generated code: """${code}"""`);

        // this may cause problems in callback functions
        code = code.replaceAll(';\n', '; if(bot.interrupt_code) {log(bot, "Code interrupted.");return;}\n');
        for (let line of code.split('\n')) {
            src += `    ${line}\n`;
        }
        let src_lint_copy = this.code_lint_template.replace('/* CODE HERE */', src);
        src = this.code_template.replace('/* CODE HERE */', src);

        let filename = this.file_counter + '.js';
        // if (this.file_counter > 0) {
        //     let prev_filename = this.fp + (this.file_counter-1) + '.js';
        //     unlink(prev_filename, (err) => {
        //         console.log("deleted file " + prev_filename);
        //         if (err) console.error(err);
        //     });
        // } commented for now, useful to keep files for debugging
        this.file_counter++;
        
        let write_result = await this._writeFilePromise('.' + this.fp + filename, src);
        // This is where we determine the environment the agent's code should be exposed to.
        // It will only have access to these things, (in addition to basic javascript objects like Array, Object, etc.)
        // Note that the code may be able to modify the exposed objects.
        // Guard each SDK entry, including inline compound code after an await.
        const guarded = (sdk, namespace) => guardSdk(sdk, check, safety, namespace);
        const bindings = {
            skills: configureGeneratedCodeFalseMode(skills, settings.generated_code_fail_on_false),
            world,
            vision: {
                lookAtPlayer: trackSkill('vision.lookAtPlayer', (playerName, direction) => this.agent.vision_interpreter.lookAtPlayer(playerName, direction)),
                lookAtBlock: trackSkill('vision.lookAtBlock', (x, y, z) => this.agent.vision_interpreter.lookAtBlock(x, y, z)),
                lookAtPosition: trackSkill('vision.lookAtPosition', (x, y, z) => this.agent.vision_interpreter.lookAtPosition(x, y, z)),
            },
            communication: settings.agent_runtime === 'codex-session' ? {
                sendToBot: trackSkill('communication.sendToBot', (recipient, message) => {
                    if (!this.agent.codexRuntime) throw new Error('Native communication is unavailable outside an active Codex task');
                    return this.agent.codexRuntime.sendToBot(recipient, message);
                }),
            } : undefined,
            diagnostics: settings.agent_runtime === 'codex-session' ? {
                lastTask: () => this.agent.codexRuntime?.getLastTaskDiagnostics()
                    ?? { available: false, reason: 'native task diagnostic unavailable' },
            } : undefined,
            places: this.agent.places?.sdk,
        };
        const api = settings.agent_runtime === 'codex-session'
            ? (await import('./library/native_sdk.js')).createNativeSdk({ bot: this.agent.bot, ...bindings }, settings)
            : bindings;
        const endowments = Object.fromEntries(Object.entries(api).map(([namespace, sdk]) => [namespace, guarded(sdk, namespace)]));
        const compartment = makeCompartment({
            ...endowments,
            log: skills.log,
            Vec3,
        });
        const mainFn = compartment.evaluate(src);
        
        if (write_result) {
            console.error('Error writing code execution file: ' + write_result);
            return null;
        }
        return { func:{main: mainFn}, src_lint_copy: src_lint_copy, places: endowments.places };
    }

    _sanitizeCode(code) {
        code = code.trim();
        const remove_strs = ['Javascript', 'javascript', 'js']
        for (let r of remove_strs) {
            if (code.startsWith(r)) {
                code = code.slice(r.length);
                return code;
            }
        }
        return code;
    }

    _writeFilePromise(filename, src) {
        // makes it so we can await this function
        return new Promise((resolve, reject) => {
            writeFile(filename, src, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }
}

function configureGeneratedCodeFalseMode(skillLibrary, configuredNames = []) {
    if (!Array.isArray(configuredNames) || configuredNames.some(name => typeof name !== 'string')) {
        throw new Error('generated_code_fail_on_false must be an array of skill names');
    }
    const selected = new Set(configuredNames);
    if (selected.size === 0) return skillLibrary;
    return Object.fromEntries(Object.entries(skillLibrary).map(([name, skill]) => {
        if (!selected.has(name) || typeof skill !== 'function') return [name, skill];
        return [name, new Proxy(skill, { apply(target, thisArg, args) {
            const checkResult = value => {
                if (value === false) {
                    throw new Error(`skills.${name} returned false: action failed. Check the action output and inventory, then gather or craft missing prerequisites before retrying.`);
                }
                return value;
            };
            const result = Reflect.apply(target, thisArg, args);
            if (result && typeof result.then === 'function') return registerOwnedPromise(result.then(checkResult));
            return checkResult(result);
        } })];
    }));
}

function guardSdk(sdk, check, safety = null, namespace = '') {
    if (!sdk) return sdk;
    const captured = operationContext();
    return Object.fromEntries(Object.entries(sdk).map(([name, value]) =>
        [name, typeof value !== 'function' ? value : (...args) => {
            if (captured?.closed || captured?.signal.aborted) throw new Error('Action cancelled or settled');
            check?.();
            safety?.before();
            if (!safety) return value(...args);
            const method = `${namespace}.${name}`;
            try {
                const result = value(...args);
                if (result?.then) return registerOwnedPromise(result.then(
                    settled => safety.after(method, settled), error => { throw safety.fail(method, error); }));
                return safety.after(method, result);
            } catch (error) { throw safety.fail(method, error); }
        }]));
}

// Per generated operation, shared by all native SDK entries. A caught or
// unawaited failure cannot authorize another operation in this same body.
function nativeExecutionSafety(windowMs) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('Invalid codex_session.execution_window_ms');
    const owner = operationContext();
    const queries = new Set(['skills.inspectChestAt', 'places.find', 'places.inspect', 'places.verify', 'places.resolveAlias']);
    let deadline, failure, yielded;
    const fail = (method, error, result) => {
        failure ||= error;
        if (owner && !owner.sdkFailure) owner.sdkFailure = {
            method, error: String(error), ...(result !== undefined ? { result } : {}),
        };
        return failure;
    };
    return {
        start() {
            deadline = Date.now() + windowMs;
            if (owner) owner.nativeNavigationNoEdits = true;
        },
        before() {
            if (failure) throw failure;
            if (!yielded && Date.now() >= deadline) {
                yielded = new Error('SDK execution window reached');
                if (owner) {
                    owner.executionYield = { reason: 'execution-window', windowMs };
                    owner.executionYieldError = yielded;
                }
            }
            if (yielded) throw yielded;
        },
        after(method, result) {
            const action = !method.startsWith('world.') && !method.startsWith('diagnostics.') && !queries.has(method);
            const failed = action && (result === false || result?.ok === false)
                || method === 'skills.approachBlock' && result?.status !== 'ready'
                || method === 'skills.fellTree' && result?.status !== 'complete';
            if (failed) throw fail(method, new Error(`${method} failed: ${result === false ? "returned false" : result?.status ?? "ok:false"}`), result);
            return result;
        },
        fail,
        finish() { if (failure) throw failure; if (yielded) throw yielded; },
        isYield(error) { return !failure && error === yielded; },
    };
}
