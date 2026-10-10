import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { createRequire } from 'node:module';
import settings from "../../../settings.js";
import craftingSync from "./crafting_sync.js";
import { placeBlockOriented } from './block_placement.js';
import { resolveBlockInteraction, makeBlockInteractionGoal, interactionFaceVector, interactionEye } from './block_interaction.js';
import { trackSkill, recordConfirmation, recordUncertainty, recordOwnedWait, beginOwnedWait, markOwnedWaitProgress, finishOwnedWait, operationContext, withSkillPhase, registerOwnedPromise } from './operation_context.js';

const require = createRequire(import.meta.url);

const blockPlaceDelay = settings.block_place_delay == null ? 0 : settings.block_place_delay;
const useDelay = blockPlaceDelay > 0;
const COLLECT_DROP_RADIUS = 0.5;
const PLANT_CONFIRM_TIMEOUT_MS = 2000;
const HARVEST_CONFIRM_TIMEOUT_MS = 2000;
const INTERACTION_CONFIRM_TIMEOUT_MS = 2000;
const COMBAT_CHECK_INTERVAL_MS = 100;
const FARM_SEARCH_RADIUS = 32;
const FARM_SEED_RESERVE = 1;
const FARM_CHEST_RADIUS = 32;
const FARM_SEARCH_LIMIT = 10000;
const FURNACE_POLL_INTERVAL_MS = 100;
const FURNACE_IDLE_TIMEOUT_MS = 11000;
const DEFAULT_NAVIGATION_STALL_TIMEOUT_MS = 90_000;
const DEFAULT_NAVIGATION_CHECK_INTERVAL_MS = 5_000;
const SURFACE_SEARCH_RADIUS = 6;
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

export function log(bot, message) {
    const owner = operationContext();
    if (owner?.closed) { owner.diagnostics.push({ kind: 'late_output', message: String(message) }); return; }
    bot.output += message + '\n';
}

function getActionContext(bot, context) {
    return context || operationContext()?.cancellation || bot.getActionCancellationContext?.() || null;
}

function isActionCancelled(bot, context) {
    return !!bot.interrupt_code || !!context?.signal?.aborted;
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
    const trackedDrops = new Set();
    let collectedTargetDrop = false;
    let targetAirObserved = false;
    const onItemDrop = entity => {
        const center = block.position.offset(0.5, 0.5, 0.5);
        if (!entity.position?.distanceTo || entity.position.distanceTo(center) > COLLECT_DROP_RADIUS) return;
        const item = entity.getDroppedItem?.();
        if (item?.type != null && expectedItemIds.has(item.type) && entity.id != null) trackedDrops.add(entity.id);
    };
    const onPlayerCollect = (collector, entity) => {
        if (bot.entity?.id == null || collector?.id !== bot.entity.id || entity?.id == null || !trackedDrops.has(entity.id)) return;
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

export async function craftRecipe(bot, itemName, num=1) {
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
        return false;
    }

    if (!Number.isInteger(num) || num < 1) {
        log(bot, `Crafting count must be a positive integer: ${num}.`);
        return false;
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
                    log(bot, `Could not confirm a crafting table after placement; refusing to use the inventory grid for ${itemName}.`);
                    return false;
                }
            }
            else {
                log(bot, `Crafting ${itemName} requires a crafting table.`)
                return false;
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
            log(bot, `Cannot use crafting table at ${tablePosition}: interaction approach ${approach.status}${approach.reason ? ` (${approach.reason})` : ''}; refusing to open a crafting window.`);
            return false;
        }
        craftingTable = bot.blockAt(new Vec3(tablePosition.x, tablePosition.y, tablePosition.z).floored());
        if (!craftingTable || craftingTable.name !== 'crafting_table') {
            log(bot, `Crafting table at ${tablePosition} changed before activation; refusing to open a crafting window.`);
            return false;
        }
    }

    const recipe = recipes[0];
    console.log('crafting...');
    //Check that the agent has sufficient items to use the recipe `num` times.
    const inventory = world.getInventoryCounts(bot); //Items in the agents inventory
    const requiredIngredients = mc.ingredientsFromPrismarineRecipe(recipe); //Items required to use the recipe once.
    const craftLimit = mc.calculateLimitingResource(inventory, requiredIngredients);
    
    const craftedCount = await craft(recipe, Math.min(craftLimit.num, num), craftingTable);
    if(craftedCount<num) log(bot, `Not enough ${craftLimit.limitingResource} to craft ${num}, crafted ${craftedCount}. You now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    else log(bot, `Successfully crafted ${itemName}, you now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    if (placedTable) {
        await withSkillPhase('cleanup', () => collectBlock(bot, 'crafting_table', 1));
    }

    //Equip any armor the bot may have crafted.
    //There is probablly a more efficient method than checking the entire inventory but this is all mineflayer-armor-manager provides. :P
    await bot.armorManager.equipAll();

    return craftedCount > 0;
    });
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

