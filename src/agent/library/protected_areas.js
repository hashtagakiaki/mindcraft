// Shared protected areas forbid route digging and scaffolding. The pathfinder
// fork reads bot.navigationProtection while planning, so every Movements
// instance and the navigation edit gate apply the same boxes.
function normalizedDimension(value) {
    if (typeof value !== 'string' || !value) return null;
    return value.includes(':') ? value : `minecraft:${value}`;
}

export function createNavigationProtection(bot) {
    let areas = [];
    return Object.freeze({
        replace(next) {
            if (!Array.isArray(next)) throw new TypeError('Protected areas must be an array.');
            areas = next.map(area => structuredClone(area));
        },
        get areas() { return areas.map(area => structuredClone(area)); },
        // An unknown bot dimension matches every area rather than none.
        areaAt(position) {
            if (!areas.length) return null;
            const dimension = normalizedDimension(bot.game?.dimension);
            const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
            return areas.find(area => (!dimension || area.dimension === dimension)
                && x >= area.min.x && x <= area.max.x && y >= area.min.y && y <= area.max.y
                && z >= area.min.z && z <= area.max.z) ?? null;
        },
        contains(position) { return this.areaAt(position) !== null; },
    });
}
