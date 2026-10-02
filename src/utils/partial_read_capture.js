import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const MAX_PARTIAL_READ_SAMPLES_PER_BOT = 8;
const MAX_PARTIAL_READ_FRAME_CAPTURE_BYTES = 256 * 1024;

export function capturePartialReadErrors(bot) {
    const capturedFrames = new Set();
    const client = bot._client;
    if (!client) return;

    const instrumentParser = parser => {
        if (!parser || typeof parser.parsePacketBuffer !== 'function' || parser.partialReadCaptureInstalled) return;
        parser.partialReadCaptureInstalled = true;
        const parsePacketBuffer = parser.parsePacketBuffer.bind(parser);
        parser.parsePacketBuffer = function(frame, ...args) {
            try {
                return parsePacketBuffer(frame, ...args);
            } catch (err) {
                if (!err?.partialReadError || !Buffer.isBuffer(frame)) throw err;

                const frameSha256 = createHash('sha256').update(frame).digest('hex');
                if (capturedFrames.has(frameSha256) || capturedFrames.size >= MAX_PARTIAL_READ_SAMPLES_PER_BOT) {
                    throw err;
                }
                capturedFrames.add(frameSha256);

                let packetId = null;
                let packetIdBytes = null;
                try {
                    const decoded = parser.proto.read(frame, 0, 'varint', {});
                    packetId = decoded.value;
                    packetIdBytes = decoded.size;
                } catch {
                    // Keep the raw frame even if the packet id cannot be decoded.
                }

                const framePreviewBytes = Math.floor(MAX_PARTIAL_READ_FRAME_CAPTURE_BYTES / 2);
                const frameHex = frame.length <= MAX_PARTIAL_READ_FRAME_CAPTURE_BYTES
                    ? frame.toString('hex')
                    : `${frame.subarray(0, framePreviewBytes).toString('hex')}...<truncated>...${frame.subarray(-framePreviewBytes).toString('hex')}`;
                const record = {
                    time: new Date().toISOString(),
                    bot: bot.username,
                    clientVersion: bot.version,
                    protocolState: client.state,
                    direction: 'server-to-client',
                    packetId,
                    packetIdBytes,
                    frameLength: frame.length,
                    frameSha256,
                    frameCaptureTruncated: frame.length > MAX_PARTIAL_READ_FRAME_CAPTURE_BYTES,
                    frameHex,
                    error: err.stack ?? String(err)
                };

                const safeBotName = String(bot.username ?? 'unknown-agent').replace(/[^A-Za-z0-9_.-]/g, '_');
                const logDirectory = path.resolve('bots', safeBotName, 'logs');
                const logPath = path.join(logDirectory, 'partial-read-errors.jsonl');
                try {
                    mkdirSync(logDirectory, { recursive: true });
                    appendFileSync(logPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
                    console.warn(`[mcdata] Captured PartialReadError frame for ${safeBotName}: state=${record.protocolState}, packetId=${packetId}, bytes=${frame.length}, sha256=${frameSha256}; details saved to ${logPath}`);
                } catch (logError) {
                    capturedFrames.delete(frameSha256);
                    console.error(`[mcdata] Failed to persist PartialReadError frame for ${safeBotName}:`, logError);
                }

                throw err;
            }
        };
    };

    const setSerializer = client.setSerializer.bind(client);
    client.setSerializer = function(...args) {
        const result = setSerializer(...args);
        instrumentParser(client.deserializer);
        return result;
    };
    instrumentParser(client.deserializer);
}
