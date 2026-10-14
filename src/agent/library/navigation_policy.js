import { AsyncLocalStorage } from 'node:async_hooks';
import { operationContext } from './operation_context.js';

const policyStorage = new AsyncLocalStorage();
let cleanupOwnedScaffolds = async () => [];

export function navigationPolicy() { return policyStorage.getStore()?.policy ?? null; }

export function registerNavigationCleanup(cleanup) {
    const previous = cleanupOwnedScaffolds;
    cleanupOwnedScaffolds = cleanup;
    return previous;
}

export async function runWithNavigationPolicy(bot, policy, body) {
    if (policy.scaffold !== 'forbid' && !policy.scaffoldBlocks.some(name =>
        (bot.inventory?.items?.() ?? []).some(item => item.name === name && item.count > 0))) {
        throw new Error('Navigation scaffold policy requires an allowed block in inventory.');
    }
    const context = { bot, policy, edits: [], scaffolds: [], arrivals: [], segment: null };
    let result, failure;
    try { result = await policyStorage.run(context, body); }
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
    const reached = context.arrivals.at(-1) ?? null;
    const workResult = failure ? { error: String(failure.message ?? failure) } : result;
    const workSucceeded = !failure && result !== false && result?.ok !== false
        && (result?.status === undefined || result?.ok === true || ['reached', 'complete', 'ready'].includes(result.status));
    const cancelled = navigationCancelled(bot) || result?.status === 'cancelled';
    const ok = workSucceeded && !cancelled
        && !(policy.scaffold === 'temporary' && context.cleanupRequired.length);
    return {
        ok, status: ok ? 'reached' : cancelled ? 'cancelled' : 'blocked',
        result: workResult, arrival: reached, edits: context.edits, cleanupRequired: context.cleanupRequired,
        ...(cleanupFailure ? { cleanupFailure } : {}),
        reason: ok ? 'Navigation policy settled with the requested work result.'
            : policy.scaffold === 'temporary' && context.cleanupRequired.length
                ? `Work settled, but ${context.cleanupRequired.length} temporary scaffold(s) remain.`
                : 'The requested work or navigation did not complete.',
    };
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
    const segment = context.segment = { workTargets: workTarget ? [workTarget] : [] };
    const dig = async function (block, ...args) {
        if (navigationCancelled(bot)) throw new Error('Action cancelled before the next navigation edit.');
        if (segment.workTargets.some(target => ['x', 'y', 'z'].every(axis => block.position[axis] === target[axis]))) {
            return originalDig.call(this, block, ...args);
        }
        if (context.policy.allowDig !== true) throw new Error('Navigation policy forbids digging route blocks.');
        const result = await originalDig.call(this, block, ...args);
        const observed = bot.blockAt(block.position);
        if (!observed || observed.type !== 0) throw new Error('Route excavation was not server-confirmed.');
        context.edits.push({ kind: 'dug', block: block.name, position: point(block.position) });
        return result;
    };
    const place = async function (reference, face, ...args) {
        if (navigationCancelled(bot)) throw new Error('Action cancelled before the next navigation edit.');
        if (context.policy.scaffold === 'forbid') throw new Error('Navigation policy forbids scaffolding.');
        const blockName = bot.heldItem?.name;
        if (!context.policy.scaffoldBlocks.includes(blockName)) throw new Error(`Navigation policy forbids scaffold block ${blockName ?? 'unknown'}.`);
        const target = reference.position.plus(face).floored();
        const result = await originalPlace.call(this, reference, face, ...args);
        const observed = bot.blockAt(target);
        if (!observed || observed.name !== blockName) throw new Error('Route scaffold placement was not server-confirmed.');
        const position = point(target);
        context.scaffolds.push({ position, block: blockName, stateId: observed.stateId });
        context.edits.push({ kind: 'scaffold_placed', block: blockName, position });
        return result;
    };
    bot.dig = dig;
    bot.placeBlock = place;
    try { return await body(); }
    finally {
        if (bot.dig === dig) bot.dig = originalDig;
        if (bot.placeBlock === place) bot.placeBlock = originalPlace;
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
