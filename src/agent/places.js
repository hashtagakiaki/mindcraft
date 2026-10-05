import { createPlaceActions } from './place_actions.js';
import settings from './settings.js';
import { Vec3 } from 'vec3';
import { trackSkill } from './library/operation_context.js';

const EMPTY_CONTEXT = 'No place has been selected in this session.';
const MAX_PLACE_SEARCH_RESULTS = 20;
const MAX_PROMPT_CANDIDATES = 5;
const PLACE_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const POINT_VERIFY_RADIUS = 3;
const CHEST_BLOCKS = new Set(['chest', 'trapped_chest']);

function normalizedDimension(bot) {
	const dimension = bot?.game?.dimension;
	if (typeof dimension !== 'string' || !dimension.trim()) throw new Error('The bot dimension is not available; place operation was not verified.');
	return dimension.includes(':') ? dimension : `minecraft:${dimension}`;
}

function currentPosition(bot) {
	const position = bot?.entity?.position;
	if (!position || !['x', 'y', 'z'].every((axis) => Number.isFinite(position[axis]))) {
		throw new Error('The bot current position is not available; place operation was not verified.');
	}
	return { x: position.x, y: position.y, z: position.z };
}

function describe(place) {
	const verifiedAt = place.lastVerifiedAt ?? place.recordedAt;
	const stale = !verifiedAt || Date.now() - Date.parse(verifiedAt) > PLACE_STALE_AFTER_MS;
	const verified = place.existence === 'observed' ? `observed ${verifiedAt ?? 'time unknown'}${stale ? ', stale' : ''}` : `unverified (${place.existence})`;
	return `${place.name} [${place.id}] (${place.kind}; ${place.dimension}; ${verified}) at ${place.position.x.toFixed(1)}, ${place.position.y.toFixed(1)}, ${place.position.z.toFixed(1)}`;
}

function matchesPlaceBlock(kind, block) {
	if (!block || ['air', 'cave_air', 'void_air', 'water', 'lava'].includes(block.name)) return false;
	if (kind === 'farm') return block.name === 'farmland';
	if (kind === 'storage') return CHEST_BLOCKS.has(block.name);
	if (kind === 'forest') return /(?:_log|_wood|_leaves)$/.test(block.name);
	if (kind === 'mine') return /(?:stone|deepslate|_ore)$/.test(block.name);
	if (kind === 'village') return /(?:bed|bell|composter|lectern|door|_log|_planks)$/.test(block.name);
	if (kind === 'base' || kind === 'resource') return block.boundingBox === 'block';
	return true;
}

