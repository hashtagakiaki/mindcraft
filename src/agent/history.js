import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'fs';
import { NPCData } from './npc/data.js';
import settings from './settings.js';


export class History {
    constructor(agent) {
        this.agent = agent;
        this.name = agent.name;
        this.memory_fp = `./bots/${this.name}/memory.json`;
        this.full_history_fp = undefined;

        mkdirSync(`./bots/${this.name}/histories`, { recursive: true });

        this.turns = [];
        this.pendingHistoryChunks = [];
        this.summaryEpoch = 0;
        this.shutdownStarted = false;
        this.shutdownSavePromise = null;

        // Natural language memory as a summary of recent messages + previous memory
        this.memory = '';

        // Maximum number of messages to keep in context before saving chunk to memory
        this.max_messages = settings.max_messages;

        // Number of messages to remove from current history and save into memory
        this.summary_chunk_size = 5; 
        // chunking reduces expensive calls to promptMemSaving and appendFullHistory
        // and improves the quality of the memory summary
    }

    getHistory() { // expects an Examples object
        return JSON.parse(JSON.stringify(this.turns));
    }

    async summarizeMemories(turns) {
        const epoch = this.summaryEpoch;
        console.log("Storing memories...");
        let memory = await this.agent.prompter.promptMemSaving(turns);
        if (this.shutdownStarted || epoch !== this.summaryEpoch) return false;

        if (memory.length > 500) {
            memory = memory.slice(0, 500);
            memory += '...(Memory truncated to 500 chars. Compress it more next time)';
        }

        if (this.shutdownStarted || epoch !== this.summaryEpoch) return false;
        this.memory = memory;
        console.log("Memory updated to: ", this.memory);
        return true;
    }

    async appendFullHistory(to_store) {
        if (this.full_history_fp === undefined) {
            const string_timestamp = new Date().toLocaleString().replace(/[/:]/g, '-').replace(/ /g, '').replace(/,/g, '_');
            this.full_history_fp = `./bots/${this.name}/histories/${string_timestamp}.json`;
            writeFileSync(this.full_history_fp, '[]', 'utf8');
        }
        try {
            const data = readFileSync(this.full_history_fp, 'utf8');
            let full_history = JSON.parse(data);
            full_history.push(...to_store);
            writeFileSync(this.full_history_fp, JSON.stringify(full_history, null, 4), 'utf8');
        } catch (err) {
            console.error(`Error reading ${this.name}'s full history file: ${err.message}`);
        }
    }

    async add(name, content) {
        if (this.shutdownStarted) return false;
        let role = 'assistant';
        if (name === 'system') {
            role = 'system';
        }
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        this.turns.push({role, content});

        if (this.turns.length >= this.max_messages) {
            let chunk = this.turns.splice(0, this.summary_chunk_size);
            while (this.turns.length > 0 && this.turns[0].role === 'assistant')
                chunk.push(this.turns.shift()); // remove until turns starts with system/user message

            this.pendingHistoryChunks.push(chunk);
            const epoch = this.summaryEpoch;
            let summarized;
            try { summarized = await this.summarizeMemories(chunk); }
            catch (error) {
                if (this.shutdownStarted || epoch !== this.summaryEpoch) return false;
                throw error;
            }
            if (!summarized || this.shutdownStarted) return false;
            await this.appendFullHistory(chunk);
            this.pendingHistoryChunks = this.pendingHistoryChunks.filter(pending => pending !== chunk);
        }
        return true;
    }

    beginShutdown() {
        if (this.shutdownStarted) return this.summaryEpoch;
        this.shutdownStarted = true;
        this.summaryEpoch += 1;
        return this.summaryEpoch;
    }

    async saveShutdownRecord(reason, outcome = {}) {
        if (this.shutdownSavePromise) return this.shutdownSavePromise;
        this.beginShutdown();
        this.shutdownSavePromise = (async () => {
            const pending = this.pendingHistoryChunks.flat();
            this.pendingHistoryChunks = [];
            this.turns = [...pending, ...this.turns];
            const detail = typeof outcome === 'string' ? outcome : JSON.stringify(outcome);
            this.turns.push({ role: 'system', content: `Agent shutdown (${reason || 'unspecified'}). Final outcome: ${detail}. Natural language shutdown summary skipped.` });
            try {
                await this.save({ final: true });
                return { saved: true, memoryPath: this.memory_fp };
            } catch (error) {
                return { saved: false, memoryPath: this.memory_fp, error: error.message };
            }
        })();
        return this.shutdownSavePromise;
    }

    async save(options = {}) {
        if (this.shutdownStarted && options.final !== true) return { saved: false, skipped: 'shutdown in progress' };
        try {
            const data = {
                memory: this.memory,
                turns: this.turns,
                self_prompting_state: this.agent.self_prompter?.state ?? null,
                self_prompt: !this.agent.self_prompter || this.agent.self_prompter.isStopped() ? null : this.agent.self_prompter.prompt,
                taskStart: this.agent.task?.taskStartTime ?? null,
                last_sender: this.agent.last_sender
            };
            const temporaryPath = `${this.memory_fp}.tmp-${process.pid}-${this.summaryEpoch}`;
            try {
                writeFileSync(temporaryPath, JSON.stringify(data, null, 2));
                renameSync(temporaryPath, this.memory_fp);
            } catch (error) {
                try { unlinkSync(temporaryPath); } catch {}
                throw error;
            }
            console.log('Saved memory to:', this.memory_fp);
            return { saved: true, memoryPath: this.memory_fp };
        } catch (error) {
            console.error('Failed to save history:', error);
            throw error;
        }
    }

    load() {
        try {
            if (!existsSync(this.memory_fp)) {
                console.log('No memory file found.');
                return null;
            }
            const data = JSON.parse(readFileSync(this.memory_fp, 'utf8'));
            this.memory = data.memory || '';
            this.turns = data.turns || [];
            console.log('Loaded memory:', this.memory);
            return data;
        } catch (error) {
            console.error('Failed to load history:', error);
            throw error;
        }
    }

    clear() {
        this.turns = [];
        this.memory = '';
    }
}