export async function smeltItem(bot, itemName, num=1, actionContext=null) {
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
    const context = getActionContext(bot, actionContext);
    if (!mc.isSmeltable(itemName)) {
        log(bot, `Cannot smelt ${itemName}. Hint: make sure you are smelting the 'raw' item.`);
        return false;
    }
    if (!Number.isInteger(num) || num < 1) {
        log(bot, `Smelting count must be a positive integer: ${num}.`);
        return false;
    }

    const furnaceRange = 16;
    let furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
    let placedFurnace = false;
    if (!furnaceBlock && world.getInventoryCounts(bot).furnace > 0 && !isActionCancelled(bot, context)) {
        const pos = world.getNearestFreeSpace(bot, 1, furnaceRange);
        await placeBlock(bot, 'furnace', pos.x, pos.y, pos.z);
        furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
        placedFurnace = !!furnaceBlock;
    }
    if (!furnaceBlock) {
        log(bot, 'There is no furnace nearby and you have no furnace.');
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4)
        await goToNearestBlock(bot, 'furnace', 4, furnaceRange);
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
        log(bot, `Smelting ${itemName} interrupted before completion; observed output: ${total}. Furnace snapshot ${furnaceConfirmed ? 'confirmed after stopping transfers' : 'unconfirmed'}, player inventory snapshot ${inventoryConfirmed ? 'confirmed after close' : 'unconfirmed'}${bot.inventoryUnconfirmed ? '; actions are gated until state is confirmed' : ''}. The furnace may continue smelting after close${reason ? ` (${reason})` : ''}.`);
        return false;
    }
    if (!furnace || !furnaceConfirmed) {
        if (reason) {
            log(bot, `Smelting ${itemName} did not start: ${reason}.`);
            return false;
        }
        log(bot, `Smelting ${itemName} result is unconfirmed${reason ? `: ${reason}` : '.'}`);
        return false;
    }
    if (!inventoryConfirmed) {
        log(bot, `Smelting ${itemName} result is unconfirmed; inventory snapshot failed and actions are gated.`);
        return false;
    }
    const mismatches = verifyInventoryDelta(bot, baseline, returnedItems, removedItems);
    if (mismatches.length) {
        log(bot, `Smelting ${itemName} result is unconfirmed: inventory delta ${JSON.stringify(mismatches)}.`);
        return false;
    }
    if (placedFurnace && !furnace.outputItem() && !furnace.inputItem() && !furnace.fuelItem())
        await collectBlock(bot, 'furnace', 1);
    if (total === 0) {
        log(bot, `Failed to smelt ${itemName}; no output was confirmed.`);
        return false;
    }
    if (total < num) {
        log(bot, `Only smelted ${total} ${mc.getItemName(smeltedItem.type)}; partial result confirmed, no retry was started.`);
        return false;
    }
    log(bot, `Successfully smelted ${itemName}, got ${total} ${mc.getItemName(smeltedItem.type)}; furnace and inventory snapshots confirmed.`);
    return true;
}

export async function clearNearestFurnace(bot, actionContext=null) {
    /**
     * Collects the output, input, and fuel from the nearest furnace.
     * @param {MinecraftBot} bot, reference to the Minecraft bot.
     * @returns {Promise<boolean>} true only when the owned furnace and player inventory snapshots confirm the transfers; false when no furnace is available, the operation is interrupted, or its result cannot be confirmed.
     * @example
     * await skills.clearNearestFurnace(bot);
     **/
    const context = getActionContext(bot, actionContext);
    const furnaceBlock = world.getNearestBlock(bot, 'furnace', 32);
    if (!furnaceBlock) {
        log(bot, 'No furnace nearby to clear.');
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4)
        await goToNearestBlock(bot, 'furnace', 4, 32);
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
        log(bot, `Furnace clearing interrupted before completion. Furnace snapshot ${furnaceConfirmed ? 'confirmed after stopping transfers' : 'unconfirmed'}, player inventory snapshot ${inventoryConfirmed ? 'confirmed after close' : 'unconfirmed'}${bot.inventoryUnconfirmed ? '; actions are gated until state is confirmed' : ''}.`);
        return false;
    }
    if (!furnace || !furnaceConfirmed) {
        log(bot, 'Furnace clearing result is unconfirmed.');
        return false;
    }
    if (!inventoryConfirmed) {
        log(bot, 'Furnace clearing result is unconfirmed; inventory snapshot failed and actions are gated.');
        return false;
    }
    if (isActionCancelled(bot, context)) {
        log(bot, 'Furnace clearing interrupted after close; inventory is confirmed but this operation is not reported as success.');
        return false;
    }
    const mismatches = verifyInventoryDelta(bot, baseline, returnedItems);
    if (mismatches.length) {
        log(bot, `Furnace clearing incomplete; inventory transfer was not confirmed: ${JSON.stringify(mismatches)}`);
        return false;
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
    log(bot, 'Could not find any '+mobType+' to attack.');
    return false;
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

    let pos = entity.position;
    await equipHighestAttack(bot)

    if (!kill) {
        if (bot.entity.position.distanceTo(pos) > 5) {
            console.log('moving to mob...')
            if (!await goToPosition(bot, pos.x, pos.y, pos.z)) return false;
        }
        console.log('attacking mob...')
        await bot.attack(entity);
        return true;
    }
    else {
        let targetDied = false;
        let targetGone = false;
        const onEntityDead = deadEntity => { if (entity.id != null && deadEntity?.id === entity.id) targetDied = true; };
        const onEntityGone = goneEntity => { if (entity.id != null && goneEntity?.id === entity.id) targetGone = true; };
        bot.on('entityDead', onEntityDead);
        bot.on('entityGone', onEntityGone);
        try {
            bot.pvp.attack(entity);
            while (!targetDied && !targetGone && !bot.interrupt_code) {
                if (!world.getNearbyEntities(bot, 24).some(nearby => nearby.id === entity.id)) break;
                await new Promise(resolve => setTimeout(resolve, COMBAT_CHECK_INTERVAL_MS));
            }
            if (!targetDied) return false;
            log(bot, `Successfully killed ${entity.name}.`);
            await pickupNearbyItems(bot);
            return true;
        } catch (err) {
            log(bot, `Failed to kill ${entity.name}: ${err.message}.`);
            return false;
        } finally {
            try {
                bot.pvp.stop();
            } finally {
                bot.removeListener('entityDead', onEntityDead);
                bot.removeListener('entityGone', onEntityGone);
            }
        }
    }
}

