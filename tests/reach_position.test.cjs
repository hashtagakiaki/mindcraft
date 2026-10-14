'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { mkdtemp, mkdir, readFile, rm, symlink, writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')
const { moduleRoot } = require('./dependency_root.cjs')

const repo = path.resolve(__dirname, '..')
const deps = moduleRoot()
const req = createRequire(path.join(deps, 'package.json'))
const registry = req('prismarine-registry')('1.21.1')
const Block = req('prismarine-block')(registry)
const WorldSync = req('prismarine-world/src/worldsync')
const Vec3 = req('vec3').Vec3
const AStar = req('mineflayer-pathfinder/lib/astar')
const Move = req('mineflayer-pathfinder/lib/move')
const pathfinder = req('mineflayer-pathfinder')

const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function write(root, relative, content) {
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
}

async function setup(root) {
  await write(root, 'package.json', '{"type":"module"}')
  await symlink(deps, path.join(root, 'node_modules'))
  await write(root, 'settings.js', 'export default { navigation_stall_timeout_ms: 500, navigation_check_interval_ms: 25 };')
  for (const name of ['skills', 'block_placement', 'block_interaction', 'operation_context', 'crafting_sync']) {
    await write(root, `src/agent/library/${name}.js`, await readFile(path.join(repo, `src/agent/library/${name}.js`)))
  }
  await write(root, 'src/agent/library/world.js', `
export function getNearestBlocksWhere() { return []; }
export function getNearestBlock() { return null; }
export function getNearestBlocks() { return []; }
export function getNearestEntityWhere() { return null; }
export function getNearbyEntities() { return []; }
export function getPosition(bot) { return bot.entity.position; }
export function inspectBlockAt() { return { loaded: false }; }
export function shouldPlaceTorch() { return false; }
export function getInventoryCounts(bot) { return Object.fromEntries(bot.inventory.items().map(item => [item.name, item.count])); }
`)
  await write(root, 'src/utils/mcdata.js', `
export function getBlockId(name) { return globalThis.mcRegistry.blocksByName[name]?.id ?? null; }
export function getItemId(name) { return globalThis.mcRegistry.itemsByName[name]?.id ?? null; }
export function getItemCraftingRecipes() { return []; }
export function ingredientsFromPrismarineRecipe() { return {}; }
export function calculateLimitingResource() { return { num: 0, limitingResource: null }; }
export function mustCollectManually() { return false; }
`)
}

