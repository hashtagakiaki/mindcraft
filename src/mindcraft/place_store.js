import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const MAX_QUERY_RESULTS = 100;
const DEFAULT_QUERY_RESULTS = 20;
const MAX_NAME_LENGTH = 120;
const MAX_TEXT_LENGTH = 240;
const PLACE_KINDS = new Set(['base', 'farm', 'storage', 'forest', 'village', 'mine', 'resource', 'other']);
const EXISTENCE_STATES = new Set(['unverified', 'observed', 'missing']);
const SOURCE_TYPES = new Set(['user', 'observed']);

export class PlaceStoreError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'PlaceStoreError';
        this.code = code;
    }
}

function fail(code, message) {
    throw new PlaceStoreError(code, message);
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, label) {
    if (!isRecord(value)) fail('INVALID_INPUT', `${label} must be an object`);
    return value;
}

function requireText(value, label, maxLength = MAX_TEXT_LENGTH) {
    if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
        fail('INVALID_INPUT', `${label} must be a non-empty string of at most ${maxLength} characters`);
    }
    return value.trim();
}

function normalizeDimension(value = 'overworld') {
    const dimension = requireText(value, 'dimension', 100).toLowerCase();
    const normalized = dimension.includes(':') ? dimension : `minecraft:${dimension}`;
    if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(normalized)) {
        fail('INVALID_INPUT', 'dimension must be a valid namespaced identifier');
    }
    return normalized;
}

function normalizePosition(value, label = 'position') {
    const position = requireRecord(value, label);
    for (const axis of ['x', 'y', 'z']) {
        if (typeof position[axis] !== 'number' || !Number.isFinite(position[axis])) {
            fail('INVALID_INPUT', `${label}.${axis} must be a finite number`);
        }
    }
    return { x: position.x, y: position.y, z: position.z };
}

function normalizeStringList(value, label, maxItems = 32) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > maxItems) fail('INVALID_INPUT', `${label} must be an array of at most ${maxItems} strings`);
    return [...new Set(value.map((item) => requireText(item, label, MAX_NAME_LENGTH)))];
}

function normalizeSource(value, reportedBy) {
    const source = value ?? 'user';
    if (!SOURCE_TYPES.has(source)) fail('INVALID_INPUT', 'source must be user or observed');
    return { type: source, ...(reportedBy ? { reportedBy: requireText(reportedBy, 'reportedBy', 80) } : {}) };
}

function normalizePlace(input, previous = null) {
    requireRecord(input, 'place');
    const name = requireText(input.name ?? previous?.name, 'name', MAX_NAME_LENGTH);
    const kind = input.kind ?? previous?.kind ?? 'other';
    if (typeof kind !== 'string' || !PLACE_KINDS.has(kind)) fail('INVALID_INPUT', `kind must be one of: ${[...PLACE_KINDS].join(', ')}`);
    const position = normalizePosition(input.position ?? previous?.position);
    const dimension = normalizeDimension(input.dimension ?? previous?.dimension ?? 'overworld');
    const purposes = normalizeStringList(input.purposes ?? previous?.purposes, 'purposes');
    const aliases = normalizeStringList(input.aliases ?? previous?.aliases, 'aliases');
    const existence = input.existence ?? previous?.existence ?? (input.source === 'observed' ? 'observed' : 'unverified');
    if (!EXISTENCE_STATES.has(existence)) fail('INVALID_INPUT', 'existence must be unverified, observed, or missing');
    const inputSource = isRecord(input.source) ? input.source.type : input.source;
    const source = normalizeSource(inputSource ?? previous?.source?.type, input.reportedBy ?? (isRecord(input.source) ? input.source.reportedBy : undefined) ?? previous?.source?.reportedBy);
    const id = input.id ?? previous?.id ?? randomUUID();
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) fail('INVALID_INPUT', 'id must contain only letters, numbers, underscore, or hyphen');
    const place = { id, name, aliases, kind, purposes, dimension, position, source, existence };
    if (input.approachPosition !== undefined || previous?.approachPosition) {
        place.approachPosition = normalizePosition(input.approachPosition ?? previous.approachPosition, 'approachPosition');
    }
    if (input.radius !== undefined || previous?.radius !== undefined) {
        const radius = input.radius ?? previous.radius;
        if (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0) fail('INVALID_INPUT', 'radius must be a finite non-negative number');
        place.radius = radius;
    }
    if (existence === 'observed') {
        const lastVerifiedAt = input.observedAt ?? input.lastVerifiedAt ?? previous?.lastVerifiedAt;
        place.lastVerifiedAt = lastVerifiedAt ? normalizeTimestamp(lastVerifiedAt, 'observedAt') : new Date().toISOString();
    }
    else if (previous?.lastVerifiedAt) place.lastVerifiedAt = previous.lastVerifiedAt;
    place.recordedAt = input.recordedAt ?? previous?.recordedAt ?? new Date().toISOString();
    place.recordedAt = normalizeTimestamp(place.recordedAt, 'recordedAt');
    if (input.lastCheckedAt !== undefined || previous?.lastCheckedAt !== undefined) {
        place.lastCheckedAt = normalizeTimestamp(input.lastCheckedAt ?? previous.lastCheckedAt, 'lastCheckedAt');
    }
    if (input.availability !== undefined || previous?.availability !== undefined) {
        const availability = input.availability ?? previous.availability;
        if (typeof availability !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(availability)) fail('INVALID_INPUT', 'availability must be a short identifier');
        place.availability = availability;
    }
    if (input.lastVisit !== undefined || previous?.lastVisit !== undefined) {
        const lastVisit = input.lastVisit ?? previous.lastVisit;
        if (!isRecord(lastVisit) || typeof lastVisit.status !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(lastVisit.status)) fail('INVALID_INPUT', 'lastVisit must include a valid status');
        place.lastVisit = {
            status: lastVisit.status,
            at: normalizeTimestamp(lastVisit.at, 'lastVisit.at'),
            ...(lastVisit.reportedBy ? { reportedBy: requireText(lastVisit.reportedBy, 'lastVisit.reportedBy', 80) } : {})
        };
    }
    return place;
}

