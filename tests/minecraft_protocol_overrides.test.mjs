import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createMinecraftProtocolOverrides } from '../src/utils/minecraft_protocol_overrides.js';

const sharedModules = new URL('../../mindcraft-eval/runtime/upstream/node_modules/', import.meta.url);
const require = createRequire(new URL('package.json', sharedModules));
const minecraftData = require('minecraft-data');
const { createDeserializer } = require('minecraft-protocol/src/transforms/serializer');

const protocol = minecraftData('1.21.1').protocol;
const overrides = createMinecraftProtocolOverrides('1.21.1', protocol);
assert.ok(overrides);
assert.equal(createMinecraftProtocolOverrides('1.21.2', protocol), undefined);

const recipeId = Buffer.from('minecraft:decorated_pot');
const packet = Buffer.concat([
    Buffer.from([0x77, 0x01, recipeId.length]),
    recipeId,
    Buffer.from([0x16, 0x03])
]);

const decoded = await new Promise((resolve, reject) => {
    const parser = createDeserializer({
        state: 'play',
        isServer: false,
        version: '1.21.1',
        customPackets: overrides,
        noErrorLogging: true
    });
    parser.once('data', resolve);
    parser.once('error', reject);
    parser.end(packet);
});

assert.equal(decoded.data.name, 'declare_recipes');
assert.equal(decoded.data.params.recipes.length, 1);
assert.equal(decoded.data.params.recipes[0].name, 'minecraft:decorated_pot');
assert.equal(decoded.data.params.recipes[0].type, 'minecraft:crafting_decorated_pot');
assert.equal(decoded.metadata.size, packet.length);
console.log('Minecraft 1.21.1 recipe protocol override test passed');
