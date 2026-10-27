import { runWithNavigationPolicy } from './navigation_policy.js';
import { operationContext } from './operation_context.js';

// Native model-facing contracts. Internal/legacy SDKs retain their bot-first APIs.
// No function-source or arity inference: each adapter states its argument mapping.
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const objectLike = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isSafeInteger(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const field = (type, options = {}) => Object.freeze({ type, ...options });
const text = options => field('string', options);
const positiveInt = options => field('positiveInteger', options);
const distance = options => field('nonnegativeNumber', options);
const radius = (value, options = {}) => field('radius', { default: value, ...options });
const position = options => field('position', options);
const optional = descriptor => Object.freeze({ ...descriptor, optional: true });
const enumeration = (values, options = {}) => field('enum', { values, ...options });
const quantity = options => field('quantity', options);
const placeKinds = ['base', 'farm', 'storage', 'forest', 'village', 'mine', 'resource', 'other'];
const PRESERVE_ROUTE = Object.freeze({ allowDig: false, scaffold: 'forbid', scaffoldBlocks: Object.freeze([]) });
const PRESERVE_WITH_CLEANUP = Object.freeze({ allowDig: false, scaffold: 'temporary', scaffoldBlocks: Object.freeze(['dirt', 'cobblestone']) });
const EDIT_ROUTE = Object.freeze({ allowDig: true, scaffold: 'leave', scaffoldBlocks: Object.freeze(['dirt', 'cobblestone']) });
const COMBAT_ROUTE = Object.freeze({ allowDig: false, scaffold: 'leave', scaffoldBlocks: Object.freeze(['dirt', 'cobblestone']), allowTowers: false });
const navigationPolicies = Object.freeze({
    'skills.goToPosition': PRESERVE_WITH_CLEANUP, 'skills.reachPosition': EDIT_ROUTE,
    'skills.craftItem': PRESERVE_ROUTE, 'skills.smeltItem': PRESERVE_ROUTE, 'skills.clearNearestFurnace': PRESERVE_ROUTE,
    'skills.attackNearest': COMBAT_ROUTE, 'skills.attackEntity': COMBAT_ROUTE, 'skills.defendSelf': COMBAT_ROUTE,
    'skills.collectBlock': EDIT_ROUTE, 'skills.pickupNearbyItems': PRESERVE_ROUTE,
    'skills.breakBlockAt': PRESERVE_ROUTE, 'skills.approachBlock': PRESERVE_ROUTE, 'skills.inspectChest': PRESERVE_ROUTE,
    'skills.putInChest': PRESERVE_ROUTE, 'skills.takeFromChest': PRESERVE_ROUTE,
    'skills.giveToPlayer': PRESERVE_ROUTE, 'skills.goToNearestBlock': PRESERVE_ROUTE, 'skills.goToNearestEntity': PRESERVE_ROUTE,
    'skills.goToPlayer': PRESERVE_ROUTE, 'skills.followPlayer': PRESERVE_ROUTE,
    'skills.moveAway': COMBAT_ROUTE, 'skills.moveAwayFromEntity': COMBAT_ROUTE, 'skills.avoidEnemies': COMBAT_ROUTE,
    'skills.goToBed': PRESERVE_ROUTE, 'skills.useDoor': PRESERVE_ROUTE, 'skills.tillAndSow': PRESERVE_ROUTE,
    'skills.activateNearestBlock': PRESERVE_ROUTE, 'skills.showVillagerTrades': PRESERVE_ROUTE,
    'skills.tradeWithVillager': PRESERVE_ROUTE, 'skills.goToSurface': EDIT_ROUTE, 'skills.tendNearbyFarm': PRESERVE_ROUTE,
    'skills.fellTree': PRESERVE_ROUTE, 'skills.placeBlock': PRESERVE_ROUTE, 'skills.useToolOn': PRESERVE_ROUTE,
    'skills.useToolOnBlock': PRESERVE_ROUTE,
    'places.goTo': PRESERVE_ROUTE, 'places.goToAlias': PRESERVE_ROUTE, 'places.tendFarm': PRESERVE_ROUTE,
});
const farmFields = Object.freeze({
    scope: enumeration(['connected', 'radius'], { default: 'connected' }),
    searchRadius: optional(radius(undefined, { positive: true, description: 'Connected-plot search radius; effective default 32.' })),
    radius: optional(radius(undefined, { positive: true, description: 'Work radius for scope:"radius" only; effective default 32.' })),
    startPosition: optional(position({ description: 'Select connected farmland; scope:"connected" only.' })),
    seedReserve: field('nonnegativeInteger', { default: 1, description: 'Items of each seed to retain.' }),
    chestPosition: optional(position({ description: 'Store harvested items in this exact chest; omission keeps harvested items in inventory.' })),
});

function farmConstraint(input, fail) {
    if (input.scope === 'connected' && has(input, 'radius')) fail('radius', 'omit radius for scope:"connected"; use searchRadius');
    if (input.scope === 'radius') {
        for (const key of ['searchRadius', 'startPosition']) if (has(input, key)) fail(key, 'omit for scope:"radius"; use scope:"connected"');
    }
}

const definitions = [];
function define(namespace, name, fields, description, args, options = {}) {
    const method = `${namespace}.${name}`;
    const queries = new Set(['places.find', 'places.inspect', 'places.resolveAlias', 'places.verify', 'skills.inspectChest', 'skills.showVillagerTrades']);
    const kind = options.kind ?? (namespace === 'world' || namespace === 'diagnostics' || namespace === 'vision' || queries.has(method) ? 'query' : 'action');
    definitions.push(Object.freeze({ namespace, name, fields: Object.freeze(fields), description, args,
        kind, completion: options.completion ?? (kind === 'query' ? 'data' : 'truthy'),
        bindBot: namespace === 'skills' || namespace === 'world', ...options }));
}
const policyDescription = policy => policy === EDIT_ROUTE
    ? 'Its route may dig and leave confirmed dirt/cobblestone scaffolds; the selected work target keeps this skill’s own permissions.'
    : policy === COMBAT_ROUTE
        ? 'Its route cannot dig or use one-block towers and may place confirmed dirt/cobblestone bridge scaffolds that may remain; the existing target/follow/retreat goal is preserved.'
        : 'Its route preserves existing blocks and leaves no route scaffolds; an unreachable target returns this skill’s normal failure result.';
const s = (name, fields, description, args, options = {}) => {
    const navigationPolicy = navigationPolicies[`skills.${name}`];
    return define('skills', name, fields,
        navigationPolicy ? `${description} ${policyDescription(navigationPolicy)}` : description, args,
        { ...options, ...(navigationPolicy ? { navigationPolicy } : {}) });
};
const w = (name, fields, description, args, options) => define('world', name, fields, description, args, options);
const p = (name, fields, description, args, options = {}) => {
    const navigationPolicy = navigationPolicies[`places.${name}`];
    return define('places', name, fields,
        navigationPolicy ? `${description} ${policyDescription(navigationPolicy)}` : description, args,
        { bindBot: false, ...options, ...(navigationPolicy ? { navigationPolicy } : {}) });
};
const coords = input => [input.position.x, input.position.y, input.position.z];
const allQuantity = value => value === 'all' ? -1 : value;

s('log', { message: field('stringValue') }, 'Append a message to operation output. No world mutation.', a => [a.message]);
s('craftItem', { itemName: text(), quantity: positiveInt({ default: 1, description: 'Minimum new output items to craft; excess recipe output is included in confirmedQuantity.' }) }, 'Craft at least quantity new output items, rounded up to whole recipe outputs; quantity is not the number of recipe executions. Handles required approach and crafting-table use. Returns requestedQuantity, confirmedQuantity and remainingQuantity based on server-confirmed recipe output; incomplete or unknown results stop the current code batch.', a => [a.itemName, a.quantity], { completion: 'complete' });
s('wait', { milliseconds: distance() }, 'Interruptible wait in milliseconds. Returns boolean.', a => [a.milliseconds]);
s('smeltItem', { itemName: text(), quantity: positiveInt({ default: 1, description: 'Input items to smelt.' }), furnacePosition: optional(position({ description: 'Use this exact furnace; never substitute another.' })) }, 'Smelt in a furnace. An explicit furnacePosition is exact; omission selects the nearest. Handles required approach and container closure. Returns the output item and server-confirmed requested, confirmed and remaining quantities; incomplete or unknown results stop the current code batch.', a => [a.itemName, a.quantity, a.furnacePosition], { completion: 'complete' });
s('clearNearestFurnace', { furnacePosition: optional(position({ description: 'Use this exact furnace; never substitute another.' })) }, 'Remove contents of the selected furnace; omission selects the nearest.', a => [a.furnacePosition ?? null]);
s('attackNearest', { mobType: text(), kill: field('boolean', { default: true }) }, 'Attack the nearest matching mob; kill:false makes one attack. Returns boolean.', a => [a.mobType, a.kill]);
s('attackEntity', { entity: field('entity'), kill: field('boolean', { default: true }) }, 'Attack an observed Entity reference; kill:false makes one attack. Returns boolean.', a => [a.entity, a.kill]);
s('defendSelf', { radius: radius(9) }, 'Defend against nearby hostile enemies, retargeting close threats and keeping distance from the group. radius admits new enemies; engaged targets remain tracked within max(radius,24). Returns true only after confirmed deaths and a quiet interval for death-spawned enemies; false on no targets, loss or interruption.', a => [a.radius]);
s('collectBlock', { blockType: text(), count: positiveInt({ default: 1, description: 'Blocks to collect, not drop quantity.' }), exclude: field('positions', { default: null, nullable: true, description: 'Positions to skip, never positions to collect.' }) }, 'Collect matching blocks. Returns boolean.', a => [a.blockType, a.count, a.exclude]);
s('pickupNearbyItems', {}, 'Pick up nearby dropped items. Returns boolean.', () => []);
for (const [name, description] of [
    ['breakBlockAt', 'Break one absolute block. Handles loaded/unchanged target and non-editing approach. Selects a harvest tool when available; if no held tool can harvest the block but its bare-hand dig time is finite, breaks it by hand and it may drop nothing. Normal survival success waits for server-confirmed air. Await once: no separate approach/equip or immediate air check is needed for that same block. Returns true on success; a false result stops minecraft_execute. Caller selects an authorized target; this does not verify the whole request.'],
    ['approachBlock', 'Approach without digging/scaffolding until a reachable surface aim point is found. Rechecks the actual eye ray; center visibility is not required. Returns ready with fresh observation and interaction aim/face/distance. In minecraft_execute, unknown/blocked stops execution and preserves that result in sdkFailure. breakBlockAt already approaches when needed.'],
]) s(name, { position: position() }, description, coords);
s('inspectChest', { position: optional(position()) }, 'Move into interaction range, open and inspect the explicit chest, or nearest when omitted. This inspection changes your position; it is not a remote inventory query. Returns a timestamped observation and closes the container. When gathering supplies, withdraw needed items here before inspecting another chest and stop exploring once requirements are met. An explicit position is never substituted. Handles approach, target recheck and closure; do not add a separate move to this chest first. A reachable interaction surface does not guarantee that the container opens. On an open timeout, read the target, above-block and sneak observations before changing the approach.', a => a.position ? coords(a) : [], { completion: 'observed' });
s('placeBlock', {
    blockType: text(), position: position(),
    facing: optional(enumeration(['north', 'south', 'east', 'west', 'up', 'down'])),
    axis: optional(enumeration(['x', 'y', 'z'])), half: optional(enumeration(['top', 'bottom'])),
    attachTo: optional(enumeration(['top', 'bottom', 'north', 'south', 'east', 'west'])),
    dontCheat: field('boolean', { default: false }),
}, 'Place a block at absolute position and verify its resulting server block state for every placement. facing/axis/half/attachTo use intended block state; attachTo is the side containing support. Supports are selected internally unless attachTo is specified. Returns boolean.', a => {
    const orientation = Object.fromEntries(['facing', 'axis', 'half', 'attachTo'].filter(key => has(a, key)).map(key => [key, a[key]]));
    return [a.blockType, ...coords(a), orientation, a.dontCheat];
}, { constraint: (a, fail) => {
    const orientation = ['facing', 'axis', 'half', 'attachTo'].filter(key => has(a, key));
    if (has(a, 'axis') && (has(a, 'facing') || has(a, 'half'))) fail('axis', 'cannot combine with facing or half');
} });
s('equip', { itemName: text() }, 'Equip the named item. Returns boolean.', a => [a.itemName]);
s('discard', { itemName: text(), quantity: quantity() }, 'Discard quantity items; quantity:"all" explicitly discards all matching items. Returns boolean.', a => [a.itemName, allQuantity(a.quantity)]);
for (const name of ['putInChest', 'takeFromChest']) s(name, {
    itemName: text(), quantity: quantity(), chestPosition: optional(position()),
}, 'Transfer quantity items; quantity:"all" explicitly requests all matching available items. chestPosition selects exactly one chest and never substitutes another; omission uses nearest. Handles approach, target recheck and closure; do not add a separate move to this chest first. Returns server-confirmed requested, confirmed and remaining quantities; incomplete or unknown results stop the current code batch.', a => [a.itemName, allQuantity(a.quantity), has(a, 'chestPosition') ? { chestPosition: a.chestPosition, details: true } : { details: true }], { completion: 'complete' });
s('consume', { itemName: field('stringValue', { default: '', description: 'Empty string selects available food.' }) }, 'Consume food or a potion. Returns boolean.', a => [a.itemName]);
s('giveToPlayer', { itemName: text(), playerName: text(), quantity: positiveInt({ default: 1 }) }, 'Give quantity items to the visible player. Returns boolean.', a => [a.itemName, a.playerName, a.quantity]);
s('goToPosition', { position: position() }, 'Reach the requested Minecraft feet block (floor(x), floor(y), floor(z)); the exact coordinate within that block is not required. Success requires a loaded, grounded, safe arrival confirmed across two physics ticks. Confirmed dirt/cobblestone route scaffolds are removed before success. Returns {ok,status,arrivalReached,finalPosition,reason,code,diagnostics}; only status:reached is complete, and other statuses stop the code batch. Read diagnostics: search_limit is a bounded search limit, no_progress is the stall condition, and target_unloaded means terminal observations are unavailable. already_at_goal means the safe target block was already occupied; it does not mean movement occurred. route_not_found means no route was found with current loaded chunks, movement policy and search limits, not that the world destination is impossible. After a no-dig noPath, a search-only probe of at most 250ms can return digging_required when a route with digging is found; it never executes that route. A probe timeout returns search_limit. Consider reachPosition only if the task permits digging. A found digging candidate does not prove successful passage or that digging is the only option. Missing scaffold materials reject routes needing them; scaffold-free routes remain available. Existing safe-drop, liquid and unknown-terrain limits still apply.', a => [{
    position: a.position, allowDig: false, scaffold: 'temporary', scaffoldBlocks: ['dirt', 'cobblestone'],
}]);
s('reachPosition', { position: position() }, 'Reach the requested Minecraft feet block (floor(x), floor(y), floor(z)); the exact coordinate within that block is not required. Success requires a loaded, grounded, safe arrival confirmed across two physics ticks. Route digging and confirmed dirt/cobblestone scaffolds may remain; route edits must be server-confirmed. Returns {ok,status,arrivalReached,finalPosition,reason,code,diagnostics}; only status:reached is complete, and other statuses stop the code batch. Read diagnostics: search_limit is a bounded search limit, no_progress is the stall condition, and target_unloaded means terminal observations are unavailable. already_at_goal means the safe target block was already occupied; it does not mean movement occurred. route_not_found means no route was found with current loaded chunks, movement policy and search limits, not that the world destination is impossible. Missing scaffold materials reject routes needing them; scaffold-free routes remain available. Existing safe-drop, liquid and unknown-terrain limits still apply.', a => [{
    position: a.position, allowDig: true, allowScaffold: true, scaffoldBlocks: ['dirt', 'cobblestone'], safeWater: false, cleanupOwnedScaffolds: false,
}]);
s('goToNearestBlock', { blockType: text(), minDistance: distance({ default: 2 }), radius: radius(64) }, 'Navigate to the nearest matching block within radius. Returns boolean.', a => [a.blockType, a.minDistance, a.radius]);
s('goToNearestEntity', { entityType: text(), minDistance: distance({ default: 2 }), radius: radius(64) }, 'Navigate to the nearest matching entity within radius. Returns boolean.', a => [a.entityType, a.minDistance, a.radius]);
s('goToPlayer', { username: text(), minDistance: distance({ default: 3 }) }, 'Navigate near a visible player. Returns boolean.', a => [a.username, a.minDistance]);
s('followPlayer', { username: text(), minDistance: distance({ default: 4 }) }, 'Follow a player until interrupted. Returns boolean.', a => [a.username, a.minDistance]);
s('moveAway', { distance: distance() }, 'Move distance blocks away from current position. Returns boolean.', a => [a.distance]);
s('moveAwayFromEntity', { entity: field('entity'), distance: distance({ default: 16 }) }, 'Move distance blocks away from an observed Entity reference. Returns boolean.', a => [a.entity, a.distance]);
s('avoidEnemies', { distance: distance({ default: 16 }) }, 'Retreat from the group of nearby enemies with a confirmed approach route or ranged line of sight. Ignores terrain-separated enemies. Returns true when none remain in range; false on path failure, 5 seconds without distance progress, the 30-second limit, or cancellation.', a => [a.distance]);
s('stay', { seconds: field('staySeconds', { default: 30, description: '-1 means stay until interrupted.' }) }, 'Stay for seconds, disabling modes; -1 stays until interrupted. Returns boolean.', a => [a.seconds]);
s('useDoor', { position: optional(position()), open: optional(field('boolean')) }, 'Use a wooden door or fence gate at position, or the nearest when omitted. open:true opens and leaves it open; open:false closes it. Explicit state is server-confirmed without walking through. Omitting open keeps the legacy open, walk through, close behavior. Returns boolean.', a => [a.position ?? null, has(a, 'open') ? { open: a.open } : {}]);
s('goToBed', {}, 'Sleep in the nearest bed. Returns boolean.', () => []);
s('tillAndSow', { position: position(), seedType: optional(text({ description: 'Seed item or supported crop name; omission only tills.' })) }, 'Till absolute ground position and optionally plant a crop. True requires confirmed requested planting.', a => [...coords(a), a.seedType ?? null]);
s('activateNearestBlock', { blockType: text(), position: optional(position()) }, 'Activate the nearest matching block, or the exact block at position when supplied.', a => [a.blockType, a.position]);
s('showVillagerTrades', { entityId: field('nonnegativeInteger') }, 'Read and return structured trades from the specified villager entity ID.', a => [a.entityId], { kind: 'query' });
s('tradeWithVillager', { entityId: field('nonnegativeInteger'), index: positiveInt({ description: 'Trade index, one-based.' }), times: positiveInt() }, 'Execute a specified villager trade times times. Returns boolean.', a => [a.entityId, a.index, a.times]);
s('digDown', { distance: positiveInt({ default: 10, description: 'Vertical blocks to dig.' }) }, 'Dig down, stopping at water/lava or unsafe falls. Returns boolean.', a => [a.distance]);
s('goToSurface', {}, 'Find and navigate to the surface. Returns boolean.', () => []);
s('useToolOn', { toolName: text(), targetName: text() }, 'Equip tool (or "hand") and use on nearest entity/block. Use useItem for activation without a target.', a => [a.toolName, a.targetName]);
s('useToolOnBlock', { toolName: text(), position: position() }, 'Resolve the currently loaded block at this position immediately before using the tool.', a => [a.toolName, a.position]);
s('useItem', { itemName: text() }, 'Activate a held item without targeting a block or entity. Confirms the use input only; later effects are separate observations.', a => [a.itemName]);
s('tendNearbyFarm', { ...farmFields }, 'Tend connected farmland by default; radius scope works a circular area. Harvest and replant; an explicit chestPosition stores harvested produce there, while omission leaves it in inventory. Returns confirmed counts, remaining work and status; incomplete work or storage stops the current code batch.', a => a.scope === 'radius' ? { ...a, radius: a.radius ?? 32 } : { ...a, searchRadius: a.searchRadius ?? 32 }, { argsObject: true, constraint: farmConstraint, completion: 'farm' });
s('fellTree', { startPosition: optional(position()), searchRadius: radius(24, { positive: true, max: 64 }) }, 'Fell one natural single-trunk tree, collect logs and remove this call’s pillars. Returns complete/partial/cancelled/blocked/not_found and confirmed counts. Bring an axe, free slots and scaffolding; inspect leftoverScaffolds/grounded. In minecraft_execute, an incomplete status stops execution and preserves the result in sdkFailure.', a => [a]);

w('inspectBlockAt', { position: position() }, 'Synchronously inspect an absolute block: loaded state, position/name/properties, legacy center visibility/distance, canDig (installed mining admission, using the same surface resolver), dimension/time, and interaction status/aim/face/distance/reason from surface rays within 4.5 blocks. Center visibility or center-distance admission is not required for digging. interaction.status:ready means a reachable interaction surface, not a guarantee that a chest opens. Unknown is not air; no sampled aim is not proof of total occlusion.', coords);
w('getNearestFreeSpace', { size: positiveInt({ default: 1 }), radius: radius(8) }, 'Synchronously find nearest empty size×size space above solid ground. Returns Vec3 or undefined.', a => [a.size, a.radius]);
w('getBlockAtOffset', { offset: position({ default: Object.freeze({ x: 0, y: 0, z: 0 }), description: 'Relative to bot feet, not absolute position.' }) }, 'Synchronously read a loaded block at a relative offset; returns Block or null.', a => [a.offset.x, a.offset.y, a.offset.z]);
w('getSurroundingBlocks', {}, 'Synchronously describe blocks below, at legs and at head; unloaded blocks are unknown.', () => []);
w('getFirstBlockAboveHead', { ignoreTypes: field('strings', { default: null, nullable: true, description: 'Omission ignores air and cave_air.' }), radius: radius(32) }, 'Synchronously search upward from the head; returns block description, none or unknown.', a => [a.ignoreTypes, a.radius]);
w('getNearestBlocks', { blockTypes: field('strings', { default: null, nullable: true, description: 'Omission searches all non-air block IDs.' }), radius: radius(8), limit: positiveInt({ default: 10000 }) }, 'Synchronously return nearest observed Blocks. Default radius is 8; unloaded targets remain unknown.', a => [a.blockTypes, a.radius, a.limit]);
w('getNearestBlocksWhere', { predicate: field('blockPredicate'), radius: radius(8), limit: positiveInt({ default: 10000 }) }, 'Synchronously search using a predicate on loaded Blocks with position, numeric block ID, or array of numeric block IDs. Function predicates scan full Blocks; ID matching uses the faster palette search. Returns Blocks.', a => [a.predicate, a.radius, a.limit]);
w('getNearestBlock', { blockType: text(), radius: radius(16) }, 'Synchronously return nearest matching Block or null.', a => [a.blockType, a.radius]);
w('getNearbyEntities', { radius: radius(16) }, 'Synchronously return observed Entity references ordered by distance.', a => [a.radius]);
w('getNearestEntityWhere', { predicate: field('function'), radius: radius(16) }, 'Synchronously return nearest Entity matching the predicate, or null.', a => [a.predicate, a.radius]);
w('getNearbyPlayers', { radius: radius(16) }, 'Synchronously return nearby player Entity references, excluding this bot.', a => [a.radius]);
w('getVillagerProfession', { entity: field('object') }, 'Synchronously read profession metadata from an observed Entity; no bot is needed internally. Returns a string.', a => [a.entity], { bindBot: false });
for (const [name, description] of [
    ['getInventoryCounts', 'Synchronously return inventory counts summed across slots and keyed by item name.'],
    ['getCraftableItems', 'Synchronously list recipes currently craftable with inventory/table.'],
    ['getPosition', 'Synchronously return this bot’s current Vec3 position; y is vertical.'],
    ['getNearbyEntityTypes', 'Synchronously list distinct nearby entity names (within 16 blocks).'],
    ['getNearbyPlayerNames', 'Synchronously list distinct other player names (within 64 blocks).'],
    ['getBiomeName', 'Synchronously return the biome at this bot’s position.'],
]) w(name, {}, description, () => []);
w('isEntityType', { name: text() }, 'Synchronously test a Minecraft entity type name. Returns boolean; no bot is needed internally.', a => [a.name], { bindBot: false });
w('getNearbyBlockTypes', { radius: radius(16) }, 'Synchronously list distinct nearby block names.', a => [a.radius]);
w('isClearPath', { target: field('entity') }, 'Check whether an observed target Entity can be reached without digging/placing/opening doors. Returns Promise<boolean>.', a => [a.target]);

p('find', { text: optional(text()), kind: optional(enumeration(placeKinds)), purpose: optional(text()), dimension: optional(text()), existence: optional(enumeration(['observed', 'unverified', 'missing'])), staleBefore: optional(field('timestamp')), limit: positiveInt({ default: 20, max: 100 }) }, 'Find persistent place records by optional text and filters. Returns structured records with stable IDs.', a => [a,], { argsObject: true });
for (const [name, description] of [
    ['inspect', 'Read a saved place and linked storage by stable ID as a structured record; missing ID throws. Check observation status and time before using recorded coordinates.'],
    ['verify', 'Reobserve a saved place in the current dimension and update its observation record. Loaded target blocks or proximity to representative points are required. Missing, unknown and verified are query results.'],
    ['setHome', 'Set this bot’s home preference to an existing stable place ID.'],
    ['goTo', 'Navigate to a saved stable place ID in the current dimension. Inspect travel status; arrival must be confirmed.'],
]) p(name, { placeId: text() }, description, a => [a.placeId], name === 'verify' ? { kind: 'query' } : {});
p('resolveAlias', { alias: text() }, 'Resolve this bot’s personal alias/home preference to a place snapshot or null.', a => [a.alias]);
p('goToAlias', { alias: text() }, 'Resolve this bot’s alias then navigate; missing alias throws. Inspect travel status.', a => [a.alias]);
p('rememberHere', { name: text(), kind: enumeration(['other', 'base'], { default: 'other' }), purpose: field('stringValue', { default: '' }) }, 'Save current observed representative point, not the whole facility boundary; storage/farm records require rememberObservedAt. Returns a structured record.', a => [a.name, a.kind, a.purpose]);
p('rememberObservedAt', { name: text(), kind: enumeration(placeKinds), purpose: field('stringValue', { default: '' }), position: position() }, 'Record a loaded block matching kind. Storage requires chest/trapped_chest. base and other record only a representative point, not the whole facility boundary. Use other with the facility purpose when no dedicated kind fits. Returns a structured record.', a => [a.name, a.kind, a.purpose, a.position]);
p('rememberReported', { name: text(), kind: enumeration(placeKinds), purpose: field('stringValue', { default: '' }), position: position(), dimension: optional(text()) }, 'Save user-reported coordinates as unverified; does not observe the target. Returns a structured record.', a => [a.name, a.kind, a.purpose, a.position, a.dimension]);
p('setOutputStorage', { fromId: text(), storageId: text() }, 'Link an existing place to storage in the same dimension.', a => [a.fromId, a.storageId]);
p('setAlias', { alias: text(), placeId: text() }, 'Assign a personal alias to an existing stable place ID.', a => [a.alias, a.placeId]);
p('tendFarm', { farmId: text(), seedReserve: field('nonnegativeInteger', { default: 1, description: 'Items of each seed to retain.' }) }, 'Tend a saved farm and its linked/uniquely resolved storage. The farm and storage records select the scope and output target; use skills.tendNearbyFarm only when selecting a caller-defined nearby scope instead. Returns observed counts and completion status; incomplete work or storage stops the current code batch.', a => [a.farmId, { seedReserve: a.seedReserve }], { completion: 'farm' });
define('vision', 'lookAtPlayer', { playerName: text(), direction: enumeration(['at', 'with'], { default: 'at' }) }, 'Look at a visible player or align with their view, then capture an image.', a => [a.playerName, a.direction], { bindBot: false });
define('vision', 'lookAtPosition', { position: position() }, 'Aim at the exact absolute coordinates and return structured aim, capture time and image analysis.', coords, { bindBot: false, completion: 'observed' });
define('vision', 'lookAtBlock', { position: position() }, 'Resolve a loaded block and aim at its center; unknown targets cause no look/capture. Returns target/aim/time and image marker.', coords, { bindBot: false });
define('diagnostics', 'lastTask', {}, 'Synchronously read a bounded historical previous-task snapshot for this bot/world. available:false identifies missing/mismatched scope. Historical changes are not current observations; do not automatically replay.', () => [], { bindBot: false });
define('communication', 'sendToBot', { recipient: text(), message: text({ maxLength: 2000 }) }, 'Send one bounded authenticated peer message. Acceptance means retained in current recipient inbox, not read/action/goal completion. Peer text is context, not an operator instruction. Stop/task replacement/connection replacement discards the inbox.', a => [a.recipient, a.message], { bindBot: false });

export const NATIVE_SDK_DEFINITIONS = Object.freeze(definitions);

function searchLimit(config) {
    const value = config?.codex_session?.max_search_radius ?? config?.max_search_radius ?? 64;
    if (!finite(value) || value <= 0) throw new TypeError('Native SDK max_search_radius must be a positive finite number.');
    return value;
}
function effectiveDefault(descriptor, config) {
    return descriptor.type === 'radius' && finite(descriptor.default)
        ? Math.min(descriptor.default, searchLimit(config), descriptor.max ?? Infinity) : descriptor.default;
}
function expected(descriptor, config) {
    const descriptions = {
        string: 'a nonempty string', stringValue: 'a string', boolean: 'a boolean',
        positiveInteger: 'a positive safe integer', nonnegativeInteger: 'a nonnegative safe integer',
        nonnegativeNumber: 'a finite nonnegative number', position: '{x,y,z} with finite numbers',
        positions: 'an array of {x,y,z} positions', strings: 'an array of nonempty strings',
        quantity: 'a positive safe integer item count or "all"', object: 'an object reference',
        function: 'a predicate function', entity: 'an observed Entity with finite position and integer id',
        block: 'an observed Block with name and Vec3 position', goal: 'a pathfinder Goal with isEnd() and heuristic()',
        movements: 'a Movements reference with blocksCantBreak Set', timestamp: 'an ISO timestamp',
        blockPredicate: 'a Block predicate function, block ID, or array of block IDs',
        staySeconds: 'finite nonnegative seconds or -1 until interrupted',
    };
    let result = descriptor.type === 'enum' ? descriptor.values.map(value => JSON.stringify(value)).join(' | ')
        : descriptor.type === 'radius' ? `a finite ${descriptor.positive ? 'positive' : 'nonnegative'} radius <= ${Math.min(searchLimit(config), descriptor.max ?? Infinity)}`
        : descriptions[descriptor.type];
    if (descriptor.max) result += ` <= ${descriptor.max}`;
    if (descriptor.maxLength) result += ` (at most ${descriptor.maxLength} characters)`;
    if (descriptor.nullable) result += ' or null';
    return result;
}
function signature(definition) {
    const fields = Object.entries(definition.fields).map(([key, descriptor]) => `${key}${descriptor.optional || has(descriptor, 'default') ? '?' : ''}`);
    return `${definition.namespace}.${definition.name}(${fields.length ? `{${fields.join(', ')}}` : ''})`;
}
function sampleValue(descriptor, config) {
    if (has(descriptor, 'default') && descriptor.default !== undefined) return JSON.stringify(effectiveDefault(descriptor, config));
    switch (descriptor.type) {
        case 'string': case 'stringValue': return '"example"';
        case 'enum': return JSON.stringify(descriptor.values[0]);
        case 'position': return '{x:10,y:64,z:-3}';
        case 'positions': return '[]';
        case 'strings': return '["chest"]';
        case 'boolean': return 'true';
        case 'function': return 'entity => entity.name === "cow"';
        case 'blockPredicate': return 'block => block.name === "chest"';
        case 'entity': return 'world.getNearbyEntities()[0]';
        case 'block': return 'world.getNearestBlock({blockType:"chest"})';
        case 'goal': return 'observedGoal';
        case 'movements': return 'observedMovements';
        case 'object': return 'observedEntity';
        case 'timestamp': return '"2026-10-07T00:00:00Z"';
        default: return '1';
    }
}
function example(definition, config = {}) {
    const fields = Object.entries(definition.fields).filter(([, descriptor]) => !descriptor.optional);
    return `${definition.namespace}.${definition.name}(${fields.length ? `{${fields.map(([key, descriptor]) => `${key}:${sampleValue(descriptor, config)}`).join(', ')}}` : ''})`;
}

export class SdkArgumentError extends TypeError {
    constructor(definition, fieldName, expectation, config = {}) {
        const method = `${definition.namespace}.${definition.name}`;
        const publicSignature = signature(definition);
        const correction = example(definition, config);
        super(`${method}: ${fieldName} must be ${expectation}. Signature: ${publicSignature}. Example: ${correction}`);
        Object.assign(this, { name: 'SdkArgumentError', code: 'INVALID_ARGUMENT', method,
            field: fieldName, expected: expectation, signature: publicSignature, example: correction });
    }
}

function validateValue(value, descriptor, fieldName, fail, config) {
    const reject = () => fail(fieldName, expected(descriptor, config));
    if (value === null && descriptor.nullable) return;
    let valid;
    switch (descriptor.type) {
        case 'string': valid = nonempty(value); break;
        case 'stringValue': valid = typeof value === 'string'; break;
        case 'boolean': valid = typeof value === 'boolean'; break;
        case 'positiveInteger': valid = integer(value) && value > 0; break;
        case 'nonnegativeInteger': valid = integer(value) && value >= 0; break;
        case 'nonnegativeNumber': valid = finite(value) && value >= 0; break;
        case 'radius': valid = finite(value) && (descriptor.positive ? value > 0 : value >= 0) && value <= searchLimit(config); break;
        case 'staySeconds': valid = finite(value) && (value >= 0 || value === -1); break;
        case 'quantity': valid = value === 'all' || integer(value) && value > 0; break;
        case 'enum': valid = descriptor.values.includes(value); break;
        case 'function': valid = typeof value === 'function'; break;
        case 'blockPredicate': valid = typeof value === 'function' || integer(value) && value >= 0 || Array.isArray(value) && value.every(id => integer(id) && id >= 0); break;
        case 'strings': valid = Array.isArray(value) && value.every(nonempty); break;
        case 'object': valid = objectLike(value); break;
        case 'goal': valid = objectLike(value) && typeof value.isEnd === 'function' && typeof value.heuristic === 'function'; break;
        case 'movements': valid = objectLike(value) && typeof value.blocksCantBreak?.add === 'function'; break;
        case 'timestamp': valid = nonempty(value) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)); break;
        case 'entity': valid = objectLike(value) && integer(value.id) && objectLike(value.position) && ['x', 'y', 'z'].every(axis => finite(value.position[axis])); break;
        case 'block': valid = objectLike(value) && nonempty(value.name) && objectLike(value.position) && ['x', 'y', 'z'].every(axis => finite(value.position[axis])) && typeof value.position.offset === 'function'; break;
        case 'position': {
            if (!objectLike(value)) return reject();
            for (const key of Object.keys(value)) if (!['x', 'y', 'z'].includes(key)) fail(`${fieldName}.${key}`, 'a recognized coordinate field (x, y, z)');
            for (const axis of ['x', 'y', 'z']) if (!finite(value[axis])) fail(`${fieldName}.${axis}`, 'a finite number');
            valid = true; break;
        }
        case 'positions': {
            if (!Array.isArray(value)) return reject();
            value.forEach((point, index) => validateValue(point, position(), `${fieldName}[${index}]`, fail, config));
            valid = true; break;
        }
        default: throw new Error(`Unknown native SDK field type: ${descriptor.type}`);
    }
    if (!valid || descriptor.max !== undefined && typeof value === 'number' && value > descriptor.max
        || descriptor.maxLength !== undefined && typeof value === 'string' && value.length > descriptor.maxLength) reject();
}
function validateInput(definition, callArgs, config) {
    const fail = (key, expectation) => { throw new SdkArgumentError(definition, key, expectation, config); };
    if (callArgs.length > 1) fail('arguments', 'one named object; omit bot and positional arguments');
    let input = callArgs[0];
    if (input === undefined) {
        if (callArgs.length) fail('arguments', 'one named object; omit the argument instead of passing undefined');
        if (Object.values(definition.fields).some(descriptor => !descriptor.optional && !has(descriptor, 'default'))) fail('arguments', 'one named object with all required fields');
        input = {};
    }
    if (!objectLike(input)) fail('arguments', 'one named object (not null, an array, or positional values)');
    for (const key of Object.keys(input)) if (!has(definition.fields, key)) fail(key, `a recognized field: ${Object.keys(definition.fields).join(', ') || '(no input fields)'}`);
    const normalized = {};
    for (const [key, descriptor] of Object.entries(definition.fields)) {
        let value = has(input, key) ? input[key] : effectiveDefault(descriptor, config);
        if (value === undefined) {
            if (has(input, key) || !descriptor.optional) fail(key, expected(descriptor, config));
            continue;
        }
        validateValue(value, descriptor, key, fail, config);
        normalized[key] = value;
    }
    definition.constraint?.(normalized, fail);
    if (definition.name === 'tendNearbyFarm' || definition.name === 'tendFarm') {
        const radiusKey = normalized.scope === 'radius' ? 'radius' : 'searchRadius';
        if (!has(normalized, radiusKey)) normalized[radiusKey] = Math.min(32, searchLimit(config));
    }
    return normalized;
}

