import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import settings from "../../../settings.js";
import craftingSync from "./crafting_sync.js";
import { placeBlockOriented } from './block_placement.js';
import { resolveBlockInteraction, makeBlockInteractionGoal, interactionFaceVector, interactionEye } from './block_interaction.js';
import { trackSkill, reportSkillOutcome, skillFailure, recordConfirmation, recordUncertainty, recordOwnedWait, beginOwnedWait, markOwnedWaitProgress, finishOwnedWait, operationContext, operationCallContext, withSkillPhase, registerOwnedPromise, withNativeNavigationEditScope, nativeNavigationEditScopeActive } from './operation_context.js';
import { awaitNavigationPlacementSettled, beginNavigationEdit, navigateWithEditErrors, navigationPolicy, navigationScaffoldsPlaced, NAVIGATION_SCAFFOLD_CLEARANCE_HEIGHT, placeAndConfirmNavigationScaffold, recordNavigationArrival, registerNavigationCleanup, registerNavigationScaffoldSettledCallback, trackNavigationSegment } from './navigation_policy.js';

const require = createRequire(import.meta.url);

function recordNavigationDiagnostic(bot, type, detail) {
    const operation = operationContext();
    const call = operationCallContext();
    const event = { taskId: operation?.taskId ?? null, actionId: operation?.actionId ?? null,
        callId: call?.id ?? null, parentCallId: call?.parentCallId ?? null, ...detail };
    if (operation?.taskRecord) return operation.taskRecord(type, event);
    return bot?._mindcraftDiagnosticRecord?.(type, event) ?? false;
}

// Observe the pathfinder's mutable path without changing its execution.
function observeNavigation(bot, record, routeId) {
    let path = [];
    let lastPlan = null;
    let lastSignature = null;
    const point = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]))
        ? { x: p.x, y: p.y, z: p.z } : null;
    const edit = e => ({ ...point(e), dx: e.dx ?? null, dy: e.dy ?? null, dz: e.dz ?? null,
        jump: e.jump === true, useOne: e.useOne === true });
    const plan = n => n ? { position: point(n), toBreak: (n.toBreak ?? []).map(edit),
        toPlace: (n.toPlace ?? []).map(edit) } : null;
    const block = p => {
        if (!p) return null;
        const b = bot.blockAt?.(new Vec3(p.x, p.y, p.z));
        return { position: point(p), name: b?.name ?? null };
    };
    const snapshot = reason => {
        const entity = bot.entity;
        const next = plan(path[0]);
        const pos = entity?.position;
        const floor = point(pos?.floored?.());
        const feet = floor ? new Vec3(floor.x, floor.y, floor.z) : null;
        const controls = Object.fromEntries(['forward', 'jump', 'sneak'].map(k => [k, bot.getControlState?.(k) ?? null]));
        record('navigation_step', { routeId, reason, next, lastPlan, position: point(pos), velocity: point(entity?.velocity),
            onGround: entity?.onGround ?? null, controls, mining: bot.pathfinder.isMining?.() ?? null,
            building: bot.pathfinder.isBuilding?.() ?? null,
            blocks: feet ? [block(feet.offset(0, -1, 0)), block(feet), block(feet.offset(0, 1, 0)),
                block(feet.offset(0, 2, 0))] : [], nextBlock: next?.position ? block(next.position) : null });
    };
    const onPath = result => {
        path = Array.isArray(result?.path) ? result.path : [];
        lastPlan = plan(path[0]);
        lastSignature = null;
        snapshot('path_update');
    };
    const onTick = () => {
        const next = plan(path[0]);
        const building = bot.pathfinder.isBuilding?.() ?? null;
        const mining = bot.pathfinder.isMining?.() ?? null;
        const jump = bot.getControlState?.('jump') ?? null;
        const signature = JSON.stringify([next, building, mining, jump]);
        if (signature === lastSignature) return;
        if (next && (next.toBreak.length || next.toPlace.length)) lastPlan = next;
        lastSignature = signature;
        snapshot('step_changed');
    };
    const onReset = reason => { snapshot(`path_reset:${reason ?? 'unknown'}`); path = []; lastSignature = null; };
    const originalPlace = bot.placeBlock;
    const place = function (reference, face, ...args) {
        const detail = { routeId, reference: point(reference?.position), referenceBlock: reference?.name ?? null,
            face: point(face), heldItem: bot.heldItem?.name ?? null, lastPlan };
        record('navigation_placement_started', detail);
        let result;
        try { result = originalPlace.call(this, reference, face, ...args); }
        catch (error) { record('navigation_placement_result', { ...detail, status: 'error', error: String(error) }); throw error; }
        Promise.resolve(result).then(
            () => record('navigation_placement_result', { ...detail, status: 'resolved' }),
            error => record('navigation_placement_result', { ...detail, status: 'error', error: String(error) }));
        return result;
    };
    bot.on?.('path_update', onPath);
    bot.on?.('path_reset', onReset);
    bot.on?.('physicsTick', onTick);
    if (typeof originalPlace === 'function') bot.placeBlock = place;
    return {
        snapshot,
        close() {
            bot.removeListener?.('path_update', onPath);
            bot.removeListener?.('path_reset', onReset);
            bot.removeListener?.('physicsTick', onTick);
            if (bot.placeBlock === place) bot.placeBlock = originalPlace;
        },
    };
}

const blockPlaceDelay = settings.block_place_delay == null ? 0 : settings.block_place_delay;
const useDelay = blockPlaceDelay > 0;
const COLLECT_DROP_RADIUS = 0.5;
const PLANT_CONFIRM_TIMEOUT_MS = 2000;
const HARVEST_CONFIRM_TIMEOUT_MS = 2000;
const INTERACTION_CONFIRM_TIMEOUT_MS = 2000;
const COMBAT_CHECK_INTERVAL_MS = 50;
const COMBAT_SETTLE_MS = 1500;

function allRetreatGoals(goals) {
    const goal = new pf.goals.GoalCompositeAll(goals);
    // The library starts its maximum at Number.MIN_VALUE, which discards
    // every negative inverted-goal heuristic and leaves search unguided.
    goal.heuristic = node => Math.max(...goals.map(child => child.heuristic(node)));
    return goal;
}
const FARM_SEARCH_RADIUS = 32;
const FARM_SEED_RESERVE = 1;
const FARM_CHEST_RADIUS = 32;
const FARM_SEARCH_LIMIT = 10000;
const FURNACE_POLL_INTERVAL_MS = 100;
const FURNACE_IDLE_TIMEOUT_MS = 11000;
const DEFAULT_NAVIGATION_STALL_TIMEOUT_MS = 90_000;
const DEFAULT_NAVIGATION_CHECK_INTERVAL_MS = 5_000;
const REACH_POSITION_MAX_DISTANCE = 512;
const REACH_POSITION_MAX_SEGMENTS = 32;
const REACH_POSITION_MAX_DURATION_MS = 180_000;
const REACH_POSITION_SEARCH_RADIUS = 64;
const REACH_POSITION_SEARCH_TIMEOUT_MS = 1_200;
const REACH_POSITION_SEARCH_TICK_MS = 60;
const REACH_POSITION_SEARCH_STEPS = 12;
const REACH_POSITION_DIG_HINT_TIMEOUT_MS = 250;
const REACH_POSITION_CHUNK_WAIT_MS = 5_000;
const REACH_POSITION_NO_PROGRESS_LIMIT = 3;
const REACH_POSITION_MAX_SAFE_FEET_DROP = 3;
const reachPositionMovementOwners = new WeakMap();
const navigationRecoveryActive = new WeakSet();
const NAVIGATION_RECOVERY_RADIUS = 32;
const NAVIGATION_RECOVERY_MAX_HAZARD_BLOCKS = 2048;
const NAVIGATION_RECOVERY_MAX_CANDIDATES = 4096;
const NAVIGATION_RECOVERY_MAX_DURATION_MS = 30_000;
const NAVIGATION_LANDING_WAIT_MS = 5_000;
const NAVIGATION_RECOVERY_SEARCH_TIMEOUT_MS = 6_000;
const NAVIGATION_RECOVERY_SEARCH_TICK_MS = 50;
const NAVIGATION_RECOVERY_SEARCH_STEPS = 2048;
const SURFACE_SEARCH_RADIUS = 16;
const SURFACE_ARRIVAL_Y_TOLERANCE = 0.25;
const SURFACE_SETTLE_TICKS = 2;
const SURFACE_CONNECTED_STEP_HEIGHT = 1;
const UNSAFE_SURFACE_BLOCKS = new Set([
    'magma_block', 'cactus', 'campfire', 'soul_campfire', 'fire', 'soul_fire',
    'powder_snow', 'sweet_berry_bush', 'wither_rose', 'pointed_dripstone',
]);
const furnaceClickGuards = new WeakMap();
const FARM_NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const CROPS = {
    wheat: { mature: 7, seed: 'wheat_seeds', produce: ['wheat'] },
    carrots: { mature: 7, seed: 'carrot', produce: ['carrot'] },
    potatoes: { mature: 7, seed: 'potato', produce: ['potato'] },
    beetroots: { mature: 3, seed: 'beetroot_seeds', produce: ['beetroot'] },
};

function isOwnedScaffoldUnderBot(bot, position) {
    const feet = bot.entity?.position;
    return !!feet && Math.floor(feet.x) === position.x && Math.floor(feet.z) === position.z && position.y < feet.y;
}

function upsertOwnedScaffold(records, record) {
    const index = records.findIndex(entry => entry.position.x === record.position.x
        && entry.position.y === record.position.y && entry.position.z === record.position.z);
    if (index >= 0) records.splice(index, 1);
    records.push(record);
}

registerNavigationCleanup(async (bot, context) => {
    const remaining = [];
    for (const scaffold of [...context.scaffolds].reverse()) {
        if (isActionCancelled(bot, getActionContext(bot))) {
            remaining.push({ ...scaffold.position, block: scaffold.block, reason: 'Action cancelled before owned scaffold cleanup.' });
            continue;
        }
        const position = new Vec3(scaffold.position.x, scaffold.position.y, scaffold.position.z);
        const block = bot.blockAt(position);
        if (block?.type === 0) continue;
        if (!block || block.name !== scaffold.block || scaffold.stateId != null && block.stateId !== scaffold.stateId) {
            remaining.push({ ...scaffold.position, block: scaffold.block, reason: 'Owned scaffold state changed or became unknown.' });
            continue;
        }
        if (isOwnedScaffoldUnderBot(bot, position)) {
            remaining.push({ ...scaffold.position, block: scaffold.block, reason: 'Scaffold supports the bot at its current position.' });
            continue;
        }
        const interaction = resolveBlockInteraction(bot, block, { reach: 4.5 });
        if (interaction.status !== 'ready') {
            remaining.push({ ...scaffold.position, block: scaffold.block, reason: `Scaffold is not safely reachable: ${interaction.reason}.` });
            continue;
        }
        try {
            await registerOwnedPromise(bot.dig(block));
            if (bot.blockAt(position)?.type !== 0) throw new Error('Server did not confirm scaffold removal.');
            context.edits.push({ kind: 'scaffold_removed', block: scaffold.block, position: scaffold.position });
        } catch (error) {
            if (bot.blockAt(position)?.type !== 0) remaining.push({ ...scaffold.position, block: scaffold.block, reason: String(error.message ?? error) });
        }
    }
    return remaining;
});

export function log(bot, message) {
    const owner = operationContext();
    if (owner?.closed) { owner.diagnostics.push({ kind: 'late_output', message: String(message) }); return; }
    bot.output += message + '\n';
}

// Log the cause for legacy output and report it as this skill call's structured outcome.
function failSkill(bot, code, reason, detail = {}) {
    log(bot, reason);
    return skillFailure(code, reason, detail);
}

function getActionContext(bot, context) {
    return context || operationContext()?.cancellation || bot.getActionCancellationContext?.() || null;
}

function isActionCancelled(bot, context) {
    return !!bot.interrupt_code || !!context?.signal?.aborted;
}

function navigationMovements(bot, movementOverride = null) {
    const supplied = movementOverride && typeof movementOverride === 'object' ? movementOverride : null;
    if (nativeNavigationEditScopeActive() || navigationRecoveryActive.has(bot)) return supplied ?? new pf.Movements(bot);
    const explicitPolicy = navigationPolicy();
    if (explicitPolicy || operationContext()?.nativeNavigationNoEdits && !nativeNavigationEditScopeActive()) {
        const policy = explicitPolicy ?? { allowDig: false, scaffold: 'forbid', scaffoldBlocks: [] };
        const scaffoldBlocks = policy.scaffold === 'forbid' ? [] : policy.scaffoldBlocks.flatMap(name => {
            const available = (bot.inventory?.items?.() ?? []).some(item => item.name === name && item.count > 0);
            const id = bot.registry?.itemsByName?.[name]?.id;
            return available && Number.isInteger(id) ? [id] : [];
        });
        return Object.assign(new pf.Movements(bot), supplied ?? {}, {
            canDig: policy.allowDig === true, canPlaceOn: scaffoldBlocks.length > 0,
            allow1by1towers: scaffoldBlocks.length > 0 && policy.allowTowers !== false,
            allowFreeMotion: false, scafoldingBlocks: scaffoldBlocks, canOpenDoors: false,
        });
    }
    return supplied ?? new pf.Movements(bot);
}

function countWindowItems(slots, start, end, itemName) {
    let count = 0;
    for (let slot = start; slot < end; slot++) if (slots[slot]?.name === itemName) count += slots[slot].count;
    return count;
}

function countWindowRegion(window, start, end, itemName) {
    return countWindowItems(window.slots, start, end, itemName);
}

function countFencedWindowRegion(snapshot, start, end, itemName) {
    const itemType = mc.getItemId(itemName);
    const slots = snapshot.items.map(item => item && { name: item.type === itemType ? itemName : null, count: item.count });
    return countWindowItems(slots, start, end, itemName);
}

function setActionPhase(context, phase) {
    context?.setPhase?.(phase);
}

function waitForActionOrTimeout(bot, context, milliseconds) {
    const signal = context?.signal;
    return new Promise(resolve => {
        let settled = false;
        let timer;
        const finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
        };
        const onAbort = () => finish(false);
        const poll = () => {
            if (isActionCancelled(bot, context)) return finish(false);
            const elapsed = Date.now() - startedAt;
            if (elapsed >= milliseconds) return finish(true);
            timer = setTimeout(poll, Math.min(FURNACE_POLL_INTERVAL_MS, milliseconds - elapsed));
        };
        const startedAt = Date.now();
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted || isActionCancelled(bot, context)) return finish(false);
        timer = setTimeout(poll, Math.min(FURNACE_POLL_INTERVAL_MS, milliseconds));
    });
}


function validateTargetCall(bot, x, y, z, signature) {
    if (!bot || typeof bot.blockAt !== 'function' || !bot.entity?.position ||
        ![x, y, z].every(Number.isFinite)) {
        const example = signature.includes('blockType') ? `(bot, \"stone\", 10, 64, -3)` : `(bot, 10, 64, -3)`;
        throw new TypeError(`${signature}: pass bot first and three finite coordinates. Example: await ${signature.split('(')[0]}${example};`);
    }
}

function requireActiveTarget(bot) {
    if (isActionCancelled(bot, getActionContext(bot))) {
        throw new Error('Action cancelled before target interaction');
    }
}

function guardFurnaceClicks(bot, window, context) {
    const client = bot._client;
    let state = furnaceClickGuards.get(client);
    if (!state) {
        state = { originalWrite: client.write, rules: [] };
        state.guardedWrite = function (name, packet, ...args) {
            if (name === 'window_click') {
                for (let index = state.rules.length - 1; index >= 0; index--) {
                    const rule = state.rules[index];
                    if (packet?.windowId === rule.windowId && isActionCancelled(rule.bot, rule.context)) {
                        const readOnlyFence = packet.slot === -999 && packet.mode === 5 && packet.mouseButton === 2;
                        if (readOnlyFence) return state.originalWrite.call(this, name, packet, ...args);
                        rule.blocked = true;
                        rule.restoreAuthoritativeWindow();
                        throw new Error('furnace action cancelled before click packet was sent');
                    }
                }
            }
            return state.originalWrite.call(this, name, packet, ...args);
        };
        client.write = state.guardedWrite;
        furnaceClickGuards.set(client, state);
    }
    const Item = require('prismarine-item')(bot.registry);
    const copyItem = item => item ? Item.fromNotch(Item.toNotch(item)) : null;
    const rule = {
        bot,
        context,
        windowId: window.id,
        blocked: false,
        authoritativeSlots: window.slots.map(copyItem),
        authoritativeCursor: copyItem(window.selectedItem),
        captureWindow() {
            this.authoritativeSlots = window.slots.map(copyItem);
            this.authoritativeCursor = copyItem(window.selectedItem);
        },
        restoreAuthoritativeWindow() {
            bot.inventoryUnconfirmed = true;
            for (let slot = 0; slot < this.authoritativeSlots.length; slot++) {
                window.slots[slot] = copyItem(this.authoritativeSlots[slot]);
                if (window.slots[slot]) window.slots[slot].slot = slot;
            }
            window.selectedItem = copyItem(this.authoritativeCursor);
        },
        onWindowItems: packet => { if (packet.windowId === window.id) rule.captureWindow(); },
        onSetSlot: packet => {
            if (packet.windowId === window.id && packet.slot >= 0 && packet.slot < window.slots.length) rule.captureWindow();
        }
    };
    client.on('window_items', rule.onWindowItems);
    client.on('set_slot', rule.onSetSlot);
    state.rules.push(rule);
    return {
        rule,
        release() {
            client.removeListener('window_items', rule.onWindowItems);
            client.removeListener('set_slot', rule.onSetSlot);
            const index = state.rules.indexOf(rule);
            if (index >= 0) state.rules.splice(index, 1);
            if (state.rules.length === 0) {
                if (client.write === state.guardedWrite) client.write = state.originalWrite;
                furnaceClickGuards.delete(client);
            }
        }
    };
}

async function closeOwnedFurnaceWindow(bot, furnace) {
    if (!furnace || bot.currentWindow !== furnace) return false;
    await bot.closeWindow(furnace);
    return true;
}

function itemCountInInventory(bot, type, metadata = null) {
    return bot.inventory.items()
        .filter(item => item.type === type && (metadata == null || item.metadata === metadata))
        .reduce((count, item) => count + item.count, 0);
}

function verifyInventoryDelta(bot, baseline, returnedItems, removedItems = []) {
    const changes = new Map();
    for (const item of returnedItems) {
        if (!item) continue;
        const key = `${item.type}:${item.metadata ?? 0}`;
        const entry = changes.get(key) || { type: item.type, metadata: item.metadata ?? 0, count: 0 };
        entry.count += item.count;
        changes.set(key, entry);
    }
    for (const item of removedItems) {
        if (!item) continue;
        const key = `${item.type}:${item.metadata ?? 0}`;
        const entry = changes.get(key) || { type: item.type, metadata: item.metadata ?? 0, count: 0 };
        entry.count -= item.count;
        changes.set(key, entry);
    }
    const mismatches = [];
    for (const { type, metadata, count } of changes.values()) {
        const before = baseline.get(`${type}:${metadata}`) || 0;
        const after = itemCountInInventory(bot, type, metadata);
        if (after < before + count) mismatches.push({ type, metadata, before, expectedAtLeast: before + count, actual: after });
    }
    return mismatches;
}

function itemIdsForNames(bot, itemNames) {
    return new Set(itemNames.map(name => bot.registry?.itemsByName?.[name]?.id).filter(Number.isInteger));
}

function trackBlockCollection(bot, block, expectedItemIds) {
    const trackedDrops = new Map();
    const collectedItems = {};
    let collectedTargetDrop = false;
    let targetAirObserved = false;
    const onItemDrop = entity => {
        const center = block.position.offset(0.5, 0.5, 0.5);
        if (!entity.position?.distanceTo || entity.position.distanceTo(center) > COLLECT_DROP_RADIUS) return;
        const item = entity.getDroppedItem?.();
        if (item?.type != null && expectedItemIds.has(item.type) && entity.id != null) trackedDrops.set(entity.id, item);
    };
    const onPlayerCollect = (collector, entity) => {
        if (bot.entity?.id == null || collector?.id !== bot.entity.id || entity?.id == null || !trackedDrops.has(entity.id)) return;
        const item = trackedDrops.get(entity.id);
        trackedDrops.delete(entity.id);
        if (item.name && Number.isInteger(item.count)) collectedItems[item.name] = (collectedItems[item.name] ?? 0) + item.count;
        collectedTargetDrop = true;
    };
    const onBlockUpdate = (oldBlock, newBlock) => {
        if (oldBlock?.position?.x === block.position.x && oldBlock.position.y === block.position.y &&
            oldBlock.position.z === block.position.z && (newBlock?.type === 0 || newBlock?.name === 'air')) targetAirObserved = true;
    };
    bot.on('itemDrop', onItemDrop);
    bot.on('playerCollect', onPlayerCollect);
    bot.on('blockUpdate', onBlockUpdate);
    return {
        collectedItems,
        async wait(timeoutMs) {
            const startedAt = Date.now();
            while (!bot.interrupt_code && Date.now() - startedAt < timeoutMs) {
                const currentBlock = bot.blockAt?.(block.position);
                const targetAir = targetAirObserved || currentBlock?.type === 0 || currentBlock?.name === 'air';
                if (collectedTargetDrop && targetAir) return true;
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            return false;
        },
        cleanup() {
            bot.removeListener('itemDrop', onItemDrop);
            bot.removeListener('playerCollect', onPlayerCollect);
            bot.removeListener('blockUpdate', onBlockUpdate);
        }
    };
}

function waitForBlockUpdate(bot, position, predicate, timeoutMs = PLANT_CONFIRM_TIMEOUT_MS) {
    let timer;
    let interruptTimer;
    let onBlockUpdate;
    let finish;
    const promise = new Promise(resolve => {
        let settled = false;
        finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearInterval(interruptTimer);
            if (onBlockUpdate) bot.removeListener('blockUpdate', onBlockUpdate);
            resolve(value);
        };
        onBlockUpdate = (_oldBlock, newBlock) => {
            const samePosition = newBlock?.position?.x === position.x &&
                newBlock.position.y === position.y && newBlock.position.z === position.z;
            if (samePosition && predicate(newBlock)) finish(true);
        };
        bot.on('blockUpdate', onBlockUpdate);
        timer = setTimeout(() => finish(false), timeoutMs);
        interruptTimer = setInterval(() => { if (bot.interrupt_code) finish(false); }, 25);
    });
    return { promise, cleanup: () => finish?.(false) };
}

async function performAndConfirmBlockUpdate(bot, position, expectedName, action) {
    const update = waitForBlockUpdate(bot, position, block => block?.name === expectedName);
    try {
        if (!await action()) return false;
        return await update.promise;
    } finally {
        update.cleanup();
    }
}

function inventoryItemCount(bot, name) {
    return bot.inventory.items().filter(item => item?.name === name).reduce((total, item) => total + item.count, 0);
}

function trackBucketInventoryChange(bot, inputName, outputName) {
    const beforeInput = inventoryItemCount(bot, inputName);
    const beforeOutput = inventoryItemCount(bot, outputName);
    return {
        async wait() {
            const startedAt = Date.now();
            while (!bot.interrupt_code && Date.now() - startedAt < INTERACTION_CONFIRM_TIMEOUT_MS) {
                if (inventoryItemCount(bot, inputName) < beforeInput && inventoryItemCount(bot, outputName) > beforeOutput) return true;
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            return false;
        }
    };
}

async function autoLight(bot) {
    if (world.shouldPlaceTorch(bot)) {
        try {
            const pos = world.getPosition(bot);
            return await placeBlock(bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
        } catch (err) {return false;}
    }
    return false;
}

async function equipHighestAttack(bot) {
    let weapons = bot.inventory.items().filter(item => item.name.includes('sword') || (item.name.includes('axe') && !item.name.includes('pickaxe')));
    if (weapons.length === 0)
        weapons = bot.inventory.items().filter(item => item.name.includes('pickaxe') || item.name.includes('shovel'));
    if (weapons.length === 0)
        return;
    weapons.sort((a, b) => a.attackDamage < b.attackDamage);
    let weapon = weapons[0];
    if (weapon)
        await bot.equip(weapon, 'hand');
}

export async function craftRecipe(bot, itemName, num=1, nativeOptions=null) {
    /**
     * Attempt to craft the given item name from a recipe. May craft many items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to craft.
     * @returns {Promise<boolean>} true if the recipe was crafted, false if its ingredients or required crafting grid are unavailable.
     * @example
     * await skills.craftRecipe(bot, "stick");
     **/
    let placedTable = false;

    if (mc.getItemCraftingRecipes(itemName).length == 0) {
        log(bot, `${itemName} is either not an item, or it does not have a crafting recipe!`);
        return nativeOptions?.details ? { ok: false, status: 'blocked', requestedQuantity: nativeOptions.quantity ?? null, confirmedQuantity: 0, remainingQuantity: nativeOptions.quantity ?? null, itemName, reason: 'no_recipe' } : false;
    }

    if (!Number.isInteger(num) || num < 1) {
        log(bot, `Crafting count must be a positive integer: ${num}.`);
        return nativeOptions?.details ? { ok: false, status: 'blocked', requestedQuantity: nativeOptions.quantity ?? null, confirmedQuantity: 0, remainingQuantity: nativeOptions.quantity ?? null, itemName, reason: 'invalid_recipe_count' } : false;
    }

    return craftingSync.run(bot, async (craft) => {
    // get recipes that don't require a crafting table
    let recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, null); 
    let craftingTable = null;
    const craftingTableRange = 16;
    placeTable: if (!recipes || recipes.length === 0) {
        recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, true);
        if(!recipes || recipes.length === 0) break placeTable; //Don't bother going to the table if we don't have the required resources.

        // Look for crafting table
        craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
        if (craftingTable === null){

            // Try to place crafting table
            let hasTable = world.getInventoryCounts(bot)['crafting_table'] > 0;
            if (hasTable) {
                let pos = world.getNearestFreeSpace(bot, 1, 6);
                await withSkillPhase('preparation', () => placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z));
                craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
                if (craftingTable) {
                    recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
                    placedTable = true;
                } else {
                    return failSkill(bot, 'confirmation_failed', `Could not confirm a crafting table after placement; refusing to use the inventory grid for ${itemName}.`);
                }
            }
            else {
                return failSkill(bot, 'missing_station', `Crafting ${itemName} requires a crafting table.`);
            }
        }
        else {
            recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
        }
    }
    if (!recipes || recipes.length === 0) {
        log(bot, `You do not have the resources to craft a ${itemName}. It requires: ${Object.entries(mc.getItemCraftingRecipes(itemName)[0][0]).map(([key, value]) => `${key}: ${value}`).join(', ')}.`);
        if (placedTable) {
            await withSkillPhase('cleanup', () => collectBlock(bot, 'crafting_table', 1));
        }
        return false;
    }
    
    if (craftingTable) {
        requireActiveTarget(bot);
        const tablePosition = craftingTable.position;
        const approach = await approachBlock(bot, tablePosition.x, tablePosition.y, tablePosition.z);
        requireActiveTarget(bot);
        if (approach.status !== 'ready' || !approach.target?.loaded || approach.target.name !== 'crafting_table') {
            return failSkill(bot, 'target_unreachable', `Cannot use crafting table at ${tablePosition}: interaction approach ${approach.status}${approach.reason ? ` (${approach.reason})` : ''}; refusing to open a crafting window.`);
        }
        craftingTable = bot.blockAt(new Vec3(tablePosition.x, tablePosition.y, tablePosition.z).floored());
        if (!craftingTable || craftingTable.name !== 'crafting_table') {
            return failSkill(bot, 'target_changed', `Crafting table at ${tablePosition} changed before activation; refusing to open a crafting window.`);
        }
    }

    const recipe = recipes[0];
    console.log('crafting...');
    //Check that the agent has sufficient items to use the recipe `num` times.
    const inventory = world.getInventoryCounts(bot); //Items in the agents inventory
    const requiredIngredients = mc.ingredientsFromPrismarineRecipe(recipe); //Items required to use the recipe once.
    const craftLimit = mc.calculateLimitingResource(inventory, requiredIngredients);
    const requestedRecipes = nativeOptions?.quantity == null ? num : Math.ceil(nativeOptions.quantity / recipe.result.count);
    const craftedCount = await craft(recipe, Math.min(craftLimit.num, requestedRecipes), craftingTable);
    if(craftedCount<requestedRecipes) log(bot, `Not enough ${craftLimit.limitingResource} to craft ${requestedRecipes}, crafted ${craftedCount}. You now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    else log(bot, `Successfully crafted ${itemName}, you now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    if (placedTable) {
        await withSkillPhase('cleanup', () => collectBlock(bot, 'crafting_table', 1));
    }

    //Equip any armor the bot may have crafted.
    //There is probablly a more efficient method than checking the entire inventory but this is all mineflayer-armor-manager provides. :P
    await bot.armorManager.equipAll();

    if (nativeOptions?.details) {
        const confirmedQuantity = craftedCount * recipe.result.count;
        const requestedQuantity = nativeOptions.quantity;
        const complete = confirmedQuantity >= requestedQuantity;
        return { ok: complete, status: complete ? 'complete' : confirmedQuantity > 0 ? 'partial' : 'blocked', itemName,
            requestedQuantity, confirmedQuantity, remainingQuantity: Math.max(0, requestedQuantity - confirmedQuantity),
            producedPerRecipe: recipe.result.count, executedRecipes: craftedCount,
            ...(!complete ? { reason: confirmedQuantity ? 'materials_or_grid_limited' : 'craft_unavailable' } : {}) };
    }
    return craftedCount > 0;
    });
}

export async function craftItem(bot, itemName, quantity=1) {
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new TypeError('craftItem quantity must be a positive safe integer');
    return craftRecipe(bot, itemName, 1, { details: true, quantity });
}

export async function wait(bot, milliseconds) {
    /**
     * Waits for the given number of milliseconds.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} milliseconds, the number of milliseconds to wait.
     * @returns {Promise<boolean>} true if the wait was successful, false otherwise.
     * @example
     * await skills.wait(bot, 1000);
     **/
    // setTimeout is disabled to prevent unawaited code, so this is a safe alternative that enables interrupts
    let timeLeft = milliseconds;
    let startTime = Date.now();
    
    while (timeLeft > 0) {
        if (bot.interrupt_code) return false;
        
        let waitTime = Math.min(2000, timeLeft);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        let elapsed = Date.now() - startTime;
        timeLeft = milliseconds - elapsed;
    }
    return true;
}

export async function smeltItem(bot, itemName, num=1, options=null) {
    /**
     * Smelts the requested number of items in a nearby furnace and waits for the confirmed result.
     * @param {MinecraftBot} bot, reference to the Minecraft bot.
     * @param {string} itemName, item name to smelt. Ore inputs must use names such as raw_iron.
     * @param {number} num, number of items to smelt. Defaults to 1.
     * @returns {Promise<boolean>} true only when the furnace and inventory snapshots confirm the full result; false for shortages, partial results, or interruption. Partial results are not retried automatically.
     * @example
     * await skills.smeltItem(bot, "raw_iron");
     * await skills.smeltItem(bot, "beef", 4);
     **/
    const context = getActionContext(bot, options?.actionContext ?? (options?.furnacePosition === undefined ? options : null));
    if (!mc.isSmeltable(itemName)) {
        return failSkill(bot, 'invalid_item', `Cannot smelt ${itemName}. Hint: make sure you are smelting the 'raw' item.`);
    }
    if (!Number.isInteger(num) || num < 1) {
        return failSkill(bot, 'invalid_quantity', `Smelting count must be a positive integer: ${num}.`);
    }

    const furnaceRange = 16;
    const exactFurnacePosition = options && Object.hasOwn(options, 'furnacePosition') ? options.furnacePosition : undefined;
    let furnaceBlock = exactFurnacePosition === undefined
        ? world.getNearestBlock(bot, 'furnace', furnaceRange)
        : bot.blockAt(new Vec3(Math.floor(exactFurnacePosition.x), Math.floor(exactFurnacePosition.y), Math.floor(exactFurnacePosition.z)));
    if (exactFurnacePosition !== undefined && (!furnaceBlock || !['furnace', 'blast_furnace', 'smoker'].includes(furnaceBlock.name)))
        return failSkill(bot, 'target_not_found', `No furnace at the requested furnacePosition.`, { position: exactFurnacePosition });
    let placedFurnace = false;
    if (!furnaceBlock && world.getInventoryCounts(bot).furnace > 0 && !isActionCancelled(bot, context)) {
        const pos = world.getNearestFreeSpace(bot, 1, furnaceRange);
        await placeBlock(bot, 'furnace', pos.x, pos.y, pos.z);
        furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
        placedFurnace = !!furnaceBlock;
    }
    if (!furnaceBlock) {
        return failSkill(bot, 'missing_station', 'There is no furnace nearby and you have no furnace.');
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4)
        if (!await goToPosition(bot, furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 4)) return false;
    if (exactFurnacePosition !== undefined) {
        const currentFurnace = bot.blockAt(new Vec3(Math.floor(exactFurnacePosition.x), Math.floor(exactFurnacePosition.y), Math.floor(exactFurnacePosition.z)));
        if (!currentFurnace || !['furnace', 'blast_furnace', 'smoker'].includes(currentFurnace.name)) return options?.returnDetails
            ? { ok: false, status: 'unknown', inputItem: itemName, requestedQuantity: num, confirmedQuantity: 0, remainingQuantity: num, furnacePosition: exactFurnacePosition, reason: 'furnace_target_changed' }
            : false;
        furnaceBlock = currentFurnace;
    }
    if (isActionCancelled(bot, context)) return false;
    let furnace = null;
    let clickGuard = null;
    let cancelled = false;
    let reason = null;
    let total = 0;
    let smeltedItem = null;
    let furnaceConfirmed = false;
    let inventoryConfirmed = false;
    let operationError = null;
    let cleanupError = null;
    const baseline = new Map();
    const returnedItems = [];
    const removedItems = [];
    try {
        setActionPhase(context, 'furnace-inventory-baseline');
        await craftingSync.snapshotInventory(bot);
        for (const item of bot.inventory.items()) {
            const key = `${item.type}:${item.metadata ?? 0}`;
            baseline.set(key, (baseline.get(key) || 0) + item.count);
        }
        if (isActionCancelled(bot, context)) {
            cancelled = true;
            reason = 'cancelled before opening furnace';
        } else {
            setActionPhase(context, 'opening-furnace');
            await bot.lookAt(furnaceBlock.position);
            if (!isActionCancelled(bot, context)) furnace = await bot.openFurnace(furnaceBlock);
            else { cancelled = true; reason = 'cancelled before opening furnace'; }
        }
        if (furnace) clickGuard = guardFurnaceClicks(bot, furnace, context);
        if (furnace && !cancelled && isActionCancelled(bot, context)) {
            cancelled = true;
            reason = 'cancelled after furnace opened';
        }
        if (furnace && !cancelled) {
            const input = furnace.inputItem();
            if (input && input.type !== mc.getItemId(itemName) && input.count > 0) {
                reason = `furnace already contains ${mc.getItemName(input.type)}`;
            } else if ((world.getInventoryCounts(bot)[itemName] || 0) < num) {
                reason = `not enough ${itemName} in inventory`;
            } else {
                if (!furnace.fuelItem()) {
                    const fuel = mc.getSmeltingFuel(bot);
                    if (!fuel) reason = `no fuel available for ${itemName}`;
                    else {
                        const fuelCount = Math.ceil(num / mc.getFuelSmeltOutput(fuel.name));
                        if (fuel.count < fuelCount) reason = `not enough ${fuel.name}: need ${fuelCount}`;
                        else {
                            setActionPhase(context, 'furnace-transfer-fuel');
                            await furnace.putFuel(fuel.type, null, fuelCount);
                            removedItems.push({ type: fuel.type, metadata: fuel.metadata ?? 0, count: fuelCount });
                        }
                    }
                }
                if (!reason && !isActionCancelled(bot, context)) {
                    setActionPhase(context, 'furnace-transfer-input');
                    await furnace.putInput(mc.getItemId(itemName), null, num);
                    removedItems.push({ type: mc.getItemId(itemName), metadata: 0, count: num });
                }
                if (isActionCancelled(bot, context)) {
                    cancelled = true;
                    reason = 'cancelled during furnace transfer';
                }
                if (!cancelled && !reason) {
                    setActionPhase(context, 'waiting-for-smelting');
                    const smeltingWaitStartedAt = new Date().toISOString();
                    const smeltingWaitStartedMs = Date.now();
                    let quietMs = 0;
                    while (total < num && quietMs < FURNACE_IDLE_TIMEOUT_MS) {
                        if (!await waitForActionOrTimeout(bot, context, FURNACE_POLL_INTERVAL_MS)) {
                            cancelled = true;
                            reason = 'cancelled while waiting for smelting';
                            break;
                        }
                        const output = furnace.outputItem();
                        if (output) {
                            setActionPhase(context, 'collecting-furnace-output');
                            smeltedItem = await furnace.takeOutput();
                            if (smeltedItem) {
                                returnedItems.push(smeltedItem);
                                total += smeltedItem.count;
                                quietMs = 0;
                            }
                            if (isActionCancelled(bot, context)) {
                                cancelled = true;
                                reason = 'cancelled during output collection';
                                break;
                            }
                            setActionPhase(context, 'waiting-for-smelting');
                        } else quietMs += FURNACE_POLL_INTERVAL_MS;
                    }
                    recordOwnedWait({
                        phase: 'waiting-for-smelting', reason: 'furnace-output-or-quiet-timeout',
                        startedAt: smeltingWaitStartedAt, timeoutMs: FURNACE_IDLE_TIMEOUT_MS,
                        endedAt: new Date().toISOString(), elapsedMs: Date.now() - smeltingWaitStartedMs,
                        deadlineKind: 'quiet-period-reset-on-output',
                        outcome: cancelled ? 'cancelled' : total >= num ? 'requested-output-observed' : 'quiet-timeout',
                        observedOutput: total,
                    });
                    if (!cancelled && furnace.inputItem()) {
                        setActionPhase(context, 'collecting-furnace-input');
                        const item = await furnace.takeInput();
                        if (item) returnedItems.push(item);
                    }
                    if (!cancelled && !isActionCancelled(bot, context) && furnace.fuelItem()) {
                        setActionPhase(context, 'collecting-furnace-fuel');
                        const item = await furnace.takeFuel();
                        if (item) returnedItems.push(item);
                    }
                    if (isActionCancelled(bot, context)) {
                        cancelled = true;
                        reason = 'cancelled during furnace collection';
                    }
                }
            }
        }
    } catch (error) {
        if (isActionCancelled(bot, context)) {
            cancelled = true;
            reason = `cancelled with unresolved furnace state: ${error.message}`;
        } else operationError = error;
    } finally {
        try {
            if (furnace) {
                setActionPhase(context, 'confirming-furnace-snapshot');
                await craftingSync.snapshotWindow(bot, furnace);
                furnaceConfirmed = true;
            }
        } catch (error) {
            bot.inventoryUnconfirmed = true;
            cleanupError = error;
        } finally {
            try {
                clickGuard?.release();
                if (furnace) await closeOwnedFurnaceWindow(bot, furnace);
            } catch (error) {
                cleanupError ||= error;
            } finally {
                if (furnace) {
                    try {
                        setActionPhase(context, cancelled || isActionCancelled(bot, context)
                            ? 'confirming-player-inventory-after-stop'
                            : 'confirming-player-inventory');
                        await craftingSync.snapshotInventory(bot);
                        inventoryConfirmed = true;
                    } catch (error) {
                        bot.inventoryUnconfirmed = true;
                        cleanupError ||= error;
                    }
                }
                if (furnace && (!furnaceConfirmed || !inventoryConfirmed)) bot.inventoryUnconfirmed = true;
            }
        }
    }

    if (operationError) throw operationError;
    if (cleanupError && !cancelled && !isActionCancelled(bot, context)) throw cleanupError;
    if (cancelled || isActionCancelled(bot, context)) {
        return failSkill(bot, 'cancelled', `Smelting ${itemName} interrupted before completion; observed output: ${total}. Furnace snapshot ${furnaceConfirmed ? 'confirmed after stopping transfers' : 'unconfirmed'}, player inventory snapshot ${inventoryConfirmed ? 'confirmed after close' : 'unconfirmed'}${bot.inventoryUnconfirmed ? '; actions are gated until state is confirmed' : ''}. The furnace may continue smelting after close${reason ? ` (${reason})` : ''}.`);
    }
    if (!furnace || !furnaceConfirmed) {
        if (reason) {
            return failSkill(bot, 'not_started', `Smelting ${itemName} did not start: ${reason}.`);
        }
        return failSkill(bot, 'unconfirmed', `Smelting ${itemName} result is unconfirmed${reason ? `: ${reason}` : '.'}`);
    }
    if (!inventoryConfirmed) {
        return failSkill(bot, 'unconfirmed', `Smelting ${itemName} result is unconfirmed; inventory snapshot failed and actions are gated.`);
    }
    const mismatches = verifyInventoryDelta(bot, baseline, returnedItems, removedItems);
    if (mismatches.length) {
        return failSkill(bot, 'unconfirmed', `Smelting ${itemName} result is unconfirmed: inventory delta ${JSON.stringify(mismatches)}.`);
    }
    if (placedFurnace && !furnace.outputItem() && !furnace.inputItem() && !furnace.fuelItem())
        await collectBlock(bot, 'furnace', 1);
    const details = () => ({ ok: total >= num, status: total >= num ? 'complete' : total > 0 ? 'partial' : cancelled ? 'cancelled' : inventoryConfirmed && furnaceConfirmed ? 'blocked' : 'unknown',
        inputItem: itemName, outputItem: smeltedItem?.name ?? null, requestedQuantity: num, confirmedQuantity: total,
        remainingQuantity: Math.max(0, num - total), furnacePosition: { x: furnaceBlock.position.x, y: furnaceBlock.position.y, z: furnaceBlock.position.z },
        ...(!total ? { reason: reason ?? (furnaceConfirmed && inventoryConfirmed ? 'no_output' : 'snapshot_unknown') } : {}) });
    if (total === 0) {
        log(bot, `Failed to smelt ${itemName}; no output was confirmed.`);
        return options?.returnDetails ? details() : false;
    }
    if (total < num) {
        log(bot, `Only smelted ${total} ${mc.getItemName(smeltedItem.type)}; partial result confirmed, no retry was started.`);
        return options?.returnDetails ? details() : false;
    }
    log(bot, `Successfully smelted ${itemName}, got ${total} ${mc.getItemName(smeltedItem.type)}; furnace and inventory snapshots confirmed.`);
    if (options?.returnDetails) return details();
    return true;
}

export async function clearNearestFurnace(bot, options=null) {
    /**
     * Collects the output, input, and fuel from the nearest furnace.
     * @param {MinecraftBot} bot, reference to the Minecraft bot.
     * @returns {Promise<boolean>} true only when the owned furnace and player inventory snapshots confirm the transfers; false when no furnace is available, the operation is interrupted, or its result cannot be confirmed.
     * @example
     * await skills.clearNearestFurnace(bot);
     **/
    const context = getActionContext(bot, options?.actionContext ?? (options?.furnacePosition === undefined ? options : null));
    const exactFurnacePosition = options && Object.hasOwn(options, 'furnacePosition') ? options.furnacePosition : undefined;
    const furnaceBlock = exactFurnacePosition === undefined
        ? world.getNearestBlock(bot, 'furnace', 32)
        : bot.blockAt(new Vec3(Math.floor(exactFurnacePosition.x), Math.floor(exactFurnacePosition.y), Math.floor(exactFurnacePosition.z)));
    if (exactFurnacePosition !== undefined && (!furnaceBlock || !['furnace', 'blast_furnace', 'smoker'].includes(furnaceBlock.name)))
        return failSkill(bot, 'target_not_found', `No furnace at the requested furnacePosition.`, { position: exactFurnacePosition });
    if (!furnaceBlock) {
        return failSkill(bot, 'target_not_found', 'No furnace nearby to clear.');
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4)
        if (!await goToPosition(bot, furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 4)) return false;
    if (exactFurnacePosition !== undefined) {
        const currentFurnace = bot.blockAt(new Vec3(Math.floor(exactFurnacePosition.x), Math.floor(exactFurnacePosition.y), Math.floor(exactFurnacePosition.z)));
        if (!currentFurnace || !['furnace', 'blast_furnace', 'smoker'].includes(currentFurnace.name))
            return failSkill(bot, 'target_changed', `The requested furnace changed during approach.`, { position: exactFurnacePosition });
    }
    if (isActionCancelled(bot, context)) return false;

    let furnace = null;
    let clickGuard = null;
    let cancelled = false;
    let furnaceConfirmed = false;
    let inventoryConfirmed = false;
    let operationError = null;
    let cleanupError = null;
    const returnedItems = [];
    let smeltedItem = null;
    let inputItem = null;
    let fuelItem = null;
    const baseline = new Map();
    try {
        setActionPhase(context, 'furnace-inventory-baseline');
        await craftingSync.snapshotInventory(bot);
        for (const item of bot.inventory.items()) {
            const key = `${item.type}:${item.metadata ?? 0}`;
            baseline.set(key, (baseline.get(key) || 0) + item.count);
        }
        setActionPhase(context, 'opening-furnace');
        if (isActionCancelled(bot, context)) cancelled = true;
        else furnace = await bot.openFurnace(furnaceBlock);
        if (furnace) clickGuard = guardFurnaceClicks(bot, furnace, context);
        if (furnace && isActionCancelled(bot, context)) cancelled = true;
        if (furnace && !cancelled && furnace.outputItem()) {
            setActionPhase(context, 'collecting-furnace-output');
            smeltedItem = await furnace.takeOutput();
            if (smeltedItem) returnedItems.push(smeltedItem);
            if (isActionCancelled(bot, context)) cancelled = true;
        }
        if (furnace && !cancelled && furnace.inputItem()) {
            setActionPhase(context, 'collecting-furnace-input');
            inputItem = await furnace.takeInput();
            if (inputItem) returnedItems.push(inputItem);
            if (isActionCancelled(bot, context)) cancelled = true;
        }
        if (furnace && !cancelled && furnace.fuelItem()) {
            setActionPhase(context, 'collecting-furnace-fuel');
            fuelItem = await furnace.takeFuel();
            if (fuelItem) returnedItems.push(fuelItem);
            if (isActionCancelled(bot, context)) cancelled = true;
        }
    } catch (error) {
        if (isActionCancelled(bot, context)) cancelled = true;
        else operationError = error;
    } finally {
        try {
            if (furnace) {
                setActionPhase(context, 'confirming-furnace-snapshot');
                await craftingSync.snapshotWindow(bot, furnace);
                furnaceConfirmed = true;
            }
        } catch (error) {
            bot.inventoryUnconfirmed = true;
            cleanupError = error;
        } finally {
            try {
                clickGuard?.release();
                if (furnace) await closeOwnedFurnaceWindow(bot, furnace);
            } catch (error) {
                cleanupError ||= error;
            } finally {
                if (furnace) {
                    try {
                        setActionPhase(context, cancelled || isActionCancelled(bot, context)
                            ? 'confirming-player-inventory-after-stop'
                            : 'confirming-player-inventory');
                        await craftingSync.snapshotInventory(bot);
                        inventoryConfirmed = true;
                    } catch (error) {
                        bot.inventoryUnconfirmed = true;
                        cleanupError ||= error;
                    }
                }
                if (furnace && (!furnaceConfirmed || !inventoryConfirmed)) bot.inventoryUnconfirmed = true;
            }
        }
    }
    if (operationError) throw operationError;
    if (cleanupError && !cancelled && !isActionCancelled(bot, context)) throw cleanupError;
    if (cancelled || isActionCancelled(bot, context)) {
        return failSkill(bot, 'cancelled', `Furnace clearing interrupted before completion. Furnace snapshot ${furnaceConfirmed ? 'confirmed after stopping transfers' : 'unconfirmed'}, player inventory snapshot ${inventoryConfirmed ? 'confirmed after close' : 'unconfirmed'}${bot.inventoryUnconfirmed ? '; actions are gated until state is confirmed' : ''}.`);
    }
    if (!furnace || !furnaceConfirmed) {
        return failSkill(bot, 'unconfirmed', 'Furnace clearing result is unconfirmed.');
    }
    if (!inventoryConfirmed) {
        return failSkill(bot, 'unconfirmed', 'Furnace clearing result is unconfirmed; inventory snapshot failed and actions are gated.');
    }
    if (isActionCancelled(bot, context)) {
        return failSkill(bot, 'cancelled', 'Furnace clearing interrupted after close; inventory is confirmed but this operation is not reported as success.');
    }
    const mismatches = verifyInventoryDelta(bot, baseline, returnedItems);
    if (mismatches.length) {
        return failSkill(bot, 'unconfirmed', `Furnace clearing incomplete; inventory transfer was not confirmed: ${JSON.stringify(mismatches)}`);
    }
    const smeltedName = smeltedItem ? `${smeltedItem.count} ${smeltedItem.name}` : '0 smelted items';
    const inputName = inputItem ? `${inputItem.count} ${inputItem.name}` : '0 input items';
    const fuelName = fuelItem ? `${fuelItem.count} ${fuelItem.name}` : '0 fuel items';
    log(bot, `Cleared furnace, received ${smeltedName}, ${inputName}, and ${fuelName}; furnace and inventory snapshots confirmed.`);
    return true;
}


export async function attackNearest(bot, mobType, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} mobType, the type of mob to attack.
     * @param {boolean} kill, whether or not to continue attacking until the mob is dead. Defaults to true.
     * @returns {Promise<boolean>} true if the mob was attacked, false if the mob type was not found.
     * @example
     * await skills.attackNearest(bot, "zombie", true);
     **/
    bot.modes.pause('cowardice');
    if (mobType === 'drowned' || mobType === 'cod' || mobType === 'salmon' || mobType === 'tropical_fish' || mobType === 'squid')
        bot.modes.pause('self_preservation'); // so it can go underwater. TODO: have an drowning mode so we don't turn off all self_preservation
    const mob = world.getNearbyEntities(bot, 24).find(entity => entity.name === mobType);
    if (mob) {
        return await attackEntity(bot, mob, kill);
    }
    return failSkill(bot, 'target_not_found', 'Could not find any '+mobType+' to attack.');
}

export async function attackEntity(bot, entity, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to attack.
     * @returns {Promise<boolean>} true if the entity was attacked, false if interrupted
     * @example
     * await skills.attackEntity(bot, entity);
     **/

    return fightEntity(bot, entity, kill, true);
}

// Self-defense shares the same uninterrupted attack loop, but leaves drops until
// nearby threats are gone instead of moving to collect them between opponents.
async function fightEntity(bot, entity, kill, collectDrops, range=24, defend=false) {
    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    if (bot.pathfinder) {
        const movements = navigationMovements(bot);
        bot.pathfinder.setMovements(movements);
        // PVP installs its own movements when an attack starts.
        bot.pvp.movements = movements;
    }
    const scaffoldsBeforeCombat = navigationScaffoldsPlaced(bot);
    let combatWeaponRestoredAt = scaffoldsBeforeCombat;
    const restoreCombatWeapon = async () => {
        await awaitNavigationPlacementSettled(bot);
        const placed = navigationScaffoldsPlaced(bot);
        if (placed > combatWeaponRestoredAt) {
            await equipHighestAttack(bot);
            combatWeaponRestoredAt = placed;
        }
    };
    let pos = entity.position;
    await equipHighestAttack(bot)

    if (!kill) {
        if (bot.entity.position.distanceTo(pos) > 5) {
            console.log('moving to mob...')
            if (!await goToPosition(bot, pos.x, pos.y, pos.z)) return false;
        }
        console.log('attacking mob...')
        await restoreCombatWeapon();
        await bot.attack(entity);
        await restoreCombatWeapon();
        return true;
    }
    else {
        const defeated = new Set();
        const observed = new Map();
        let lastDeathAt = 0;
        let died = false;
        let targetLost = false;
        let attackRunning = false;
        let currentTarget = null;
        let retargetAfter = 0;
        let retreating = false;
        let motionKey = null;
        const stopAttack = () => {
            if (attackRunning) {
                bot.pvp.forceStop();
                motionKey = null;
            }
            attackRunning = false;
            currentTarget = null;
        };
        const onEntityDead = dead => {
            if (!observed.has(dead?.id)) return;
            defeated.add(dead.id);
            lastDeathAt = Date.now();
            if (currentTarget?.id === dead.id) stopAttack();
        };
        const onEntityGone = gone => {
            if (observed.has(gone?.id) && !defeated.has(gone.id)) targetLost = true;
            if (bot.pvp.target?.id === gone?.id) stopAttack();
        };
        const onDeath = () => { died = true; };
        const onEnd = () => { targetLost = true; };
        const onAttacked = () => {
            retargetAfter = Date.now() + Math.max(1, bot.pvp.meleeAttackRate.getTicks(bot)) * 50;
        };
        bot.on('entityDead', onEntityDead);
        // Stop before PVP's entityGone handler starts its delayed graceful stop.
        bot.prependListener('entityGone', onEntityGone);
        bot.on('death', onDeath);
        bot.on('end', onEnd);
        bot.on('attackedTarget', onAttacked);
        const unregisterScaffoldRestore = registerNavigationScaffoldSettledCallback(bot, () => restoreCombatWeapon());
        try {
            const completed = await trackNavigationSegment(bot, async () => {
                while (!bot.interrupt_code && !died && !targetLost) {
                    // Admission radius selects new threats; an engaged enemy
                    // can leave that radius during knockback or a retreat.
                    const nearby = world.getNearbyEntities(bot, Math.max(range, 24));
                    const targets = nearby.filter(candidate => !defeated.has(candidate.id) &&
                        (defend ? mc.isHostile(candidate) && (observed.has(candidate.id) || bot.entity.position.distanceTo(candidate.position) <= range) : candidate.id === entity.id));
                    for (const target of targets) observed.set(target.id, target);
                    // Losing a loaded target does not confirm its death.
                    if ([...observed.keys()].some(id => !defeated.has(id) && !nearby.some(candidate => candidate.id === id))) {
                        return failSkill(bot, 'target_lost', 'Combat target left the loaded tracking area without a confirmed death.');
                    }
                    targets.sort((left, right) => bot.entity.position.distanceTo(left.position) - bot.entity.position.distanceTo(right.position));
                    if (!targets.length) {
                        stopAttack();
                        if (!observed.size) return false;
                        // Death can spawn new opponents (slimes); observe that
                        // server update before declaring the area defended.
                        if (!defend || Date.now() - lastDeathAt >= COMBAT_SETTLE_MS) return true;
                        await new Promise(resolve => setTimeout(resolve, COMBAT_CHECK_INTERVAL_MS));
                        continue;
                    }
                    const target = targets[0];
                    const distance = bot.entity.position.distanceTo(target.position);
                    if (distance < 3.4) retreating = true;
                    else if (distance > 4.4) retreating = false;
                    if (currentTarget?.id !== target.id) {
                        stopAttack();
                        if (Date.now() >= retargetAfter) {
                            await restoreCombatWeapon();
                            if (bot.interrupt_code || died || targetLost) return false;
                            if (defeated.has(target.id)) continue;
                            attackRunning = true;
                            await bot.pvp.attack(target);
                            currentTarget = target;
                            motionKey = null; // attack() installs PVP's own follow goal
                            if (bot.interrupt_code || died || targetLost) return false;
                        }
                    }
                    const key = retreating ? `away:${targets.map(target => target.id).sort((a, b) => a-b).join(',')}` : `toward:${target.id}`;
                    if (key !== motionKey) {
                        const follow = (opponent, radius) => {
                            const goal = new pf.goals.GoalFollow(opponent, radius);
                            // GoalFollow normally waits an entire radius before
                            // refreshing. Close combat needs each moved block.
                            goal.hasChanged = function () {
                                const position = opponent.position.floored();
                                if (this.x === position.x && this.y === position.y && this.z === position.z) return false;
                                Object.assign(this, { x: position.x, y: position.y, z: position.z });
                                return true;
                            };
                            return goal;
                        };
                        const goal = retreating
                            ? allRetreatGoals(targets.map(opponent => new pf.goals.GoalInvert(follow(opponent, 3.9))))
                            : follow(target, 2.9);
                        bot.pathfinder.setGoal(goal, true);
                        motionKey = key;
                    }
                    await new Promise(resolve => setTimeout(resolve, COMBAT_CHECK_INTERVAL_MS));
                }
                return false;
            });
            if (!completed) return false;
            log(bot, defend ? `Successfully defended self against ${observed.size} enemies.` : `Successfully killed ${entity.name}.`);
            if (collectDrops) await pickupNearbyItems(bot);
            return true;
        } catch (err) {
            return failSkill(bot, 'action_error', `Combat failed: ${err.message}.`);
        } finally {
            unregisterScaffoldRestore();
            stopAttack();
            bot.pathfinder.setGoal(null);
            bot.removeListener('entityDead', onEntityDead);
            bot.removeListener('entityGone', onEntityGone);
            bot.removeListener('death', onDeath);
            bot.removeListener('end', onEnd);
            bot.removeListener('attackedTarget', onAttacked);
            await restoreCombatWeapon();
        }
    }
}

export async function defendSelf(bot, range=9) {
    /**
     * Fight nearby hostile mobs, switching to the closest threat and maintaining
     * distance from the group. Success requires confirmed deaths and a quiet
     * interval for death-spawned enemies. Does not collect drops during combat.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} range, the range in which enemies are engaged.
     * @returns {Promise<boolean>} true after the observed enemies are killed; false on no targets, loss, failure or interruption.
     **/
    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    const enemy = world.getNearestEntityWhere(bot, candidate => mc.isHostile(candidate), range);
    if (!enemy) return failSkill(bot, 'no_targets', 'No enemies nearby to defend self from.');
    return fightEntity(bot, enemy, true, false, range, true);
}


export async function collectBlock(bot, blockType, num=1, exclude=null) {
    /**
     * Collect one of the given block type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to collect.
     * @param {number} num, the number of blocks to collect. Defaults to 1.
     * @param {list} exclude, a list of positions to exclude from the search. Defaults to null.
     * @returns {Promise<boolean>} true if the block was collected, false if the block type was not found.
     * @example
     * await skills.collectBlock(bot, "oak_log");
     **/
    if (!bot || typeof bot.blockAt !== 'function' || !bot.entity?.position ||
        typeof blockType !== 'string' || !blockType.trim() || !Number.isFinite(num) ||
        (exclude != null && (!Array.isArray(exclude) || exclude.some(p => !p || ![p.x, p.y, p.z].every(Number.isFinite))))) {
        throw new TypeError('skills.collectBlock(bot, blockType, num = 1, exclude = null): pass bot first, a block name, finite count, and optional coordinate exclusions. Example: await skills.collectBlock(bot, "oak_log", 4); exclude skips positions; use breakBlockAt for an exact target.');
    }
    if (num < 1) {
        log(bot, `Invalid number of blocks to collect: ${num}.`);
        return skillFailure('invalid_quantity', `Invalid number of blocks to collect: ${num}.`);
    }
    let blocktypes = [blockType];
    if (blockType === 'coal' || blockType === 'diamond' || blockType === 'emerald' || blockType === 'iron' || blockType === 'gold' || blockType === 'lapis_lazuli' || blockType === 'redstone')
        blocktypes.push(blockType+'_ore');
    if (blockType.endsWith('ore'))
        blocktypes.push('deepslate_'+blockType);
    if (blockType === 'dirt')
        blocktypes.push('grass_block');
    if (blockType === 'cobblestone')
        blocktypes.push('stone');
    const isLiquid = blockType === 'lava' || blockType === 'water';

    let collected = 0;
    let unconfirmed = 0;
    let stop = null;
    const collectedItems = {};
    // Quantity is server-confirmed broken blocks; picked-up drops are a separate observation.
    const finish = (legacyResult) => {
        const complete = collected >= num;
        reportSkillOutcome({ ok: complete, status: complete ? 'complete' : unconfirmed ? 'unknown' : collected ? 'partial' : 'failed',
            ...(complete ? {} : { code: stop?.code ?? 'collection_unconfirmed', reason: stop?.reason ?? 'Some block collections were not confirmed.' }),
            blockType, unit: 'block', requestedQuantity: num, confirmedQuantity: collected, remainingQuantity: Math.max(0, num - collected),
            ...(unconfirmed ? { unconfirmedQuantity: unconfirmed } : {}), collectedItems });
        return legacyResult;
    };

    const movements = navigationMovements(bot);
    movements.dontMineUnderFallingBlock = false;
    movements.dontCreateFlow = true;

    // Blocks to ignore safety for, usually next to lava/water
    const unsafeBlocks = ['obsidian'];

    for (let i=0; i<num; i++) {
        let blocks = world.getNearestBlocksWhere(bot, block => {
            if (!blocktypes.includes(block.name)) {
                return false;
            }
            // Palette entries have no position; defer coordinate and terrain checks to the positioned pass.
            if (!block.position) return true;
            if (exclude) {
                for (let position of exclude) {
                    if (block.position.x === position.x && block.position.y === position.y && block.position.z === position.z) {
                        return false;
                    }
                }
            }
            if (isLiquid) {
                // collect only source blocks
                return block.metadata === 0;
            }
            
            return movements.safeToBreak(block) || unsafeBlocks.includes(block.name);
        }, 64, 1);

        if (blocks.length === 0) {
            stop = { code: 'not_found', reason: `No ${collected === 0 ? '' : 'more '}${blockType} nearby to collect.` };
            log(bot, stop.reason);
            break;
        }
        const block = blocks[0];
        await bot.tool.equipForBlock(block);
        if (isLiquid) {
            const bucket = bot.inventory.findInventoryItem('bucket');
            if (!bucket) {
                stop = { code: 'missing_item', reason: `Don't have bucket to harvest ${blockType}.`, missingItem: 'bucket' };
                log(bot, stop.reason);
                return finish(false);
            }
            await bot.equip(bucket, 'hand');
        }
        const itemId = bot.heldItem ? bot.heldItem.type : null
        if (!block.canHarvest(itemId)) {
            stop = { code: 'missing_tool', reason: `Don't have right tools to harvest ${blockType}.` };
            log(bot, stop.reason);
            return finish(false);
        }
        const expectedItemIds = new Set();
        for (const drop of block.drops ?? []) {
            const id = typeof drop === 'number' ? drop : typeof drop.drop === 'number' ? drop.drop : drop.drop?.id;
            if (Number.isInteger(id)) expectedItemIds.add(id);
        }
        const silkTouch = bot.heldItem?.enchants?.some(enchant => enchant.name === 'silk_touch' && enchant.lvl > 0);
        if (silkTouch) {
            const blockItemId = bot.registry?.itemsByName?.[block.name]?.id;
            if (blockItemId != null) {
                expectedItemIds.clear();
                expectedItemIds.add(blockItemId);
            }
        }
        const crop = CROPS[block.name];
        for (const id of itemIdsForNames(bot, [...(crop?.produce ?? []), ...(crop ? [crop.seed] : [])])) expectedItemIds.add(id);
        const collectionTracker = !isLiquid ? trackBlockCollection(bot, block, expectedItemIds) : null;
        try {
            let success = false;
            if (isLiquid) {
                success = await useToolOnBlock(bot, 'bucket', block);
            }
            else if (mc.mustCollectManually(blockType)) {
                if (await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2)) {
                    await trackNavigationSegment(bot, () => bot.dig(block), { workTarget: block.position });
                    await pickupNearbyItems(bot);
                    success = true;
                }
            }
            else {
                // mineflayer-collectblock's collect() waits for its drop entity
                // without a deadline or cancellation; a missed entityGone hung
                // the action until the stop watchdog restarted the bot.
                await trackNavigationSegment(bot, async () => {
                    await goToGoal(bot, block.name.endsWith('_ore')
                        ? new pf.goals.GoalNear(block.position.x, block.position.y, block.position.z, 2)
                        : new pf.goals.GoalLookAtBlock(block.position, bot.world), movements);
                    // Navigation scaffolding can change the held item.
                    await bot.tool.equipForBlock(block);
                    await bot.dig(block);
                }, { workTarget: block.position });
                await pickupNearbyItems(bot);
                success = true;
            }
            if (success && !isLiquid) {
                success = await collectionTracker.wait(HARVEST_CONFIRM_TIMEOUT_MS);
                if (!success) log(bot, `Mined ${block.name}, but its target drop pickup or server block-air update was not confirmed.`);
            }
            if (success) {
                recordConfirmation({ phase: 'collect', quantity: 1, unit: 'block', target: { name: block.name, position: { x: block.position.x, y: block.position.y, z: block.position.z } },
                    evidence: isLiquid ? 'bucket inventory confirmation' : 'server block-air update and matching playerCollect' });
                collected++;
            } else {
                unconfirmed++;
                recordUncertainty({ requestedQuantity: 1, confirmedQuantity: null, unit: 'block', target: block.name, reason: 'block/drop collection not confirmed; resulting quantity is unknown' });
            }
            await autoLight(bot);
        }
        catch (err) {
            if (err.name === 'NoChests') {
                stop = { code: 'inventory_full', reason: `Failed to collect ${blockType}: Inventory full, no place to deposit.` };
                log(bot, stop.reason);
                break;
            }
            else {
                stop = { code: 'collect_error', reason: `Failed to collect ${blockType}: ${err}.` };
                log(bot, stop.reason);
                continue;
            }
        }
        finally {
            if (collectionTracker) for (const [name, count] of Object.entries(collectionTracker.collectedItems)) collectedItems[name] = (collectedItems[name] ?? 0) + count;
            collectionTracker?.cleanup();
        }
        
        if (bot.interrupt_code) {
            stop = { code: 'cancelled', reason: 'Collection was interrupted.' };
            break;
        }
    }
    log(bot, `Collected ${collected} ${blockType}.`);
    return finish(collected > 0);
}

export async function pickupNearbyItems(bot) {
    /**
     * Pick up all nearby items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the items were picked up, false otherwise.
     * @example
     * await skills.pickupNearbyItems(bot);
     **/
    const distance = 8;
    const getNearestItem = bot => bot.nearestEntity(entity => entity.name === 'item' && bot.entity.position.distanceTo(entity.position) < distance);
    let nearestItem = getNearestItem(bot);
    let pickedUp = 0;
    while (nearestItem) {
        let movements = navigationMovements(bot);
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new pf.goals.GoalFollow(nearestItem, 1));
        await new Promise(resolve => setTimeout(resolve, 200));
        let prev = nearestItem;
        nearestItem = getNearestItem(bot);
        if (prev === nearestItem) {
            break;
        }
        pickedUp++;
    }
    log(bot, `Picked up ${pickedUp} items.`);
    return true;
}


export async function breakBlockAt(bot, x, y, z) {
    /**
     * Break the block at the given position. Selects a harvest tool when available;
     * if none can harvest it, uses an empty hand when the block is still breakable.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate of the block to break.
     * @param {number} y, the y coordinate of the block to break.
     * @param {number} z, the z coordinate of the block to break.
     * @returns {Promise<boolean>} true if the block was broken, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.breakBlockAt(bot, position.x, position.y - 1, position.z);
     **/
    validateTargetCall(bot, x, y, z, 'skills.breakBlockAt(bot, x, y, z)');
    let block = bot.blockAt(Vec3(x, y, z));
    if (!block) {
        recordUncertainty({ unit: 'block', target: { position: { x, y, z } },
            reason: 'block observation is unknown; Mineflayer returned null', observedAt: new Date().toISOString() });
        return failSkill(bot, 'target_unknown', `Cannot break block at x:${x}, y:${y}, z:${z}: block observation is unknown.`);
    }
    if (block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
        if (bot.modes.isOn('cheat')) {
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' air';
            bot.chat(msg);
            log(bot, `Used /setblock to break block at ${x}, ${y}, ${z}.`);
            return true;
        }

        const expectedType = block.type;
        const expectedState = block.stateId;
        if (resolveBlockInteraction(bot, block).status !== 'ready') {
            const approach = await approachBlock(bot, x, y, z);
            if (approach.status !== 'ready') {
                return failSkill(bot, 'target_unreachable', `Cannot break target: ${approach.reason ?? approach.status}.`);
            }
            block = bot.blockAt(new Vec3(x, y, z).floored());
            if (!block || ['air', 'water', 'lava'].includes(block.name)) return failSkill(bot, 'target_changed', `Target at x:${x}, y:${y}, z:${z} changed during approach.`);
        }
        requireActiveTarget(bot);
        if (bot.game.gameMode !== 'creative') {
            await bot.tool.equipForBlock(block);
            const itemId = bot.heldItem ? bot.heldItem.type : null
            if (!block.canHarvest(itemId)) {
                const handDigTime = block.digTime(null, false,
                    ['water', 'flowing_water'].includes(bot._getBlockAtEyeLevel?.()?.name),
                    !bot.entity?.onGround, [], bot.entity?.effects ?? {});
                if (!Number.isFinite(handDigTime)) {
                    return failSkill(bot, 'missing_tool', `Don't have a harvest tool, and ${block.name} cannot be broken by hand.`);
                }
                if (bot.heldItem) await bot.unequip('hand');
                log(bot, `No harvest tool available; breaking ${block.name} by hand. It may drop nothing.`);
            }
        }
        requireActiveTarget(bot);
        block = bot.blockAt(new Vec3(x, y, z).floored());
        if (!block || block.type !== expectedType || block.stateId !== expectedState ||
            resolveBlockInteraction(bot, block).status !== 'ready') {
            return failSkill(bot, 'target_changed', 'Target changed or has no reachable surface aim point before digging.');
        }
        await trackNavigationSegment(bot, () => bot.dig(block, true), { workTarget: block.position });
        log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    else if (block.name === 'air') {
        // Removal is already satisfied; legacy callers keep their false result.
        const reason = `Block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} is already air.`;
        log(bot, reason);
        reportSkillOutcome({ ok: true, status: 'no_change', code: 'already_air', reason });
        return false;
    }
    else {
        return failSkill(bot, 'invalid_target', `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block.name}.`);
    }
    return true;
}


export async function placeBlock(bot, blockType, x, y, z, placeOn='bottom', dontCheat=false) {
    /**
     * Place the given block type at the given position. It will build off from any adjacent blocks. Will fail if there is a block in the way or nothing to build off of.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to place, which can be a block or item name.
     * @param {number} x, the x coordinate of the block to place.
     * @param {number} y, the y coordinate of the block to place.
     * @param {number} z, the z coordinate of the block to place.
     * @param {string|object} placeOn, a legacy preferred support side (top/bottom/north/south/east/west/side), or strict placement options {facing, axis, half, attachTo}. facing is the resulting block state, not the bot look direction. north=-Z, south=+Z, east=+X, west=-X; six-way blocks also allow up/down. axis is x/y/z for logs. half is top/bottom for stairs/slabs. attachTo is the side of the target containing its support; when specified it is required. Object placement never replaces occupied blocks and confirms the requested server state. An already matching block returns true without consuming an item. Legacy strings may fall back to another support.
     * @param {boolean} dontCheat, overrides cheat mode to place the block normally. Defaults to false.
     * @returns {Promise<boolean>} true if the block was placed, false otherwise.
     * @example
     * let p = world.getPosition(bot);
     * await skills.placeBlock(bot, "oak_log", p.x + 2, p.y, p.z);
     * await skills.placeBlock(bot, "torch", p.x + 1, p.y, p.z, 'side');
     * const placed = await skills.placeBlock(bot, 'oak_stairs', p.x + 2, p.y, p.z, {facing:'west', half:'top'});
     * if (!placed) { log(bot, 'Placement failed; inspect the reported block state before continuing.'); return; }
     **/
    if (typeof placeOn !== 'string') {
        return await placeBlockOriented(bot, blockType, { x, y, z }, placeOn, dontCheat, {
            log: message => log(bot, message),
            navigate: (goal, movements) => goToGoal(bot, goal, movements),
        });
    }
    validateTargetCall(bot, x, y, z, 'skills.placeBlock(bot, blockType, x, y, z, options)');
    if (typeof blockType !== 'string' || !blockType.trim()) throw new TypeError('skills.placeBlock(bot, blockType, x, y, z): blockType must be a nonempty item/block name.');
    const target_dest = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));

    if (blockType === 'air') {
        log(bot, `Placing air (removing block) at ${target_dest}.`);
        return await breakBlockAt(bot, x, y, z);
    }

    if (bot.modes.isOn('cheat') && !dontCheat) {
        if (bot.restrict_to_inventory) {
            let block = bot.inventory.findInventoryItem(blockType);
            if (!block) {
                return failSkill(bot, 'missing_item', `Cannot place ${blockType}, you are restricted to your current inventory.`, { itemName: blockType });
            }
        }

        // invert the facing direction
        let face = placeOn === 'north' ? 'south' : placeOn === 'south' ? 'north' : placeOn === 'east' ? 'west' : 'east';
        if (blockType.includes('torch') && placeOn !== 'bottom') {
            // insert wall_ before torch
            blockType = blockType.replace('torch', 'wall_torch');
            if (placeOn !== 'side' && placeOn !== 'top') {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType.includes('button') || blockType === 'lever') {
            if (placeOn === 'top') {
                blockType += `[face=ceiling]`;
            }
            else if (placeOn === 'bottom') {
                blockType += `[face=floor]`;
            }
            else {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType === 'ladder' || blockType === 'repeater' || blockType === 'comparator') {
            blockType += `[facing=${face}]`;
        }
        if (blockType.includes('stairs')) {
            blockType += `[facing=${face}]`;
        }
        if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
        let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' ' + blockType;
        bot.chat(msg);
        if (blockType.includes('door')) {
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y+1) + ' ' + Math.floor(z) + ' ' + blockType + '[half=upper]');
        }
        if (blockType.includes('bed')) {
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z-1) + ' ' + blockType + '[part=head]');
        }
        log(bot, `Used /setblock to place ${blockType} at ${target_dest}.`);
        return true;
    }

    let item_name = blockType;
    if (item_name == "redstone_wire")
        item_name = "redstone";
    else if (item_name === 'water') {
        item_name = 'water_bucket';
    }
    else if (item_name === 'lava') {
        item_name = 'lava_bucket';
    }
    const targetBlock = bot.blockAt(target_dest);
    if (!targetBlock) {
        recordUncertainty({ unit: 'block', target: { position: { x: target_dest.x, y: target_dest.y, z: target_dest.z } },
            reason: 'placement target observation is unknown; Mineflayer returned null', observedAt: new Date().toISOString() });
        return failSkill(bot, 'target_unknown', `Cannot place ${blockType} at ${target_dest}: target block observation is unknown.`);
    }
    let block_item = bot.inventory.findInventoryItem(item_name);
    if (!block_item && bot.game.gameMode === 'creative' && !bot.restrict_to_inventory) {
        await bot.creative.setInventorySlot(36, mc.makeItem(item_name, 1)); // 36 is first hotbar slot
        block_item = bot.inventory.findInventoryItem(item_name);
    }
    if (!block_item) {
        return failSkill(bot, 'missing_item', `Don't have any ${item_name} to place.`, { itemName: item_name });
    }

    if (targetBlock.name === blockType || (targetBlock.name === 'grass_block' && blockType === 'dirt')) {
        return failSkill(bot, 'already_present', `${blockType} already at ${targetBlock.position}.`, { existingBlock: targetBlock.name });
    }
    const empty_blocks = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'];
    if (!empty_blocks.includes(targetBlock.name)) {
        log(bot, `${targetBlock.name} in the way at ${targetBlock.position}.`);
        const removed = await breakBlockAt(bot, x, y, z);
        if (!removed) {
            return failSkill(bot, 'blocked', `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`);
        }
        await new Promise(resolve => setTimeout(resolve, 200)); // wait for block to break
    }
    // get the buildoffblock and facevec based on whichever adjacent block is not empty
    let buildOffBlock = null;
    let faceVec = null;
    let unknownAdjacentBlock = false;
    const dir_map = {
        'top': Vec3(0, 1, 0),
        'bottom': Vec3(0, -1, 0),
        'north': Vec3(0, 0, -1),
        'south': Vec3(0, 0, 1),
        'east': Vec3(1, 0, 0),
        'west': Vec3(-1, 0, 0),
    }
    let dirs = [];
    if (placeOn === 'side') {
        dirs.push(dir_map['north'], dir_map['south'], dir_map['east'], dir_map['west']);
    }
    else if (dir_map[placeOn] !== undefined) {
        dirs.push(dir_map[placeOn]);
    }
    else {
        dirs.push(dir_map['bottom']);
        log(bot, `Unknown placeOn value "${placeOn}". Defaulting to bottom.`);
    }
    dirs.push(...Object.values(dir_map).filter(d => !dirs.includes(d)));

    for (let d of dirs) {
        const block = bot.blockAt(target_dest.plus(d));
        if (!block) {
            unknownAdjacentBlock = true;
            continue;
        }
        if (!empty_blocks.includes(block.name)) {
            buildOffBlock = block;
            faceVec = new Vec3(-d.x, -d.y, -d.z); // invert
            break;
        }
    }
    if (!buildOffBlock) {
        if (unknownAdjacentBlock) {
            recordUncertainty({ unit: 'block', target: { position: { x: target_dest.x, y: target_dest.y, z: target_dest.z } },
                reason: 'placement support observation is unknown; Mineflayer returned null', observedAt: new Date().toISOString() });
            return failSkill(bot, 'target_unknown', `Cannot place ${blockType} at ${target_dest}: support blocks are not fully observed.`);
        }
        return failSkill(bot, 'missing_support', `Cannot place ${blockType} at ${targetBlock.position}: nothing to place on.`);
    }

    const pos = bot.entity.position;
    const pos_above = pos.plus(Vec3(0,1,0));
    const dont_move_for = ['torch', 'redstone_torch', 'redstone', 'lever', 'button', 'rail', 'detector_rail', 
        'powered_rail', 'activator_rail', 'tripwire_hook', 'tripwire', 'water_bucket', 'string'];
    if (!dont_move_for.includes(item_name) && (pos.distanceTo(targetBlock.position) < 1.1 || pos_above.distanceTo(targetBlock.position) < 1.1)) {
        // too close
        let goal = new pf.goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
        let inverted_goal = new pf.goals.GoalInvert(goal);
        await goToGoal(bot, inverted_goal);
    }
    if (bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
        // too far
        let pos = targetBlock.position;
        let movements = new pf.Movements(bot);
        bot.pathfinder.setMovements(navigationMovements(bot, movements));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }

    // will throw error if an entity is in the way, and sometimes even if the block was placed
    try {
        if (item_name.includes('bucket')) {
            const expectedFluid = item_name === 'water_bucket' ? 'water' : item_name === 'lava_bucket' ? 'lava' : null;
            if (!expectedFluid) return failSkill(bot, 'invalid_target', `${item_name} cannot be placed as a fluid.`);
            const placement = waitForBlockUpdate(bot, target_dest, block => block?.name === expectedFluid, INTERACTION_CONFIRM_TIMEOUT_MS);
            try {
                if (!await useToolOnBlock(bot, item_name, buildOffBlock)) return false;
                const confirmed = await placement.promise;
                if (!confirmed) log(bot, `Could not confirm ${expectedFluid} at ${target_dest}.`);
                return confirmed;
            } finally {
                placement.cleanup();
            }
        }
        else {
            await bot.equip(block_item, 'hand');
            await bot.lookAt(buildOffBlock.position.offset(0.5, 0.5, 0.5));
            await bot.placeBlock(buildOffBlock, faceVec);
            log(bot, `Placed ${blockType} at ${target_dest}.`);
            await new Promise(resolve => setTimeout(resolve, 200));
            return true;
        }
    } catch (err) {
        return failSkill(bot, 'unconfirmed', `Failed to place ${blockType} at ${target_dest}.`);
    }
}

export async function equip(bot, itemName) {
    /**
     * Equip the given item to the proper body part, like tools or armor.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to equip.
     * @returns {Promise<boolean>} true if the item was equipped, false otherwise.
     * @example
     * await skills.equip(bot, "iron_pickaxe");
     **/
    if (itemName === 'hand') {
        await bot.unequip('hand');
        log(bot, `Unequipped hand.`);
        return true;
    }
    let item = bot.inventory.slots.find(slot => slot && slot.name === itemName);
    if (!item) {
        if (bot.game.gameMode === "creative") {
            await bot.creative.setInventorySlot(36, mc.makeItem(itemName, 1));
            item = bot.inventory.findInventoryItem(itemName);
        }
        else {
            return failSkill(bot, 'missing_item', `You do not have any ${itemName} to equip.`, { itemName });
        }
    }
    if (itemName.includes('leggings')) {
        await bot.equip(item, 'legs');
    }
    else if (itemName.includes('boots')) {
        await bot.equip(item, 'feet');
    }
    else if (itemName.includes('helmet')) {
        await bot.equip(item, 'head');
    }
    else if (itemName.includes('chestplate') || itemName.includes('elytra')) {
        await bot.equip(item, 'torso');
    }
    else if (itemName.includes('shield')) {
        await bot.equip(item, 'off-hand');
    }
    else {
        await bot.equip(item, 'hand');
    }
    log(bot, `Equipped ${itemName}.`);
    return true;
}

export async function discard(bot, itemName, num=-1) {
    /**
     * Discard the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to discard.
     * @param {number} num, the number of items to discard. Defaults to -1, which discards all items.
     * @returns {Promise<boolean>} true if the item was discarded, false otherwise.
     * @example
     * await skills.discard(bot, "oak_log");
     **/
    const before = inventoryItemCount(bot, itemName);
    let discarded = 0;
    while (true) {
        let item = bot.inventory.findInventoryItem(itemName);
        if (!item) {
            break;
        }
        let to_discard = num === -1 ? item.count : Math.min(num - discarded, item.count);
        await bot.toss(item.type, null, to_discard);
        discarded += to_discard;
        if (num !== -1 && discarded >= num) {
            break;
        }
    }
    const requested = num === -1 ? null : num;
    const confirmed = Math.max(0, before - inventoryItemCount(bot, itemName));
    const quantities = { itemName, unit: 'item', requestedQuantity: requested, confirmedQuantity: confirmed,
        remainingQuantity: requested == null ? null : Math.max(0, requested - confirmed) };
    if (discarded === 0) {
        return failSkill(bot, 'missing_item', `You do not have any ${itemName} to discard.`, quantities);
    }
    const complete = requested == null ? confirmed > 0 : confirmed >= requested;
    reportSkillOutcome({ ok: complete, status: complete ? 'complete' : confirmed > 0 ? 'partial' : 'unknown', ...quantities,
        ...(complete ? {} : confirmed < discarded
            ? { code: 'discard_unconfirmed', reason: `Tossed ${discarded} ${itemName}, but inventory confirmed only ${confirmed}.` }
            : { code: 'insufficient_items', reason: `Only ${confirmed} of ${requested} ${itemName} were available to discard.` }) });
    log(bot, `Discarded ${discarded} ${itemName}.`);
    return true;
}

function validateChestTransferOptions(options, signature) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError(`${signature}: options must be an object. Example: ${signature.split('(')[0]}(bot, "oak_log", -1, { chestPosition: { x: 10, y: 64, z: -3 } });`);
    }
    if (options.chestPosition !== undefined) {
        const position = options.chestPosition;
        if (!position || typeof position !== 'object' || Array.isArray(position) ||
            ![position.x, position.y, position.z].every(Number.isFinite)) {
            throw new TypeError(`${signature}: options.chestPosition must contain finite x, y and z coordinates. Example: ${signature.split('(')[0]}(bot, "oak_log", -1, { chestPosition: { x: 10, y: 64, z: -3 } });`);
        }
    }
    return options.chestPosition;
}

function validateChestTransferQuantity(num, signature) {
    if (num !== -1 && (!Number.isSafeInteger(num) || num <= 0)) {
        throw new TypeError(`${signature}: num must be a positive safe integer or -1 for all available items.`);
    }
}

function chestTransferOutput(bot, direction, requestedQuantity, confirmedQuantity, chest) {
    const chestPosition = chest?.position
        ? { x: chest.position.x, y: chest.position.y, z: chest.position.z }
        : null;
    const remainingQuantity = confirmedQuantity == null
        ? null
        : Math.max(0, requestedQuantity - confirmedQuantity);
    log(bot, `Chest ${direction}: ${JSON.stringify({ requestedQuantity, confirmedQuantity, remainingQuantity, chestPosition })}`);
}

function chestTransferResult(options, { itemName, requestedQuantity, confirmedQuantity, chest, cancelled = false, reason, unknown = false, legacyOk = false }) {
    const complete = !cancelled && !unknown && requestedQuantity > 0 && confirmedQuantity === requestedQuantity;
    const ok = complete;
    const status = cancelled ? 'cancelled' : unknown || confirmedQuantity == null ? 'unknown'
        : complete ? 'complete' : confirmedQuantity > 0 ? 'partial' : 'blocked';
    if (options?.details !== true) return legacyOk || ok;
    return { ok, status, itemName, requestedQuantity, confirmedQuantity,
        remainingQuantity: requestedQuantity == null || confirmedQuantity == null ? null : Math.max(0, requestedQuantity - confirmedQuantity),
        ...(chest?.position ? { chestPosition: { x: chest.position.x, y: chest.position.y, z: chest.position.z } } : {}),
        ...(reason ? { reason } : {}) };
}

async function resolveChestTransferTarget(bot, chestPosition) {
    if (chestPosition === undefined) {
        const chest = world.getNearestBlock(bot, 'chest', 32);
        if (!chest) log(bot, `Could not find a chest nearby.`);
        return { chest, reason: chest ? null : 'chest_unavailable' };
    }
    const x = chestPosition.x, y = chestPosition.y, z = chestPosition.z;
    let target = world.inspectBlockAt(bot, x, y, z);
    if (!target.loaded) {
        const reached = await goToPosition(bot, Math.floor(x) + 1.5, Math.floor(y), Math.floor(z) + 0.5, 1);
        if (!reached) {
            log(bot, `Chest target at ${target.position.x}, ${target.position.y}, ${target.position.z} is unknown and its exact approach position was not reached.`);
            return { chest: null, reason: 'chest_target_unloaded: exact approach position was not reached' };
        }
        target = world.inspectBlockAt(bot, x, y, z);
        if (!target.loaded) {
            log(bot, `Chest target at ${target.position.x}, ${target.position.y}, ${target.position.z} is still unknown after approaching its exact position.`);
            return { chest: null, reason: 'chest_target_unloaded: still unknown after approach' };
        }
    }
    if (!['chest', 'trapped_chest'].includes(target.name)) {
        log(bot, `Target at ${target.position.x}, ${target.position.y}, ${target.position.z} is ${target.name}, not a chest.`);
        return { chest: null, reason: 'chest_target_is_not_container' };
    }
    const approach = await approachBlock(bot, x, y, z);
    if (approach.status !== 'ready') {
        log(bot, `Could not reach chest at ${target.position.x}, ${target.position.y}, ${target.position.z}: ${approach.reason || approach.status}.`);
        return { chest: null, reason: approach.reason || approach.status };
    }
    // Navigation can change what is loaded or present. Re-observe this exact
    // coordinate and never replace it with a nearby chest.
    target = world.inspectBlockAt(bot, x, y, z);
    if (!target.loaded) {
        log(bot, `Chest target at ${target.position.x}, ${target.position.y}, ${target.position.z} became unknown after approach.`);
        return { chest: null, reason: 'chest_target_unloaded: became unknown after approach' };
    }
    if (!['chest', 'trapped_chest'].includes(target.name)) {
        log(bot, `Target at ${target.position.x}, ${target.position.y}, ${target.position.z} changed to ${target.name} after approach; it is not a chest.`);
        return { chest: null, reason: 'chest_target_changed' };
    }
    return { chest: bot.blockAt(new Vec3(x, y, z).floored()), reason: null };
}

// Native activateBlock accepts face/cursor but still looks at the center. Keep
// its inventory/window implementation and redirect just this activation's aim.
async function openContainerAtSurface(bot, block) {
    requireActiveTarget(bot);
    let hit = resolveBlockInteraction(bot, block);
    if (hit.status !== 'ready') throw new Error(hit.reason);
    const check = () => {
        requireActiveTarget(bot);
        const fresh = bot.blockAt(block.position);
        if (!fresh || fresh.type !== block.type || fresh.stateId !== block.stateId) throw new Error('Chest target changed before activation.');
        const current = resolveBlockInteraction(bot, fresh, { direction: hit.aim.minus(interactionEye(bot)) });
        if (current.status !== 'ready') throw new Error(current.reason);
        hit = current;
    };
    const direction = interactionFaceVector(hit.face);
    const cursor = hit.aim.minus(block.position);
    const originalLookAt = bot.lookAt;
    const originalActivate = bot.activateBlock;
    const originalWrite = bot._client?.write;
    let fail;
    const failure = new Promise((_, reject) => { fail = reject; });
    failure.catch(() => {});
    const signal = getActionContext(bot)?.signal;
    const abort = () => fail(new Error('Chest opening cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    if (typeof originalLookAt === 'function') bot.lookAt = async function (_point, force) {
        check();
        await originalLookAt.call(this, hit.aim, force);
        check();
    };
    // openBlock does not await activateBlock; catch its errors here so they
    // reject the owned operation rather than becoming an unhandled rejection.
    if (typeof originalActivate === 'function') bot.activateBlock = function (...args) {
        return Promise.resolve(originalActivate.apply(this, args)).catch(fail);
    };
    const guardedWrite = function (name, packet, ...args) {
        if (name === 'block_place' && packet.location?.equals?.(block.position)) {
            try { check(); }
            catch (error) { fail(error); return; }
        }
        return originalWrite.call(this, name, packet, ...args);
    };
    if (typeof originalWrite === 'function') bot._client.write = guardedWrite;
    let pending, completed = false;
    try {
        pending = bot.openContainer(block, direction, cursor);
        const container = await Promise.race([pending, failure]);
        completed = true;
        return container;
    } catch (error) {
        if (!signal?.aborted) {
            const above = bot.blockAt(block.position.offset(0, 1, 0));
            const evidence = { target: { name: block.name, position: block.position },
                interaction: resolveBlockInteraction(bot, bot.blockAt(block.position)),
                above: above ? { name: above.name, position: above.position } : null,
                sneaking: bot.getControlState?.('sneak') ?? null,
                heldItem: bot.heldItem?.name ?? null, currentWindow: bot.currentWindow?.type ?? null };
            recordNavigationDiagnostic(bot, 'container_open_failed', { error: String(error), evidence });
            error.message += `; container observation: ${JSON.stringify(evidence)}`;
        }
        throw error;
    } finally {
        if (typeof originalLookAt === 'function') bot.lookAt = originalLookAt;
        if (typeof originalActivate === 'function') bot.activateBlock = originalActivate;
        if (bot._client?.write === guardedWrite) bot._client.write = originalWrite;
        signal?.removeEventListener('abort', abort);
        // Native window waiting is bounded. If a cancelled activation opens
        // late, close that operation's window instead of leaving it open.
        if (!completed && pending) pending.then(container => container.close()).catch(() => {});
    }
}

export async function putInChest(bot, itemName, num=-1, options={}) {
    /**
     * Put an exact requested quantity of an item in a chest; -1 means all available matching stacks.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to put in the chest.
     * @param {number} num, a positive safe integer quantity, or -1 to put all available matching stacks.
     * @param {object} options, optional { chestPosition: { x, y, z } } to select one exact loaded chest; omitted uses the nearest chest.
     * @returns {Promise<boolean>} true only when the full requested quantity is server-confirmed; false on a known shortage or incomplete transfer.
     * @example
     * const stored = await skills.putInChest(bot, "oak_log", 262, { chestPosition: { x: 10, y: 64, z: -3 } });
     * log(bot, `stored all requested items: ${stored}`);
     **/
    const signature = 'skills.putInChest(bot, itemName, num, options)';
    validateChestTransferQuantity(num, signature);
    const chestPosition = validateChestTransferOptions(options, signature);
    const initialAvailable = inventoryItemCount(bot, itemName);
    let requestedQuantity = num === -1 ? initialAvailable : num;
    const target = await resolveChestTransferTarget(bot, chestPosition);
    const chest = target.chest;
    if (!chest) {
        if (chestPosition === undefined) log(bot, `Could not find a chest nearby.`);
        return chestTransferResult(options, { itemName, requestedQuantity, confirmedQuantity: 0, reason: target.reason });
    }
    if (chestPosition === undefined && !await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2))
        return chestTransferResult(options, { itemName, requestedQuantity, confirmedQuantity: 0, chest, reason: 'chest_unreachable' });
    const context = getActionContext(bot);
    if (isActionCancelled(bot, context)) return chestTransferResult(options, { itemName, requestedQuantity, confirmedQuantity: 0, chest, cancelled: true });
    const chestContainer = await (chestPosition === undefined ? bot.openContainer(chest) : openContainerAtSurface(bot, chest));
    let beforeSnapshot = null;
    let afterSnapshot = null;
    let transferError = null;
    let snapshotError = null;
    let closeError = null;
    let attemptedQuantity = 0;
    try {
        try { beforeSnapshot = await craftingSync.snapshotWindow(bot, chestContainer); }
        catch (error) { snapshotError = error; }
        const available = beforeSnapshot
            ? countFencedWindowRegion(beforeSnapshot, chestContainer.inventoryStart, chestContainer.inventoryEnd, itemName)
            : initialAvailable;
        requestedQuantity = num === -1 ? available : num;
        const toPut = Math.min(requestedQuantity, available);
        if (beforeSnapshot && toPut > 0 && !isActionCancelled(bot, context)) {
            attemptedQuantity = toPut;
            try { await chestContainer.deposit(mc.getItemId(itemName), null, toPut); }
            catch (error) { transferError = error; }
            try { afterSnapshot = await craftingSync.snapshotWindow(bot, chestContainer); }
            catch (error) { snapshotError = error; }
        } else if (beforeSnapshot) {
            afterSnapshot = beforeSnapshot;
        }
    }
    finally {
        try { await chestContainer.close(); }
        catch (error) { closeError = error; bot.inventoryUnconfirmed = true; }
    }
    let confirmed = null;
    let uncertaintyReason = 'server-fenced container snapshots unavailable';
    if (beforeSnapshot && afterSnapshot && attemptedQuantity === 0) {
        confirmed = 0;
    } else if (beforeSnapshot && afterSnapshot) {
        const containerDelta = countFencedWindowRegion(afterSnapshot, 0, chestContainer.inventoryStart, itemName) - countFencedWindowRegion(beforeSnapshot, 0, chestContainer.inventoryStart, itemName);
        const inventoryDelta = countFencedWindowRegion(beforeSnapshot, chestContainer.inventoryStart, chestContainer.inventoryEnd, itemName) - countFencedWindowRegion(afterSnapshot, chestContainer.inventoryStart, chestContainer.inventoryEnd, itemName);
        if (containerDelta === inventoryDelta && containerDelta >= 0) {
            confirmed = containerDelta;
            if (confirmed > 0) recordConfirmation({ phase: 'chest-deposit', quantity: confirmed, requestedQuantity, remainingQuantity: Math.max(0, requestedQuantity - confirmed), unit: 'item', target: { itemName, chest: { x: chest.position.x, y: chest.position.y, z: chest.position.z } },
                evidence: 'matching slot deltas between two server window_items snapshots fenced by statistics' });
        } else {
            bot.inventoryUnconfirmed = true;
            uncertaintyReason = 'server-fenced container and player-inventory slot deltas disagree';
        }
    }
    if (confirmed == null || confirmed !== attemptedQuantity || transferError) {
        if (confirmed != null) recordUncertainty({ requestedQuantity: attemptedQuantity, confirmedQuantity: confirmed, unit: 'item', target: itemName,
            reason: 'server-fenced container transfer did not confirm the full requested slot delta' });
        else recordUncertainty({ requestedQuantity: attemptedQuantity || requestedQuantity, confirmedQuantity: null, unit: 'item', target: itemName, reason: `${uncertaintyReason}${snapshotError ? `: ${String(snapshotError)}` : ''}` });
        bot.inventoryUnconfirmed = true;
    }
    chestTransferOutput(bot, 'deposit', requestedQuantity, confirmed, chest);
    if (transferError && options?.details !== true) throw transferError;
    if (closeError && options?.details !== true) throw closeError;
    if (isActionCancelled(bot, context)) return chestTransferResult(options, { itemName, requestedQuantity, confirmedQuantity: confirmed, chest, cancelled: true,
        reason: transferError?.message ?? closeError?.message });
    if (closeError) return chestTransferResult(options, { itemName, requestedQuantity, confirmedQuantity: confirmed, chest, unknown: true, reason: `container_close_failed: ${String(closeError)}` });
    if (confirmed !== requestedQuantity) {
        log(bot, `Chest transfer was incomplete: confirmed ${confirmed == null ? 'unknown' : confirmed} of ${requestedQuantity} ${itemName}${confirmed === attemptedQuantity && attemptedQuantity < requestedQuantity ? '; only the currently available inventory was transferred.' : '; inventory actions are gated until state is confirmed.'}`);
        return chestTransferResult(options, { itemName, requestedQuantity, confirmedQuantity: confirmed, chest,
            unknown: confirmed == null, reason: transferError?.message ?? (confirmed == null ? 'snapshot_unknown' : 'quantity_shortfall') });
    }
    log(bot, `Successfully put ${confirmed} ${itemName} in the chest.`);
    return chestTransferResult(options, { itemName, requestedQuantity, confirmedQuantity: confirmed, chest, legacyOk: true });
}

export async function takeFromChest(bot, itemName, num=-1, options={}) {
    /**
     * Take an exact requested quantity of an item from a chest; -1 means all available matching stacks.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to take from the chest.
     * @param {number} num, a positive safe integer quantity, or -1 to take all available matching stacks.
     * @param {object} options, optional { chestPosition: { x, y, z } } to select one exact loaded chest; omitted uses the nearest chest.
     * @returns {Promise<boolean>} true only when the full requested quantity is server-confirmed; false on a known shortage or incomplete transfer.
     * @example
     * const taken = await skills.takeFromChest(bot, "oak_log", -1, { chestPosition: { x: 10, y: 64, z: -3 } });
     * log(bot, `took all available items: ${taken}`);
     * **/
    const signature = 'skills.takeFromChest(bot, itemName, num, options)';
    validateChestTransferQuantity(num, signature);
    const chestPosition = validateChestTransferOptions(options, signature);
    const target = await resolveChestTransferTarget(bot, chestPosition);
    const chest = target.chest;
    if (!chest) {
        if (chestPosition === undefined) log(bot, `Could not find a chest nearby.`);
        return chestTransferResult(options, { itemName, requestedQuantity: num === -1 ? null : num, confirmedQuantity: 0, reason: target.reason });
    }
    if (chestPosition === undefined && !await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2))
        return chestTransferResult(options, { itemName, requestedQuantity: num === -1 ? null : num, confirmedQuantity: 0, chest, reason: 'chest_unreachable' });
    const context = getActionContext(bot);
    if (isActionCancelled(bot, context)) return chestTransferResult(options, { itemName, requestedQuantity: num === -1 ? null : num, confirmedQuantity: 0, chest, cancelled: true });
    const chestContainer = await (chestPosition === undefined ? bot.openContainer(chest) : openContainerAtSurface(bot, chest));
    let serverSnapshot;
    try { serverSnapshot = await craftingSync.snapshotWindow(bot, chestContainer); }
    catch (error) {
        try { await chestContainer.close(); } catch { bot.inventoryUnconfirmed = true; }
        bot.inventoryUnconfirmed = true;
        recordUncertainty({ requestedQuantity: num === -1 ? null : num, confirmedQuantity: null, unit: 'item', target: itemName,
            reason: `server-fenced chest snapshot unavailable: ${String(error)}` });
        chestTransferOutput(bot, 'withdraw', num === -1 ? null : num, null, chest);
        if (options?.details === true) return chestTransferResult(options, { itemName, requestedQuantity: num === -1 ? null : num, confirmedQuantity: null, chest,
            unknown: true, reason: `snapshot_unknown: ${String(error)}` });
        throw error;
    }
    
    // Find all matching items in the chest
    const totalAvailable = countFencedWindowRegion(serverSnapshot, 0, chestContainer.inventoryStart, itemName);
    const requestedQuantity = num === -1 ? totalAvailable : num;
    const toTake = Math.min(requestedQuantity, totalAvailable);
    if (totalAvailable === 0) {
        log(bot, `Could not find any ${itemName} in the chest.`);
        try { await chestContainer.close(); }
        catch (error) { bot.inventoryUnconfirmed = true; throw error; }
        chestTransferOutput(bot, 'withdraw', requestedQuantity, 0, chest);
        return chestTransferResult(options, { itemName, requestedQuantity, confirmedQuantity: 0, chest, reason: 'item_unavailable' });
    }
    let afterSnapshot = null;
    let transferError = null;
    const attemptedQuantity = isActionCancelled(bot, context) ? 0 : toTake;
    if (attemptedQuantity > 0) {
        try { await chestContainer.withdraw(mc.getItemId(itemName), null, attemptedQuantity); }
        catch (error) { transferError = error; }
        try { afterSnapshot = await craftingSync.snapshotWindow(bot, chestContainer); }
        catch (error) { transferError ||= error; }
    } else {
        afterSnapshot = serverSnapshot;
    }
    let confirmed = null;
    if (afterSnapshot) {
        const containerDelta = countFencedWindowRegion(serverSnapshot, 0, chestContainer.inventoryStart, itemName) - countFencedWindowRegion(afterSnapshot, 0, chestContainer.inventoryStart, itemName);
        const inventoryDelta = countFencedWindowRegion(afterSnapshot, chestContainer.inventoryStart, chestContainer.inventoryEnd, itemName) - countFencedWindowRegion(serverSnapshot, chestContainer.inventoryStart, chestContainer.inventoryEnd, itemName);
        if (containerDelta === inventoryDelta && containerDelta >= 0) {
            confirmed = containerDelta;
            if (confirmed > 0) recordConfirmation({ phase: 'chest-withdraw', quantity: confirmed, unit: 'item', requestedQuantity, remainingQuantity: Math.max(0, requestedQuantity - confirmed), target: { itemName, chest: { x: chest.position.x, y: chest.position.y, z: chest.position.z } },
                evidence: 'matching slot deltas between two server window_items snapshots fenced by statistics' });
        } else {
            bot.inventoryUnconfirmed = true;
            recordUncertainty({ requestedQuantity: toTake, confirmedQuantity: null, unit: 'item', target: itemName,
                reason: 'server-fenced container and player-inventory slot deltas disagree' });
        }
    } else {
        bot.inventoryUnconfirmed = true;
        recordUncertainty({ requestedQuantity: toTake, confirmedQuantity: null, unit: 'item', target: itemName,
            reason: `server-fenced chest snapshot unavailable${transferError ? `: ${String(transferError)}` : ''}` });
    }
    if (confirmed == null || confirmed !== attemptedQuantity || transferError) {
        bot.inventoryUnconfirmed = true;
        if (confirmed != null) recordUncertainty({ requestedQuantity: attemptedQuantity, confirmedQuantity: confirmed, unit: 'item', target: itemName,
            reason: 'server-fenced chest transfer did not confirm the full attempted quantity' });
    }
    let closeError;
    try { await chestContainer.close(); }
    catch (error) { bot.inventoryUnconfirmed = true; closeError = error; }
    chestTransferOutput(bot, 'withdraw', requestedQuantity, confirmed, chest);
    if (transferError && options?.details !== true) throw transferError;
    if (closeError && options?.details !== true) throw closeError;
    if (isActionCancelled(bot, context)) return chestTransferResult(options, { itemName, requestedQuantity, confirmedQuantity: confirmed, chest, cancelled: true,
        reason: transferError?.message ?? closeError?.message });
    if (closeError) return chestTransferResult(options, { itemName, requestedQuantity, confirmedQuantity: confirmed, chest, unknown: true, reason: `container_close_failed: ${String(closeError)}` });
    if (confirmed !== requestedQuantity) {
        log(bot, `Chest transfer was incomplete: confirmed ${confirmed == null ? 'unknown' : confirmed} of ${requestedQuantity} ${itemName}${confirmed === toTake && toTake < requestedQuantity ? '; the chest contained fewer items than requested.' : '; inventory actions are gated until state is confirmed.'}`);
        return chestTransferResult(options, { itemName, requestedQuantity, confirmedQuantity: confirmed, chest,
            unknown: confirmed == null, reason: transferError?.message ?? (confirmed == null ? 'snapshot_unknown' : 'quantity_shortfall') });
    }
    log(bot, `Successfully took ${confirmed} ${itemName} from the chest.`);
    return chestTransferResult(options, { itemName, requestedQuantity, confirmedQuantity: confirmed, chest });
}

export async function approachBlock(bot, x, y, z) {
    /**
     * Move to a standing position with a reachable surface aim point for one absolute block, without digging or placing. Center visibility is not required.
     * @param {MinecraftBot} bot - Pass bot first.
     * @param {number} x - Absolute block x.
     * @param {number} y - Absolute block y.
     * @param {number} z - Absolute block z.
     * @returns {Promise<object>} status ready/unknown/blocked and fresh target with interaction aim/face/distance; movement is not interaction success. No sampled aim is not proof that every surface point is occluded.
     * @example
     * log(bot, JSON.stringify(await skills.approachBlock(bot, 10, 64, -3)));
     **/
    validateTargetCall(bot, x, y, z, 'skills.approachBlock(bot, x, y, z)');
    requireActiveTarget(bot);
    let target = world.inspectBlockAt(bot, x, y, z);
    const ready = t => t.loaded && t.interaction.status === 'ready';
    if (!target.loaded) return { status: 'unknown', target, reason: 'Target is not loaded; no navigation started.' };
    if (ready(target)) return { status: 'ready', target };
    if (target.interaction.status === 'unknown') return { status: 'unknown', target, reason: target.interaction.reason };
    const previousMovements = bot.pathfinder.movements;
    const movements = new pf.Movements(bot);
    movements.canDig = false;
    movements.canPlaceOn = false;
    movements.allow1by1towers = false;
    movements.allowFreeMotion = false;
    movements.scafoldingBlocks = [];
    const block = bot.blockAt(new Vec3(x, y, z).floored());
    const goal = makeBlockInteractionGoal(bot, block.position);
    let navigationError = null;
    try {
        await goToGoal(bot, goal, movements);
    } catch (error) {
        requireActiveTarget(bot);
        navigationError = String(error);
    } finally {
        if (previousMovements) bot.pathfinder.setMovements(previousMovements);
    }
    requireActiveTarget(bot);
    target = world.inspectBlockAt(bot, x, y, z);
    if (!target.loaded) return { status: 'unknown', target, reason: 'Target unloaded during navigation.' };
    if (ready(target)) return { status: 'ready', target };
    return { status: target.interaction.status === 'unknown' ? 'unknown' : 'blocked', target,
        reason: navigationError || target.interaction.reason };
}

export async function inspectChestAt(bot, x, y, z) {
    /**
     * Inspect the chest at absolute coordinates, returning actual container position, contents and observation time. Never selects a nearest substitute.
     * @param {MinecraftBot} bot - Pass bot first.
     * @param {number} x - Absolute chest x.
     * @param {number} y - Absolute chest y.
     * @param {number} z - Absolute chest z.
     * @returns {Promise<object>} status observed/unknown/not_chest/blocked; cancellation throws and an opened container is always closed. Double chests expose combined contents.
     * @example
     * log(bot, JSON.stringify(await skills.inspectChestAt(bot, 10, 64, -3)));
     **/
    validateTargetCall(bot, x, y, z, 'skills.inspectChestAt(bot, x, y, z)');
    requireActiveTarget(bot);
    const isChest = t => ['chest', 'trapped_chest'].includes(t.name);
    let target = world.inspectBlockAt(bot, x, y, z);
    if (!target.loaded) return { status: 'unknown', target };
    if (!isChest(target)) return { status: 'not_chest', target };
    const approach = await approachBlock(bot, x, y, z);
    if (approach.status !== 'ready') return approach;
    requireActiveTarget(bot);
    target = world.inspectBlockAt(bot, x, y, z);
    if (!target.loaded) return { status: 'unknown', target };
    if (!isChest(target)) return { status: 'not_chest', target, reason: 'Target changed during navigation.' };
    const cancellation = getActionContext(bot);
    const previousPhase = cancellation?.phase ?? 'executing';
    setActionPhase(cancellation, 'inspecting-chest');
    let chest;
    try {
        chest = await openContainerAtSurface(bot, bot.blockAt(new Vec3(x, y, z).floored()));
        requireActiveTarget(bot);
        const result = { status: 'observed', position: target.position, target,
            observedAt: new Date().toISOString(),
            contents: chest.containerItems().map(item => ({ name: item.name, count: item.count, slot: item.slot })) };
        recordConfirmation({ unit: 'container_observation', target: { position: result.position },
            observedAt: result.observedAt, contents: result.contents });
        return result;
    } finally {
        try { if (chest) await chest.close(); }
        finally { setActionPhase(cancellation, previousPhase); }
    }
}

export async function inspectChest(bot, position=null) {
    let chest = position == null ? world.getNearestBlocksWhere(bot, block => ['chest', 'trapped_chest'].includes(block.name), 32, 1)[0]
        : bot.blockAt(new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)));
    if (!chest) return { status: position == null ? 'not_found' : 'unknown', target: null };
    if (!['chest', 'trapped_chest'].includes(chest.name)) return { status: 'not_chest', target: world.inspectBlockAt(bot, chest.position.x, chest.position.y, chest.position.z) };
    if (position == null && bot.entity.position.distanceTo(chest.position) > 4.5) {
        if (!await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 4.5)) return { status: 'blocked', target: world.inspectBlockAt(bot, chest.position.x, chest.position.y, chest.position.z) };
    }
    return inspectChestAt(bot, chest.position.x, chest.position.y, chest.position.z);
}


export async function viewChest(bot) {
    /**
     * View the contents of the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the chest was viewed, false otherwise.
     * @example
     * await skills.viewChest(bot);
     * **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        return failSkill(bot, 'target_not_found', `Could not find a chest nearby.`);
    }
    if (!await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2)) return false;
    const context = getActionContext(bot);
    if (isActionCancelled(bot, context)) return false;
    setActionPhase(context, 'opening-chest');
    try {
        const chestContainer = await bot.openContainer(chest);
        try {
            const items = chestContainer.containerItems();
            if (items.length === 0) {
                log(bot, `The chest is empty.`);
            }
            else {
                log(bot, `The chest contains:`);
                for (const item of items) {
                    log(bot, `${item.count} ${item.name}`);
                }
            }
            return true;
        } finally {
            await chestContainer.close();
        }
    } finally {
        setActionPhase(context, 'executing');
    }
}

// Default self-feeding skips foods with harmful/teleport effects and scarce golden foods.
const NON_DEFAULT_FOODS = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit',
    'suspicious_stew', 'golden_apple', 'enchanted_golden_apple']);
const CONSUME_CONFIRM_TIMEOUT_MS = 1000;

export async function consume(bot, itemName="") {
    /**
     * Eat/drink the given item, or the best default-eligible food when omitted.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to eat/drink. Empty selects available food with the highest food points.
     * @returns {Promise<boolean>} true if the item was eaten, false otherwise.
     * @example
     * await skills.consume(bot, "apple");
     **/
    let item;
    if (itemName) {
        item = bot.inventory.findInventoryItem(itemName);
        if (!item) return failSkill(bot, 'missing_item', `You do not have any ${itemName} to eat.`, { itemName });
    } else {
        const foods = bot.registry?.foodsByName ?? {};
        item = bot.inventory.items().filter(candidate => foods[candidate.name] && !NON_DEFAULT_FOODS.has(candidate.name))
            .sort((a, b) => (foods[b.name].foodPoints ?? 0) - (foods[a.name].foodPoints ?? 0))[0];
        if (!item) return failSkill(bot, 'no_food', 'You do not have any default-eligible food to eat.',
            { excludedFoods: [...NON_DEFAULT_FOODS] });
    }
    const before = inventoryItemCount(bot, item.name);
    const foodBefore = bot.food ?? null;
    await bot.equip(item, 'hand');
    try {
        await bot.consume();
    } catch (error) {
        const message = String(error?.message ?? error);
        return failSkill(bot, message === 'Food is full' ? 'food_full' : 'consume_failed', `Could not consume ${item.name}: ${message}.`, { itemName: item.name });
    }
    const startedAt = Date.now();
    while (inventoryItemCount(bot, item.name) >= before && Date.now() - startedAt < CONSUME_CONFIRM_TIMEOUT_MS && !bot.interrupt_code)
        await new Promise(resolve => setTimeout(resolve, 25));
    const consumed = inventoryItemCount(bot, item.name) < before;
    const detail = { itemName: item.name, foodBefore, foodAfter: bot.food ?? null };
    reportSkillOutcome(consumed ? { ok: true, status: 'complete', ...detail }
        : { ok: false, status: 'unknown', code: 'effect_unconfirmed', reason: `Finished using ${item.name}, but no inventory decrease was observed.`, ...detail });
    log(bot, `Consumed ${item.name}.`);
    return true;
}


export async function giveToPlayer(bot, itemType, username, num=1, timeoutMs=30000) {
    /**
     * Give one of the specified item to the specified player
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemType, the name of the item to give.
     * @param {string} username, the username of the player to give the item to.
     * @param {number} num, the number of items to give. Defaults to 1.
     * @param {number} timeoutMs, how long to wait for a receiving bot to call receiveFromPlayer.
     * @returns {Promise<boolean>} true if the item was given, false otherwise.
     * @example
     * await skills.giveToPlayer(bot, "oak_log", "player1");
     **/
    if (bot.username === username) {
        return failSkill(bot, 'invalid_target', `You cannot give items to yourself.`, { playerName: username });
    }
    let player = bot.players?.[username]?.entity
    if (!player) {
        return failSkill(bot, 'target_not_found', `Could not find ${username}.`, { playerName: username });
    }
    if (!bot.itemHandoff?.isPeer(username)) return await throwToPlayer(bot, itemType, username, num, player, null);
    // Another bot receives only while it runs receiveFromPlayer; wait for its ready signal.
    const ready = await bot.itemHandoff.waitFor(bot, username, signal => signal.type === 'ready' && signal.itemName === itemType, timeoutMs);
    if (!ready) return failSkill(bot, 'receiver_not_ready', `${username} did not start receiveFromPlayer for ${itemType} within ${timeoutMs}ms.`,
        { itemName: itemType, playerName: username, unit: 'item', requestedQuantity: num, confirmedQuantity: 0, remainingQuantity: num });
    const handoff = { id: ready.id, doneSent: false };
    bot.itemHandoff.send(username, { type: 'giving', id: handoff.id });
    try {
        return await throwToPlayer(bot, itemType, username, num, player, handoff);
    } finally {
        if (!handoff.doneSent) bot.itemHandoff.send(username, { type: 'cancel', id: handoff.id });
    }
}

async function throwToPlayer(bot, itemType, username, num, player, handoff) {
    if (!await goToPlayer(bot, username, 3)) return false;
    // if we are 2 below the player
    if (bot.entity.position.y < player.position.y - 1) {
        if (!await goToPlayer(bot, username, 1)) return false;
    }
    // if we are too close, make some distance
    if (bot.entity.position.distanceTo(player.position) < 2) {
        let too_close = true;
        let start_moving_away = Date.now();
        try {
            if (!await moveAwayFromEntity(bot, player, 2)) return false;
        } catch (err) {
            return failSkill(bot, 'route_failed', `Failed to move away from ${username}: ${err.message}.`, { playerName: username });
        }
        while (too_close && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            too_close = bot.entity.position.distanceTo(player.position) < 5;
            if (too_close) {
                try {
                    if (!await moveAwayFromEntity(bot, player, 5)) return false;
                } catch (err) {
                    return failSkill(bot, 'route_failed', `Failed to move away from ${username}: ${err.message}.`, { playerName: username });
                }
            }
            if (Date.now() - start_moving_away > 3000) {
                break;
            }
        }
        if (too_close) {
            return failSkill(bot, 'too_close', `Failed to give ${itemType} to ${username}, too close.`, { playerName: username });
        }
    }

    await bot.lookAt(player.position);
    // Thrown items are confirmed from this bot's inventory; receipt only from observed pickup.
    const before = inventoryItemCount(bot, itemType);
    let received = 0;
    const onCollect = (collector, collected) => {
        if (collector?.username !== username) return;
        const item = collected?.getDroppedItem?.();
        if (item?.name === itemType) received += item.count;
    };
    bot.on('playerCollect', onCollect);
    try {
        if (!await discard(bot, itemType, num)) return false;
        const tossed = Math.max(0, before - inventoryItemCount(bot, itemType));
        if (handoff) {
            // The receiving bot reports its own inventory increase.
            bot.itemHandoff.send(username, { type: 'done', id: handoff.id, quantity: tossed });
            handoff.doneSent = true;
            const receipt = await bot.itemHandoff.waitFor(bot, username, signal => signal.type === 'received' && signal.id === handoff.id, 10000);
            received = receipt?.quantity ?? 0;
        }
        const start = Date.now();
        while (!handoff && received < tossed && !bot.interrupt_code && Date.now() - start <= 3000) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const quantities = { itemName: itemType, playerName: username, unit: 'item', requestedQuantity: num,
            confirmedQuantity: tossed, remainingQuantity: Math.max(0, num - tossed), receivedQuantity: received > 0 ? received : null };
        if (received === 0) return failSkill(bot, 'receipt_unconfirmed', `Failed to give ${itemType} to ${username}, it was never received.`, quantities);
        log(bot, `${username} received ${itemType}.`);
        reportSkillOutcome(tossed >= num ? { ok: true, status: 'complete', ...quantities }
            : { ok: false, status: 'partial', code: 'insufficient_items', reason: `Gave only ${tossed} of ${num} ${itemType}.`, ...quantities });
        return true;
    } finally {
        bot.removeListener('playerCollect', onCollect);
    }
}

export async function receiveFromPlayer(bot, itemType, username, num=1, timeoutMs=30000) {
    /**
     * Receive items another player or bot gives with skills.giveToPlayer.
     * With another bot, both sides negotiate timing: whichever call starts first waits for the other.
     * Collects dropped items of the given type and confirms by inventory increase.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemType, the name of the item expected.
     * @param {string} username, the giver.
     * @param {number} num, the number of items expected. Defaults to 1.
     * @param {number} timeoutMs, how long to wait for the giver and the items.
     * @returns {Promise<boolean>} true if all requested items arrived, false otherwise.
     * @example
     * await skills.receiveFromPlayer(bot, "oak_log", "player1", 4);
     **/
    if (bot.username === username) {
        return failSkill(bot, 'invalid_target', `You cannot receive items from yourself.`, { playerName: username });
    }
    const giver = bot.players?.[username]?.entity;
    if (!giver) {
        return failSkill(bot, 'target_not_found', `Could not find ${username}.`, { playerName: username });
    }
    const before = inventoryItemCount(bot, itemType);
    const gained = () => Math.max(0, inventoryItemCount(bot, itemType) - before);
    const quantities = () => ({ itemName: itemType, playerName: username, unit: 'item', requestedQuantity: num,
        confirmedQuantity: gained(), remainingQuantity: Math.max(0, num - gained()) });
    const deadline = Date.now() + timeoutMs;
    let handoffId = null;
    let ending = null;
    if (bot.itemHandoff?.isPeer(username)) {
        handoffId = randomUUID();
        const ready = { type: 'ready', id: handoffId, itemName: itemType, quantity: num };
        const giving = await bot.itemHandoff.waitFor(bot, username, signal => signal.type === 'giving' && signal.id === handoffId,
            timeoutMs, { onTick: () => bot.itemHandoff.send(username, ready) });
        if (!giving) return failSkill(bot, 'giver_not_ready', `${username} did not start giveToPlayer for ${itemType} within ${timeoutMs}ms.`, quantities());
        // done carries the thrown count; cancel means the giver stopped before throwing.
        void bot.itemHandoff.waitFor(bot, username, signal => (signal.type === 'done' || signal.type === 'cancel') && signal.id === handoffId,
            Math.max(1, deadline - Date.now())).then(signal => { ending = signal ?? { type: 'timeout' }; });
    }
    const isWanted = entity => entity.name === 'item' && entity.getDroppedItem?.()?.name === itemType
        && bot.entity.position.distanceTo(entity.position) < 12;
    await bot.lookAt(giver.position.offset(0, giver.height ?? 1.6, 0));
    let doneAt = null;
    while (gained() < num && !bot.interrupt_code && Date.now() <= deadline) {
        if (ending?.type === 'cancel' || ending?.type === 'timeout') break;
        if (ending?.type === 'done') {
            doneAt ??= Date.now();
            // Stop once everything thrown arrived, or after a short pickup window.
            if (gained() >= ending.quantity || Date.now() - doneAt > 5000) break;
        }
        const drop = bot.nearestEntity(isWanted);
        if (drop && bot.entity.position.distanceTo(drop.position) > 1.5) {
            const movements = navigationMovements(bot);
            movements.canDig = false;
            bot.pathfinder.setMovements(movements);
            await goToGoal(bot, new pf.goals.GoalFollow(drop, 0.5));
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    const received = gained();
    if (handoffId) bot.itemHandoff.send(username, { type: 'received', id: handoffId, quantity: received });
    if (received === 0) {
        if (ending?.type === 'cancel') return failSkill(bot, 'giver_cancelled', `${username} stopped giving ${itemType} before throwing it.`, quantities());
        return failSkill(bot, 'receipt_unconfirmed', `Nothing was received from ${username}.`, quantities());
    }
    reportSkillOutcome(received >= num ? { ok: true, status: 'complete', ...quantities() }
        : { ok: false, status: 'partial', code: 'insufficient_items', reason: `Received only ${received} of ${num} ${itemType}.`, ...quantities() });
    log(bot, `Received ${received} ${itemType} from ${username}.`);
    return received >= num;
}

function navigationGoalPosition(bot) {
    const position = bot.entity.position;
    const node = position.floored();
    const block = bot.blockAt(node);
    // Match getPathFromTo's start-node offset when standing on a partial block.
    if (bot.entity.onGround && position.y - node.y > 0.001 && block
        && !bot.pathfinder.movements.emptyBlocks.has(block.type)) node.y++;
    return node;
}

export async function goToGoal(bot, goal, movementOverride=null) {
    /**
     * Navigate to the given goal. Use doors and attempt minimally destructive movements.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {pf.goals.Goal} goal, the goal to navigate to.
     * @param {pf.Movements|null} movementOverride, optional movements used without destructive fallback.
     **/

    // Older callers passed a boolean in this previously unused position.
    if (typeof movementOverride !== 'object') movementOverride = null;
    let recoveryRouteCells = null;
    if (!navigationRecoveryActive.has(bot)) {
        await awaitNavigationLanding(bot);
        const startDescriptor = navigationRecoveryDescriptor(bot);
        const releaseRecoverySwim = startDescriptor?.submerged ? holdNavigationRecoverySwim(bot) : () => {};
        let recovery;
        try {
            recovery = await navigationRecovery(bot, movementOverride, goal);
        } catch (error) {
            releaseRecoverySwim();
            throw error;
        }
        if (recovery) {
            log(bot, `[navigation-recovery] ${JSON.stringify({ kind: recovery.kind, hazardBlocks: recovery.blocks?.size ?? 0,
                safeCandidates: recovery.safeCandidateCount ?? recovery.candidates?.length ?? 0, searchStatus: recovery.searchStatus,
                pathNodeCount: recovery.pathNodeCount ?? null,
                candidateDiagnostics: recovery.goal ? undefined : recovery.candidateDiagnostics,
                searchLimits: recovery.limits,
                hazardBlockLimitReached: recovery.blocks?.size === NAVIGATION_RECOVERY_MAX_HAZARD_BLOCKS,
                candidateLimitReached: recovery.safeCandidateCount === NAVIGATION_RECOVERY_MAX_CANDIDATES,
                policy: 'survival-egress-before-goal' })}`);
            if (!recovery.goal) {
                releaseRecoverySwim();
                const limitReason = recovery.searchStatus === 'search_limit'
                    ? `Recovery search budget exhausted (hazard blocks ${recovery.blocks?.size ?? 0}/${NAVIGATION_RECOVERY_MAX_HAZARD_BLOCKS}, candidates ${recovery.candidates?.length ?? 0}/${NAVIGATION_RECOVERY_MAX_CANDIDATES}, ${NAVIGATION_RECOVERY_MAX_DURATION_MS}ms).`
                    : `No safe landing was found in the observed local search (radius ${NAVIGATION_RECOVERY_RADIUS}, hazard blocks ${recovery.blocks?.size ?? 0}, candidates ${recovery.candidates?.length ?? 0}).`;
                const error = new Error(`Navigation recovery from ${recovery.kind} failed: ${limitReason} This bounded search does not establish that every route is impossible.`);
                error.name = recovery.searchStatus === 'search_limit' ? 'NavigationRecoveryBudgetError' : 'NavigationRecoveryNoPathError';
                error.navigation = { code: recovery.searchStatus === 'search_limit' ? 'search_limit' : 'route_not_found',
                    phase: 'search', recovery: { kind: recovery.kind, status: recovery.searchStatus,
                        hazardBlocks: recovery.blocks?.size ?? 0, safeCandidates: recovery.safeCandidateCount ?? recovery.candidates?.length ?? 0,
                        limits: recovery.limits } };
                throw error;
            }
            const previousMovements = bot.pathfinder.movements;
            navigationRecoveryActive.add(bot);
            try {
                const recoveryTarget = recovery.landing;
                const egress = await reachPositionCore(bot, { position: { x: recoveryTarget.x + 0.5, y: recoveryTarget.y,
                    z: recoveryTarget.z + 0.5 }, tolerance: 0.75, allowDig: true,
                    allowScaffold: recovery.scaffoldNames.length > 0,
                    scaffoldBlocks: recovery.scaffoldNames.length ? recovery.scaffoldNames : ['dirt'],
                    safeWater: recovery.kind === 'water', cleanupOwnedScaffolds: false,
                    emergencyEgress: true, emergencyWaterBlocks: [...recovery.blocks.keys()],
                    recoveryMovements: recovery.movements, recoveryBreaks: recovery.plannedBreaks,
                    recoveryPlacements: recovery.plannedPlacements,
                    recoverySubmerged: recovery.kind === 'water' && recovery.submerged }, { skipHazardRecovery: true });
                releaseRecoverySwim();
                if (!egress.ok) throw Object.assign(new Error(`Navigation recovery from ${recovery.kind} did not reach its server-confirmed safe landing: ${egress.reason}`),
                    { name: egress.status === 'cancelled' ? 'ReachCancelledError' : 'NavigationRecoveryMovementError',
                        navigation: { code: egress.code ?? 'runtime_error', phase: 'movement', recovery: egress } });
                const recoveryPosition = bot.entity.position.clone();
                const settledRecovery = await settleReachPositionArrival(bot, recoveryPosition, () => {
                    if (operationContext()?.signal?.aborted || bot.interrupt_code) {
                        const error = new Error('Navigation recovery landing confirmation cancelled.');
                        error.name = 'ReachCancelledError';
                        throw error;
                    }
                }, 1200, { waitForSafeStart: true });
                if (!settledRecovery || !navigationRecoveryLanded(bot, bot.entity.position.floored())) {
                    const feet = bot.blockAt(bot.entity.position.floored());
                    const head = bot.blockAt(bot.entity.position.floored().offset(0, 1, 0));
                    const support = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
                    throw new Error(`Navigation recovery from ${recovery.kind} did not confirm a grounded safe landing: ${JSON.stringify({
                        position: bot.entity.position, onGround: bot.entity.onGround, feet: feet?.name ?? null,
                        head: head?.name ?? null, support: support?.name ?? null, egress })}.`);
                }
                log(bot, `[navigation-recovery] ${JSON.stringify({ kind: recovery.kind, policy: 'safe-landing-confirmed',
                    position: bot.entity.position.floored(), edits: egress.edits, cleanupRequired: egress.cleanupRequired })}`);
                recoveryRouteCells = recovery.routeCells;
            } finally {
                releaseRecoverySwim();
                navigationRecoveryActive.delete(bot);
                if (previousMovements) bot.pathfinder.setMovements(previousMovements);
            }
        } else releaseRecoverySwim();
    }
    const callerRestrictedMovement = !!movementOverride;
    const nativeNoEditNavigation = operationContext()?.nativeNavigationNoEdits === true && !nativeNavigationEditScopeActive();

    // Native navigation (including implicit approaches in other skills) uses
    // the same no-edit movement unless an owned explicit route edit is active.
    movementOverride = navigationMovements(bot, movementOverride);
    if (recoveryRouteCells) movementOverride = navigationRecoveryNoReentryMovements(movementOverride, recoveryRouteCells);
    if (!navigationRecoveryActive.has(bot)) {
        for (const block of ['glass', 'glass_pane']) {
            movementOverride.blocksCantBreak.add(mc.getBlockId(block));
        }
    }
    // Edit penalties apply only while preferring and following a non-destructive
    // route. Left on the shared movements they push every bare-hand stone break
    // over pathfinder's per-move cost cap (100), so routes that must dig end noPath.
    const baseEditCosts = { placeCost: movementOverride.placeCost, digCost: movementOverride.digCost };
    const restoreEditCosts = () => Object.assign(movementOverride, baseEditCosts);
    const nonDestructiveMovements = Object.assign(movementOverride, { placeCost: 2, digCost: 10 });

    const destructiveMovements = movementOverride;

    let final_movements = destructiveMovements;
    const navigationRouteId = `nav:${randomUUID()}`;
    const navigationStartedAt = new Date().toISOString();
    recordNavigationDiagnostic(bot, 'navigation_route_started', { routeId: navigationRouteId,
        goalType: goal?.constructor?.name ?? 'unknown', movementPolicy: {
            callerRestricted: callerRestrictedMovement, nativeNoEdit: nativeNoEditNavigation,
            digCost: final_movements.digCost ?? null, placeCost: final_movements.placeCost ?? null,
        }, startedAt: navigationStartedAt });

    const pathfind_timeout = 1000;
    const nonDestructiveFound = await bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfind_timeout).status === 'success';
    if (!nonDestructiveFound) restoreEditCosts();
    if (nonDestructiveFound) {
        final_movements = nonDestructiveMovements;
        log(bot, `Found non-destructive path.`);
    }
    else if (await bot.pathfinder.getPathTo(destructiveMovements, goal, pathfind_timeout).status === 'success') {
        log(bot, callerRestrictedMovement || nativeNoEditNavigation ? 'Found a path with the requested movement restrictions.' : 'Found destructive path.');
    }
    else {
        log(bot, callerRestrictedMovement || nativeNoEditNavigation ? 'Path search is incomplete; attempting navigation with the requested movement restrictions.' : 'Path not found, but attempting navigation anyway using destructive movements.');
    }

    const doorCheckInterval = callerRestrictedMovement || nativeNoEditNavigation ? null : startDoorInterval(bot);

    bot.pathfinder.setMovements(final_movements);
    const owner = operationContext();
    const cancellation = owner?.cancellation;
    // stop() waits for the next path node. A bot stuck before that node must
    // cancel the owned goal instead, which also settles the real goto promise.
    let navigationObserver;
    const stopOwnedNavigation = () => {
        navigationObserver?.snapshot('stop_requested');
        if (bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null);
    };
    const previousActionPhase = cancellation?.phase ?? 'running';
    const navigationStallTimeoutMs = Number.isFinite(settings.navigation_stall_timeout_ms) && settings.navigation_stall_timeout_ms > 0
        ? settings.navigation_stall_timeout_ms : DEFAULT_NAVIGATION_STALL_TIMEOUT_MS;
    const configuredNavigationCheckIntervalMs = Number.isFinite(settings.navigation_check_interval_ms) && settings.navigation_check_interval_ms > 0
        ? settings.navigation_check_interval_ms : DEFAULT_NAVIGATION_CHECK_INTERVAL_MS;
    const navigationCheckIntervalMs = configuredNavigationCheckIntervalMs;
    const navigationWait = beginOwnedWait({
        phase: 'navigation', reason: 'goal-or-new-route-segment',
        startedAt: new Date().toISOString(), timeoutMs: navigationStallTimeoutMs,
        progressCount: 0,
    });
    let timeoutHandle;
    let bestGoalDistance;
    let lastProgressAt;
    let stallError = null;
    let navigationError = false;
    let clearOwnedGoalOnFailure = false;
    let lastPathUpdate = null;
    let lastPathRecordAt = 0;
    const seenRouteSegments = new Set();
    let activeRouteNodes = [];
    const positionKey = point => `${point.x},${point.y},${point.z}`;
    const onPathUpdate = result => {
        lastPathUpdate = result && typeof result === 'object' ? {
            status: result.status ?? null,
            endpoint: Array.isArray(result.path) && result.path.length ? (() => {
                const node = result.path.at(-1);
                return [node?.x, node?.y, node?.z].every(Number.isFinite)
                    ? { x: node.x, y: node.y, z: node.z } : null;
            })() : null,
            pathNodeCount: Array.isArray(result.path) ? result.path.length : null,
        } : { status: null, endpoint: null, pathNodeCount: null };
        activeRouteNodes = Array.isArray(result?.path)
            ? result.path.filter(node => [node?.x, node?.y, node?.z].every(Number.isFinite))
                .map(node => ({ x: node.x, y: node.y, z: node.z }))
            : [];
        const now = Date.now();
        if (now - lastPathRecordAt >= 250) {
            lastPathRecordAt = now;
            recordNavigationDiagnostic(bot, 'navigation_path_update', { routeId: navigationRouteId,
                status: lastPathUpdate.status, endpoint: lastPathUpdate.endpoint,
                pathNodeCount: activeRouteNodes.length, routeNodes: activeRouteNodes.slice(0, 32),
                omittedNodeCount: Math.max(0, activeRouteNodes.length - 32) });
        }
        const position = bot.entity.position;
        for (const node of activeRouteNodes) {
            if (Math.abs(position.x - node.x) <= 0.5 && Math.abs(position.z - node.z) <= 0.5 && Math.abs(position.y - node.y) < 1) {
                seenRouteSegments.add(positionKey(node));
            }
        }
    };
    const onPathReset = reason => {
        recordNavigationDiagnostic(bot, 'navigation_path_reset', { routeId: navigationRouteId,
            reason: reason ?? 'unknown', previousNodeCount: activeRouteNodes.length });
        activeRouteNodes = [];
    };
    const routeSegmentAdvanced = () => {
        const position = bot.entity.position;
        for (const node of activeRouteNodes) {
            if (Math.abs(position.x - node.x) > 0.5 || Math.abs(position.z - node.z) > 0.5 || Math.abs(position.y - node.y) >= 1) continue;
            const key = positionKey(node);
            if (seenRouteSegments.has(key)) continue;
            seenRouteSegments.add(key);
            markOwnedWaitProgress(navigationWait);
            return true;
        }
        return false;
    };
    const navigationWaitStartedAt = new Date().toISOString();
    let removeDigListener = () => {};
    try {
        bestGoalDistance = goal.heuristic(navigationGoalPosition(bot));
        seenRouteSegments.add(positionKey(bot.entity.position.floored()));
        lastProgressAt = Date.now();
        bot.on?.('path_update', onPathUpdate);
        bot.on?.('path_reset', onPathReset);
        const call = operationCallContext();
        const record = (type, detail) => {
            const event = { taskId: owner?.taskId ?? null, actionId: owner?.actionId ?? null,
                callId: call?.id ?? null, parentCallId: call?.parentCallId ?? null, ...detail };
            if (owner?.taskRecord) return owner.taskRecord(type, event);
            return bot._mindcraftDiagnosticRecord?.(type, event);
        };
        navigationObserver = observeNavigation(bot, record, navigationRouteId);
        setActionPhase(cancellation, 'navigation');
        // Emergency reachPosition already owns and confirms its edits. A second
        // segment would reapply the normal policy and enqueue placement twice.
        const navigate = () => navigateWithEditErrors(bot, goal, () => bot.pathfinder.goto(goal));
        const startNavigation = () => navigationRecoveryActive.has(bot)
            ? navigate() : trackNavigationSegment(bot, navigate);
        // Pathfinder's think timeout is wall-clock and keeps running while the bot
        // digs, so slow breaks (bare-hand stone takes ~7.5s) end goto with Timeout
        // mid-route. After a completed dig or goal/segment progress, continue
        // toward the goal; the stall check still ends routes without progress.
        let digCompletedSinceStart = false;
        let attemptStartedAt = Date.now();
        // Bot event listeners run outside the owned async context; the interval
        // below reports the completed dig as owned-wait progress.
        let digProgressPending = false;
        const onDigCompleted = () => { digCompletedSinceStart = true; digProgressPending = true; };
        bot.on?.('diggingCompleted', onDigCompleted);
        removeDigListener = () => bot.removeListener?.('diggingCompleted', onDigCompleted);
        let navigation = startNavigation();
        owner?.signal.addEventListener('abort', stopOwnedNavigation, { once: true });
        if (owner?.signal.aborted) stopOwnedNavigation();
        timeoutHandle = setInterval(() => {
            if (owner?.signal.aborted || owner?.closed) {
                clearInterval(timeoutHandle);
                timeoutHandle = null;
                return;
            }
            const currentGoalDistance = goal.heuristic(navigationGoalPosition(bot));
            if (digProgressPending) {
                digProgressPending = false;
                lastProgressAt = Date.now();
                markOwnedWaitProgress(navigationWait);
            }
            if (currentGoalDistance <= bestGoalDistance - 0.5) {
                bestGoalDistance = currentGoalDistance;
                lastProgressAt = Date.now();
                // The action stall watchdog only sees owned-wait progress.
                markOwnedWaitProgress(navigationWait);
            } else if (routeSegmentAdvanced()) {
                lastProgressAt = Date.now();
            } else if (!stallError && Date.now() - lastProgressAt >= navigationStallTimeoutMs) {
                stallError = new Error(`Navigation made no goal or new route-segment progress for ${navigationStallTimeoutMs}ms.`);
                stallError.name = 'NavigationStallTimeoutError';
                stopOwnedNavigation();
            }
        }, navigationCheckIntervalMs);
        try {
            for (;;) {
                try {
                    await navigation;
                    break;
                } catch (err) {
                    const progressed = digCompletedSinceStart || lastProgressAt > attemptStartedAt;
                    if (err?.name !== 'Timeout' || !progressed || stallError || owner?.signal.aborted || bot.interrupt_code) throw err;
                    digCompletedSinceStart = false;
                    attemptStartedAt = Date.now();
                    navigation = startNavigation();
                }
            }
        } catch (caught) {
            let err = caught;
            if (!stallError) {
                // Stopping the action clears the owned goal, which the goto wrapper
                // reports as GoalChanged; name the actual stop reason instead.
                if (err?.name === 'GoalChanged' && owner?.signal.aborted) {
                    err = Object.assign(new Error(`Navigation stopped because the action was stopped (${owner.signal.reason ?? 'unknown'})`),
                        { name: 'ActionStopped', cause: caught });
                }
                navigationError = true;
                clearOwnedGoalOnFailure = true;
                const navigationCode = err.name === 'Timeout' || lastPathUpdate?.status === 'timeout' ? 'search_limit'
                    : lastPathUpdate?.status === 'noPath' ? 'route_not_found'
                        : err.name === 'NavigationStallTimeoutError' ? 'no_progress' : 'runtime_error';
                err.navigation = {
                    code: navigationCode,
                    phase: navigationCode === 'route_not_found' || navigationCode === 'search_limit' ? 'search' : 'movement',
                    lastPathUpdate,
                    position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
                    observedAt: new Date().toISOString(),
                };
                throw err;
            }
        }
        if (stallError) { clearOwnedGoalOnFailure = true; throw stallError; }
        const endNode = navigationGoalPosition(bot);
        if (typeof goal.isEnd === 'function' && !goal.isEnd(endNode)) {
            clearOwnedGoalOnFailure = true;
            const error = new Error(`Pathfinder resolved without satisfying its goal (last path status: ${lastPathUpdate?.status ?? 'unknown'}).`);
            error.name = 'NavigationArrivalUnconfirmedError';
            const navigationCode = lastPathUpdate?.status === 'noPath' ? 'route_not_found'
                : lastPathUpdate?.status === 'timeout' ? 'search_limit' : 'arrival_unconfirmed';
            error.navigation = {
                code: navigationCode,
                phase: navigationCode === 'route_not_found' || navigationCode === 'search_limit' ? 'search' : 'arrival',
                lastPathUpdate,
                position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
                observedAt: new Date().toISOString(),
            };
            throw error;
        }
        recordNavigationArrival(bot);
        recordNavigationDiagnostic(bot, 'navigation_route_arrived', { routeId: navigationRouteId,
            elapsedMs: Date.now() - Date.parse(navigationStartedAt), visitedRouteSegments: seenRouteSegments.size,
            finalPosition: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
            lastPathUpdate });
        return true;
    } catch (err) {
        recordNavigationDiagnostic(bot, stallError ? 'navigation_stall' : 'navigation_route_error', {
            routeId: navigationRouteId, elapsedMs: Date.now() - Date.parse(navigationStartedAt),
            cancelled: owner?.signal.aborted === true, errorName: err?.name ?? 'Error',
            error: String(err?.message ?? err).slice(0, 2000), lastPathUpdate,
            visitedRouteSegments: seenRouteSegments.size });
        // we need to catch so we can clean up the door check interval, then rethrow the error
        throw err;
    } finally {
        owner?.signal.removeEventListener('abort', stopOwnedNavigation);
        removeDigListener();
        navigationObserver?.close();
        restoreEditCosts();
        if (clearOwnedGoalOnFailure && bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null);
        clearInterval(doorCheckInterval);
        if (timeoutHandle) clearInterval(timeoutHandle);
        bot.removeListener?.('path_update', onPathUpdate);
        bot.removeListener?.('path_reset', onPathReset);
        setActionPhase(cancellation, previousActionPhase);
        finishOwnedWait(navigationWait, {
            phase: 'navigation', reason: 'goal-or-new-route-segment',
            startedAt: navigationWaitStartedAt, endedAt: new Date().toISOString(),
            timeoutMs: navigationStallTimeoutMs,
            outcome: stallError ? 'stalled' : owner?.signal.aborted ? 'cancelled' : navigationError ? 'error' : 'settled',
            visitedRouteSegments: seenRouteSegments.size,
        });
        recordNavigationDiagnostic(bot, 'navigation_route_settled', { routeId: navigationRouteId,
            outcome: stallError ? 'stalled' : owner?.signal.aborted ? 'cancelled' : navigationError ? 'error' : 'settled',
            visitedRouteSegments: seenRouteSegments.size, lastPathUpdate });
    }
}

let _doorInterval = null;
function startDoorInterval(bot) {
    /**
     * Start helper interval that opens nearby doors if the bot is stuck.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {number} the interval id.
     **/
    if (_doorInterval) {
        clearInterval(_doorInterval);
    }
    let prev_pos = bot.entity.position.clone();
    let prev_check = Date.now();
    let stuck_time = 0;


    const doorCheckInterval = setInterval(() => {
        const now = Date.now();
        if (bot.entity.position.distanceTo(prev_pos) >= 0.1) {
            stuck_time = 0;
        } else {
            stuck_time += now - prev_check;
        }
        
        if (stuck_time > 1200) {
            // shuffle positions so we're not always opening the same door
            const positions = [
                bot.entity.position.clone(),
                bot.entity.position.offset(0, 0, 1),
                bot.entity.position.offset(0, 0, -1), 
                bot.entity.position.offset(1, 0, 0),
                bot.entity.position.offset(-1, 0, 0),
            ]
            let elevated_positions = positions.map(position => position.offset(0, 1, 0));
            positions.push(...elevated_positions);
            positions.push(bot.entity.position.offset(0, 2, 0)); // above head
            positions.push(bot.entity.position.offset(0, -1, 0)); // below feet
            
            let currentIndex = positions.length;
            while (currentIndex != 0) {
                let randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                [positions[currentIndex], positions[randomIndex]] = [
                positions[randomIndex], positions[currentIndex]];
            }
            
            for (let position of positions) {
                let block = bot.blockAt(position);
                if (block && block.name &&
                    !block.name.includes('iron') &&
                    (block.name.includes('door') ||
                     block.name.includes('fence_gate') ||
                     block.name.includes('trapdoor'))) 
                {
                    registerOwnedPromise(bot.activateBlock(block)).catch(error => log(bot, `Door activation failed: ${error.message}`));
                    break;
                }
            }
            stuck_time = 0;
        }
        prev_pos = bot.entity.position.clone();
        prev_check = now;
    }, 200);
    _doorInterval = doorCheckInterval;
    return doorCheckInterval;
}

function reachPositionResult(status, finalPosition, reason, edits = [], cleanupRequired = [], arrivalReached = status === 'reached', code = null, diagnostics = null) {
    return { ok: status === 'reached', status, arrivalReached, finalPosition, reason, edits, cleanupRequired,
        ...(code ? { code } : {}), ...(diagnostics ? { diagnostics } : {}) };
}

function reachPositionBlockMatches(position, target) {
    return !!position && Math.floor(position.x) === Math.floor(target.x)
        && Math.floor(position.y) === Math.floor(target.y) && Math.floor(position.z) === Math.floor(target.z);
}

function reachPositionSearchSummary(value) {
    if (!value || typeof value !== 'object') return null;
    return {
        status: value.status ?? value.searchStatus ?? null,
        code: value.code ?? null,
        phase: value.phase ?? null,
        pathNodeCount: Number.isFinite(value.pathNodeCount) ? value.pathNodeCount : null,
        endpoint: value.endpoint && [value.endpoint.x, value.endpoint.y, value.endpoint.z].every(Number.isFinite)
            ? { x: value.endpoint.x, y: value.endpoint.y, z: value.endpoint.z } : null,
        limits: value.limits ?? null,
        segment: Number.isFinite(value.segment) ? value.segment : null,
        attempt: Number.isFinite(value.attempt) ? value.attempt : null,
        start: value.start && [value.start.x, value.start.y, value.start.z].every(Number.isFinite)
            ? { x: value.start.x, y: value.start.y, z: value.start.z } : null,
        startHazard: value.startHazard ?? null,
        unknownNeighbor: typeof value.unknownNeighbor === 'boolean' ? value.unknownNeighbor : null,
        chunkWaitOutcome: value.chunkWaitOutcome ?? null,
        position: value.position && [value.position.x, value.position.y, value.position.z].every(Number.isFinite)
            ? { x: value.position.x, y: value.position.y, z: value.position.z } : null,
        targetBlocker: value.targetBlocker && typeof value.targetBlocker.code === 'string'
            ? { code: value.targetBlocker.code, feet: value.targetBlocker.feet ?? null, head: value.targetBlocker.head ?? null } : null,
        observedAt: value.observedAt ?? null,
    };
}

function reachPositionTargetBlocker(bot, target, allowDig) {
    const feetPosition = new Vec3(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z));
    const feet = bot.blockAt(feetPosition);
    const headOffset = Math.max(1, Math.ceil((Number.isFinite(bot.entity.height) ? bot.entity.height : 1.8) - 0.01) - 1);
    const head = bot.blockAt(feetPosition.offset(0, headOffset, 0));
    if (!feet || !head) return { code: 'target_unloaded', feet: feet?.name ?? null, head: head?.name ?? null };
    if (!allowDig && [feet, head].some(reachPositionFullCollisionBlock)) {
        return { code: 'target_obstructed', feet: feet.name, head: head.name };
    }
    return null;
}

function reachPositionSafeArrival(bot, target) {
    const position = bot.entity?.position;
    if (!reachPositionBlockMatches(position, target) || bot.entity?.onGround !== true) return false;
    const feet = bot.blockAt(position.floored());
    const headOffset = Math.max(1, Math.ceil((Number.isFinite(bot.entity.height) ? bot.entity.height : 1.8) - 0.01) - 1);
    const head = bot.blockAt(position.floored().offset(0, headOffset, 0));
    const support = bot.blockAt(position.floored().offset(0, -1, 0));
    if (!feet || !head || !support) return false;
    const unsafe = new Set(['water', 'flowing_water', 'lava', 'flowing_lava', 'fire', 'soul_fire', 'magma_block',
        'cactus', 'campfire', 'soul_campfire', 'bubble_column', 'powder_snow', 'sweet_berry_bush', 'wither_rose', 'pointed_dripstone']);
    if ([feet, head, support].some(block => unsafe.has(block.name))) return false;
    const width = Number.isFinite(bot.entity.width) && bot.entity.width > 0 ? bot.entity.width : 0.6;
    const height = Number.isFinite(bot.entity.height) && bot.entity.height > 0 ? bot.entity.height : 1.8;
    const halfWidth = width / 2;
    const minX = position.x - halfWidth, maxX = position.x + halfWidth;
    const minZ = position.z - halfWidth, maxZ = position.z + halfWidth;
    for (let y = Math.floor(position.y); y < Math.ceil(position.y + height); y++) {
        for (let x = Math.floor(minX); x < Math.ceil(maxX); x++) {
            for (let z = Math.floor(minZ); z < Math.ceil(maxZ); z++) {
                const block = bot.blockAt(new Vec3(x, y, z));
                if (!block) return false;
                for (const shape of block.shapes ?? []) {
                    const intersects = x + shape[3] > minX + 0.001 && x + shape[0] < maxX - 0.001
                        && z + shape[5] > minZ + 0.001 && z + shape[2] < maxZ - 0.001
                        && y + shape[4] > position.y + 0.001 && y + shape[1] < position.y + height - 0.001;
                    if (intersects) return false;
                }
            }
        }
    }
    for (const y of [Math.floor(position.y) - 1, Math.floor(position.y)]) {
        for (const x of [Math.floor(position.x), Math.floor(position.x) - 1]) {
            for (const z of [Math.floor(position.z), Math.floor(position.z) - 1]) {
                const block = bot.blockAt(new Vec3(x, y, z));
                for (const shape of block?.shapes ?? []) {
                    const top = y + shape[4];
                    if (Math.abs(top - position.y) > 0.08) continue;
                    if (x + shape[3] <= minX || x + shape[0] >= maxX || z + shape[5] <= minZ || z + shape[2] >= maxZ) continue;
                    return true;
                }
            }
        }
    }
    return false;
}

async function settleReachPositionArrival(bot, target, active, timeoutMs = 1200, { waitForSafeStart = false } = {}) {
    let timer;
    let cancellationPoll;
    let tickCount = 0;
    const operation = operationContext();
    if (typeof bot.on !== 'function' || typeof bot.removeListener !== 'function') return null;
    let safeStartObserved = reachPositionSafeArrival(bot, target);
    if (!safeStartObserved && !waitForSafeStart) return null;
    let onPhysicsTick;
    const confirmation = new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            clearTimeout(timer);
            clearInterval(cancellationPoll);
            bot.removeListener('physicsTick', onPhysicsTick);
        };
        const finish = value => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };
        const fail = error => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        onPhysicsTick = function onArrivalPhysicsTick() {
            try { active(); } catch (error) { fail(error); return; }
            if (!reachPositionBlockMatches(bot.entity?.position, target)) {
                finish(null);
                return;
            }
            if (!reachPositionSafeArrival(bot, target)) {
                if (!waitForSafeStart || safeStartObserved) finish(null);
                return;
            }
            safeStartObserved = true;
            tickCount++;
            if (tickCount === 2) {
                const position = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };
                const feet = new Vec3(position.x, position.y, position.z).floored();
                const headOffset = Math.max(1, Math.ceil((Number.isFinite(bot.entity.height) ? bot.entity.height : 1.8) - 0.01) - 1);
                const velocity = bot.entity.velocity;
                finish({ position, feet: bot.blockAt(feet)?.name ?? null,
                    head: bot.blockAt(feet.offset(0, headOffset, 0))?.name ?? null,
                    support: bot.blockAt(feet.offset(0, -1, 0))?.name ?? null,
                    onGround: bot.entity.onGround === true,
                    velocity: velocity ? { x: velocity.x, y: velocity.y, z: velocity.z } : null,
                    observedAt: new Date().toISOString(), physicsTicks: tickCount });
            }
        };
        onPhysicsTick.isArrivalConfirmationObserver = true;
        bot.on('physicsTick', onPhysicsTick);
        timer = setTimeout(() => finish(null), timeoutMs);
        cancellationPoll = setInterval(() => {
            if (!operation?.signal.aborted && !bot.interrupt_code) return;
            const error = new Error('Arrival confirmation cancelled.');
            error.name = 'ReachCancelledError';
            fail(error);
        }, 25);
    });
    try {
        active();
        return await confirmation;
    } finally {
        clearTimeout(timer);
        clearInterval(cancellationPoll);
        if (onPhysicsTick) bot.removeListener('physicsTick', onPhysicsTick);
    }
}

function reachPositionMoves(bot, { allowDig, allowScaffold, scaffoldBlocks, safeWater }) {
    const movements = new pf.Movements(bot);
    movements.canDig = allowDig;
    movements.allow1by1towers = allowScaffold;
    movements.scafoldingBlocks = allowScaffold
        ? scaffoldBlocks.map(name => bot.registry.itemsByName[name].id) : [];
    movements.canOpenDoors = false;
    movements.allowFreeMotion = false;
    movements.allowParkour = false;
    // Pathfinder measures the vertical distance to the support block, one
    // block below the bot's feet. A support delta of four means a three-block
    // fall in feet coordinates; its landing scan still rejects unknown/unsafe.
    movements.maxDropDown = REACH_POSITION_MAX_SAFE_FEET_DROP + 1;
    movements.infiniteLiquidDropdownDistance = false;

    const avoidNames = [
        'lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'campfire', 'soul_campfire', 'bubble_column',
        'powder_snow', 'sweet_berry_bush', 'wither_rose', 'pointed_dripstone',
        ...(!safeWater ? ['water', 'flowing_water'] : []),
    ];
    const avoidNameSet = new Set(avoidNames);
    const protectedNames = [
        'glass', 'glass_pane', 'sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel',
        'anvil', 'chipped_anvil', 'damaged_anvil', 'dragon_egg', 'turtle_egg', 'farmland', 'dirt_path',
        ...avoidNames,
    ];
    for (const name of avoidNames) {
        const id = bot.registry.blocksByName[name]?.id;
        if (id != null) movements.blocksToAvoid.add(id);
    }
    for (const name of protectedNames) {
        const id = bot.registry.blocksByName[name]?.id;
        if (id != null) movements.blocksCantBreak.add(id);
    }
    // The pathfinder's forward-step planner can treat a solid hazard as a
    // valid support even when its id is in blocksToAvoid. Make that movement
    // view unsafe so route nodes cannot bridge the default water/hazard fence.
    const getMovementBlock = movements.getBlock.bind(movements);
    movements.getBlock = (position, dx, dy, dz) => {
        const block = getMovementBlock(position, dx, dy, dz);
        if (avoidNames.includes(block.name)) {
            block.safe = false;
            block.physical = false;
        }
        return block;
    };
    // Mineflayer-pathfinder's forward-step planner checks only whether the
    // destination support is physical. Mark avoided hazards as nonphysical in
    // this private movement view as well, so it cannot route over solid hazards.
    const getBlock = movements.getBlock.bind(movements);
    movements.getBlock = (position, dx, dy, dz) => {
        const block = getBlock(position, dx, dy, dz);
        if (avoidNameSet.has(block.name)) {
            block.safe = false;
            block.physical = false;
        }
        return block;
    };
    const getLandingBlock = movements.getLandingBlock.bind(movements);
    movements.getLandingBlock = (node, direction) => {
        const landing = getLandingBlock(node, direction);
        if (!landing?.position || landing.liquid) return null;
        const supportPosition = landing.position.offset(0, -1, 0);
        const support = bot.blockAt(supportPosition);
        if (!support || support.liquid || avoidNameSet.has(support.name)) return null;
        const safeSupport = movements.getBlock(supportPosition, 0, 0, 0);
        if (!safeSupport.physical || safeSupport.liquid || avoidNameSet.has(safeSupport.name)) return null;
        return landing;
    };
    // Never destroy gravity blocks while pathing; the pathfinder's default set
    // omits several blocks which can fall in current registries.
    for (const block of bot.registry.blocksArray ?? []) {
        if (block.name.endsWith('glass') || block.name.endsWith('glass_pane') || movements.interactableBlocks.has(block.id)) {
            movements.blocksCantBreak.add(block.id);
        }
        if (/(?:sand|gravel|concrete_powder|anvil)$/.test(block.name) || block.name === 'dragon_egg') {
            movements.blocksCantBreak.add(block.id);
        }
    }
    if (safeWater) {
        const getBlock = movements.getBlock.bind(movements);
        movements.getBlock = (position, dx, dy, dz) => {
            const block = getBlock(position, dx, dy, dz);
            if (block.liquid && ['water', 'flowing_water'].includes(block.name)) {
                const support = bot.blockAt(block.position.offset(0, -1, 0));
                if (!support?.shapes?.some(shape => shape[4] >= 0.99)) block.safe = false;
            }
            return block;
        };
    }
    return movements;
}

function reachPositionGoal(target, tolerance, arrivalMode = 'distance') {
    if (arrivalMode === 'block') {
        const targetBlock = { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z) };
        const goal = new pf.goals.Goal();
        goal.isEnd = node => Math.floor(node.x) === targetBlock.x
            && Math.floor(node.y) === targetBlock.y && Math.floor(node.z) === targetBlock.z;
        goal.heuristic = node => Math.abs(Math.floor(node.x) - targetBlock.x)
            + Math.abs(Math.floor(node.y) - targetBlock.y) + Math.abs(Math.floor(node.z) - targetBlock.z);
        return goal;
    }
    // Pathfinder goals use block centers, while arrival is measured from the
    // actual entity position. Leave room for the entity's within-block offset.
    const goalRadius = Math.max(0, tolerance - Math.SQRT1_2);
    const distanceFromNode = node => Math.hypot(node.x + 0.5 - target.x, node.y - target.y, node.z + 0.5 - target.z);
    const goal = new pf.goals.Goal();
    goal.isEnd = node => distanceFromNode(node) <= goalRadius;
    goal.heuristic = node => Math.max(0, distanceFromNode(node) - goalRadius);
    return goal;
}

function reachPositionHasUnknownNeighbor(bot, position, radius = 4) {
    const center = position.floored();
    for (let distance = 1; distance <= radius; distance++) {
        for (let dx = -distance; dx <= distance; dx++) {
            for (const dz of [-distance, distance]) {
                if (!bot.blockAt(center.offset(dx, 0, dz))) return true;
            }
        }
        for (let dz = -distance + 1; dz < distance; dz++) {
            for (const dx of [-distance, distance]) {
                if (!bot.blockAt(center.offset(dx, 0, dz))) return true;
            }
        }
    }
    return false;
}

async function waitForReachPositionChunk(bot, operation, timeoutMs) {
    const world = bot.world;
    if (!world?.on) return false;
    const wait = beginOwnedWait({ phase: 'navigation', reason: 'loaded-route-segment', timeoutMs, startedAt: new Date().toISOString() });
    const startedAt = new Date().toISOString();
    let timer;
    let poll;
    try {
        return await new Promise(resolve => {
            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                clearInterval(poll);
                world.removeListener('chunkColumnLoad', onLoad);
                resolve(value);
            };
            const onLoad = () => finish(true);
            world.on('chunkColumnLoad', onLoad);
            timer = setTimeout(() => finish(false), timeoutMs);
            poll = setInterval(() => {
                if (operation?.signal.aborted || bot.interrupt_code) finish(false);
            }, 25);
        });
    } finally {
        finishOwnedWait(wait, { phase: 'navigation', reason: 'loaded-route-segment', startedAt, endedAt: new Date().toISOString(), timeoutMs,
            outcome: operation?.signal.aborted || bot.interrupt_code ? 'cancelled' : 'settled' });
    }
}

// Pathfinder's searchRadius is a cost cap (start heuristic + radius), not a
// distance. It approximates a detour bound only for walking costs; dig labor
// (bare-hand stone costs ~23 per block) makes any digging route exceed it and
// end noPath, so digging searches are bounded by time and steps only.
function pathSearchCostCap(movements, radius) {
    return movements?.canDig ? -1 : radius;
}

function reachPositionPath(bot, movements, goal, {
    timeout = REACH_POSITION_SEARCH_TIMEOUT_MS,
    tickTimeout = REACH_POSITION_SEARCH_TICK_MS,
    steps = REACH_POSITION_SEARCH_STEPS,
} = {}) {
    if (typeof bot.pathfinder.getPathFromTo !== 'function') return { status: 'unavailable', path: [] };
    const generator = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, {
        timeout, tickTimeout, searchRadius: pathSearchCostCap(movements, REACH_POSITION_SEARCH_RADIUS),
    });
    let result = { status: 'unavailable', path: [] };
    for (let step = 0; step < steps; step++) {
        const next = generator.next();
        if (next.done || !next.value?.result) break;
        result = next.value.result;
        if (result.status !== 'partial') break;
    }
    return result;
}

const REACH_POSITION_EXIT_HAZARDS = new Set([
    'lava', 'flowing_lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'campfire', 'soul_campfire',
    'bubble_column', 'powder_snow', 'sweet_berry_bush', 'wither_rose', 'pointed_dripstone',
]);
const REACH_POSITION_CONTACT_EXIT_HAZARDS = new Set([
    'fire', 'soul_fire', 'magma_block', 'cactus', 'campfire', 'soul_campfire',
    'sweet_berry_bush', 'wither_rose', 'pointed_dripstone',
]);
const REACH_POSITION_WATER_NAMES = new Set(['water', 'flowing_water']);
const reachPositionBlockKey = position => `${position.x},${position.y},${position.z}`;

function reachPositionStartHazard(bot) {
    const feet = bot.entity.position.floored();
    const headOffset = Math.max(1, Math.ceil((Number.isFinite(bot.entity.height) ? bot.entity.height : 1.8) - 0.01) - 1);
    const current = bot.blockAt(new Vec3(feet.x, feet.y, feet.z));
    const head = bot.blockAt(new Vec3(feet.x, feet.y + headOffset, feet.z));
    const support = bot.blockAt(new Vec3(feet.x, feet.y - 1, feet.z));
    if ([current, head].some(block => block && REACH_POSITION_WATER_NAMES.has(block.name))) return 'shallow_water';
    for (const block of [current, head, support]) {
        if (!block) continue;
        if (REACH_POSITION_EXIT_HAZARDS.has(block.name)) return block.name;
    }
    return null;
}

function reachPositionFullTopSupport(block) {
    return !!block?.shapes?.some(shape => shape[0] <= 0.01 && shape[2] <= 0.01
        && shape[3] >= 0.99 && shape[4] >= 0.99 && shape[5] >= 0.99);
}

function reachPositionFullCollisionBlock(block) {
    return !!block?.shapes?.some(shape => shape[0] <= 0.01 && shape[1] <= 0.01 && shape[2] <= 0.01
        && shape[3] >= 0.99 && shape[4] >= 0.99 && shape[5] >= 0.99);
}

function navigationRecoveryDescriptor(bot) {
    const feet = bot.entity.position.floored();
    const headOffset = Math.max(1, Math.ceil((Number.isFinite(bot.entity.height) ? bot.entity.height : 1.8) - 0.01) - 1);
    const current = bot.blockAt(new Vec3(feet.x, feet.y, feet.z));
    const head = bot.blockAt(new Vec3(feet.x, feet.y + headOffset, feet.z));
    const support = bot.blockAt(new Vec3(feet.x, feet.y - 1, feet.z));
    const observed = [current, head, support].filter(Boolean);
    const liquidBlocks = observed.filter(block => REACH_POSITION_WATER_NAMES.has(block.name)
        || ['lava', 'flowing_lava'].includes(block.name));
    const contactBlocks = observed.filter(block => REACH_POSITION_CONTACT_EXIT_HAZARDS.has(block.name));
    if (liquidBlocks.length || contactBlocks.length) {
        const names = new Set([...liquidBlocks, ...contactBlocks].map(block => block.name));
        const supportSeeds = support && [current, head].every(block => block?.position?.y !== support.position.y)
            && liquidBlocks.some(block => block.position.y === support.position.y) ? [support.position.floored()] : [];
        return { kind: liquidBlocks.some(block => REACH_POSITION_WATER_NAMES.has(block.name)) ? 'water'
            : liquidBlocks.length ? 'lava' : 'contact', names,
        contactNames: new Set(contactBlocks.map(block => block.name)), supportSeeds,
        submerged: liquidBlocks.some(block => REACH_POSITION_WATER_NAMES.has(block.name)),
        seeds: [...liquidBlocks, ...contactBlocks].map(block => block.position.floored()) };
    }
    const unsupported = observed.find(block => REACH_POSITION_EXIT_HAZARDS.has(block.name));
    if (unsupported) return { kind: `unsupported:${unsupported.name}`, names: new Set([unsupported.name]), seeds: [unsupported.position.floored()] };
    return null;
}

function navigationFalling(bot) {
    return bot.entity.onGround !== true && Number.isFinite(bot.entity.velocity?.y) && bot.entity.velocity.y < -0.08;
}

// A fall cannot be steered. Treating each airborne tick (a step down, combat
// knockback) as a hazard started an egress route mid-air that failed about 100
// times in the 2026-10-28 play. Wait for the landing instead; the landed state
// (ground, water or lava) is then classified like any other start.
async function awaitNavigationLanding(bot) {
    if (!navigationFalling(bot)) return;
    const deadline = Date.now() + NAVIGATION_LANDING_WAIT_MS;
    while (navigationFalling(bot)) {
        if (operationContext()?.signal?.aborted || bot.interrupt_code) {
            throw Object.assign(new Error('Waiting for a landing was cancelled.'), { name: 'ReachCancelledError' });
        }
        if (Date.now() >= deadline) {
            throw Object.assign(new Error(`The bot was still falling after ${NAVIGATION_LANDING_WAIT_MS}ms.`),
                { name: 'NavigationLandingTimeoutError', navigation: { code: 'unsafe_state', phase: 'landing' } });
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

async function navigationRecovery(bot, suppliedMovements, requestedGoal = null) {
    const descriptor = navigationRecoveryDescriptor(bot);
    if (!descriptor) return null;
    if (descriptor.kind.startsWith('unsupported:')) {
        return { kind: descriptor.kind, blocks: new Map(), candidates: [], goal: null, movements: null, searchStatus: 'unsupported' };
    }
    const start = bot.entity.position.floored();
    const startedAt = Date.now();
    const operation = operationContext();
    const cancelled = () => operation?.signal?.aborted || bot.interrupt_code;
    const checkBudget = () => {
        if (cancelled()) {
            const error = new Error('Navigation recovery search was cancelled.');
            error.name = 'ReachCancelledError';
            throw error;
        }
        return Date.now() - startedAt >= NAVIGATION_RECOVERY_MAX_DURATION_MS;
    };
    const yieldSlice = () => new Promise(resolve => setImmediate(resolve));
    const matches = block => descriptor.names.has(block?.name);
    const blocks = new Map();
    const queue = [...descriptor.seeds];
    let queueIndex = 0;
    while (queueIndex < queue.length && blocks.size < NAVIGATION_RECOVERY_MAX_HAZARD_BLOCKS) {
        if (queueIndex % 128 === 0) {
            if (checkBudget()) return { kind: descriptor.kind, blocks, candidates: [], goal: null, movements: null, searchStatus: 'search_limit' };
            if (queueIndex > 0) await yieldSlice();
        }
        const position = queue[queueIndex++].floored();
        const key = reachPositionBlockKey(position);
        if (blocks.has(key) || position.distanceTo(start) > NAVIGATION_RECOVERY_RADIUS) continue;
        const block = bot.blockAt(position);
        if (!block || !matches(block)) continue;
        blocks.set(key, position);
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
            queue.push(position.offset(dx, dy, dz));
        }
    }
    if (!blocks.size) return { kind: descriptor.kind, goal: null, movements: null, candidates: [], searchStatus: 'noPath' };

    const routeCells = new Map();
    const candidateKeys = new Set();
    const supportSeedKeys = new Set((descriptor.supportSeeds ?? []).map(reachPositionBlockKey));
    for (const position of blocks.values()) {
        const blockName = bot.blockAt(position)?.name;
        const routePositions = descriptor.contactNames?.has(blockName) || supportSeedKeys.has(reachPositionBlockKey(position))
            ? [position.offset(0, 1, 0)]
                : ['water', 'lava'].includes(descriptor.kind)
                    ? [position, position.offset(0, -1, 0), position.offset(0, 1, 0)] : [position];
        for (const routePosition of routePositions) {
            routeCells.set(reachPositionBlockKey(routePosition), routePosition);
            for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
                candidateKeys.add(reachPositionBlockKey(routePosition.offset(dx, dy, dz)));
            }
        }
    }
    const unsafeNames = new Set([...REACH_POSITION_EXIT_HAZARDS, ...REACH_POSITION_WATER_NAMES, 'flowing_lava']);
    const scaffoldNames = ['dirt', 'cobblestone'].filter(name => bot.registry?.itemsByName?.[name]
        && (bot.inventory?.items?.() ?? []).some(item => item.name === name && item.count > 0));
    const candidates = [];
    const scaffoldCandidates = [];
    const candidateDiagnostics = [];
    let candidateLimitReached = false;
    for (const key of candidateKeys) {
        if (candidates.length >= NAVIGATION_RECOVERY_MAX_CANDIDATES) { candidateLimitReached = true; break; }
        const [x, y, z] = key.split(',').map(Number);
        const position = new Vec3(x, y, z);
        if (position.distanceTo(start) > NAVIGATION_RECOVERY_RADIUS) continue;
        if (blocks.has(reachPositionBlockKey(position))) continue;
        const feet = bot.blockAt(position);
        const head = bot.blockAt(position.offset(0, 1, 0));
        const support = bot.blockAt(position.offset(0, -1, 0));
        const supportIsEgressWater = descriptor.kind === 'water' && blocks.has(reachPositionBlockKey(support?.position ?? {}));
        const clearanceOrDiggable = block => !!block && (block.type === 0 && !block.shapes?.length || block.diggable);
        const candidateStructure = !!feet && !!head && !!support && clearanceOrDiggable(feet) && clearanceOrDiggable(head)
            && !unsafeNames.has(feet.name)
            && !unsafeNames.has(head.name) && (!unsafeNames.has(support.name) || supportIsEgressWater);
        const safe = candidateStructure && feet.type === 0 && head.type === 0 && reachPositionFullTopSupport(support);
        if (candidateDiagnostics.length < 12) candidateDiagnostics.push({ x, y, z,
            feet: feet?.name ?? null, head: head?.name ?? null, support: support?.name ?? null, safe });
        if (!candidateStructure) continue;
        if (candidateStructure && reachPositionFullTopSupport(support)) {
            candidates.push(position);
            continue;
        }
        const scaffoldTarget = position.offset(0, -1, 0);
        const canReplaceWater = supportIsEgressWater;
        if (canReplaceWater && scaffoldTarget.x === start.x && scaffoldTarget.z === start.z) continue;
        if (!scaffoldNames.length || !(support.name === 'air' && support.type === 0 || canReplaceWater)) continue;
        const anchor = navigationRecoveryPlacementAnchor(bot, scaffoldTarget);
        if (!anchor) continue;
        candidates.push(position);
        scaffoldCandidates.push({ position, target: scaffoldTarget, anchor });
    }
    const safeCandidateCount = candidates.length;
    const candidateScore = position => position.distanceTo(start) + (requestedGoal?.heuristic?.(position) ?? 0) * 0.1
        + (['water', 'lava'].includes(descriptor.kind) && position.y < start.y ? 2 : 0)
        + [position, position.offset(0, 1, 0)].filter(point => bot.blockAt(point)?.shapes?.length).length * 2
        + (scaffoldCandidates.some(candidate => candidate.position.equals(position)) ? 2 : 0);
    candidates.sort((a, b) => candidateScore(a) - candidateScore(b));
    const movementSource = new pf.Movements(bot);
    const movements = Object.assign(Object.create(Object.getPrototypeOf(movementSource)), movementSource);
    for (const key of ['blocksToAvoid', 'blocksCantBreak', 'interactableBlocks', 'entitiesToAvoid', 'scafoldingBlocks']) {
        if (movementSource[key] instanceof Set) movements[key] = new Set(movementSource[key]);
        else if (Array.isArray(movementSource[key])) movements[key] = [...movementSource[key]];
    }
    // Egress owns an emergency edit scope. It can break terrain and use any
    // available dirt/cobblestone even when the requested route is no-edit.
    movements.canDig = true;
    movements.blocksCantBreak.clear();
    for (const block of bot.registry?.blocksArray ?? []) if (!block.diggable) movements.blocksCantBreak.add(block.id);
    movements.scafoldingBlocks = scaffoldNames.map(name => bot.registry.itemsByName[name].id);
    movements.canPlaceOn = movements.scafoldingBlocks.length > 0;
    movements.allow1by1towers = movements.scafoldingBlocks.length > 0;
    movements.allowParkour = false;
    movements.allowFreeMotion = false;
    movements.digCost = 2;
    movements.placeCost = 2;
    movements.navigationRecoveryKind = descriptor.kind;
    const originalGetBlock = movementSource.getBlock;
    movements.getBlock = (position, dx, dy, dz) => {
        const block = originalGetBlock.call(movements, position, dx, dy, dz);
        if (!block?.position || !matches(block)) return block;
        const blockKey = reachPositionBlockKey(block.position.floored());
        block.safe = blocks.has(blockKey);
        if (!blocks.has(blockKey)) block.physical = false;
        return block;
    };
    const originalGetNeighbors = movementSource.getNeighbors;
    const placementLiquidNames = new Set([...REACH_POSITION_WATER_NAMES, 'lava', 'flowing_lava']);
    let selectedWaterLanding = null;
    movements.getNeighbors = node => {
        const neighbors = originalGetNeighbors.call(movements, node);
        const fromKey = reachPositionBlockKey(new Vec3(node.x, node.y, node.z));
        const fromInside = routeCells.has(fromKey);
        // A block cannot be placed against a liquid face, e.g. a 1x1 tower from
        // the surface onto the water below.
        const allowed = neighbors.filter(next => (fromInside || !routeCells.has(reachPositionBlockKey(new Vec3(next.x, next.y, next.z))))
            && !(next.toPlace ?? []).some(placement => !placement.useOne
                && placementLiquidNames.has(bot.blockAt(new Vec3(placement.x, placement.y, placement.z))?.name)));
        if (fromInside && ['water', 'lava'].includes(descriptor.kind)) {
            if (descriptor.kind === 'water' && node.remainingBlocks > 0) {
                for (const candidate of scaffoldCandidates) {
                    const destination = candidate.position;
                    if (Math.abs(destination.x - node.x) + Math.abs(destination.z - node.z) !== 1
                        || destination.y < node.y || destination.y > node.y + 1) continue;
                    const support = bot.blockAt(candidate.target);
                    if (!REACH_POSITION_WATER_NAMES.has(support?.name)) continue;
                    const anchor = candidate.anchor;
                    allowed.push(new node.constructor(destination.x, destination.y, destination.z,
                        node.remainingBlocks - 1, 2 + movements.placeCost, [], [{
                            x: anchor.anchor.x, y: anchor.anchor.y, z: anchor.anchor.z,
                            dx: anchor.face.x, dy: anchor.face.y, dz: anchor.face.z,
                        }]));
                }
            }
            const up = new Vec3(node.x, node.y + 1, node.z);
            const upFeet = bot.blockAt(up);
            const upHead = bot.blockAt(up.offset(0, 1, 0));
            const liquidNames = descriptor.kind === 'water' ? REACH_POSITION_WATER_NAMES : new Set(['lava', 'flowing_lava']);
            const clear = block => !!block && (block.type === 0 || liquidNames.has(block.name))
                && !(block.shapes?.length);
            const diggable = block => !!block?.diggable && movements.canDig
                && !movements.blocksCantBreak.has(block.type);
            const toBreak = [];
            for (const block of [upFeet, upHead]) {
                if (clear(block)) continue;
                if (!diggable(block) || !movements.safeToBreak(block)) { toBreak.length = 0; break; }
                toBreak.push(block.position.floored());
            }
            const upClear = [upFeet, upHead].every(block => clear(block) || diggable(block) && movements.safeToBreak(block));
            // Swimming lifts the feet only while they are in the liquid. A node
            // already in the air above the surface cannot rise again, or a path
            // could float up and step onto a bank one block above the surface.
            const swimming = liquidNames.has(bot.blockAt(new Vec3(node.x, node.y, node.z))?.name);
            if (swimming && upClear && (clear(upFeet) || diggable(upFeet)) && up.y - start.y <= NAVIGATION_RECOVERY_RADIUS) {
                allowed.push(new node.constructor(up.x, up.y, up.z, node.remainingBlocks,
                    1 + toBreak.length * movements.digCost, toBreak, []));
            }
        }
        if (!selectedWaterLanding || reachPositionFullTopSupport(bot.blockAt(selectedWaterLanding.target))) return allowed;
        const destination = selectedWaterLanding.position;
        const targetKey = reachPositionBlockKey(selectedWaterLanding.target);
        return allowed.filter(next => next.x !== destination.x || next.y !== destination.y || next.z !== destination.z
            || (next.toPlace ?? []).some(placement => reachPositionBlockKey(new Vec3(placement.x + placement.dx,
                placement.y + placement.dy, placement.z + placement.dz)) === targetKey));
    };
    let path = { status: 'noPath', path: [] };
    let landing = null;
    let searchBudgetExpired = false;
    let candidateSearchLimited = false;
    while (candidates.length) {
        if (checkBudget()) { searchBudgetExpired = true; break; }
        const selectedCandidate = candidates[0];
        selectedWaterLanding = scaffoldCandidates.find(candidate => candidate.position.equals(selectedCandidate)
            && REACH_POSITION_WATER_NAMES.has(bot.blockAt(candidate.target)?.name)) ?? null;
        const recoveryGoal = new pf.goals.GoalBlock(selectedCandidate.x, selectedCandidate.y, selectedCandidate.z);
        const generator = bot.pathfinder.getPathFromTo(movements, bot.entity.position, recoveryGoal, {
            timeout: NAVIGATION_RECOVERY_SEARCH_TIMEOUT_MS,
            tickTimeout: NAVIGATION_RECOVERY_SEARCH_TICK_MS,
            searchRadius: pathSearchCostCap(movements, NAVIGATION_RECOVERY_RADIUS),
        });
        for (let step = 0; step < NAVIGATION_RECOVERY_SEARCH_STEPS; step++) {
            if (step % 8 === 0) {
                if (checkBudget()) { path = { status: 'timeout', path: [] }; searchBudgetExpired = true; break; }
                if (step > 0) await yieldSlice();
            }
            const next = generator.next();
            if (next.done || !next.value?.result) break;
            path = next.value.result;
            if (path.status !== 'partial') break;
        }
        if (path.status !== 'success' || !path.path?.length) {
            if (['timeout', 'partial'].includes(path.status)) candidateSearchLimited = true;
            candidates.shift();
            continue;
        }
        // Pathfinder post-processing centers movement nodes; retain the exact
        // search goal for support/edit keys and the subsequent arrival check.
        const candidate = selectedCandidate;
        const feet = bot.blockAt(candidate);
        const head = bot.blockAt(candidate.offset(0, 1, 0));
        const support = bot.blockAt(candidate.offset(0, -1, 0));
        const supportKey = reachPositionBlockKey(candidate.offset(0, -1, 0));
        const plannedBreak = position => path.path.some(node => (node.toBreak ?? [])
            .some(broken => reachPositionBlockKey(broken) === reachPositionBlockKey(position)));
        const placementPlanned = path.path.some(node => (node.toPlace ?? []).some(placement =>
            reachPositionBlockKey(new Vec3(placement.x + placement.dx, placement.y + placement.dy,
                placement.z + placement.dz).floored()) === supportKey));
        const feetClear = feet?.type === 0 && !feet.shapes?.length || plannedBreak(candidate);
        const headPosition = candidate.offset(0, 1, 0);
        const headClear = head?.type === 0 && !head.shapes?.length || plannedBreak(headPosition);
        const supportSurvives = reachPositionFullTopSupport(support) && !plannedBreak(candidate.offset(0, -1, 0));
        if (feetClear && headClear && (supportSurvives || placementPlanned)) {
            landing = candidate;
            break;
        }
        candidates.shift();
    }
    const goal = landing ? new pf.goals.GoalBlock(landing.x, landing.y, landing.z) : null;
    const hazardLimitReached = queueIndex < queue.length && blocks.size >= NAVIGATION_RECOVERY_MAX_HAZARD_BLOCKS;
    const searchStatus = goal ? 'success'
        : searchBudgetExpired || candidateSearchLimited || ['timeout', 'partial'].includes(path.status)
            || candidateLimitReached || hazardLimitReached ? 'search_limit' : 'noPath';
    const plannedBreaks = path.status === 'success' ? [...new Map(path.path.flatMap(node => node.toBreak ?? [])
        .map(position => [reachPositionBlockKey(position), { x: position.x, y: position.y, z: position.z }])).values()] : [];
    const plannedPlacements = path.status === 'success' ? path.path.flatMap(node => node.toPlace ?? [])
        .filter(placement => !placement.useOne) : [];
    return { kind: descriptor.kind, submerged: descriptor.submerged === true, blocks, routeCells, candidates, candidateDiagnostics, goal, landing, movements,
        searchStatus, pathNodeCount: path.path?.length ?? 0, safeCandidateCount, scaffoldNames, scaffoldCandidates,
        plannedBreaks, plannedPlacements,
        limits: { radius: NAVIGATION_RECOVERY_RADIUS, hazardBlocks: NAVIGATION_RECOVERY_MAX_HAZARD_BLOCKS,
            candidates: NAVIGATION_RECOVERY_MAX_CANDIDATES, durationMs: NAVIGATION_RECOVERY_MAX_DURATION_MS,
            pathSearchTimeoutMs: NAVIGATION_RECOVERY_SEARCH_TIMEOUT_MS,
            pathSearchTickTimeoutMs: NAVIGATION_RECOVERY_SEARCH_TICK_MS,
            pathSearchSteps: NAVIGATION_RECOVERY_SEARCH_STEPS } };
}

function navigationRecoveryLanded(bot, position) {
    return navigationRecoverySafeLanding(bot, position);
}

function holdNavigationRecoverySwim(bot) {
    const hold = () => {
        const position = bot.entity?.position?.floored?.();
        const landed = bot.entity?.onGround === true && position && navigationRecoveryLanded(bot, position);
        bot.setControlState?.('jump', !landed);
    };
    hold();
    bot.on?.('physicsTick', hold);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        bot.removeListener?.('physicsTick', hold);
        bot.setControlState?.('jump', false);
    };
}

async function digSubmergedNavigationRecoveryBlocks(bot, positions, active) {
    if (bot.entity.onGround === true || !positions?.length) return;
    if (typeof bot.dig !== 'function') throw new Error('Submerged hazard recovery requires the owned dig API.');
    for (const position of positions) {
        let approachGoal = null;
        try {
            while (true) {
                active();
                const target = bot.blockAt(new Vec3(position.x, position.y, position.z));
                if (!target) throw new Error(`Submerged recovery dig target became unknown at ${position.x},${position.y},${position.z}.`);
                if (target.type === 0) break;
                if (!target.diggable) {
                    throw new Error(`Submerged recovery cannot dig ${target.name} at ${position.x},${position.y},${position.z}.`);
                }
                const interaction = resolveBlockInteraction(bot, target, { reach: 4.5 });
                if (interaction.status === 'ready' && interaction.distance <= 2) {
                    if (bot.canDigBlock && !bot.canDigBlock(target)) {
                        throw new Error(`Submerged recovery cannot dig ${target.name} at ${position.x},${position.y},${position.z}.`);
                    }
                    if (approachGoal && bot.pathfinder.goal === approachGoal) bot.pathfinder.stop();
                    log(bot, `[navigation-recovery-edit] ${JSON.stringify({ kind: 'dig-started', block: target.name,
                        position, reason: 'pathfinder cannot initiate a dig while airborne' })}`);
                    await bot.dig(target);
                    active();
                    const confirmed = bot.blockAt(target.position);
                    if (!confirmed || confirmed.type !== 0) throw new Error(`Server did not confirm submerged recovery dig at ${position.x},${position.y},${position.z}.`);
                    log(bot, `[navigation-recovery-edit] ${JSON.stringify({ kind: 'dug', block: target.name, position, serverConfirmed: true })}`);
                    break;
                }
                if (!approachGoal) {
                    approachGoal = new pf.goals.GoalNear(position.x, position.y, position.z, 2);
                    bot.pathfinder.setGoal(approachGoal, false);
                }
                await new Promise(resolve => {
                    const done = () => {
                        clearTimeout(timer);
                        bot.removeListener('physicsTick', done);
                        resolve();
                    };
                    const timer = setTimeout(done, 50);
                    bot.once('physicsTick', done);
                });
            }
        } finally {
            if (approachGoal && bot.pathfinder.goal === approachGoal) bot.pathfinder.setGoal(null);
        }
    }
}

async function placeSubmergedNavigationRecoveryBlocks(bot, placements, names, active) {
    for (const placement of placements) {
        active();
        const target = new Vec3(placement.x + placement.dx, placement.y + placement.dy, placement.z + placement.dz);
        if (reachPositionFullTopSupport(bot.blockAt(target))) continue;
        if (!REACH_POSITION_WATER_NAMES.has(bot.blockAt(target)?.name)) continue;
        const item = bot.inventory.items().find(item => names.includes(item.name) && item.count > 0);
        if (!item) throw new Error('Submerged recovery has no scaffold material remaining.');
        const anchor = navigationRecoveryPlacementAnchor(bot, target);
        if (!anchor) throw new Error('Submerged recovery scaffold has no reachable solid anchor.');
        const reference = bot.blockAt(new Vec3(anchor.anchor.x, anchor.anchor.y, anchor.anchor.z));
        await bot.equip(item, 'hand');
        active();
        await bot.placeBlock(reference, new Vec3(anchor.face.x, anchor.face.y, anchor.face.z));
        active();
    }
}

function navigationRecoveryNoReentryMovements(movementSource, routeCells) {
    const movements = Object.assign(Object.create(Object.getPrototypeOf(movementSource)), movementSource);
    for (const key of ['blocksToAvoid', 'blocksCantBreak', 'interactableBlocks', 'entitiesToAvoid', 'scafoldingBlocks']) {
        if (movementSource[key] instanceof Set) movements[key] = new Set(movementSource[key]);
        else if (Array.isArray(movementSource[key])) movements[key] = [...movementSource[key]];
    }
    const getNeighbors = movementSource.getNeighbors.bind(movementSource);
    movements.getNeighbors = node => {
        const neighbors = getNeighbors(node);
        const fromInside = routeCells.has(reachPositionBlockKey(new Vec3(node.x, node.y, node.z)));
        return fromInside ? neighbors : neighbors.filter(next => !routeCells.has(reachPositionBlockKey(new Vec3(next.x, next.y, next.z))));
    };
    return movements;
}

function navigationRecoveryPlacementAnchor(bot, target) {
    const faces = [
        { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0), faceId: 1 },
        { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1), faceId: 3 },
        { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1), faceId: 2 },
        { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0), faceId: 5 },
        { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0), faceId: 4 },
    ];
    for (const candidate of faces) {
        const anchorPosition = target.plus(candidate.offset);
        const anchor = bot.blockAt(anchorPosition);
        if (!reachPositionFullCollisionBlock(anchor) || REACH_POSITION_EXIT_HAZARDS.has(anchor.name)
            || REACH_POSITION_WATER_NAMES.has(anchor.name)) continue;
        const interaction = resolveBlockInteraction(bot, anchor, { reach: 4.5 });
        if (interaction.status !== 'ready' || interaction.face !== candidate.faceId) continue;
        return { anchor: { x: anchorPosition.x, y: anchorPosition.y, z: anchorPosition.z },
            face: { x: candidate.face.x, y: candidate.face.y, z: candidate.face.z }, interactionFace: candidate.faceId };
    }
    return null;
}

function navigationRecoverySafeLanding(bot, position) {
    const feet = bot.blockAt(position);
    const head = bot.blockAt(position.offset(0, 1, 0));
    const support = bot.blockAt(position.offset(0, -1, 0));
    return bot.entity.onGround === true && !!feet && !!head && !!support && feet.type === 0 && head.type === 0
        && !REACH_POSITION_WATER_NAMES.has(feet.name) && !REACH_POSITION_WATER_NAMES.has(head.name)
        && !REACH_POSITION_EXIT_HAZARDS.has(feet.name) && !REACH_POSITION_EXIT_HAZARDS.has(head.name)
        && !REACH_POSITION_EXIT_HAZARDS.has(support.name) && reachPositionFullTopSupport(support);
}

async function reachPositionCore(bot, options = {}, { requireScaffoldCleanup = false, skipHazardRecovery = false, retainEmergencyScaffolds = false } = {}) {
    /**
     * Reach an absolute bot-feet position using explicitly permitted digging
     * and/or pathfinder scaffolding. Only server-confirmed edits are reported.
     * @param {MinecraftBot} bot
     * @param {{position:{x:number,y:number,z:number}, tolerance?:number, allowDig?:boolean, allowScaffold?:boolean, scaffoldBlocks?:string[], safeWater?:boolean}} options
     * @returns {Promise<{ok:boolean,status:'reached'|'blocked'|'stalled'|'cancelled',finalPosition:{x:number,y:number,z:number}|null,reason:string,edits:Array,cleanupRequired:Array}>}
     * @example
     * const result = await skills.reachPosition(bot, { position: {x: 10.5, y: 64, z: -3.5} });
     **/
    const snapshotPosition = () => bot.entity?.position
        ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : null;
    const edits = [];
    const cleanupRequired = [];
    const early = (reason, code = 'runtime_error') => reachPositionResult('blocked', snapshotPosition(), reason, edits, cleanupRequired, false, code,
        { phase: 'target', observedAt: new Date().toISOString() });
    if (!bot?.entity?.position || !bot.pathfinder || !options || typeof options !== 'object' || Array.isArray(options)) return early('Bot, position, or pathfinder is unavailable.');
    const { position, tolerance = 1, arrivalMode = 'distance', allowDig = true, allowScaffold = true, scaffoldBlocks = ['dirt', 'cobblestone'], safeWater = false,
        cleanupOwnedScaffolds = true } = options;
    if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return early('Position must contain finite x, y, and z coordinates.', 'invalid_target');
    if (!Number.isFinite(tolerance) || tolerance < 0.75 || tolerance > 8) return early('Tolerance must be between 0.75 and 8 blocks.');
    if (![allowDig, allowScaffold, safeWater].every(value => typeof value === 'boolean')) return early('Edit and water permissions must be booleans.');
    if (!Array.isArray(scaffoldBlocks) || new Set(scaffoldBlocks).size !== scaffoldBlocks.length ||
        scaffoldBlocks.some(name => !['dirt', 'cobblestone'].includes(name)) || (allowScaffold && scaffoldBlocks.length === 0)) {
        return early('Scaffolding requires a unique, nonempty dirt/cobblestone allowlist.');
    }

    const operation = operationContext();
    const routeId = `reach:${randomUUID()}`;
    const routeStartedAt = new Date().toISOString();
    recordNavigationDiagnostic(bot, 'navigation_route_started', { routeId, routeKind: 'reachPosition',
        goal: { x: position.x, y: position.y, z: position.z }, policy: { allowDig, allowScaffold, safeWater,
            scaffoldBlocks }, startedAt: routeStartedAt });
    const actionContext = operation?.cancellation ?? getActionContext(bot);
    let budgetExpired = false;
    let hazardRecoveryComplete = skipHazardRecovery;
    let submergedRecoveryDigsDone = false;
    let startedAt = 0;
    const cancelled = () => !!operation?.signal?.aborted || isActionCancelled(bot, actionContext);
    const active = () => {
        if (cancelled()) throw Object.assign(new Error('Reach cancelled.'), { name: 'ReachCancelledError' });
        if (budgetExpired || startedAt && Date.now() - startedAt >= REACH_POSITION_MAX_DURATION_MS) {
            budgetExpired = true;
            throw Object.assign(new Error('Reach exceeded its elapsed-time budget.'), { name: 'ReachBudgetExpiredError' });
        }
    };
    const target = new Vec3(position.x, position.y, position.z);
    if (!['distance', 'block'].includes(arrivalMode)) return early('Arrival mode is invalid.');
    try { await awaitNavigationLanding(bot); }
    catch (error) {
        if (error.name === 'ReachCancelledError') return reachPositionResult('cancelled', snapshotPosition(),
            'Action was cancelled; no further edits were started.', edits, cleanupRequired, false, 'cancelled',
            { phase: 'landing', observedAt: new Date().toISOString() });
        return early(error.message, 'unsafe_state');
    }
    const initialHazard = reachPositionStartHazard(bot);
    const emergencyEgress = !!initialHazard || options.emergencyEgress === true;
    const emergencyWaterBlocks = new Set(options.emergencyWaterBlocks ?? []);
    const recoveryMovements = options.recoveryMovements ?? null;
    const recoveryBreaks = Array.isArray(options.recoveryBreaks) ? options.recoveryBreaks : [];
    const recoveryPlacements = Array.isArray(options.recoveryPlacements) ? options.recoveryPlacements : [];
    const recoverySubmerged = options.recoverySubmerged === true;
    if (bot.game?.minY != null && (target.y < bot.game.minY || bot.game.height != null && target.y >= bot.game.minY + bot.game.height)) return early('Target is outside the loaded dimension height.', 'invalid_target');
    if (bot.entity.position.distanceTo(target) > REACH_POSITION_MAX_DISTANCE) return early(`Target exceeds the ${REACH_POSITION_MAX_DISTANCE}-block range limit.`, 'invalid_target');
    const egressScaffoldOptions = emergencyEgress ? ['dirt', 'cobblestone'] : scaffoldBlocks;
    const availableScaffoldBlocks = allowScaffold || emergencyEgress
        ? egressScaffoldOptions.filter(name => bot.registry?.itemsByName?.[name] &&
            (bot.inventory?.items?.() ?? []).some(item => item.name === name && item.count > 0))
        : [];
    if (reachPositionMovementOwners.has(bot.pathfinder)) {
        return early('Another reachPosition operation already owns this pathfinder.');
    }

    const context = operationContext();
    const originalDig = bot.dig;
    const originalPlaceBlock = bot.placeBlock;
    const originalEquip = bot.equip;
    const canAttemptScaffolds = (allowScaffold || emergencyEgress) && availableScaffoldBlocks.length > 0 && typeof originalPlaceBlock === 'function';
    const originalMovements = bot.pathfinder.movements;
    const ownedMovements = new WeakSet();
    const scaffoldRecords = [];
    const unconfirmedScaffolds = [];
    const failedScaffoldCells = new Set();
    const pendingNavigationEdits = new Set();
    const ownNavigationEdit = (promise, releaseGate) => {
        pendingNavigationEdits.add(promise);
        registerOwnedPromise(promise);
        promise.then(() => { pendingNavigationEdits.delete(promise); releaseGate(); }, () => { pendingNavigationEdits.delete(promise); releaseGate(); });
        return promise;
    };
    const ordinaryMovement = reachPositionMoves(bot, { allowDig, allowScaffold, scaffoldBlocks: availableScaffoldBlocks, safeWater });
    let movement = skipHazardRecovery && recoveryMovements ? recoveryMovements : ordinaryMovement;
    ownedMovements.add(movement);
    reachPositionMovementOwners.set(bot.pathfinder, context ?? movement);
    const movementOwner = reachPositionMovementOwners.get(bot.pathfinder);
    let editPhase = 'traversal';
    let activeGoal = null;
    let lastNavigationError = '';
    let status = 'blocked';
    let reason = 'No safe route was found.';
    let diagnosticPhase = 'target';
    let hardTimer;
    startedAt = Date.now();
    let chunkWaitCount = 0;
    const routeAttempts = new Map();
    const finalDistance = () => bot.entity.position.distanceTo(target);
    const arrivalCandidate = () => arrivalMode === 'block' ? reachPositionBlockMatches(bot.entity.position, target) : finalDistance() <= tolerance;
    const confirmArrival = async () => {
        if (arrivalMode !== 'block') return { position: snapshotPosition(), observedAt: new Date().toISOString(), physicsTicks: 0 };
        return await settleReachPositionArrival(bot, target, active);
    };
    const goal = reachPositionGoal(target, tolerance, arrivalMode);
    let resultCode = null;
    let lastSearchDiagnostics = null;
    const startedPosition = bot.entity.position.clone();
    const drainNavigationEdits = async () => {
        while (pendingNavigationEdits.size) await Promise.allSettled([...pendingNavigationEdits]);
    };

    const digWrapper = function (block, ...args) {
        const releaseGate = beginNavigationEdit(bot);
        return ownNavigationEdit((async () => {
            await awaitNavigationPlacementSettled(bot);
            active();
            if (unconfirmedScaffolds.length) throw new Error('Navigation stopped after an unconfirmed scaffold placement.');
            if (typeof bot.tool?.equipForBlock === 'function') await bot.tool.equipForBlock(block);
            active();
            if (unconfirmedScaffolds.length) throw new Error('Navigation stopped after an unconfirmed scaffold placement.');
            const result = await registerOwnedPromise(originalDig.call(this, block, ...args));
            const observed = bot.blockAt(block.position);
            if (!observed || observed.type !== 0) throw new Error(`Server did not confirm route excavation at ${block.position}.`);
            const kind = editPhase === 'cleanup' ? 'scaffold_removed' : 'dug';
            const change = { kind, block: block.name, position: { x: block.position.x, y: block.position.y, z: block.position.z } };
            edits.push(change);
            recordConfirmation({ quantity: 1, unit: 'block', target: { block: block.name, position: change.position },
                evidence: 'Mineflayer dig promise resolved after server block update' });
            active();
            return result;
        })(), releaseGate);
    };
    const equipWrapper = function (...args) {
        const releaseGate = beginNavigationEdit(bot);
        return ownNavigationEdit((async () => {
            await awaitNavigationPlacementSettled(bot);
            active();
            if (unconfirmedScaffolds.length) throw new Error('Navigation stopped after an unconfirmed scaffold placement.');
            return originalEquip.call(this, ...args);
        })(), releaseGate);
    };
    const placeWrapper = function (reference, face, ...args) {
        const releaseGate = beginNavigationEdit(bot);
        return ownNavigationEdit((async () => {
        active();
        const blockName = bot.heldItem?.name;
        if (!(allowScaffold || emergencyEgress) || !availableScaffoldBlocks.includes(blockName)) throw new Error(`Pathfinder attempted an unpermitted scaffold block: ${blockName ?? 'unknown'}.`);
        const targetPosition = reference.position.plus(face).floored();
        let placement;
        try {
            const observedTarget = bot.blockAt(targetPosition);
            const bodyFeet = bot.entity.position.floored();
            const bodyHeadOffset = Math.max(1, Math.ceil((Number.isFinite(bot.entity.height) ? bot.entity.height : 1.8) - 0.01) - 1);
            const overlapsWaterPlacementBody = targetPosition.x === bodyFeet.x && targetPosition.z === bodyFeet.z
                && targetPosition.y >= bodyFeet.y && targetPosition.y <= bodyFeet.y + bodyHeadOffset;
            const waterPlacementAllowed = emergencyEgress && REACH_POSITION_WATER_NAMES.has(observedTarget?.name)
                && emergencyWaterBlocks.has(reachPositionBlockKey(targetPosition)) && !overlapsWaterPlacementBody;
            if (!observedTarget || (REACH_POSITION_WATER_NAMES.has(observedTarget.name) && !waterPlacementAllowed)
                || ['lava', 'flowing_lava'].includes(observedTarget.name)) {
                failedScaffoldCells.add(reachPositionBlockKey(targetPosition));
                const error = new Error(overlapsWaterPlacementBody
                    ? 'Emergency egress will not place a block in the bot body.'
                    : 'Navigation scaffold target is unknown or occupied by liquid outside the observed egress water region.');
                error.navigationPlacementAttempted = false;
                throw error;
            }
            placement = await placeAndConfirmNavigationScaffold(bot, targetPosition, blockName,
                () => {
                    try {
                        active();
                        if (unconfirmedScaffolds.length) throw new Error('Navigation stopped after an unconfirmed scaffold placement.');
                        const freshReference = bot.blockAt(reference.position);
                        if (!freshReference || freshReference.type === 0) throw new Error('Scaffold support block is no longer available.');
                        return registerOwnedPromise(originalPlaceBlock.call(this, freshReference, face, ...args));
                    } catch (error) {
                        if (error.navigationPlacementAttempted !== false) error.navigationPlacementAttempted = false;
                        throw error;
                    }
                }, () => bot.lookAt(reference.position.offset(
                    0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)));
        } catch (error) {
            const position = { x: targetPosition.x, y: targetPosition.y, z: targetPosition.z };
            if (error.navigationPlacementAttempted !== false && !unconfirmedScaffolds.some(entry => entry.position.x === position.x && entry.position.y === position.y && entry.position.z === position.z)) {
                unconfirmedScaffolds.push({ position, block: blockName });
                cleanupRequired.push({ ...position, block: blockName,
                    reason: 'Scaffold placement was attempted but not server-confirmed; target state is unknown.' });
            }
            throw error;
        }
        const observed = placement.block;
        const positionRecord = { x: targetPosition.x, y: targetPosition.y, z: targetPosition.z };
        const record = { position: positionRecord, block: blockName, stateId: observed.stateId };
        if (!retainEmergencyScaffolds || !navigationRecoveryActive.has(bot)) upsertOwnedScaffold(scaffoldRecords, record);
        const change = { kind: 'scaffold_placed', block: blockName, position: positionRecord };
        edits.push(change);
        recordConfirmation({ quantity: 1, unit: 'block', target: { block: blockName, position: positionRecord },
            evidence: 'Expected server block update confirmed after Mineflayer placement promise' });
        if (emergencyEgress) log(bot, `[navigation-recovery-edit] ${JSON.stringify({ kind: 'scaffold-placed',
            block: blockName, position: positionRecord, serverConfirmed: true, replanning: true })}`);
        active();
        return placement.result;
        })(), releaseGate);
    };

    const restoreWrappers = () => {
        if (bot.dig === digWrapper) bot.dig = originalDig;
        if (bot.placeBlock === placeWrapper) bot.placeBlock = originalPlaceBlock;
        if (bot.equip === equipWrapper) bot.equip = originalEquip;
    };
    const cleanupScaffolds = async () => {
        editPhase = 'cleanup';
        for (const scaffold of [...scaffoldRecords].reverse()) {
            if (cancelled()) break;
            if (budgetExpired || Date.now() - startedAt >= REACH_POSITION_MAX_DURATION_MS) {
                budgetExpired = true;
                break;
            }
            const p = new Vec3(scaffold.position.x, scaffold.position.y, scaffold.position.z);
            const observed = bot.blockAt(p);
            if (observed?.type === 0) continue;
            if (!observed || observed.name !== scaffold.block || scaffold.stateId != null && observed.stateId !== scaffold.stateId) {
                cleanupRequired.push({ ...scaffold.position, block: scaffold.block, reason: 'Owned scaffold state changed or became unknown.' });
                continue;
            }
            if (isOwnedScaffoldUnderBot(bot, p)) {
                cleanupRequired.push({ ...scaffold.position, block: scaffold.block, reason: 'Scaffold supports the bot at its current position.' });
                continue;
            }
            try {
                const targetBlock = bot.blockAt(p);
                if (!targetBlock) throw new Error('Scaffold became unobserved.');
                const current = bot.blockAt(p);
                if (!current || current.name !== scaffold.block || scaffold.stateId != null && current.stateId !== scaffold.stateId) throw new Error('Owned scaffold changed before cleanup.');
                const interaction = resolveBlockInteraction(bot, current, { reach: 4.5 });
                if (interaction.status !== 'ready') throw new Error(`Scaffold is not safely reachable: ${interaction.reason}.`);
                await bot.dig(current);
                active();
                if (bot.blockAt(p)?.type !== 0) throw new Error('Server did not confirm scaffold removal.');
            } catch (error) {
                if (cancelled()) break;
                const afterAttempt = bot.blockAt(p);
                if (afterAttempt?.type === 0) {
                    if (budgetExpired) break;
                    continue;
                }
                cleanupRequired.push({ ...scaffold.position, block: scaffold.block, reason: String(error.message ?? error) });
                if (budgetExpired) break;
            }
        }
    };

    try {
        if (!originalDig || (availableScaffoldBlocks.length > 0 && allowScaffold && !originalPlaceBlock)
            || typeof bot.pathfinder.getPathFromTo !== 'function') throw new Error('The required Mineflayer/pathfinder edit APIs are unavailable.');
        bot.dig = digWrapper;
        if (canAttemptScaffolds) bot.placeBlock = placeWrapper;
        bot.equip = equipWrapper;
        bot.pathfinder.setMovements(movement);
        hardTimer = setTimeout(() => {
            budgetExpired = true;
            if (activeGoal && bot.pathfinder.goal === activeGoal) bot.pathfinder.stop();
        }, REACH_POSITION_MAX_DURATION_MS);

        for (let segment = 0; segment < REACH_POSITION_MAX_SEGMENTS; segment++) {
            active();
            if ((!initialHazard || hazardRecoveryComplete) && arrivalCandidate()) {
                diagnosticPhase = 'arrival';
                if (await confirmArrival()) {
                    status = 'reached';
                    resultCode = reachPositionBlockMatches(bot.entity.position, target) && startedPosition.distanceTo(bot.entity.position) < 0.01
                        ? 'already_at_goal' : 'arrived';
                    reason = 'Reached the requested feet position with a grounded, loaded, safe arrival.';
                    break;
                }
                status = 'blocked'; resultCode = 'unsafe_state';
                reason = 'Arrival did not remain grounded, loaded, and safe for two physics ticks.';
                break;
            }
            if (Date.now() - startedAt > REACH_POSITION_MAX_DURATION_MS) {
                status = 'stalled'; reason = 'Reach exceeded its elapsed-time budget.'; break;
            }
            if (skipHazardRecovery && emergencyEgress && recoverySubmerged && !submergedRecoveryDigsDone) {
                await withNativeNavigationEditScope(async () => {
                    await digSubmergedNavigationRecoveryBlocks(bot, recoveryBreaks, active);
                    await placeSubmergedNavigationRecoveryBlocks(bot, recoveryPlacements, availableScaffoldBlocks, active);
                });
                submergedRecoveryDigsDone = true;
            }
            const start = bot.entity.position.floored();
            if (segment === 0 && initialHazard && !hazardRecoveryComplete && !skipHazardRecovery) {
                diagnosticPhase = 'recovery';
                const releaseRecoverySwim = navigationRecoveryDescriptor(bot)?.submerged
                    ? holdNavigationRecoverySwim(bot) : () => {};
                let recovery;
                try {
                    recovery = await navigationRecovery(bot, movement, goal);
                } catch (error) {
                    releaseRecoverySwim();
                    throw error;
                }
                log(bot, `[navigation-recovery] ${JSON.stringify({ kind: recovery?.kind ?? initialHazard,
                    policy: 'survival-egress-before-goal', searchStatus: recovery?.searchStatus ?? 'noPath',
                    hazardBlocks: recovery?.blocks?.size ?? 0,
                    safeCandidates: recovery?.safeCandidateCount ?? recovery?.candidates?.length ?? 0,
                    landing: recovery?.landing ?? null, searchLimits: recovery?.limits ?? null })}`);
                if (!recovery?.goal) {
                    releaseRecoverySwim();
                    const code = recovery?.searchStatus === 'search_limit' ? 'search_limit' : 'route_not_found';
                    resultCode = code;
                    throw Object.assign(new Error(`Hazard egress ${recovery?.searchStatus ?? 'failed'}: ${recovery?.kind ?? initialHazard}; `
                        + `${recovery?.blocks?.size ?? 0} connected hazard blocks, ${recovery?.safeCandidateCount ?? recovery?.candidates?.length ?? 0} safe candidates.`),
                        { name: code === 'search_limit' ? 'NavigationRecoveryBudgetError' : 'NavigationRecoveryNoPathError',
                            navigation: { code, phase: 'search', recovery: { kind: recovery?.kind ?? initialHazard,
                                status: recovery?.searchStatus ?? 'noPath', limits: recovery?.limits ?? null } } });
                }
                for (const key of recovery.blocks.keys()) emergencyWaterBlocks.add(key);
                activeGoal = recovery.goal;
                ownedMovements.add(recovery.movements);
                bot.pathfinder.setMovements(recovery.movements);
                let navigationFailure = null;
                navigationRecoveryActive.add(bot);
                try {
                    await withNativeNavigationEditScope(async () => {
                        if (recovery.kind === 'water' && recovery.submerged && recovery.plannedBreaks.length) {
                            await digSubmergedNavigationRecoveryBlocks(bot, recovery.plannedBreaks, active);
                        }
                        if (recovery.kind === 'water' && recovery.submerged) {
                            await placeSubmergedNavigationRecoveryBlocks(bot, recovery.plannedPlacements, availableScaffoldBlocks, active);
                        }
                        await goToGoal(bot, recovery.goal, recovery.movements);
                    });
                } catch (error) {
                    navigationFailure = error;
                } finally {
                    releaseRecoverySwim();
                    navigationRecoveryActive.delete(bot);
                    await drainNavigationEdits();
                }
                if (navigationFailure) throw navigationFailure;
                active();
                const recoveredPosition = bot.entity.position.floored();
                const settled = await settleReachPositionArrival(bot, recoveredPosition, active, 1200, { waitForSafeStart: true });
                if (!settled || !navigationRecoveryLanded(bot, recoveredPosition)) {
                    resultCode = 'unsafe_state';
                    throw new Error('Hazard egress did not confirm a grounded safe landing.');
                }
                hazardRecoveryComplete = true;
                if (recovery.kind === 'water' && recovery.blocks?.has(reachPositionBlockKey(target.floored()))) {
                    status = 'blocked';
                    resultCode = 'unsafe_state';
                    reason = 'The requested destination is inside the water region; navigation stopped at the safe landing to avoid re-entry.';
                    log(bot, `[reachPosition-departure] ${JSON.stringify({ policy: 'survival-egress', reason: 'target_reentry_forbidden', target: target.floored(), safeLanding: recoveredPosition })}`);
                    break;
                }
                movement = navigationRecoveryNoReentryMovements(ordinaryMovement, recovery.routeCells);
                ownedMovements.add(movement);
                bot.pathfinder.setMovements(movement);
                log(bot, `[navigation-recovery] ${JSON.stringify({ kind: recovery.kind, policy: 'safe-landing-confirmed', position: recoveredPosition })}`);
                continue;
            }
            diagnosticPhase = initialHazard && !hazardRecoveryComplete ? 'recovery' : 'search';
            const pathResult = reachPositionPath(bot, movement, goal);
            lastSearchDiagnostics = { status: pathResult.status ?? 'unknown', pathNodeCount: pathResult.path?.length ?? 0,
                endpoint: pathResult.path?.length ? { x: pathResult.path.at(-1).x, y: pathResult.path.at(-1).y, z: pathResult.path.at(-1).z } : null,
                limits: { timeoutMs: REACH_POSITION_SEARCH_TIMEOUT_MS, steps: REACH_POSITION_SEARCH_STEPS,
                    searchRadius: pathSearchCostCap(movement, REACH_POSITION_SEARCH_RADIUS) } };
            recordNavigationDiagnostic(bot, 'navigation_route_search', { routeId, phase: diagnosticPhase, search: lastSearchDiagnostics });
            if (pathResult.status === 'unavailable') { status = 'blocked'; reason = 'Bounded path search is unavailable.'; break; }
            const path = Array.isArray(pathResult.path) ? pathResult.path : [];
            const endpoint = path.at(-1);
            const searchDiagnostic = {
                segment, start: { x: start.x, y: start.y, z: start.z },
                searchStatus: pathResult.status, pathNodeCount: path.length,
                path: path.slice(0, 128).map(node => ({ x: node.x, y: node.y, z: node.z })),
                omittedPathNodeCount: Math.max(0, path.length - 128),
                endpoint: endpoint ? { x: endpoint.x, y: endpoint.y, z: endpoint.z } : null,
                startHazard: segment === 0 ? initialHazard : null,
            };
            if (!endpoint || endpoint.x === start.x && endpoint.y === start.y && endpoint.z === start.z) {
                if ((!initialHazard || hazardRecoveryComplete) && arrivalCandidate()) {
                    diagnosticPhase = 'arrival';
                    if (arrivalMode === 'block' && !await confirmArrival()) {
                        status = 'blocked'; resultCode = 'unsafe_state';
                        reason = 'Arrival could not be confirmed as grounded, loaded, and safe for two physics ticks.';
                        break;
                    }
                    status = 'reached';
                    resultCode = reachPositionBlockMatches(bot.entity.position, target) && startedPosition.distanceTo(bot.entity.position) < 0.01
                        ? 'already_at_goal' : 'arrived';
                    reason = 'Reached the requested feet position after safe hazard egress.';
                    break;
                }
                const unknownNeighbor = reachPositionHasUnknownNeighbor(bot, bot.entity.position);
                searchDiagnostic.unknownNeighbor = unknownNeighbor;
                if (unknownNeighbor) {
                    diagnosticPhase = 'search';
                    if (++chunkWaitCount > REACH_POSITION_MAX_SEGMENTS) {
                        const blocker = reachPositionTargetBlocker(bot, target, allowDig);
                        resultCode = blocker?.code ?? 'search_limit';
                        diagnosticPhase = blocker ? 'target' : 'search';
                        status = blocker?.code === 'target_unloaded' ? 'blocked' : 'stalled';
                        reason = blocker ? 'The target remains unloaded after the bounded chunk wait.' : 'Chunk loading retry limit reached.';
                        break;
                    }
                    const loaded = await waitForReachPositionChunk(bot, context, REACH_POSITION_CHUNK_WAIT_MS);
                    searchDiagnostic.chunkWaitOutcome = loaded ? 'chunk_loaded' : 'deadline';
                    active();
                    log(bot, `[reachPosition-route] ${JSON.stringify(searchDiagnostic)}`);
                    if (loaded) continue;
                    const blocker = reachPositionTargetBlocker(bot, target, allowDig);
                    resultCode = blocker?.code ?? 'search_limit';
                    diagnosticPhase = blocker ? 'target' : 'search';
                    status = 'blocked'; reason = blocker ? 'The target is not loaded.' : 'No newly loaded safe route segment appeared before the chunk wait deadline.'; break;
                }
                const blocker = reachPositionTargetBlocker(bot, target, allowDig);
                if (!allowDig && pathResult.status === 'noPath'
                    && !reachPositionStartHazard(bot) && blocker?.code !== 'target_unloaded') {
                    // Search only: never install these movements or execute this path.
                    // All restrictions except digging remain those of this call.
                    active();
                    const digMovements = reachPositionMoves(bot, {
                        allowDig: true, allowScaffold, scaffoldBlocks: availableScaffoldBlocks, safeWater,
                    });
                    digMovements.digCost = ordinaryMovement.digCost;
                    digMovements.placeCost = ordinaryMovement.placeCost;
                    const digPath = reachPositionPath(bot, digMovements, goal, {
                        timeout: Math.min(REACH_POSITION_DIG_HINT_TIMEOUT_MS,
                            REACH_POSITION_MAX_DURATION_MS - (Date.now() - startedAt)),
                        tickTimeout: 30, steps: 4,
                    });
                    active();
                    if (digPath.status === 'success' && digPath.path?.some(node => node.toBreak?.length)) {
                        resultCode = 'digging_required';
                        diagnosticPhase = 'search';
                        lastSearchDiagnostics = reachPositionSearchSummary({ ...searchDiagnostic, targetBlocker: blocker });
                        status = 'blocked';
                        reason = '現在の探索条件では採掘を伴う経路が見つかりました。';
                        break;
                    }
                    if (digPath.status === 'timeout' || digPath.status === 'partial') {
                        resultCode = 'search_limit';
                        diagnosticPhase = 'search';
                        status = 'blocked';
                        reason = '採掘ありの追加探索が探索上限に達しました。';
                        break;
                    }
                    resultCode = 'route_not_found';
                    diagnosticPhase = 'search';
                    lastSearchDiagnostics = reachPositionSearchSummary({ ...searchDiagnostic, targetBlocker: blocker });
                    status = 'blocked';
                    reason = '採掘なしの経路は見つからず、採掘を要する候補も確認できませんでした。';
                    break;
                }
                if (blocker) {
                    resultCode = blocker.code;
                    searchDiagnostic.targetBlocker = blocker;
                    diagnosticPhase = 'target';
                } else {
                    resultCode = pathResult.status === 'timeout' || pathResult.status === 'partial' ? 'search_limit'
                        : pathResult.status === 'noPath' ? 'route_not_found' : 'arrival_unconfirmed';
                    diagnosticPhase = 'search';
                }
                log(bot, `[reachPosition-route] ${JSON.stringify(searchDiagnostic)}`);
                status = 'blocked'; reason = `Path search ended ${pathResult.status} without a safe next segment.`; break;
            }

            const routeKey = `${start.x},${start.y},${start.z}>${endpoint.x},${endpoint.y},${endpoint.z}:${pathResult.status}`;
            const attempts = (routeAttempts.get(routeKey) ?? 0) + 1;
            routeAttempts.set(routeKey, attempts);
            searchDiagnostic.attempt = attempts;
            lastSearchDiagnostics = reachPositionSearchSummary(searchDiagnostic);
            log(bot, `[reachPosition-route] ${JSON.stringify(searchDiagnostic)}`);
            if (attempts >= REACH_POSITION_NO_PROGRESS_LIMIT) {
                resultCode = 'no_progress';
                status = 'stalled'; reason = 'The same route segment failed repeatedly without progress.'; break;
            }
            let checkpoint = goal;
            if (pathResult.status !== 'success') {
                // postProcessPath mutates feet coordinates, including partial-block
                // heights. Move.hash retains the original integer A* coordinates.
                const node = typeof endpoint.hash === 'string' ? endpoint.hash.split(',').map(Number) : [];
                if (node.length !== 3 || !node.every(Number.isSafeInteger)) {
                    throw new Error('Pathfinder checkpoint is missing its original A* coordinates.');
                }
                checkpoint = new pf.goals.GoalBlock(...node);
            }
            activeGoal = checkpoint;
            const before = bot.entity.position.clone();
            let navigationFailure = null;
            try {
                await withNativeNavigationEditScope(() => goToGoal(bot, checkpoint, movement));
            } catch (error) {
                navigationFailure = error;
            } finally {
                await drainNavigationEdits();
            }
            if (navigationFailure) {
                const error = navigationFailure;
                lastNavigationError = String(error.message ?? error);
                if (error.navigation) {
                    resultCode = error.navigation.code;
                    lastSearchDiagnostics = error.navigation;
                }
                if (cancelled()) throw error;
                if (unconfirmedScaffolds.length) {
                    status = 'blocked';
                    resultCode = 'edit_unconfirmed';
                    reason = 'A scaffold placement was attempted but not server-confirmed.';
                    break;
                }
                if (budgetExpired || error.name === 'NavigationStallTimeoutError' || error.name === 'Timeout') {
                    resultCode = error.navigation?.code ?? (error.name === 'NavigationStallTimeoutError' ? 'no_progress' : 'search_limit');
                    status = 'stalled'; reason = lastNavigationError; break;
                }
                if (bot.entity.position.distanceTo(before) < 0.5 && attempts + 1 >= REACH_POSITION_NO_PROGRESS_LIMIT) {
                    resultCode = 'no_progress';
                    status = 'stalled'; reason = lastNavigationError; break;
                }
                continue;
            }
            active();
            if (bot.entity.position.distanceTo(before) < 0.5 && !arrivalCandidate()) {
                if (reachPositionHasUnknownNeighbor(bot, bot.entity.position)) {
                    const loaded = await waitForReachPositionChunk(bot, context, REACH_POSITION_CHUNK_WAIT_MS);
                    active();
                    if (loaded) continue;
                }
                if (attempts + 1 >= REACH_POSITION_NO_PROGRESS_LIMIT) { resultCode = 'no_progress'; status = 'stalled'; reason = 'Navigation returned without observable route progress.'; break; }
            }
        }

        if (status === 'blocked' && reason === 'No safe route was found.' && !cancelled()) {
            status = 'stalled'; reason = 'Reach exceeded its bounded route-segment budget.';
        }

        if (cleanupOwnedScaffolds && scaffoldRecords.length && !cancelled()) await cleanupScaffolds();
        if (cancelled()) { status = 'cancelled'; reason = 'Action was cancelled; no further edits were started.'; }
        else if (budgetExpired) { status = 'stalled'; reason = 'Reach exceeded its elapsed-time budget.'; }
        else if (status === 'reached' && !arrivalCandidate()) { status = 'blocked'; resultCode = 'arrival_unconfirmed'; reason = 'Cleanup completed, but the final position no longer satisfies the requested arrival condition.'; }
        else if (status !== 'reached' && status === 'blocked' && lastNavigationError) reason = `${reason} Last navigation error: ${lastNavigationError}`;
    } catch (error) {
        if (cancelled() || error.name === 'ReachCancelledError') { status = 'cancelled'; reason = 'Action was cancelled; no further edits were started.'; }
        else if (budgetExpired || error.name === 'NavigationStallTimeoutError' || error.name === 'Timeout') { status = 'stalled'; reason = String(error.message ?? error); }
        else { status = 'blocked'; resultCode = error.navigation?.code ?? (error.name === 'NavigationArrivalUnconfirmedError' ? 'arrival_unconfirmed' : 'runtime_error'); reason = String(error.message ?? error); }
        if (error.navigation) {
            lastSearchDiagnostics = error.navigation;
            diagnosticPhase = error.navigation.phase ?? diagnosticPhase;
        }
        if (cleanupOwnedScaffolds && status !== 'cancelled' && scaffoldRecords.length) await cleanupScaffolds();
        if (cleanupRequired.length && status === 'reached') status = 'blocked';
    } finally {
        await drainNavigationEdits();
        clearTimeout(hardTimer);
        restoreWrappers();
        if (reachPositionMovementOwners.get(bot.pathfinder) === movementOwner) {
            // Mineflayer-pathfinder leaves stateGoal set when goto rejects for
            // NoPath/Timeout. Clear only this call's goal before restoring the
            // caller's movements, or physicsTick can resume it with broader
            // digging/scaffolding permissions after this skill has failed.
            if (activeGoal && bot.pathfinder.goal === activeGoal) bot.pathfinder.setGoal(null);
            if (ownedMovements.has(bot.pathfinder.movements) && originalMovements) bot.pathfinder.setMovements(originalMovements);
            reachPositionMovementOwners.delete(bot.pathfinder);
        }
    }
    for (const scaffold of scaffoldRecords) {
        const block = bot.blockAt(new Vec3(scaffold.position.x, scaffold.position.y, scaffold.position.z));
        if ((!block || block.type !== 0) && !cleanupRequired.some(entry => entry.x === scaffold.position.x && entry.y === scaffold.position.y && entry.z === scaffold.position.z)) {
            cleanupRequired.push({ ...scaffold.position, block: scaffold.block, reason: cancelled() ? 'Action cancelled before owned scaffold cleanup.' : 'Owned scaffold remains or became unobserved after route completion.' });
        }
    }
    let finalPosition = snapshotPosition();
    let finalObservedAt = new Date().toISOString();
    if (status === 'reached' && cleanupRequired.length && requireScaffoldCleanup) {
        status = 'blocked';
        resultCode = 'cleanup_incomplete';
        reason = `Reached the target, but ${cleanupRequired.length} owned scaffold(s) could not be removed.`;
    } else if (status === 'reached' && cleanupRequired.length) {
        reason = `Reached the target; ${cleanupRequired.length} owned scaffold(s) remain and are listed in cleanupRequired for optional cleanup.`;
    }
    if (status === 'reached' && unconfirmedScaffolds.length) {
        status = 'blocked';
        resultCode = 'edit_unconfirmed';
        reason = 'A scaffold placement was attempted but not server-confirmed.';
    }
    if (budgetExpired || startedAt && Date.now() - startedAt >= REACH_POSITION_MAX_DURATION_MS) {
        budgetExpired = true;
        if (status === 'reached') {
            status = 'stalled';
            reason = 'Reach exceeded its elapsed-time budget.';
        }
    }
    if (status === 'reached' && arrivalCandidate()) {
        diagnosticPhase = 'arrival';
        const observation = await confirmArrival();
        if (observation) {
            finalPosition = observation.position;
            finalObservedAt = observation.observedAt;
            const observedPosition = new Vec3(finalPosition.x, finalPosition.y, finalPosition.z);
            const diagnostics = { phase: 'arrival', target: { x: target.x, y: target.y, z: target.z,
                block: { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z) } },
                finalPosition, distance: observedPosition.distanceTo(target), displacement: startedPosition.distanceTo(observedPosition),
                feet: observation.feet ?? bot.blockAt(observedPosition.floored())?.name ?? null,
                head: observation.head ?? bot.blockAt(observedPosition.floored().offset(0, 1, 0))?.name ?? null,
                support: observation.support ?? bot.blockAt(observedPosition.floored().offset(0, -1, 0))?.name ?? null,
                onGround: observation.onGround ?? bot.entity.onGround === true, velocity: observation.velocity ?? null,
                lastSearch: reachPositionSearchSummary(lastSearchDiagnostics), physicsTicks: observation.physicsTicks,
                observedAt: finalObservedAt };
            log(bot, `Reached ${target} within ${tolerance} blocks; confirmed ${edits.length} route edits.`);
            recordNavigationDiagnostic(bot, 'navigation_route_arrived', { routeId, routeKind: 'reachPosition',
                elapsedMs: Date.now() - Date.parse(routeStartedAt), finalPosition, confirmedEditCount: edits.length,
                cleanupRequiredCount: cleanupRequired.length, diagnostics });
            return reachPositionResult('reached', finalPosition, reason, edits, cleanupRequired, true, resultCode ?? 'arrived', diagnostics);
        }
        finalPosition = snapshotPosition();
        finalObservedAt = new Date().toISOString();
    }
    if (status === 'reached') { status = 'blocked'; resultCode = arrivalMode === 'block' ? 'unsafe_state' : 'arrival_unconfirmed'; reason = 'Final arrival state was not confirmed.'; }
    if (cleanupRequired.length) reason += ` Cleanup required at ${cleanupRequired.map(item => `(${item.x}, ${item.y}, ${item.z})`).join(', ')}.`;
    log(bot, `Could not complete route to ${target}: ${reason}`);
    const code = resultCode ?? (status === 'cancelled' ? 'cancelled' : status === 'stalled' ? 'search_limit' : 'arrival_unconfirmed');
    const diagnostics = { phase: cleanupRequired.length ? 'cleanup' : diagnosticPhase, target: { x: target.x, y: target.y, z: target.z,
            block: { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z) } },
        finalPosition, distance: finalDistance(), displacement: startedPosition.distanceTo(bot.entity.position),
        feet: bot.blockAt(bot.entity.position.floored())?.name ?? null,
        head: bot.blockAt(bot.entity.position.floored().offset(0, 1, 0))?.name ?? null,
        support: bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))?.name ?? null,
        onGround: bot.entity.onGround === true, velocity: bot.entity.velocity ? { x: bot.entity.velocity.x, y: bot.entity.velocity.y, z: bot.entity.velocity.z } : null,
        lastSearch: reachPositionSearchSummary(lastSearchDiagnostics), observedAt: finalObservedAt };
    recordNavigationDiagnostic(bot, status === 'stalled' ? 'navigation_stall' : 'navigation_route_result', {
        routeId, routeKind: 'reachPosition', status, code, reason: reason.slice(0, 2000),
        elapsedMs: Date.now() - Date.parse(routeStartedAt), finalPosition, confirmedEditCount: edits.length,
        cleanupRequiredCount: cleanupRequired.length, diagnostics });
    return reachPositionResult(status, finalPosition, reason, edits, cleanupRequired, arrivalCandidate(), code, diagnostics);
}

export async function reachPosition(bot, options = {}) {
    return reachPositionCore(bot, options);
}

export async function reachPositionWithScaffoldCleanup(bot, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        return reachPositionResult('blocked', bot?.entity?.position ?? null, 'Options must be an object.');
    }
    return reachPositionCore(bot, {
        ...options,
        allowDig: options.allowDig ?? false,
        allowScaffold: true,
    }, { requireScaffoldCleanup: true });
}

/**
 * Unified native position navigation. Legacy positional goToPosition remains
 * boolean-compatible; this public contract reports arrival and route cleanup
 * separately and keeps temporary scaffolds as a success condition.
 */
async function navigateToPosition(bot, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        return reachPositionResult('blocked', bot?.entity?.position ?? null, 'Options must be an object.');
    }
    const { scaffold = 'forbid', allowDig = false, scaffoldBlocks = ['dirt', 'cobblestone'] } = options;
    if (!['forbid', 'temporary', 'leave'].includes(scaffold)) {
        return reachPositionResult('blocked', bot?.entity?.position ?? null, 'Scaffold policy must be forbid, temporary, or leave.');
    }
    if (typeof allowDig !== 'boolean') {
        return reachPositionResult('blocked', bot?.entity?.position ?? null, 'allowDig must be a boolean.');
    }
    return reachPositionCore(bot, {
        ...options,
        allowDig,
        allowScaffold: scaffold !== 'forbid',
        scaffoldBlocks,
    }, { requireScaffoldCleanup: scaffold === 'temporary', retainEmergencyScaffolds: true });
}

export async function goToPosition(bot, x, y, z, min_distance=2) {
    /**
     * Navigate to the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to navigate to. Must be a finite number.
     * @param {number} y, the y coordinate to navigate to. Must be a finite number.
     * @param {number} z, the z coordinate to navigate to. Must be a finite number.
     * @param {number} distance, the distance to keep from the position. Defaults to 2.
     * @returns {Promise<boolean>} true if the position was reached, false otherwise.
     * @example
     * let position = world.getNearestBlock(bot, "oak_log", 64).position;
     * await skills.goToPosition(bot, position.x, position.y, position.z + 20);
     **/
    if (x && typeof x === 'object' && y === undefined && z === undefined) return navigateToPosition(bot, x);
    validateTargetCall(bot, x, y, z, 'skills.goToPosition(bot, x, y, z, min_distance = 2)');
    if (!Number.isFinite(min_distance) || min_distance < 0) throw new TypeError('skills.goToPosition(bot, x, y, z, min_distance = 2): min_distance must be finite and nonnegative.');
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
        log(bot, `Teleported to ${x}, ${y}, ${z}.`);
        return true;
    }
    
    const checkDigProgress = () => {
        if (bot.targetDigBlock) {
            const targetBlock = bot.targetDigBlock;
            const itemId = bot.heldItem ? bot.heldItem.type : null;
            if (!targetBlock.canHarvest(itemId)) {
                log(bot, `Pathfinding stopped: Cannot break ${targetBlock.name} with current tools.`);
                bot.pathfinder.stop();
                bot.stopDigging();
            }
        }
    };
    
    const progressInterval = setInterval(checkDigProgress, 1000);
    
    try {
        await goToGoal(bot, new pf.goals.GoalNear(x, y, z, min_distance));
        clearInterval(progressInterval);
        const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
        if (distance <= min_distance+1) {
            log(bot, `You have reached at ${x}, ${y}, ${z}.`);
            return true;
        }
        else {
            return failSkill(bot, 'target_unreachable', `Unable to reach ${x}, ${y}, ${z}, you are ${Math.round(distance)} blocks away.`);
        }
    } catch (err) {
        clearInterval(progressInterval);
        return failSkill(bot, err?.navigation?.code ?? 'route_failed', `Pathfinding stopped: ${err.message}.`,
            err?.navigation ? { diagnostics: err.navigation } : {});
    }
}

export async function goToNearestBlock(bot, blockType,  min_distance=2, range=64) {
    /**
     * Navigate to the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to navigate to.
     * @param {number} min_distance, the distance to keep from the block. Defaults to 2.
     * @param {number} range, the range to look for the block. Defaults to 64.
     * @returns {Promise<boolean>} true if the block was reached, false otherwise.
     * @example
     * await skills.goToNearestBlock(bot, "oak_log", 2, 64);
     * **/
    const MAX_RANGE = 512;
    if (range > MAX_RANGE) {
        log(bot, `Maximum search range capped at ${MAX_RANGE}. `);
        range = MAX_RANGE;
    }
    let block = null;
    if (blockType === 'water' || blockType === 'lava') {
        let blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType && block.metadata === 0, range, 1);
        if (blocks.length === 0) {
            log(bot, `Could not find any source ${blockType} in ${range} blocks, looking for uncollectable flowing instead...`);
            blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType, range, 1);
        }
        block = blocks[0];
    }
    else {
        block = world.getNearestBlock(bot, blockType, range);
    }
    if (!block) {
        return failSkill(bot, 'target_not_found', `Could not find any ${blockType} in ${range} blocks.`);
    }
    log(bot, `Found ${blockType} at ${block.position}. Navigating...`);
    return await goToPosition(bot, block.position.x, block.position.y, block.position.z, min_distance);
}

export async function goToNearestEntity(bot, entityType, min_distance=2, range=64) {
    /**
     * Navigate to the nearest entity of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} entityType, the type of entity to navigate to.
     * @param {number} min_distance, the distance to keep from the entity. Defaults to 2.
     * @param {number} range, the range to look for the entity. Defaults to 64.
     * @returns {Promise<boolean>} true if the entity was reached, false otherwise.
     **/
    let entity = world.getNearestEntityWhere(bot, entity => entity.name === entityType, range);
    if (!entity) {
        return failSkill(bot, 'target_not_found', `Could not find any ${entityType} in ${range} blocks.`);
    }
    let distance = bot.entity.position.distanceTo(entity.position);
    log(bot, `Found ${entityType} ${distance} blocks away.`);
    return await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, min_distance);
}

const EXPLORE_STEP_TIMEOUT_MS = 20000;
const EXPLORE_TURNS = [0, 1, -1, 2, -2, 3, -3].map(turn => turn * Math.PI / 4);
const EXPLORE_SURFACE_SCAN = 48;

// Feet position on the topmost ground of a loaded column; trees are not ground. Water columns
// return null so wandering turns toward land: open-water recovery cannot find a landing.
function exploreSurfaceTarget(bot, x, z, nearY) {
    const column = new Vec3(Math.floor(x), 0, Math.floor(z));
    for (let y = Math.floor(nearY) + EXPLORE_SURFACE_SCAN; y >= Math.floor(nearY) - EXPLORE_SURFACE_SCAN; y--) {
        const block = bot.blockAt(column.offset(0, y, 0));
        if (!block) continue;
        if (block.name === 'air' || block.name === 'cave_air' || block.name.endsWith('_leaves') || block.name.endsWith('_log')) continue;
        if (block.name === 'water' || block.name === 'lava') return null;
        if (block.boundingBox === 'block') return { x: column.x, y: y + 1, z: column.z };
    }
    return null;
}

export async function exploreUntilBlock(bot, options = {}) {
    /**
     * Wander outward until one of the given block types is loaded within searchRadius, e.g. bell or hay_block to find a village. 構造物探しの探索移動。
     * @param {MinecraftBot} bot - Pass bot first.
     * @param {object} options - Named options.
     * @param {string[]} options.blockTypes - Block names to look for; any one ends the search.
     * @param {number} options.searchRadius - Observation radius checked before each step, default 64.
     * @param {number} options.stepDistance - Horizontal distance of each wander step, default 32.
     * @param {number} options.timeoutMs - Search time budget, default 300000.
     * @returns {Promise<object>} found returns {ok:true,status:'found',block:{name,position},steps,travelled,elapsedMs}; otherwise ok:false with status not_found (timeout), blocked (no progress in any of seven directions) or cancelled. It does not approach the found block.
     * @example
     * const result = await skills.exploreUntilBlock(bot, { blockTypes: ['bell', 'hay_block'] });
     **/
    const { blockTypes, searchRadius = 64, stepDistance = 32, timeoutMs = 300000 } = options ?? {};
    if (!Array.isArray(blockTypes) || blockTypes.length === 0) throw new TypeError('skills.exploreUntilBlock(bot, options): blockTypes must be a nonempty array of block names.');
    const unknown = blockTypes.filter(name => !Number.isInteger(mc.getBlockId(name)));
    if (unknown.length) throw new TypeError(`skills.exploreUntilBlock(bot, options): unknown block types ${unknown.join(', ')}.`);
    const context = getActionContext(bot);
    const startedAt = Date.now();
    const start = bot.entity.position.clone();
    let heading = Math.random() * 2 * Math.PI;
    let steps = 0;
    let failures = 0;
    let lastFailure = null;
    const summary = () => ({ steps, travelled: Math.round(Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z)),
        elapsedMs: Date.now() - startedAt });
    const finish = result => { log(bot, JSON.stringify(result)); return result; };
    while (true) {
        const block = world.getNearestBlocks(bot, blockTypes, searchRadius, 1)[0];
        if (block) return finish({ ok: true, status: 'found', block: { name: block.name, position: { x: block.position.x, y: block.position.y, z: block.position.z } }, ...summary() });
        if (isActionCancelled(bot, context)) return finish({ ok: false, status: 'cancelled', code: 'cancelled', reason: 'Exploration cancelled.', ...summary() });
        if (Date.now() - startedAt >= timeoutMs) return finish({ ok: false, status: 'not_found', code: 'timeout',
            reason: `No ${blockTypes.join('/')} found within ${timeoutMs}ms of exploration.`, ...summary() });
        // Head away from the start so the search keeps reaching new chunks; after a failed step try
        // the next offset from that outward direction instead of reversing the whole walk.
        const before = bot.entity.position.clone();
        const away = Math.hypot(before.x - start.x, before.z - start.z) >= stepDistance
            ? Math.atan2(before.z - start.z, before.x - start.x) : heading;
        let target = null;
        for (; failures < EXPLORE_TURNS.length && !target; failures += target ? 0 : 1) {
            const angle = away + EXPLORE_TURNS[failures] + (failures === 0 ? (Math.random() - 0.5) * Math.PI / 3 : 0);
            target = exploreSurfaceTarget(bot, before.x + Math.cos(angle) * stepDistance, before.z + Math.sin(angle) * stepDistance, before.y);
            if (!target) lastFailure = { code: 'no_ground', reason: 'No loaded dry ground in the remaining wander directions.' };
        }
        if (!target) return finish({ ok: false, status: 'blocked', code: lastFailure?.code ?? 'no_progress',
            reason: `Exploration found no way forward in ${EXPLORE_TURNS.length} directions${lastFailure ? `: ${lastFailure.reason}` : '.'}`, ...summary() });
        steps++;
        // An XZ-only goal lets the route follow caves downward, so aim at the column's surface instead.
        const stepTimer = setTimeout(() => bot.pathfinder.stop(), EXPLORE_STEP_TIMEOUT_MS);
        try {
            await goToGoal(bot, new pf.goals.GoalNear(target.x, target.y, target.z, 3));
        } catch (err) {
            lastFailure = { code: err?.navigation?.code ?? 'route_failed', reason: String(err?.message ?? err) };
        } finally { clearTimeout(stepTimer); }
        const moved = Math.hypot(bot.entity.position.x - before.x, bot.entity.position.z - before.z);
        if (moved >= stepDistance / 4) {
            heading = Math.atan2(bot.entity.position.z - before.z, bot.entity.position.x - before.x);
            failures = 0;
        } else failures++;
    }
}

export async function goToPlayer(bot, username, distance=3) {
    /**
     * Navigate to the given player.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to navigate to.
     * @param {number} distance, the goal distance to the player.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.goToPlayer(bot, "player");
     **/
    if (bot.username === username) {
        log(bot, `You are already at ${username}.`);
        return true;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + username);
        log(bot, `Teleported to ${username}.`);
        return true;
    }

    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let player = bot.players?.[username]?.entity
    if (!player) {
        return failSkill(bot, 'target_not_found', `Could not find ${username}.`);
    }

    distance = Math.max(distance, 0.5);
    const goal = new pf.goals.GoalFollow(player, distance);

    try {
        await goToGoal(bot, goal, true);
    } catch (err) {
        return failSkill(bot, 'route_failed', `Could not reach ${username}: ${err.message}.`);
    }

    log(bot, `You have reached ${username}.`);
    return true;
}


export async function followPlayer(bot, username, distance=4) {
    /**
     * Follow the given player endlessly. Will not return until the code is manually stopped.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to follow.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.followPlayer(bot, "player");
     **/
    let player = bot.players?.[username]?.entity
    if (!player)
        return failSkill(bot, 'target_not_found', `Could not find ${username}.`, { playerName: username });

    return trackNavigationSegment(bot, async () => {
    const move = navigationMovements(bot);
    move.digCost = 10;
    const followGoal = new pf.goals.GoalFollow(player, distance);
    if (navigationRecoveryDescriptor(bot)) await goToGoal(bot, followGoal, move);
    bot.pathfinder.setMovements(move);
    let doorCheckInterval = navigationPolicy() || operationContext()?.nativeNavigationNoEdits
        ? null : startDoorInterval(bot);

    bot.pathfinder.setGoal(new pf.goals.GoalFollow(player, distance), true);
    log(bot, `You are now actively following player ${username}.`);

    while (!bot.interrupt_code) {
        await new Promise(resolve => setTimeout(resolve, 500));
        // in cheat mode, if the distance is too far, teleport to the player
        const distance_from_player = bot.entity.position.distanceTo(player.position);

        const teleport_distance = 100;
        const ignore_modes_distance = 30; 
        const nearby_distance = distance + 2;

        if (distance_from_player > teleport_distance && bot.modes.isOn('cheat')) {
            // teleport with cheat mode
            await goToPlayer(bot, username);
        }
        else if (distance_from_player > ignore_modes_distance) {
            // these modes slow down the bot, and we want to catch up
            bot.modes.pause('item_collecting');
            bot.modes.pause('hunting');
            bot.modes.pause('torch_placing');
        }
        else if (distance_from_player <= ignore_modes_distance) {
            bot.modes.unpause('item_collecting');
            bot.modes.unpause('hunting');
            bot.modes.unpause('torch_placing');
        }

        if (distance_from_player <= nearby_distance) {
            clearInterval(doorCheckInterval);
            doorCheckInterval = null;
            bot.modes.pause('elbow_room');
        }
        else {
            if (!doorCheckInterval) {
            doorCheckInterval = navigationPolicy() || operationContext()?.nativeNavigationNoEdits
                ? null : startDoorInterval(bot);
            }
            bot.modes.unpause('elbow_room');
        }
    }
    clearInterval(doorCheckInterval);
    return true;
    });
}


export async function moveAway(bot, distance) {
    /**
     * Move away from current position in any direction.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.moveAway(bot, 8);
     **/
    const pos = bot.entity.position;
    let goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(navigationMovements(bot));

    if (bot.modes.isOn('cheat')) {
        const move = navigationMovements(bot);
        const path = await bot.pathfinder.getPathTo(move, inverted_goal, 10000);
        let last_move = path.path[path.path.length-1];
        if (last_move) {
            let x = Math.floor(last_move.x);
            let y = Math.floor(last_move.y);
            let z = Math.floor(last_move.z);
            bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
            return true;
        }
    }

    await goToGoal(bot, inverted_goal);
    let new_pos = bot.entity.position;
    log(bot, `Moved away from ${pos.floored()} to ${new_pos.floored()}.`);
    return true;
}

export async function moveAwayFromEntity(bot, entity, distance=16) {
    /**
     * Move away from the given entity.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to move away from.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     **/
    let goal = new pf.goals.GoalFollow(entity, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    await goToGoal(bot, inverted_goal);
    return true;
}

export async function avoidEnemies(bot, distance=16) {
    /**
     * Move a given distance away from all nearby enemy mobs.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.avoidEnemies(bot, 8);
     **/
    bot.modes.pause('self_preservation'); // prevents damage-on-low-health from interrupting the bot
    return trackNavigationSegment(bot, async () => {
    const movement = navigationMovements(bot);
    movement.canDig = false;
    movement.allow1by1towers = false;
    let key = null;
    let pathFailure = null;
    let bestClearance = -Infinity;
    let progressAt = Date.now();
    const deadline = Date.now() + 30_000;
    const onPath = result => {
        if (['noPath', 'timeout'].includes(result?.status)) pathFailure = result.status;
    };
    bot.on('path_update', onPath);
    try {
        while (!bot.interrupt_code) {
            const enemies = await world.getNearbyThreats(bot, distance);
            if (bot.interrupt_code) return false;
            if (!enemies.length) {
                log(bot, `No threatening enemies remain within ${distance} blocks.`);
                return true;
            }
            const clearance = Math.min(...enemies.map(enemy => bot.entity.position.distanceTo(enemy.position)));
            if (clearance > bestClearance + 0.5) {
                bestClearance = clearance;
                progressAt = Date.now();
            }
            if (pathFailure || Date.now() >= deadline || Date.now() - progressAt >= 5_000) {
                return failSkill(bot, 'retreat_stopped', `Retreat stopped: ${pathFailure ?? (Date.now() >= deadline ? 'time limit' : 'no distance progress')}.`);
            }
            const nextKey = enemies.map(enemy => `${enemy.id}:${Math.floor(enemy.position.x)},${Math.floor(enemy.position.y)},${Math.floor(enemy.position.z)}`).sort().join(';');
            if (nextKey !== key) {
                const goal = allRetreatGoals(enemies.map(enemy => {
                    const p = enemy.position;
                    return new pf.goals.GoalInvert(new pf.goals.GoalNear(p.x, p.y, p.z, distance + 1));
                }));
                if (navigationRecoveryDescriptor(bot)) await goToGoal(bot, goal, movement);
                if (bot.interrupt_code) return false;
                bot.pathfinder.setMovements(movement);
                bot.pathfinder.setGoal(goal, true);
                key = nextKey;
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return false;
    } finally {
        bot.removeListener('path_update', onPath);
        bot.pathfinder.setGoal(null);
    }
    });
}

export async function stay(bot, seconds=30) {
    /**
     * Stay in the current position until interrupted. Disables all modes.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} seconds, the number of seconds to stay. Defaults to 30. -1 for indefinite.
     * @returns {Promise<boolean>} true if the bot stayed, false otherwise.
     * @example
     * await skills.stay(bot);
     **/
    bot.modes.pause('self_preservation');
    bot.modes.pause('cowardice');
    bot.modes.pause('self_defense');
    bot.modes.pause('hunting');
    bot.modes.pause('torch_placing');
    bot.modes.pause('item_collecting');
    let start = Date.now();
    while (!bot.interrupt_code && (seconds === -1 || Date.now() - start < seconds*1000)) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `Stayed for ${(Date.now() - start)/1000} seconds.`);
    return true;
}

export async function useDoor(bot, door_pos=null, options={}) {
    /**
     * Use a wooden door or fence gate, optionally setting its open state without crossing.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Vec3} door_pos, the position of the door to use. If null, the nearest door will be used.
     * @param {object} options, optional { open: boolean }; omission keeps open/traverse/close behavior.
     * @returns {Promise<boolean>} true if the door was used, false otherwise.
     * @example
     * let door = world.getNearestBlock(bot, "oak_door", 16).position;
     * await skills.useDoor(bot, door);
     **/
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || (Object.hasOwn(options, 'open') && typeof options.open !== 'boolean')) {
        throw new TypeError('skills.useDoor options.open must be a boolean when supplied.');
    }
    const species = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped'];
    const usable = new Set(species.flatMap(name => [`${name}_door`, `${name}_fence_gate`]));
    if (!door_pos) {
        door_pos = [...usable].map(name => world.getNearestBlock(bot, name, 16)).filter(Boolean)
            .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0]?.position;
    } else {
        door_pos = Vec3(door_pos.x, door_pos.y, door_pos.z);
    }
    if (!door_pos) {
        return failSkill(bot, 'target_not_found', `Could not find a door to use.`);
    }

    let forwardEnabled = false;
    try {
        if (!await goToPosition(bot, door_pos.x, door_pos.y, door_pos.z, 1)) return false;
        let doorBlock = bot.blockAt(door_pos);
        const isOpen = block => block?.getProperties?.().open === true;
        if (!doorBlock || !usable.has(doorBlock.name)) {
            return failSkill(bot, 'target_not_found', `Could not find a wooden door or fence gate at ${door_pos}.`);
        }
        if (Object.hasOwn(options, 'open')) {
            if (typeof doorBlock.getProperties?.().open !== 'boolean') {
                return failSkill(bot, 'target_unknown', `Door or gate state is unknown at ${door_pos}.`);
            }
            if (isOpen(doorBlock) === options.open) return true;
            const changed = waitForBlockUpdate(bot, door_pos,
                block => block?.name === doorBlock.name && block.getProperties?.().open === options.open,
                INTERACTION_CONFIRM_TIMEOUT_MS);
            try {
                await bot.lookAt(door_pos);
                await bot.activateBlock(doorBlock);
                const confirmed = await changed.promise;
                if (!confirmed || bot.interrupt_code) {
                    return failSkill(bot, 'unconfirmed', `Could not confirm ${options.open ? 'opening' : 'closing'} the door or gate at ${door_pos}.`);
                }
                return true;
            } finally { changed.cleanup(); }
        }
        if (!isOpen(doorBlock)) {
            const opening = waitForBlockUpdate(bot, door_pos, isOpen, INTERACTION_CONFIRM_TIMEOUT_MS);
            try {
                await bot.lookAt(door_pos);
                await bot.activateBlock(doorBlock);
                if (!await opening.promise || bot.interrupt_code) {
                    return failSkill(bot, 'unconfirmed', `Could not confirm opening the door at ${door_pos}.`);
                }
            } finally {
                opening.cleanup();
            }
            doorBlock = bot.blockAt(door_pos);
        }
        if (bot.interrupt_code) return false;
        if (!isOpen(doorBlock)) return failSkill(bot, 'unconfirmed', `Could not confirm the door at ${door_pos} is open.`);

        bot.setControlState('forward', true);
        forwardEnabled = true;
        await new Promise(resolve => setTimeout(resolve, 600));
        if (bot.interrupt_code) return false;
        bot.setControlState('forward', false);
        forwardEnabled = false;
        doorBlock = bot.blockAt(door_pos);
        if (isOpen(doorBlock)) await bot.activateBlock(doorBlock);

        log(bot, `Used door at ${door_pos}.`);
        return true;
    } catch (err) {
        return failSkill(bot, 'action_error', `Failed to use door at ${door_pos}: ${err.message}.`);
    } finally {
        if (forwardEnabled) {
            try { bot.setControlState('forward', false); } catch (err) {}
        }
    }
}

export async function goToBed(bot) {
    /**
     * Sleep in the nearest bed.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bed was found, false otherwise.
     * @example
     * await skills.goToBed(bot);
     **/
    const beds = bot.findBlocks({
        matching: (block) => {
            return block.name.includes('bed');
        },
        maxDistance: 32,
        count: 1
    });
    if (beds.length === 0) {
        return failSkill(bot, 'target_not_found', `Could not find a bed to sleep in.`);
    }
    let loc = beds[0];
    if (!await goToPosition(bot, loc.x, loc.y, loc.z)) return false;
    const bed = bot.blockAt(loc);
    await bot.sleep(bed);
    log(bot, `You are in bed.`);
    while (bot.isSleeping) {
        if (isActionCancelled(bot)) {
            await bot.wake().catch(() => {});
            return failSkill(bot, 'cancelled', 'Sleeping was interrupted; left the bed.');
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `You have woken up.`);
    return true;
}

export async function tillAndSow(bot, x, y, z, seedType=null) {
    /**
     * Till the ground at the given position and plant the given seed type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to till.
     * @param {number} y, the y coordinate to till.
     * @param {number} z, the z coordinate to till.
     * @param {string} seedType, a seed item name or supported crop name. Defaults to none, which will only till the ground.
     * @returns {Promise<boolean>} true if tilling succeeded and any requested planting was confirmed, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.tillAndSow(bot, position.x, position.y - 1, position.z, "wheat_seeds");
     **/
    let pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    let block = bot.blockAt(pos);
    const requestedPlant = seedType;
    const plantingItem = seedType
        ? (CROPS[seedType]?.seed ?? (seedType.endsWith('seed') && !seedType.endsWith('seeds') ? `${seedType}s` : seedType))
        : null;
    const cropName = seedType ? (CROPS[seedType] ? seedType : Object.entries(CROPS).find(([, crop]) => crop.seed === plantingItem)?.[0]) : null;
    log(bot, `Planting ${requestedPlant} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);

    if (bot.modes.isOn('cheat')) {
        if (block.name !== 'farmland' && !await performAndConfirmBlockUpdate(bot, pos, 'farmland', () => placeBlock(bot, 'farmland', x, y, z))) {
            return failSkill(bot, 'unconfirmed', `Could not confirm farmland at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
        }
        if (plantingItem) {
            const desiredCrop = cropName ?? plantingItem;
            const cropPosition = pos.offset(0, 1, 0);
            if (bot.blockAt(cropPosition)?.name !== desiredCrop &&
                !await performAndConfirmBlockUpdate(bot, cropPosition, desiredCrop, () => placeBlock(bot, desiredCrop, x, y+1, z))) {
                return failSkill(bot, 'unconfirmed', `Could not confirm planting ${plantingItem} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
            }
        }
        return true;
    }

    if (block.name !== 'grass_block' && block.name !== 'dirt' && block.name !== 'farmland') {
        return failSkill(bot, 'invalid_target', `Cannot till ${block.name}, must be grass_block or dirt.`);
    }
    let above = bot.blockAt(new Vec3(x, y+1, z));
    if (above.name !== 'air') {
        if (block.name === 'farmland') {
            if (!plantingItem || (cropName && above.name === cropName)) {
                log(bot, `Land is already farmed with ${above.name}.`);
                return true;
            }
            return failSkill(bot, 'blocked', `Land is already farmed with ${above.name}, not ${requestedPlant}.`);
        }
        let broken = await breakBlockAt(bot, x, y+1, z);
        if (!broken) {
            return failSkill(bot, 'blocked', `Cannot cannot break above block to till.`);
        }
    }
    // if distance is too far, move to the block
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(navigationMovements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    if (block.name !== 'farmland') {
        let hoe = bot.inventory.items().find(item => item.name.includes('hoe'));
        let to_equip = hoe?.name || 'diamond_hoe';
        if (!await equip(bot, to_equip)) {
            return failSkill(bot, 'missing_tool', `Cannot till, no hoes.`);
        }
        await bot.activateBlock(block);
        log(bot, `Tilled block x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    
    if (plantingItem) {
        let equipped_seeds = await equip(bot, plantingItem);
        if (!equipped_seeds) {
            return failSkill(bot, 'missing_item', `No ${plantingItem} to plant.`, { itemName: plantingItem });
        }

        const cropPosition = pos.offset(0, 1, 0);
        const update = waitForBlockUpdate(bot, cropPosition, newBlock => cropName ? newBlock?.name === cropName : newBlock?.name !== 'air');
        try {
            await bot.activateBlock(block);
            if (!await update.promise) {
                return failSkill(bot, 'unconfirmed', `Could not confirm planting ${plantingItem} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
            }
        } finally {
            update.cleanup();
        }
        log(bot, `Planted ${plantingItem} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    return true;
}

export async function activateNearestBlock(bot, type, position=null) {
    /**
     * Activate the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} type, the type of block to activate.
     * @returns {Promise<boolean>} true if the block was activated, false otherwise.
     * @example
     * await skills.activateNearestBlock(bot, "lever");
     * **/
    let block = position == null ? world.getNearestBlock(bot, type, 16)
        : bot.blockAt(new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)));
    if (position != null && block?.name !== type) return failSkill(bot, 'target_not_found', `No ${type} at the requested position.`, { position });
    if (!block) {
        return failSkill(bot, 'target_not_found', `Could not find any ${type} to activate.`);
    }
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        const pos = block.position;
        if (position != null) {
            if (!await goToPosition(bot, pos.x, pos.y, pos.z, 4)) return false;
            block = bot.blockAt(pos);
            if (!block || block.name !== type) return failSkill(bot, 'target_changed', `The requested ${type} changed during approach.`, { position });
        } else {
            bot.pathfinder.setMovements(navigationMovements(bot));
            await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
        }
    }
    await bot.activateBlock(block);
    log(bot, `Activated ${type} at x:${block.position.x.toFixed(1)}, y:${block.position.y.toFixed(1)}, z:${block.position.z.toFixed(1)}.`);
    return true;
}

/**
 * Helper function to find and navigate to a villager for trading
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager
 * @returns {Promise<Object|null>} the villager entity if found and reachable, null otherwise
 */
async function findAndGoToVillager(bot, id) {
    id = id+"";
    const entity = bot.entities[id];
    
    if (!entity) {
        log(bot, `Cannot find villager with id ${id}`);
        let entities = world.getNearbyEntities(bot, 16);
        let villager_list = "Available villagers:\n";
        for (let entity of entities) {
            if (entity.name === 'villager') {
                if (entity.metadata && entity.metadata[16] === 1) {
                    villager_list += `${entity.id}: baby villager\n`;
                } else {
                    const profession = world.getVillagerProfession(entity);
                    villager_list += `${entity.id}: ${profession}\n`;
                }
            }
        }
        if (villager_list === "Available villagers:\n") {
            failSkill(bot, 'target_not_found', `Cannot find villager with id ${id}; no villagers found nearby.`, { entityId: Number(id) });
            return null;
        }
        log(bot, villager_list);
        skillFailure('target_not_found', `Cannot find villager with id ${id}.`, { entityId: Number(id) });
        return null;
    }
    
    if (entity.entityType !== bot.registry.entitiesByName.villager.id) {
        failSkill(bot, 'wrong_target_type', 'Entity is not a villager', { entityId: Number(id) });
        return null;
    }
    
    if (entity.metadata && entity.metadata[16] === 1) {
        failSkill(bot, 'target_cannot_trade', 'This is either a baby villager or a villager with no job - neither can trade', { entityId: Number(id) });
        return null;
    }
    
    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance > 4) {
        log(bot, `Villager is ${distance.toFixed(1)} blocks away, moving closer...`);
        try {
            const goal = new pf.goals.GoalFollow(entity, 2);
            await goToGoal(bot, goal);
            
            
            log(bot, 'Successfully reached villager');
        } catch (err) {
            failSkill(bot, 'route_failed', `Failed to reach villager - pathfinding error or villager moved: ${err?.message ?? err}`, { entityId: Number(id) });
            console.log(err);
            return null;
        }
    }
    
    return entity;
}

/**
 * Show available trades for a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to show trades for
 * @returns {Promise<boolean>} true if trades were shown successfully, false otherwise
 * @example
 * await skills.showVillagerTrades(bot, "123");
 */
export async function showVillagerTrades(bot, id, structured=false) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return structured ? null : false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return structured ? [] : false;
        }
        
        log(bot, `Villager has ${villager.trades.length} available trades:`);
        stringifyTrades(bot, villager.trades).forEach((trade, i) => {
            const tradeInfo = `${i + 1}: ${trade}`;
            console.log(tradeInfo);
            log(bot, tradeInfo);
        });
        
        const trades = villager.trades;
        villager.close();
        return structured ? trades.map((trade, index) => ({ index: index + 1, disabled: !!trade.disabled, uses: trade.uses ?? null,
            maxUses: trade.maxUses ?? null, input: (trade.inputItem1 ? [{ name: trade.inputItem1.name, count: trade.inputItem1.count }] : [])
                .concat(trade.inputItem2 ? [{ name: trade.inputItem2.name, count: trade.inputItem2.count }] : []),
            output: trade.outputItem ? { name: trade.outputItem.name, count: trade.outputItem.count } : null })) : true;
    } catch (err) {
        log(bot, 'Failed to open villager trading interface - they might be sleeping, a baby, or jobless');
        console.log('Villager trading error:', err.message);
        return structured ? null : false;
    }
}

/**
 * Trade with a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to trade with
 * @param {number} index - the index (1-based) of the trade to execute
 * @param {number} count - how many times to execute the trade (optional)
 * @returns {Promise<boolean>} true if trade was successful, false otherwise
 * @example
 * await skills.tradeWithVillager(bot, "123", "1", "2");
 */
export async function tradeWithVillager(bot, id, index, count) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    const tradeFailure = (villager, code, reason, detail = {}) => {
        villager?.close();
        return failSkill(bot, code, reason, { unit: 'trade', requestedQuantity: count, confirmedQuantity: 0, remainingQuantity: count, ...detail });
    };
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            return tradeFailure(villager, 'no_trades', 'This villager has no trades available - might be sleeping, a baby, or jobless');
        }
        
        const tradeIndex = parseInt(index) - 1; // Convert to 0-based index
        const trade = villager.trades[tradeIndex];
        
        if (!trade) {
            return tradeFailure(villager, 'trade_not_found', `Trade ${index} not found. This villager has ${villager.trades.length} trades available.`);
        }
        
        if (trade.disabled) {
            return tradeFailure(villager, 'trade_disabled', `Trade ${index} is currently disabled`);
        }

        const item_2 = trade.inputItem2 ? stringifyItem(bot, trade.inputItem2)+' ' : '';
        log(bot, `Trading ${stringifyItem(bot, trade.inputItem1)} ${item_2}for ${stringifyItem(bot, trade.outputItem)}...`);
        
        const maxPossibleTrades = trade.maximumNbTradeUses - trade.nbTradeUses;
        const requestedCount = count;
        const actualCount = Math.min(requestedCount, maxPossibleTrades);
        
        if (actualCount <= 0) {
            return tradeFailure(villager, 'trade_limit', `Trade ${index} has been used to its maximum limit`);
        }
        
        if (!hasResources(villager.slots, trade, actualCount)) {
            return tradeFailure(villager, 'missing_item', `Don't have enough resources to execute trade ${index} ${actualCount} time(s)`);
        }
        
        log(bot, `Executing trade ${index} ${actualCount} time(s)...`);
        
        const outputName = bot.registry?.items?.[trade.outputItem?.type]?.name ?? trade.outputItem?.name;
        const outputBefore = outputName ? inventoryItemCount(bot, outputName) : null;
        try {
            await bot.trade(villager, tradeIndex, actualCount);
            villager.close();
            // Executed trades are confirmed from the received output, never from the requested count.
            const perTrade = trade.outputItem?.count;
            const confirmed = outputName && Number.isInteger(perTrade) && perTrade > 0
                ? Math.min(actualCount, Math.floor((inventoryItemCount(bot, outputName) - outputBefore) / perTrade)) : null;
            log(bot, `Successfully traded ${actualCount} time(s)`);
            const complete = confirmed === requestedCount;
            reportSkillOutcome({ ok: complete, status: complete ? 'complete' : confirmed == null ? 'unknown' : confirmed > 0 ? 'partial' : 'failed',
                ...(complete ? {} : actualCount < requestedCount
                    ? { code: 'trade_limit', reason: `Trade ${index} allowed only ${actualCount} of ${requestedCount} requested uses.` }
                    : { code: 'trade_unconfirmed', reason: 'Received trade output did not confirm every requested trade.' }),
                unit: 'trade', requestedQuantity: requestedCount, confirmedQuantity: confirmed,
                remainingQuantity: confirmed == null ? null : requestedCount - confirmed });
            return true;
        } catch (tradeErr) {
            console.log('Trade execution error:', tradeErr.message);
            return tradeFailure(villager, 'trade_failed', `An error occurred while trying to execute the trade: ${tradeErr.message}`, { confirmedQuantity: null, remainingQuantity: null });
        }
    } catch (err) {
        console.log('Villager interface error:', err.message);
        return failSkill(bot, 'container_open_failed', `Failed to open villager trading interface: ${err.message}`,
            { unit: 'trade', requestedQuantity: count, confirmedQuantity: 0, remainingQuantity: count });
    }
}

function hasResources(window, trade, count) {
    const first = enough(trade.inputItem1, count);
    const second = !trade.inputItem2 || enough(trade.inputItem2, count);
    return first && second;

    function enough(item, count) {
        let c = 0;
        window.forEach((element) => {
            if (element && element.type === item.type && element.metadata === item.metadata) {
                c += element.count;
            }
        });
        return c >= item.count * count;
    }
}

function stringifyTrades(bot, trades) {
    return trades.map((trade) => {
        let text = stringifyItem(bot, trade.inputItem1);
        if (trade.inputItem2) text += ` & ${stringifyItem(bot, trade.inputItem2)}`;
        if (trade.disabled) text += ' x '; else text += ' » ';
        text += stringifyItem(bot, trade.outputItem);
        return `(${trade.nbTradeUses}/${trade.maximumNbTradeUses}) ${text}`;
    });
}

function stringifyItem(bot, item) {
    if (!item) return 'nothing';
    let text = `${item.count} ${item.displayName}`;
    if (item.nbt && item.nbt.value) {
        const ench = item.nbt.value.ench;
        const StoredEnchantments = item.nbt.value.StoredEnchantments;
        const Potion = item.nbt.value.Potion;
        const display = item.nbt.value.display;

        if (Potion) text += ` of ${Potion.value.replace(/_/g, ' ').split(':')[1] || 'unknown type'}`;
        if (display) text += ` named ${display.value.Name.value}`;
        if (ench || StoredEnchantments) {
            text += ` enchanted with ${(ench || StoredEnchantments).value.value.map((e) => {
                const lvl = e.lvl.value;
                const id = e.id.value;
                return bot.registry.enchantments[id].displayName + ' ' + lvl;
            }).join(' ')}`;
        }
    }
    return text;
}

export async function digDown(bot, distance = 10) {
    /**
     * Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {int} distance, distance to dig down.
     * @returns {Promise<boolean>} true if successfully dug all the way down.
     * @example
     * await skills.digDown(bot, 10);
     **/

    let start_block = bot.blockAt(bot.entity.position);
    if (!start_block) {
        recordUncertainty({ unit: 'block', target: 'digDown start position',
            reason: 'block observation is unknown; Mineflayer returned null', observedAt: new Date().toISOString() });
        return failSkill(bot, 'target_unknown', 'Cannot dig down: current block observation is unknown.');
    }
    let start_block_pos = start_block.position;
    for (let i = 1; i <= distance; i++) {
        const targetBlock = bot.blockAt(start_block_pos.offset(0, -i, 0));
        let belowBlock = bot.blockAt(start_block_pos.offset(0, -i-1, 0));

        if (!targetBlock || !belowBlock) {
            recordUncertainty({ unit: 'block', target: { position: { x: start_block_pos.x, y: start_block_pos.y - i, z: start_block_pos.z } },
                reason: 'digDown stopped because a target or lower block observation is unknown; Mineflayer returned null',
                observedAt: new Date().toISOString() });
            return failSkill(bot, 'unconfirmed', `Could not confirm the next block while digging down after ${i-1} blocks; stopping without treating it as completion.`);
        }

        // Check for lava, water
        if (targetBlock.name === 'lava' || targetBlock.name === 'water' || 
            belowBlock.name === 'lava' || belowBlock.name === 'water') {
            return failSkill(bot, 'hazard_stop', `Dug down ${i-1} blocks, but reached ${belowBlock ? belowBlock.name : '(lava/water)'}`);
        }

        const MAX_FALL_BLOCKS = 2;
        let num_fall_blocks = 0;
        for (let j = 0; j <= MAX_FALL_BLOCKS; j++) {
            if (!belowBlock || (belowBlock.name !== 'air' && belowBlock.name !== 'cave_air')) {
                break;
            }
            num_fall_blocks++;
            belowBlock = bot.blockAt(belowBlock.position.offset(0, -1, 0));
        }
        if (num_fall_blocks > MAX_FALL_BLOCKS) {
            return failSkill(bot, 'hazard_stop', `Dug down ${i-1} blocks, but reached a drop below the next block.`);
        }

        if (targetBlock.name === 'air' || targetBlock.name === 'cave_air') {
            log(bot, 'Skipping air block');
            console.log(targetBlock.position);
            continue;
        }

        let dug = await breakBlockAt(bot, targetBlock.position.x, targetBlock.position.y, targetBlock.position.z);
        if (!dug) {
            return failSkill(bot, 'action_error', 'Failed to dig block at position:' + targetBlock.position);
        }
    }
    log(bot, `Dug down ${distance} blocks.`);
    return true;
}

function isFullCubeSurfaceSupport(block, movements) {
    if (!block || block.boundingBox !== 'block' || block.name.includes('leaves')) return false;
    if (UNSAFE_SURFACE_BLOCKS.has(block.name) || movements?.blocksToAvoid?.has(block.type)) return false;
    return block.shapes?.some(shape => shape.length === 6 &&
        shape[0] === 0 && shape[1] === 0 && shape[2] === 0 &&
        shape[3] === 1 && shape[4] === 1 && shape[5] === 1) === true;
}

function isClearStandingSpace(block, movements) {
    if (!block || !Array.isArray(block.shapes)) return false;
    if (block.shapes.length !== 0 || UNSAFE_SURFACE_BLOCKS.has(block.name) ||
        movements?.blocksToAvoid?.has(block.type)) return false;
    return !block.name.includes('water') && !block.name.includes('lava');
}

function findLoadedSurfaceCandidate(bot, x, z, minY, maxY, movements) {
    let highestCollision = null;
    for (let y = maxY - 1; y >= minY; y--) {
        const block = bot.blockAt(new Vec3(x, y, z));
        if (!block) return null;
        if (block.shapes?.length) {
            highestCollision = block;
            break;
        }
    }
    if (!isFullCubeSurfaceSupport(highestCollision, movements)) return null;

    const feetY = Math.floor(highestCollision.position.y) + 1;
    for (const y of [feetY, feetY + 1]) {
        const block = bot.blockAt(new Vec3(x, y, z));
        if (!isClearStandingSpace(block, movements)) return null;
    }
    return { x, y: feetY, z, support: highestCollision };
}

function isConnectedSurfaceCandidate(candidate, candidates) {
    return candidates.some(neighbor =>
        Math.abs(neighbor.x - candidate.x) + Math.abs(neighbor.z - candidate.z) === 1 &&
        Math.abs(neighbor.y - candidate.y) <= SURFACE_CONNECTED_STEP_HEIGHT);
}

function hasLoadedSurfaceNeighbor(bot, candidate, minY, maxY, movements) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const neighbor = findLoadedSurfaceCandidate(bot, candidate.x + dx, candidate.z + dz, minY, maxY, movements);
        if (neighbor && Math.abs(neighbor.y - candidate.y) <= SURFACE_CONNECTED_STEP_HEIGHT) return true;
    }
    return false;
}

function isAtSurfaceCandidate(bot, candidate, minY, maxY, movements) {
    const position = bot.entity.position;
    if (Math.floor(position.x) !== candidate.x || Math.floor(position.z) !== candidate.z ||
        Math.abs(position.y - candidate.y) > SURFACE_ARRIVAL_Y_TOLERANCE) return false;
    const support = bot.blockAt(new Vec3(candidate.x, candidate.y - 1, candidate.z));
    if (!isFullCubeSurfaceSupport(support, movements)) return false;
    for (const y of [candidate.y, candidate.y + 1]) {
        const block = bot.blockAt(new Vec3(candidate.x, y, candidate.z));
        if (!isClearStandingSpace(block, movements)) return false;
    }
    return bot.entity.onGround === true && hasLoadedSurfaceNeighbor(bot, candidate, minY, maxY, movements);
}

function surfaceCandidateArrivalChecks(bot, candidate, minY, maxY, movements) {
    const position = bot.entity.position;
    const support = bot.blockAt(new Vec3(candidate.x, candidate.y - 1, candidate.z));
    const feet = bot.blockAt(new Vec3(candidate.x, candidate.y, candidate.z));
    const head = bot.blockAt(new Vec3(candidate.x, candidate.y + 1, candidate.z));
    return {
        candidate: { x: candidate.x, y: candidate.y, z: candidate.z },
        sameColumn: Math.floor(position.x) === candidate.x && Math.floor(position.z) === candidate.z,
        yWithinTolerance: Math.abs(position.y - candidate.y) <= SURFACE_ARRIVAL_Y_TOLERANCE,
        fullCubeSupport: isFullCubeSurfaceSupport(support, movements),
        clearFeetSpace: isClearStandingSpace(feet, movements),
        clearHeadSpace: isClearStandingSpace(head, movements),
        onGround: bot.entity.onGround === true,
        connectedLoadedNeighbor: hasLoadedSurfaceNeighbor(bot, candidate, minY, maxY, movements),
    };
}

export async function goToSurface(bot) {
    /**
     * Navigate to a loaded, safe surface within a bounded radius of the current position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true only after standing on a confirmed surface candidate.
     **/
    const context = getActionContext(bot);
    requireActiveTarget(bot);
    const { minY, height } = bot.game ?? {};
    if (!Number.isSafeInteger(minY) || !Number.isSafeInteger(height) || height <= 0) {
        return failSkill(bot, 'target_unknown', 'Cannot search for the surface: dimension height is unavailable.');
    }

    const position = bot.entity.position;
    const movements = new pf.Movements(bot);
    const centerX = Math.floor(position.x);
    const centerZ = Math.floor(position.z);
    const candidates = [];
    for (let dx = -SURFACE_SEARCH_RADIUS; dx <= SURFACE_SEARCH_RADIUS; dx++) {
        for (let dz = -SURFACE_SEARCH_RADIUS; dz <= SURFACE_SEARCH_RADIUS; dz++) {
            const candidate = findLoadedSurfaceCandidate(bot, centerX + dx, centerZ + dz, minY, minY + height, movements);
            if (candidate) candidates.push(candidate);
        }
    }
    if (candidates.length === 0) {
        return failSkill(bot, 'target_not_found', `No loaded safe surface candidate found within ${SURFACE_SEARCH_RADIUS} blocks.`);
    }

    const surfaceCandidates = candidates.filter(candidate => isConnectedSurfaceCandidate(candidate, candidates));
    if (surfaceCandidates.length === 0) {
        return failSkill(bot, 'target_not_found', `No connected loaded surface candidate found within ${SURFACE_SEARCH_RADIUS} blocks.`);
    }

    surfaceCandidates.sort((a, b) =>
        Math.hypot(a.x + 0.5 - position.x, a.y - position.y, a.z + 0.5 - position.z) -
        Math.hypot(b.x + 0.5 - position.x, b.y - position.y, b.z + 0.5 - position.z));
    requireActiveTarget(bot);
    const goal = new pf.goals.GoalCompositeAny(surfaceCandidates.map(candidate =>
        new pf.goals.GoalBlock(candidate.x, candidate.y, candidate.z)));
    let moved = false;
    let navigationFailure = null;
    try {
        moved = await goToGoal(bot, goal, movements);
        requireActiveTarget(bot);
        if (moved && bot.entity.onGround !== true && typeof bot.waitForTicks === 'function') {
            await bot.waitForTicks(SURFACE_SETTLE_TICKS);
            requireActiveTarget(bot);
        }
        if (moved && surfaceCandidates.some(candidate => isAtSurfaceCandidate(bot, candidate, minY, minY + height, movements))) {
            log(bot, `Reached a confirmed surface at ${bot.entity.position.floored()}.`);
            return true;
        }
    } catch (error) {
        if (isActionCancelled(bot, context)) return false;
        navigationFailure = String(error?.message ?? error);
    }
    const nearestCandidate = surfaceCandidates
        .map(candidate => ({
            distance: Math.hypot(candidate.x + 0.5 - bot.entity.position.x,
                candidate.y - bot.entity.position.y, candidate.z + 0.5 - bot.entity.position.z),
            checks: surfaceCandidateArrivalChecks(bot, candidate, minY, minY + height, movements),
        }))
        .sort((a, b) => a.distance - b.distance)[0] ?? null;
    const diagnostics = {
        moved, finalPosition: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
        onGround: bot.entity.onGround === true,
        safeCandidateCount: surfaceCandidates.length, nearestCandidate, navigationFailure,
    };
    return failSkill(bot, 'arrival_unconfirmed', `Surface navigation ended without confirmed arrival at a safe surface. Diagnostic: ${JSON.stringify(diagnostics)}`, { diagnostics });
}

export async function useToolOn(bot, toolName, targetName) {
    /**
     * Equip a tool and use it on the nearest target.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {string} targetName - entity type, block type, or "nothing" for no target
     * @returns {Promise<boolean>} true if action succeeded
     **/
    if (toolName !== 'hand' && !bot.inventory.slots.find(slot => slot && slot.name === toolName) && bot.game.gameMode !== 'creative') {
        return failSkill(bot, 'missing_item', `You do not have any ${toolName} to use.`, { itemName: toolName });
    }

    targetName = targetName.toLowerCase();
    if (targetName === 'nothing') {
        const equipped = await equip(bot, toolName);
        if (!equipped) {
            return false;
        }
        await bot.activateItem();
        log(bot, `Used ${toolName}.`);
    } else if (world.isEntityType(targetName)) {
        const entity = world.getNearestEntityWhere(bot, e => e.name === targetName, 64);
        if (!entity) {
            return failSkill(bot, 'target_not_found', `Could not find any ${targetName}.`);
        }
        if (!await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z)) return false;
        if (toolName === 'hand') {
            await bot.unequip('hand');
        }
        else {
            const equipped = await equip(bot, toolName);
            if (!equipped) return false;
        }
        await bot.useOn(entity);
        log(bot, `Used ${toolName} on ${targetName}.`);
    } else {
        let block = null;
        if (targetName === 'water' || targetName === 'lava') {
            // we want to get liquid source blocks, not flowing blocks
            // so search for blocks with metadata 0 (not flowing)
            let blocks = world.getNearestBlocksWhere(bot, block => block.name === targetName && block.metadata === 0, 64, 1);
            if (blocks.length === 0) {
                return failSkill(bot, 'target_not_found', `Could not find any source ${targetName}.`);
            }
            block = blocks[0];
        }
        else {
            block = world.getNearestBlock(bot, targetName, 64);
        }
        if (!block) {
            return failSkill(bot, 'target_not_found', `Could not find any ${targetName}.`);
        }
        return await useToolOnBlock(bot, toolName, block);
    }

    return true;
 }

 export async function useToolOnBlock(bot, toolName, block) {
    /**
     * Use a tool on a specific block.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {Block} block - the block reference to use the tool on.
     * @returns {Promise<boolean>} true if action succeeded
     */

    const distance = toolName === 'water_bucket' && block.name !== 'lava' ? 1.5 : 2;
    if (!await goToPosition(bot, block.position.x, block.position.y, block.position.z, distance)) return false;
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));

    // if block in view is closer than the target block, it is in our way. try to move closer
    const viewBlocked = () => {
        const blockInView = bot.blockAtCursor(5);
        const headPos = bot.entity.position.offset(0, bot.entity.height, 0);
        return blockInView && 
            !blockInView.position.equals(block.position) && 
            blockInView.position.distanceTo(headPos) < block.position.distanceTo(headPos);
    }
    const blockInView = bot.blockAtCursor(5);
    if (viewBlocked()) {
        log(bot, `Block ${blockInView.name} is in the way, moving closer...`);
        // choose random block next to target block, go to it
        const nearbyPos = block.position.offset(Math.random() * 2 - 1, 0, Math.random() * 2 - 1);
        if (!await goToPosition(bot, nearbyPos.x, nearbyPos.y, nearbyPos.z, 1)) return false;
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
        if (viewBlocked()) {
            const blockInView = bot.blockAtCursor(5);
            return failSkill(bot, 'blocked', `Block ${blockInView.name} is in the way, not using ${toolName}.`);
        }
    }

    const equipped = await equip(bot, toolName);

    if (!equipped) {
        return failSkill(bot, 'missing_item', `Could not equip ${toolName}.`, { itemName: toolName });
    }
    if (toolName.includes('bucket')) {
        const filledBucket = toolName === 'bucket'
            ? block.name === 'water' ? 'water_bucket' : block.name === 'lava' ? 'lava_bucket' : null
            : toolName === 'water_bucket' || toolName === 'lava_bucket' ? toolName : null;
        if (!filledBucket) {
            return failSkill(bot, 'invalid_target', `Cannot use ${toolName} on ${block.name} as a supported bucket interaction.`);
        }
        const inputBucket = toolName === 'bucket' ? 'bucket' : filledBucket;
        const outputBucket = toolName === 'bucket' ? filledBucket : 'bucket';
        const inventoryChange = trackBucketInventoryChange(bot, inputBucket, outputBucket);
        try {
            await bot.activateItem();
            if (!await inventoryChange.wait()) {
                return failSkill(bot, 'unconfirmed', `Could not confirm ${toolName} interaction with ${block.name}.`);
            }
            if (toolName === 'bucket') {
                const currentBlock = bot.blockAt(block.position);
                if (!['air', block.name].includes(currentBlock?.name)) {
                    return failSkill(bot, 'target_changed', `Bucket inventory changed, but target ${block.name} is now ${currentBlock?.name ?? 'unknown'}.`);
                }
            }
        } catch (err) {
            return failSkill(bot, 'action_error', `Failed to use ${toolName} on ${block.name}: ${err.message}.`);
        }
    }
    else {
        await bot.activateBlock(block);
    }
    log(bot, `Used ${toolName} on ${block.name}.`);
    return true;
 }

function selectFarmSoil(bot, { scope, searchRadius, radius, startPosition }) {
    if (scope === 'radius') {
        const soil = world.getNearestBlocks(bot, 'farmland', radius, FARM_SEARCH_LIMIT);
        if (soil.length === FARM_SEARCH_LIMIT) throw new Error('Farm search limit reached; reduce radius.');
        return soil;
    }
    let start;
    if (startPosition != null) {
        if (![startPosition.x, startPosition.y, startPosition.z].every(Number.isFinite)) {
            throw new Error('startPosition must contain finite x, y and z farmland coordinates.');
        }
        start = bot.blockAt(new Vec3(Math.floor(startPosition.x), Math.floor(startPosition.y), Math.floor(startPosition.z)));
        if (start?.name !== 'farmland') throw new Error('startPosition must point to farmland.');
    } else {
        start = world.getNearestBlock(bot, 'farmland', searchRadius);
        if (!start) return [];
    }
    const soil = [start];
    const visited = new Set([`${start.position.x},${start.position.z}`]);
    for (let index = 0; index < soil.length; index++) {
        for (const [dx, dz] of FARM_NEIGHBORS) {
            const position = soil[index].position.offset(dx, 0, dz);
            const key = `${position.x},${position.z}`;
            if (visited.has(key)) continue;
            visited.add(key);
            const neighbor = bot.blockAt(position);
            if (!neighbor) throw new Error('Farm boundary is not loaded; move closer and retry.');
            if (neighbor.name === 'farmland') soil.push(neighbor);
        }
    }
    return soil;
}

export async function useItem(bot, itemName, options = {}) {
    /**
     * Use a held item once: optional aim, equip, activate, hold, then always release.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to use.
     * @param {object} options, { hand: 'main'|'off', holdMs, position, entity }. position and entity are exclusive aims.
     * @returns {Promise<boolean>} true if the use input was sent and released; game effects are not verified.
     * @example
     * await skills.useItem(bot, "bow", { holdMs: 1200, entity: target });
     **/
    const { hand = 'main', holdMs = 0, position = null, entity = null } = options;
    let target = null;
    if (entity) {
        target = bot.entities?.[entity.id];
        if (!target) return failSkill(bot, 'target_not_found', `Entity ${entity.id} is no longer observed.`, { entityId: entity.id });
    }
    if (hand === 'off') {
        const item = bot.inventory.findInventoryItem(itemName);
        if (!item) return failSkill(bot, 'missing_item', `You do not have any ${itemName} to use.`, { itemName });
        await bot.equip(item, 'off-hand');
    } else if (!await equip(bot, itemName)) return false;
    if (target) await bot.lookAt(target.position.offset(0, (target.height ?? 0) / 2, 0), true);
    else if (position) await bot.lookAt(new Vec3(position.x, position.y, position.z), true);
    const startedAt = Date.now();
    let held = true;
    try {
        await bot.activateItem(hand === 'off');
        if (holdMs > 0) held = await waitForActionOrTimeout(bot, getActionContext(bot), holdMs);
    } finally {
        // Release on completion, failure and cancellation so no use state outlives this call.
        if (bot.usingHeldItem) bot.deactivateItem();
    }
    const detail = { itemName, hand, heldMs: Date.now() - startedAt, released: bot.usingHeldItem !== true, effect: 'not_observed' };
    if (!held) return skillFailure('cancelled', `Use of ${itemName} was interrupted and released.`, detail);
    log(bot, `Used ${itemName}.`);
    reportSkillOutcome({ ok: true, status: 'complete', ...detail });
    return true;
}

export async function useToolOnBlockAt(bot, toolName, position) {
    const targetPosition = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
    const observed = bot.blockAt(targetPosition);
    if (!observed) return failSkill(bot, 'target_unknown', `Block observation at ${targetPosition} is unknown.`);
    const expectedName = observed.name;
    if (!await goToPosition(bot, targetPosition.x, targetPosition.y, targetPosition.z,
        toolName === 'water_bucket' && expectedName !== 'lava' ? 1.5 : 2)) return false;
    if (bot.interrupt_code) return false;
    const current = bot.blockAt(targetPosition);
    if (!current || current.name !== expectedName) return failSkill(bot, 'target_changed', `Block at ${targetPosition} changed during approach.`);
    return useToolOnBlock(bot, toolName, current);
}

export async function tendNearbyFarm(bot, options = {}) {
    /**
     * Tend the nearest connected farmland plot by default: harvest mature crops, replant empty soil, and store produce in a chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {object} options, optional farm settings (use an object, not positional arguments).
     * @param {string} options.scope, 'connected' (default) or 'radius'. Connected means same-height farmland sharing an edge; water and diagonal contact do not connect plots.
     * @param {number} options.searchRadius, distance to search for the starting farmland in connected mode, default 32. Does not limit the selected plot's size.
     * @param {{x: number, y: number, z: number}} options.startPosition, optional farmland coordinates selecting the connected plot instead of searching.
     * @param {number} options.radius, working radius in radius mode only, default 32.
     * @param {number} options.seedReserve, number of each planting item to keep in inventory, default 1.
     * @param {{x: number, y: number, z: number}} options.chestPosition, optional exact chest coordinates. Legacy bot-first calls select a nearby chest when omitted; the native facade privately opts to keep harvested items in inventory.
     * @returns {Promise<object>} confirmed harvested, planted and stored counts. Unavailable seeds or unreachable crops can leave work unfinished; inspect counts and logs. An unloaded plot boundary throws before tending.
     * @example
     * await skills.tendNearbyFarm(bot);
     * await skills.tendNearbyFarm(bot, { startPosition: { x: 10, y: 64, z: -4 }, seedReserve: 1 });
     * await skills.tendNearbyFarm(bot, { scope: 'radius', radius: 32 });
     **/
    if (options == null || typeof options !== 'object' || Array.isArray(options)) {
        throw new Error('tendNearbyFarm expects an options object.');
    }
    const { scope = 'connected', searchRadius = FARM_SEARCH_RADIUS, radius = FARM_SEARCH_RADIUS,
        seedReserve = FARM_SEED_RESERVE, chestPosition = null, startPosition = null } = options;
    if (!['connected', 'radius'].includes(scope)) throw new Error('Unknown farm scope.');
    if (scope === 'connected' && options.radius != null) throw new Error('radius requires scope: radius; use searchRadius to find a connected plot.');
    if (scope === 'radius' && (options.searchRadius != null || startPosition != null)) throw new Error('searchRadius and startPosition require scope: connected.');
    if (![searchRadius, radius].every(value => Number.isFinite(value) && value > 0) || !Number.isInteger(seedReserve) || seedReserve < 0) {
        throw new Error('Farm distances must be positive and seedReserve must be a nonnegative integer.');
    }
    const crops = CROPS;
    const soil = selectFarmSoil(bot, { scope, searchRadius, radius, startPosition });
    const cropPositions = soil.map(block => bot.blockAt(block.position.offset(0, 1, 0)))
        .filter(block => block && crops[block.name])
        .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
    const workInitiallyPresent = cropPositions.some(block => {
        const crop = crops[block.name], age = block.getProperties?.().age;
        return crop && age != null && Number(age) >= crop.mature;
    }) || soil.some(block => bot.blockAt(block.position.offset(0, 1, 0))?.name === 'air');
    const harvestedItems = new Set();
    let harvested = 0;

    for (const cropBlock of cropPositions) {
        const crop = crops[cropBlock.name];
        const age = cropBlock.getProperties?.().age;
        if (!crop || age == null || Number(age) < crop.mature) continue;
        if (!cropBlock.diggable) continue;
        if (bot.interrupt_code) break;
        if (bot.entity.position.distanceTo(cropBlock.position) > 2 &&
            !await goToPosition(bot, cropBlock.position.x, cropBlock.position.y, cropBlock.position.z, 2)) {
            log(bot, `Could not reach crop at ${cropBlock.position}.`);
            continue;
        }
        const current = bot.blockAt(cropBlock.position);
        const currentAge = current?.getProperties?.().age;
        if (current?.name !== cropBlock.name || currentAge == null || Number(currentAge) < crop.mature || bot.interrupt_code) continue;
        const expectedDropIds = itemIdsForNames(bot, [...crop.produce, crop.seed]);
        const collectionTracker = trackBlockCollection(bot, current, expectedDropIds);
        try {
            await trackNavigationSegment(bot, () => bot.dig(current), { workTarget: current.position });
            if (await collectionTracker.wait(HARVEST_CONFIRM_TIMEOUT_MS)) {
                for (const item of crop.produce) harvestedItems.add(item);
                harvestedItems.add(crop.seed);
                harvested++;
            } else {
                log(bot, `Could not confirm harvest of ${cropBlock.name}; crop items were not marked for storage.`);
            }
        } finally {
            collectionTracker.cleanup();
        }
        if (bot.interrupt_code) break;
    }

    const farmland = soil
        .filter(block => bot.blockAt(block.position)?.name === 'farmland' && bot.blockAt(block.position.offset(0, 1, 0))?.name === 'air')
        .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
    let planted = 0;
    const seedItems = new Set(Object.values(crops).map(crop => crop.seed));
    for (const seed of seedItems) {
        const stacks = bot.inventory.items().filter(item => item.name === seed);
        let available = stacks.reduce((total, item) => total + item.count, 0) - seedReserve;
        while (available > 0 && farmland.length > 0 && !bot.interrupt_code) {
            const soil = farmland.shift();
            const ok = await tillAndSow(bot, soil.position.x, soil.position.y, soil.position.z, seed);
            if (ok) {
                planted++;
                available--;
            }
        }
    }

    let stored = 0;
    let storageStatus = 'not_needed';
    const deposits = [...harvestedItems].map(itemName => {
        const stacks = bot.inventory.items().filter(candidate => candidate.name === itemName);
        const itemCount = stacks.reduce((total, item) => total + item.count, 0);
        const reserve = seedItems.has(itemName) ? seedReserve : 0;
        return { itemName, item: stacks[0], count: Math.max(0, itemCount - reserve) };
    }).filter(deposit => deposit.item && deposit.count > 0);
    const hasChestResolver = typeof options.resolveChestPosition === 'function';
    // Preserve the legacy bot-first default; the native public adapter explicitly
    // sets this private flag when its caller omits chestPosition.
    const selectLegacyNearbyChest = chestPosition == null && !hasChestResolver && options.keepHarvestInInventory !== true;
    if (deposits.length > 0 && !bot.interrupt_code && (chestPosition != null || hasChestResolver || selectLegacyNearbyChest)) {
        let chest;
        let chestTargetBlock = null;
        let chestTargetReachable = true;
        let resolvedChestPosition = chestPosition;
        if (hasChestResolver) {
            const resolved = await options.resolveChestPosition();
            resolvedChestPosition = resolved?.position ?? null;
            storageStatus = resolvedChestPosition ? 'target_resolved' : (resolved?.status ?? 'target_unavailable');
        } else if (selectLegacyNearbyChest) {
            chest = world.getNearestBlock(bot, 'chest', FARM_CHEST_RADIUS);
            storageStatus = chest ? 'legacy_nearest_selected' : 'no_chest';
        }
        if (resolvedChestPosition && [resolvedChestPosition.x, resolvedChestPosition.y, resolvedChestPosition.z].every(Number.isFinite)) {
            const target = new Vec3(Math.floor(resolvedChestPosition.x), Math.floor(resolvedChestPosition.y), Math.floor(resolvedChestPosition.z));
            chestTargetBlock = bot.blockAt(target);
            if (!chestTargetBlock) {
                chestTargetReachable = await goToPosition(bot, target.x, target.y, target.z, 2);
                if (chestTargetReachable) chestTargetBlock = bot.blockAt(target);
            }
            chest = chestTargetBlock;
        }
        if (!chest || !['chest', 'trapped_chest'].includes(chest.name)) {
            if (storageStatus === 'target_resolved') storageStatus = !chestTargetReachable ? 'unreachable' : chestTargetBlock ? 'target_missing' : 'target_unloaded';
            else if (resolvedChestPosition == null) storageStatus = 'target_unavailable';
            if (chestTargetBlock && typeof options.onChestBlock === 'function') {
                await options.onChestBlock({ position: resolvedChestPosition, block: chestTargetBlock });
            }
            log(bot, storageStatus === 'no_chest' ? 'Could not find a nearby chest; harvested items remain in inventory.' : 'The selected chest is unavailable; harvested items remain in inventory.');
        } else if (await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2)) {
            const mustRecheckChest = resolvedChestPosition != null || typeof options.beforeFarmDeposit === 'function';
            const currentChest = mustRecheckChest ? bot.blockAt(chest.position) : chest;
            if (currentChest && typeof options.onChestBlock === 'function') {
                await options.onChestBlock({
                    position: { x: chest.position.x, y: chest.position.y, z: chest.position.z }, block: currentChest
                });
            }
            const stillAllowed = typeof options.beforeFarmDeposit !== 'function' || await options.beforeFarmDeposit({
                position: { x: chest.position.x, y: chest.position.y, z: chest.position.z }
            });
            if (!stillAllowed) {
                storageStatus = 'relation_changed';
                log(bot, 'Farm storage relation changed before deposit; harvested items remain in inventory.');
            } else if (!currentChest || !['chest', 'trapped_chest'].includes(currentChest.name)) {
                storageStatus = currentChest ? 'target_missing' : 'target_unloaded';
                log(bot, currentChest ? 'The requested chest is missing; harvested items remain in inventory.' : 'The requested chest is no longer loaded; harvested items remain in inventory.');
            } else {
                let depositFailed = false;
                for (const deposit of deposits) {
                    const operation = operationContext();
                    const factStart = operation?.facts.length ?? 0;
                    try {
                        const transferred = await putInChest(bot, deposit.itemName, deposit.count, {
                            chestPosition: { x: currentChest.position.x, y: currentChest.position.y, z: currentChest.position.z }
                        });
                        const confirmed = operation?.facts.slice(factStart).filter(fact => fact.phase === 'chest-deposit' && fact.target?.itemName === deposit.itemName)
                            .reduce((sum, fact) => sum + fact.quantity, 0) ?? (transferred ? deposit.count : 0);
                        stored += confirmed;
                        if (!transferred) { depositFailed = true; break; }
                    } catch (error) {
                        const confirmed = operation?.facts.slice(factStart).filter(fact => fact.phase === 'chest-deposit' && fact.target?.itemName === deposit.itemName)
                            .reduce((sum, fact) => sum + fact.quantity, 0) ?? 0;
                        stored += confirmed;
                        depositFailed = true;
                        log(bot, `Farm storage failed after confirmed stored count ${stored}: ${error.message}`);
                        break;
                    }
                }
                storageStatus = depositFailed ? (stored > 0 ? 'partial_storage_failed' : 'storage_failed') : 'stored';
            }
        } else {
            storageStatus = 'unreachable';
        }
    }
    const remainingMature = cropPositions.filter(original => {
        const current = bot.blockAt(original.position);
        const crop = current && crops[current.name];
        const age = current?.getProperties?.().age;
        return crop && age != null && Number(age) >= crop.mature;
    }).length;
    const remainingPlantable = soil.filter(block => bot.blockAt(block.position)?.name === 'farmland' &&
        bot.blockAt(block.position.offset(0, 1, 0))?.name === 'air').length;
    const remainingWork = { matureCrops: remainingMature, emptySoil: remainingPlantable };
    const seedAvailable = [...seedItems].some(seed => bot.inventory.items().filter(item => item.name === seed).reduce((n, item) => n + item.count, 0) > seedReserve);
    const storageIncomplete = storageStatus !== 'not_needed' && storageStatus !== 'stored' && deposits.length > 0;
    const status = storageIncomplete || remainingMature > 0 || remainingPlantable > 0 ? 'partial' : !workInitiallyPresent ? 'no_work' : 'complete';
    const reason = storageIncomplete ? `storage_${storageStatus}`
        : remainingMature > 0 ? 'mature_crops_remain'
            : remainingPlantable > 0 && !seedAvailable ? 'seed_shortage'
                : remainingPlantable > 0 ? 'empty_soil_remains' : undefined;
    const result = { ok: status === 'complete' || status === 'no_work', status, harvested, planted, stored, remainingWork,
        ...(reason ? { reason } : {}) };
    if (options.includeStorageStatus === true) result.storageStatus = storageStatus;
    log(bot, `Farm cycle complete: ${JSON.stringify(result)}. Call skills.tendNearbyFarm again to repeat.`);
    return result;
}

const TREE_SEARCH_RADIUS = 24;
const TREE_MAX_HEIGHT = 24;
const TREE_MAX_RADIUS = 6;
const TREE_MAX_LOGS = 192;
const TREE_REACH = 4.5;
const TREE_PHYSICS_TIMEOUT_MS = 5000;
const TREE_PILLAR_PACKET_DELAY_MS = 50;
const TREE_PICKUP_TIMEOUT_MS = 30000;
const TREE_SOILS = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mud', 'moss_block']);
const TREE_LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log'];
const TREE_SCAFFOLD_ITEMS = ['dirt', 'cobblestone'];
const treePositionKey = p => `${p.x},${p.y},${p.z}`;
const treeAir = b => b && ['air', 'cave_air', 'void_air'].includes(b.name);

function inspectFellingTree(bot, root) {
    const first = bot.blockAt(root);
    if (!first || !TREE_LOGS.includes(first.name)) throw new Error('Select a loaded, unstripped overworld tree log.');
    const logName = first.name;
    // A supplied trunk block may be above its base.
    while (bot.blockAt(root.offset(0, -1, 0))?.name === logName) {
        root = root.offset(0, -1, 0);
        if (first.position.y - root.y >= TREE_MAX_HEIGHT) throw new Error('Trunk exceeds the tree height limit.');
    }
    const soil = bot.blockAt(root.offset(0, -1, 0));
    if (!soil || !TREE_SOILS.has(soil.name)) throw new Error('Tree base must be observed on natural soil.');
    const logs = [root];
    const seen = new Set([treePositionKey(root)]);
    let naturalLeaves = false;
    const leafName = logName.replace('_log', '_leaves');
    for (let index = 0; index < logs.length; index++) {
        const p = logs[index];
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            const neighbor = p.offset(dx, dy, dz);
            const block = bot.blockAt(neighbor);
            if (!block) throw new Error('Tree boundary is not loaded; move closer and retry.');
            if (block.name === leafName && [false, 'false'].includes(block.getProperties?.().persistent)) naturalLeaves = true;
            if (block.name !== logName || seen.has(treePositionKey(neighbor))) continue;
            if (Math.abs(neighbor.x - root.x) > TREE_MAX_RADIUS || Math.abs(neighbor.z - root.z) > TREE_MAX_RADIUS ||
                neighbor.y < root.y || neighbor.y - root.y >= TREE_MAX_HEIGHT || logs.length >= TREE_MAX_LOGS) {
                throw new Error('Connected logs exceed the single-tree limits.');
            }
            const below = bot.blockAt(neighbor.offset(0, -1, 0));
            if (!below) throw new Error('Tree base boundary is not loaded.');
            if ((neighbor.x !== root.x || neighbor.z !== root.z) && TREE_SOILS.has(below.name)) {
                throw new Error('Connected logs have multiple grounded trunks; one tree cannot be distinguished.');
            }
            seen.add(treePositionKey(neighbor));
            logs.push(neighbor);
        }
    }
    if (!naturalLeaves || logs.length < 2) throw new Error('No natural tree canopy was confirmed.');
    return { root, logName, leafName, logs };
}

export async function fellTree(bot, options = {}) {
    /**
     * Fell exactly one natural single-trunk tree, including tall branched oak, collect its logs, and remove/recover this call's temporary dirt/cobblestone pillars before returning to ground. 木一本の伐採と足場の片づけ。
     * @param {MinecraftBot} bot - Pass bot first.
     * @param {object} options - Optional settings; use an object, not positional coordinates.
     * @param {{x:number,y:number,z:number}} options.startPosition - Any log in the selected trunk; otherwise finds the nearest natural tree within searchRadius.
     * @param {number} options.searchRadius - Positive search radius, default 24, maximum 64.
     * @returns {Promise<object>} status complete/partial/cancelled/blocked/not_found, tree, logsBroken/logsCollected, scaffoldPlaced/scaffoldRemoved/scaffoldRecovered, remainingLogs, leftoverScaffolds, grounded, cleanupRequired and reason. Complete requires server-observed removal, this bot's drop pickups and ground return. Bring an axe, free inventory space and enough dirt/cobblestone for the height. Rejects connected multiple trunks (including 2x2 trees), unloaded boundaries and logs without natural leaves. Clears only obstructing natural leaves; remaining leaves decay normally. Stop does not initiate cleanup mutations; use returned leftoverScaffolds to recover after cancellation.
     * @example
     * log(bot, JSON.stringify(await skills.fellTree(bot)));
     * log(bot, JSON.stringify(await skills.fellTree(bot, { startPosition: { x: 10, y: 64, z: -4 } })));
     **/
    if (!bot?.entity?.position || typeof bot.blockAt !== 'function' || options == null ||
        typeof options !== 'object' || Array.isArray(options)) throw new TypeError('skills.fellTree(bot, options = {}): pass bot first and an options object.');
    const { startPosition = null, searchRadius = TREE_SEARCH_RADIUS } = options;
    if (!Number.isFinite(searchRadius) || searchRadius <= 0 || searchRadius > 64 ||
        (startPosition != null && ![startPosition.x, startPosition.y, startPosition.z].every(Number.isFinite))) {
        throw new TypeError('fellTree needs finite startPosition coordinates and searchRadius in (0, 64].');
    }
    const context = getActionContext(bot);
    const cancelled = () => isActionCancelled(bot, context);
    const active = () => { if (cancelled()) throw new Error('Tree felling cancelled.'); };
    const result = { status: 'blocked', tree: null, logsBroken: 0, logsCollected: 0,
        scaffoldPlaced: 0, scaffoldRemoved: 0, scaffoldRecovered: 0,
        remainingLogs: [], leftoverScaffolds: [], grounded: false, cleanupRequired: false, reason: null };
    let tree;
    try {
        active();
        if (startPosition) tree = inspectFellingTree(bot, new Vec3(startPosition.x, startPosition.y, startPosition.z).floored());
        else {
            const candidates = world.getNearestBlocksWhere(bot, b => TREE_LOGS.includes(b.name), searchRadius, 128);
            let lastReason = null;
            for (const candidate of candidates) {
                try { tree = inspectFellingTree(bot, candidate.position); break; }
                catch (error) { lastReason = String(error.message); }
            }
            if (!tree) { result.status = 'not_found'; result.reason = lastReason || 'No nearby natural tree logs.'; }
        }
    } catch (error) { result.reason = String(error.message); }
    if (!tree) {
        if (cancelled()) result.status = 'cancelled';
        log(bot, JSON.stringify(result));
        return result;
    }
    result.tree = { root: { ...tree.root }, logName: tree.logName, logCount: tree.logs.length };
    const remaining = () => tree.logs.filter(p => {
        const block = bot.blockAt(p);
        return !treeAir(block) && !scaffolds.some(entry => !entry.removed &&
            treePositionKey(entry.position) === treePositionKey(p) && block?.name === entry.name);
    });
    const originalMovements = bot.pathfinder.movements;
    const movements = new pf.Movements(bot);
    movements.canDig = false;
    movements.canPlaceOn = false;
    movements.scafoldingBlocks = []; // Pathfinder bridges also consume these items.
    movements.allow1by1towers = false;
    movements.allowParkour = false;
    movements.allowFreeMotion = false;
    const scaffolds = [];
    const broken = [];
    const drops = new Map();
    let column = null;
    let leavesCleared = 0;
    const isNaturalLeaf = block => block?.name === tree.leafName &&
        [false, 'false'].includes(block.getProperties?.().persistent) &&
        Math.abs(block.position.x - tree.root.x) <= TREE_MAX_RADIUS &&
        Math.abs(block.position.z - tree.root.z) <= TREE_MAX_RADIUS &&
        block.position.y >= tree.root.y && block.position.y <= tree.root.y + TREE_MAX_HEIGHT;
    const eye = () => bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
    const interaction = p => resolveBlockInteraction(bot, bot.blockAt(p), { reach: TREE_REACH });
    const reachable = p => interaction(p).status === 'ready';
    const nearby = p => {
        // Logs and leaves occupy a full cube. Use its nearest surface for the
        // range prefilter, so distant work does not trigger needless leaf digs.
        const origin = eye();
        const nearest = new Vec3(...['x', 'y', 'z'].map(axis => Math.max(p[axis], Math.min(origin[axis], p[axis] + 1))));
        return origin.distanceTo(nearest) <= TREE_REACH;
    };
    const onDrop = entity => {
        const item = entity.getDroppedItem?.();
        if (!item || drops.has(entity.id)) return;
        const source = broken.find(entry => entry.name === item.name && entity.position.distanceTo(entry.position.offset(0.5, 0.5, 0.5)) <= 1);
        if (source) drops.set(entity.id, { entity, count: item.count, kind: source.kind, collected: false });
    };
    const pendingWork = () => [...remaining(), ...[...drops.values()]
        .filter(drop => !drop.collected && bot.entities[drop.entity.id] && drop.entity.position.y > tree.root.y + 2)
        .map(drop => drop.entity.position.floored())];
    const onCollect = (collector, entity) => {
        if (collector.id !== bot.entity.id) return;
        const drop = drops.get(entity.id);
        if (drop && !drop.collected) {
            drop.collected = true;
            // Item entities may merge after itemDrop; use their current server metadata.
            const count = entity.getDroppedItem?.()?.count ?? drop.count;
            if (drop.kind === 'log') result.logsCollected += count;
            else result.scaffoldRecovered += count;
        }
    };
    const waitState = async predicate => {
        const deadline = Date.now() + TREE_PHYSICS_TIMEOUT_MS;
        while (!predicate()) {
            active();
            if (Date.now() >= deadline) throw new Error('Tree movement/block confirmation timed out.');
            await waitForActionOrTimeout(bot, context, 25);
        }
        active();
    };
    const navigate = async p => {
        active();
        const goal = new pf.goals.GoalBlock(p.x, p.y, p.z);
        if (!await goToGoal(bot, goal, movements)) throw new Error(`Cannot reach tree work position ${p}.`);
        active();
    };
    const dig = async (p, name, kind) => {
        active();
        let block = bot.blockAt(p);
        if (treeAir(block)) return false;
        if (block?.name !== name || !reachable(p) || !bot.canDigBlock(block)) throw new Error(`Cannot safely dig expected ${name} at ${p}.`);
        await bot.tool.equipForBlock(block);
        active();
        block = bot.blockAt(p);
        if (block?.name !== name) throw new Error(`Tree target changed at ${p}.`);
        const entry = { position: p, name, kind };
        if (kind !== 'leaf') broken.push(entry);
        try {
            await trackNavigationSegment(bot, () => bot.dig(block, true), { workTarget: block.position });
            await waitState(() => treeAir(bot.blockAt(p)));
        } finally {
            // Cancellation can arrive after the server removed the block.
            // Preserve that observation without starting another mutation.
            if (treeAir(bot.blockAt(p))) {
                if (kind === 'log') result.logsBroken++;
                if (kind === 'scaffold') result.scaffoldRemoved++;
                recordConfirmation({ phase: kind === 'scaffold' ? 'cleanup' : 'felling', quantity: 1, unit: 'block',
                    target: { name, position: { ...p } }, evidence: 'loaded server block state became air' });
            }
        }
        return true;
    };
    // Only discover an obstruction after surface targeting failed. The center ray
    // is a discovery hint, never a visibility requirement for digging.
    const clearRay = async (p, seen = new Set()) => {
        if (reachable(p) || !nearby(p)) return false;
        const key = treePositionKey(p);
        if (seen.has(key) || seen.size >= TREE_MAX_HEIGHT) return false;
        seen.add(key);
        const center = p.offset(0.5, 0.5, 0.5);
        const origin = eye();
        const delta = center.minus(origin);
        if (delta.norm() === 0) return false;
        const hit = bot.world.raycast(origin, delta.scaled(1 / delta.norm()), delta.norm());
        if (!hit || treePositionKey(hit.position) === key) return false;
        const block = bot.blockAt(hit.position);
        const ownLog = block?.name === tree.logName && tree.logs.some(log => treePositionKey(log) === treePositionKey(hit.position));
        if (!ownLog && !isNaturalLeaf(block)) return false;
        if (!reachable(hit.position)) return await clearRay(hit.position, seen);
        if (ownLog) return await dig(hit.position, tree.logName, 'log');
        if (leavesCleared >= TREE_MAX_LOGS * 2) return false;
        await dig(hit.position, block.name, 'leaf');
        leavesCleared++;
        return true;
    };
    const harvestReachable = async () => {
        let progress;
        do {
            progress = false;
            for (const p of remaining().sort((a, b) => a.y - b.y)) {
                active();
                if (bot.blockAt(p)?.name !== tree.logName) throw new Error(`Selected log changed at ${p}.`);
                if (!reachable(p)) {
                    if (await clearRay(p)) { progress = true; break; }
                    continue;
                }
                if (await dig(p, tree.logName, 'log')) progress = true;
            }
        } while (progress);
    };
    const approachInitialWork = async () => {
        // Try actual work first. Navigation is only needed while the ground-level
        // trunk remains; higher logs are reached later with recorded pillars.
        const attempts = new Set();
        const failures = [];
        const approach = async (p, depth = 0) => {
            active();
            const block = bot.blockAt(p);
            const ownLog = block?.name === tree.logName && tree.logs.some(log => treePositionKey(log) === treePositionKey(p));
            if (!ownLog && !isNaturalLeaf(block)) return false;
            const key = `${block.name}:${treePositionKey(p)}`;
            if (attempts.has(key) || attempts.size >= TREE_MAX_HEIGHT || depth >= TREE_MAX_HEIGHT) return false;
            attempts.add(key);
            if (!reachable(p)) {
                try {
                    await goToGoal(bot, makeBlockInteractionGoal(bot, p, { reach: TREE_REACH }), movements);
                    active();
                } catch (error) {
                    active();
                    failures.push(`interaction ${p}: ${error.message}`);
                }
            }
            if (reachable(p)) {
                if (ownLog) return await dig(p, tree.logName, 'log');
                if (leavesCleared >= TREE_MAX_LOGS * 2) return false;
                await dig(p, tree.leafName, 'leaf');
                leavesCleared++;
                return true;
            }
            const delta = p.offset(0.5, 0.5, 0.5).minus(eye());
            const hit = delta.norm() && bot.world.raycast(eye(), delta.scaled(1 / delta.norm()), delta.norm());
            const obstruction = hit && treePositionKey(hit.position) !== treePositionKey(p) ? hit.position : null;
            failures.push(`target ${p}: ${interaction(p).reason || 'No sampled surface aim'}${obstruction ? `; observed ray obstruction ${obstruction}` : ''}`);
            // A failed route does not prove which block blocked the route. Only
            // the observed ray may nominate an owned log or in-scope natural leaf.
            return obstruction ? await approach(obstruction, depth + 1) : false;
        };
        while (remaining().some(p => p.y <= tree.root.y + 1)) {
            let progress = false;
            for (const p of remaining().filter(p => p.y <= tree.root.y + 1).sort((a, b) => a.y - b.y)) {
                if (await approach(p)) { progress = true; break; }
            }
            if (!progress) throw new Error(`Cannot approach selected tree work; ${failures.join('; ') || 'No permitted interaction candidate remains.'}`);
            // Every retry follows a confirmed owned removal; never retry an
            // identical route against the same world state.
            attempts.clear();
            await harvestReachable();
        }
    };
    const clearColumnCell = async p => {
        while (await clearRay(p)) { active(); }
        const block = bot.blockAt(p);
        if (treeAir(block)) return;
        if (isNaturalLeaf(block) && leavesCleared < TREE_MAX_LOGS * 2) {
            await dig(p, block.name, 'leaf'); leavesCleared++;
        } else if (block?.name === tree.logName && tree.logs.some(log => treePositionKey(log) === treePositionKey(p))) {
            await dig(p, tree.logName, 'log');
        } else throw new Error(`Unowned obstruction in tree pillar at ${p}.`);
    };
    const settleDrop = async drop => {
        let previous = drop.entity.position.clone();
        let stableSince = Date.now();
        const deadline = Date.now() + TREE_PHYSICS_TIMEOUT_MS;
        while (!drop.collected && bot.entities[drop.entity.id]) {
            active();
            await waitForActionOrTimeout(bot, context, 100);
            const current = drop.entity.position;
            if (current.distanceTo(previous) > 0.05) stableSince = Date.now();
            else if (Date.now() - stableSince >= 300) return;
            if (Date.now() >= deadline) return;
            previous = current.clone();
        }
    };
    const releaseCanopyDrops = async () => {
        // Branch drops can rest on leaves. Release them while we still have
        // height access, rather than dismantling the pillar and losing reach.
        for (const drop of drops.values()) {
            if (drop.collected || !bot.entities[drop.entity.id]) continue;
            await settleDrop(drop);
            while (!drop.collected && bot.entities[drop.entity.id]) {
                active();
                const supportPosition = drop.entity.position.offset(0, -0.1, 0).floored();
                const support = bot.blockAt(supportPosition);
                if (!isNaturalLeaf(support) || leavesCleared >= TREE_MAX_LOGS * 2) break;
                while (await clearRay(supportPosition)) { active(); }
                if (!reachable(supportPosition)) break;
                await dig(supportPosition, tree.leafName, 'leaf');
                leavesCleared++;
                await settleDrop(drop);
            }
        }
    };
    const descend = async () => {
        if (!column) return;
        await withSkillPhase('cleanup', async () => {
            for (const entry of [...scaffolds].reverse()) {
                if (entry.removed) continue;
                active();
                if (Math.abs(bot.entity.position.x - entry.position.x - 0.5) > 0.4 ||
                    Math.abs(bot.entity.position.z - entry.position.z - 0.5) > 0.4) throw new Error('Bot left its owned pillar; cleanup requires a new safe approach.');
                if (await dig(entry.position, entry.name, 'scaffold')) entry.removed = true;
                else entry.removed = treeAir(bot.blockAt(entry.position));
                await waitState(() => bot.entity.onGround && bot.entity.position.y <= entry.position.y + 0.1);
            }
        });
        column = null;
    };
    bot.on('itemDrop', onDrop);
    bot.on('playerCollect', onCollect);
    try {
        const requiredHeight = Math.max(...tree.logs.map(p => p.y)) - tree.root.y;
        const available = TREE_SCAFFOLD_ITEMS.reduce((sum, name) => sum + inventoryItemCount(bot, name), 0);
        if (requiredHeight > 4 && available < requiredHeight) throw new Error(`Bring at least ${requiredHeight} dirt/cobblestone blocks for this tree (have ${available}).`);
        if (bot.inventory.emptySlotCount() < 2) throw new Error('Need two free inventory slots for logs and recovered materials.');
        await harvestReachable();
        await approachInitialWork();
        await harvestReachable();
        await releaseCanopyDrops();
        const attemptedColumns = new Set();
        while (pendingWork().length) {
            const target = pendingWork().sort((a, b) => a.y - b.y)[0];
            let base = tree.root;
            if (attemptedColumns.has(`${base.x},${base.z}`)) base = new Vec3(target.x, tree.root.y, target.z);
            if (attemptedColumns.has(`${base.x},${base.z}`)) throw new Error('Remaining branches or canopy drops are unreachable from the selected pillars.');
            attemptedColumns.add(`${base.x},${base.z}`);
            if (!TREE_SOILS.has(bot.blockAt(base.offset(0, -1, 0))?.name)) throw new Error('Branch pillar has no same-level natural ground.');
            // The base must already be clear; approach from the ground without auto-digging.
            await clearColumnCell(base);
            await clearColumnCell(base.offset(0, 1, 0));
            await navigate(base);
            column = base;
            const topY = Math.max(...pendingWork().map(p => p.y));
            while (pendingWork().length && bot.entity.position.y < topY) {
                await harvestReachable();
                if (!remaining().length) await releaseCanopyDrops();
                if (!pendingWork().length) break;
                const feet = new Vec3(base.x, Math.round(bot.entity.position.y), base.z);
                await clearColumnCell(feet.offset(0, 1, 0));
                await clearColumnCell(feet.offset(0, 2, 0));
                if (!treeAir(bot.blockAt(feet))) throw new Error('Pillar placement target is no longer air.');
                const item = bot.inventory.items().find(stack => TREE_SCAFFOLD_ITEMS.includes(stack.name));
                if (!item) throw new Error('Ran out of recoverable pillar material.');
                const support = bot.blockAt(feet.offset(0, -1, 0));
                if (support?.boundingBox !== 'block') throw new Error('Pillar support is not a full block.');
                active();
                await bot.equip(item, 'hand');
                active();
                // Finish turning before jumping: a gradual turn during placeBlock
                // can otherwise consume the brief window above the target's hitbox.
                await bot.lookAt(support.position.offset(0.5, 1, 0.5));
                active();
                const entry = { position: feet, name: item.name, removed: false };
                // Track even ambiguous placement so an error cannot silently abandon a placed block.
                scaffolds.push(entry);
                bot.setControlState('jump', true);
                try {
                    await waitState(() => bot.entity.position.y >= feet.y + NAVIGATION_SCAFFOLD_CLEARANCE_HEIGHT);
                    await waitForActionOrTimeout(bot, context, TREE_PILLAR_PACKET_DELAY_MS);
                    active();
                    await bot.placeBlock(support, new Vec3(0, 1, 0));
                    await waitState(() => bot.blockAt(feet)?.name === item.name);
                } finally {
                    bot.setControlState('jump', false);
                    if (bot.blockAt(feet)?.name === item.name) {
                        result.scaffoldPlaced++;
                        recordConfirmation({ phase: 'pillar', quantity: 1, unit: 'block', target: { name: item.name, position: { ...feet } }, evidence: 'loaded server block state matches placed pillar' });
                    } else if (treeAir(bot.blockAt(feet))) scaffolds.pop();
                }
                await waitState(() => bot.entity.onGround && Math.abs(bot.entity.position.y - feet.y - 1) < 0.1);
            }
            await harvestReachable();
            await releaseCanopyDrops();
            await descend();
        }
    } catch (error) {
        result.reason = String(error.message);
    } finally {
        bot.setControlState('jump', false);
        if (!cancelled()) {
            try { await releaseCanopyDrops(); }
            catch (error) { result.reason = [result.reason, `Canopy pickup: ${error.message}`].filter(Boolean).join('; '); }
        }
        if (!cancelled()) {
            try { await descend(); }
            catch (error) { result.reason = [result.reason, `Cleanup: ${error.message}`].filter(Boolean).join('; '); }
        }
        if (!cancelled() && !scaffolds.some(entry => !treeAir(bot.blockAt(entry.position)))) {
            try {
                // Collect only drops produced by our recorded digs; movement cannot make new terrain changes.
                const deadline = Date.now() + TREE_PICKUP_TIMEOUT_MS;
                await waitForActionOrTimeout(bot, context, 300);
                const pickupOrder = [...drops.values()].sort((a, b) =>
                    bot.entity.position.distanceTo(a.entity.position) - bot.entity.position.distanceTo(b.entity.position));
                for (const drop of pickupOrder) {
                    active();
                    if (result.logsCollected >= result.logsBroken && result.scaffoldRecovered >= result.scaffoldPlaced) break;
                    if (drop.collected || !bot.entities[drop.entity.id]) continue;
                    if (Date.now() >= deadline) throw new Error('Owned drop pickup exceeded its time budget.');
                    await settleDrop(drop);
                    if (drop.collected || !bot.entities[drop.entity.id]) continue;
                    // Follow the actual item, not the corner of its floored block:
                    // reaching that corner can still leave the drop outside pickup reach.
                    await goToGoal(bot, new pf.goals.GoalFollow(drop.entity, 1), movements);
                    active();
                    await waitForActionOrTimeout(bot, context, 300);
                }
            } catch (error) { result.reason ||= `Pickup: ${error.message}`; }
        }
        bot.removeListener('itemDrop', onDrop);
        bot.removeListener('playerCollect', onCollect);
        if (originalMovements && !cancelled()) bot.pathfinder.setMovements(originalMovements);
    }
    result.remainingLogs = remaining().map(p => ({ ...p }));
    result.leftoverScaffolds = scaffolds.filter(entry => !treeAir(bot.blockAt(entry.position)))
        .map(entry => ({ position: { ...entry.position }, name: entry.name }));
    const underfoot = bot.blockAt(bot.entity.position.offset(0, -0.1, 0).floored());
    result.grounded = !!bot.entity.onGround && !!underfoot && TREE_SOILS.has(underfoot.name);
    result.cleanupRequired = result.leftoverScaffolds.length > 0;
    result.status = cancelled() ? 'cancelled' : !result.remainingLogs.length && !result.cleanupRequired && result.grounded &&
        result.logsCollected >= result.logsBroken && result.scaffoldRecovered >= result.scaffoldPlaced ? 'complete' : 'partial';
    if (result.status === 'complete') result.reason = null;
    if (result.status !== 'complete') {
        result.reason ||= 'Logs, pillar pickup, or safe ground return remain unconfirmed.';
        recordUncertainty({ phase: 'tree-felling', target: result.tree, reason: result.reason,
            remainingLogs: result.remainingLogs, leftoverScaffolds: result.leftoverScaffolds });
    }
    log(bot, `Tree felling: ${JSON.stringify(result)}`);
    return result;
}

// Replace exported bindings so internal delegation and direct command callers share ownership.
craftRecipe = trackSkill("skills.craftRecipe", craftRecipe);
craftItem = trackSkill("skills.craftItem", craftItem);
wait = trackSkill("skills.wait", wait);
smeltItem = trackSkill("skills.smeltItem", smeltItem);
clearNearestFurnace = trackSkill("skills.clearNearestFurnace", clearNearestFurnace);
attackNearest = trackSkill("skills.attackNearest", attackNearest);
attackEntity = trackSkill("skills.attackEntity", attackEntity);
defendSelf = trackSkill("skills.defendSelf", defendSelf);
collectBlock = trackSkill("skills.collectBlock", collectBlock);
pickupNearbyItems = trackSkill("skills.pickupNearbyItems", pickupNearbyItems);
breakBlockAt = trackSkill("skills.breakBlockAt", breakBlockAt);
placeBlock = trackSkill("skills.placeBlock", placeBlock);
equip = trackSkill("skills.equip", equip);
discard = trackSkill("skills.discard", discard);
putInChest = trackSkill("skills.putInChest", putInChest);
takeFromChest = trackSkill("skills.takeFromChest", takeFromChest);
approachBlock = trackSkill("skills.approachBlock", approachBlock);
inspectChestAt = trackSkill("skills.inspectChestAt", inspectChestAt);
inspectChest = trackSkill("skills.inspectChest", inspectChest);
viewChest = trackSkill("skills.viewChest", viewChest);
consume = trackSkill("skills.consume", consume);
giveToPlayer = trackSkill("skills.giveToPlayer", giveToPlayer);
receiveFromPlayer = trackSkill("skills.receiveFromPlayer", receiveFromPlayer);
goToGoal = trackSkill("skills.goToGoal", goToGoal);
goToPosition = trackSkill("skills.goToPosition", goToPosition);
reachPosition = trackSkill("skills.reachPosition", reachPosition);
reachPositionWithScaffoldCleanup = trackSkill("skills.reachPositionWithScaffoldCleanup", reachPositionWithScaffoldCleanup);
goToNearestBlock = trackSkill("skills.goToNearestBlock", goToNearestBlock);
goToNearestEntity = trackSkill("skills.goToNearestEntity", goToNearestEntity);
goToPlayer = trackSkill("skills.goToPlayer", goToPlayer);
followPlayer = trackSkill("skills.followPlayer", followPlayer);
moveAway = trackSkill("skills.moveAway", moveAway);
moveAwayFromEntity = trackSkill("skills.moveAwayFromEntity", moveAwayFromEntity);
avoidEnemies = trackSkill("skills.avoidEnemies", avoidEnemies);
stay = trackSkill("skills.stay", stay);
useDoor = trackSkill("skills.useDoor", useDoor);
goToBed = trackSkill("skills.goToBed", goToBed);
tillAndSow = trackSkill("skills.tillAndSow", tillAndSow);
activateNearestBlock = trackSkill("skills.activateNearestBlock", activateNearestBlock);
showVillagerTrades = trackSkill("skills.showVillagerTrades", showVillagerTrades);
tradeWithVillager = trackSkill("skills.tradeWithVillager", tradeWithVillager);
digDown = trackSkill("skills.digDown", digDown);
goToSurface = trackSkill("skills.goToSurface", goToSurface);
useToolOn = trackSkill("skills.useToolOn", useToolOn);
useItem = trackSkill("skills.useItem", useItem);
useToolOnBlock = trackSkill("skills.useToolOnBlock", useToolOnBlock);
useToolOnBlockAt = trackSkill("skills.useToolOnBlockAt", useToolOnBlockAt);
tendNearbyFarm = trackSkill("skills.tendNearbyFarm", tendNearbyFarm);

fellTree = trackSkill("skills.fellTree", fellTree);
