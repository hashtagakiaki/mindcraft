import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import {
    operationContext, recordConfirmation, recordUncertainty,
    beginOwnedWait, finishOwnedWait, registerOwnedPromise,
} from './operation_context.js';

const HORIZONTAL = ['north', 'south', 'east', 'west'];
const DIRECTIONS = {
    north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0],
    top: [0, 1, 0], bottom: [0, -1, 0],
};
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' };
const EMPTY = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern', 'dead_bush', 'snow']);
const SIX_WAY = new Set(['observer', 'piston', 'sticky_piston', 'dispenser', 'dropper']);
const HORIZONTAL_BLOCKS = new Set(['furnace', 'blast_furnace', 'smoker', 'chest', 'trapped_chest', 'repeater', 'comparator']);
const TORCH_ITEMS = new Set(['torch', 'redstone_torch', 'soul_torch']);
const OPTION_KEYS = new Set(['facing', 'axis', 'half', 'attachTo']);
const PLACEMENT_RANGE = 4.5;
const PLACEMENT_CONFIRM_TIMEOUT_MS = 5000;
const CANCEL_POLL_INTERVAL_MS = 25;
const LOOK_CONFIRM_TIMEOUT_MS = 3000;
const LOOK_TOLERANCE_DEGREES = 0.1;
const LOOK_REFRESH_YAW_RADIANS = 0.01;
const DEFAULT_SUPPORT_ORDER = ['bottom', 'top', 'north', 'south', 'east', 'west'];
const SNEAK_EYE_HEIGHT = 1.27;
const STANDING_EYE_HEIGHT = 1.62;

function familyOf(name) {
    if (HORIZONTAL_BLOCKS.has(name)) return 'horizontal';
    if (SIX_WAY.has(name)) return 'six-way';
    if (name.endsWith('_stairs')) return 'stairs';
    if (name.endsWith('_slab')) return 'slab';
    if (/_(log|wood|stem|hyphae)$/.test(name)) return 'axis';
    if (TORCH_ITEMS.has(name) || name.includes('wall_torch')) return 'torch';
    if (name === 'ladder') return 'wall';
    if (name === 'lever' || name.endsWith('_button')) return 'mount';
    if (name.endsWith('_door')) return 'door';
    if (name.endsWith('_bed')) return 'bed';
    if (['stone', 'cobblestone', 'dirt', 'crafting_table'].includes(name) || name.endsWith('_planks')) return 'plain';
    throw new Error(`Oriented placement is not supported for ${name}.`);
}

