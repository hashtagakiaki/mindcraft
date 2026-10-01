import { goToPosition, tendNearbyFarm } from './library/skills.js';
import Vec3 from 'vec3';

const FOOD_STORAGE_PURPOSE = 'food_storage';
const PLACE_APPROACH_DISTANCE = 2;
const STORAGE_QUERY_LIMIT = 100;

function dimensionId(value) {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const dimension = value.toLowerCase();
    if (!['overworld', 'the_nether', 'the_end'].includes(dimension) && !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(dimension)) return null;
    return dimension.includes(':') ? dimension : `minecraft:${dimension}`;
}

function validPosition(position) {
    return position && ['x', 'y', 'z'].every(axis => Number.isFinite(position[axis]));
}

function confirmation(status, details = {}) {
    return { ok: false, status, confirmationRequired: true, ...details };
}

function relationKey(snapshot) {
    const relation = snapshot?.relation;
    return relation ? `${relation.toPlaceId}:${relation.revision}:${relation.source}` : null;
}

export function createPlaceActions(agent, client) {
    if (!agent || !client) throw new TypeError('createPlaceActions requires an agent and place client');

    async function readBotAndDimension(place) {
        const bot = agent.bot;
        if (!bot) return { error: confirmation('bot_unavailable') };
        const currentDimension = dimensionId(bot.game?.dimension);
        const savedDimension = dimensionId(place?.dimension);
        if (!currentDimension || !savedDimension) return { error: confirmation('dimension_unknown') };
        if (currentDimension !== savedDimension) {
            return { error: confirmation('dimension_mismatch', { expectedDimension: savedDimension, currentDimension }) };
        }
        return { bot, dimension: currentDimension };
    }

    async function goTo(placeId) {
        const snapshot = await client.inspectPlace(placeId);
        const place = snapshot?.place;
        if (!place) return confirmation('place_missing', { placeId });
        if (place.existence === 'missing') return confirmation('place_marked_missing', { placeId });
        const { bot, error } = await readBotAndDimension(place);
        if (error) return error;
        const target = place.approachPosition ?? place.position;
        if (!validPosition(target)) return confirmation('saved_position_invalid', { placeId });
        const reached = await goToPosition(bot, target.x, target.y, target.z, PLACE_APPROACH_DISTANCE);
        const status = reached ? 'visited' : 'unreachable';
        let recordError;
        try {
            const ack = await client.recordPlaceVisit({ placeId, status });
            if (!ack?.ok) throw new Error('visit acknowledgement was not successful');
        } catch (cause) {
            recordError = cause?.message ?? String(cause);
        }
        return { ok: reached, status, placeId, ...(recordError ? { recordError } : {}) };
    }

    async function resolveFarmStorage(farmSnapshot, farm) {
        if (farmSnapshot.relation) {
            const target = farmSnapshot.outputStorage;
            if (!target || target.kind !== 'storage' || target.existence === 'missing' || target.dimension !== farm.dimension || !validPosition(target.position)) {
                return { error: confirmation('explicit_storage_target_missing', { farmId: farm.id, storageId: farmSnapshot.relation.toPlaceId }) };
            }
            return { place: target, relation: farmSnapshot.relation, initialRelationKey: relationKey(farmSnapshot) };
        }

        const purposes = [...new Set([FOOD_STORAGE_PURPOSE, ...(farm.purposes ?? [])])];
        const results = await Promise.all(purposes.map(purpose => client.queryPlaces({
            kind: 'storage', purpose, dimension: farm.dimension, limit: STORAGE_QUERY_LIMIT
        })));
        const candidates = new Map(results.flat().filter(place => place.kind === 'storage' && place.existence !== 'missing' && place.dimension === farm.dimension && validPosition(place.position)).map(place => [place.id, place]));
        if (candidates.size !== 1) {
            return { error: confirmation(candidates.size ? 'storage_candidates_ambiguous' : 'storage_candidate_missing', {
                farmId: farm.id, candidateIds: [...candidates.keys()]
            }) };
        }
        return { place: [...candidates.values()][0], relation: null, initialRelationKey: null };
    }

    async function tendFarm(farmId, options = {}) {
        if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('tendFarm options must be an object');
        if (options.scope === 'radius' || options.radius != null) return confirmation('unsupported_saved_farm_scope', { farmId });
        const snapshot = await client.inspectPlace(farmId);
        const farm = snapshot?.place;
        if (!farm) return confirmation('farm_missing', { farmId });
        if (farm.kind !== 'farm') return confirmation('place_is_not_farm', { farmId, kind: farm.kind });
        if (farm.existence === 'missing') return confirmation('farm_marked_missing', { farmId });
        const { bot, error } = await readBotAndDimension(farm);
        if (error) return error;
        if (!validPosition(farm.position)) return confirmation('saved_farm_position_invalid', { farmId });

        const approach = farm.approachPosition ?? farm.position;
        if (!validPosition(approach)) return confirmation('saved_approach_position_invalid', { farmId });
        if (!await goToPosition(bot, approach.x, approach.y, approach.z, PLACE_APPROACH_DISTANCE)) {
            return { ok: false, status: 'farm_unreachable', farmId, harvested: 0, planted: 0, stored: 0 };
        }
        const dimensionAfterTravel = dimensionId(bot.game?.dimension);
        if (!dimensionAfterTravel || dimensionAfterTravel !== dimensionId(farm.dimension)) {
            return confirmation('dimension_changed_during_travel', { farmId, expectedDimension: dimensionId(farm.dimension), currentDimension: dimensionAfterTravel });
        }
        const farmBlock = bot.blockAt(new Vec3(Math.floor(farm.position.x), Math.floor(farm.position.y), Math.floor(farm.position.z)));
        if (!farmBlock) return confirmation('farm_unloaded', { farmId });
        const observationErrors = [];
        const observe = async (placeId, existence, availability) => {
            try {
                const ack = await client.updatePlaceObservation({ placeId, existence, availability });
                if (!ack?.ok) throw new Error('observation acknowledgement was not successful');
            } catch (cause) {
                observationErrors.push(cause?.message ?? String(cause));
            }
        };
        if (farmBlock.name !== 'farmland') {
            await observe(farmId, 'missing', 'missing');
            return confirmation('farm_target_missing_or_not_farmland', {
                farmId, blockName: farmBlock.name, ...(observationErrors.length ? { observationErrors } : {})
            });
        }
        await observe(farmId, 'observed', 'available');

        const initialStorage = await resolveFarmStorage(snapshot, farm);
        if (initialStorage.error) return { ...initialStorage.error, ...(observationErrors.length ? { observationErrors } : {}) };
        let depositTarget = null;
        let checkedSnapshot = null;

        const resolveChestPosition = async () => {
            const current = await client.inspectPlace(farmId);
            if (!current?.place) return { status: 'farm_missing' };
            const currentDimension = dimensionId(bot.game?.dimension);
            if (!currentDimension || currentDimension !== dimensionId(current.place.dimension)) return { status: 'dimension_mismatch' };
            const resolved = current.relation
                ? await resolveFarmStorage(current, current.place)
                : initialStorage.relation
                    ? { error: confirmation('explicit_storage_relation_missing', { farmId }) }
                    : initialStorage;
            if (resolved.error) return { status: resolved.error.status };
            depositTarget = resolved.place;
            checkedSnapshot = current;
            return { position: resolved.place.position };
        };

        const beforeFarmDeposit = async ({ position }) => {
            const current = await client.inspectPlace(farmId);
            if (!current?.place || !depositTarget || !checkedSnapshot) return false;
            const currentDimension = dimensionId(bot.game?.dimension);
            if (!currentDimension || currentDimension !== dimensionId(current.place.dimension)) return false;
            if (relationKey(current) !== relationKey(checkedSnapshot)) return false;
            const sameTarget = current.relation
                ? current.outputStorage?.id === depositTarget.id
                : !initialStorage.relation && initialStorage.place.id === depositTarget.id;
            if (!sameTarget) return false;
            const latestTarget = current.relation ? current.outputStorage : await client.getPlace(depositTarget.id);
            if (!latestTarget || latestTarget.kind !== 'storage' || latestTarget.existence === 'missing' ||
                latestTarget.dimension !== current.place.dimension || !validPosition(latestTarget.position) ||
                latestTarget.position.x !== depositTarget.position.x || latestTarget.position.y !== depositTarget.position.y || latestTarget.position.z !== depositTarget.position.z) return false;
            return position.x === depositTarget.position.x && position.y === depositTarget.position.y && position.z === depositTarget.position.z;
        };

        const onChestBlock = async ({ block }) => {
            if (!depositTarget || !block) return;
            const current = await client.inspectPlace(farmId);
            const currentDimension = dimensionId(bot.game?.dimension);
            if (!current?.place || !currentDimension || currentDimension !== dimensionId(current.place.dimension) ||
                relationKey(current) !== relationKey(checkedSnapshot)) return;
            const stillTarget = current.relation
                ? current.outputStorage?.id === depositTarget.id
                : !initialStorage.relation && initialStorage.place.id === depositTarget.id;
            if (!stillTarget) return;
            await observe(depositTarget.id,
                ['chest', 'trapped_chest'].includes(block.name) ? 'observed' : 'missing',
                ['chest', 'trapped_chest'].includes(block.name) ? 'available' : 'missing');
        };

        const farmOptions = { ...options };
        delete farmOptions.startPosition;
        delete farmOptions.chestPosition;
        delete farmOptions.resolveChestPosition;
        delete farmOptions.beforeFarmDeposit;
        delete farmOptions.onChestBlock;
        delete farmOptions.confirmStorage;
        delete farmOptions.includeStorageStatus;
        const result = await tendNearbyFarm(bot, {
            ...farmOptions,
            scope: options.scope ?? 'connected',
            startPosition: farm.position,
            resolveChestPosition,
            beforeFarmDeposit,
            onChestBlock,
            confirmStorage: true,
            includeStorageStatus: true
        });

        if (result.stored > 0) {
            let relationRecordError;
            try {
                const latest = await client.inspectPlace(farmId);
                if (latest?.relation) {
                    if (latest.relation.toPlaceId !== depositTarget?.id) throw new Error('storage relation changed after deposit');
                } else {
                    const ack = await client.setPlaceRelation({
                        fromPlaceId: farmId, type: 'output_storage', toPlaceId: depositTarget.id, source: 'observed'
                    }, latest?.revision);
                    if (!ack?.ok) throw new Error('relation acknowledgement was not successful');
                }
            } catch (cause) {
                relationRecordError = cause?.message ?? String(cause);
            }
            return {
                ok: true, status: result.storageStatus === 'partial_storage_failed' ? 'partial_storage_failed' : 'completed', farmId, storageId: depositTarget?.id,
                ...result,
                ...(observationErrors.length ? { observationErrors } : {}),
                ...(relationRecordError ? { relationRecordError, actionAlreadyCompleted: true } : {})
            };
        }

        return {
            ok: result.harvested > 0 || result.planted > 0,
            status: result.storageStatus === 'not_needed'
                ? (result.harvested > 0 || result.planted > 0 ? 'completed_without_storage' : 'no_work')
                : result.storageStatus ?? (result.harvested > 0 || result.planted > 0 ? 'completed_without_storage' : 'no_work'),
            farmId, storageId: depositTarget?.id, ...result,
            ...(observationErrors.length ? { observationErrors } : {})
        };
    }

    return { goTo, tendFarm };
}
