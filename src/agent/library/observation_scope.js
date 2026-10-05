export function createObservationScope(bot, management = {}) {
    return {
        observedAt: new Date().toISOString(),
        dimension: typeof bot?.game?.dimension === 'string' ? bot.game.dimension : null,
        worldConnectionGeneration: null,
        managementConnectionGeneration: Number.isSafeInteger(management.connectionGeneration)
            ? management.connectionGeneration : null,
        managementConnectionReady: typeof management.ready === 'boolean' ? management.ready : null,
        managementServerGeneration: management.ready === false ? null
            : typeof management.serverGeneration === 'string' && management.serverGeneration
            ? management.serverGeneration : null,
    };
}