const availability = Object.freeze({
    skills: 'Host-bound bot and current owned operation; existing cancellation, false-mode and server-confirmation rules apply.',
    world: 'Host-bound bot; observations retain synchronous return values.',
    places: 'settings.place_memory_enabled, configured place_world_id and available place store.',
    vision: 'settings.allow_vision and native owned task. Captures attach JPEG directly to operation results (up to four images, each at most 2 MiB). Interpret images yourself; no separate vision_model is required.',
    diagnostics: 'Native runtime and configured place_world_id; absent scope/record returns available:false.',
    communication: 'Native runtime, authenticated MindServer management connection and active owned task operation.',
});

export function getNativeSdkDocs(config = {}) {
    searchLimit(config);
    return definitions.map(definition => {
        const fields = Object.entries(definition.fields).map(([key, descriptor]) => {
            const requirement = has(descriptor, 'default') && descriptor.default !== undefined ? `default ${JSON.stringify(effectiveDefault(descriptor, config))}` : descriptor.optional ? 'optional' : 'required';
            return `${key}: ${expected(descriptor, config)}; ${requirement}${descriptor.description ? `. ${descriptor.description}` : ''}.`;
        });
        const policy = definition.navigationPolicy
            ? `\nFixed implicit-route policy: allowDig=${definition.navigationPolicy.allowDig}, scaffold=${definition.navigationPolicy.scaffold}. This policy applies to this skill's movement and plugin pathing; work targets retain the skill's own permissions.` : '';
        return `${definition.namespace}.${definition.name}\nSignature: ${signature(definition)}. Host binds the bot; pass only one named object. ${Object.keys(definition.fields).length ? Object.values(definition.fields).every(d => d.optional || has(d, 'default')) ? 'Input may be omitted; defaults apply.' : 'Required fields must be supplied.' : 'Accepts () or ({}).'}\n${definition.description}${policy}\n${fields.join('\n')}\nNative execution: minecraft_execute stops on action false/error/ok:false; queries remain data. Failure blocks further SDK calls even after catch or omitted await. The host owns cancellation and execution_window_ms yielding. These guarantees cover SDK calls.\nExample: ${example(definition, config)}\nRuntime availability: ${availability[definition.namespace]}\nSearch-radius defaults are capped by max_search_radius (${searchLimit(config)}). Invalid input throws SdkArgumentError (INVALID_ARGUMENT) before this method calls the internal SDK. Raw bot/plugin access is outside this guarantee.`;
    });
}

