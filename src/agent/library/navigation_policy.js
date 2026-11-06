import { AsyncLocalStorage } from 'node:async_hooks';
import { beginOwnedWait, finishOwnedWait, markOwnedWaitProgress, operationContext, recordConfirmation, registerOwnedPromise } from './operation_context.js';

const policyStorage = new AsyncLocalStorage();
const NAVIGATION_PLACEMENT_CONFIRM_TIMEOUT_MS = 2_000;
const NAVIGATION_SCAFFOLD_CLEARANCE_TIMEOUT_MS = 5_000;
export const NAVIGATION_SCAFFOLD_CLEARANCE_HEIGHT = 1.1;
const pendingScaffoldPlacements = new WeakMap();
const scaffoldPlacementTails = new WeakMap();
const pendingNavigationEdits = new WeakMap();
const navigationEditPromises = new WeakMap();
const navigationScaffoldSettledCallbacks = new WeakMap();
const unresolvedNavigationCells = new WeakMap();
const activeNavigationObservations = new WeakMap();
const navigationSnapshots = new WeakMap();

export function navigationPolicy() { return policyStorage.getStore()?.policy ?? null; }
export function navigationScaffoldsPlaced(bot) {
    const context = policyStorage.getStore();
    return context?.bot === bot ? context.confirmedScaffoldCount : 0;
}
export function navigationScaffoldPlacementPending(bot) {
    return (pendingNavigationEdits.get(bot) ?? 0) > 0;
}

export function navigationUnconfirmedAt(bot, position) {
    return unresolvedNavigationCells.get(bot)?.has(positionKey(position)) ?? false;
}

export function isNavigationScaffoldUnconfirmed(error) {
    return error?.name === 'NavigationScaffoldUnconfirmedError' && error?.code === 'scaffold_unconfirmed';
}

export function navigationEditSnapshot(bot) {
    const context = policyStorage.getStore();
    return immutableSnapshot(context?.bot === bot ? context : navigationSnapshots.get(bot));
}

function immutableSnapshot(context) {
    if (!context) return Object.freeze({ edits: Object.freeze([]), scaffolds: Object.freeze([]),
        unconfirmedScaffolds: Object.freeze([]), unresolvedScaffolds: Object.freeze([]), arrivals: Object.freeze([]) });
    const clone = values => Object.freeze((values ?? []).map(value => Object.freeze(structuredClone(value))));
    return Object.freeze({ edits: clone(context.edits), scaffolds: clone(context.scaffolds),
        unconfirmedScaffolds: clone(context.unconfirmedScaffolds),
        unresolvedScaffolds: clone(context.bot ? [...(unresolvedNavigationCells.get(context.bot)?.values() ?? [])] : []),
        arrivals: clone(context.arrivals) });
}

export function beginNavigationEdit(bot) {
    pendingNavigationEdits.set(bot, (pendingNavigationEdits.get(bot) ?? 0) + 1);
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        const count = pendingNavigationEdits.get(bot) ?? 0;
        if (count <= 1) pendingNavigationEdits.delete(bot);
        else pendingNavigationEdits.set(bot, count - 1);
    };
}

// Holds the pathfinder's movement loop while an owned route edit is in flight.
// Once an edit settles without confirmation, planning resumes around its unknown cell.
export function navigationEditGatePlugin(bot) {
    bot.pathfinder.tickPaused = () => navigationScaffoldPlacementPending(bot);
    bot.pathfinder.navigationUnconfirmedAt = position => navigationUnconfirmedAt(bot, position);
    if (typeof bot.pathfinder.isWaterFilled !== 'function' && typeof bot.pathfinder.movements?.constructor?.isWaterFilled === 'function') {
        bot.pathfinder.isWaterFilled = bot.pathfinder.movements.constructor.isWaterFilled;
    }
}

export function registerNavigationScaffoldSettledCallback(bot, callback) {
    if (typeof callback !== 'function') throw new TypeError('Navigation scaffold callback must be a function.');
    let callbacks = navigationScaffoldSettledCallbacks.get(bot);
    if (!callbacks) {
        callbacks = new Set();
        navigationScaffoldSettledCallbacks.set(bot, callbacks);
    }
    callbacks.add(callback);
    return () => {
        callbacks.delete(callback);
        if (!callbacks.size) navigationScaffoldSettledCallbacks.delete(bot);
    };
}


