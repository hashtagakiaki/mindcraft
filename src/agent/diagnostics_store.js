import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, statfsSync, writeSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const SEGMENT_BYTES = 16 * 1024 * 1024;
const SEGMENT_MS = 60 * 60 * 1000;
const RESERVATION_OVERHEAD_BYTES = 4096;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_DEPTH = 6;
const SECRET_KEY = /(?:auth|token|secret|password|cookie|credential|api.?key|environment|env)/i;
const SENSITIVE_TEXT = /(bearer\s+)[A-Za-z0-9._~+/-]+=*|((?:auth|token|secret|password|cookie|credential|api[_-]?key|access[_-]?token)\s*[:=]\s*)[^\s,;]+/ig;

function redact(value, depth = 0, seen = new WeakSet()) {
    if (depth > MAX_DEPTH) return '[truncated:depth]';
    if (typeof value === 'string') return (/^data:image\//i.test(value) ? '[image omitted]'
        : value.replace(SENSITIVE_TEXT, '$1[redacted]').replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-jwt]'));
    if (value && typeof value === 'object') {
        if (seen.has(value)) return '[truncated:circular]';
        seen.add(value);
        if (Array.isArray(value)) return value.slice(0, 128).map(item => redact(item, depth + 1, seen));
        const output = {};
        for (const [key, item] of Object.entries(value).slice(0, 128)) {
            if (SECRET_KEY.test(key)) output[key] = '[redacted]';
            else if (typeof item === 'string' && /^data:image\//i.test(item)) output[key] = '[image omitted]';
            else output[key] = redact(item, depth + 1, seen);
        }
        return output;
    }
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return value;
}

function processStartTicks(pid) {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        return fields[19] ?? null;
    } catch { return null; }
}

function lock(root, timeoutMs = 500) {
    const file = path.join(root, '.quota.lock');
    const until = Date.now() + timeoutMs;
    while (true) {
        try {
            const fd = openSync(file, 'wx', 0o600);
            writeSync(fd, JSON.stringify({ pid: process.pid, startTicks: processStartTicks(process.pid), at: Date.now() }));
            return () => { closeSync(fd); try { unlinkSync(file); } catch {} };
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            try {
                const current = JSON.parse(readFileSync(file, 'utf8'));
                const actual = processStartTicks(Number(current.pid));
                if (!actual || actual !== current.startTicks) unlinkSync(file);
            } catch (readError) {
                if (readError.code === 'ENOENT') continue;
                try { if (Date.now() - statSync(file).mtimeMs > 30_000) unlinkSync(file); } catch {}
            }
            if (Date.now() >= until) throw new Error(`diagnostics quota lock is busy: ${file}`);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
    }
}

function segmentFiles(poolRoot) {
    const dir = path.join(poolRoot, 'segments');
    if (!existsSync(dir)) return [];
    if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error(`diagnostics segment directory is unsafe: ${dir}`);
    return readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => {
        const file = path.join(dir, name);
        const manifest = `${file}.manifest.json`;
        const linkStat = lstatSync(file);
        if (linkStat.isSymbolicLink() || !linkStat.isFile()) throw new Error(`diagnostics segment is not a regular file: ${file}`);
        const stat = statSync(file);
        let meta = null;
        try { meta = JSON.parse(readFileSync(manifest, 'utf8')); } catch {}
        let manifestBytes = 0;
        if (existsSync(manifest)) {
            const manifestStat = lstatSync(manifest);
            if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) throw new Error(`diagnostics segment manifest is not a regular file: ${manifest}`);
            manifestBytes = manifestStat.size;
        }
        return { file, manifest, bytes: stat.size + manifestBytes, meta };
    });
}