export function normalizePlacement(bot, blockType, position, options) {
    if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) throw new Error('Placement coordinates must be finite.');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Placement options must be an object.');
    if (typeof blockType !== 'string' || !/^[a-z0-9_]+$/.test(blockType)) throw new Error('Use a block/item name without block state syntax.');
    for (const key of Object.keys(options)) if (!OPTION_KEYS.has(key)) throw new Error(`Unknown placement option: ${key}.`);
    const family = familyOf(blockType);
    const allowed = new Set(['attachTo']);
    if (['horizontal', 'six-way', 'stairs', 'torch', 'wall', 'mount', 'door', 'bed'].includes(family)) allowed.add('facing');
    if (family === 'axis') allowed.add('axis');
    if (family === 'stairs' || family === 'slab') allowed.add('half');
    for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error(`${key} is not supported for ${blockType}.`);
    if ('attachTo' in options && !Object.hasOwn(DIRECTIONS, options.attachTo)) throw new Error('attachTo must be top, bottom, north, south, east, or west.');
    if ('facing' in options && ![...HORIZONTAL, ...(family === 'six-way' ? ['up', 'down'] : [])].includes(options.facing)) throw new Error(`Invalid facing for ${blockType}.`);
    if ('axis' in options && !['x', 'y', 'z'].includes(options.axis)) throw new Error('axis must be x, y, or z.');
    if ('half' in options && !['top', 'bottom'].includes(options.half)) throw new Error('half must be top or bottom.');
    let name = blockType;
    let item = blockType.replace('wall_torch', 'torch');
    let attachTo = options.attachTo;
    const properties = {};
    if (options.facing) properties.facing = options.facing;
    if (options.axis) properties.axis = options.axis;
    if (options.half) properties[family === 'slab' ? 'type' : 'half'] = options.half;
    if (family === 'wall' || family === 'torch') {
        if (!attachTo && options.facing) attachTo = OPPOSITE[options.facing];
        if (!attachTo) attachTo = family === 'torch' && TORCH_ITEMS.has(blockType) ? 'bottom' : 'south';
        if (attachTo === 'top' || (family === 'wall' && attachTo === 'bottom')) throw new Error(`${blockType} requires a wall or supported floor.`);
        if (attachTo !== 'bottom') {
            if (options.facing && options.facing !== OPPOSITE[attachTo]) throw new Error('facing conflicts with attachTo.');
            properties.facing = OPPOSITE[attachTo];
            if (family === 'torch') name = item.replace('torch', 'wall_torch');
        } else if (options.facing) throw new Error('A floor torch has no facing; use a wall support.');
    }
    if (family === 'mount') {
        attachTo ??= 'bottom';
        properties.face = attachTo === 'bottom' ? 'floor' : attachTo === 'top' ? 'ceiling' : 'wall';
        if (properties.face === 'wall') {
            if (options.facing && options.facing !== OPPOSITE[attachTo]) throw new Error('facing conflicts with attachTo.');
            properties.facing = OPPOSITE[attachTo];
        }
    }
    if (family === 'door' || family === 'bed' || ['repeater', 'comparator'].includes(name)) {
        if (attachTo && attachTo !== 'bottom') throw new Error(`${name} requires floor placement.`);
        attachTo = 'bottom';
    }
    const block = bot.registry?.blocksByName?.[name];
    if (!block || !bot.registry?.itemsByName?.[item]) throw new Error(`Unknown block or placement item: ${blockType}.`);
    for (const [key, value] of Object.entries(properties)) {
        const state = block.states?.find(entry => entry.name === key);
        if (!state?.values?.includes(value)) throw new Error(`${name} does not support ${key}=${value}.`);
    }
    return { name, item, family, position: new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)),
        properties, attachTo, facing: properties.facing ?? 'north',
        axis: properties.axis ?? (['east', 'west'].includes(attachTo) ? 'x' : ['north', 'south'].includes(attachTo) ? 'z' : 'y'),
        half: options.half ?? (attachTo === 'top' ? 'top' : 'bottom') };
}

function expectedBlocks(request, facing = request.facing) {
    const blocks = [{ position: request.position, name: request.name, properties: { ...request.properties } }];
    if (request.family === 'door') {
        blocks[0].properties.half = 'lower';
        blocks.push({ position: request.position.offset(0, 1, 0), name: request.name, properties: { ...request.properties, facing, half: 'upper' } });
    }
    if (request.family === 'bed') {
        const [x, y, z] = DIRECTIONS[facing];
        blocks[0].properties.part = 'foot';
        blocks.push({ position: request.position.offset(x, y, z), name: request.name, properties: { ...request.properties, facing, part: 'head' } });
    }
    return blocks;
}

function snapshot(bot, targets) {
    return targets.map(({ position }) => {
        const block = bot.blockAt(position);
        return { position: { x: position.x, y: position.y, z: position.z },
            name: block?.name ?? null, properties: block?.getProperties?.() ?? null };
    });
}

function matches(block, expected) {
    const state = block?.getProperties?.() ?? {};
    return block?.name === expected.name && Object.entries(expected.properties).every(([key, value]) => state[key] === value);
}

function cancelled(bot) {
    const owner = operationContext();
    return bot.interrupt_code || owner?.closed || owner?.signal.aborted || bot.getActionCancellationContext?.()?.signal?.aborted;
}

function assertEmpty(bot, targets) {
    for (const target of targets) {
        const block = bot.blockAt(target.position);
        if (!block) throw new Error(`Placement target is not observed at ${target.position}.`);
        if (!EMPTY.has(block.name)) throw new Error(`Placement target is occupied by ${block.name} at ${target.position}; it was not replaced.`);
    }
}

