import { readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import path from 'path';

const MAX_ENTRIES = 200;
const MAX_FILES = 250;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 16 * 1024 * 1024;

function safeBotName(name) {
    return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..'
        && path.basename(name) === name && !name.includes('\\') && !name.includes('/');
}

function readHistoryRecord(line, agentName, filePath, lineNumber) {
    let event;
    try { event = JSON.parse(line); }
    catch { return null; }
    if (!event || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) return null;
    if (event.type === 'model_message' && typeof event.text === 'string') {
        return { kind: 'model', at: event.at, agentName, message: event.text,
            id: event.taskId ? `${agentName}:${event.taskId}:message:${lineNumber}` : `${filePath}:${lineNumber}` };
    }
    if (event.type === 'response_reported' && typeof event.response === 'string') {
        return { kind: 'reported', at: event.at, agentName, message: event.response,
            id: event.taskId ? `${agentName}:${event.taskId}:reported` : `${filePath}:${lineNumber}` };
    }
    if (event.type === 'finished' && event.status === 'completed' && typeof event.response === 'string') {
        return { kind: 'completed', at: event.at, agentName, message: event.response,
            id: event.taskId ? `${agentName}:${event.taskId}:completed` : `${filePath}:${lineNumber}` };
    }
    if (event.type === 'finished' && event.status === 'error' && typeof event.error === 'string') {
        return { kind: 'error', at: event.at, agentName, message: `Codex task failed: ${event.error}`,
            id: event.taskId ? `${agentName}:${event.taskId}:error` : `${filePath}:${lineNumber}` };
    }
    return null;
}

export function readBotOutputHistory(runtimeDirectory, agentNames, limit = MAX_ENTRIES) {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_ENTRIES) : MAX_ENTRIES;
    const names = [...new Set((Array.isArray(agentNames) ? agentNames : []).filter(safeBotName))];
    if (!names.length) return [];

    let runtime;
    try { runtime = realpathSync(runtimeDirectory); }
    catch { return []; }
    const activeBundle = path.dirname(runtime);
    const bundlesRoot = path.dirname(activeBundle);
    if (path.basename(runtime) !== 'runtime' || !/^bundle-[a-f0-9]{32}$/i.test(path.basename(activeBundle))
        || path.basename(bundlesRoot) !== 'mindcraft-bundles') return [];

    let bundleDirs;
    try {
        bundleDirs = readdirSync(bundlesRoot, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && /^bundle-[a-f0-9]{32}$/i.test(entry.name))
            .map(entry => path.join(bundlesRoot, entry.name));
    } catch { return []; }

    const files = [];
    for (const bundleDir of bundleDirs) {
        for (const agentName of names) {
            const historyDir = path.join(bundleDir, 'runtime', 'bots', agentName, 'histories');
            let entries;
            try { entries = readdirSync(historyDir, { withFileTypes: true }); }
            catch { continue; }
            for (const entry of entries) {
                if (!entry.isFile() || !/^codex-[a-f0-9-]+\.jsonl$/i.test(entry.name)) continue;
                const filePath = path.join(historyDir, entry.name);
                try {
                    const stat = statSync(filePath);
                    if (stat.isFile() && stat.size > 0 && stat.size <= MAX_FILE_BYTES)
                        files.push({ filePath, agentName, mtimeMs: stat.mtimeMs, size: stat.size });
                } catch {}
            }
        }
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const results = [];
    const ids = new Set();
    let readBytes = 0;
    for (const file of files.slice(0, MAX_FILES)) {
        if (readBytes + file.size > MAX_READ_BYTES) continue;
        let content;
        try { content = readFileSync(file.filePath, 'utf8'); }
        catch { continue; }
        readBytes += file.size;
        let lineNumber = 0;
        const fileRecords = [];
        for (const line of content.split('\n')) {
            lineNumber++;
            const result = readHistoryRecord(line, file.agentName, file.filePath, lineNumber);
            if (result) fileRecords.push(result);
        }
        const modelMessages = fileRecords.filter(record => record.kind === 'model');
        const reported = fileRecords.filter(record => record.kind === 'reported');
        const completed = fileRecords.filter(record => record.kind === 'completed');
        const errors = fileRecords.filter(record => record.kind === 'error');
        const chosen = [...(modelMessages.length ? modelMessages : reported.length ? reported : completed), ...errors];
        for (const result of chosen) {
            if (ids.has(result.id)) continue;
            ids.add(result.id);
            const { kind, ...entry } = result;
            results.push(entry);
        }
    }
    results.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return results.slice(-safeLimit);
}