function discoverDiagnosticsRoots(ownerRoot) {
    const roots = [];
    const pending = [{ dir: path.resolve(ownerRoot), depth: 0 }];
    while (pending.length) {
        const { dir, depth } = pending.pop();
        if (!existsSync(dir)) continue;
        const dirStat = lstatSync(dir);
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;
        const manifestPath = path.join(dir, 'manifest.json');
        if (existsSync(manifestPath)) {
            const manifestStat = lstatSync(manifestPath);
            if (manifestStat.isFile() && !manifestStat.isSymbolicLink()) {
                try {
                    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
                    if (manifest.schemaVersion === 1 && manifest.owner === 'mindcraft') roots.push(dir);
                } catch {}
            }
        }
        if (depth >= 6) continue;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        }
    }
    return [...new Set(roots)];
}

function ownerSegmentFiles(ownerRoot, pool) {
    const files = [];
    for (const root of discoverDiagnosticsRoots(ownerRoot)) files.push(...segmentFiles(path.join(root, pool)));
    return files;
}

function writeManifest(file, value) {
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(temp, 'wx', 0o600);
    try { writeSync(fd, JSON.stringify(value) + '\n'); } finally { closeSync(fd); }
    // A temp is created in the same directory so rename is atomic on the same filesystem.
    const fs = requireFs();
    fs.renameSync(temp, file);
}

function requireFs() { return fsModule; }
import * as fsModule from 'node:fs';

const PROCESS_MONOTONIC_ORIGIN = process.hrtime.bigint();

export class DiagnosticQuotaError extends Error {
    constructor(message, pool) { super(message); this.name = 'DiagnosticQuotaError'; this.pool = pool; }
}

export function diagnosticsFreeSpace(root) {
    const space = statfsSync(path.resolve(root));
    return Number(space.bavail) * Number(space.bsize);
}

export function checkDiagnosticsSpace(root, { warningBytes = 0, rejectBytes = 0 } = {}) {
    if (!Number.isSafeInteger(warningBytes) || warningBytes < 0
        || !Number.isSafeInteger(rejectBytes) || rejectBytes < 0
        || (warningBytes && rejectBytes && rejectBytes > warningBytes)) {
        throw new TypeError('diagnostics free-space thresholds must be non-negative integers with reject <= warning');
    }
    const freeBytes = diagnosticsFreeSpace(root);
    return { freeBytes, warning: warningBytes > 0 && freeBytes < warningBytes,
        rejected: rejectBytes > 0 && freeBytes < rejectBytes };
}