function observePlacement(bot, targets) {
    let finish, timer, cancelTimer;
    const updatedPositions = new Set();
    const key = position => `${position.x},${position.y},${position.z}`;
    const onUpdate = (_old, block) => {
        if (block && targets.some(target => key(target.position) === key(block.position))) {
            updatedPositions.add(key(block.position));
            if (targets.every(target => updatedPositions.has(key(target.position)) && matches(bot.blockAt(target.position), target))) finish(true);
        }
    };
    const promise = new Promise(resolve => {
        let settled = false;
        finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer); clearInterval(cancelTimer);
            bot.removeListener('blockUpdate', onUpdate);
            resolve(value);
        };
        bot.on('blockUpdate', onUpdate);
        timer = setTimeout(() => finish(false), PLACEMENT_CONFIRM_TIMEOUT_MS);
        cancelTimer = setInterval(() => { if (cancelled(bot)) finish(false); }, CANCEL_POLL_INTERVAL_MS);
    });
    return { promise, cleanup: () => finish(false) };
}

function supportDirections(request) {
    let directions = [...DEFAULT_SUPPORT_ORDER];
    if (request.family === 'axis') directions = request.axis === 'x' ? ['east', 'west'] : request.axis === 'z' ? ['north', 'south'] : ['bottom', 'top'];
    if (request.family === 'stairs' || request.family === 'slab') directions = directions.filter(side => side !== (request.half === 'top' ? 'bottom' : 'top'));
    if (request.attachTo) {
        if (!directions.includes(request.attachTo)) throw new Error('attachTo conflicts with the requested axis or half.');
        directions = [request.attachTo];
    }
    return directions;
}

function headingFor(request) {
    if (request.name === 'observer') return request.facing;
    if (['horizontal', 'six-way'].includes(request.family)) return OPPOSITE[request.facing];
    if (request.family === 'mount' && request.properties.face === 'wall') return undefined;
    if (['stairs', 'door', 'bed', 'mount'].includes(request.family)) return request.facing;
    return undefined;
}

export function makePlacementGoal(bot, request, targets = expectedBlocks(request)) {
    const faces = supportDirections(request).map(side => new Vec3(...DIRECTIONS[side])).filter(direction => {
        const block = bot.blockAt(request.position.plus(direction));
        return block && !EMPTY.has(block.name) && block.shapes?.length;
    });
    if (!faces.length) throw new Error('No observed usable support for the requested placement.');
    const heading = headingFor(request);
    // Pathfinder 2.4.5 reverses the horizontal direction in checkFacing.
    const facing = HORIZONTAL.includes(heading) ? OPPOSITE[heading] : heading;
    const goal = new pf.goals.GoalPlaceBlock(request.position, bot.world, {
        faces, facing, facing3D: request.family === 'six-way',
        range: PLACEMENT_RANGE, LOS: true,
    });
    if (request.family === 'stairs' || request.family === 'slab') {
        // Pathfinder's half filter rejects a floor's top face for bottom
        // placement. Only side clicks need a cursor-height constraint.
        const sideGoal = new pf.goals.GoalPlaceBlock(request.position, bot.world, {
            faces: faces.filter(direction => direction.y === 0), facing,
            half: request.half, range: PLACEMENT_RANGE, LOS: true,
        });
        goal.facesPos = goal.facesPos.filter(([direction]) => direction.y !== 0).concat(sideGoal.facesPos);
    }
    const interactable = bot.pathfinder.movements?.interactableBlocks ?? new pf.Movements(bot).interactableBlocks;
    // Interactive supports require crouching. Ordinary supports can use
    // either posture; prefer standing at placement time to preserve normal use.
    goal.isEnd = node => {
        if (goal.isStandingIn(node)) return false;
        const currentCell = bot.entity.position.floored();
        // A route node uses the cell centre, but a bot can start at its edge.
        // Do not accept "already at goal" unless its real position works.
        // Pathfinder also tries currentCell + (0,1,0) for partial floor blocks.
        // That arrival shortcut must use the real pose as well.
        const head = node.x === currentCell.x && node.z === currentCell.z &&
            (node.y === currentCell.y || node.y === currentCell.y + 1)
            ? bot.entity.position.offset(0, SNEAK_EYE_HEIGHT, 0)
            : node.offset(0.5, SNEAK_EYE_HEIGHT, 0.5);
        const standing = goal.getFaceAndRef(head.offset(0, STANDING_EYE_HEIGHT - SNEAK_EYE_HEIGHT, 0));
        const usableFace = goal.getFaceAndRef(head) !== null ||
            (standing && !interactable.has(bot.blockAt(standing.ref)?.name));
        return !!usableFace && targets.slice(1).every(target =>
            !(Math.floor(node.x) === target.position.x && Math.floor(node.z) === target.position.z &&
                (Math.floor(node.y) === target.position.y || Math.floor(node.y) + 1 === target.position.y)));
    };
    return goal;
}