export function createPlacesFacade(agent, client) {
	let selected = null;
	let searchCandidates = [];
	const enabled = () => Boolean(settings.place_memory_enabled && settings.place_world_id && client);
	const requireEnabled = () => {
		if (!enabled()) throw new Error('Persistent place memory is disabled; use the session bookmark commands instead.');
	};
	const actions = createPlaceActions(agent, client);
	const methods = {
		find: async (text, options = {}) => {
			requireEnabled();
			const bot = agent.bot;
			const dimension = options.dimension ?? normalizedDimension(bot);
			const current = bot?.entity?.position;
			const results = await client.queryPlaces({
				text,
				purpose: options.purpose,
				kind: options.kind,
				dimension,
				near: current ? { x: current.x, y: current.y, z: current.z } : undefined,
				nearDimension: dimension,
				existence: options.existence,
				staleBefore: options.staleBefore,
				limit: options.limit ?? MAX_PLACE_SEARCH_RESULTS
			});
			searchCandidates = results.slice(0, MAX_PROMPT_CANDIDATES);
			selected = results.length === 1 ? await client.inspectPlace(results[0].id) : null;
			return results.map(describe).join('\n') || 'No matching places in this dimension.';
		},
		inspect: async (placeId) => {
			requireEnabled();
			const result = await client.inspectPlace(placeId);
			if (!result) throw new Error(`No place with ID '${placeId}' exists.`);
			selected = result;
			return describe(result.place) + (result.outputStorage ? `\nOutput storage: ${describe(result.outputStorage)}` : '');
		},
		resolveAlias: async (alias) => {
			requireEnabled();
			let place = await client.resolvePlaceAlias(alias);
			if (!place && String(alias).trim().toLocaleLowerCase('en-US') === 'home') {
				const preferences = await client.getPlacePreferences();
				if (preferences.homePlaceId) place = await client.getPlace(preferences.homePlaceId);
			}
			if (!place) return null;
			selected = await client.inspectPlace(place.id);
			return selected;
		},
		goToAlias: async (alias) => {
			const result = await sdk.resolveAlias(alias);
			if (!result) throw new Error(`No personal place alias named '${alias}' was found.`);
			return sdk.goTo(result.place.id);
		},
		rememberHere: async (name, kind = 'other', purpose = '') => {
			requireEnabled();
			if (!['other', 'base'].includes(kind)) throw new Error(`A ${kind} requires a loaded target block; use places.rememberObservedAt(name, kind, purpose, position).`);
			const bot = agent.bot;
			const place = {
				name,
				kind,
				purposes: purpose ? [purpose] : [],
				dimension: normalizedDimension(bot),
				position: currentPosition(bot),
				source: 'observed',
				existence: 'observed',
				observedAt: new Date().toISOString()
			};
			const response = await client.rememberPlace(place, { alias: name });
			selected = await client.inspectPlace(response.value.id);
			return `Saved observed place: ${describe(response.value)}`;
		},
		rememberObservedAt: async (name, kind, purpose, position) => {
			requireEnabled();
			if (!position || !['x', 'y', 'z'].every((axis) => Number.isFinite(position[axis]))) throw new Error('Target coordinates must be finite x, y, z values.');
			const dimension = normalizedDimension(agent.bot);
			const blockPosition = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
			const block = agent.bot.blockAt(blockPosition);
			if (!block) throw new Error('The target block is not loaded; no observed place was recorded.');
			if (!matchesPlaceBlock(kind, block)) {
				throw new Error(`Loaded target block '${block.name}' does not match place kind '${kind}'; no observed place was recorded.`);
			}
			const response = await client.rememberPlace({
				name,
				kind,
				purposes: purpose ? [purpose] : [],
				dimension,
				position: { x: blockPosition.x, y: blockPosition.y, z: blockPosition.z },
				source: 'observed',
				existence: 'observed',
				observedAt: new Date().toISOString()
			}, { alias: name });
			selected = await client.inspectPlace(response.value.id);
			return `Saved observed place at loaded ${block.name}: ${describe(response.value)}`;
		},
		rememberReported: async (name, kind, purpose, position, dimension) => {
			requireEnabled();
			if (!position || !['x', 'y', 'z'].every((axis) => Number.isFinite(position[axis]))) throw new Error('Place coordinates must be finite x, y, z values.');
			const response = await client.rememberPlace({
				name,
				kind,
				purposes: purpose ? [purpose] : [],
				dimension: dimension ?? normalizedDimension(agent.bot),
				position: { x: position.x, y: position.y, z: position.z },
				source: 'user',
				existence: 'unverified'
			}, { alias: name });
			selected = await client.inspectPlace(response.value.id);
			return `Saved unverified place: ${describe(response.value)}`;
		},
		verify: async (placeId) => {
			requireEnabled();
			const record = await client.getPlace(placeId);
			if (!record) throw new Error(`No place with ID '${placeId}' exists.`);
			if (record.dimension !== normalizedDimension(agent.bot)) throw new Error(`Cannot verify a ${record.dimension} place while the bot is in ${normalizedDimension(agent.bot)}.`);
			if (record.kind === 'other' || record.kind === 'base') {
				const position = currentPosition(agent.bot);
				const distance = Math.hypot(position.x - record.position.x, position.y - record.position.y, position.z - record.position.z);
				if (distance > POINT_VERIFY_RADIUS) return { status: 'not_nearby', placeId, distance };
				const ack = await client.updatePlaceObservation({ placeId, existence: 'observed', observedAt: new Date().toISOString() });
				selected = await client.inspectPlace(placeId);
				return { ...ack, value: selected, status: 'observed_point' };
			}
			const block = agent.bot.blockAt(new Vec3(Math.floor(record.position.x), Math.floor(record.position.y), Math.floor(record.position.z)));
			if (!block) throw new Error('The place block is not loaded; no observation was recorded.');
			if (!matchesPlaceBlock(record.kind, block)) {
				const ack = await client.updatePlaceObservation({ placeId, existence: 'missing', observedAt: new Date().toISOString() });
				selected = await client.inspectPlace(placeId);
				return { ...ack, value: selected, status: 'missing', observedBlock: block.name };
			}
			const ack = await client.updatePlaceObservation({ placeId, existence: 'observed', observedAt: new Date().toISOString() });
			selected = await client.inspectPlace(placeId);
			return { ...ack, value: selected, status: 'observed' };
		},
		setOutputStorage: async (fromPlaceId, toPlaceId) => {
			requireEnabled();
			const [from, to] = await Promise.all([client.getPlace(fromPlaceId), client.getPlace(toPlaceId)]);
			if (!from || !to) throw new Error('Both relation endpoints must be existing place IDs.');
			if (to.kind !== 'storage') throw new Error('The output target must be a place of kind storage.');
			if (from.dimension !== to.dimension) throw new Error('Relation endpoints must be in the same dimension.');
			const response = await client.setPlaceRelation({ fromPlaceId, toPlaceId, type: 'output_storage', source: 'user' });
			selected = await client.inspectPlace(fromPlaceId);
			return response;
		},
		setAlias: async (alias, placeId) => {
			requireEnabled();
			if (!await client.getPlace(placeId)) throw new Error(`No place with ID '${placeId}' exists.`);
			return client.setPlaceAlias(alias, placeId);
		},
		setHome: async (placeId) => {
			requireEnabled();
			const place = await client.getPlace(placeId);
			if (!place) throw new Error(`No place with ID '${placeId}' exists.`);
			return client.setPlacePreference({ homePlaceId: placeId });
		},
		goTo: async (placeId) => {
			requireEnabled();
			const result = await client.inspectPlace(placeId);
			if (!result) throw new Error(`No place with ID '${placeId}' exists.`);
			if (result.place.dimension !== normalizedDimension(agent.bot)) throw new Error(`Cannot travel to ${result.place.dimension} while the bot is in ${normalizedDimension(agent.bot)}.`);
			selected = result;
			const outcome = await actions.goTo(placeId);
			if (outcome?.ok) selected = await client.inspectPlace(placeId);
			return outcome;
		},
		tendFarm: async (farmId, options = {}) => {
			requireEnabled();
			const result = await client.inspectPlace(farmId);
			if (!result || result.place.kind !== 'farm') throw new Error(`Place '${farmId}' is not a saved farm.`);
			if (result.place.dimension !== normalizedDimension(agent.bot)) throw new Error(`Cannot tend a ${result.place.dimension} farm while the bot is in ${normalizedDimension(agent.bot)}.`);
			selected = result;
			return actions.tendFarm(farmId, options);
		}
	};
	const sdk = Object.freeze(Object.fromEntries(Object.entries(methods).map(([name, method]) => [name, trackSkill(`places.${name}`, method)])));
	return Object.freeze({
		sdk,
		isEnabled: enabled,
		get selected() { return selected; },
		getPromptContext() {
			if (!enabled()) return 'Persistent place memory is disabled. Session-only bookmarks remain available.';
			if (!selected) {
				if (!searchCandidates.length) return EMPTY_CONTEXT;
				return `No single place is selected. Choose one of these recent candidates by stable ID:\n${searchCandidates.map(describe).join('\n')}\nDo not travel until one ID is explicitly selected.`;
			}
			const { place, outputStorage } = selected;
			return `Selected place: ${describe(place)}${outputStorage ? `\nRelated output storage: ${describe(outputStorage)}` : ''}\nUse this stable place ID in place SDK calls. Treat user-reported or stale records as unverified until the bot confirms a current position or loaded target block. Base and other records describe a representative point only; record farm, storage, forest, village, mine, and resource locations with rememberObservedAt at a loaded block matching the place kind.`;
		}
	});
}
