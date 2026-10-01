const MAX_REQUEST_BYTES = 16 * 1024;
const MUTATION_OPERATIONS = new Set(['remember', 'observation', 'visit', 'relation', 'alias', 'preference']);
export const DEFAULT_PLACE_RPC_TIMEOUT_MS = 5000;

export class PlaceRpcError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'PlaceRpcError';
        this.code = code;
    }
}

export function requestPlaceRpc(socket, operation, payload = {}, expectedRevision, timeoutMs = DEFAULT_PLACE_RPC_TIMEOUT_MS) {
    if (!socket) return Promise.reject(new PlaceRpcError('DISCONNECTED', 'MindServer is not connected'));
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new PlaceRpcError('RPC_TIMEOUT', `Place request '${operation}' timed out after ${timeoutMs} ms`)), timeoutMs);
        const request = { operation, payload };
        if (expectedRevision !== undefined) request.expectedRevision = expectedRevision;
        try {
            socket.emit('place:request', request, (response) => {
                clearTimeout(timeout);
                if (!response?.ok) {
                    const error = response?.error ?? { code: 'INVALID_RESPONSE', message: 'Invalid place response' };
                    reject(new PlaceRpcError(error.code, error.message));
                    return;
                }
                resolve(response);
            });
        } catch (error) {
            clearTimeout(timeout);
            reject(error);
        }
    });
}

function errorResponse(error) {
    return {
        ok: false,
        error: {
            code: error?.code ?? 'INTERNAL_ERROR',
            message: error?.message ?? 'Place request failed'
        }
    };
}

function validRequest(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) return false;
    try {
        return Buffer.byteLength(JSON.stringify(request)) <= MAX_REQUEST_BYTES;
    } catch {
        return false;
    }
}

export function attachPlaceRpc(socket, { getAgentName, getPlaceStore, isClosing = () => false }) {
    socket.on('place:request', async (request, acknowledge) => {
        if (typeof acknowledge !== 'function') return;
        try {
            if (!validRequest(request) || typeof request.operation !== 'string') {
                acknowledge(errorResponse(Object.assign(new Error('Invalid place request'), { code: 'INVALID_REQUEST' })));
                return;
            }
            const agentName = getAgentName();
            if (!agentName) {
                acknowledge(errorResponse(Object.assign(new Error('Place requests require a registered agent socket'), { code: 'UNREGISTERED_SOCKET' })));
                return;
            }
            if (MUTATION_OPERATIONS.has(request.operation) && isClosing()) {
                acknowledge(errorResponse(Object.assign(new Error('MindServer is shutting down'), { code: 'SERVER_SHUTTING_DOWN' })));
                return;
            }
            const store = await getPlaceStore();
            if (MUTATION_OPERATIONS.has(request.operation) && isClosing()) {
                acknowledge(errorResponse(Object.assign(new Error('MindServer is shutting down'), { code: 'SERVER_SHUTTING_DOWN' })));
                return;
            }
            if (!store) {
                acknowledge(errorResponse(Object.assign(new Error('Persistent place store is not configured'), { code: 'STORE_DISABLED' })));
                return;
            }
            const payload = request.payload ?? {};
            let result;
            switch (request.operation) {
                case 'query':
                    result = store.queryPlaces({ ...payload, agentName });
                    break;
                case 'get':
                    result = store.getPlace(payload.placeId);
                    break;
                case 'inspect':
                    result = store.inspectPlace(payload.placeId);
                    break;
                case 'resolve_alias':
                    result = store.resolveAgentAlias(agentName, payload.alias);
                    break;
                case 'preferences':
                    result = store.getAgentPreferences(agentName);
                    break;
                case 'remember':
                    result = await store.rememberPlace({ ...payload.place, source: payload.place?.source ?? 'user' }, {
                        expectedRevision: request.expectedRevision,
                        agentName,
                        alias: payload.alias
                    });
                    break;
                case 'observation':
                    result = await store.updateObservation({ ...payload, reportedBy: agentName }, { expectedRevision: request.expectedRevision });
                    break;
                case 'visit':
                    result = await store.recordVisit({ ...payload, reportedBy: agentName }, { expectedRevision: request.expectedRevision });
                    break;
                case 'relation':
                    result = await store.setRelation({ ...payload, recordedBy: agentName }, { expectedRevision: request.expectedRevision });
                    break;
                case 'alias':
                    result = await store.setAgentAlias(agentName, payload.alias, payload.placeId, { expectedRevision: request.expectedRevision });
                    break;
                case 'preference':
                    result = await store.setAgentPreference(agentName, payload, { expectedRevision: request.expectedRevision });
                    break;
                default:
                    acknowledge(errorResponse(Object.assign(new Error(`Unknown place operation '${request.operation}'`), { code: 'UNKNOWN_OPERATION' })));
                    return;
            }
            const mutation = MUTATION_OPERATIONS.has(request.operation);
            acknowledge({
                ok: true,
                value: mutation ? result.value : result,
                revision: mutation ? result.revision : (result?.revision ?? store.revision)
            });
        } catch (error) {
            acknowledge(errorResponse(error));
        }
    });
}