function normalizeTimestamp(value, label = 'timestamp') {
    const text = requireText(value, label, 40);
    if (!Number.isFinite(Date.parse(text))) fail('INVALID_INPUT', `${label} must be a valid timestamp`);
    return new Date(text).toISOString();
}

function normalizeAlias(value) {
    return requireText(value, 'alias', MAX_NAME_LENGTH).toLocaleLowerCase('en-US');
}

function validateWorldId(worldId) {
    if (typeof worldId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(worldId)) {
        fail('INVALID_CONFIG', 'place_world_id must be a UUID');
    }
    return worldId.toLowerCase();
}

function newDocument(worldId) {
    return { schemaVersion: SCHEMA_VERSION, worldId, revision: 0, places: [], relations: [], agentPreferences: {} };
}

function validateDocument(document, worldId) {
    if (!isRecord(document) || document.schemaVersion !== SCHEMA_VERSION || document.worldId !== worldId ||
        !Number.isSafeInteger(document.revision) || document.revision < 0 || !Array.isArray(document.places) ||
        !Array.isArray(document.relations) || !isRecord(document.agentPreferences)) {
        fail('CORRUPT_STORE', `Place store for world ${worldId} has an invalid schema or scope`);
    }
    const placeIds = new Set();
    for (const place of document.places) {
        if (!isRecord(place) || typeof place.id !== 'string' || placeIds.has(place.id)) fail('CORRUPT_STORE', 'Place store contains an invalid or duplicate place ID');
        placeIds.add(place.id);
        try { normalizePlace(place, place); } catch (error) { fail('CORRUPT_STORE', `Place store contains an invalid place: ${error.message}`); }
    }
    for (const relation of document.relations) {
        if (!isRecord(relation) || !placeIds.has(relation.fromPlaceId) || !placeIds.has(relation.toPlaceId) ||
            relation.type !== 'output_storage' || !SOURCE_TYPES.has(relation.source) || !Number.isSafeInteger(relation.revision) || relation.revision < 1 || relation.revision > document.revision ||
            !Number.isFinite(Date.parse(relation.confirmedAt))) {
            fail('CORRUPT_STORE', 'Place store contains an invalid relation');
        }
        const fromPlace = document.places.find((place) => place.id === relation.fromPlaceId);
        const toPlace = document.places.find((place) => place.id === relation.toPlaceId);
        if (fromPlace.dimension !== toPlace.dimension || toPlace.kind !== 'storage') fail('CORRUPT_STORE', 'Place store relation endpoints have incompatible types or dimensions');
    }
    for (const [agentName, preferences] of Object.entries(document.agentPreferences)) {
        if (!isRecord(preferences) || typeof agentName !== 'string' || !isRecord(preferences.aliases)) fail('CORRUPT_STORE', 'Place store contains invalid agent preferences');
        if (preferences.homePlaceId !== undefined && !placeIds.has(preferences.homePlaceId)) fail('CORRUPT_STORE', 'Agent home refers to a missing place');
        for (const placeId of Object.values(preferences.aliases)) if (!placeIds.has(placeId)) fail('CORRUPT_STORE', 'Agent alias refers to a missing place');
    }
    return document;
}

