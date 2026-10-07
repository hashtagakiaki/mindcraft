'use strict'

// Contract checks need no Mineflayer installation or running game server.
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { readFile } = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const repo = path.resolve(__dirname, '..')

async function main() {
  const { createNativeSdk, getNativeSdkDocs, getNativeSdkMethodNames, NATIVE_SDK_DEFINITIONS, SdkArgumentError } =
    await import(pathToFileURL(path.join(repo, 'src/agent/library/native_sdk.js')))
  const calls = []
  const namespaces = {}
  for (const definition of NATIVE_SDK_DEFINITIONS) {
    namespaces[definition.namespace] ??= {}
    namespaces[definition.namespace][definition.name] = (...args) => {
      calls.push({ method: `${definition.namespace}.${definition.name}`, args })
      return args
    }
  }
  const botA = { username: 'A' }
  const botB = { username: 'B' }
  const sdk = createNativeSdk({ ...namespaces, bot: botA })
  const second = createNativeSdk({ ...namespaces, bot: botB })
  const methodNames = getNativeSdkMethodNames()
  assert.equal(methodNames.length, new Set(methodNames).size)
  assert.deepEqual(Object.entries(sdk).flatMap(([namespace, methods]) => Object.keys(methods).map(name => `${namespace}.${name}`)), methodNames)
  const docs = getNativeSdkDocs()
  assert.deepEqual(docs.map(doc => doc.split('\n')[0]), methodNames)
  assert.ok(docs.every(doc => !/Signature:.*\(bot[,)]/.test(doc)))

  // Every preexisting exposed function has an explicit adapter. This guards accidental
  // omission while keeping newly exported helpers private until explicitly admitted.
  for (const namespace of ['skills', 'world']) {
    const source = await readFile(path.join(repo, `src/agent/library/${namespace}.js`), 'utf8')
    const exports = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(/g)].map(match => `${namespace}.${match[1]}`)
    assert.deepEqual(methodNames.filter(name => name.startsWith(`${namespace}.`)).sort(), exports.sort())
  }

  const invalid = (method, args, field) => {
    const before = calls.length
    assert.throws(() => method(...args), error => {
      assert.ok(error instanceof SdkArgumentError)
      assert.equal(error.name, 'SdkArgumentError')
      assert.equal(error.code, 'INVALID_ARGUMENT')
      assert.equal(error.field, field)
      assert.ok(error.method.includes('.'))
      assert.ok(error.expected.length > 0)
      assert.ok(error.signature.startsWith(error.method))
      assert.ok(error.example.startsWith(error.method))
      assert.ok(error.message.includes(error.example))
      return true
    })
    assert.equal(calls.length, before, 'invalid input never calls the underlying SDK')
  }

  assert.deepEqual(sdk.world.getPosition(), [botA])
  assert.deepEqual(second.world.getPosition({}), [botB])
  assert.ok(!sdk.world.getPosition().then, 'synchronous observation stays synchronous')
  const input = vm.runInNewContext('({position:{x:10,y:64,z:-3}})')
  assert.deepEqual(sdk.world.inspectBlockAt(input), [botA, 10, 64, -3])
  assert.deepEqual(sdk.world.getBlockAtPosition({ offset: { x: 0, y: -1, z: 0 } }), [botA, 0, -1, 0])
  assert.deepEqual(sdk.world.getNearestBlocks(), [botA, null, 8, 10000])
  assert.deepEqual(sdk.world.getNearbyBlockTypes({ radius: 12 }), [botA, 12])
  invalid(sdk.world.getNearbyBlockTypes, [12], 'arguments')
  invalid(sdk.world.getPosition, [{ bot: botA }], 'bot')
  invalid(sdk.world.getPosition, [undefined], 'arguments')
  invalid(sdk.world.getPosition, [null], 'arguments')
  invalid(sdk.world.getPosition, [[]], 'arguments')
  invalid(sdk.world.inspectBlockAt, [10, 64, -3], 'arguments')
  invalid(sdk.world.inspectBlockAt, [], 'arguments')
  invalid(sdk.world.inspectBlockAt, [{ position: { x: NaN, y: 64, z: 0 } }], 'position.x')
  invalid(sdk.world.inspectBlockAt, [{ position: { x: 0, y: '64', z: 0 } }], 'position.y')
  invalid(sdk.world.inspectBlockAt, [{ position: { x: 0, y: 64, z: Infinity } }], 'position.z')
  invalid(sdk.world.inspectBlockAt, [{ position: { x: 0, y: 64, z: 0, dimension: 'overworld' } }], 'position.dimension')
  invalid(sdk.world.getNearestBlocks, [{ limit: 1.5 }], 'limit')
  invalid(sdk.world.getNearestBlocks, [{ radius: 65 }], 'radius')
  invalid(sdk.world.getNearestBlocks, [{ blockTypes: 'chest' }], 'blockTypes')

  const predicate = entity => entity.name === 'cow'
  assert.deepEqual(sdk.world.getNearestEntityWhere({ predicate }), [botA, predicate, 16])
  assert.deepEqual(sdk.world.isEntityType({ name: 'cow' }), ['cow'])
  const entity = { id: 4, position: { x: 0, y: 64, z: 0 }, metadata: [] }
  assert.deepEqual(sdk.world.getVillagerProfession({ entity }), [entity])
  assert.deepEqual(sdk.skills.attackEntity({ entity, kill: false }), [botA, entity, false])

  assert.deepEqual(sdk.skills.craftRecipe({ itemName: 'stick', times: 3 }), [botA, 'stick', 3])
  assert.deepEqual(sdk.skills.smeltItem({ itemName: 'raw_iron', quantity: 4 }), [botA, 'raw_iron', 4])
  invalid(sdk.skills.craftRecipe, [{ itemName: 'stick', quantity: 3 }], 'quantity')
  invalid(sdk.skills.craftRecipe, [{ itemName: 'stick', times: 1.5 }], 'times')
  for (const name of ['putInChest', 'takeFromChest', 'discard']) {
    invalid(sdk.skills[name], [{ itemName: 'oak_log' }], 'quantity')
    invalid(sdk.skills[name], [{ itemName: 'oak_log', quantity: -1 }], 'quantity')
    invalid(sdk.skills[name], [{ itemName: 'oak_log', quantity: 0 }], 'quantity')
    const result = sdk.skills[name]({ itemName: 'oak_log', quantity: 'all' })
    assert.equal(result[0], botA)
    assert.equal(result[2], -1)
  }
  assert.deepEqual(sdk.skills.putInChest({ itemName: 'oak_log', quantity: 2, chestPosition: input.position }), [botA, 'oak_log', 2, { chestPosition: input.position }])
  assert.deepEqual(sdk.skills.goToPlayer({ username: 'Steve' }), [botA, 'Steve', 3])
  assert.deepEqual(sdk.skills.stay({ seconds: -1 }), [botA, -1])
  invalid(sdk.skills.stay, [{ seconds: -2 }], 'seconds')
  assert.deepEqual(sdk.skills.tendNearbyFarm(), [botA, { scope: 'connected', seedReserve: 1, searchRadius: 32 }])
  assert.deepEqual(sdk.skills.tendNearbyFarm({ scope: 'radius', radius: 5 }), [botA, { scope: 'radius', radius: 5, seedReserve: 1 }])
  invalid(sdk.skills.tendNearbyFarm, [{ radius: 5 }], 'radius')
  invalid(sdk.skills.tendNearbyFarm, [{ scope: 'radius', searchRadius: 5 }], 'searchRadius')
  invalid(sdk.skills.tendNearbyFarm, [{ scope: 'radius', startPosition: input.position }], 'startPosition')
  invalid(sdk.skills.placeBlock, [{ blockType: 'chest', position: input.position, facing: 'north', placeOn: 'bottom' }], 'placeOn')
  assert.deepEqual(sdk.skills.placeBlock({ blockType: 'oak_stairs', position: input.position, facing: 'west', half: 'top' }), [botA, 'oak_stairs', 10, 64, -3, { facing: 'west', half: 'top' }, false])
  assert.deepEqual(sdk.skills.placeBlock({ blockType: 'stone', position: input.position }), [botA, 'stone', 10, 64, -3, 'bottom', false])

  assert.deepEqual(sdk.places.find({ text: 'chest' }), ['chest', { limit: 20 }])
  invalid(sdk.places.find, ['chest'], 'arguments')
  invalid(sdk.places.find, [{ query: 'chest' }], 'query')
  invalid(sdk.places.find, [{ text: 'chest', limit: 101 }], 'limit')
  invalid(sdk.places.find, [{ text: 'chest', existence: 'reported' }], 'existence')
  invalid(sdk.places.rememberHere, [{ name: 'chest', kind: 'storage' }], 'kind')
  invalid(sdk.places.tendFarm, [{ farmId: 'farm-1', scope: 'radius' }], 'scope')
  assert.deepEqual(sdk.vision.lookAtPosition({ position: input.position }), [10, 64, -3])
  assert.deepEqual(sdk.vision.lookAtPlayer({ playerName: 'Steve' }), ['Steve', 'at'])
  invalid(sdk.vision.lookAtPlayer, [{ playerName: 'Steve', direction: 'left' }], 'direction')
  invalid(sdk.communication.sendToBot, [{ recipient: 'B', message: 'x'.repeat(2001) }], 'message')
  assert.deepEqual(sdk.communication.sendToBot({ recipient: 'B', message: 'hello' }), ['B', 'hello'])

  const limited = createNativeSdk({ ...namespaces, bot: botA }, { codex_session: { max_search_radius: 10 } })
  invalid(limited.world.getNearbyBlockTypes, [{ radius: 11 }], 'radius')
  assert.deepEqual(limited.world.getNearbyBlockTypes(), [botA, 10])
  assert.deepEqual(limited.skills.tendNearbyFarm(), [botA, { scope: 'connected', seedReserve: 1, searchRadius: 10 }])
  assert.ok(getNativeSdkDocs({ codex_session: { max_search_radius: 10 } }).find(doc => doc.startsWith('world.getNearbyBlockTypes\n')).includes('default 10'))
  const missing = createNativeSdk({ bot: botA })
  invalid(missing.places.find, [null], 'arguments')
  assert.throws(() => missing.places.find({ text: 'chest' }), /unavailable/)
  const sentinel = Promise.resolve('done')
  const asyncSdk = createNativeSdk({ bot: botA, skills: { wait: () => sentinel } })
  assert.equal(asyncSdk.skills.wait({ milliseconds: 0 }), sentinel, 'ownership promise identity is preserved')
  assert.equal(await asyncSdk.skills.wait({ milliseconds: 0 }), 'done')
  console.log(`native SDK contracts passed (${methodNames.length} methods; bot binding, docs, units, invalid input without internal calls, cross-realm objects, sync/async preservation)`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