/** Bounded synchronous JSONL writer. Callers pass only diagnostic event fields, never raw env/process objects. */
export class DiagnosticWriter {
    constructor({ root, pool, limitBytes, ownerRoot = root, ownerLimitBytes = limitBytes,
        runLimitBytes = limitBytes, identity = {}, clock = () => Date.now(), segmentBytes = SEGMENT_BYTES,
        segmentMs = SEGMENT_MS, processRunId = randomUUID() }) {
        if (!path.isAbsolute(root)) throw new TypeError('diagnostics root must be absolute');
        if (!['stream', 'incident', 'console', 'maintenance'].includes(pool)) throw new TypeError(`unknown diagnostics pool: ${pool}`);
        if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) throw new TypeError('diagnostics limitBytes must be a positive safe integer');
        this.root = path.resolve(root);
        this.ownerRoot = path.resolve(ownerRoot);
        this.ownerLimitBytes = ownerLimitBytes;
        this.runLimitBytes = runLimitBytes;
        if (!Number.isSafeInteger(ownerLimitBytes) || ownerLimitBytes <= 0
            || !Number.isSafeInteger(runLimitBytes) || runLimitBytes <= 0) throw new TypeError('diagnostics owner/run limits must be positive safe integers');
        if (existsSync(this.root) && realpathSync(this.root) !== this.root)
            throw new Error(`diagnostics root must not traverse symlinks: ${this.root}`);
        this.pool = pool;
        this.poolRoot = path.join(this.root, pool);
        this.limitBytes = limitBytes;
        this.identity = redact(identity);
        this.clock = clock;
        this.segmentBytes = Math.min(segmentBytes, SEGMENT_BYTES);
        this.segmentMs = segmentMs;
        this.processRunId = processRunId;
        this.sequence = 0;
        this.current = null;
        this.closed = false;
        mkdirSync(this.root, { recursive: true, mode: 0o700 });
        if (lstatSync(this.root).isSymbolicLink() || realpathSync(this.root) !== this.root)
            throw new Error(`diagnostics root must not traverse symlinks: ${this.root}`);
        mkdirSync(this.ownerRoot, { recursive: true, mode: 0o700 });
        if (lstatSync(this.ownerRoot).isSymbolicLink() || realpathSync(this.ownerRoot) !== this.ownerRoot)
            throw new Error(`diagnostics owner root must not traverse symlinks: ${this.ownerRoot}`);
        const release = lock(this.ownerRoot);
        try {
            const manifestPath = path.join(this.root, 'manifest.json');
            if (existsSync(manifestPath)) {
                const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
                if (manifest.schemaVersion !== 1 || manifest.owner !== 'mindcraft')
                    throw new Error(`unsupported diagnostics root manifest: ${manifestPath}`);
            } else {
                writeManifest(manifestPath, { schemaVersion: 1, owner: 'mindcraft', createdAt: new Date(this.clock()).toISOString() });
            }
        } finally { release(); }
        mkdirSync(this.poolRoot, { recursive: true, mode: 0o700 });
        if (lstatSync(this.poolRoot).isSymbolicLink() || realpathSync(this.poolRoot) !== this.poolRoot)
            throw new Error(`diagnostics pool path is unsafe: ${this.poolRoot}`);
        mkdirSync(path.join(this.poolRoot, 'segments'), { recursive: true, mode: 0o700 });
    }

    _newSegment(now, versionId = this.identity.versionId ?? null) {
        const name = `${now}-${this.processRunId}-${randomUUID()}.jsonl`;
        const file = path.join(this.poolRoot, 'segments', name);
        const fd = openSync(file, 'wx', 0o600);
        const fileStat = statSync(file);
        const manifest = `${file}.manifest.json`;
        const meta = { schemaVersion: 1, owner: 'mindcraft', pool: this.pool, file: name,
            processRunId: this.processRunId, pid: process.pid, processStartTicks: processStartTicks(process.pid),
            device: fileStat.dev, inode: fileStat.ino,
            versionId, sourceSha: this.identity.sourceSha ?? null, bundleId: this.identity.bundleId ?? null,
            openedAt: new Date(now).toISOString(), endedAt: null, closed: false, bytes: 0,
            reservedBytes: this.segmentBytes + RESERVATION_OVERHEAD_BYTES };
        writeManifest(manifest, meta);
        this.current = { file, fd, manifest, meta };
    }

    _closeSegment(now) {
        if (!this.current) return;
        const current = this.current;
        closeSync(current.fd);
        current.meta.closed = true;
        current.meta.endedAt = new Date(now).toISOString();
        current.meta.bytes = statSync(current.file).size;
        current.meta.reservedBytes = 0;
        writeManifest(current.manifest, current.meta);
        this.current = null;
    }

    append(type, detail = {}, { critical = false } = {}) {
        if (this.closed) throw new Error('diagnostics writer is closed');
        if (typeof type !== 'string' || !type || type.length > 100) throw new TypeError('diagnostic event type is required');
        const now = this.clock();
        let versionRole = null;
        let activationEpoch = this.identity.activationEpoch ?? null;
        const stateFile = path.join(this.root, 'version-state.json');
        if (existsSync(stateFile)) {
            const state = JSON.parse(readFileSync(stateFile, 'utf8'));
            if (state.schemaVersion !== 1 || state.owner !== 'mindcraft-tools')
                throw new Error(`unsupported diagnostics version state: ${stateFile}`);
            if (this.identity.versionId && state.currentVersionId === this.identity.versionId) {
                versionRole = 'current'; activationEpoch = state.activationEpoch;
            } else if (this.identity.versionId && state.previousVersionId === this.identity.versionId) {
                versionRole = 'previous'; activationEpoch = state.activationEpoch;
            } else versionRole = 'unclassified';
        }
        const event = redact({ schemaVersion: 1, eventId: `${this.processRunId}:${this.pool}:${++this.sequence}`,
            processRunId: this.processRunId, bot: this.identity.bot ?? null, sourceSha: this.identity.sourceSha ?? null,
            versionId: this.identity.versionId ?? null, versionRole, activationEpoch,
            bundleId: this.identity.bundleId ?? null, worldId: this.identity.worldId ?? null,
            taskId: detail.taskId ?? null, actionId: detail.actionId ?? null, callId: detail.callId ?? null,
            parentCallId: detail.parentCallId ?? null, at: new Date(now).toISOString(),
            monotonicMs: Number((process.hrtime.bigint() - PROCESS_MONOTONIC_ORIGIN) / 1_000_000n),
            sequence: this.sequence, type, critical: critical || undefined, detail });
        let line = JSON.stringify(event) + '\n';
        if (Buffer.byteLength(line) > MAX_EVENT_BYTES) {
            const bytes = Buffer.byteLength(line);
            event.detail = { truncated: true, originalBytes: bytes,
                sha256: createHash('sha256').update(line).digest('hex'), type: event.type,
                taskId: event.taskId, actionId: event.actionId, callId: event.callId };
            line = JSON.stringify(event) + '\n';
        }
        const bytes = Buffer.byteLength(line);
        const release = lock(this.ownerRoot);
        try {
            const files = segmentFiles(this.poolRoot);
            const ownerFiles = ownerSegmentFiles(this.ownerRoot, this.pool);
            const occupied = ownerFiles.reduce((sum, item) => sum + item.bytes
                + (item.meta?.closed === false ? Math.max(0, item.meta.reservedBytes - item.bytes) : 0), 0);
            const runOccupied = files.reduce((sum, item) => sum + item.bytes
                + (item.meta?.closed === false ? Math.max(0, item.meta.reservedBytes - item.bytes) : 0), 0);
            const rotate = !this.current || this.current.meta.versionId !== (this.identity.versionId ?? null)
                || this.current.meta.bytes + bytes > this.segmentBytes
                || now - Date.parse(this.current.meta.openedAt) >= this.segmentMs;
            const additionalReservation = rotate ? Math.max(this.segmentBytes, bytes) + RESERVATION_OVERHEAD_BYTES : 0;
            const currentManifestBytes = this.current ? statSync(this.current.manifest).size : 0;
            const releasedReservation = rotate && this.current
                ? Math.max(0, this.current.meta.reservedBytes - this.current.meta.bytes - currentManifestBytes) : 0;
            if (occupied - releasedReservation + additionalReservation > this.ownerLimitBytes
                || runOccupied - releasedReservation + additionalReservation > this.runLimitBytes)
                throw new DiagnosticQuotaError(`diagnostics pool ${this.pool} owner/run quota is full`, this.pool);
            if (rotate) {
                this._closeSegment(now);
                this._newSegment(now);
            }
            writeSync(this.current.fd, line);
            this.current.meta.bytes += bytes;
            this.current.meta.lastWriteAt = new Date(now).toISOString();
            this.current.meta.reservedBytes = this.segmentBytes + RESERVATION_OVERHEAD_BYTES;
            writeManifest(this.current.manifest, this.current.meta);
            return event;
        } finally { release(); }
    }

    close() {
        if (this.closed) return;
        const release = lock(this.ownerRoot);
        try { this._closeSegment(this.clock()); this.closed = true; }
        finally { release(); }
    }
}

export function diagnosticPoolUsage(root) {
    const result = {};
    for (const pool of ['stream', 'incident', 'console', 'maintenance']) {
        const entries = segmentFiles(path.join(path.resolve(root), pool));
        result[pool] = { bytes: entries.reduce((sum, item) => sum + item.bytes, 0),
            reservedBytes: entries.reduce((sum, item) => sum + (item.meta?.closed === false ? Math.max(0, item.meta.reservedBytes - item.bytes) : 0), 0),
            segments: entries.length, openSegments: entries.filter(item => item.meta?.closed === false).length };
    }
    return result;
}
