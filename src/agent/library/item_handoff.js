// Bot-to-bot item handoff signals. Control messages travel over the authenticated
// MindServer bot chat and are consumed here, never by the model conversation.
// The agent attaches one instance as bot.itemHandoff for giveToPlayer/receiveFromPlayer.
export function createItemHandoff({ send, isPeer }) {
    const waiters = new Set();
    return Object.freeze({
        isPeer,
        send,
        deliver(sender, signal) {
            for (const waiter of [...waiters]) waiter(sender, signal);
        },
        // Resolves with the first matching signal from sender, or null on timeout/interrupt.
        waitFor(bot, sender, match, timeoutMs, { onTick = null, tickMs = 1000 } = {}) {
            return new Promise(resolve => {
                const startedAt = Date.now();
                let timer = null;
                const finish = value => {
                    waiters.delete(waiter);
                    clearTimeout(timer);
                    resolve(value);
                };
                const waiter = (from, signal) => { if (from === sender && match(signal)) finish(signal); };
                const tick = () => {
                    if (bot.interrupt_code || Date.now() - startedAt >= timeoutMs) return finish(null);
                    onTick?.();
                    timer = setTimeout(tick, Math.min(tickMs, Math.max(1, timeoutMs - (Date.now() - startedAt))));
                };
                waiters.add(waiter);
                tick();
            });
        },
    });
}
