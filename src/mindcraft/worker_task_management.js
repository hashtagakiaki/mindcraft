export function attachWorkerTaskManagement(socket, { registry, allowed, deny, getConnection, isClosing }) {
    socket.on('worker-task-start', (data, callback) => {
        if (!allowed(['operator', 'legacy'])) return deny(callback);
        try {
            if (isClosing()) throw new Error('MindServer is closing');
            if (typeof data?.bot !== 'string' || typeof data?.requestId !== 'string'
                || !data.requestId.trim() || data.requestId.length > 200
                || typeof data.message !== 'string' || !data.message.trim() || data.message.length > 4000)
                throw new Error('Bot, request ID and 1-4000 character task are required.');
            const connection = getConnection(data.bot);
            if (!connection?.in_game || !connection.socket?.connected || !Number.isInteger(connection.connectionGeneration))
                throw new Error('Worker bot is not connected with a current runtime generation.');
            const begun = registry.begin({ bot: data.bot, requestId: data.requestId,
                message: data.message, connectionGeneration: connection.connectionGeneration });
            if (!begun.accepted) throw new Error(begun.error);
            const { record } = begun;
            if (begun.duplicate) {
                const snapshot = registry.snapshot(record, record.sequence);
                callback?.({ success: record.status !== 'rejected', duplicate: true,
                    accepted: record.accepted, ...snapshot });
                return;
            }
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                const snapshot = registry.acceptanceUnknown(record);
                callback?.({ success: false, accepted: false, ...snapshot,
                    error: 'Worker acceptance is unknown; query by request ID and do not replay.' });
            }, 5000);
            connection.socket.emit('worker-task-start', { handle: { ...record.handle }, message: data.message }, result => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (getConnection(data.bot) !== connection || connection.connectionGeneration !== record.handle.connectionGeneration) {
                    const snapshot = registry.acceptanceUnknown(record);
                    callback?.({ success: false, accepted: false, ...snapshot, error: 'Worker connection changed during acceptance.' });
                    return;
                }
                if (result?.accepted === true && result.taskId === record.handle.taskId && result.handleId === record.handle.id) {
                    const snapshot = registry.accept(record);
                    callback?.({ success: true, accepted: true, ...snapshot });
                } else {
                    const snapshot = registry.reject(record, result?.error || 'Worker rejected the task.');
                    callback?.({ success: false, accepted: false, ...snapshot, error: result?.error || 'Worker rejected the task.' });
                }
            });
        } catch (error) { callback?.({ success: false, error: error.message }); }
    });

    socket.on('worker-task-read', (query, callback) => {
        if (!allowed(['operator', 'legacy'])) return deny(callback);
        const record = registry.find({ handle: query?.handle, bot: query?.bot, requestId: query?.requestId });
        if (!record) { callback?.({ success: false, error: 'Worker task handle or request ID is unknown or stale.' }); return; }
        const cursor = query?.handle?.cursor;
        callback?.({ success: true, ...registry.snapshot(record, Number.isSafeInteger(cursor) ? cursor : record.sequence) });
    });

    socket.on('worker-task-wait', async (query, callback) => {
        if (!allowed(['operator', 'legacy'])) return deny(callback);
        if (!Array.isArray(query?.handles) || !query.handles.length || query.handles.length > 32
            || !Number.isInteger(query.timeoutMs) || query.timeoutMs < 0 || query.timeoutMs > 45000) {
            callback?.({ success: false, error: 'One to 32 handles and a 0-45000ms event wait are required.' });
            return;
        }
        try {
            const result = await registry.wait(query.handles, query.timeoutMs);
            callback?.({ success: true, ...result });
        } catch (error) {
            callback?.({ success: false, error: error.message || 'Worker event wait failed.' });
        }
    });

    socket.on('worker-task-cancel', (handle, callback) => {
        if (!allowed(['operator', 'legacy'])) return deny(callback);
        const record = registry.find({ handle });
        if (!record) { callback?.({ success: false, error: 'Worker task handle is unknown or stale.' }); return; }
        if (record.terminal) {
            const outcomeKnown = record.status !== 'unknown';
            callback?.({ success: outcomeKnown, ...registry.snapshot(record),
                ...(outcomeKnown ? {} : { error: 'Worker outcome is unknown; this handle cannot cancel a later task.' }) });
            return;
        }
        const connection = getConnection(record.handle.bot);
        if (!connection?.in_game || !connection.socket?.connected
            || connection.connectionGeneration !== record.handle.connectionGeneration) {
            registry.markDisconnected(record.handle.bot, record.handle.connectionGeneration);
            callback?.({ success: false, ...registry.snapshot(record), error: 'Worker connection is unavailable; outcome is unknown.' });
            return;
        }
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            registry.append(record, 'stopping', { reason: 'cancel acknowledgement timed out; outcome remains unknown' });
            record.status = 'unknown';
            callback?.({ success: false, ...registry.snapshot(record), error: 'Cancel acknowledgement timed out; read the handle again.' });
        }, 5000);
        connection.socket.emit('worker-task-cancel', { handle: { ...record.handle } }, result => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (result?.accepted === true) {
                if (record.status !== 'stopping') {
                    record.status = result.status || 'stopping';
                    registry.append(record, 'stopping', { reason: result.reason || 'cancellation requested' });
                }
                callback?.({ success: true, ...registry.snapshot(record) });
            } else callback?.({ success: false, ...registry.snapshot(record), error: result?.error || 'Worker did not accept cancellation.' });
        });
    });
}

export function attachWorkerTaskAgentEvents(socket, { registry, getBot, isCurrentConnection,
    getConnectionGeneration, getHubGeneration }) {
    socket.on('worker-task-event', (payload, acknowledge) => {
        const bot = getBot();
        if (!bot || !isCurrentConnection(bot)) {
            acknowledge?.({ accepted: false, error: 'worker task event sender is not the current bot connection' });
            return;
        }
        const record = registry.find({ handle: payload?.handle });
        const result = registry.recordAgentEvent(record, payload, {
            bot, connectionGeneration: getConnectionGeneration(bot), hubGeneration: getHubGeneration()
        });
        acknowledge?.(result);
    });
}