function supportRequirements(bot, request, targets) {
    const supports = supportDirections(request).map(side => bot.blockAt(request.position.plus(new Vec3(...DIRECTIONS[side]))));
    if (!supports.some(block => block && !EMPTY.has(block.name) && block.shapes?.length)) throw new Error('Required support is missing or unobserved.');
    if (request.family === 'bed' || request.family === 'door' || ['repeater', 'comparator'].includes(request.name)) {
        const floorTargets = request.family === 'bed' ? targets : targets.slice(0, 1);
        for (const target of floorTargets) {
            const block = bot.blockAt(target.position.offset(0, -1, 0));
            if (!block || EMPTY.has(block.name) || !block.shapes?.length) throw new Error(`Required floor support is missing or unobserved at ${target.position}.`);
        }
    }
}

// Mineflayer 4.39.0 lookAt resolves on yaw convergence, before pitch may have
// been transmitted. Observe the existing physics writer; never craft packets.
async function lookAndConfirm(bot, point) {
    const client = bot._client;
    const originalWrite = client.write;
    let sentLook;
    const observeWrite = function (name, packet) {
        const value = originalWrite.apply(this, arguments);
        if (name === 'look' || name === 'position_look') sentLook = { yaw: packet.yaw, pitch: packet.pitch };
        return value;
    };
    client.write = observeWrite;
    const startedAt = Date.now();
    let timer, cancellationTimer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Placement yaw/pitch transmission timed out.')), LOOK_CONFIRM_TIMEOUT_MS);
        cancellationTimer = setInterval(() => { if (cancelled(bot)) reject(new Error('Placement look cancelled.')); }, CANCEL_POLL_INTERVAL_MS);
    });
    const look = () => registerOwnedPromise(bot.lookAt(point));
    const tick = () => registerOwnedPromise(bot.waitForTicks(1));
    try {
        await Promise.race([look(), deadline]);
        await Promise.race([tick(), deadline]);
        // A first placement already looking at the point may generate no look
        // packet. A small ordinary look change establishes a fresh observation.
        if (!sentLook) {
            await Promise.race([registerOwnedPromise(bot.look(bot.entity.yaw + LOOK_REFRESH_YAW_RADIANS, bot.entity.pitch, true)), deadline]);
            await Promise.race([tick(), deadline]);
            await Promise.race([look(), deadline]);
        }
        while (Date.now() - startedAt < LOOK_CONFIRM_TIMEOUT_MS) {
            if (cancelled(bot)) throw new Error('Placement look cancelled.');
            const expectedYaw = (Math.PI - bot.entity.yaw) * 180 / Math.PI;
            const expectedPitch = -bot.entity.pitch * 180 / Math.PI;
            const yawDifference = sentLook ? Math.abs(((sentLook.yaw - expectedYaw + 540) % 360 + 360) % 360 - 180) : Infinity;
            if (sentLook && yawDifference <= LOOK_TOLERANCE_DEGREES && Math.abs(sentLook.pitch - expectedPitch) <= LOOK_TOLERANCE_DEGREES) return;
            await Promise.race([tick(), deadline]);
        }
        throw new Error('Placement yaw/pitch transmission timed out.');
    } finally {
        clearTimeout(timer); clearInterval(cancellationTimer);
        if (client.write === observeWrite) client.write = originalWrite;
    }
}