export function getNativeSdkMethodNames() {
    return definitions.map(definition => `${definition.namespace}.${definition.name}`);
}

export function getNativeSdkExecutionMetadata() {
    return Object.freeze(Object.fromEntries(definitions.map(d => [`${d.namespace}.${d.name}`, Object.freeze({ kind: d.kind, completion: d.completion })])));
}

const movementResultMethods = new Set(['goToPosition', 'reachPosition']);

function compactNavigationResult(value, requireCleanup = false) {
    if (!objectLike(value)) return value;
    const result = { ...value };
    if (Array.isArray(value.edits)) delete result.edits;
    if (Array.isArray(value.cleanupRequired)) delete result.cleanupRequired;
    if (objectLike(value.result) && (Array.isArray(value.result.edits) || Array.isArray(value.result.cleanupRequired))) {
        result.result = compactNavigationResult(value.result);
    }
    if (requireCleanup && value.cleanupRequired?.length && value.ok === true) {
        result.ok = false;
        result.status = 'blocked';
        result.code = 'cleanup_incomplete';
        result.reason = 'Required scaffold cleanup is incomplete.';
    }
    return result;
}

export function createNativeSdk(bindings, config = {}) {
    searchLimit(config);
    const namespaces = {};
    for (const definition of definitions) {
        const namespace = namespaces[definition.namespace] ??= {};
        namespace[definition.name] = (...callArgs) => {
            const input = validateInput(definition, callArgs, config);
            const internalName = definition.namespace === 'skills' && definition.name === 'craftItem' ? 'craftItem'
                : definition.namespace === 'skills' && definition.name === 'inspectChest' ? 'inspectChest'
                : definition.namespace === 'world' && definition.name === 'getBlockAtOffset' ? 'getBlockAtPosition'
                : definition.namespace === 'skills' && definition.name === 'useToolOnBlock' ? 'useToolOnBlockAt'
                : definition.namespace === 'places' && definition.name === 'find' ? 'findRecords'
                : definition.namespace === 'places' && definition.name === 'inspect' ? 'inspectRecord'
                : definition.namespace === 'places' && definition.name === 'rememberHere' ? 'rememberHereRecord'
                : definition.namespace === 'places' && definition.name === 'rememberObservedAt' ? 'rememberObservedAtRecord'
                : definition.namespace === 'places' && definition.name === 'rememberReported' ? 'rememberReportedRecord'
                : definition.name;
            const namespaceBindings = bindings[definition.namespace];
            const internal = namespaceBindings?.[internalName] ?? namespaceBindings?.[definition.name];
            if (typeof internal !== 'function') throw new Error(`${definition.namespace}.${definition.name} is unavailable in this runtime.`);
            let args;
            if (definition.namespace === 'skills' && definition.name === 'goToPosition') {
                const policy = definition.navigationPolicy;
                args = [{ position: input.position, arrivalMode: 'block', allowDig: policy.allowDig, scaffold: policy.scaffold, scaffoldBlocks: [...policy.scaffoldBlocks] }];
            } else if (definition.namespace === 'skills' && definition.name === 'reachPosition') {
                const policy = definition.navigationPolicy;
                args = [{ position: input.position, arrivalMode: 'block', allowDig: policy.allowDig, allowScaffold: policy.scaffold !== 'forbid', scaffoldBlocks: [...policy.scaffoldBlocks], safeWater: false, cleanupOwnedScaffolds: false }];
            } else if (definition.namespace === 'skills' && definition.name === 'craftItem') {
                args = [input.itemName, input.quantity];
            } else if (definition.namespace === 'skills' && definition.name === 'inspectChest') {
                args = [input.position];
            } else if (definition.namespace === 'skills' && definition.name === 'smeltItem') {
                args = [input.itemName, input.quantity, { furnacePosition: input.furnacePosition, returnDetails: true }];
            } else if (definition.namespace === 'skills' && definition.name === 'clearNearestFurnace') {
                args = [{ furnacePosition: input.furnacePosition }];
            } else if (definition.namespace === 'skills' && definition.name === 'activateNearestBlock') {
                args = [input.blockType, input.position];
            } else if (definition.namespace === 'skills' && definition.name === 'useToolOnBlock') {
                args = [input.toolName, input.position];
            } else if (definition.namespace === 'skills' && definition.name === 'useItem') {
                args = [input.itemName];
            } else if (definition.namespace === 'skills' && definition.name === 'showVillagerTrades') {
                args = [input.entityId, true];
            } else if (definition.namespace === 'vision' && definition.name === 'lookAtPosition') {
                args = [...coords(input), 0];
            } else if (definition.namespace === 'places' && definition.name === 'find') {
                args = typeof namespaceBindings?.findRecords === 'function' ? [input]
                    : [input.text ?? '', Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'text'))];
            } else if (definition.namespace === 'places' && definition.name === 'tendFarm') {
                args = [input.farmId, { seedReserve: input.seedReserve }];
            } else if (definition.namespace === 'skills' && definition.name === 'tendNearbyFarm') {
                args = [{ ...definition.args(input), keepHarvestInInventory: true }];
            } else if (definition.namespace === 'skills' && ['putInChest', 'takeFromChest'].includes(definition.name)) {
                args = [input.itemName, allQuantity(input.quantity), input.chestPosition ? { chestPosition: input.chestPosition, details: true } : { details: true }];
            } else {
                args = definition.argsObject ? [definition.args(input)] : definition.args(input);
            }
            // Internal skills/places/vision already retain their ownership wrappers.
            // Preserve pure synchronous world results by never making this wrapper async.
            const invoke = () => {
                const context = operationContext();
                const factStart = context?.facts.length ?? 0;
                const uncertaintyStart = context?.uncertain.length ?? 0;
                const call = internal(...(definition.bindBot ? [bindings.bot, ...args] : args));
                if (definition.kind !== 'action' || !call?.then || definition.completion === 'truthy') return call;
                return call.then(value => projectDomainResult(definition, value, context, factStart, uncertaintyStart, input));
            };
            const isPositionMove = definition.namespace === 'skills' && movementResultMethods.has(definition.name);
            const result = definition.navigationPolicy && !isPositionMove
                ? runWithNavigationPolicy(bindings.bot, definition.navigationPolicy, invoke) : invoke();
            if (!(definition.namespace === 'skills' && movementResultMethods.has(definition.name))) return result;
            const compact = value => compactNavigationResult(value, definition.name === 'goToPosition');
            return result?.then ? result.then(compact) : compact(result);
        };
    }
    return Object.freeze(Object.fromEntries(Object.entries(namespaces).map(([key, value]) => [key, Object.freeze(value)])));
}