export async function placeAndConfirmNavigationScaffold(bot, position, blockName, action, prepare = null) {
    ensureNavigationObservation(bot);
    const key = positionKey(position);
    let pending = pendingScaffoldPlacements.get(bot);
    if (!pending) {
        pending = new Map();
        pendingScaffoldPlacements.set(bot, pending);
    }
    const prior = pending.get(key);
    if (prior) {
        const outcome = await prior.done;
        if (outcome.error) throw outcome.error;
        return outcome.value;
    }

    let wait;
    let timer;
    let listener;
    let confirmed = false;
    let confirmation;
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const attempt = { confirmation, done };
    pending.set(key, attempt);
    const observations = activeNavigationObservations.get(bot);
    const observation = { revision: 0 };
    observations.set(key, observation);
    const releaseGate = beginNavigationEdit(bot);
    const previousPlacement = scaffoldPlacementTails.get(bot) ?? Promise.resolve();
    let releasePlacement;
    const currentPlacement = new Promise(resolve => { releasePlacement = resolve; });
    scaffoldPlacementTails.set(bot, currentPlacement);
    try {
        await previousPlacement;
        if (navigationCancelled(bot)) throw placementNotAttempted('Action cancelled before the next navigation edit.');
        const currentTarget = bot.blockAt(position);
        const targetWater = currentTarget && bot.pathfinder?.isWaterFilled?.(currentTarget) === true;
        const replaceables = bot.pathfinder?.movements?.replaceables;
        const targetReplaceable = currentTarget && (currentTarget.type === 0 || replaceables?.has?.(currentTarget.type) ||
            currentTarget.boundingBox === 'empty' || targetWater);
        if (!targetReplaceable) {
            throw placementNotAttempted(`Scaffold target ${key} is no longer replaceable.`);
        }
        // Turning can take longer than a jump. Finish it before checking body
        // clearance so the placement does not wait for aim while falling back
        // into the target block.
        if (prepare) {
            try { await prepare(); }
            catch (error) { error.navigationPlacementAttempted = false; throw error; }
        }
        if (navigationCancelled(bot)) throw placementNotAttempted('Action cancelled before the next navigation edit.');
        await waitForScaffoldClearance(bot, position);
        if (navigationCancelled(bot)) throw placementNotAttempted('Action cancelled before the next navigation edit.');
        const startedAt = new Date().toISOString();
        wait = beginOwnedWait({ phase: 'navigation', reason: 'scaffold-placement-confirmation',
            timeoutMs: NAVIGATION_PLACEMENT_CONFIRM_TIMEOUT_MS, startedAt });
        confirmation = new Promise(resolve => {
            listener = (_oldBlock, newBlock) => {
                const samePosition = newBlock?.position?.x === position.x && newBlock.position.y === position.y && newBlock.position.z === position.z;
                if (!samePosition || newBlock.name !== blockName) return;
                const current = bot.blockAt(position);
                if (!current || current.name !== blockName || current.stateId !== newBlock.stateId) return;
                confirmed = true;
                markOwnedWaitProgress(wait);
                resolve(newBlock);
            };
            bot.on('blockUpdate', listener);
            timer = setTimeout(() => resolve(null), NAVIGATION_PLACEMENT_CONFIRM_TIMEOUT_MS);
        });
        const actionResult = Promise.resolve().then(action).then(
            value => ({ value }),
            error => ({ error }),
        );
        const first = await Promise.race([
            confirmation.then(block => ({ kind: 'confirmation', block })),
            actionResult.then(result => ({ kind: 'action', result })),
        ]);
        if (first.kind === 'action' && first.result.error?.navigationPlacementAttempted === false) throw first.result.error;
        const actionOutcome = first.kind === 'action' ? first.result : await actionResult;
        const confirmedBlock = first.kind === 'confirmation' ? first.block : await confirmation;
        if (!confirmedBlock) {
            const detail = actionOutcome?.error ? `: ${String(actionOutcome.error.message ?? actionOutcome.error)}` : '';
            if (observation.revision === 0) {
                const unconfirmedError = new NavigationScaffoldUnconfirmedError(position, blockName,
                    `Scaffold placement at ${key} was not server-confirmed before the deadline${detail}.`);
                markNavigationCellUnconfirmed(bot, position, blockName, unconfirmedError.message);
                throw unconfirmedError;
            }
            throw new NavigationScaffoldUnconfirmedError(position, blockName,
                `Scaffold placement at ${key} was not confirmed, but the target received an authoritative block update${detail}.`);
        }
        // The plugin may reject on an intermediate update even though the
        // later server block update proves that placement succeeded. Still wait
        // for the plugin promise to settle before pathfinder can issue another
        // edit; Mineflayer's placeBlock promise has its own 5-second deadline.
        const value = { result: actionOutcome?.value, block: confirmedBlock };
        resolveDone({ value });
        return value;
    } catch (error) {
        if (error.navigationPlacementAttempted !== false) error.navigationPlacementAttempted = true;
        resolveDone({ error });
        throw error;
    } finally {
        clearTimeout(timer);
        if (listener) bot.removeListener('blockUpdate', listener);
        if (pending.get(key) === attempt) pending.delete(key);
        if (observations.get(key) === observation) observations.delete(key);
        releasePlacement();
        if (scaffoldPlacementTails.get(bot) === currentPlacement) scaffoldPlacementTails.delete(bot);
        releaseGate();
        if (wait) finishOwnedWait(wait, { outcome: confirmed ? 'confirmed' : 'unconfirmed', endedAt: new Date().toISOString() });
    }
}