function makeBot({ gap = [], wall = [], hazards = [], platform = false, corridor = false, loadedMaxX = 16, rejectScaffoldRemoval = false, navigationDelay = 0 } = {}) {
  const bot = new EventEmitter()
  const world = new EventEmitter()
  const states = new Map()
  const inventory = { dirt: 16, cobblestone: 16 }
  const edits = []
  let loadedThroughX = loadedMaxX
  let placementMode = 'accept'
  let placementDelay = 0
  const paths = []
  bot.testState = { edits, inventory, paths, equippedForBlocks: [], get placementMode() { return placementMode }, set placementMode(value) { placementMode = value }, set placementDelay(value) { placementDelay = value } }
  bot.registry = registry
  bot.version = '1.21.1'
  bot.output = ''
  bot.interrupt_code = false
  bot.game = { minY: 60, height: 20, dimension: 'overworld', gameMode: 'survival' }
  bot.entity = { id: 1, position: new Vec3(0.5, 64, 0.5), onGround: true, eyeHeight: 1.62, effects: {}, velocity: { x: 0, z: 0 } }
  bot.entities = {}
  bot.world = world
  const loaded = (x, z) => x >= -8 && x <= loadedThroughX && z >= -4 && z <= 4
  bot.testState.loadThrough = x => { loadedThroughX = x; world.emit('chunkColumnLoad', new Vec3(x, 0, 0)) }
  const getName = p => {
    const cell = p.floored()
    if (!loaded(cell.x, cell.z) || cell.y < 60 || cell.y > 76) return null
    const explicit = states.get(key(cell))
    if (explicit) return explicit.name
    const hazard = hazards.find(point => point.x === cell.x && point.y === cell.y && point.z === cell.z)
    if (hazard) return hazard.name
    if (corridor && cell.z !== 0 && (cell.y === 64 || cell.y === 65)) return 'stone'
    if (platform && cell.x >= 4 && cell.x <= 10 && cell.y === 65) return 'stone'
    if (gap.includes(cell.x) && cell.y <= 63) return 'air'
    if (cell.y < 63) return 'stone'
    if (cell.y === 63 && !gap.includes(cell.x)) return 'stone'
    const obstruction = wall.find(point => point.x === cell.x && point.y === cell.y && point.z === cell.z)
    if (obstruction) return obstruction.name ?? 'stone'
    return 'air'
  }
  const blockAt = position => {
    const p = position.floored()
    const name = getName(p)
    if (!name) return null
    const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0)
    block.position = p
    return block
  }
  bot.blockAt = blockAt
  bot.canDigBlock = block => !!block?.diggable
  bot.canSeeBlock = block => {
    const origin = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
    const delta = block.position.offset(0.5, 0.5, 0.5).minus(origin)
    const hit = world.raycast(origin, delta.scaled(1 / delta.norm()), delta.norm() + 0.01)
    return !!hit && key(hit.position) === key(block.position)
  }
  bot.world.getBlock = blockAt
  bot.world.raycast = WorldSync.prototype.raycast
  bot.inventory = { slots: [], items: () => Object.entries(inventory).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id })) }
  bot.tool = { equipForBlock: async block => { bot.testState.equippedForBlocks.push(block.name) } }
  bot.heldItem = null
  bot.equip = async item => { bot.heldItem = item }
  bot.setControlState = () => {}
  bot.clearControlStates = () => {}
  bot.getControlState = () => false
  bot.dig = async block => {
    const p = block.position.floored()
    const oldBlock = blockAt(p)
    if (rejectScaffoldRemoval && oldBlock?.name === 'dirt') return false
    states.set(key(p), { name: 'air' })
    const newBlock = blockAt(p)
    edits.push({ kind: 'server_dig', block: oldBlock.name, position: { x: p.x, y: p.y, z: p.z } })
    bot.emit('blockUpdate', oldBlock, newBlock)
    bot.emit(`blockUpdate:${p}`, oldBlock, newBlock)
    return true
  }
  bot.placeBlock = async (support, face) => {
    const p = support.position.plus(face).floored()
    if (placementDelay) await delay(placementDelay)
    if (placementMode === 'reject') return
    const oldBlock = blockAt(p)
    states.set(key(p), { name: bot.heldItem.name })
    inventory[bot.heldItem.name]--
    const newBlock = blockAt(p)
    edits.push({ kind: 'server_place', block: bot.heldItem.name, position: { x: p.x, y: p.y, z: p.z } })
    bot.emit('blockUpdate', oldBlock, newBlock)
    bot.emit(`blockUpdate:${p}`, oldBlock, newBlock)
  }
  bot.pathfinder = {
    movements: { original: true }, goal: null,
    bestHarvestTool: () => null,
    setMovements(value) { this.movements = value },
    stop() { const goal = this.goal; this.goal = null; bot.emit('path_stop', goal) },
    setGoal(goal) { this.goal = goal },
    _route(movements, goal, timeout = 1200, tickTimeout = 1000, searchRadius = -1) {
      movements.allowEntityDetection = false
      const p = bot.entity.position.floored()
      const start = new Move(p.x, p.y, p.z, movements.countScaffoldingItems(), 0)
      const astar = new AStar(start, movements, goal, timeout, tickTimeout, searchRadius)
      let result = astar.compute()
      while (result.status === 'partial') result = astar.compute()
      paths.push({ status: result.status, path: result.path.map(node => ({ x: node.x, y: node.y, z: node.z, toPlace: node.toPlace })) })
      return result
    },
    *getPathFromTo(movements, startPosition, goal, options = {}) {
      movements.allowEntityDetection = false
      const p = startPosition.floored()
      const start = new Move(p.x, p.y, p.z, movements.countScaffoldingItems(), 0)
      const astar = new AStar(start, movements, goal, options.timeout ?? 1200, options.tickTimeout ?? 60, options.searchRadius ?? 64)
      let result = astar.compute()
      yield { result, astarContext: astar }
      while (result.status === 'partial') { result = astar.compute(); yield { result, astarContext: astar } }
    },
    getPathTo(movements, goal, timeout) { return this._route(movements, goal, timeout ?? 1200, 1000, -1) },
    async goto(goal) {
      this.goal = goal
      if (navigationDelay) await delay(navigationDelay)
      const result = this._route(this.movements, goal, 1200, 1000, -1)
      bot.emit('path_update', result)
      if (result.status !== 'success') throw Object.assign(new Error(`No path to the goal (${result.status})`), { name: result.status === 'timeout' ? 'Timeout' : 'NoPath' })
      for (const node of result.path) {
        if (bot.interrupt_code) throw new Error('Action cancelled')
        for (const point of node.toBreak ?? []) {
          const block = blockAt(point)
          if (!block) throw new Error('Unknown block in dig route')
          await bot.dig(block)
        }
        for (const placement of node.toPlace ?? []) {
          if (placement.useOne) throw new Error('Unexpected door activation in route')
          const item = this.movements.getScaffoldingItem()
          if (!item) throw new Error('Missing scaffold item')
          await bot.equip(item)
          const reference = blockAt(new Vec3(placement.x, placement.y, placement.z))
          if (!reference) throw new Error('Unknown scaffold support')
          await bot.placeBlock(reference, new Vec3(placement.dx, placement.dy, placement.dz))
        }
        bot.entity.position = new Vec3(node.x + 0.5, node.y, node.z + 0.5)
      }
      bot.entity.onGround = true
      bot.emit('goal_reached', goal)
    },
  }
  return bot
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mc-reach-position-'))
  try {
    await setup(root)
    globalThis.mcRegistry = registry
    const skills = await import(pathToFileURL(path.join(root, 'src/agent/library/skills.js')))
    const { reachPosition } = skills

    const open = makeBot()
    const openMovements = open.pathfinder.movements
    const openResult = await reachPosition(open, { position: { x: 5.5, y: 64, z: 0.5 } })
    assert.equal(openResult.status, 'reached', JSON.stringify(openResult))
    assert.equal(openResult.ok, true)
    assert.deepEqual(openResult.edits, [])
    assert.match(open.output, /\[reachPosition-route\].*"searchStatus":"success"/)
    assert.equal(open.pathfinder.movements, openMovements, 'original movements are restored')

    const serialized = makeBot({ navigationDelay: 50 })
    const firstNavigation = reachPosition(serialized, { position: { x: 5.5, y: 64, z: 0.5 } })
    await delay(5)
    const overlapping = await reachPosition(serialized, { position: { x: 4.5, y: 64, z: 0.5 } })
    assert.equal(overlapping.status, 'blocked', JSON.stringify(overlapping))
    assert.match(overlapping.reason, /already owns this pathfinder/)
    assert.equal((await firstNavigation).status, 'reached')
    assert.equal(serialized.pathfinder.movements.original, true, 'the owning navigation restores the original movements')

    const wall = []
    for (let z = -4; z <= 4; z++) for (const y of [64, 65]) wall.push({ x: 3, y, z, name: 'dirt' })
    const blocked = makeBot({ wall })
    const blockedMovements = blocked.pathfinder.movements
    const blockedResult = await reachPosition(blocked, { position: { x: 6.5, y: 64, z: 0.5 }, allowDig: false, allowScaffold: false })
    assert.equal(blockedResult.status, 'blocked', JSON.stringify(blockedResult))
    assert.match(blocked.output, /\[reachPosition-route\].*"searchStatus":/)
    assert.equal(blocked.testState.edits.length, 0, 'explicitly disabled edits leave the wall untouched')
    assert.equal(blocked.pathfinder.movements, blockedMovements)

    const mined = makeBot({ wall })
    const minedResult = await reachPosition(mined, { position: { x: 6.5, y: 64, z: 0.5 }, allowDig: true })
    assert.equal(minedResult.status, 'reached', JSON.stringify(minedResult))
    assert.ok(minedResult.edits.some(edit => edit.kind === 'dug'))
    assert.ok(mined.testState.edits.some(edit => edit.kind === 'server_dig'))
    assert.ok(mined.testState.equippedForBlocks.length > 0, 'the suitable tool is equipped before route mining')

    const defaultMined = makeBot({ wall })
    const defaultMinedResult = await reachPosition(defaultMined, { position: { x: 6.5, y: 64, z: 0.5 } })
    assert.equal(defaultMinedResult.status, 'reached', JSON.stringify(defaultMinedResult))
    assert.ok(defaultMinedResult.edits.some(edit => edit.kind === 'dug'))

    const bridge = makeBot({ gap: [2, 3, 4], corridor: true })
    const bridgeResult = await reachPosition(bridge, {
      position: { x: 6.5, y: 64, z: 0.5 }, allowScaffold: true, scaffoldBlocks: ['dirt'],
    })
    assert.equal(bridgeResult.status, 'reached', JSON.stringify(bridgeResult))
    assert.ok(bridgeResult.edits.filter(edit => edit.kind === 'scaffold_placed').length >= 2, JSON.stringify({ bridgeResult, paths: bridge.testState.paths }))
    assert.ok(bridgeResult.edits.some(edit => edit.kind === 'scaffold_removed'), JSON.stringify(bridgeResult))
    assert.ok(bridge.testState.edits.filter(edit => edit.kind === 'server_place').length >= 2)
    assert.equal(bridgeResult.cleanupRequired.length, 0)
    assert.equal(bridge.pathfinder.movements.original, true)

    const defaultBridge = makeBot({ gap: [2, 3, 4], corridor: true })
    const defaultBridgeResult = await reachPosition(defaultBridge, { position: { x: 6.5, y: 64, z: 0.5 } })
    assert.equal(defaultBridgeResult.status, 'reached', JSON.stringify(defaultBridgeResult))
    assert.ok(defaultBridgeResult.edits.some(edit => edit.kind === 'scaffold_placed'))

    const partialInventory = makeBot({ gap: [2, 3, 4], corridor: true })
    partialInventory.testState.inventory.cobblestone = 0
    const partialInventoryResult = await reachPosition(partialInventory, {
      position: { x: 6.5, y: 64, z: 0.5 }, allowScaffold: true, scaffoldBlocks: ['dirt', 'cobblestone'],
    })
    assert.equal(partialInventoryResult.status, 'reached', JSON.stringify(partialInventoryResult))
    assert.ok(partialInventoryResult.edits.filter(edit => edit.kind === 'scaffold_placed').every(edit => edit.block === 'dirt'))

    const uncleanableScaffold = makeBot({ gap: [2, 3, 4], corridor: true, rejectScaffoldRemoval: true })
    const uncleanable = await reachPosition(uncleanableScaffold, {
      position: { x: 6.5, y: 64, z: 0.5 }, allowScaffold: true, scaffoldBlocks: ['dirt'],
    })
    assert.notEqual(uncleanable.status, 'reached', JSON.stringify(uncleanable))
    assert.equal(uncleanable.ok, false)
    assert.ok(uncleanable.cleanupRequired.length > 0)

    const climbWall = []
    for (const y of [64, 65]) for (let z = -4; z <= 4; z++) climbWall.push({ x: 3, y, z })
    const pillar = makeBot({ platform: true, wall: climbWall, corridor: true })
    const climbed = await reachPosition(pillar, {
      position: { x: 6.5, y: 66, z: 0.5 }, allowScaffold: true, scaffoldBlocks: ['cobblestone'],
    })
    assert.notEqual(climbed.status, 'reached', JSON.stringify(climbed))
    assert.equal(climbed.ok, false)
    assert.ok(climbed.finalPosition && Math.hypot(climbed.finalPosition.x - 6.5, climbed.finalPosition.y - 66, climbed.finalPosition.z - 0.5) <= 1,
      'the climb reaches the requested tolerance even though an unsafe scaffold cleanup prevents success')
    assert.ok(climbed.edits.filter(edit => edit.kind === 'scaffold_placed').length > 0, JSON.stringify(climbed))
    assert.ok(climbed.cleanupRequired.length > 0, JSON.stringify(climbed))

    const streaming = makeBot({ loadedMaxX: 16 })
    setTimeout(() => streaming.testState.loadThrough(32), 50)
    const streamed = await reachPosition(streaming, { position: { x: 24.5, y: 64, z: 0.5 } })
    assert.equal(streamed.status, 'reached', JSON.stringify(streamed))
    const unloaded = makeBot({ loadedMaxX: 16 })
    const timedOut = await reachPosition(unloaded, { position: { x: 24.5, y: 64, z: 0.5 } })
    assert.equal(timedOut.status, 'blocked', JSON.stringify(timedOut))
    assert.ok(timedOut.finalPosition.x > 0.5, 'moves through the loaded segment before refusing the unloaded continuation')

    const native = makeBot({ wall })
    const { createOperationContext, runOwnedOperation } = await import(pathToFileURL(path.join(root, 'src/agent/library/operation_context.js')))
    const owner = createOperationContext({ id: 'reach-position-native-scope', controller: new AbortController() }, { bot: native }, { intentEpoch: 1 })
    owner.nativeNavigationNoEdits = true
    const scopedResult = await runOwnedOperation(owner, async () => {
      const result = await skills.reachPosition(native, { position: { x: 6.5, y: 64, z: 0.5 }, allowDig: true })
      assert.equal(result.status, 'reached', JSON.stringify(result))
      await skills.goToGoal(native, new pathfinder.goals.GoalNear(8, 64, 0, 1), new pathfinder.Movements(native))
      return result
    })
    assert.equal(scopedResult.ok, true)
    const ordinaryMovement = native.pathfinder.movements
    assert.equal(ordinaryMovement.canDig, false, 'explicit edits do not leak to a later native navigation call')
    assert.equal(ordinaryMovement.allow1by1towers, false)
    assert.deepEqual(ordinaryMovement.scafoldingBlocks, [])

    const rejectedPlacement = makeBot({ gap: [2, 3, 4], corridor: true })
    rejectedPlacement.testState.placementMode = 'reject'
    const rejected = await reachPosition(rejectedPlacement, {
      position: { x: 6.5, y: 64, z: 0.5 }, allowScaffold: true, scaffoldBlocks: ['dirt'],
    })
    assert.notEqual(rejected.status, 'reached', JSON.stringify(rejected))
    assert.equal(rejected.ok, false)
    assert.equal(rejected.edits.some(edit => edit.kind === 'scaffold_placed'), false, 'optimistic pathfinder state is not counted as a server placement')
    assert.equal(rejectedPlacement.pathfinder.movements.original, true)

    const delayedPlacement = makeBot({ gap: [2, 3, 4], corridor: true })
    delayedPlacement.testState.placementDelay = 30
    const delayed = await reachPosition(delayedPlacement, {
      position: { x: 6.5, y: 64, z: 0.5 }, allowScaffold: true, scaffoldBlocks: ['dirt'],
    })
    assert.equal(delayed.status, 'reached', JSON.stringify(delayed))
    assert.ok(delayed.edits.some(edit => edit.kind === 'scaffold_placed'))

    const cancelledPlacement = makeBot({ gap: [2, 3, 4], corridor: true })
    cancelledPlacement.testState.placementDelay = 100
    const cancelPromise = reachPosition(cancelledPlacement, {
      position: { x: 6.5, y: 64, z: 0.5 }, allowScaffold: true, scaffoldBlocks: ['dirt'],
    })
    await delay(20)
    cancelledPlacement.interrupt_code = true
    const cancelled = await cancelPromise
    assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancelled))
    assert.equal(cancelledPlacement.pathfinder.movements.original, true)
    assert.ok(cancelled.cleanupRequired.length > 0, 'a placement confirmed after cancellation is reported for cleanup')

    const noInventory = makeBot({ gap: [2, 3, 4], corridor: true })
    noInventory.testState.inventory.dirt = 0
    const noMaterial = await reachPosition(noInventory, {
      position: { x: 6.5, y: 64, z: 0.5 }, allowScaffold: true, scaffoldBlocks: ['dirt'],
    })
    assert.equal(noMaterial.status, 'blocked')
    assert.equal(noInventory.testState.edits.length, 0, 'missing scaffold materials fail before edits')

    const unsupportedDrop = makeBot({ gap: [2, 3, 4], corridor: true })
    const dropResult = await reachPosition(unsupportedDrop, { position: { x: 6.5, y: 64, z: 0.5 }, allowDig: false, allowScaffold: false })
    assert.equal(dropResult.status, 'blocked', JSON.stringify(dropResult))
    assert.equal(unsupportedDrop.testState.edits.length, 0)

    const unsafeWater = makeBot({ corridor: true, hazards: [{ x: 2, y: 64, z: 0, name: 'water' }] })
    const waterBlocked = await reachPosition(unsafeWater, { position: { x: 6.5, y: 64, z: 0.5 } })
    assert.equal(waterBlocked.status, 'blocked', JSON.stringify(waterBlocked))
    const shallowWater = makeBot({ corridor: true, hazards: [{ x: 2, y: 64, z: 0, name: 'water' }] })
    const waterCrossed = await reachPosition(shallowWater, { position: { x: 6.5, y: 64, z: 0.5 }, safeWater: true })
    assert.equal(waterCrossed.status, 'reached', JSON.stringify(waterCrossed))
    const deepWater = makeBot({ corridor: true, hazards: [
      { x: 2, y: 64, z: 0, name: 'water' }, { x: 2, y: 63, z: 0, name: 'water' },
    ] })
    const deepWaterBlocked = await reachPosition(deepWater, { position: { x: 6.5, y: 64, z: 0.5 }, safeWater: true })
    assert.equal(deepWaterBlocked.status, 'blocked', JSON.stringify(deepWaterBlocked))

    const lava = makeBot({ corridor: true, hazards: [{ x: 2, y: 64, z: 0, name: 'lava' }] })
    const lavaBlocked = await reachPosition(lava, { position: { x: 6.5, y: 64, z: 0.5 }, allowDig: true, safeWater: true })
    assert.equal(lavaBlocked.status, 'blocked', JSON.stringify(lavaBlocked))
    assert.equal(lava.testState.edits.some(edit => edit.block === 'lava'), false, 'hazard blocks are never excavated')

    console.log('reachPosition real pathfinder movement/A* fixtures passed (open, mining, scaffolded routes, hazards, server confirmation, cancellation, chunk progression, native scope and restoration)')
  } finally {
    delete globalThis.mcRegistry
    await rm(root, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
