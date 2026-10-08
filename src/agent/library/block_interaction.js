import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';

export const BLOCK_INTERACTION_REACH = 4.5;
const STANDING_EYE_HEIGHT = 1.62;
const SNEAK_EYE_HEIGHT = 1.27;
const MAX_INTERACTION_RAYS = 192;
const FACE_SAMPLES = [0.5, 0.05, 0.95, 0.25, 0.75];
const SELECTION_CUBE = [[0, 0, 0, 1, 1, 1]];
const EMPTY_NAMES = new Set(['air', 'cave_air', 'void_air', 'water', 'lava']);
const FACE_VECTORS = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];

export function interactionEye(bot) {
    return bot.entity.position.offset(0, bot.entity.eyeHeight ??
        (bot.getControlState?.('sneak') ? SNEAK_EYE_HEIGHT : STANDING_EYE_HEIGHT), 0);
}

export function interactionFaceVector(face) {
    const v = FACE_VECTORS[face];
    if (!v) throw new Error(`Invalid interaction face: ${face}`);
    return new Vec3(...v);
}

export function currentViewDirection(bot) {
    const { yaw, pitch } = bot.entity;
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return null;
    return new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
}

function samePosition(a, b) {
    return a && b && a.x === b.x && a.y === b.y && a.z === b.z;
}

function shapesFor(block) {
    if (block.shapes?.length) return block.shapes;
    // Native digging also accepts shapeless, diggable plants. Use a target-only
    // selection cube; other shapeless blocks remain transparent to the ray.
    return block.diggable && !EMPTY_NAMES.has(block.name) ? SELECTION_CUBE : [];
}

function outcome(status, reason, extra = {}) {
    return { status, aim: null, face: null, distance: null, reason, ...extra };
}

// Use the installed world's ray iterator and shape intersections. WorldSync
// otherwise skips unloaded cells, which must not be mistaken for visible air.
function trace(bot, block, eye, direction, reach) {
    let unknown = false;
    const view = Object.create(bot.world);
    view.getBlock = p => {
        const b = bot.blockAt(p);
        if (!b) unknown = true;
        return b;
    };
    let hit;
    try {
        hit = bot.world.raycast.call(view, eye, direction, reach, (candidate, iterator) => {
            const shapes = samePosition(candidate.position, block.position) ? shapesFor(candidate) : candidate.shapes;
            const intersection = iterator.intersect(shapes ?? [], candidate.position);
            if (!intersection) return false;
            candidate.face = intersection.face;
            candidate.intersect = intersection.pos;
            return true;
        });
    } catch {
        return outcome('unknown', 'World raycast is unavailable.');
    }
    if (unknown) return outcome('unknown', 'Ray crosses unloaded blocks.');
    if (hit && samePosition(hit.position, block.position) && hit.intersect && Number.isInteger(hit.face)) {
        const distance = eye.distanceTo(hit.intersect);
        if (distance <= reach) return { status: 'ready', aim: hit.intersect.clone(), face: hit.face, distance, reason: null };
    }
    return outcome('blocked', 'No reachable surface aim point found.',
        hit?.position ? { obstruction: { ...hit.position } } : {});
}

export function resolveBlockInteraction(bot, block, { eye = interactionEye(bot), reach = BLOCK_INTERACTION_REACH, direction = null } = {}) {
    if (!block?.position || !bot.blockAt(block.position)) return outcome('unknown', 'Target is not loaded.');
    if (typeof bot.world?.raycast !== 'function') return outcome('unknown', 'World raycast is unavailable.');
    if (!Number.isFinite(reach) || reach <= 0) throw new RangeError('Interaction reach must be positive and finite.');
    const shapes = shapesFor(block);
    if (!shapes.length) return outcome('blocked', 'Target has no interactable surface.');
    if (shapes === SELECTION_CUBE && samePosition(
        { x: Math.floor(eye.x), y: Math.floor(eye.y), z: Math.floor(eye.z) }, block.position)) {
        // An eye inside shapeless tall grass has no outward-facing candidate.
        // Native's replaceable-plant center fallback remains valid in this
        // already-loaded target cell; no other voxel lies before the target.
        const aim = block.position.offset(0.5, 0.5, 0.5);
        const distance = eye.distanceTo(aim);
        return distance <= reach ? { status: 'ready', aim, face: 1, distance, reason: null }
            : outcome('blocked', 'Plant aim point is out of reach.');
    }
    if (direction) {
        if (!direction.norm()) return outcome('unknown', 'Interaction view direction is unknown.');
        return trace(bot, block, eye, direction.normalize(), reach);
    }
    const faces = [];
    for (const shape of shapes) {
        const nearest = new Vec3(...['x', 'y', 'z'].map((axis, i) =>
            Math.max(block.position[axis] + shape[i], Math.min(eye[axis], block.position[axis] + shape[i + 3]))));
        if (eye.distanceTo(nearest) > reach) continue;
        for (let axis = 0; axis < 3; axis++) {
            const name = ['x', 'y', 'z'][axis];
            const min = block.position[name] + shape[axis], max = block.position[name] + shape[axis + 3];
            if (eye[name] >= min && eye[name] <= max) continue;
            faces.push({ shape, axis, side: eye[name] < min ? axis : axis + 3 });
        }
    }
    let attempted = 0, unknown = null, blocked = null;
    // Try all face centers first, then the bounded interior/edge samples.
    for (const a of FACE_SAMPLES) for (const b of FACE_SAMPLES) for (const { shape, axis, side } of faces) {
        if (++attempted > MAX_INTERACTION_RAYS) return unknown ?? blocked ?? outcome('blocked', 'Surface aim search limit reached.');
        const coordinates = [0, 0, 0];
        coordinates[axis] = shape[side];
        const others = [0, 1, 2].filter(i => i !== axis);
        coordinates[others[0]] = shape[others[0]] + (shape[others[0] + 3] - shape[others[0]]) * a;
        coordinates[others[1]] = shape[others[1]] + (shape[others[1] + 3] - shape[others[1]]) * b;
        const aim = block.position.offset(...coordinates);
        const delta = aim.minus(eye);
        if (!delta.norm()) continue;
        const result = trace(bot, block, eye, delta.normalize(), reach);
        if (result.status === 'ready') return result;
        if (result.status === 'unknown') unknown = result;
        else if (result.obstruction || !blocked) blocked = result;
    }
    return unknown ?? blocked ?? outcome('blocked', 'No reachable surface aim point found.');
}

export function makeBlockInteractionGoal(bot, position, { reach = BLOCK_INTERACTION_REACH } = {}) {
    const goal = new pf.goals.GoalLookAtBlock(position, bot.world, { reach,
        entityHeight: bot.entity.eyeHeight ?? STANDING_EYE_HEIGHT });
    goal.isEnd = node => {
        const eye = new Vec3(node.x + 0.5, node.y, node.z + 0.5).offset(0,
            bot.entity.eyeHeight ?? (bot.getControlState?.('sneak') ? SNEAK_EYE_HEIGHT : STANDING_EYE_HEIGHT), 0);
        return resolveBlockInteraction(bot, bot.blockAt(position), { eye, reach }).status === 'ready';
    };
    return goal;
}