class NavigationScaffoldUnconfirmedError extends Error {
    constructor(position, block, message) {
        super(message);
        this.name = 'NavigationScaffoldUnconfirmedError';
        this.code = 'scaffold_unconfirmed';
        this.position = point(position);
        this.block = block;
    }
}

function ensureNavigationObservation(bot) {
    if (unresolvedNavigationCells.has(bot)) return;
    const unresolved = new Map();
    const observations = new Map();
    unresolvedNavigationCells.set(bot, unresolved);
    activeNavigationObservations.set(bot, observations);
    bot.on('blockUpdate', (_oldBlock, newBlock) => {
        if (!newBlock?.position) return;
        const key = positionKey(newBlock.position);
        const observation = observations.get(key);
        if (observation) observation.revision++;
        unresolved.delete(key);
    });
}

function markNavigationCellUnconfirmed(bot, position, block, reason) {
    ensureNavigationObservation(bot);
    const entry = Object.freeze({ ...point(position), block, reason });
    unresolvedNavigationCells.get(bot).set(positionKey(position), entry);
}

export async function awaitNavigationPlacementSettled(bot) {
    const scaffoldPending = scaffoldPlacementTails.get(bot);
    const pending = navigationEditPromises.get(bot);
    if (scaffoldPending) await scaffoldPending;
    while (pending?.size) await Promise.allSettled([...pending]);
}

function placementNotAttempted(message) {
    const error = new Error(message);
    error.navigationPlacementAttempted = false;
    return error;
}

