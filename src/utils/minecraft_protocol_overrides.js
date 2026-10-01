const MINECRAFT_1_21_1 = '1.21.1';
const MINECRAFT_1_21_PROTOCOL_FAMILY = '1.21';
const BANNER_ADD_PATTERN_RECIPE_TYPE_ID = 11;
const LAST_RECIPE_TYPE_ID = 23;

function findRecipeTypeMappings(value, found = []) {
    if (Array.isArray(value)) {
        for (const entry of value) findRecipeTypeMappings(entry, found);
    } else if (value && typeof value === 'object') {
        if (value.name === 'type' && Array.isArray(value.type) && value.type[0] === 'mapper') {
            const mappings = value.type[1]?.mappings;
            if (mappings?.['11'] === 'minecraft:crafting_special_banneraddpattern' &&
                mappings?.['23'] === 'minecraft:crafting_decorated_pot') {
                found.push(mappings);
            }
        }
        for (const entry of Object.values(value)) findRecipeTypeMappings(entry, found);
    }
    return found;
}

/**
 * Return the 1.21.1 recipe type correction for minecraft-protocol's customPackets option.
 * minecraft-data includes a recipe type that is absent from the 1.21.1 wire enum, shifting
 * every recipe type from ID 11 onward by one.
 */
export function createMinecraftProtocolOverrides(version, protocol) {
    if (version !== MINECRAFT_1_21_1) return undefined;

    const packet = protocol?.play?.toClient?.types?.packet_declare_recipes;
    if (!packet) throw new Error('Minecraft 1.21.1 recipe packet schema is missing');

    const correctedPacket = structuredClone(packet);
    const mappings = findRecipeTypeMappings(correctedPacket);
    if (mappings.length !== 1) {
        throw new Error('Minecraft 1.21.1 recipe type mapping has an unsupported structure');
    }

    const currentMappings = mappings[0];
    const correctedMappings = { ...currentMappings };
    delete correctedMappings[String(BANNER_ADD_PATTERN_RECIPE_TYPE_ID)];
    for (let typeId = BANNER_ADD_PATTERN_RECIPE_TYPE_ID + 1; typeId <= LAST_RECIPE_TYPE_ID; typeId++) {
        correctedMappings[String(typeId - 1)] = currentMappings[String(typeId)];
        delete correctedMappings[String(typeId)];
    }
    for (const key of Object.keys(currentMappings)) delete currentMappings[key];
    Object.assign(currentMappings, correctedMappings);

    return {
        [MINECRAFT_1_21_PROTOCOL_FAMILY]: {
            play: {
                toClient: {
                    types: { packet_declare_recipes: correctedPacket }
                }
            }
        }
    };
}

export function createMinecraftConnectionProtocolOptions(settings, fallbackVersion, loadMinecraftData) {
    const version = settings.minecraft_version ?? fallbackVersion;
    const versionData = version && version !== 'auto' ? loadMinecraftData(version) : null;
    return {
        version,
        customPackets: createMinecraftProtocolOverrides(version, versionData?.protocol)
    };
}
