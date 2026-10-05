import { writeFile, readFile, mkdirSync } from 'fs';
import { makeCompartment, lockdown } from './library/lockdown.js';
import * as skills from './library/skills.js';
import * as world from './library/world.js';
import settings from './settings.js';
import { Vec3 } from 'vec3';
import {ESLint} from "eslint";
import { trackSkill, operationContext, registerOwnedPromise } from './library/operation_context.js';

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
        this.agent.bot.modes.pause('unstuck');
        try {
            lockdown();
            check();
            this.agent.actions.setPhase('staging', context?.actionId);
            const staged = await this._stageCode(code, check);
            check();
            this.agent.actions.setPhase('linting', context?.actionId);
            if (!staged) throw new Error('Could not stage code');
            const error = await this._lintCode(staged.src_lint_copy);
            check();
            if (error) throw new Error(error);
            this.agent.actions.setPhase('executing', context?.actionId);
            await trackSkill('generated_code', () => staged.func.main(this.agent.bot, guardSdk(this.agent.places?.sdk, check)))();
            check();
        } finally { this.agent.bot.modes.unpause('unstuck'); }
    }

    async generateCode(agent_history) {
        const context = this.agent.actions.getCancellationContext?.() || null;
        const actionId = context?.actionId;
        const isCancelled = () => !!context?.signal?.aborted || this.agent.bot.interrupt_code;
        const setPhase = phase => {
            if (context) this.agent.actions.setPhase(phase, actionId);
        };
        let pausedUnstuck = false;

        try {
            this.agent.bot.modes.pause('unstuck');
            pausedUnstuck = true;
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
        } finally {
            if (pausedUnstuck) this.agent.bot.modes.unpause('unstuck');
        }
    }
    
    async  _lintCode(code) {
        let result = '#### CODE ERROR INFO ###\n';
        const codeNoComments = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const skillRegex = /((?:skills|world|places|vision)\.(.*?))\(/g;
        const skills = [];
        let match;
        while ((match = skillRegex.exec(codeNoComments)) !== null) {
            skills.push(match[1]);
        }
        const allDocs = await this.agent.prompter.skill_libary.getAllSkillDocs();
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
    async _stageCode(code, check = null) {
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
        const guarded = sdk => guardSdk(sdk, check);
        const compartment = makeCompartment({
            skills: guarded(configureGeneratedCodeFalseMode(skills, settings.generated_code_fail_on_false)),
            log: skills.log,
            world: guarded(world),
            vision: guarded({
                lookAtPlayer: trackSkill('vision.lookAtPlayer', (playerName, direction) => this.agent.vision_interpreter.lookAtPlayer(playerName, direction)),
                lookAtPosition: trackSkill('vision.lookAtPosition', (x, y, z) => this.agent.vision_interpreter.lookAtPosition(x, y, z)),
            }),
            places: guarded(this.agent.places?.sdk),
            Vec3,
        });
        const mainFn = compartment.evaluate(src);
        
        if (write_result) {
            console.error('Error writing code execution file: ' + write_result);
            return null;
        }
        return { func:{main: mainFn}, src_lint_copy: src_lint_copy };
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

function guardSdk(sdk, check) {
    if (!sdk) return sdk;
    const captured = operationContext();
    return Object.fromEntries(Object.entries(sdk).map(([name, value]) =>
        [name, typeof value !== 'function' ? value : (...args) => {
            if (captured?.closed || captured?.signal.aborted) throw new Error('Action cancelled or settled');
            check?.();
            return value(...args);
        }]));
}