export async function defendSelf(bot, range=9) {
    /**
     * Defend yourself from all nearby hostile mobs until there are no more.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} range, the range to look for mobs. Defaults to 8.
     * @returns {Promise<boolean>} true if the bot found any enemies and has killed them, false if no entities were found.
     * @example
     * await skills.defendSelf(bot);
     * **/
    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let attacked = false;
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
    while (enemy) {
        await equipHighestAttack(bot);
        if (bot.entity.position.distanceTo(enemy.position) >= 4 && enemy.name !== 'creeper' && enemy.name !== 'phantom') {
            try {
                bot.pathfinder.setMovements(new pf.Movements(bot));
                await bot.pathfinder.goto(new pf.goals.GoalFollow(enemy, 3.5), true);
            } catch (err) {/* might error if entity dies, ignore */}
        }
        if (bot.entity.position.distanceTo(enemy.position) <= 2) {
            try {
                bot.pathfinder.setMovements(new pf.Movements(bot));
                let inverted_goal = new pf.goals.GoalInvert(new pf.goals.GoalFollow(enemy, 2));
                await bot.pathfinder.goto(inverted_goal, true);
            } catch (err) {/* might error if entity dies, ignore */}
        }
        bot.pvp.attack(enemy);
        attacked = true;
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
        if (bot.interrupt_code) {
            bot.pvp.stop();
            return false;
        }
    }
    bot.pvp.stop();
    if (attacked)
        log(bot, `Successfully defended self.`);
    else
        log(bot, `No enemies nearby to defend self from.`);
    return attacked;
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
        return false;
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

    const movements = new pf.Movements(bot);
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
            if (collected === 0)
                log(bot, `No ${blockType} nearby to collect.`);
            else
                log(bot, `No more ${blockType} nearby to collect.`);
            break;
        }
        const block = blocks[0];
        await bot.tool.equipForBlock(block);
        if (isLiquid) {
            const bucket = bot.inventory.findInventoryItem('bucket');
            if (!bucket) {
                log(bot, `Don't have bucket to harvest ${blockType}.`);
                return false;
            }
            await bot.equip(bucket, 'hand');
        }
        const itemId = bot.heldItem ? bot.heldItem.type : null
        if (!block.canHarvest(itemId)) {
            log(bot, `Don't have right tools to harvest ${blockType}.`);
            return false;
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
                    await bot.dig(block);
                    await pickupNearbyItems(bot);
                    success = true;
                }
            }
            else {
                await bot.collectBlock.collect(block);
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
            } else recordUncertainty({ requestedQuantity: 1, confirmedQuantity: null, unit: 'block', target: block.name, reason: 'block/drop collection not confirmed; resulting quantity is unknown' });
            await autoLight(bot);
        }
        catch (err) {
            if (err.name === 'NoChests') {
                log(bot, `Failed to collect ${blockType}: Inventory full, no place to deposit.`);
                break;
            }
            else {
                log(bot, `Failed to collect ${blockType}: ${err}.`);
                continue;
            }
        }
        finally {
            collectionTracker?.cleanup();
        }
        
        if (bot.interrupt_code)
            break;  
    }
    log(bot, `Collected ${collected} ${blockType}.`);
    return collected > 0;
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
        let movements = new pf.Movements(bot);
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
     * Break the block at the given position. Will use the bot's equipped item.
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
        log(bot, `Cannot break block at x:${x}, y:${y}, z:${z}: block observation is unknown.`);
        return false;
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
                log(bot, `Cannot break target: ${approach.reason ?? approach.status}.`);
                return false;
            }
            block = bot.blockAt(new Vec3(x, y, z).floored());
            if (!block || ['air', 'water', 'lava'].includes(block.name)) return false;
        }
        requireActiveTarget(bot);
        if (bot.game.gameMode !== 'creative') {
            await bot.tool.equipForBlock(block);
            const itemId = bot.heldItem ? bot.heldItem.type : null
            if (!block.canHarvest(itemId)) {
                log(bot, `Don't have right tools to break ${block.name}.`);
                return false;
            }
        }
        requireActiveTarget(bot);
        block = bot.blockAt(new Vec3(x, y, z).floored());
        if (!block || block.type !== expectedType || block.stateId !== expectedState ||
            resolveBlockInteraction(bot, block).status !== 'ready') {
            log(bot, 'Target changed or has no reachable surface aim point before digging.');
            return false;
        }
        await bot.dig(block, true);
        log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    else {
        log(bot, `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block.name}.`);
        return false;
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
                log(bot, `Cannot place ${blockType}, you are restricted to your current inventory.`);
                return false;
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
        log(bot, `Cannot place ${blockType} at ${target_dest}: target block observation is unknown.`);
        return false;
    }
    let block_item = bot.inventory.findInventoryItem(item_name);
    if (!block_item && bot.game.gameMode === 'creative' && !bot.restrict_to_inventory) {
        await bot.creative.setInventorySlot(36, mc.makeItem(item_name, 1)); // 36 is first hotbar slot
        block_item = bot.inventory.findInventoryItem(item_name);
    }
    if (!block_item) {
        log(bot, `Don't have any ${item_name} to place.`);
        return false;
    }

    if (targetBlock.name === blockType || (targetBlock.name === 'grass_block' && blockType === 'dirt')) {
        log(bot, `${blockType} already at ${targetBlock.position}.`);
        return false;
    }
    const empty_blocks = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'];
    if (!empty_blocks.includes(targetBlock.name)) {
        log(bot, `${targetBlock.name} in the way at ${targetBlock.position}.`);
        const removed = await breakBlockAt(bot, x, y, z);
        if (!removed) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`);
            return false;
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
            log(bot, `Cannot place ${blockType} at ${target_dest}: support blocks are not fully observed.`);
            return false;
        }
        log(bot, `Cannot place ${blockType} at ${targetBlock.position}: nothing to place on.`);
        return false;
    }

    const pos = bot.entity.position;
    const pos_above = pos.plus(Vec3(0,1,0));
    const dont_move_for = ['torch', 'redstone_torch', 'redstone', 'lever', 'button', 'rail', 'detector_rail', 
        'powered_rail', 'activator_rail', 'tripwire_hook', 'tripwire', 'water_bucket', 'string'];
    if (!dont_move_for.includes(item_name) && (pos.distanceTo(targetBlock.position) < 1.1 || pos_above.distanceTo(targetBlock.position) < 1.1)) {
        // too close
        let goal = new pf.goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
        let inverted_goal = new pf.goals.GoalInvert(goal);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await bot.pathfinder.goto(inverted_goal);
    }
    if (bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
        // too far
        let pos = targetBlock.position;
        let movements = new pf.Movements(bot);
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }

    // will throw error if an entity is in the way, and sometimes even if the block was placed
    try {
        if (item_name.includes('bucket')) {
            const expectedFluid = item_name === 'water_bucket' ? 'water' : item_name === 'lava_bucket' ? 'lava' : null;
            if (!expectedFluid) return false;
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
        log(bot, `Failed to place ${blockType} at ${target_dest}.`);
        return false;
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
            log(bot, `You do not have any ${itemName} to equip.`);
            return false;
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
    if (discarded === 0) {
        log(bot, `You do not have any ${itemName} to discard.`);
        return false;
    }
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

async function resolveChestTransferTarget(bot, chestPosition) {
    if (chestPosition === undefined) {
        const chest = world.getNearestBlock(bot, 'chest', 32);
        if (!chest) log(bot, `Could not find a chest nearby.`);
        return chest;
    }
    const x = chestPosition.x, y = chestPosition.y, z = chestPosition.z;
    let target = world.inspectBlockAt(bot, x, y, z);
    if (!target.loaded) {
        log(bot, `Chest target at ${target.position.x}, ${target.position.y}, ${target.position.z} is unknown because it is not loaded.`);
        return null;
    }
    if (!['chest', 'trapped_chest'].includes(target.name)) {
        log(bot, `Target at ${target.position.x}, ${target.position.y}, ${target.position.z} is ${target.name}, not a chest.`);
        return null;
    }
    const approach = await approachBlock(bot, x, y, z);
    if (approach.status !== 'ready') {
        log(bot, `Could not reach chest at ${target.position.x}, ${target.position.y}, ${target.position.z}: ${approach.reason || approach.status}.`);
        return null;
    }
    // Navigation can change what is loaded or present. Re-observe this exact
    // coordinate and never replace it with a nearby chest.
    target = world.inspectBlockAt(bot, x, y, z);
    if (!target.loaded) {
        log(bot, `Chest target at ${target.position.x}, ${target.position.y}, ${target.position.z} became unknown after approach.`);
        return null;
    }
    if (!['chest', 'trapped_chest'].includes(target.name)) {
        log(bot, `Target at ${target.position.x}, ${target.position.y}, ${target.position.z} changed to ${target.name} after approach; it is not a chest.`);
        return null;
    }
    return bot.blockAt(new Vec3(x, y, z).floored());
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
    let chest = await resolveChestTransferTarget(bot, chestPosition);
    if (!chest) {
        if (chestPosition === undefined) log(bot, `Could not find a chest nearby.`);
        return false;
    }
    const initialAvailable = inventoryItemCount(bot, itemName);
    if (chestPosition === undefined && !await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2)) return false;
    const context = getActionContext(bot);
    if (isActionCancelled(bot, context)) return false;
    const chestContainer = await (chestPosition === undefined ? bot.openContainer(chest) : openContainerAtSurface(bot, chest));
    let beforeSnapshot = null;
    let afterSnapshot = null;
    let transferError = null;
    let snapshotError = null;
    let closeError = null;
    let requestedQuantity = num === -1 ? initialAvailable : num;
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
    if (transferError) throw transferError;
    if (closeError) throw closeError;
    if (isActionCancelled(bot, context)) return false;
    if (confirmed !== requestedQuantity) {
        log(bot, `Chest transfer was incomplete: confirmed ${confirmed == null ? 'unknown' : confirmed} of ${requestedQuantity} ${itemName}${confirmed === attemptedQuantity && attemptedQuantity < requestedQuantity ? '; only the currently available inventory was transferred.' : '; inventory actions are gated until state is confirmed.'}`);
        return false;
    }
    log(bot, `Successfully put ${confirmed} ${itemName} in the chest.`);
    return true;
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
    let chest = await resolveChestTransferTarget(bot, chestPosition);
    if (!chest) {
        if (chestPosition === undefined) log(bot, `Could not find a chest nearby.`);
        return false;
    }
    if (chestPosition === undefined && !await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2)) return false;
    const context = getActionContext(bot);
    if (isActionCancelled(bot, context)) return false;
    const chestContainer = await (chestPosition === undefined ? bot.openContainer(chest) : openContainerAtSurface(bot, chest));
    let serverSnapshot;
    try { serverSnapshot = await craftingSync.snapshotWindow(bot, chestContainer); }
    catch (error) {
        try { await chestContainer.close(); } catch { bot.inventoryUnconfirmed = true; }
        bot.inventoryUnconfirmed = true;
        recordUncertainty({ requestedQuantity: num === -1 ? null : num, confirmedQuantity: null, unit: 'item', target: itemName,
            reason: `server-fenced chest snapshot unavailable: ${String(error)}` });
        chestTransferOutput(bot, 'withdraw', num === -1 ? null : num, null, chest);
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
        return false;
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
    try { await chestContainer.close(); }
    catch (error) { bot.inventoryUnconfirmed = true; throw error; }
    chestTransferOutput(bot, 'withdraw', requestedQuantity, confirmed, chest);
    if (transferError) throw transferError;
    if (isActionCancelled(bot, context)) return confirmed > 0 && confirmed === requestedQuantity;
    if (confirmed !== requestedQuantity) {
        log(bot, `Chest transfer was incomplete: confirmed ${confirmed == null ? 'unknown' : confirmed} of ${requestedQuantity} ${itemName}${confirmed === toTake && toTake < requestedQuantity ? '; the chest contained fewer items than requested.' : '; inventory actions are gated until state is confirmed.'}`);
        return false;
    }
    log(bot, `Successfully took ${confirmed} ${itemName} from the chest.`);
    return true;
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
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    if (!await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2)) return false;
    const chestContainer = await bot.openContainer(chest);
    let items = chestContainer.containerItems();
    if (items.length === 0) {
        log(bot, `The chest is empty.`);
    }
    else {
        log(bot, `The chest contains:`);
        for (let item of items) {
            log(bot, `${item.count} ${item.name}`);
        }
    }
    await chestContainer.close();
    return true;
}

export async function consume(bot, itemName="") {
    /**
     * Eat/drink the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to eat/drink.
     * @returns {Promise<boolean>} true if the item was eaten, false otherwise.
     * @example
     * await skills.consume(bot, "apple");
     **/
    let item, name;
    if (itemName) {
        item = bot.inventory.findInventoryItem(itemName);
        name = itemName;
    }
    if (!item) {
        log(bot, `You do not have any ${name} to eat.`);
        return false;
    }
    await bot.equip(item, 'hand');
    await bot.consume();
    log(bot, `Consumed ${item.name}.`);
    return true;
}


export async function giveToPlayer(bot, itemType, username, num=1) {
    /**
     * Give one of the specified item to the specified player
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemType, the name of the item to give.
     * @param {string} username, the username of the player to give the item to.
     * @param {number} num, the number of items to give. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was given, false otherwise.
     * @example
     * await skills.giveToPlayer(bot, "oak_log", "player1");
     **/
    if (bot.username === username) {
        log(bot, `You cannot give items to yourself.`);
        return false;
    }
    let player = bot.players?.[username]?.entity
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }
    if (!await goToPlayer(bot, username, 3)) return false;
    // if we are 2 below the player
    log(bot, bot.entity.position.y, player.position.y);
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
            log(bot, `Failed to move away from ${username}: ${err.message}.`);
            return false;
        }
        while (too_close && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            too_close = bot.entity.position.distanceTo(player.position) < 5;
            if (too_close) {
                try {
                    if (!await moveAwayFromEntity(bot, player, 5)) return false;
                } catch (err) {
                    log(bot, `Failed to move away from ${username}: ${err.message}.`);
                    return false;
                }
            }
            if (Date.now() - start_moving_away > 3000) {
                break;
            }
        }
        if (too_close) {
            log(bot, `Failed to give ${itemType} to ${username}, too close.`);
            return false;
        }
    }

    await bot.lookAt(player.position);
    if (await discard(bot, itemType, num)) {
        let given = false;
        bot.once('playerCollect', (collector, collected) => {
            console.log(collected.name);
            if (collector.username === username) {
                log(bot, `${username} received ${itemType}.`);
                given = true;
            }
        });
        let start = Date.now();
        while (!given && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (given) {
                return true;
            }
            if (Date.now() - start > 3000) {
                break;
            }
        }
    }
    log(bot, `Failed to give ${itemType} to ${username}, it was never received.`);
    return false;
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

    // Native code uses explicit edits for changes; all navigation, including
    // navigation inside other skills, stays free of digging and scaffolding.
    if (operationContext()?.nativeNavigationNoEdits) {
        movementOverride = Object.assign(new pf.Movements(bot), movementOverride ?? {}, {
            canDig: false, canPlaceOn: false, allow1by1towers: false,
            allowFreeMotion: false, scafoldingBlocks: [], canOpenDoors: false,
        });
    }

    const nonDestructiveMovements = movementOverride || new pf.Movements(bot);
    const dontBreakBlocks = ['glass', 'glass_pane'];
    for (let block of dontBreakBlocks) {
        nonDestructiveMovements.blocksCantBreak.add(mc.getBlockId(block));
    }
    nonDestructiveMovements.placeCost = 2;
    nonDestructiveMovements.digCost = 10;

    const destructiveMovements = movementOverride || new pf.Movements(bot);

    let final_movements = destructiveMovements;

    const pathfind_timeout = 1000;
    if (await bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfind_timeout).status === 'success') {
        final_movements = nonDestructiveMovements;
        log(bot, `Found non-destructive path.`);
    }
    else if (await bot.pathfinder.getPathTo(destructiveMovements, goal, pathfind_timeout).status === 'success') {
        log(bot, movementOverride ? 'Found a path with the requested movement restrictions.' : 'Found destructive path.');
    }
    else {
        log(bot, movementOverride ? 'Path search is incomplete; attempting navigation with the requested movement restrictions.' : 'Path not found, but attempting to navigate anyway using destructive movements.');
    }

    const doorCheckInterval = movementOverride ? null : startDoorInterval(bot);

    bot.pathfinder.setMovements(final_movements);
    const owner = operationContext();
    const cancellation = owner?.cancellation;
    const previousActionPhase = cancellation?.phase ?? 'running';
    const navigationStallTimeoutMs = Number.isFinite(settings.navigation_stall_timeout_ms) && settings.navigation_stall_timeout_ms > 0
        ? settings.navigation_stall_timeout_ms : DEFAULT_NAVIGATION_STALL_TIMEOUT_MS;
    const navigationCheckIntervalMs = Number.isFinite(settings.navigation_check_interval_ms) && settings.navigation_check_interval_ms > 0
        ? settings.navigation_check_interval_ms : DEFAULT_NAVIGATION_CHECK_INTERVAL_MS;
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
    const seenRouteSegments = new Set();
    let activeRouteNodes = [];
    const positionKey = point => `${point.x},${point.y},${point.z}`;
    const onPathUpdate = result => {
        activeRouteNodes = Array.isArray(result?.path)
            ? result.path.filter(node => [node?.x, node?.y, node?.z].every(Number.isFinite))
                .map(node => ({ x: node.x, y: node.y, z: node.z }))
            : [];
        const position = bot.entity.position;
        for (const node of activeRouteNodes) {
            if (Math.abs(position.x - node.x) <= 0.5 && Math.abs(position.z - node.z) <= 0.5 && Math.abs(position.y - node.y) < 1) {
                seenRouteSegments.add(positionKey(node));
            }
        }
    };
    const onPathReset = () => { activeRouteNodes = []; };
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
    try {
        bestGoalDistance = goal.heuristic(bot.entity.position.floored());
        seenRouteSegments.add(positionKey(bot.entity.position.floored()));
        lastProgressAt = Date.now();
        bot.on?.('path_update', onPathUpdate);
        bot.on?.('path_reset', onPathReset);
        setActionPhase(cancellation, 'navigation');
        const navigation = bot.pathfinder.goto(goal);
        timeoutHandle = setInterval(() => {
            if (owner?.signal.aborted || owner?.closed) {
                clearInterval(timeoutHandle);
                timeoutHandle = null;
                return;
            }
            const currentGoalDistance = goal.heuristic(bot.entity.position.floored());
            if (currentGoalDistance <= bestGoalDistance - 0.5) {
                bestGoalDistance = currentGoalDistance;
                lastProgressAt = Date.now();
            } else if (routeSegmentAdvanced()) {
                lastProgressAt = Date.now();
            } else if (!stallError && Date.now() - lastProgressAt >= navigationStallTimeoutMs) {
                stallError = new Error(`Navigation made no goal or new route-segment progress for ${navigationStallTimeoutMs}ms.`);
                stallError.name = 'NavigationStallTimeoutError';
                bot.pathfinder.stop();
            }
        }, navigationCheckIntervalMs);
        try {
            await navigation;
        } catch (err) {
            if (!stallError) { navigationError = true; throw err; }
        }
        if (stallError) throw stallError;
        return true;
    } catch (err) {
        // we need to catch so we can clean up the door check interval, then rethrow the error
        throw err;
    } finally {
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
            log(bot, `Unable to reach ${x}, ${y}, ${z}, you are ${Math.round(distance)} blocks away.`);
            return false;
        }
    } catch (err) {
        log(bot, `Pathfinding stopped: ${err.message}.`);
        clearInterval(progressInterval);
        return false;
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
        log(bot, `Could not find any ${blockType} in ${range} blocks.`);
        return false;
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
        log(bot, `Could not find any ${entityType} in ${range} blocks.`);
        return false;
    }
    let distance = bot.entity.position.distanceTo(entity.position);
    log(bot, `Found ${entityType} ${distance} blocks away.`);
    return await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, min_distance);
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
        log(bot, `Could not find ${username}.`);
        return false;
    }

    distance = Math.max(distance, 0.5);
    const goal = new pf.goals.GoalFollow(player, distance);

    try {
        await goToGoal(bot, goal, true);
    } catch (err) {
        log(bot, `Could not reach ${username}: ${err.message}.`);
        return false;
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
    let player = bot.players[username].entity
    if (!player)
        return false;

    const move = new pf.Movements(bot);
    move.digCost = 10;
    bot.pathfinder.setMovements(move);
    let doorCheckInterval = startDoorInterval(bot);

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
                doorCheckInterval = startDoorInterval(bot);
            }
            bot.modes.unpause('elbow_room');
        }
    }
    clearInterval(doorCheckInterval);
    return true;
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
    bot.pathfinder.setMovements(new pf.Movements(bot));

    if (bot.modes.isOn('cheat')) {
        const move = new pf.Movements(bot);
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
    bot.pathfinder.setMovements(new pf.Movements(bot));
    await bot.pathfinder.goto(inverted_goal);
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
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
    while (enemy) {
        const follow = new pf.goals.GoalFollow(enemy, distance+1); // move a little further away
        const inverted_goal = new pf.goals.GoalInvert(follow);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        bot.pathfinder.setGoal(inverted_goal, true);
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
        if (bot.interrupt_code) {
            break;
        }
        if (enemy && bot.entity.position.distanceTo(enemy.position) < 3) {
            await attackEntity(bot, enemy, false);
        }
    }
    bot.pathfinder.stop();
    log(bot, `Moved ${distance} away from enemies.`);
    return true;
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

export async function useDoor(bot, door_pos=null) {
    /**
     * Use the door at the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Vec3} door_pos, the position of the door to use. If null, the nearest door will be used.
     * @returns {Promise<boolean>} true if the door was used, false otherwise.
     * @example
     * let door = world.getNearestBlock(bot, "oak_door", 16).position;
     * await skills.useDoor(bot, door);
     **/
    if (!door_pos) {
        for (let door_type of ['oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
                               'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door']) {
            door_pos = world.getNearestBlock(bot, door_type, 16)?.position;
            if (door_pos) break;
        }
    } else {
        door_pos = Vec3(door_pos.x, door_pos.y, door_pos.z);
    }
    if (!door_pos) {
        log(bot, `Could not find a door to use.`);
        return false;
    }

    let forwardEnabled = false;
    try {
        if (!await goToPosition(bot, door_pos.x, door_pos.y, door_pos.z, 1)) return false;
        let doorBlock = bot.blockAt(door_pos);
        const isOpen = block => block?.getProperties?.().open === true;
        if (!doorBlock || !doorBlock.name?.includes('door')) {
            log(bot, `Could not find a door at ${door_pos}.`);
            return false;
        }
        if (!isOpen(doorBlock)) {
            const opening = waitForBlockUpdate(bot, door_pos, isOpen, INTERACTION_CONFIRM_TIMEOUT_MS);
            try {
                await bot.lookAt(door_pos);
                await bot.activateBlock(doorBlock);
                if (!await opening.promise || bot.interrupt_code) {
                    log(bot, `Could not confirm opening the door at ${door_pos}.`);
                    return false;
                }
            } finally {
                opening.cleanup();
            }
            doorBlock = bot.blockAt(door_pos);
        }
        if (!isOpen(doorBlock) || bot.interrupt_code) return false;

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
        log(bot, `Failed to use door at ${door_pos}: ${err.message}.`);
        return false;
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
        log(bot, `Could not find a bed to sleep in.`);
        return false;
    }
    let loc = beds[0];
    if (!await goToPosition(bot, loc.x, loc.y, loc.z)) return false;
    const bed = bot.blockAt(loc);
    await bot.sleep(bed);
    log(bot, `You are in bed.`);
    while (bot.isSleeping) {
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
            log(bot, `Could not confirm farmland at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
            return false;
        }
        if (plantingItem) {
            const desiredCrop = cropName ?? plantingItem;
            const cropPosition = pos.offset(0, 1, 0);
            if (bot.blockAt(cropPosition)?.name !== desiredCrop &&
                !await performAndConfirmBlockUpdate(bot, cropPosition, desiredCrop, () => placeBlock(bot, desiredCrop, x, y+1, z))) {
                log(bot, `Could not confirm planting ${plantingItem} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
                return false;
            }
        }
        return true;
    }

    if (block.name !== 'grass_block' && block.name !== 'dirt' && block.name !== 'farmland') {
        log(bot, `Cannot till ${block.name}, must be grass_block or dirt.`);
        return false;
    }
    let above = bot.blockAt(new Vec3(x, y+1, z));
    if (above.name !== 'air') {
        if (block.name === 'farmland') {
            if (!plantingItem || (cropName && above.name === cropName)) {
                log(bot, `Land is already farmed with ${above.name}.`);
                return true;
            }
            log(bot, `Land is already farmed with ${above.name}, not ${requestedPlant}.`);
            return false;
        }
        let broken = await breakBlockAt(bot, x, y+1, z);
        if (!broken) {
            log(bot, `Cannot cannot break above block to till.`);
            return false;
        }
    }
    // if distance is too far, move to the block
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    if (block.name !== 'farmland') {
        let hoe = bot.inventory.items().find(item => item.name.includes('hoe'));
        let to_equip = hoe?.name || 'diamond_hoe';
        if (!await equip(bot, to_equip)) {
            log(bot, `Cannot till, no hoes.`);
            return false;
        }
        await bot.activateBlock(block);
        log(bot, `Tilled block x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    
    if (plantingItem) {
        let equipped_seeds = await equip(bot, plantingItem);
        if (!equipped_seeds) {
            log(bot, `No ${plantingItem} to plant.`);
            return false;
        }

        const cropPosition = pos.offset(0, 1, 0);
        const update = waitForBlockUpdate(bot, cropPosition, newBlock => cropName ? newBlock?.name === cropName : newBlock?.name !== 'air');
        try {
            await bot.activateBlock(block);
            if (!await update.promise) {
                log(bot, `Could not confirm planting ${plantingItem} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
                return false;
            }
        } finally {
            update.cleanup();
        }
        log(bot, `Planted ${plantingItem} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    return true;
}

export async function activateNearestBlock(bot, type) {
    /**
     * Activate the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} type, the type of block to activate.
     * @returns {Promise<boolean>} true if the block was activated, false otherwise.
     * @example
     * await skills.activateNearestBlock(bot, "lever");
     * **/
    let block = world.getNearestBlock(bot, type, 16);
    if (!block) {
        log(bot, `Could not find any ${type} to activate.`);
        return false;
    }
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
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
            log(bot, "No villagers found nearby.");
            return null;
        }
        log(bot, villager_list);
        return null;
    }
    
    if (entity.entityType !== bot.registry.entitiesByName.villager.id) {
        log(bot, 'Entity is not a villager');
        return null;
    }
    
    if (entity.metadata && entity.metadata[16] === 1) {
        log(bot, 'This is either a baby villager or a villager with no job - neither can trade');
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
            log(bot, 'Failed to reach villager - pathfinding error or villager moved');
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
export async function showVillagerTrades(bot, id) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        log(bot, `Villager has ${villager.trades.length} available trades:`);
        stringifyTrades(bot, villager.trades).forEach((trade, i) => {
            const tradeInfo = `${i + 1}: ${trade}`;
            console.log(tradeInfo);
            log(bot, tradeInfo);
        });
        
        villager.close();
        return true;
    } catch (err) {
        log(bot, 'Failed to open villager trading interface - they might be sleeping, a baby, or jobless');
        console.log('Villager trading error:', err.message);
        return false;
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
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        const tradeIndex = parseInt(index) - 1; // Convert to 0-based index
        const trade = villager.trades[tradeIndex];
        
        if (!trade) {
            log(bot, `Trade ${index} not found. This villager has ${villager.trades.length} trades available.`);
            villager.close();
            return false;
        }
        
        if (trade.disabled) {
            log(bot, `Trade ${index} is currently disabled`);
            villager.close();
            return false;
        }

        const item_2 = trade.inputItem2 ? stringifyItem(bot, trade.inputItem2)+' ' : '';
        log(bot, `Trading ${stringifyItem(bot, trade.inputItem1)} ${item_2}for ${stringifyItem(bot, trade.outputItem)}...`);
        
        const maxPossibleTrades = trade.maximumNbTradeUses - trade.nbTradeUses;
        const requestedCount = count;
        const actualCount = Math.min(requestedCount, maxPossibleTrades);
        
        if (actualCount <= 0) {
            log(bot, `Trade ${index} has been used to its maximum limit`);
            villager.close();
            return false;
        }
        
        if (!hasResources(villager.slots, trade, actualCount)) {
            log(bot, `Don't have enough resources to execute trade ${index} ${actualCount} time(s)`);
            villager.close();
            return false;
        }
        
        log(bot, `Executing trade ${index} ${actualCount} time(s)...`);
        
        try {
            await bot.trade(villager, tradeIndex, actualCount);
            log(bot, `Successfully traded ${actualCount} time(s)`);
            villager.close();
            return true;
        } catch (tradeErr) {
            log(bot, 'An error occurred while trying to execute the trade');
            console.log('Trade execution error:', tradeErr.message);
            villager.close();
            return false;
        }
    } catch (err) {
        log(bot, 'Failed to open villager trading interface');
        console.log('Villager interface error:', err.message);
        return false;
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
        log(bot, 'Cannot dig down: current block observation is unknown.');
        return false;
    }
    let start_block_pos = start_block.position;
    for (let i = 1; i <= distance; i++) {
        const targetBlock = bot.blockAt(start_block_pos.offset(0, -i, 0));
        let belowBlock = bot.blockAt(start_block_pos.offset(0, -i-1, 0));

        if (!targetBlock || !belowBlock) {
            recordUncertainty({ unit: 'block', target: { position: { x: start_block_pos.x, y: start_block_pos.y - i, z: start_block_pos.z } },
                reason: 'digDown stopped because a target or lower block observation is unknown; Mineflayer returned null',
                observedAt: new Date().toISOString() });
            log(bot, `Could not confirm the next block while digging down after ${i-1} blocks; stopping without treating it as completion.`);
            return false;
        }

        // Check for lava, water
        if (targetBlock.name === 'lava' || targetBlock.name === 'water' || 
            belowBlock.name === 'lava' || belowBlock.name === 'water') {
            log(bot, `Dug down ${i-1} blocks, but reached ${belowBlock ? belowBlock.name : '(lava/water)'}`)
            return false;
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
            log(bot, `Dug down ${i-1} blocks, but reached a drop below the next block.`);
            return false;
        }

        if (targetBlock.name === 'air' || targetBlock.name === 'cave_air') {
            log(bot, 'Skipping air block');
            console.log(targetBlock.position);
            continue;
        }

        let dug = await breakBlockAt(bot, targetBlock.position.x, targetBlock.position.y, targetBlock.position.z);
        if (!dug) {
            log(bot, 'Failed to dig block at position:' + targetBlock.position);
            return false;
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

export async function goToSurface(bot) {
    /**
     * Navigate to a loaded, safe surface within a small radius of the current position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true only after standing on a confirmed surface candidate.
     **/
    const context = getActionContext(bot);
    requireActiveTarget(bot);
    const { minY, height } = bot.game ?? {};
    if (!Number.isSafeInteger(minY) || !Number.isSafeInteger(height) || height <= 0) {
        log(bot, 'Cannot search for the surface: dimension height is unavailable.');
        return false;
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
        log(bot, `No loaded safe surface candidate found within ${SURFACE_SEARCH_RADIUS} blocks.`);
        return false;
    }

    const surfaceCandidates = candidates.filter(candidate => isConnectedSurfaceCandidate(candidate, candidates));
    if (surfaceCandidates.length === 0) {
        log(bot, `No connected loaded surface candidate found within ${SURFACE_SEARCH_RADIUS} blocks.`);
        return false;
    }

    surfaceCandidates.sort((a, b) =>
        Math.hypot(a.x + 0.5 - position.x, a.y - position.y, a.z + 0.5 - position.z) -
        Math.hypot(b.x + 0.5 - position.x, b.y - position.y, b.z + 0.5 - position.z));
    requireActiveTarget(bot);
    const goal = new pf.goals.GoalCompositeAny(surfaceCandidates.map(candidate =>
        new pf.goals.GoalBlock(candidate.x, candidate.y, candidate.z)));
    try {
        const moved = await goToGoal(bot, goal, movements);
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
        if (!isActionCancelled(bot, context)) log(bot, `Surface navigation failed: ${error.message}.`);
        return false;
    }
    log(bot, 'Surface navigation ended without confirmed arrival at a safe surface.');
    return false;
}

export async function useToolOn(bot, toolName, targetName) {
    /**
     * Equip a tool and use it on the nearest target.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {string} targetName - entity type, block type, or "nothing" for no target
     * @returns {Promise<boolean>} true if action succeeded
     **/
    if (!bot.inventory.slots.find(slot => slot && slot.name === toolName) && !bot.game.gameMode === 'creative') {
        log(bot, `You do not have any ${toolName} to use.`);
        return false;
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
            log(bot, `Could not find any ${targetName}.`);
            return false;
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
                log(bot, `Could not find any source ${targetName}.`);
                return false;
            }
            block = blocks[0];
        }
        else {
            block = world.getNearestBlock(bot, targetName, 64);
        }
        if (!block) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
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
            log(bot, `Block ${blockInView.name} is in the way, not using ${toolName}.`);
            return false;
        }
    }

    const equipped = await equip(bot, toolName);

    if (!equipped) {
        log(bot, `Could not equip ${toolName}.`);
        return false;
    }
    if (toolName.includes('bucket')) {
        const filledBucket = toolName === 'bucket'
            ? block.name === 'water' ? 'water_bucket' : block.name === 'lava' ? 'lava_bucket' : null
            : toolName === 'water_bucket' || toolName === 'lava_bucket' ? toolName : null;
        if (!filledBucket) {
            log(bot, `Cannot use ${toolName} on ${block.name} as a supported bucket interaction.`);
            return false;
        }
        const inputBucket = toolName === 'bucket' ? 'bucket' : filledBucket;
        const outputBucket = toolName === 'bucket' ? filledBucket : 'bucket';
        const inventoryChange = trackBucketInventoryChange(bot, inputBucket, outputBucket);
        try {
            await bot.activateItem();
            if (!await inventoryChange.wait()) {
                log(bot, `Could not confirm ${toolName} interaction with ${block.name}.`);
                return false;
            }
            if (toolName === 'bucket') {
                const currentBlock = bot.blockAt(block.position);
                if (!['air', block.name].includes(currentBlock?.name)) {
                    log(bot, `Bucket inventory changed, but target ${block.name} is now ${currentBlock?.name ?? 'unknown'}.`);
                    return false;
                }
            }
        } catch (err) {
            log(bot, `Failed to use ${toolName} on ${block.name}: ${err.message}.`);
            return false;
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
     * @param {{x: number, y: number, z: number}} options.chestPosition, optional chest coordinates; otherwise searches for a chest within 32 blocks after tending.
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
            await bot.dig(current);
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
    if (deposits.length > 0 && !bot.interrupt_code) {
        let chest;
        let chestTargetBlock = null;
        let chestTargetReachable = true;
        let resolvedChestPosition = chestPosition;
        const hasChestResolver = typeof options.resolveChestPosition === 'function';
        if (hasChestResolver) {
            const resolved = await options.resolveChestPosition();
            resolvedChestPosition = resolved?.position ?? null;
            storageStatus = resolvedChestPosition ? 'target_resolved' : (resolved?.status ?? 'target_unavailable');
        }
        if (resolvedChestPosition == null && !hasChestResolver && chestPosition == null) {
            chest = world.getNearestBlock(bot, 'chest', FARM_CHEST_RADIUS);
        } else if (resolvedChestPosition && [resolvedChestPosition.x, resolvedChestPosition.y, resolvedChestPosition.z].every(Number.isFinite)) {
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
            else if (!hasChestResolver && resolvedChestPosition == null && chestPosition == null) storageStatus = 'no_chest';
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
                let container;
                let depositError = null;
                try {
                    container = await bot.openContainer(currentChest);
                    for (const deposit of deposits) {
                        const before = bot.inventory.items().filter(item => item.name === deposit.itemName).reduce((total, item) => total + item.count, 0);
                        try {
                            await container.deposit(deposit.item.type, null, deposit.count);
                        } catch (error) {
                            if (options.confirmStorage !== true) throw error;
                            depositError = error;
                        }
                        const after = bot.inventory.items().filter(item => item.name === deposit.itemName).reduce((total, item) => total + item.count, 0);
                        stored += options.confirmStorage === true ? Math.max(0, before - after) : deposit.count;
                        if (depositError) break;
                    }
                } catch (error) {
                    if (options.confirmStorage !== true) throw error;
                    depositError ??= error;
                } finally {
                    if (container) {
                        try { await container.close(); }
                        catch (error) {
                            if (options.confirmStorage !== true) throw error;
                            depositError ??= error;
                        }
                    }
                }
                storageStatus = depositError ? (stored > 0 ? 'partial_storage_failed' : 'storage_failed') : stored > 0 ? 'stored' : 'storage_unconfirmed';
                if (depositError) log(bot, `Farm storage failed after confirmed stored count ${stored}: ${depositError.message}`);
            }
        } else {
            storageStatus = 'unreachable';
        }
    }
    const result = { harvested, planted, stored };
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
const TREE_JUMP_PLACE_HEIGHT = 1.1;
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
            await bot.dig(block, true);
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
                    await waitState(() => bot.entity.position.y >= feet.y + TREE_JUMP_PLACE_HEIGHT);
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
viewChest = trackSkill("skills.viewChest", viewChest);
consume = trackSkill("skills.consume", consume);
giveToPlayer = trackSkill("skills.giveToPlayer", giveToPlayer);
goToGoal = trackSkill("skills.goToGoal", goToGoal);
goToPosition = trackSkill("skills.goToPosition", goToPosition);
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
useToolOnBlock = trackSkill("skills.useToolOnBlock", useToolOnBlock);
tendNearbyFarm = trackSkill("skills.tendNearbyFarm", tendNearbyFarm);

fellTree = trackSkill("skills.fellTree", fellTree);
