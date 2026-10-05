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
        this.summaryDrainPromise = null;
        this.summaryDiagnostic = null;
        this.persistSummaryChunks = new WeakSet();
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

    async summarizeMemories(turns, epoch = this.summaryEpoch) {
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
        this._appendTurn(name, content);

        if (this.turns.length >= this.max_messages) {
            const epoch = this.summaryEpoch;
            this._queueSummaryChunk(this._takeSummaryChunk());
            let summarized;
            try { summarized = await this._ensureSummaryDrain(); }
            catch (error) {
                if (this.shutdownStarted || epoch !== this.summaryEpoch) return false;
                throw error;
            }
            if (!summarized || this.shutdownStarted) return false;
        }
        return true;
    }

    async checkpointAdd(name, content) {
        if (this.shutdownStarted) return { saved: false, skipped: 'shutdown in progress' };
        this._appendTurn(name, content);
        const saveResult = await this.save();
        if (!saveResult.saved) return saveResult;
        if (this.turns.length >= this.max_messages) {
            this._queueSummaryChunk(this._takeSummaryChunk(), { persistAfter: true });
            void this._ensureSummaryDrain().catch(error => {
                this.summaryDiagnostic = String(error);
                console.error(`Memory summary failed for ${this.name}:`, error);
            });
        }
        return saveResult;
    }

    _appendTurn(name, content) {
        let role = 'assistant';
        if (name === 'system') role = 'system';
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        this.turns.push({ role, content });
    }

    _takeSummaryChunk() {
        const chunk = this.turns.splice(0, this.summary_chunk_size);
        while (this.turns.length > 0 && this.turns[0].role === 'assistant')
            chunk.push(this.turns.shift());
        return chunk;
    }

    _queueSummaryChunk(chunk, { persistAfter = false } = {}) {
        if (!chunk?.length) return;
        if (persistAfter) this.persistSummaryChunks.add(chunk);
        this.pendingHistoryChunks.push(chunk);
    }

    _ensureSummaryDrain() {
        if (this.summaryDrainPromise) return this.summaryDrainPromise;
        const drain = this._drainSummaryQueue();
        this.summaryDrainPromise = drain;
        drain.then(result => {
            if (this.summaryDrainPromise === drain) this.summaryDrainPromise = null;
            if (result === false && !this.shutdownStarted && this.pendingHistoryChunks.length)
                void this._ensureSummaryDrain().catch(error => {
                    this.summaryDiagnostic = String(error);
                    console.error(`Memory summary failed for ${this.name}:`, error);
                });
        }, error => {
            if (this.summaryDrainPromise === drain) this.summaryDrainPromise = null;
            this.summaryDiagnostic = String(error);
        });
        return drain;
    }

    async _drainSummaryQueue() {
        while (this.pendingHistoryChunks.length && !this.shutdownStarted) {
            const chunk = this.pendingHistoryChunks[0];
            const epoch = this.summaryEpoch;
            const summarized = await this.summarizeMemories(chunk, epoch);
            if (!summarized || this.shutdownStarted || epoch !== this.summaryEpoch) return false;
            await this.appendFullHistory(chunk);
            if (this.shutdownStarted || epoch !== this.summaryEpoch) return false;
            const persistAfter = this.persistSummaryChunks.has(chunk);
            if (this.pendingHistoryChunks[0] === chunk) this.pendingHistoryChunks.shift();
            if (persistAfter) {
                const saveResult = await this.save();
                if (!saveResult.saved && !this.shutdownStarted) throw new Error('Could not persist summarized memory state');
            }
        }
        return true;
    }

    invalidateSummaries() {
        if (this.shutdownStarted) return this.summaryEpoch;
        this.summaryEpoch += 1;
        if (this.pendingHistoryChunks.length) {
            this.turns = [...this.pendingHistoryChunks.flat(), ...this.turns];
            this.pendingHistoryChunks = [];
        }
        return this.summaryEpoch;
    }

    beginShutdown() {
        if (this.shutdownStarted) return this.summaryEpoch;
        this.shutdownStarted = true;
        this.summaryEpoch += 1;
        this.turns = [...this.pendingHistoryChunks.flat(), ...this.turns];
        this.pendingHistoryChunks = [];
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
                turns: [...this.pendingHistoryChunks.flat(), ...this.turns],
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
