const MAX_SAVED_PLACE_NAMES = 100;

export class MemoryBank {
	constructor(client = null, agentName = '', isPersistentEnabled = () => false) {
		this.memory = Object.create(null);
		this.client = client;
		this.agentName = agentName;
		this.isPersistentEnabled = isPersistentEnabled;
	}

	async rememberPlace(name, x, y, z, { dimension = 'overworld', kind = 'other', purpose = [] } = {}) {
		if (this.isPersistentEnabled()) {
			const response = await this.client.rememberPlace({
				name,
			kind,
			purposes: Array.isArray(purpose) ? purpose : [purpose],
			dimension,
			position: { x, y, z },
			source: 'observed',
			observedAt: new Date().toISOString(),
			existence: 'observed'
			}, { alias: name });
			return response.value;
		}
		this.memory[name] = [x, y, z];
		return this.memory[name];
	}

	async recallPlace(name) {
		if (this.isPersistentEnabled()) {
			const place = await this.client.resolvePlaceAlias(name);
			return place?.position ?? null;
		}
		return Object.hasOwn(this.memory, name) ? this.memory[name] : undefined;
	}

	async getKeys() {
		if (this.isPersistentEnabled()) {
			const places = await this.client.queryPlaces({ limit: MAX_SAVED_PLACE_NAMES });
			const preferences = await this.client.getPlacePreferences();
			return [...new Set([...places.map((place) => place.name), ...places.flatMap((place) => place.aliases ?? []), ...Object.keys(preferences.aliases ?? {}), ...(preferences.homePlaceId ? ['home'] : [])])].join(', ');
		}
		return Object.keys(this.memory).join(', ');
	}

	getJson() {
		return { ...this.memory };
	}

	loadJson(json) {
		this.memory = Object.assign(Object.create(null), json ?? {});
	}
}
