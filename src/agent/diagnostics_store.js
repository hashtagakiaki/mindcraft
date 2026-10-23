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
                if (actual !== null && actual !== current.startTicks) unlinkSync(file);
                else if (actual === null) {
                    try { process.kill(Number(current.pid), 0); }
                    catch (probeError) { if (probeError.code === 'ESRCH') unlinkSync(file); }
                }
            } catch (readError) {
                if (readError.code === 'ENOENT') continue;
                throw new Error(`diagnostics quota lock is unreadable: ${file}`, { cause: readError });
            }
            if (Date.now() >= until) throw new Error(`diagnostics quota lock is busy: ${file}`);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
    }
}

export function withDiagnosticQuotaLock(root, callback) {
    if (typeof callback !== 'function') throw new TypeError('diagnostics lock callback is required');
    const release = lock(path.resolve(root));
    try { return callback(); }
    finally { release(); }
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
                let manifest;
                try {
                    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
                } catch (error) {
                    if (existsSync(path.join(dir, 'stream', 'segments')))
                        throw new Error(`invalid diagnostics owner manifest: ${manifestPath}`, { cause: error });
                }
                if (manifest?.schemaVersion === 1 && manifest.owner === 'mindcraft') roots.push(dir);
                else if (existsSync(path.join(dir, 'stream', 'segments')))
                    throw new Error(`unsupported diagnostics owner manifest: ${manifestPath}`);
            } else if (existsSync(path.join(dir, 'stream', 'segments')))
                throw new Error(`unsafe diagnostics owner manifest: ${manifestPath}`);
        } else if (existsSync(path.join(dir, 'stream', 'segments'))) {
            throw new Error(`missing diagnostics owner manifest: ${manifestPath}`);
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

function diagnosticRootForSegment(file) {
    return path.dirname(path.dirname(path.dirname(file)));
}

function validClosedSegment(entry, pool) {
    const meta = entry.meta;
    if (!meta || meta.schemaVersion !== 1 || meta.owner !== 'mindcraft' || meta.pool !== pool
        || meta.file !== path.basename(entry.file) || meta.closed !== true) return false;
    const root = diagnosticRootForSegment(entry.file);
    const resolved = path.resolve(entry.file);
    if (!resolved.startsWith(`${root}${path.sep}`)) return false;
    try {
        const file = lstatSync(entry.file);
        const manifest = lstatSync(entry.manifest);
        return file.isFile() && !file.isSymbolicLink() && manifest.isFile() && !manifest.isSymbolicLink()
            && file.dev === meta.device && file.ino === meta.inode;
    } catch { return false; }
}

function reconcileStaleWriters(ownerRoot, pool, now) {
    for (const entry of ownerSegmentFiles(ownerRoot, pool)) {
        const meta = entry.meta;
        if (!meta || meta.closed !== false || !Number.isInteger(meta.pid) || typeof meta.processStartTicks !== 'string') continue;
        const liveTicks = processStartTicks(meta.pid);
        if (liveTicks === meta.processStartTicks) continue;
        let writerExitConfirmed = liveTicks !== null;
        if (liveTicks === null) {
            try { process.kill(meta.pid, 0); }
            catch (error) { writerExitConfirmed = error.code === 'ESRCH'; }
        }
        if (!writerExitConfirmed) continue;
        const state = lstatSync(entry.file);
        if (state.isSymbolicLink() || !state.isFile() || state.dev !== meta.device || state.ino !== meta.inode) continue;
        meta.closed = true;
        meta.staleWriter = true;
        meta.endedAt = meta.lastWriteAt ?? new Date(now).toISOString();
        meta.bytes = state.size;
        meta.reservedBytes = 0;
        writeManifest(entry.manifest, meta);
    }
}

function candidatePriority(entry, retentionDays, now) {
    const root = diagnosticRootForSegment(entry.file);
    const stateFile = path.join(root, 'version-state.json');
    if (existsSync(stateFile)) {
        try {
            const state = JSON.parse(readFileSync(stateFile, 'utf8'));
            if (state.schemaVersion === 1 && state.owner === 'mindcraft-tools') {
                if (!Object.hasOwn(state, 'currentVersionId') || !Object.hasOwn(state, 'previousVersionId'))
                    throw new Error(`missing diagnostics version identifiers: ${stateFile}`);
                if ((state.currentVersionId !== null && typeof state.currentVersionId !== 'string')
                    || (state.previousVersionId !== null && typeof state.previousVersionId !== 'string'))
                    throw new Error(`invalid diagnostics version identifiers: ${stateFile}`);
                const version = entry.meta.versionId;
                if (version !== null && typeof version !== 'string')
                    throw new Error(`invalid diagnostics segment version identifier: ${entry.file}`);
                const current = version && version === state.currentVersionId;
                const previous = version && version === state.previousVersionId;
                const ended = Date.parse(entry.meta.endedAt ?? '');
                return { rank: current ? 2 : previous ? 1 : version ? 0 : 3,
                    ended: Number.isFinite(ended) ? ended : Infinity, root, versioned: true,
                    eligible: Boolean(version && state.currentVersionId) };
            }
            throw new Error(`unsupported diagnostics version state: ${stateFile}`);
        } catch (error) {
            throw new Error(`cannot safely evaluate diagnostics version state: ${stateFile}`, { cause: error });
        }
    }
    const ended = Date.parse(entry.meta.endedAt ?? '');
    const expiry = Number.isFinite(ended) && retentionDays > 0 && ended <= now - retentionDays * 86_400_000;
    return { rank: expiry ? 0 : 1, ended: Number.isFinite(ended) ? ended : Infinity, root, versioned: false };
}

function unlinkClosedSegment(entry, pool) {
    if (!validClosedSegment(entry, pool)) return false;
    const fileStat = lstatSync(entry.file);
    const manifestStat = lstatSync(entry.manifest);
    if (fileStat.dev !== entry.meta.device || fileStat.ino !== entry.meta.inode
        || manifestStat.isSymbolicLink() || !manifestStat.isFile()) return false;
    unlinkSync(entry.file);
    unlinkSync(entry.manifest);
    return true;
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
        segmentMs = SEGMENT_MS, processRunId = randomUUID(), retentionDays = null }) {
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
        if (retentionDays !== null && (!Number.isSafeInteger(retentionDays) || retentionDays <= 0))
            throw new TypeError('diagnostics retentionDays must be null or a positive safe integer');
        this.retentionDays = retentionDays;
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
            let rootManifest;
            if (existsSync(manifestPath)) {
                rootManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
                if (rootManifest.schemaVersion !== 1 || rootManifest.owner !== 'mindcraft')
                    throw new Error(`unsupported diagnostics root manifest: ${manifestPath}`);
            } else {
                rootManifest = { schemaVersion: 1, owner: 'mindcraft', createdAt: new Date(this.clock()).toISOString(), pools: {} };
            }
            rootManifest.pools ??= {};
            const poolPolicy = { limitBytes: this.limitBytes, ownerLimitBytes: this.ownerLimitBytes,
                runLimitBytes: this.runLimitBytes, retentionDays: this.retentionDays };
            const existingPolicy = rootManifest.pools[this.pool];
            if (existingPolicy && JSON.stringify(existingPolicy) !== JSON.stringify(poolPolicy))
                throw new Error(`diagnostics pool policy changed for ${this.pool}: ${manifestPath}`);
            rootManifest.pools[this.pool] = poolPolicy;
            writeManifest(manifestPath, rootManifest);
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
            if (!Object.hasOwn(state, 'currentVersionId') || !Object.hasOwn(state, 'previousVersionId')
                || (state.currentVersionId !== null && typeof state.currentVersionId !== 'string')
                || (state.previousVersionId !== null && typeof state.previousVersionId !== 'string'))
                throw new Error(`invalid diagnostics version identifiers: ${stateFile}`);
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
            reconcileStaleWriters(this.ownerRoot, this.pool, now);
            const files = segmentFiles(this.poolRoot);
            const rotate = !this.current || this.current.meta.versionId !== (this.identity.versionId ?? null)
                || this.current.meta.bytes + bytes > this.segmentBytes
                || now - Date.parse(this.current.meta.openedAt) >= this.segmentMs;
            const additionalReservation = rotate ? Math.max(this.segmentBytes, bytes) + RESERVATION_OVERHEAD_BYTES : 0;
            const currentManifestBytes = this.current ? statSync(this.current.manifest).size : 0;
            const releasedReservation = rotate && this.current
                ? Math.max(0, this.current.meta.reservedBytes - this.current.meta.bytes - currentManifestBytes) : 0;
            const ownerFiles = ownerSegmentFiles(this.ownerRoot, this.pool);
            const ranked = ownerFiles.filter(item => validClosedSegment(item, this.pool))
                .map(item => ({ ...item, ...candidatePriority(item, this.retentionDays, now) }));
            const eligible = ranked.filter(item => item.eligible !== false)
                .sort((a, b) => a.rank - b.rank || a.ended - b.ended);
            const unknownVersionSegments = ranked.filter(item => item.eligible === false);
            const deletedSegments = [];
            const projected = () => {
                const all = ownerSegmentFiles(this.ownerRoot, this.pool);
                const local = segmentFiles(this.poolRoot);
                const usage = entries => entries.reduce((sum, item) => sum + item.bytes
                    + (item.meta?.closed === false ? Math.max(0, item.meta.reservedBytes - item.bytes) : 0), 0);
                const reservation = rotate ? additionalReservation - releasedReservation : 0;
                return { owner: usage(all) + reservation, run: usage(local) + reservation };
            };
            let usage = projected();
            for (const candidate of eligible) {
                if (usage.owner <= this.ownerLimitBytes && usage.run <= this.runLimitBytes
                    && usage.run <= this.limitBytes) break;
                const isLocal = candidate.root === this.root;
                const localOver = usage.run > Math.min(this.runLimitBytes, this.limitBytes);
                if ((localOver && !isLocal) || (!localOver && usage.owner <= this.ownerLimitBytes)) continue;
                if (unlinkClosedSegment(candidate, this.pool)) {
                    deletedSegments.push({ bytes: candidate.bytes, versionId: candidate.meta.versionId,
                        reason: candidate.versioned ? candidate.rank === 0 ? 'older_version'
                            : candidate.rank === 1 ? 'previous_capacity' : 'current_capacity'
                            : candidate.rank === 0 ? 'expired' : 'capacity' });
                    usage = projected();
                }
            }
            if (deletedSegments.length) {
                const manifestPath = path.join(this.root, 'manifest.json');
                const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
                manifest.lastQuotaCleanup = { at: new Date(now).toISOString(), pool: this.pool,
                    segmentCount: deletedSegments.length,
                    bytes: deletedSegments.reduce((sum, item) => sum + item.bytes, 0),
                    reasons: deletedSegments.reduce((counts, item) => {
                        counts[item.reason] = (counts[item.reason] ?? 0) + 1;
                        return counts;
                    }, {}) };
                writeManifest(manifestPath, manifest);
            }
            if (usage.owner > this.ownerLimitBytes || usage.run > this.runLimitBytes || usage.run > this.limitBytes) {
                const detail = unknownVersionSegments.length
                    ? `; ${unknownVersionSegments.length} closed segment(s) have unknown manual versions and were protected`
                    : '';
                throw new DiagnosticQuotaError(`diagnostics pool ${this.pool} owner/run quota is full${detail}`, this.pool);
            }
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
