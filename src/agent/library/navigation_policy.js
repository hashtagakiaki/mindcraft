import { AsyncLocalStorage } from 'node:async_hooks';
import { beginOwnedWait, finishOwnedWait, markOwnedWaitProgress, operationContext, registerOwnedPromise } from './operation_context.js';

const policyStorage = new AsyncLocalStorage();
let cleanupOwnedScaffolds = async () => [];
const NAVIGATION_PLACEMENT_CONFIRM_TIMEOUT_MS = 2_000;
const NAVIGATION_SCAFFOLD_CLEARANCE_TIMEOUT_MS = 5_000;
export const NAVIGATION_SCAFFOLD_CLEARANCE_HEIGHT = 1.1;
const pendingScaffoldPlacements = new WeakMap();
const scaffoldPlacementTails = new WeakMap();
const pendingNavigationEdits = new WeakMap();
const navigationScaffoldSettledCallbacks = new WeakMap();

export function navigationPolicy() { return policyStorage.getStore()?.policy ?? null; }
export function navigationScaffoldsPlaced(bot) {
    const context = policyStorage.getStore();
    return context?.bot === bot ? context.scaffolds.length : 0;
}
export function navigationScaffoldPlacementPending(bot) {
    return scaffoldPlacementTails.has(bot) || (pendingNavigationEdits.get(bot) ?? 0) > 0;
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

// Holds the pathfinder's movement loop while an owned route edit is unsettled, so
// it neither replans nor starts another edit before the server confirms the last.
export function navigationEditGatePlugin(bot) {
    bot.pathfinder.tickPaused = () => navigationScaffoldPlacementPending(bot);
}

export function registerNavigationCleanup(cleanup) {
    const previous = cleanupOwnedScaffolds;
    cleanupOwnedScaffolds = cleanup;
    return previous;
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
    const key = `${position.x},${position.y},${position.z}`;
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
    const previousPlacement = scaffoldPlacementTails.get(bot) ?? Promise.resolve(true);
    let releasePlacement;
    const currentPlacement = new Promise(resolve => { releasePlacement = resolve; });
    scaffoldPlacementTails.set(bot, currentPlacement);
    try {
        // Pathfinder can replan while an earlier placement's optimistic block
        // update is still in flight. Serialize all owned scaffold attempts for
        // this bot, not just attempts targeting the same coordinate.
        const previousConfirmed = await previousPlacement;
        if (!previousConfirmed) throw placementNotAttempted('Navigation stopped after an unconfirmed scaffold placement.');
        if (navigationCancelled(bot)) throw placementNotAttempted('Action cancelled before the next navigation edit.');
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
            throw new Error(`Scaffold placement at ${key} was not server-confirmed before the deadline${detail}.`);
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
        releasePlacement(confirmed);
        if (scaffoldPlacementTails.get(bot) === currentPlacement) scaffoldPlacementTails.delete(bot);
        if (wait) finishOwnedWait(wait, { outcome: confirmed ? 'confirmed' : 'unconfirmed', endedAt: new Date().toISOString() });
    }
}

export async function awaitNavigationPlacementSettled(bot) {
    const pending = scaffoldPlacementTails.get(bot);
    if (pending && !await pending) throw new Error('Navigation stopped after an unconfirmed scaffold placement.');
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

export async function runWithNavigationPolicy(bot, policy, body) {
    const context = { bot, policy, edits: [], scaffolds: [], unconfirmedScaffolds: [], arrivals: [], segment: null, active: true, goal: null };
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
    let cleanupFailure = null;
    if (policy.scaffold === 'temporary' && !navigationCancelled(bot) && result?.status !== 'cancelled') {
        try { context.cleanupRequired = await cleanupOwnedScaffolds(bot, context); }
        catch (error) {
            cleanupFailure = String(error?.message ?? error);
            context.cleanupRequired = inspectRemainingScaffolds(bot, context.scaffolds, `Cleanup failed: ${cleanupFailure}`);
            if (!context.cleanupRequired.length) context.cleanupRequired.push({ reason: `Cleanup failed: ${cleanupFailure}` });
        }
    } else {
        context.cleanupRequired = inspectRemainingScaffolds(bot, context.scaffolds,
            policy.scaffold === 'temporary' ? 'Action cancelled before cleanup began.' : 'Scaffold policy allows this placement to remain.');
    }
    context.cleanupRequired.push(...context.unconfirmedScaffolds);
    const cancelled = navigationCancelled(bot) || result?.status === 'cancelled';
    if (failure) throw failure;
    if (cancelled && result !== false && result?.status !== 'cancelled') throw new Error('Action was cancelled before the navigation policy settled.');
    if (context.unconfirmedScaffolds.length) throw new Error('A route scaffold placement was not server-confirmed.');
    if (cleanupFailure || policy.scaffold === 'temporary' && context.cleanupRequired.length) {
        throw new Error(cleanupFailure ?? `Work settled, but ${context.cleanupRequired.length} temporary scaffold(s) remain.`);
    }
    return result;
}

export function normalizeNavigationPolicy(value = {}) {
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
    const ownPlacement = (taskFactory, { gate = true } = {}) => {
        const releaseGate = gate ? beginNavigationEdit(bot) : () => {};
        const task = Promise.resolve().then(taskFactory).finally(releaseGate);
        segment.pendingPlacements.add(task);
        registerOwnedPromise(task);
        task.then(() => segment.pendingPlacements.delete(task), () => segment.pendingPlacements.delete(task));
        return task;
    };
    const equip = function (...args) {
        return ownPlacement(async () => {
            await awaitNavigationPlacementSettled(bot);
            if (!context.active) throw new Error('Navigation policy ended before the next edit.');
            if (navigationCancelled(bot)) throw new Error('Action cancelled before the next navigation edit.');
            if (context.unconfirmedScaffolds.length) throw new Error('Navigation stopped after an unconfirmed scaffold placement.');
            return originalEquip.call(this, ...args);
        });
    };
    const dig = function (block, ...args) {
        const workTargetDig = segment.workTargets.some(target => ['x', 'y', 'z'].every(axis => block.position[axis] === target[axis]));
        return ownPlacement(async () => {
        await awaitNavigationPlacementSettled(bot);
        if (!context.active) throw new Error('Navigation policy ended before the next edit.');
        if (navigationCancelled(bot)) throw new Error('Action cancelled before the next navigation edit.');
        if (context.unconfirmedScaffolds.length) throw new Error('Navigation stopped after an unconfirmed scaffold placement.');
        if (workTargetDig) {
            return originalDig.call(this, block, ...args);
        }
        if (context.policy.allowDig !== true) throw new Error('Navigation policy forbids digging route blocks.');
        const result = await originalDig.call(this, block, ...args);
        const observed = bot.blockAt(block.position);
        if (!observed || observed.type !== 0) throw new Error('Route excavation was not server-confirmed.');
        context.edits.push({ kind: 'dug', block: block.name, position: point(block.position) });
        return result;
        }, { gate: !workTargetDig });
    };
    const place = function (reference, face, ...args) {
        return ownPlacement(async () => {
        if (!context.active) throw new Error('Navigation policy ended before the next edit.');
        if (navigationCancelled(bot)) throw new Error('Action cancelled before the next navigation edit.');
        if (context.unconfirmedScaffolds.length) throw new Error('Navigation stopped after an unconfirmed scaffold placement.');
        if (context.policy.scaffold === 'forbid') throw new Error('Navigation policy forbids scaffolding.');
        const blockName = bot.heldItem?.name;
        if (!context.policy.scaffoldBlocks.includes(blockName)) throw new Error(`Navigation policy forbids scaffold block ${blockName ?? 'unknown'}.`);
        const target = reference.position.plus(face).floored();
        let placement;
        try {
            placement = await placeAndConfirmNavigationScaffold(bot, target, blockName,
                () => {
                    try {
                        if (!context.active) throw placementNotAttempted('Navigation policy ended before the next edit.');
                        if (navigationCancelled(bot)) throw placementNotAttempted('Action cancelled before the next navigation edit.');
                        if (context.unconfirmedScaffolds.length) throw placementNotAttempted('Navigation stopped after an unconfirmed scaffold placement.');
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
            if (error.navigationPlacementAttempted !== false && !context.unconfirmedScaffolds.some(entry => ['x', 'y', 'z'].every(axis => entry[axis] === target[axis]))) {
                context.unconfirmedScaffolds.push({ ...point(target), block: blockName,
                    reason: 'Scaffold placement was attempted but not server-confirmed; target state is unknown.' });
            }
            throw error;
        }
        const observed = placement.block;
        const position = point(target);
        context.scaffolds.push({ position, block: blockName, stateId: observed.stateId });
        context.edits.push({ kind: 'scaffold_placed', block: blockName, position });
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
function inspectRemainingScaffolds(bot, scaffolds, reason) {
    const remaining = [];
    for (const scaffold of scaffolds) {
        const block = bot.blockAt(new bot.entity.position.constructor(scaffold.position.x, scaffold.position.y, scaffold.position.z));
        if (block?.type === 0) continue;
        remaining.push({ ...scaffold.position, block: scaffold.block,
            reason: block?.name === scaffold.block && (scaffold.stateId == null || block.stateId === scaffold.stateId)
                ? reason : 'Owned scaffold state changed or became unknown.' });
    }
    return remaining;
}
function navigationCancelled(bot) {
    return !!bot.interrupt_code || !!operationContext()?.signal?.aborted || !!bot.getActionCancellationContext?.()?.signal?.aborted;
}
