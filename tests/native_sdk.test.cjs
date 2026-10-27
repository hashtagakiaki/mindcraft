'use strict'

// Contract checks need no Mineflayer installation or running game server.
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { readFile } = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const repo = path.resolve(__dirname, '..')

async function main() {
  const { createNativeSdk, getNativeSdkDocs, getNativeSdkMethodNames, getNativeSdkExecutionMetadata, getRetiredNativeSdkReplacement, NATIVE_SDK_DEFINITIONS, SdkArgumentError } =
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
  for (const name of ['craftItem', 'inspectChest', 'useToolOnBlockAt']) namespaces.skills[name] = (...args) => { calls.push({ method: `skills.${name}`, args }); return args }
  namespaces.world.getBlockAtPosition = (...args) => { calls.push({ method: 'world.getBlockAtPosition', args }); return args }
  namespaces.world.getNearestBlocksWhere = (...args) => { calls.push({ method: 'world.getNearestBlocksWhere', args }); return args }
  for (const name of ['findRecords', 'inspectRecord', 'rememberHereRecord', 'rememberObservedAtRecord', 'rememberReportedRecord']) namespaces.places[name] = (...args) => { calls.push({ method: `places.${name}`, args }); return args }
  const botA = { username: 'A', inventory: { items: () => [{ name: 'dirt', count: 1 }] } }
  const botB = { username: 'B' }
  const sdk = createNativeSdk({ ...namespaces, bot: botA })
  const second = createNativeSdk({ ...namespaces, bot: botB })
  const methodNames = getNativeSdkMethodNames()
  assert.equal(methodNames.length, new Set(methodNames).size)
  assert.deepEqual(Object.entries(sdk).flatMap(([namespace, methods]) => Object.keys(methods).map(name => `${namespace}.${name}`)), methodNames)
  const docs = getNativeSdkDocs()
  const execution = getNativeSdkExecutionMetadata()
  assert.deepEqual(docs.map(doc => doc.split('\n')[0]), methodNames)
  assert.ok(docs.every(doc => !/Signature:.*\(bot[,)]/.test(doc)))
  assert.equal(methodNames.length, 78)
  for (const retired of ['skills.log', 'world.isEntityType', 'world.getNearestBlock', 'world.getNearestBlocksWhere']) {
    assert.ok(!methodNames.includes(retired), `${retired} is not model-facing`)
    assert.ok(getRetiredNativeSdkReplacement(retired), `${retired} names its replacement`)
  }
  assert.equal(execution['world.getNearestBlocks'].kind, 'query')
  assert.equal(execution['places.find'].kind, 'query')
  assert.equal(execution['skills.showVillagerTrades'].kind, 'query')
  assert.equal(execution['places.verify'].kind, 'query', 'verification observations remain query data even though they refresh a saved observation record')
  assert.equal(execution['skills.craftItem'].completion, 'complete')
  assert.equal(execution['skills.smeltItem'].completion, 'complete')
  assert.equal(execution['skills.putInChest'].completion, 'complete')
  assert.equal(execution['skills.takeFromChest'].completion, 'complete')
  assert.equal(execution['skills.tendNearbyFarm'].completion, 'farm')
  assert.equal(execution['places.tendFarm'].completion, 'farm')

  // Every model-facing function has an explicit adapter. A small set of raw pathfinder
  // helpers stays available to internal legacy code but is never model-facing.
  for (const namespace of ['skills', 'world']) {
    const source = await readFile(path.join(repo, `src/agent/library/${namespace}.js`), 'utf8')
    const exports = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(/g)].map(match => `${namespace}.${match[1]}`)
    const exposed = methodNames.filter(name => name.startsWith(`${namespace}.`))
    assert.ok(exposed.every(name => exports.includes(name) || name === 'world.getBlockAtOffset'), 'every native entry binds an existing function or documented native alias')
    if (namespace === 'skills') {
      assert.ok(!exposed.includes('skills.goToGoal'))
      assert.ok(!exposed.includes('skills.reachPositionWithScaffoldCleanup'))
      for (const internal of ['skills.craftRecipe', 'skills.inspectChestAt', 'skills.viewChest', 'skills.useToolOnBlockAt']) assert.ok(!exposed.includes(internal))
    } else assert.deepEqual(exposed.sort(), exports.filter(name => !['world.shouldPlaceTorch', 'world.getNearbyThreats', 'world.getNearestBlock', 'world.getNearestBlocksWhere', 'world.isEntityType'].includes(name)).map(name => name === 'world.getBlockAtPosition' ? 'world.getBlockAtOffset' : name).sort())
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
  assert.deepEqual(await sdk.skills.useDoor({ position: input.position, open: true }), [botA, input.position, { open: true }])
  assert.deepEqual(await sdk.skills.useDoor({ position: input.position, open: false }), [botA, input.position, { open: false }])
  assert.deepEqual(await sdk.skills.useDoor(), [botA, null, {}])
  invalid(sdk.skills.useDoor, [{ open: 'true' }], 'open')
  assert.deepEqual(sdk.world.inspectBlockAt(input), [botA, 10, 64, -3])
  assert.deepEqual(sdk.world.getBlockAtOffset({ offset: { x: 0, y: -1, z: 0 } }), [botA, 0, -1, 0])
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
  const blockPredicate = block => block.name === 'chest'
  assert.deepEqual(sdk.world.getNearestBlocks({ predicate: blockPredicate, radius: 6, limit: 1 }), [botA, blockPredicate, 6, 1])
  assert.equal(calls.at(-1).method, 'world.getNearestBlocksWhere', 'predicate searches keep the optimized internal predicate scan')
  assert.deepEqual(sdk.world.getNearestBlocks({ blockTypes: ['chest'], limit: 1 }), [botA, ['chest'], 8, 1])
  invalid(sdk.world.getNearestBlocks, [{ blockTypes: ['chest'], predicate: blockPredicate }], 'predicate')
  invalid(sdk.world.getNearestBlocks, [{ predicate: 7 }], 'predicate')
  assert.equal(sdk.world.getNearestBlock, undefined)
  assert.equal(sdk.world.isEntityType, undefined)
  assert.equal(sdk.skills.log, undefined)
  const entity = { id: 4, position: { x: 0, y: 64, z: 0 }, metadata: [] }
  assert.deepEqual(sdk.world.getVillagerProfession({ entity }), [entity])
  assert.deepEqual(await sdk.skills.attackEntity({ entity, kill: false }), [botA, entity, false])

  assert.deepEqual(await sdk.skills.craftItem({ itemName: 'stick', quantity: 3 }), [botA, 'stick', 3])
  assert.deepEqual(await sdk.skills.smeltItem({ itemName: 'raw_iron', quantity: 4 }), [botA, 'raw_iron', 4, { furnacePosition: undefined, returnDetails: true }])
  invalid(sdk.skills.craftItem, [{ itemName: 'stick', quantity: 1.5 }], 'quantity')
  for (const name of ['putInChest', 'takeFromChest', 'discard']) {
    invalid(sdk.skills[name], [{ itemName: 'oak_log' }], 'quantity')
    invalid(sdk.skills[name], [{ itemName: 'oak_log', quantity: -1 }], 'quantity')
    invalid(sdk.skills[name], [{ itemName: 'oak_log', quantity: 0 }], 'quantity')
    const result = await sdk.skills[name]({ itemName: 'oak_log', quantity: 'all' })
    assert.equal(result[0], botA)
    assert.equal(result[2], -1)
  }
  assert.deepEqual(await sdk.skills.putInChest({ itemName: 'oak_log', quantity: 2, chestPosition: input.position }), [botA, 'oak_log', 2, { chestPosition: input.position, details: true }])
  assert.deepEqual(await sdk.skills.goToPlayer({ playerName: 'Steve' }), [botA, 'Steve', 3])
  invalid(sdk.skills.goToPlayer, [{ username: 'Steve' }], 'username')
  invalid(sdk.skills.useToolOn, [{ toolName: 'bow', targetName: 'nothing' }], 'targetName')
  assert.deepEqual(await sdk.skills.useItem({ itemName: 'bow', holdMs: 1200, position: input.position }),
    [botA, 'bow', { hand: 'main', holdMs: 1200, position: input.position, entity: null }])
  assert.deepEqual(await sdk.skills.useItem({ itemName: 'shield', hand: 'off' }), [botA, 'shield', { hand: 'off', holdMs: 0, position: null, entity: null }])
  invalid(sdk.skills.useItem, [{ itemName: 'bow', position: input.position, entity }], 'entity')
  invalid(sdk.skills.useItem, [{ itemName: 'bow', holdMs: 30001 }], 'holdMs')
  invalid(sdk.skills.placeBlock, [{ blockType: 'stone', position: input.position, dontCheat: true }], 'dontCheat')
  assert.deepEqual(await sdk.skills.goToNearestBlock({ blockType: 'chest' }), [botA, 'chest', 2, 64])
  invalid(sdk.skills.goToNearestBlock, [{ blockType: 'chest', navigation: { allowDig: true } }], 'navigation')
  invalid(sdk.skills.followPlayer, [{ playerName: 'Steve', preserveEnvironment: false }], 'preserveEnvironment')
  assert.deepEqual(sdk.skills.goToPosition({ position: input.position }), [botA, {
    position: input.position, arrivalMode: 'block', allowDig: false, scaffold: 'temporary', scaffoldBlocks: ['dirt', 'cobblestone'],
  }])
  invalid(sdk.skills.goToPosition, [{ position: input.position, minDistance: 2 }], 'minDistance')
  invalid(sdk.skills.goToPosition, [{ position: input.position, allowDig: true }], 'allowDig')
  assert.deepEqual(sdk.skills.reachPosition({ position: input.position }), [botA, {
    position: input.position, arrivalMode: 'block', allowDig: true, allowScaffold: true, scaffoldBlocks: ['dirt', 'cobblestone'], safeWater: false, cleanupOwnedScaffolds: false,
  }])
  invalid(sdk.skills.reachPosition, [{ position: input.position, allowScaffold: false }], 'allowScaffold')
  assert.equal(sdk.skills.goToGoal, undefined)
  assert.equal(sdk.skills.reachPositionWithScaffoldCleanup, undefined)

  const detailedMove = {
    ok: true, status: 'reached', arrivalReached: true, finalPosition: input.position,
    code: 'arrived', diagnostics: { phase: 'arrival', observedAt: '2026-10-22T00:00:00.000Z' },
    reason: 'Reached the target; 1 scaffold remains in cleanupRequired.',
    edits: [{ kind: 'scaffold_placed', block: 'dirt', position: input.position }],
    cleanupRequired: [{ ...input.position, block: 'dirt', reason: 'Supports the bot.' }],
  }
  const compactMove = {
    ok: true, status: 'reached', arrivalReached: true, finalPosition: input.position,
    code: 'arrived', diagnostics: { phase: 'arrival', observedAt: '2026-10-22T00:00:00.000Z' },
    reason: 'Reached the target; 1 scaffold remains in cleanupRequired.',
  }
  const incompletePreservedMove = {
    ok: false, status: 'blocked', arrivalReached: true, finalPosition: input.position,
    code: 'cleanup_incomplete', diagnostics: { phase: 'arrival', observedAt: '2026-10-22T00:00:00.000Z' },
    reason: 'Required scaffold cleanup is incomplete.',
  }
  const movementSdk = createNativeSdk({ bot: botA, skills: {
    goToPosition: () => detailedMove,
    reachPosition: async () => detailedMove,
  }, places: { goTo: async () => detailedMove } })
  assert.deepEqual(movementSdk.skills.goToPosition({ position: input.position }), incompletePreservedMove)
  assert.deepEqual(await movementSdk.skills.reachPosition({ position: input.position }), compactMove)
  const placeMovement = await movementSdk.places.goTo({ placeId: 'base' })
  assert.deepEqual(placeMovement, detailedMove, 'fixed navigation scope keeps the place method result shape')
  assert.equal(detailedMove.edits.length, 1, 'public projection preserves internal tracking')
  assert.equal(detailedMove.cleanupRequired.length, 1)
  assert.ok(docs.find(doc => doc.startsWith('skills.collectBlock\n')).includes('Its route may dig and leave confirmed'))
  assert.ok(docs.find(doc => doc.startsWith('skills.breakBlockAt\n')).includes('Its ordinary route preserves existing blocks'))
  assert.ok(docs.find(doc => doc.startsWith('skills.attackEntity\n')).includes('Its route cannot dig'))
  for (const name of ['breakBlockAt', 'attackEntity', 'collectBlock', 'goToPosition']) {
    assert.ok(docs.find(doc => doc.startsWith(`skills.${name}\n`)).includes('survival egress may dig or place confirmed blocks'),
      `${name} documents the shared emergency exception`)
  }
  const definitions = new Map(NATIVE_SDK_DEFINITIONS.map(definition => [`${definition.namespace}.${definition.name}`, definition]))
  assert.deepEqual(definitions.get('skills.collectBlock').navigationPolicy, { allowDig: true, scaffold: 'leave', scaffoldBlocks: ['dirt', 'cobblestone'] })
  assert.deepEqual(definitions.get('skills.craftItem').navigationPolicy, { allowDig: false, scaffold: 'forbid', scaffoldBlocks: [] },
    'the public craftItem entry owns the preserving route policy')
  assert.deepEqual(definitions.get('skills.attackEntity').navigationPolicy, { allowDig: false, scaffold: 'leave', scaffoldBlocks: ['dirt', 'cobblestone'], allowTowers: false })
  assert.deepEqual(definitions.get('skills.breakBlockAt').navigationPolicy, { allowDig: false, scaffold: 'forbid', scaffoldBlocks: [] })


  assert.deepEqual(sdk.skills.stay({ seconds: -1 }), [botA, -1])
  invalid(sdk.skills.stay, [{ seconds: -2 }], 'seconds')
  assert.deepEqual(await sdk.skills.tendNearbyFarm(), [botA, { scope: 'connected', seedReserve: 1, searchRadius: 32, keepHarvestInInventory: true }])
  assert.deepEqual(await sdk.skills.tendNearbyFarm({ scope: 'radius', radius: 5 }), [botA, { scope: 'radius', radius: 5, seedReserve: 1, keepHarvestInInventory: true }])
  invalid(sdk.skills.tendNearbyFarm, [{ radius: 5 }], 'radius')
  invalid(sdk.skills.tendNearbyFarm, [{ scope: 'radius', searchRadius: 5 }], 'searchRadius')
  invalid(sdk.skills.tendNearbyFarm, [{ scope: 'radius', startPosition: input.position }], 'startPosition')
  assert.deepEqual(await sdk.skills.placeBlock({ blockType: 'oak_stairs', position: input.position, facing: 'west', half: 'top' }), [botA, 'oak_stairs', 10, 64, -3, { facing: 'west', half: 'top' }, false])
  assert.deepEqual(await sdk.skills.placeBlock({ blockType: 'stone', position: input.position }), [botA, 'stone', 10, 64, -3, {}, false])

  assert.deepEqual(sdk.places.find({ text: 'chest' }), [{ text: 'chest', limit: 20 }])
  for (const method of ['goTo', 'goToAlias', 'tendFarm']) {
    const doc = docs.find(value => value.startsWith(`places.${method}\n`))
    assert.ok(doc.includes('Its ordinary route preserves existing blocks'), `${method} documents its fixed route policy`)
  }
  const placeGo = await sdk.places.goTo({ placeId: 'place-1' })
  assert.deepEqual(placeGo, ['place-1'])
  const visitedPlaces = createNativeSdk({ bot: botA, places: { goTo: () => ({ ok: true, status: 'visited' }) } })
  const visitedPlace = await visitedPlaces.places.goTo({ placeId: 'place-1' })
  assert.deepEqual(visitedPlace, { ok: true, status: 'visited' }, 'a place action keeps its own result contract')
  const aliasGo = await sdk.places.goToAlias({ alias: 'home' })
  assert.deepEqual(aliasGo, ['home'])
  const farmTend = await sdk.places.tendFarm({ farmId: 'farm-1', seedReserve: 2 })
  assert.deepEqual(farmTend, ['farm-1', { seedReserve: 2 }])
  invalid(sdk.places.find, ['chest'], 'arguments')
  invalid(sdk.places.find, [{ query: 'chest' }], 'query')
  invalid(sdk.places.find, [{ text: 'chest', limit: 101 }], 'limit')
  invalid(sdk.places.find, [{ text: 'chest', existence: 'reported' }], 'existence')
  invalid(sdk.places.rememberHere, [{ name: 'chest', kind: 'storage' }], 'kind')
  invalid(sdk.places.tendFarm, [{ farmId: 'farm-1', scope: 'radius' }], 'scope')
  assert.deepEqual(sdk.vision.lookAtPosition({ position: input.position }), [10, 64, -3, 0])
  assert.deepEqual(sdk.vision.lookAtPlayer({ playerName: 'Steve' }), ['Steve', 'at'])
  invalid(sdk.vision.lookAtPlayer, [{ playerName: 'Steve', direction: 'left' }], 'direction')
  invalid(sdk.communication.sendToBot, [{ recipient: 'B', message: 'x'.repeat(2001) }], 'message')
  assert.deepEqual(sdk.communication.sendToBot({ recipient: 'B', message: 'hello' }), ['B', 'hello'])

  const limited = createNativeSdk({ ...namespaces, bot: botA }, { codex_session: { max_search_radius: 10 } })
  invalid(limited.world.getNearbyBlockTypes, [{ radius: 11 }], 'radius')
  assert.deepEqual(limited.world.getNearbyBlockTypes(), [botA, 10])
  assert.deepEqual(await limited.skills.tendNearbyFarm(), [botA, { scope: 'connected', seedReserve: 1, searchRadius: 10, keepHarvestInInventory: true }])
  assert.ok(getNativeSdkDocs({ codex_session: { max_search_radius: 10 } }).find(doc => doc.startsWith('world.getNearbyBlockTypes\n')).includes('default 10'))
  const missing = createNativeSdk({ bot: botA })
  invalid(missing.places.find, [null], 'arguments')
  assert.throws(() => missing.places.find({ text: 'chest' }), /unavailable/)
  const asyncSdk = createNativeSdk({ bot: botA, skills: { wait: async () => 'done', equip: async () => false, discard: async () => true } })
  assert.equal(await asyncSdk.skills.wait({ milliseconds: 0 }), 'done', 'non-boolean action values pass through')
  assert.deepEqual(await asyncSdk.skills.equip({ itemName: 'stone' }), { ok: false, status: 'failed', code: 'returned_false', reason: null },
    'an untracked boolean failure becomes an explicit failed action result')
  assert.deepEqual(await asyncSdk.skills.discard({ itemName: 'stone', quantity: 1 }), { ok: true, status: 'complete' })
  console.log(`native SDK contracts passed (${methodNames.length} methods; bot binding, docs, units, invalid input without internal calls, cross-realm objects, sync/async preservation)`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
