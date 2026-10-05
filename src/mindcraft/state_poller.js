export const STATE_POLL_INTERVAL_MS = 1000;
export const STATE_ACK_TIMEOUT_MS = 750;

// One poll generation owns at most one round of callbacks. Stopping it invalidates
// both the timer and any callbacks that arrive after the final listener left.
export function createStatePoller({ getConnections, emit, intervalMs = STATE_POLL_INTERVAL_MS,
    ackTimeoutMs = STATE_ACK_TIMEOUT_MS }) {
    let timer = null;
    let generation = 0;
    let stopped = true;
    const lastKnown = new Map();
    const unavailable = (name, error = null) => {
        const previous = lastKnown.get(name);
        return previous
            ? { ...previous.state, _freshness: { status: 'stale', observedAt: previous.observedAt, ...(error ? { error } : {}) } }
            : { _freshness: { status: 'unknown', observedAt: null, ...(error ? { error } : {}) } };
    };

    const poll = async (owner) => {
        if (stopped || owner !== generation) return;
        const connections = getConnections();
        const entries = await Promise.all(Object.entries(connections).map(async ([name, connection]) => {
            if (!connection?.in_game || !connection.socket?.connected) {
                return [name, unavailable(name)];
            }
            const socket = connection.socket;
            let deadline;
            try {
                const state = await Promise.race([
                    new Promise((resolve, reject) => {
                        try { socket.emit('get-full-state', resolve); } catch (error) { reject(error); }
                    }),
                    new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('state acknowledgement timed out')), ackTimeoutMs); }),
                ]);
                if (stopped || owner !== generation) return [name, null];
                if (getConnections()[name] !== connection || connection.socket !== socket) return [name, unavailable(name, 'connection changed during state poll')];
                if (state && typeof state === 'object') {
                    const observedAt = new Date().toISOString();
                    lastKnown.set(name, { state, observedAt });
                    return [name, { ...state, _freshness: { status: 'fresh', observedAt } }];
                }
                throw new Error('state acknowledgement returned no state');
            } catch (error) {
                if (stopped || owner !== generation) return [name, null];
                if (getConnections()[name] !== connection || connection.socket !== socket) return [name, unavailable(name, 'connection changed during state poll')];
                return [name, unavailable(name, String(error.message || error))];
            } finally { clearTimeout(deadline); }
        }));
        if (!stopped && owner === generation) {
            const states = Object.fromEntries(entries.filter(([, state]) => state !== null));
            emit(states);
            timer = setTimeout(() => { void poll(owner); }, intervalMs);
        }
    };

    return {
        start() {
            if (!stopped) return;
            stopped = false;
            const owner = ++generation;
            void poll(owner);
        },
        stop() {
            stopped = true;
            generation++;
            clearTimeout(timer);
            timer = null;
        },
    };
}
