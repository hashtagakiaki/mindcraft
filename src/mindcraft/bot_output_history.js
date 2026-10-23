import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import path from 'path';
import { withDiagnosticQuotaLock } from '../agent/diagnostics_store.js';

const MAX_ENTRIES = 200;
const MAX_FILES = 250;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 16 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
const MAX_DIAGNOSTICS_READ_BYTES = 64 * 1024 * 1024;

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

function readDiagnosticsHistory(root, names) {
    if (existsSync(root)) {
        const rootStat = lstatSync(root);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(root) !== root)
            throw new Error(`Diagnostics root is unsafe: ${root}`);
    }
    const manifestPath = path.join(root, 'manifest.json');
    if (!existsSync(manifestPath)) {
        if (existsSync(path.join(root, 'stream', 'segments')))
            throw new Error(`Diagnostics root manifest is missing: ${manifestPath}`);
        return null;
    }
    return withDiagnosticQuotaLock(root, () => {
        const rootStat = lstatSync(root);
        const manifestStat = lstatSync(manifestPath);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
            || !manifestStat.isFile() || manifestStat.isSymbolicLink())
            throw new Error(`Diagnostics root is unsafe: ${root}`);
        let owner;
        try { owner = JSON.parse(readFileSync(manifestPath, 'utf8')); }
        catch (error) { throw new Error(`Diagnostics root manifest is invalid: ${manifestPath}`, { cause: error }); }
        if (owner.schemaVersion !== 1 || owner.owner !== 'mindcraft')
            throw new Error(`Diagnostics root manifest is unsupported: ${manifestPath}`);
        const segmentDir = path.join(root, 'stream', 'segments');
        let versionState = null;
        const versionStatePath = path.join(root, 'version-state.json');
        if (existsSync(versionStatePath)) {
            const stateStat = lstatSync(versionStatePath);
            if (!stateStat.isFile() || stateStat.isSymbolicLink())
                throw new Error(`Diagnostics version state is unsafe: ${versionStatePath}`);
            try { versionState = JSON.parse(readFileSync(versionStatePath, 'utf8')); }
            catch (error) { throw new Error(`Diagnostics version state is invalid: ${versionStatePath}`, { cause: error }); }
            if (versionState.schemaVersion !== 1 || versionState.owner !== 'mindcraft-tools'
                || !/^bundle-[a-f0-9]{32}$/i.test(versionState.currentBundleId ?? '')
                || (versionState.previousBundleId !== null
                    && !/^bundle-[a-f0-9]{32}$/i.test(versionState.previousBundleId ?? '')))
                throw new Error(`Diagnostics version state is unsupported: ${versionStatePath}`);
        }
        if (!existsSync(segmentDir)) return { records: [], versionState };
        const segmentStat = lstatSync(segmentDir);
        if (!segmentStat.isDirectory() || segmentStat.isSymbolicLink()
            || realpathSync(segmentDir) !== segmentDir)
            throw new Error(`Diagnostics segment directory is unsafe: ${segmentDir}`);
        const files = readdirSync(segmentDir).filter(name => name.endsWith('.jsonl')).sort().reverse();
        if (files.length > MAX_FILES) throw new Error(`Diagnostics segment count exceeds reader limit: ${files.length}`);
        const records = [];
        let readBytes = 0;
        for (const name of files) {
            const filePath = path.join(segmentDir, name);
            const manifestFile = `${filePath}.manifest.json`;
            const fileStat = lstatSync(filePath);
            const metadataStat = lstatSync(manifestFile);
            if (!fileStat.isFile() || fileStat.isSymbolicLink()
                || !metadataStat.isFile() || metadataStat.isSymbolicLink())
                throw new Error(`Diagnostics segment is unsafe: ${filePath}`);
            let metadata;
            try { metadata = JSON.parse(readFileSync(manifestFile, 'utf8')); }
            catch (error) { throw new Error(`Diagnostics segment manifest is invalid: ${manifestFile}`, { cause: error }); }
            if (metadata.schemaVersion !== 1 || metadata.owner !== 'mindcraft' || metadata.pool !== 'stream'
                || metadata.file !== name || metadata.device !== fileStat.dev || metadata.inode !== fileStat.ino
                || typeof metadata.closed !== 'boolean')
                throw new Error(`Diagnostics segment manifest does not match its file: ${manifestFile}`);
            const file = statSync(filePath);
            if (file.size > MAX_SEGMENT_BYTES)
                throw new Error(`Diagnostics segment exceeds reader limit: ${filePath}`);
            if (readBytes + file.size > MAX_DIAGNOSTICS_READ_BYTES) continue;
            readBytes += file.size;
            const lines = readFileSync(filePath, 'utf8').split('\n');
            for (let index = 0; index < lines.length; index++) {
                let event;
                try { event = JSON.parse(lines[index]); }
                catch { continue; }
                if (!names.includes(event?.bot) || typeof event?.at !== 'string'
                    || !Number.isFinite(Date.parse(event.at)) || !event.detail || typeof event.detail !== 'object') continue;
                const taskId = typeof event.taskId === 'string' ? event.taskId : null;
                if (event.type === 'response_reported' && typeof event.detail.response === 'string') {
                    records.push({ kind: 'reported', at: event.detail.reportedAt ?? event.at,
                        agentName: event.bot, message: event.detail.response,
                        id: taskId ? `${event.bot}:${taskId}:reported` : `${filePath}:${index + 1}` });
                } else if (event.type === 'finished' && event.detail.status === 'error'
                    && typeof event.detail.error === 'string') {
                    records.push({ kind: 'error', at: event.at, agentName: event.bot,
                        message: `Codex task failed: ${event.detail.error}`,
                        id: taskId ? `${event.bot}:${taskId}:error` : `${filePath}:${index + 1}` });
                }
            }
        }
        return { records, versionState };
    });
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
    const diagnosticsRoot = path.join(path.dirname(bundlesRoot), 'diagnostics');
    const diagnosticHistory = readDiagnosticsHistory(diagnosticsRoot, names);
    const versionState = diagnosticHistory?.versionState;
    const eligibleBundleIds = versionState
        ? new Set([versionState.currentBundleId, versionState.previousBundleId].filter(Boolean)) : null;
    for (const bundleDir of bundleDirs) {
        if (eligibleBundleIds && !eligibleBundleIds.has(path.basename(bundleDir))) continue;
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
    for (const result of diagnosticHistory?.records ?? []) {
        if (ids.has(result.id)) continue;
        ids.add(result.id);
        const { kind, ...entry } = result;
        results.push(entry);
    }
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