export async function placeBlockOriented(bot, blockType, position, options, dontCheat, hooks) {
    const log = hooks?.log ?? (message => { bot.output = (bot.output ?? '') + message + '\n'; });
    let request, targets, observer, wait, oldMovements, movements, oldSneak, changedSneak = false;
    let placementError;
    const owner = operationContext();
    const context = owner?.cancellation ?? bot.getActionCancellationContext?.();
    const oldPhase = context?.phase ?? 'executing';
    const fail = reason => {
        const observed = targets ? snapshot(bot, targets) : [];
        recordUncertainty({ unit: 'block', requestedQuantity: 1, confirmedQuantity: null,
            target: { block: request?.name ?? blockType, position, requestedProperties: request?.properties ?? options },
            observedBlocks: observed, reason });
        log(`Oriented placement failed: ${reason}${observed.length ? ` Observed: ${JSON.stringify(observed)}` : ''}`);
        return false;
    };
    try {
        request = normalizePlacement(bot, blockType, position, options);
        if (cancelled(bot)) return fail('Action cancelled before placement.');
        const existing = bot.blockAt(request.position);
        if (!existing) return fail('Placement target observation is unknown.');
        const existingFacing = existing.getProperties?.().facing;
        targets = expectedBlocks(request, HORIZONTAL.includes(existingFacing) ? existingFacing : request.facing);
        if (targets.every(target => matches(bot.blockAt(target.position), target))) {
            supportDirections(request);
            if (Object.hasOwn(options, 'attachTo')) supportRequirements(bot, request, targets);
            recordConfirmation({ quantity: 0, unit: 'block', target: { block: request.name, position: request.position },
                observedBlocks: snapshot(bot, targets), evidence: 'existing requested state observed; no placement sent' });
            log(`Requested ${request.name} state already exists at ${request.position}; no item consumed.`);
            return true;
        }
        targets = expectedBlocks(request);
        assertEmpty(bot, targets);
        supportRequirements(bot, request, targets);
        if (bot.modes?.isOn('cheat') && !dontCheat) {
            if (bot.restrict_to_inventory && !bot.inventory.findInventoryItem(request.item)) return fail(`No ${request.item} in the restricted inventory.`);
            observer = observePlacement(bot, targets);
            wait = beginOwnedWait({ phase: 'placement-confirmation', reason: 'requested-block-state', timeoutMs: PLACEMENT_CONFIRM_TIMEOUT_MS, startedAt: new Date().toISOString() });
            context?.setPhase?.('placement-confirmation');
            for (const target of targets) {
                if (cancelled(bot)) return fail('Action cancelled during cheat placement.');
                const state = Object.entries(target.properties).map(([key, value]) => `${key}=${value}`).join(',');
                const { x, y, z } = target.position;
                bot.chat(`/setblock ${x} ${y} ${z} ${target.name}${state ? `[${state}]` : ''} keep`);
            }
        } else {
            let item = bot.inventory.findInventoryItem(request.item);
            if (!item && bot.game?.gameMode === 'creative' && !bot.restrict_to_inventory) {
                const { default: itemFactory } = await import('prismarine-item');
                const Item = itemFactory(bot.registry);
                await bot.creative.setInventorySlot(36, new Item(bot.registry.itemsByName[request.item].id, 1));
                item = bot.inventory.findInventoryItem(request.item);
            }
            if (!item) return fail(`No ${request.item} in the inventory.`);
            oldMovements = bot.pathfinder.movements;
            movements = new pf.Movements(bot);
            movements.canDig = false;
            movements.allow1by1towers = false;
            movements.scafoldingBlocks = [];
            movements.exclusionAreasStep.push(block => targets.some(target => target.position.equals(block.position)) ? Infinity : 0);
            bot.pathfinder.setMovements(movements);
            let goal = makePlacementGoal(bot, request, targets);
            let head = bot.entity.position.offset(0, SNEAK_EYE_HEIGHT, 0);
            let candidate = goal.isStandingIn(bot.entity.position.floored()) ? null : goal.getFaceAndRef(head);
            if (!candidate) await hooks.navigate(goal, movements);
            if (cancelled(bot)) return fail('Action cancelled before the placement packet.');
            assertEmpty(bot, targets);
            supportRequirements(bot, request, targets);
            // Crouch only to bypass an interactive support or when the face
            // geometry requires it. Unconditional crouching changes placement
            // semantics, including preventing adjacent chests from joining.
            head = bot.entity.position.offset(0, STANDING_EYE_HEIGHT, 0);
            candidate = goal.isStandingIn(bot.entity.position.floored()) ? null : goal.getFaceAndRef(head);
            const needsSneak = !candidate || movements.interactableBlocks.has(bot.blockAt(candidate.ref)?.name);
            oldSneak = bot.getControlState?.('sneak') ?? false;
            if (oldSneak !== needsSneak) {
                bot.setControlState('sneak', needsSneak);
                changedSneak = true;
                await bot.waitForTicks(2);
            }
            goal = makePlacementGoal(bot, request, targets);
            head = bot.entity.position.offset(0, needsSneak ? SNEAK_EYE_HEIGHT : STANDING_EYE_HEIGHT, 0);
            candidate = goal.isStandingIn(bot.entity.position.floored()) ? null : goal.getFaceAndRef(head);
            if (!candidate) return fail('No visible placement face at the final position and eye height.');
            const reference = bot.blockAt(candidate.ref);
            if (!reference) return fail('Placement support became unobserved.');
            item = bot.inventory.findInventoryItem(request.item);
            if (!item) return fail(`No ${request.item} remaining in the inventory.`);
            await bot.equip(item, 'hand');
            if (cancelled(bot)) return fail('Action cancelled before the placement packet.');
            await lookAndConfirm(bot, candidate.to);
            if (cancelled(bot)) return fail('Action cancelled before the placement packet.');
            assertEmpty(bot, targets);
            observer = observePlacement(bot, targets);
            wait = beginOwnedWait({ phase: 'placement-confirmation', reason: 'requested-block-state', timeoutMs: PLACEMENT_CONFIRM_TIMEOUT_MS, startedAt: new Date().toISOString() });
            context?.setPhase?.('placement-confirmation');
            try {
                await registerOwnedPromise(bot._placeBlockWithOptions(reference, candidate.face.scaled(-1), {
                    delta: candidate.to.minus(candidate.ref), swingArm: 'right', forceLook: 'ignore',
                }));
            } catch (error) {
                placementError = error;
                // Mineflayer may time out even when our pre-registered listener observed placement.
                if (!targets.every(target => matches(bot.blockAt(target.position), target))) observer.cleanup();
            }
        }
        const confirmed = await observer.promise;
        const actualMatches = targets.every(target => matches(bot.blockAt(target.position), target));
        if (confirmed && actualMatches) {
            recordConfirmation({ quantity: 1, unit: 'block', target: { block: request.name, position: request.position, requestedProperties: request.properties },
                observedBlocks: snapshot(bot, targets), evidence: 'server block updates matched all required placement states' });
            if (cancelled(bot)) return fail('Requested state was observed, but the action was cancelled.');
            log(`Placed ${request.name} at ${request.position}; requested state confirmed: ${JSON.stringify(request.properties)}.`);
            return true;
        }
        return fail(cancelled(bot) ? 'Placement confirmation cancelled.' : placementError?.message ?? 'Requested block state was not confirmed before the deadline.');
    } catch (error) {
        return fail(error.message);
    } finally {
        observer?.cleanup();
        finishOwnedWait(wait, { outcome: cancelled(bot) ? 'cancelled' : placementError ? 'plugin-error' : 'settled', endedAt: new Date().toISOString() });
        if (!owner?.closed) context?.setPhase?.(oldPhase);
        if (!owner?.closed && changedSneak && bot.getControlState?.('sneak') !== oldSneak) bot.setControlState('sneak', oldSneak);
        if (oldMovements && bot.pathfinder.movements === movements) bot.pathfinder.setMovements(oldMovements);
    }
}
