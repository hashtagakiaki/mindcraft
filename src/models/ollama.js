import { strictFormat } from '../utils/text.js';
import { randomUUID } from 'node:crypto';

const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

export class Ollama {
    static prefix = 'ollama';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.url = url || 'http://127.0.0.1:11434';
        this.chat_endpoint = '/api/chat';
        this.embedding_endpoint = '/api/embeddings';
        const configuredTimeout = Number(params?.request_timeout_ms);
        this.requestTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
            ? configuredTimeout : DEFAULT_REQUEST_TIMEOUT_MS;
        this.params = { ...(params || {}) };
        delete this.params.request_timeout_ms;
    }

    async sendRequest(turns, systemMessage, stop_seq = '***', options = {}) {
        if (stop_seq && typeof stop_seq === 'object') {
            options = stop_seq;
        }
        let model = this.model_name || 'sweaterdog/andy-4:micro-q8_0';
        let messages = strictFormat(turns);
        messages.unshift({ role: 'system', content: systemMessage });
        if (Array.isArray(options.imagePayloads) && options.imagePayloads.length) {
            let imageMessage = null;
            for (let index = messages.length - 1; index >= 0; index--) {
                if (messages[index].role === 'user') { imageMessage = messages[index]; break; }
            }
            if (!imageMessage) {
                imageMessage = { role: 'user', content: '' };
                messages.push(imageMessage);
            }
            imageMessage.images = [...options.imagePayloads];
        }
        const maxAttempts = 5;
        let attempt = 0;
        let finalRes = null;
        const requestId = options.requestId || randomUUID();
        const startedAt = Date.now();

        while (attempt < maxAttempts) {
            attempt++;
            if (options.signal?.aborted) throw abortError(options.signal.reason);
            console.log(`Awaiting local response... (model: ${model}, attempt: ${attempt})`);
            let res = null;
            try {
                let apiResponse = await this.send(this.chat_endpoint, {
                    model: model,
                    messages: messages,
                    stream: false,
                    ...(this.params || {})
                }, { signal: options.signal });
                if (typeof apiResponse?.error === 'string' && apiResponse.error.length) throw new Error(`Ollama: ${apiResponse.error}`);
                if (typeof apiResponse?.message?.content !== 'string') throw new Error('Ollama response did not contain message.content');
                res = apiResponse.message.content;
                if (options.signal?.aborted) throw abortError(options.signal.reason);
                const usage = {};
                if (Number.isFinite(apiResponse.prompt_eval_count)) usage.promptTokens = apiResponse.prompt_eval_count;
                if (Number.isFinite(apiResponse.eval_count)) usage.completionTokens = apiResponse.eval_count;
                if (Object.keys(usage).length && typeof options.onUsage === 'function') {
                    try { options.onUsage({ requestId, attempt, provider: 'ollama', purpose: options.purpose ?? null,
                        taskId: options.taskId ?? null, actionId: options.actionId ?? null, usage,
                        elapsedMs: Date.now() - startedAt }); }
                    catch (error) { console.warn('Could not record Ollama usage diagnostic:', error); }
                }
            } catch (err) {
                if (String(err?.message || err).toLowerCase().includes('context length') && turns.length > 1) {
                    console.log('Context length exceeded, trying again with shorter context.');
                    return await this.sendRequest(turns.slice(1), systemMessage, options);
                } else {
                    throw err;
                }
            }

            const hasOpenTag = res.includes("<think>");
            const hasCloseTag = res.includes("</think>");

            if ((hasOpenTag && !hasCloseTag)) {
                console.warn("Partial <think> block detected. Re-generating...");
                if (attempt < maxAttempts) continue;
                throw new Error('Ollama returned an incomplete <think> block after maximum attempts');
            }
            if (hasCloseTag && !hasOpenTag) {
                res = '<think>' + res;
            }
            if (hasOpenTag && hasCloseTag) {
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            }
            finalRes = res;
            break;
        }

        if (finalRes == null) {
            throw new Error('Ollama could not produce a valid response after maximum attempts');
        }
        return finalRes;
    }

    async embed(text) {
        let model = this.model_name || 'embeddinggemma';
        let body = { model: model, input: text };
        let res = await this.send(this.embedding_endpoint, body);
        return res['embedding'];
    }

    async send(endpoint, body, { signal = null } = {}) {
        const url = new URL(endpoint, this.url);
        let method = 'POST';
        let headers = new Headers();
        const requestController = new AbortController();
        let timedOut = false;
        const onAbort = () => requestController.abort(signal.reason || abortError());
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        const timeout = setTimeout(() => {
            timedOut = true;
            requestController.abort(new Error(`Ollama request timed out after ${this.requestTimeoutMs}ms`));
        }, this.requestTimeoutMs);
        try {
            const request = new Request(url, { method, headers, body: JSON.stringify(body), signal: requestController.signal });
            const res = await fetch(request);
            if (!res.ok) throw new Error(`Ollama Status: ${res.status}`);
            const data = await res.json();
            if (timedOut) throw requestTimeoutError(this.requestTimeoutMs);
            if (requestController.signal.aborted) throw abortError(signal?.reason || requestController.signal.reason);
            return data;
        } catch (err) {
            if (timedOut) {
                throw requestTimeoutError(this.requestTimeoutMs);
            }
            if (signal?.aborted || requestController.signal.aborted) throw abortError(signal?.reason || requestController.signal.reason);
            throw err;
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
        }
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer, options = {}) {
        return this.sendRequest(messages, systemMessage, { ...options,
            imagePayloads: imageBuffer ? [imageBuffer.toString('base64')] : [] });
    }
}

function requestTimeoutError(timeoutMs) {
    const error = new Error(`Ollama request timed out after ${timeoutMs}ms`);
    error.name = 'TimeoutError';
    error.code = 'OLLAMA_REQUEST_TIMEOUT';
    return error;
}

function abortError(reason = 'Ollama request cancelled') {
    if (reason instanceof Error) return reason;
    const error = new Error(String(reason || 'Ollama request cancelled'));
    error.name = 'AbortError';
    return error;
}