async function waitForScaffoldClearance(bot, position) {
    const feet = () => bot.entity.position;
    const sameColumn = () => Math.floor(feet().x) === position.x && Math.floor(feet().z) === position.z;
    const height = Number.isFinite(bot.entity.height) && bot.entity.height > 0 ? bot.entity.height : 1.8;
    const mustClear = sameColumn() && feet().y < position.y + NAVIGATION_SCAFFOLD_CLEARANCE_HEIGHT
        && feet().y + height > position.y;
    if (!mustClear) return;
    const clear = () => !sameColumn() || feet().y >= position.y + NAVIGATION_SCAFFOLD_CLEARANCE_HEIGHT
        || feet().y + height <= position.y;

    const startedAt = Date.now();
    const wait = beginOwnedWait({ phase: 'navigation', reason: 'scaffold-player-clearance',
        timeoutMs: NAVIGATION_SCAFFOLD_CLEARANCE_TIMEOUT_MS, startedAt: new Date(startedAt).toISOString() });
    const restoreJump = !bot.getControlState?.('jump');
    const maintainJump = () => {
        if (!bot.getControlState?.('jump')) bot.setControlState?.('jump', true);
    };
    if (restoreJump) {
        // Pathfinder may clear controls on its next physics tick while it
        // replans around the optimistic placement update. Keep jump held only
        // for this bounded clearance wait, then remove the listener below.
        bot.on?.('physicsTick', maintainJump);
        bot.setControlState?.('jump', true);
    }
    try {
        while (!clear()) {
            if (navigationCancelled(bot)) throw placementNotAttempted('Action cancelled while waiting for scaffold clearance.');
            if (Date.now() - startedAt >= NAVIGATION_SCAFFOLD_CLEARANCE_TIMEOUT_MS) {
                throw placementNotAttempted(`Player did not clear scaffold target ${position} before the deadline.`);
            }
            await new Promise(resolve => setTimeout(resolve, 25));
            if (clear()) markOwnedWaitProgress(wait);
        }
    } finally {
        if (restoreJump) bot.removeListener?.('physicsTick', maintainJump);
        if (restoreJump) bot.setControlState?.('jump', false);
        finishOwnedWait(wait, { outcome: clear() ? 'cleared' : 'cancelled', endedAt: new Date().toISOString() });
    }
}

export async function withEmergencyNavigation(bot, policy, body) {
    const context = policyStorage.getStore();
    if (context?.bot !== bot) return runWithNavigationPolicy(bot, policy, body);
    context.emergencyPolicy = policy;
    try { return await body(); }
    finally { context.emergencyPolicy = null; }
}

export async function runWithNavigationPolicy(bot, policy, body) {
    const context = { bot, policy, edits: [], scaffolds: [], unconfirmedScaffolds: [], confirmedScaffoldCount: 0,
        arrivals: [], segment: null, active: true, goal: null };
    const pathfinder = bot.pathfinder;
    const originalSetGoal = pathfinder?.setGoal;
    const ownedSetGoal = typeof originalSetGoal === 'function' ? function (goal, ...args) {
        const activeContext = policyStorage.getStore();
        if (activeContext?.bot === bot) activeContext.goal = goal;
        return originalSetGoal.call(this, goal, ...args);
    } : null;
    if (ownedSetGoal) pathfinder.setGoal = ownedSetGoal;
    let result, failure;
    try {
        result = await policyStorage.run(context, async () => {
            try { return await body(); }
            finally {
                context.active = false;
                if (context.goal && pathfinder?.goal === context.goal) pathfinder.setGoal(null);
                if (ownedSetGoal && pathfinder.setGoal === ownedSetGoal) pathfinder.setGoal = originalSetGoal;
            }
        });
    }
    catch (error) { failure = error; }
    navigationSnapshots.set(bot, context);
    const cancelled = navigationCancelled(bot) || result?.status === 'cancelled';
    if (failure) throw failure;
    if (cancelled && result !== false && result?.status !== 'cancelled') throw new Error('Action was cancelled before the navigation policy settled.');
    return result;
}

export function normalizeNavigationPolicy(value = {}) {
    if (value.scaffold != null && !['forbid', 'leave'].includes(value.scaffold)) {
        throw new TypeError(`Unsupported navigation scaffold policy: ${value.scaffold}`);
    }
    return {
        allowDig: value.allowDig ?? false,
        scaffold: value.scaffold ?? 'forbid',
        scaffoldBlocks: value.scaffoldBlocks ?? ['dirt', 'cobblestone'],
    };
}