function clone(value) {
    return structuredClone(value);
}

function ownValue(record, key) {
    return Object.hasOwn(record, key) ? record[key] : undefined;
}

function setOwnValue(record, key, value) {
    Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

export class PlaceStore {
    constructor({ stateDir, worldId, lockHandle, lockToken, lockPath, filePath, document }) {
        this.stateDir = stateDir;
        this.worldId = worldId;
        this.lockHandle = lockHandle;
        this.lockToken = lockToken;
        this.lockPath = lockPath;
        this.filePath = filePath;
        this.document = document;
        this.queue = Promise.resolve();
        this.closing = false;
        this.closed = false;
        this.closePromise = null;
    }

    static async open({ stateDir, worldId }) {
        if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) fail('INVALID_CONFIG', 'place_state_dir must be an absolute path');
        const normalizedWorldId = validateWorldId(worldId);
        const normalizedDir = path.resolve(stateDir);
        const worldsDir = path.join(normalizedDir, 'worlds');
        await mkdir(worldsDir, { recursive: true });
        const lockPath = path.join(normalizedDir, '.place-store.lock');
        const lockToken = randomUUID();
        let lockHandle;
        let lockCreated = false;
        try {
            lockHandle = await open(lockPath, 'wx', 0o600);
            lockCreated = true;
            await lockHandle.writeFile(JSON.stringify({ pid: process.pid, token: lockToken, worldId: normalizedWorldId }));
            await lockHandle.sync();
        } catch (error) {
            if (lockHandle) await lockHandle.close().catch(() => {});
            if (lockCreated) await unlink(lockPath).catch(() => {});
            if (error.code === 'EEXIST') fail('STORE_LOCKED', `Place store directory is already in use: ${normalizedDir}`);
            throw error;
        }
        const filePath = path.join(worldsDir, `${normalizedWorldId}.json`);
        try {
            let document;
            try {
                document = JSON.parse(await readFile(filePath, 'utf8'));
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    if (error instanceof SyntaxError) fail('CORRUPT_STORE', `Place store JSON is invalid; original file was preserved: ${filePath}`);
                    throw error;
                }
                document = newDocument(normalizedWorldId);
            }
            validateDocument(document, normalizedWorldId);
            return new PlaceStore({ stateDir: normalizedDir, worldId: normalizedWorldId, lockHandle, lockToken, lockPath, filePath, document });
        } catch (error) {
            await lockHandle.close();
            await unlink(lockPath).catch(() => {});
            throw error;
        }
    }

    get revision() { return this.document.revision; }

    snapshot() { return clone(this.document); }

    _enqueue(mutator, expectedRevision) {
        if (this.closing || this.closed) fail('STORE_CLOSED', 'Place store is closing or closed');
        const operation = this.queue.then(async () => {
            if (this.closed) fail('STORE_CLOSED', 'Place store is closed');
            if (expectedRevision !== undefined && expectedRevision !== this.document.revision) {
                fail('REVISION_CONFLICT', `Expected revision ${expectedRevision}, current revision is ${this.document.revision}`);
            }
            const next = clone(this.document);
            const result = mutator(next);
            if (result?.unchanged) return { value: clone(result.value), revision: next.revision, changed: false };
            next.revision++;
            validateDocument(next, this.worldId);
            const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
            try {
                await writeFile(temporaryPath, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 });
                await rename(temporaryPath, this.filePath);
            } catch (error) {
                await unlink(temporaryPath).catch(() => {});
                throw error;
            }
            this.document = next;
            return { value: clone(result), revision: next.revision, changed: true };
        });
        this.queue = operation.catch(() => {});
        return operation;
    }

    queryPlaces(criteria = {}) {
        requireRecord(criteria, 'criteria');
        const text = criteria.text === undefined ? '' : requireText(criteria.text, 'text').toLocaleLowerCase('en-US');
        const kind = criteria.kind;
        if (kind !== undefined && !PLACE_KINDS.has(kind)) fail('INVALID_INPUT', 'kind is invalid');
        if (criteria.purpose !== undefined && typeof criteria.purpose !== 'string') fail('INVALID_INPUT', 'purpose must be a string');
        const purpose = criteria.purpose?.toLocaleLowerCase('en-US');
        const dimension = criteria.dimension === undefined ? undefined : normalizeDimension(criteria.dimension);
        const existence = criteria.existence;
        if (existence !== undefined && !EXISTENCE_STATES.has(existence)) fail('INVALID_INPUT', 'existence is invalid');
        const availability = criteria.availability;
        if (availability !== undefined && (typeof availability !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(availability))) fail('INVALID_INPUT', 'availability is invalid');
        const staleBefore = criteria.staleBefore === undefined ? undefined : normalizeTimestamp(criteria.staleBefore, 'staleBefore');
        const limit = criteria.limit ?? DEFAULT_QUERY_RESULTS;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUERY_RESULTS) fail('INVALID_INPUT', `limit must be between 1 and ${MAX_QUERY_RESULTS}`);
        const agentName = criteria.agentName === undefined ? undefined : requireText(criteria.agentName, 'agentName', 80);
        const near = criteria.near === undefined ? undefined : normalizePosition(criteria.near, 'near');
        const nearDimension = criteria.nearDimension === undefined ? dimension : normalizeDimension(criteria.nearDimension);
        if (dimension && nearDimension && dimension !== nearDimension) fail('INVALID_INPUT', 'dimension and nearDimension must match');
        const candidates = this.document.places.filter((place) => {
            if (kind && place.kind !== kind) return false;
            if (purpose && !place.purposes.some((tag) => tag.toLocaleLowerCase('en-US') === purpose)) return false;
            if (dimension && place.dimension !== dimension) return false;
            if (existence && place.existence !== existence) return false;
            if (availability !== undefined && place.availability !== availability) return false;
            if (staleBefore && Date.parse(place.lastVerifiedAt ?? place.recordedAt) >= Date.parse(staleBefore)) return false;
            if (text) {
                const aliases = ownValue(this.document.agentPreferences, agentName)?.aliases ?? {};
                const matchingAlias = Object.entries(aliases).some(([alias, placeId]) => placeId === place.id && alias.includes(text));
                const fields = [place.name, ...place.aliases, place.kind, ...place.purposes, place.id];
                if (!matchingAlias && !fields.some((field) => field.toLocaleLowerCase('en-US').includes(text))) return false;
            }
            return true;
        });
        if (near) {
            candidates.sort((a, b) => {
                if (nearDimension && a.dimension !== nearDimension) return 1;
                if (nearDimension && b.dimension !== nearDimension) return -1;
                const distance = (place) => Math.hypot(place.position.x - near.x, place.position.y - near.y, place.position.z - near.z);
                return distance(a) - distance(b);
            });
        }
        return candidates.slice(0, limit).map(clone);
    }

    getPlace(placeId) {
        const id = requireText(placeId, 'placeId', 128);
        const place = this.document.places.find((entry) => entry.id === id);
        return place ? clone(place) : null;
    }

    inspectPlace(placeId) {
        const id = requireText(placeId, 'placeId', 128);
        const place = this.document.places.find((entry) => entry.id === id);
        if (!place) return null;
        const relation = this.document.relations.find((entry) => entry.fromPlaceId === id && entry.type === 'output_storage') ?? null;
        const target = relation ? this.document.places.find((entry) => entry.id === relation.toPlaceId) ?? null : null;
        return { place: clone(place), outputStorage: clone(target), relation: clone(relation), revision: this.document.revision };
    }

    resolveAgentAlias(agentName, alias) {
        const name = requireText(agentName, 'agentName', 80);
        const normalizedAlias = normalizeAlias(alias);
        const preferences = ownValue(this.document.agentPreferences, name);
        const placeId = preferences ? ownValue(preferences.aliases, normalizedAlias) : undefined;
        return placeId ? this.getPlace(placeId) : null;
    }

    rememberPlace(input, options = {}) {
        requireRecord(input, 'place');
        const id = input.id ?? randomUUID();
        const inputForMatch = input.source === 'observed' && !input.id ? {
            kind: input.kind ?? 'other',
            dimension: normalizeDimension(input.dimension ?? 'overworld'),
            position: normalizePosition(input.position)
        } : null;
        return this._enqueue((document) => {
            let actualId = id;
            let previous = input.id ? document.places.find((entry) => entry.id === input.id) : null;
            if (input.id && !previous) fail('PLACE_NOT_FOUND', `Place '${input.id}' was not found`);
            if (inputForMatch) {
                previous = document.places.find((entry) => entry.kind === inputForMatch.kind && entry.dimension === inputForMatch.dimension &&
                    entry.position.x === inputForMatch.position.x && entry.position.y === inputForMatch.position.y && entry.position.z === inputForMatch.position.z) ?? previous;
                if (previous) actualId = previous.id;
            }
            let placeInput = { ...input, id: actualId };
            if (inputForMatch && previous) {
                const aliases = new Set([...(previous.aliases ?? []), ...(input.aliases ?? [])]);
                if (input.name && input.name !== previous.name) aliases.add(input.name);
                placeInput = {
                    ...placeInput,
                    name: previous.name,
                    aliases: [...aliases],
                    purposes: [...new Set([...(previous.purposes ?? []), ...(input.purposes ?? [])])],
                    source: previous.source.type,
                    existence: 'observed'
                };
            }
            const place = normalizePlace(placeInput, previous);
            const index = document.places.findIndex((entry) => entry.id === actualId);
            if (index === -1) document.places.push(place);
            else document.places[index] = place;
            if (options.agentName && options.alias) this._setAgentAliasIn(document, options.agentName, options.alias, place.id);
            return place;
        }, options.expectedRevision);
    }

    updateObservation({ placeId, existence, observedAt, reportedBy, availability }, options = {}) {
        const id = requireText(placeId, 'placeId', 128);
        if (!EXISTENCE_STATES.has(existence)) fail('INVALID_INPUT', 'existence must be unverified, observed, or missing');
        const timestamp = observedAt === undefined ? new Date().toISOString() : normalizeTimestamp(observedAt, 'observedAt');
        return this._enqueue((document) => {
            const place = document.places.find((entry) => entry.id === id);
            if (!place) fail('PLACE_NOT_FOUND', `Place '${id}' was not found`);
            place.existence = existence;
            place.lastCheckedAt = timestamp;
            if (availability !== undefined) {
                if (typeof availability !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(availability)) fail('INVALID_INPUT', 'availability must be a short identifier');
                place.availability = availability;
            }
            if (existence === 'observed') {
                place.lastVerifiedAt = timestamp;
            }
            if (existence !== 'unverified') place.source = normalizeSource('observed', reportedBy);
            return place;
        }, options.expectedRevision);
    }

    recordVisit({ placeId, status, visitedAt, reportedBy }, options = {}) {
        const id = requireText(placeId, 'placeId', 128);
        if (typeof status !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(status)) fail('INVALID_INPUT', 'status must be a short identifier');
        const at = visitedAt === undefined ? new Date().toISOString() : normalizeTimestamp(visitedAt, 'visitedAt');
        const actor = reportedBy === undefined ? undefined : requireText(reportedBy, 'reportedBy', 80);
        return this._enqueue((document) => {
            const place = document.places.find((entry) => entry.id === id);
            if (!place) fail('PLACE_NOT_FOUND', `Place '${id}' was not found`);
            place.lastVisit = { status, at, ...(actor ? { reportedBy: actor } : {}) };
            return place;
        }, options.expectedRevision);
    }

    setRelation({ fromPlaceId, type = 'output_storage', toPlaceId, source = 'user', recordedBy }, options = {}) {
        const fromId = requireText(fromPlaceId, 'fromPlaceId', 128);
        const toId = requireText(toPlaceId, 'toPlaceId', 128);
        if (type !== 'output_storage') fail('INVALID_INPUT', 'Only output_storage relations are supported');
        if (!SOURCE_TYPES.has(source)) fail('INVALID_INPUT', 'source must be user or observed');
        const actor = recordedBy === undefined ? undefined : requireText(recordedBy, 'recordedBy', 80);
        return this._enqueue((document) => {
            const from = document.places.find((place) => place.id === fromId);
            const to = document.places.find((place) => place.id === toId);
            if (!from || !to) fail('PLACE_NOT_FOUND', 'Both relation endpoints must exist');
            if (from.dimension !== to.dimension) fail('DIMENSION_MISMATCH', 'Relations across dimensions are not supported');
            if (to.kind !== 'storage') fail('INVALID_RELATION', 'output_storage target must have kind storage');
            const current = document.relations.find((entry) => entry.fromPlaceId === fromId && entry.type === type);
            if (current?.source === 'user' && source === 'observed') return { unchanged: true, value: current };
            const relation = { fromPlaceId: fromId, type, toPlaceId: toId, source, ...(actor ? { recordedBy: actor } : {}), confirmedAt: new Date().toISOString(), revision: document.revision + 1 };
            if (current) document.relations[document.relations.indexOf(current)] = relation;
            else document.relations.push(relation);
            return relation;
        }, options.expectedRevision);
    }

    setAgentAlias(agentName, alias, placeId, options = {}) {
        const name = requireText(agentName, 'agentName', 80);
        const normalizedAlias = normalizeAlias(alias);
        const id = requireText(placeId, 'placeId', 128);
        return this._enqueue((document) => {
            if (!document.places.some((place) => place.id === id)) fail('PLACE_NOT_FOUND', `Place '${id}' was not found`);
            this._setAgentAliasIn(document, name, normalizedAlias, id);
            return { agentName: name, alias: normalizedAlias, placeId: id };
        }, options.expectedRevision);
    }

    _setAgentAliasIn(document, agentName, alias, placeId) {
        const name = requireText(agentName, 'agentName', 80);
        const normalizedAlias = normalizeAlias(alias);
        if (!ownValue(document.agentPreferences, name)) setOwnValue(document.agentPreferences, name, { aliases: {} });
        setOwnValue(document.agentPreferences[name].aliases, normalizedAlias, placeId);
    }

    setAgentPreference(agentName, { homePlaceId }, options = {}) {
        const name = requireText(agentName, 'agentName', 80);
        if (homePlaceId !== null && homePlaceId !== undefined) homePlaceId = requireText(homePlaceId, 'homePlaceId', 128);
        return this._enqueue((document) => {
            if (!ownValue(document.agentPreferences, name)) setOwnValue(document.agentPreferences, name, { aliases: {} });
            if (homePlaceId && !document.places.some((place) => place.id === homePlaceId)) fail('PLACE_NOT_FOUND', `Place '${homePlaceId}' was not found`);
            if (homePlaceId) document.agentPreferences[name].homePlaceId = homePlaceId;
            else delete document.agentPreferences[name].homePlaceId;
            return document.agentPreferences[name];
        }, options.expectedRevision);
    }

    getRelation(fromPlaceId, type = 'output_storage') {
        const fromId = requireText(fromPlaceId, 'fromPlaceId', 128);
        return clone(this.document.relations.find((entry) => entry.fromPlaceId === fromId && entry.type === type) ?? null);
    }

    getAgentPreferences(agentName) {
        const name = requireText(agentName, 'agentName', 80);
        return clone(ownValue(this.document.agentPreferences, name) ?? { aliases: {} });
    }

    async close() {
        if (this.closePromise) return this.closePromise;
        this.closing = true;
        this.closePromise = (async () => {
            await this.queue;
            this.closed = true;
            await this.lockHandle.close();
            try {
                const lock = JSON.parse(await readFile(this.lockPath, 'utf8'));
                if (lock.token === this.lockToken) await unlink(this.lockPath);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        })();
        return this.closePromise;
    }
}