function projectDomainResult(definition, value, context, factStart, uncertaintyStart, input) {
    const facts = context?.facts.slice(factStart) ?? [];
    const uncertain = context?.uncertain.slice(uncertaintyStart) ?? [];
    const method = `${definition.namespace}.${definition.name}`;
    if (definition.completion === 'complete' && method === 'skills.craftItem') {
        if (value && typeof value === 'object' && Number.isFinite(value.confirmedQuantity)) return value;
        const recipe = facts.find(f => f.unit === 'recipe')?.target;
        const itemFact = [...facts].reverse().find(f => f.unit === 'item');
        const confirmed = recipe?.resultCount && facts.filter(f => f.unit === 'recipe').length
            ? facts.filter(f => f.unit === 'recipe').length * recipe.resultCount : itemFact?.quantity ?? 0;
        const requested = input.quantity;
        return { ok: value?.ok === true, status: value?.status ?? (value?.ok ? (confirmed >= requested ? 'complete' : 'partial') : 'blocked'),
            itemName: input.itemName, requestedQuantity: requested, confirmedQuantity: confirmed, remainingQuantity: Math.max(0, requested - confirmed),
            ...(value?.reason ? { reason: value.reason } : {}) };
    }
    if (definition.completion === 'complete' && method === 'skills.smeltItem') {
        const result = value && typeof value === 'object' ? value : null;
        if (result) return result;
        return { ok: value === true, status: value === true ? 'complete' : uncertain.length ? 'unknown' : 'blocked',
            requestedQuantity: input.quantity, confirmedQuantity: facts.find(f => f.unit === 'item')?.quantity ?? (value === true ? input.quantity : uncertain[0]?.confirmedQuantity ?? 0),
            remainingQuantity: Math.max(0, input.quantity - (facts.find(f => f.unit === 'item')?.quantity ?? (value === true ? input.quantity : 0))), itemName: input.itemName };
    }
    if (definition.completion === 'complete' && ['skills.putInChest', 'skills.takeFromChest'].includes(method)) {
        if (value && typeof value === 'object' && Object.hasOwn(value, 'confirmedQuantity')) return value;
        const fact = [...facts, ...uncertain].reverse().find(f => f.unit === 'item' && f.target?.itemName === input.itemName || f.unit === 'item' && f.target === input.itemName);
        const requested = fact?.requestedQuantity ?? (input.quantity === 'all' ? null : input.quantity);
        const confirmed = fact?.quantity ?? fact?.confirmedQuantity ?? (value === true ? requested : 0);
        const complete = requested == null ? value === true : confirmed === requested;
        return { ok: value === true && complete, status: complete ? 'complete' : confirmed == null ? 'unknown' : confirmed > 0 ? 'partial' : 'blocked',
            itemName: input.itemName, requestedQuantity: requested, confirmedQuantity: confirmed,
            remainingQuantity: requested == null || confirmed == null ? null : Math.max(0, requested - confirmed), ...(fact?.reason ? { reason: fact.reason } : {}) };
    }
    if (definition.completion === 'farm') {
        const result = value?.result ?? value;
        const noWork = result?.status === 'no_work' && result?.ok === true;
        const complete = result?.status === 'complete' && result?.ok === true;
        return { ...result, ok: noWork || complete, status: noWork ? 'no_work' : complete ? 'complete' : result?.status ?? 'blocked',
            remainingWork: result?.remainingWork ?? null };
    }
    return value;
}