export async function trackNavigationSegment(bot, body, { workTarget = null } = {}) {
    const context = policyStorage.getStore();
    if (!context || context.bot !== bot) return body();
    if (context.segment) {
        if (workTarget) context.segment.workTargets.push(workTarget);
        try { return await body(); }
        finally {
            if (workTarget) context.segment.workTargets.pop();
        }
    }
    const originalDig = bot.dig;
    const originalPlace = bot.placeBlock;
    const originalEquip = bot.equip;
    const segment = context.segment = { workTargets: workTarget ? [workTarget] : [], pendingPlacements: new Set() };
    const runInCapturedContext = AsyncLocalStorage.snapshot();
    const ownPlacement = (taskFactory, { gate = true } = {}) => {
        const releaseGate = gate ? beginNavigationEdit(bot) : () => {};
        const task = Promise.resolve().then(() => runInCapturedContext(taskFactory)).finally(releaseGate);
        let pending = navigationEditPromises.get(bot);
        if (!pending) navigationEditPromises.set(bot, pending = new Set());
        pending.add(task);
        segment.pendingPlacements.add(task);
        runInCapturedContext(() => registerOwnedPromise(task));
        task.then(() => {
            segment.pendingPlacements.delete(task);
            pending.delete(task);
        }, () => {
            segment.pendingPlacements.delete(task);
            pending.delete(task);
        });
        return task;
    };
    const equip = function (...args) {
        return ownPlacement(async () => {
            if (!context.active) throw new Error('Navigation policy ended before the next edit.');
            if (navigationCancelled(bot)) throw new Error('Action cancelled before the next navigation edit.');
            const result = await originalEquip.call(this, ...args);
            if (navigationCancelled(bot)) throw new Error('Action cancelled after equipping; no route placement was started.');
            return result;
        });
    };
    const dig = function (block, ...args) {
        const workTargetDig = segment.workTargets.some(target => ['x', 'y', 'z'].every(axis => block.position[axis] === target[axis]));
        return ownPlacement(async () => {
        if (!context.active) throw new Error('Navigation policy ended before the next edit.');
        if (navigationCancelled(bot)) throw new Error('Action cancelled before the next navigation edit.');
        if (workTargetDig) {
            return originalDig.call(this, block, ...args);
        }
        if ((context.emergencyPolicy ?? context.policy).allowDig !== true) throw new Error('Navigation policy forbids digging route blocks.');
        const protection = bot.navigationProtection;
        const protectedArea = protection?.areaAt?.(block.position);
        if (protectedArea || protection?.contains?.(block.position) === true) {
            throw new Error(`Protected area ${protectedArea?.name ?? 'unknown'} forbids digging route blocks.`);
        }
        const result = await originalDig.call(this, block, ...args);
        const observed = bot.blockAt(block.position);
        if (!observed || observed.type !== 0) throw new Error('Route excavation was not server-confirmed.');
        const edit = { kind: 'dug', block: block.name, position: point(block.position) };
        context.scaffolds = context.scaffolds.filter(scaffold => positionKey(scaffold.position) !== positionKey(edit.position));
        context.edits.push(edit);
        recordConfirmation({ phase: 'navigation', quantity: 1, unit: 'block', target: { block: block.name, position: edit.position },
            evidence: 'server-observed route block removal' });
        return result;
        }, { gate: !workTargetDig });
    };
    const place = function (reference, face, ...args) {
        return ownPlacement(async () => {
        if (!context.active) throw new Error('Navigation policy ended before the next edit.');
        if (navigationCancelled(bot)) throw new Error('Action cancelled before the next navigation edit.');
        const policy = context.emergencyPolicy ?? context.policy;
        if (policy.scaffold === 'forbid') throw new Error('Navigation policy forbids scaffolding.');
        const blockName = bot.heldItem?.name;
        if (!policy.scaffoldBlocks.includes(blockName)) throw new Error(`Navigation policy forbids scaffold block ${blockName ?? 'unknown'}.`);
        const target = reference.position.plus(face).floored();
        if (navigationUnconfirmedAt(bot, target)) {
            const error = new NavigationScaffoldUnconfirmedError(target, blockName,
                `Scaffold target ${positionKey(target)} remains unresolved from an earlier placement.`);
            error.navigationPlacementAttempted = false;
            throw error;
        }
        const protection = bot.navigationProtection;
        const protectedArea = protection?.areaAt?.(target);
        if (protectedArea || protection?.contains?.(target) === true) {
            throw placementNotAttempted(`Protected area ${protectedArea?.name ?? 'unknown'} forbids scaffolding.`);
        }
        const observedTarget = bot.blockAt(target);
        const targetName = observedTarget?.name;
        if (!observedTarget || targetName === 'lava' || targetName === 'flowing_lava') {
            throw placementNotAttempted('Navigation cannot place a scaffold into an unknown or lava-filled cell.');
        }
        if (bot.pathfinder?.isWaterFilled?.(observedTarget) === true) {
            const feet = bot.entity.position.floored();
            const bodyHeight = Number.isFinite(bot.entity.height) && bot.entity.height > 0 ? bot.entity.height : 1.8;
            const headOffset = Math.max(1, Math.ceil(bodyHeight - 0.01) - 1);
            const overlapsBody = target.x === feet.x && target.z === feet.z && target.y >= feet.y && target.y <= feet.y + headOffset;
            const waterAllowed = context.emergencyPolicy != null || bot.pathfinder.movements?.allowWaterScaffold === true;
            if (overlapsBody || !waterAllowed) {
                throw placementNotAttempted(overlapsBody
                    ? 'Navigation cannot place a scaffold into the bot body.'
                    : 'Navigation scaffold policy does not allow placement into water.');
            }
        }
        let placement;
        try {
            placement = await placeAndConfirmNavigationScaffold(bot, target, blockName,
                () => {
                    try {
                        if (!context.active) throw placementNotAttempted('Navigation policy ended before the next edit.');
                        if (navigationCancelled(bot)) throw placementNotAttempted('Action cancelled before the next navigation edit.');
                        const freshReference = bot.blockAt(reference.position);
                        if (!freshReference || freshReference.type === 0) throw placementNotAttempted('Scaffold support block is no longer available.');
                        return originalPlace.call(this, freshReference, face, ...args);
                    } catch (error) {
                        if (error.navigationPlacementAttempted !== false) error.navigationPlacementAttempted = false;
                        throw error;
                    }
                }, () => bot.lookAt(reference.position.offset(
                    0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)));
        } catch (error) {
            if (isNavigationScaffoldUnconfirmed(error) && error.navigationPlacementAttempted !== false) {
                context.unconfirmedScaffolds.push({ ...point(target), block: blockName,
                    reason: 'Scaffold placement was attempted but server confirmation was not observed.' });
            }
            throw error;
        }
        const observed = placement.block;
        const position = point(target);
        context.scaffolds = context.scaffolds.filter(scaffold => positionKey(scaffold.position) !== positionKey(position));
        context.scaffolds.push({ position, block: blockName, stateId: observed.stateId });
        context.confirmedScaffoldCount++;
        const edit = { kind: 'scaffold_placed', block: blockName, position };
        context.edits.push(edit);
        recordConfirmation({ phase: 'navigation', quantity: 1, unit: 'block', target: { block: blockName, position },
            evidence: 'server-confirmed route scaffold placement' });
        for (const callback of navigationScaffoldSettledCallbacks.get(bot) ?? []) {
            if (context.active) await callback({ bot, context, scaffold: context.scaffolds.at(-1) });
        }
        if (navigationCancelled(bot)) throw new Error('Action cancelled after the scaffold placement was server-confirmed.');
        return placement.result;
        });
    };
    bot.dig = dig;
    bot.placeBlock = place;
    bot.equip = equip;
    try { return await body(); }
    finally {
        while (segment.pendingPlacements.size) await Promise.allSettled([...segment.pendingPlacements]);
        if (bot.dig === dig) bot.dig = originalDig;
        if (bot.placeBlock === place) bot.placeBlock = originalPlace;
        if (bot.equip === equip) bot.equip = originalEquip;
        context.segment = null;
    }
}

export function recordNavigationArrival(bot) {
    const context = policyStorage.getStore();
    if (context?.bot === bot) context.arrivals.push(point(bot.entity.position));
}

function point(position) { return { x: position.x, y: position.y, z: position.z }; }
function positionKey(position) { return `${position.x},${position.y},${position.z}`; }
function navigationCancelled(bot) {
    return !!bot.interrupt_code || !!operationContext()?.signal?.aborted || !!bot.getActionCancellationContext?.()?.signal?.aborted;
}