export function attachPlaceStoreLifecycle({ server, socketServer, storePromise, processObject = process, beforeClose = () => {} }) {
    let closeStorePromise = null;
    let shutdownPromise = null;
    const closeStore = () => {
        if (!closeStorePromise) closeStorePromise = Promise.resolve(storePromise).then((store) => store?.close());
        return closeStorePromise;
    };
    const removeSignalHandlers = () => {
        processObject.removeListener('SIGINT', onSigint);
        processObject.removeListener('SIGTERM', onSigterm);
    };
    const onServerClose = () => {
        removeSignalHandlers();
        closeStore().catch((error) => console.error('Place store close failed:', error.message));
    };
    const shutdown = (signal) => {
        if (shutdownPromise) return shutdownPromise;
        shutdownPromise = (async () => {
            beforeClose();
            await closeStore();
            await new Promise((resolve, reject) => {
                try { socketServer.close(resolve); } catch (error) { reject(error); }
            });
            processObject.exit(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 0);
        })().catch((error) => {
            console.error('MindServer shutdown failed:', error.message);
            processObject.exit(1);
        });
        return shutdownPromise;
    };
    const onSigint = () => { void shutdown('SIGINT'); };
    const onSigterm = () => { void shutdown('SIGTERM'); };
    server.once('close', onServerClose);
    processObject.on('SIGINT', onSigint);
    processObject.on('SIGTERM', onSigterm);
    return { closeStore, shutdown };
}
