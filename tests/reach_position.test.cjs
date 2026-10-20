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
  for (const name of ['skills', 'block_placement', 'block_interaction', 'operation_context', 'navigation_policy', 'crafting_sync', 'native_sdk']) {
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

function makeBot({ gap = [], wall = [], hazards = [], unknown = [], solidBlocks = [], platform = false, corridor = false,
  loadedMaxX = 16, floorY = 63, startY = floorY + 1, rejectScaffoldRemoval = false, navigationDelay = 0,
  airborneArrival = false, scaffoldInventory = { dirt: 16, cobblestone: 16 } } = {}) {
  const bot = new EventEmitter()
  const world = new EventEmitter()
  const states = new Map()
  const inventory = { ...scaffoldInventory }
  const edits = []
  let loadedThroughX = loadedMaxX
  let placementMode = 'accept'
  let placementDelay = 0
  let placementAttempts = 0
  let pendingPlacementActions = 0
  let pathAdvancedWhilePlacementPending = false
  const paths = []
  bot.testState = { edits, inventory, paths, equippedForBlocks: [], get placementMode() { return placementMode }, set placementMode(value) { placementMode = value }, set placementDelay(value) { placementDelay = value }, get placementAttempts() { return placementAttempts }, get pendingPlacementActions() { return pendingPlacementActions }, get pathAdvancedWhilePlacementPending() { return pathAdvancedWhilePlacementPending } }
  bot.registry = registry
  bot.version = '1.21.1'
  bot.output = ''
  bot.interrupt_code = false
  bot.game = { minY: 60, height: 60, dimension: 'overworld', gameMode: 'survival' }
  bot.entity = { id: 1, position: new Vec3(0.5, startY, 0.5), onGround: true, eyeHeight: 1.62, effects: {}, velocity: { x: 0, z: 0 } }
  bot.health = 20
  bot.entities = {}
  bot.world = world
  const loaded = (x, z) => x >= -8 && x <= loadedThroughX && z >= -4 && z <= 4
  bot.testState.loadThrough = x => { loadedThroughX = x; world.emit('chunkColumnLoad', new Vec3(x, 0, 0)) }
  const getName = p => {
    const cell = p.floored()
    if (!loaded(cell.x, cell.z) || cell.y < 60 || cell.y > 110) return null
    if (unknown.some(point => point.x === cell.x && point.y === cell.y && point.z === cell.z)) return null
    const explicit = states.get(key(cell))
    if (explicit) return explicit.name
    const hazard = hazards.find(point => point.x === cell.x && point.y === cell.y && point.z === cell.z)
    if (hazard) return hazard.name
    const solid = solidBlocks.find(point => point.x === cell.x && point.y === cell.y && point.z === cell.z)
    if (solid) return solid.name ?? 'stone'
    if (corridor && cell.z !== 0 && cell.y >= floorY + 1 && cell.y <= Math.max(floorY + 2, startY + 4)) return 'stone'
    if (platform && cell.x >= 4 && cell.x <= 10 && cell.y === floorY + 2) return 'stone'
    if (gap.includes(cell.x) && cell.y <= floorY) return 'air'
    if (cell.y < floorY) return 'stone'
    if (cell.y === floorY) return 'stone'
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
  const controls = new Map()
  bot.setControlState = (name, value) => {
    controls.set(name, value)
    if (name === 'jump' && value) setTimeout(() => {
      if (controls.get('jump')) bot.entity.position = bot.entity.position.offset(0, 1.2, 0)
    }, 30)
  }
  bot.clearControlStates = () => {}
  bot.getControlState = name => !!controls.get(name)
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
    placementAttempts++
    if (placementDelay) await delay(placementDelay)
    if (placementMode === 'reject') return
    if (placementMode === 'no-ack') return
    const oldBlock = blockAt(p)
    if (oldBlock?.type !== 0) return
    if (placementMode === 'late-confirm') {
      return new Promise(resolve => {
        let resolved = false
        const resolveOnStaleAir = (_old, current) => {
          if (current?.position && key(current.position) === key(p) && current.name === 'air' && !resolved) {
            resolved = true
            bot.removeListener('blockUpdate', resolveOnStaleAir)
            resolve()
          }
        }
        bot.on('blockUpdate', resolveOnStaleAir)
        states.set(key(p), { name: 'stone' })
        const predictedStone = blockAt(p)
        states.set(key(p), { name: 'air' })
        const staleAir = blockAt(p)
        bot.emit('blockUpdate', predictedStone, staleAir)
        bot.emit(`blockUpdate:${p}`, predictedStone, staleAir)
        setTimeout(() => {
          const stale = blockAt(p)
          states.set(key(p), { name: bot.heldItem.name })
          inventory[bot.heldItem.name]--
          const confirmed = blockAt(p)
          edits.push({ kind: 'server_place', block: bot.heldItem.name, position: { x: p.x, y: p.y, z: p.z } })
          bot.emit('blockUpdate', stale, confirmed)
          bot.emit(`blockUpdate:${p}`, stale, confirmed)
        }, 80)
      })
    }
    if (placementMode === 'late-confirm-delayed-reject') {
      pendingPlacementActions++
      return new Promise((_resolve, reject) => {
        states.set(key(p), { name: 'stone' })
        const predictedStone = blockAt(p)
        states.set(key(p), { name: 'air' })
        const staleAir = blockAt(p)
        bot.emit('blockUpdate', predictedStone, staleAir)
        bot.emit(`blockUpdate:${p}`, predictedStone, staleAir)
        setTimeout(() => {
          const stale = blockAt(p)
          states.set(key(p), { name: bot.heldItem.name })
          inventory[bot.heldItem.name]--
          const confirmed = blockAt(p)
          edits.push({ kind: 'server_place', block: bot.heldItem.name, position: { x: p.x, y: p.y, z: p.z } })
          bot.emit('blockUpdate', stale, confirmed)
          bot.emit(`blockUpdate:${p}`, stale, confirmed)
          setTimeout(() => {
            pendingPlacementActions--
            reject(new Error('Place promise rejected after the authoritative block update.'))
          }, 120)
        }, 80)
      })
    }
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
        if (pendingPlacementActions > 0) pathAdvancedWhilePlacementPending = true
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
      if (airborneArrival) {
        bot.entity.position = bot.entity.position.offset(0, 0.25, 0)
        bot.entity.onGround = false
      } else {
        bot.entity.onGround = true
      }
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
    const { createNativeSdk } = await import(pathToFileURL(path.join(root, 'src/agent/library/native_sdk.js')))
    const { registerNavigationCleanup } = await import(pathToFileURL(path.join(root, 'src/agent/library/navigation_policy.js')))
    const { runWithNavigationPolicy } = await import(pathToFileURL(path.join(root, 'src/agent/library/navigation_policy.js')))
    const { placeAndConfirmNavigationScaffold } = await import(pathToFileURL(path.join(root, 'src/agent/library/navigation_policy.js')))
    const { beginNavigationEdit, navigationScaffoldPlacementPending, withNavigationScaffoldTickGate } = await import(pathToFileURL(path.join(root, 'src/agent/library/navigation_policy.js')))
    const wall = []
    for (let z = -4; z <= 4; z++) for (const y of [64, 65]) wall.push({ x: 3, y, z, name: 'dirt' })

    const nativeDefault = makeBot({ wall })
    const nativeDefaultResult = await skills.goToPosition(nativeDefault, {
      position: { x: 6.5, y: 64, z: 0.5 },
    })
    assert.equal(nativeDefaultResult.status, 'blocked', JSON.stringify(nativeDefaultResult))
    assert.equal(nativeDefaultResult.ok, false)
    assert.deepEqual(nativeDefault.testState.edits, [], 'native ordinary movement defaults to no route edits')

    const nativeTemporary = makeBot({ gap: [2, 3, 4], corridor: true })
    const nativeTemporaryResult = await skills.goToPosition(nativeTemporary, {
      position: { x: 6.5, y: 64, z: 0.5 }, scaffold: 'temporary', scaffoldBlocks: ['dirt'],
    })
    assert.equal(nativeTemporaryResult.status, 'reached', JSON.stringify(nativeTemporaryResult))
    assert.equal(nativeTemporaryResult.ok, true)
    assert.equal(nativeTemporaryResult.cleanupRequired.length, 0)
    assert.ok(nativeTemporaryResult.edits.some(edit => edit.kind === 'scaffold_placed'))
    assert.ok(nativeTemporaryResult.edits.some(edit => edit.kind === 'scaffold_removed'))

    const sdkTemporary = makeBot({ gap: [2, 3, 4], corridor: true })
    const sdk = createNativeSdk({ bot: sdkTemporary, skills })
    const sdkRouteResult = await sdk.skills.goToPosition({ position: { x: 6.5, y: 64, z: 0.5 } })
    assert.equal(sdkRouteResult.ok, true, JSON.stringify(sdkRouteResult))
    assert.equal(sdkRouteResult.status, 'reached')
    assert.equal(Object.hasOwn(sdkRouteResult, 'edits'), false)
    assert.equal(Object.hasOwn(sdkRouteResult, 'cleanupRequired'), false)
    assert.ok(sdkTemporary.testState.edits.some(edit => edit.kind === 'server_place'), 'native goToPosition may use temporary route scaffolds')
    assert.ok(sdkTemporary.testState.edits.some(edit => edit.kind === 'server_dig'), 'native goToPosition removes its confirmed route scaffolds before success')

    const nativeLeave = makeBot({ gap: [2, 3, 4], corridor: true })
    const nativeReachSdk = createNativeSdk({ bot: nativeLeave, skills })
    const nativeLeaveResult = await nativeReachSdk.skills.reachPosition({ position: { x: 6.5, y: 64, z: 0.5 } })
    assert.equal(nativeLeaveResult.status, 'reached', JSON.stringify(nativeLeaveResult))
    assert.equal(nativeLeaveResult.ok, true)
    assert.equal(nativeLeaveResult.arrivalReached, true)
    assert.equal(Object.hasOwn(nativeLeaveResult, 'cleanupRequired'), false)
    assert.ok(nativeLeave.testState.edits.some(edit => edit.kind === 'server_place'), 'native reachPosition leaves confirmed scaffolds in place')
    assert.equal(nativeLeave.testState.edits.some(edit => edit.kind === 'server_dig'), false, 'native reachPosition does no route cleanup')
    assert.ok(nativeLeave.testState.inventory.dirt < 16, 'left scaffolds remain in the world and consume only the blocks actually placed')

    const noScaffoldMaterials = makeBot()
    noScaffoldMaterials.testState.inventory.dirt = 0
    noScaffoldMaterials.testState.inventory.cobblestone = 0
    const noMaterialSdk = createNativeSdk({ bot: noScaffoldMaterials, skills })
    assert.equal((await noMaterialSdk.skills.goToPosition({ position: { x: 5.5, y: 64, z: 0.5 } })).ok, true,
      'preservation movement succeeds on a clear route without scaffold materials')
    noScaffoldMaterials.entity.position = new Vec3(0.5, 64, 0.5)
    assert.equal((await noMaterialSdk.skills.reachPosition({ position: { x: 5.5, y: 64, z: 0.5 } })).ok, true,
      'editable movement succeeds on a clear route without scaffold materials')

    const nativeTemporaryIncomplete = makeBot({ gap: [2, 3, 4], corridor: true, rejectScaffoldRemoval: true })
    const nativeTemporaryIncompleteResult = await skills.goToPosition(nativeTemporaryIncomplete, {
      position: { x: 6.5, y: 64, z: 0.5 }, scaffold: 'temporary', scaffoldBlocks: ['dirt'],
    })
    assert.equal(nativeTemporaryIncompleteResult.status, 'blocked', JSON.stringify(nativeTemporaryIncompleteResult))
    assert.equal(nativeTemporaryIncompleteResult.ok, false)
    assert.ok(nativeTemporaryIncompleteResult.cleanupRequired.length > 0)
    assert.equal(nativeTemporaryIncompleteResult.arrivalReached, true, 'arrival remains recorded independently from failed cleanup')

    const sdkTemporaryIncomplete = makeBot({ gap: [2, 3, 4], corridor: true, rejectScaffoldRemoval: true })
    const sdkIncompleteResult = await createNativeSdk({ bot: sdkTemporaryIncomplete, skills }).skills.goToPosition({
      position: { x: 6.5, y: 64, z: 0.5 },
    })
    assert.equal(sdkIncompleteResult.ok, false, JSON.stringify(sdkIncompleteResult))
    assert.equal(sdkIncompleteResult.status, 'blocked')
    assert.equal(sdkIncompleteResult.arrivalReached, true,
      'the public native mapping preserves confirmed arrival while reporting unfinished temporary cleanup')

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

    const blocked = makeBot({ wall })
    const blockedMovements = blocked.pathfinder.movements
    const blockedResult = await reachPosition(blocked, { position: { x: 6.5, y: 64, z: 0.5 }, allowDig: false, allowScaffold: false })
    assert.equal(blockedResult.status, 'blocked', JSON.stringify(blockedResult))
    assert.match(blocked.output, /\[reachPosition-route\].*"searchStatus":/)
    assert.equal(blocked.testState.edits.length, 0, 'explicitly disabled edits leave the wall untouched')
    assert.equal(blocked.pathfinder.movements, blockedMovements)

    const mined = makeBot({ wall })
    const minedResult = await reachPosition(mined, { position: { x: 6.5, y: 64, z: 0.5 }, allowDig: true, allowScaffold: false })
    assert.equal(minedResult.status, 'reached', JSON.stringify(minedResult))
    assert.ok(minedResult.edits.some(edit => edit.kind === 'dug'))
    assert.ok(mined.testState.edits.some(edit => edit.kind === 'server_dig'))
    assert.ok(mined.testState.equippedForBlocks.length > 0, 'the suitable tool is equipped before route mining')

    const defaultMined = makeBot({ wall })
    const defaultMinedResult = await reachPosition(defaultMined, { position: { x: 6.5, y: 64, z: 0.5 }, allowScaffold: false })
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

    const recoverableBridge = makeBot({ gap: [2, 3, 4], corridor: true })
    const recovered = await skills.reachPositionWithScaffoldCleanup(recoverableBridge, {
      position: { x: 6.5, y: 64, z: 0.5 }, scaffoldBlocks: ['dirt'],
    })
    assert.equal(recovered.status, 'reached', JSON.stringify(recovered))
    assert.equal(recovered.ok, true)
    assert.ok(recovered.edits.some(edit => edit.kind === 'scaffold_placed'))
    assert.ok(recovered.edits.some(edit => edit.kind === 'scaffold_removed'))
    assert.equal(recovered.cleanupRequired.length, 0)
    assert.equal(recoverableBridge.testState.edits.some(edit => edit.kind === 'server_dig' && edit.block === 'dirt'), true)

    const unrecoverableBridge = makeBot({ gap: [2, 3, 4], corridor: true, rejectScaffoldRemoval: true })
    const recoveryFailed = await skills.reachPositionWithScaffoldCleanup(unrecoverableBridge, {
      position: { x: 6.5, y: 64, z: 0.5 }, scaffoldBlocks: ['dirt'],
    })
    assert.equal(recoveryFailed.status, 'blocked', JSON.stringify(recoveryFailed))
    assert.equal(recoveryFailed.ok, false)
    assert.ok(recoveryFailed.cleanupRequired.length > 0)
    assert.match(recoveryFailed.reason, /could not be removed/)

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
    assert.equal(uncleanable.status, 'reached', JSON.stringify(uncleanable))
    assert.equal(uncleanable.ok, true)
    assert.ok(uncleanable.cleanupRequired.length > 0)
    assert.match(uncleanable.reason, /optional cleanup/)

    const climbWall = []
    for (const y of [64, 65]) for (let z = -4; z <= 4; z++) climbWall.push({ x: 3, y, z })
    const pillar = makeBot({ platform: true, wall: climbWall, corridor: true })
    const climbed = await reachPosition(pillar, {
      position: { x: 6.5, y: 66, z: 0.5 }, allowScaffold: true, scaffoldBlocks: ['cobblestone'],
    })
    assert.equal(climbed.status, 'reached', JSON.stringify(climbed))
    assert.equal(climbed.ok, true)
    assert.ok(climbed.finalPosition && Math.hypot(climbed.finalPosition.x - 6.5, climbed.finalPosition.y - 66, climbed.finalPosition.z - 0.5) <= 1,
      'the climb reaches the requested tolerance')
    assert.ok(climbed.edits.filter(edit => edit.kind === 'scaffold_placed').length > 0, JSON.stringify(climbed))
    assert.ok(climbed.cleanupRequired.length > 0, JSON.stringify(climbed))
    assert.match(climbed.reason, /optional cleanup/)

    const threeBlockWall = []
    for (const y of [81, 82, 83]) threeBlockWall.push({ x: 3, y, z: 0, name: 'dirt' })
    const safeThreeBlockDrop = makeBot({ wall: threeBlockWall, corridor: true, floorY: 80, startY: 81 })
    const safeThreeBlockDropResult = await reachPosition(safeThreeBlockDrop, {
      position: { x: 6.5, y: 81, z: 0.5 }, allowDig: false, allowScaffold: true, scaffoldBlocks: ['dirt'],
    })
    assert.equal(safeThreeBlockDropResult.status, 'reached', JSON.stringify({ result: safeThreeBlockDropResult, paths: safeThreeBlockDrop.testState.paths }))
    assert.ok(Math.abs(safeThreeBlockDrop.entity.position.y - 81) <= 1, JSON.stringify(safeThreeBlockDropResult))
    assert.ok(safeThreeBlockDropResult.edits.some(edit => edit.kind === 'scaffold_placed'))
    assert.ok(safeThreeBlockDropResult.cleanupRequired.length > 0, 'safe arrival remains distinct from unreachable optional scaffold cleanup')

    const fourBlockDrop = makeBot({ corridor: true, floorY: 80, startY: 85,
      solidBlocks: [0, 1, 2].map(x => ({ x, y: 84, z: 0, name: 'stone' })) })
    const fourBlockDropResult = await reachPosition(fourBlockDrop, {
      position: { x: 6.5, y: 81, z: 0.5 }, allowDig: false, allowScaffold: false,
    })
    assert.notEqual(fourBlockDropResult.status, 'reached', JSON.stringify(fourBlockDropResult))
    assert.equal(fourBlockDrop.testState.edits.length, 0, 'four-block fall remains refused without route edits')

    for (const [label, blockedCell, safeWater] of [
      ['unknown', null, false], ['water', { x: 6, y: 80, z: 0, name: 'water' }, true],
      ['lava', { x: 6, y: 80, z: 0, name: 'lava' }, true],
      ['magma', { x: 6, y: 80, z: 0, name: 'magma_block' }, true],
    ]) {
      const options = { wall: threeBlockWall, corridor: true, floorY: 80, startY: 81, safeWater }
      if (label === 'unknown') options.unknown = [{ x: 6, y: 80, z: 0 }]
      else options.hazards = [blockedCell]
      const blockedLanding = makeBot(options)
      const blockedLandingResult = await reachPosition(blockedLanding, {
        position: { x: 6.5, y: 81, z: 0.5 }, tolerance: 0.75, allowDig: false, allowScaffold: true, scaffoldBlocks: ['dirt'],
      })
      assert.notEqual(blockedLandingResult.status, 'reached', `${label}: ${JSON.stringify(blockedLandingResult)}`)
    }

    const finalSupport = makeBot({ gap: [6], corridor: true })
    const supportedArrival = await reachPosition(finalSupport, {
      position: { x: 6.5, y: 64, z: 0.5 }, allowScaffold: true, scaffoldBlocks: ['dirt'],
    })
    assert.equal(supportedArrival.status, 'reached', JSON.stringify(supportedArrival))
    assert.equal(supportedArrival.ok, true)
    assert.ok(supportedArrival.cleanupRequired.length > 0, JSON.stringify(supportedArrival))
    assert.ok(supportedArrival.cleanupRequired.every(item => item.reason === 'Scaffold supports the bot at its current position.'), JSON.stringify(supportedArrival))
    assert.match(supportedArrival.reason, /optional cleanup/)

    const makeRepeatedScaffoldBot = () => {
      const bot = makeBot()
      bot.entity.position = new Vec3(-1.5, 64, 0.5)
      bot.pathfinder.getPathFromTo = function* () {
        yield { result: { status: 'success', path: [{ x: 0, y: 64, z: 0 }] } }
      }
      bot.pathfinder.goto = async function (goal) {
        this.goal = goal
        const support = bot.blockAt(new Vec3(0, 63, 0))
        const dirt = bot.inventory.items().find(item => item.name === 'dirt')
        await bot.equip(dirt)
        await bot.placeBlock(support, new Vec3(0, 1, 0))
        await bot.dig(bot.blockAt(new Vec3(0, 64, 0)))
        await bot.equip(dirt)
        await bot.placeBlock(support, new Vec3(0, 1, 0))
        bot.entity.position = new Vec3(0.5, 64.25, 0.5)
        bot.entity.onGround = false
        this.goal = null
        return true
      }
      return bot
    }
    const repeatedScaffold = makeRepeatedScaffoldBot()
    const repeatedScaffoldResult = await reachPosition(repeatedScaffold, {
      position: { x: 0.5, y: 64, z: 0.5 }, allowScaffold: true, scaffoldBlocks: ['dirt'],
    })
    assert.equal(repeatedScaffoldResult.status, 'reached', JSON.stringify(repeatedScaffoldResult))
    assert.equal(repeatedScaffoldResult.edits.filter(edit => edit.kind === 'scaffold_placed').length, 2,
      'placement edit history retains both confirmed placements at one position')
    assert.equal(repeatedScaffoldResult.cleanupRequired.filter(item => item.x === 0 && item.y === 64 && item.z === 0).length, 1,
      `owned scaffold cleanup state is upserted by coordinate: ${JSON.stringify(repeatedScaffoldResult)}`)
    const strictRepeatedScaffold = makeRepeatedScaffoldBot()
    const strictRepeatedScaffoldResult = await skills.reachPositionWithScaffoldCleanup(strictRepeatedScaffold, {
      position: { x: 0.5, y: 64, z: 0.5 }, scaffoldBlocks: ['dirt'],
    })
    assert.equal(strictRepeatedScaffoldResult.arrivalReached, true)
    assert.equal(strictRepeatedScaffoldResult.status, 'blocked')
    assert.equal(strictRepeatedScaffoldResult.cleanupRequired.filter(item => item.x === 0 && item.y === 64 && item.z === 0).length, 1)

    const airborneSupport = makeBot({ gap: [2, 3, 4], corridor: true, airborneArrival: true })
    const airborneSupportResult = await reachPosition(airborneSupport, {
      position: { x: 4.5, y: 64, z: 0.5 }, allowScaffold: true, scaffoldBlocks: ['dirt'],
    })
    assert.equal(airborneSupportResult.status, 'reached', JSON.stringify(airborneSupportResult))
    assert.equal(airborneSupport.entity.onGround, false)
    assert.ok(airborneSupportResult.cleanupRequired.some(item => item.reason === 'Scaffold supports the bot at its current position.'), JSON.stringify(airborneSupportResult))
    assert.equal(airborneSupport.blockAt(new Vec3(4, 63, 0)).name, 'dirt', 'cleanup leaves the airborne bot’s owned support block intact')

    const strictAirborneSupport = makeBot({ gap: [2, 3, 4], corridor: true, airborneArrival: true })
    const strictAirborneSupportResult = await skills.reachPositionWithScaffoldCleanup(strictAirborneSupport, {
      position: { x: 4.5, y: 64, z: 0.5 }, scaffoldBlocks: ['dirt'],
    })
    assert.equal(strictAirborneSupportResult.arrivalReached, true, JSON.stringify(strictAirborneSupportResult))
    assert.equal(strictAirborneSupportResult.status, 'blocked', JSON.stringify(strictAirborneSupportResult))
    assert.ok(strictAirborneSupportResult.cleanupRequired.length > 0)

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

    const policyMovement = makeBot({ wall })
    const policyOwner = createOperationContext({ id: 'route-policy-owner', controller: new AbortController() }, { bot: policyMovement }, { intentEpoch: 1 })
    policyOwner.nativeNavigationNoEdits = true
    const { trackNavigationSegment } = await import(pathToFileURL(path.join(root, 'src/agent/library/navigation_policy.js')))
    const policyResult = await runOwnedOperation(policyOwner, () => runWithNavigationPolicy(policyMovement,
      { allowDig: true, scaffold: 'forbid', scaffoldBlocks: ['dirt', 'cobblestone'] },
      () => skills.goToGoal(policyMovement, new pathfinder.goals.GoalNear(6, 64, 0, 1))));
    assert.equal(policyResult, true, 'navigation scope preserves the skill return value')
    assert.ok(policyMovement.testState.edits.some(edit => edit.kind === 'server_dig'))
    assert.equal(policyMovement.testState.edits.some(edit => edit.kind === 'server_place'), false)

    const goalOwnerBot = makeBot()
    let finishOldBody
    const ownedGoal = new pathfinder.goals.GoalBlock(2, 64, 0)
    const replacementGoal = new pathfinder.goals.GoalBlock(8, 64, 0)
    const oldPolicy = runWithNavigationPolicy(goalOwnerBot,
      { allowDig: false, scaffold: 'forbid', scaffoldBlocks: [] }, async () => {
        goalOwnerBot.pathfinder.setGoal(ownedGoal)
        await new Promise(resolve => { finishOldBody = resolve })
        return true
      })
    await new Promise(resolve => setImmediate(resolve))
    goalOwnerBot.pathfinder.setGoal(replacementGoal)
    finishOldBody()
    await oldPolicy
    assert.equal(goalOwnerBot.pathfinder.goal, replacementGoal,
      'a settled old navigation policy cannot clear a replacement goal it does not own')

    const outerScaffoldBot = makeBot({ gap: [2, 3, 4], corridor: true })
    const outerScaffoldResult = await runWithNavigationPolicy(outerScaffoldBot,
      { allowDig: false, scaffold: 'temporary', scaffoldBlocks: ['dirt'] },
      () => trackNavigationSegment(outerScaffoldBot, () => trackNavigationSegment(outerScaffoldBot, async () => {
        await outerScaffoldBot.equip(outerScaffoldBot.inventory.items().find(item => item.name === 'dirt'))
        await outerScaffoldBot.placeBlock(outerScaffoldBot.blockAt(new Vec3(1, 63, 0)), new Vec3(0, 1, 0))
        return true
      })))
    assert.equal(outerScaffoldResult, true, 'navigation scope preserves its existing boolean result')
    assert.ok(outerScaffoldBot.testState.edits.some(edit => edit.kind === 'server_place'))
    assert.ok(outerScaffoldBot.testState.edits.some(edit => edit.kind === 'server_dig'))

    const earlyNoPathBot = makeBot()
    earlyNoPathBot.testState.placementDelay = 80
    await assert.rejects(() => runWithNavigationPolicy(earlyNoPathBot,
      { allowDig: false, scaffold: 'temporary', scaffoldBlocks: ['dirt'] },
      () => trackNavigationSegment(earlyNoPathBot, async () => {
        await earlyNoPathBot.equip(earlyNoPathBot.inventory.items().find(item => item.name === 'dirt'))
        void earlyNoPathBot.placeBlock(earlyNoPathBot.blockAt(new Vec3(1, 63, 0)), new Vec3(0, 1, 0))
        throw new Error('Pathfinder returned NoPath before the pending scaffold call settled.')
      })), /NoPath/)
    assert.ok(earlyNoPathBot.testState.edits.some(edit => edit.kind === 'server_place'))
    assert.ok(earlyNoPathBot.testState.edits.some(edit => edit.kind === 'server_dig'))

    const latePolicyBot = makeBot({ gap: [2, 3, 4], corridor: true })
    latePolicyBot.testState.placementMode = 'late-confirm'
    const latePolicyMovements = new pathfinder.Movements(latePolicyBot)
    latePolicyMovements.allowParkour = false
    latePolicyMovements.allowFreeMotion = false
    const latePolicyResult = await runWithNavigationPolicy(latePolicyBot,
      { allowDig: false, scaffold: 'temporary', scaffoldBlocks: ['dirt'] },
      () => skills.goToGoal(latePolicyBot, new pathfinder.goals.GoalBlock(6, 64, 0), latePolicyMovements))
    assert.equal(latePolicyResult, true, 'a successful movement keeps its boolean result')
    assert.ok(latePolicyBot.testState.edits.some(edit => edit.kind === 'server_place'))
    assert.ok(latePolicyBot.testState.edits.some(edit => edit.kind === 'server_dig'))

    const noAckPolicyBot = makeBot({ gap: [2, 3, 4], corridor: true })
    noAckPolicyBot.testState.placementMode = 'no-ack'
    const noAckPolicyMovements = new pathfinder.Movements(noAckPolicyBot)
    noAckPolicyMovements.allowParkour = false
    noAckPolicyMovements.allowFreeMotion = false
    await assert.rejects(() => runWithNavigationPolicy(noAckPolicyBot,
      { allowDig: false, scaffold: 'temporary', scaffoldBlocks: ['dirt'] },
      () => skills.goToGoal(noAckPolicyBot, new pathfinder.goals.GoalBlock(6, 64, 0), noAckPolicyMovements)),
      error => error.name === 'NavigationStallTimeoutError')
    assert.equal(noAckPolicyBot.testState.edits.some(edit => edit.kind === 'server_place'), false)

    const workTargetPolicyBot = makeBot({ wall: [{ x: 2, y: 64, z: 0, name: 'dirt' }] })
    const workTarget = { x: 2, y: 64, z: 0 }
    const workTargetPolicy = await runWithNavigationPolicy(workTargetPolicyBot,
      { allowDig: false, scaffold: 'forbid', scaffoldBlocks: ['dirt', 'cobblestone'] },
      () => trackNavigationSegment(workTargetPolicyBot, async () => {
        await workTargetPolicyBot.dig(workTargetPolicyBot.blockAt(new Vec3(workTarget.x, workTarget.y, workTarget.z)))
        await assert.rejects(() => workTargetPolicyBot.dig(workTargetPolicyBot.blockAt(new Vec3(3, 64, 0))), /forbids digging route blocks/)
        return true
      }, { workTarget }))
    assert.equal(workTargetPolicy, true, 'the selected work target keeps its own permission and return type')
    assert.equal(workTargetPolicyBot.testState.edits.filter(edit => edit.kind === 'server_dig').length, 1)

    const cancelledPolicyBot = makeBot()
    await assert.rejects(() => runWithNavigationPolicy(cancelledPolicyBot,
      { allowDig: false, scaffold: 'forbid', scaffoldBlocks: ['dirt'] }, async () => {
        cancelledPolicyBot.interrupt_code = true
        return true
      }), /cancelled/)

    const restoreCleanup = registerNavigationCleanup(async () => { throw new Error('cleanup fixture failure') })
    try {
      const cleanupFailureBot = makeBot()
      await assert.rejects(() => runWithNavigationPolicy(cleanupFailureBot,
        { allowDig: false, scaffold: 'temporary', scaffoldBlocks: ['dirt'] }, async () => ({ status: 'complete', count: 3 })), /cleanup fixture failure/)
    } finally { registerNavigationCleanup(restoreCleanup) }

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

    const latePlacement = makeBot({ gap: [2, 3, 4], corridor: true })
    latePlacement.testState.placementMode = 'late-confirm'
    const lateConfirmed = await skills.reachPositionWithScaffoldCleanup(latePlacement, {
      position: { x: 6.5, y: 64, z: 0.5 }, scaffoldBlocks: ['dirt'],
    })
    assert.equal(lateConfirmed.status, 'reached', JSON.stringify(lateConfirmed))
    assert.ok(lateConfirmed.edits.some(edit => edit.kind === 'scaffold_placed'), JSON.stringify(lateConfirmed))
    assert.ok(lateConfirmed.edits.some(edit => edit.kind === 'scaffold_removed'), JSON.stringify(lateConfirmed))
    assert.equal(lateConfirmed.cleanupRequired.length, 0)

    const confirmationBeforeReject = makeBot({ gap: [2, 3, 4], corridor: true })
    confirmationBeforeReject.testState.placementMode = 'late-confirm-delayed-reject'
    const confirmedBeforeRejectResult = await skills.reachPositionWithScaffoldCleanup(confirmationBeforeReject, {
      position: { x: 6.5, y: 64, z: 0.5 }, scaffoldBlocks: ['dirt'],
    })
    assert.equal(confirmedBeforeRejectResult.status, 'reached', JSON.stringify(confirmedBeforeRejectResult))
    assert.equal(confirmationBeforeReject.testState.pendingPlacementActions, 0, 'the raw place promise settles before the navigation caller resumes')
    assert.equal(confirmationBeforeReject.testState.pathAdvancedWhilePlacementPending, false, 'pathfinder never advances while the raw place promise is pending')
    assert.ok(confirmedBeforeRejectResult.edits.some(edit => edit.kind === 'scaffold_removed'))

    const noAckPlacement = makeBot({ gap: [2, 3, 4], corridor: true })
    noAckPlacement.testState.placementMode = 'no-ack'
    const noAck = await skills.reachPositionWithScaffoldCleanup(noAckPlacement, {
      position: { x: 6.5, y: 64, z: 0.5 }, scaffoldBlocks: ['dirt'],
    })
    assert.notEqual(noAck.status, 'reached', JSON.stringify(noAck))
    assert.ok(noAck.cleanupRequired.some(item => item.reason.includes('not server-confirmed')), JSON.stringify(noAck))
    assert.equal(noAck.cleanupRequired.filter(item => item.reason.includes('not server-confirmed')).length, 1)
    assert.equal(noAckPlacement.testState.placementAttempts, 1, 'an unconfirmed placement stops further route edits and replans')
    assert.equal(noAck.edits.some(edit => edit.kind === 'scaffold_placed'), false)

    const serializedPlacement = makeBot()
    serializedPlacement.entity.position = new Vec3(1.5, 64, 0.5)
    const placementTrace = []
    const firstSupport = serializedPlacement.blockAt(new Vec3(0, 63, 0))
    const firstTarget = firstSupport.position.offset(0, 1, 0)
    const secondTarget = firstTarget.offset(0, 1, 0)
    serializedPlacement.heldItem = serializedPlacement.inventory.items().find(item => item.name === 'dirt')
    const firstQueuedPlacement = placeAndConfirmNavigationScaffold(serializedPlacement, firstTarget, 'dirt', async () => {
      placementTrace.push({ event: 'raw-start', target: key(firstTarget), reference: firstSupport.name })
      setTimeout(() => serializedPlacement.placeBlock(firstSupport, new Vec3(0, 1, 0)), 60)
      return 'raw-promise-settled-before-server-update'
    })
    const secondQueuedPlacement = placeAndConfirmNavigationScaffold(serializedPlacement, secondTarget, 'dirt', async () => {
      const freshReference = serializedPlacement.blockAt(firstTarget)
      placementTrace.push({ event: 'raw-start', target: key(secondTarget), reference: freshReference?.name })
      assert.equal(freshReference?.name, 'dirt', 'a later placement starts only after the prior support is server-confirmed and is re-read')
      return serializedPlacement.placeBlock(freshReference, new Vec3(0, 1, 0))
    })
    await Promise.all([firstQueuedPlacement, secondQueuedPlacement])
    assert.deepEqual(placementTrace.map(entry => entry.event), ['raw-start', 'raw-start'])
    assert.equal(placementTrace[1].reference, 'dirt')

    const clearancePlacement = makeBot()
    const clearanceSupport = clearancePlacement.blockAt(new Vec3(0, 63, 0))
    const clearanceTarget = clearanceSupport.position.offset(0, 1, 0)
    clearancePlacement.heldItem = clearancePlacement.inventory.items().find(item => item.name === 'dirt')
    let pathfinderJumpResets = 0
    clearancePlacement.on('physicsTick', () => {
      pathfinderJumpResets++
      clearancePlacement.setControlState('jump', false)
    })
    const resetJumpTimer = setTimeout(() => clearancePlacement.emit('physicsTick'), 10)
    const clearedPlacement = await placeAndConfirmNavigationScaffold(clearancePlacement, clearanceTarget, 'dirt', async () => {
      assert.ok(clearancePlacement.entity.position.y >= clearanceTarget.y + 1.1,
        'a tower placement waits until the player clears the target block top')
      assert.equal(clearancePlacement.getControlState('jump'), false, 'the helper restores the prior jump state after clearance')
      return clearancePlacement.placeBlock(clearanceSupport, new Vec3(0, 1, 0))
    })
    clearTimeout(resetJumpTimer)
    assert.equal(pathfinderJumpResets, 1, 'the fixture simulates pathfinder clearing jump on physicsTick')
    assert.equal(clearedPlacement.block.name, 'dirt')

    const cancelledQueuedPlacement = makeBot()
    cancelledQueuedPlacement.entity.position = new Vec3(1.5, 64, 0.5)
    const cancelSupport = cancelledQueuedPlacement.blockAt(new Vec3(0, 63, 0))
    const cancelTarget = cancelSupport.position.offset(0, 1, 0)
    cancelledQueuedPlacement.heldItem = cancelledQueuedPlacement.inventory.items().find(item => item.name === 'dirt')
    let queuedRawStarts = 0
    const firstCancelPlacement = placeAndConfirmNavigationScaffold(cancelledQueuedPlacement, cancelTarget, 'dirt', async () => {
      setTimeout(() => cancelledQueuedPlacement.placeBlock(cancelSupport, new Vec3(0, 1, 0)), 60)
      return true
    })
    const secondCancelPlacement = placeAndConfirmNavigationScaffold(cancelledQueuedPlacement, cancelTarget.offset(0, 1, 0), 'dirt', async () => {
      queuedRawStarts++
      return true
    })
    setTimeout(() => { cancelledQueuedPlacement.interrupt_code = true }, 10)
    const cancellationOutcomes = await Promise.allSettled([firstCancelPlacement, secondCancelPlacement])
    assert.equal(cancellationOutcomes[0].status, 'fulfilled')
    assert.equal(cancellationOutcomes[1].status, 'rejected')
    assert.equal(queuedRawStarts, 0, 'a queued placement rechecks cancellation before starting its raw edit')

    const unknownQueuedPlacement = makeBot()
    unknownQueuedPlacement.entity.position = new Vec3(1.5, 64, 0.5)
    const unknownSupport = unknownQueuedPlacement.blockAt(new Vec3(0, 63, 0))
    const unknownTarget = unknownSupport.position.offset(0, 1, 0)
    let afterUnknownRawStarts = 0
    const unconfirmedFirst = placeAndConfirmNavigationScaffold(unknownQueuedPlacement, unknownTarget, 'dirt', async () => true)
    const afterUnknown = placeAndConfirmNavigationScaffold(unknownQueuedPlacement, unknownTarget.offset(0, 1, 0), 'dirt', async () => {
      afterUnknownRawStarts++
      return true
    })
    const unknownOutcomes = await Promise.allSettled([unconfirmedFirst, afterUnknown])
    assert.equal(unknownOutcomes[0].status, 'rejected')
    assert.equal(unknownOutcomes[1].status, 'rejected')
    assert.equal(afterUnknownRawStarts, 0, 'an unconfirmed placement invalidates already-queued scaffold attempts')

    const gatedPathfinderBot = makeBot()
    gatedPathfinderBot.entity.position = new Vec3(2.5, 64, 0.5)
    let pathfinderPhysicsTicks = 0
    let worldPhysicsTicks = 0
    const injectPlugin = plugin => setTimeout(() => plugin(gatedPathfinderBot, {}), 0)
    injectPlugin((pluginBot, pluginOptions) => withNavigationScaffoldTickGate(pluginBot, () => {
      assert.deepEqual(pluginOptions, {})
      pluginBot.on('physicsTick', () => pathfinderPhysicsTicks++)
    }))
    await delay(5)
    gatedPathfinderBot.on('physicsTick', () => worldPhysicsTicks++)
    const gateSupport = gatedPathfinderBot.blockAt(new Vec3(0, 63, 0))
    const gateTarget = gateSupport.position.offset(0, 1, 0)
    gatedPathfinderBot.heldItem = gatedPathfinderBot.inventory.items().find(item => item.name === 'dirt')
    const gatedPlacement = placeAndConfirmNavigationScaffold(gatedPathfinderBot, gateTarget, 'dirt', () => new Promise(resolve => {
      setTimeout(async () => resolve(await gatedPathfinderBot.placeBlock(gateSupport, new Vec3(0, 1, 0))), 40)
    }))
    await delay(5)
    assert.equal(navigationScaffoldPlacementPending(gatedPathfinderBot), true)
    gatedPathfinderBot.emit('physicsTick')
    assert.equal(pathfinderPhysicsTicks, 0, 'pathfinder physics listener is gated while a scaffold attempt is pending')
    assert.equal(worldPhysicsTicks, 1, 'other physics listeners and Minecraft physics remain active')
    await gatedPlacement
    assert.equal(navigationScaffoldPlacementPending(gatedPathfinderBot), false)
    gatedPathfinderBot.emit('physicsTick')
    assert.equal(pathfinderPhysicsTicks, 1, 'pathfinder resumes after authoritative placement settlement')
    assert.equal(worldPhysicsTicks, 2)

    const pendingRouteEditBot = makeBot()
    let pendingRoutePathfinderTicks = 0
    let pendingRouteWorldTicks = 0
    withNavigationScaffoldTickGate(pendingRouteEditBot, () => {
      pendingRouteEditBot.on('physicsTick', () => pendingRoutePathfinderTicks++)
    })
    pendingRouteEditBot.on('physicsTick', () => pendingRouteWorldTicks++)
    const releaseRouteEdit = beginNavigationEdit(pendingRouteEditBot)
    pendingRouteEditBot.emit('physicsTick')
    assert.equal(pendingRoutePathfinderTicks, 0, 'pathfinder route planning pauses while an owned route edit is unsettled')
    assert.equal(pendingRouteWorldTicks, 1, 'route edit gating leaves Minecraft physics listeners active')
    releaseRouteEdit()
    pendingRouteEditBot.emit('physicsTick')
    assert.equal(pendingRoutePathfinderTicks, 1, 'pathfinder resumes after the owned route edit settles')

    const routeDigGateBot = makeBot()
    let routeDigGateTicks = 0
    withNavigationScaffoldTickGate(routeDigGateBot, () => routeDigGateBot.on('physicsTick', () => routeDigGateTicks++))
    let settleRouteDig
    routeDigGateBot.dig = () => new Promise(resolve => { settleRouteDig = resolve })
    const routeDigPolicy = runWithNavigationPolicy(routeDigGateBot,
      { allowDig: true, scaffold: 'forbid', scaffoldBlocks: ['dirt'] },
      () => trackNavigationSegment(routeDigGateBot, () => routeDigGateBot.dig(routeDigGateBot.blockAt(new Vec3(2, 64, 0)))))
    await delay(1)
    routeDigGateBot.emit('physicsTick')
    assert.equal(routeDigGateTicks, 0, 'an owned route dig suppresses competing pathfinder replans')
    settleRouteDig()
    await routeDigPolicy
    routeDigGateBot.emit('physicsTick')
    assert.equal(routeDigGateTicks, 1, 'pathfinder route planning resumes after route dig settlement')

    const workDigGateBot = makeBot()
    let workDigGateTicks = 0
    withNavigationScaffoldTickGate(workDigGateBot, () => workDigGateBot.on('physicsTick', () => workDigGateTicks++))
    let settleWorkDig
    const workTargetBlock = workDigGateBot.blockAt(new Vec3(2, 63, 0))
    workDigGateBot.dig = () => new Promise(resolve => { settleWorkDig = resolve })
    const workDigPolicy = runWithNavigationPolicy(workDigGateBot,
      { allowDig: false, scaffold: 'forbid', scaffoldBlocks: ['dirt'] },
      () => trackNavigationSegment(workDigGateBot, () => workDigGateBot.dig(workTargetBlock), { workTarget: workTargetBlock.position }))
    await delay(1)
    workDigGateBot.emit('physicsTick')
    assert.equal(workDigGateTicks, 1, 'a selected work-target dig keeps its separate non-route permission and does not gate navigation')
    settleWorkDig()
    await workDigPolicy

    const cancelledLatePlacement = makeBot({ gap: [2, 3, 4], corridor: true })
    cancelledLatePlacement.testState.placementMode = 'late-confirm'
    const cancelledLatePromise = skills.reachPositionWithScaffoldCleanup(cancelledLatePlacement, {
      position: { x: 6.5, y: 64, z: 0.5 }, scaffoldBlocks: ['dirt'],
    })
    await delay(20)
    cancelledLatePlacement.interrupt_code = true
    const cancelledLate = await cancelledLatePromise
    assert.equal(cancelledLate.status, 'cancelled', JSON.stringify(cancelledLate))
    assert.ok(cancelledLate.edits.some(edit => edit.kind === 'scaffold_placed'), JSON.stringify(cancelledLate))
    assert.ok(cancelledLate.cleanupRequired.length > 0, JSON.stringify(cancelledLate))
    const editCountAfterCancellation = cancelledLatePlacement.testState.edits.length
    await delay(100)
    assert.equal(cancelledLatePlacement.testState.edits.length, editCountAfterCancellation, 'no cleanup or new route edit starts after cancellation')

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
    assert.equal(unsafeWater.testState.paths.flatMap(path => path.path ?? []).some(node => node.x === 2 && node.y === 64 && node.z === 0), false,
      `safeWater:false does not enter the water cell: ${JSON.stringify(waterBlocked)}`)
    const shallowWater = makeBot({ corridor: true, hazards: [{ x: 2, y: 64, z: 0, name: 'water' }] })
    const waterCrossed = await reachPosition(shallowWater, { position: { x: 6.5, y: 64, z: 0.5 }, safeWater: true })
    assert.equal(waterCrossed.status, 'reached', JSON.stringify(waterCrossed))
    const deepWater = makeBot({ corridor: true, hazards: [
      { x: 2, y: 64, z: 0, name: 'water' }, { x: 2, y: 63, z: 0, name: 'water' },
    ] })
    const deepWaterBlocked = await reachPosition(deepWater, { position: { x: 6.5, y: 64, z: 0.5 }, safeWater: true })
    assert.notEqual(deepWaterBlocked.status, 'reached', JSON.stringify(deepWaterBlocked))

    // Disposable reproduction of the recorded start: two water layers around
    // the feet, air above, solid bottom and a gravel shore one block east.
    // The fixture teleports on path nodes, so it distinguishes A* policy only;
    // it does not claim that water physics or climbing onto shore works.
    const waterStart = makeBot({ floorY: 61, startY: 63, corridor: true, solidBlocks: [
      { x: 3, y: 62, z: 0, name: 'stone' },
    ], hazards: [
      { x: 0, y: 63, z: 0, name: 'water' }, { x: 0, y: 62, z: 0, name: 'water' },
      { x: 1, y: 63, z: 0, name: 'water' }, { x: 1, y: 62, z: 0, name: 'water' },
      { x: 2, y: 62, z: 0, name: 'gravel' },
    ] })
    const waterStartResult = await reachPosition(waterStart, { position: { x: 3.5, y: 63, z: 0.5 }, tolerance: 0.75, allowScaffold: false })
    assert.equal(waterStartResult.status, 'reached', JSON.stringify({ result: waterStartResult, output: waterStart.output }))
    assert.equal(waterStart.testState.edits.length, 0, 'shallow-water departure reaches land without edits')
    assert.match(waterStart.output, /"ordinarySearchStatus":"noPath"/, 'the original policy reproduces a noPath at the water start')
    assert.match(waterStart.output, /"policy":"shallow-water-exit"/, 'the bounded departure policy finds a supported shoreline')
    assert.match(waterStart.output, /"reason":"safe_surface_reached"/, 'departure permission ends as soon as the shoreline is reached')
    const ordinaryRouteLogs = waterStart.output.split('\n').filter(line => line.startsWith('[reachPosition-route] '))
      .map(line => JSON.parse(line.slice('[reachPosition-route] '.length)))
      .filter(entry => entry.segment > 0)
    assert.ok(ordinaryRouteLogs.some(entry => entry.path?.some(node => node.x >= 3)), 'ordinary navigation resumes toward the requested destination')
    assert.equal(ordinaryRouteLogs.some(entry => entry.path?.some(node => node.x <= 1 && node.y === 63)), false,
      'ordinary routing does not re-enter the departed water')

    const stagingWalls = [
      { x: -1, y: 64, z: 0 }, { x: 0, y: 64, z: -1 }, { x: 0, y: 64, z: 1 },
      { x: 1, y: 64, z: -1 }, { x: 1, y: 64, z: 1 },
    ]
    const oneBlockWaterExit = makeBot({ floorY: 62, startY: 64, wall: stagingWalls, hazards: [
      { x: 0, y: 64, z: 0, name: 'water' }, { x: 0, y: 63, z: 0, name: 'water' },
      { x: 1, y: 64, z: 0, name: 'water' }, { x: 1, y: 63, z: 0, name: 'water' },
    ] })
    oneBlockWaterExit.testState.placementDelay = 50
    const oneBlockResult = await reachPosition(oneBlockWaterExit, {
      position: { x: 4.5, y: 63, z: 0.5 }, tolerance: 0.75, allowDig: false, allowScaffold: true,
      scaffoldBlocks: ['dirt'],
    })
    assert.equal(oneBlockResult.status, 'reached', JSON.stringify({ result: oneBlockResult, output: oneBlockWaterExit.output, paths: oneBlockWaterExit.testState.paths }))
    assert.equal(oneBlockResult.edits.filter(edit => edit.kind === 'scaffold_placed').length, 1,
      'water departure uses one confirmed staging block')
    assert.equal(oneBlockWaterExit.testState.placementAttempts, 1, 'the staging position is sent once')
    assert.equal(oneBlockWaterExit.testState.pathAdvancedWhilePlacementPending, false, 'movement waits for staging confirmation')
    assert.ok(oneBlockResult.edits.some(edit => edit.kind === 'scaffold_placed' && edit.position.x === 2 && edit.position.y === 63), JSON.stringify({ oneBlockResult, output: oneBlockWaterExit.output, paths: oneBlockWaterExit.testState.paths }))
    assert.ok(oneBlockResult.edits.some(edit => edit.kind === 'scaffold_removed' && edit.position.x === 2 && edit.position.y === 63), JSON.stringify(oneBlockResult))
    assert.equal(oneBlockWaterExit.testState.edits.filter(edit => edit.kind === 'server_place').length, 1)
    assert.equal(oneBlockWaterExit.testState.edits.filter(edit => edit.kind === 'server_dig').length, 1)
    assert.match(oneBlockWaterExit.output, /"staging":"server-confirmed".*"replanning":true/)
    assert.match(oneBlockWaterExit.output, /"reason":"safe_surface_reached"/)

    const noMaterialWaterExit = makeBot({ floorY: 62, startY: 64, wall: stagingWalls, scaffoldInventory: {}, hazards: [
      { x: 0, y: 64, z: 0, name: 'water' }, { x: 0, y: 63, z: 0, name: 'water' },
      { x: 1, y: 64, z: 0, name: 'water' }, { x: 1, y: 63, z: 0, name: 'water' },
    ] })
    const noMaterialExitResult = await reachPosition(noMaterialWaterExit, {
      position: { x: 4.5, y: 63, z: 0.5 }, tolerance: 0.75, allowDig: false, allowScaffold: true,
      scaffoldBlocks: ['dirt'],
    })
    assert.notEqual(noMaterialExitResult.status, 'reached', JSON.stringify(noMaterialExitResult))
    assert.equal(noMaterialWaterExit.testState.placementAttempts, 0, 'missing material prevents a staging placement')
    assert.equal(noMaterialWaterExit.testState.edits.length, 0)

    const rejectedWaterStaging = makeBot({ floorY: 62, startY: 64, wall: stagingWalls, hazards: [
      { x: 0, y: 64, z: 0, name: 'water' }, { x: 0, y: 63, z: 0, name: 'water' },
      { x: 1, y: 64, z: 0, name: 'water' }, { x: 1, y: 63, z: 0, name: 'water' },
    ] })
    rejectedWaterStaging.testState.placementMode = 'reject'
    const rejectedStagingResult = await reachPosition(rejectedWaterStaging, {
      position: { x: 4.5, y: 63, z: 0.5 }, tolerance: 0.75, allowDig: false, allowScaffold: true,
      scaffoldBlocks: ['dirt'],
    })
    assert.notEqual(rejectedStagingResult.status, 'reached', JSON.stringify(rejectedStagingResult))
    assert.equal(rejectedWaterStaging.testState.placementAttempts, 1, 'an unconfirmed staging placement is never retried')
    assert.equal(rejectedWaterStaging.testState.edits.filter(edit => edit.kind === 'server_place').length, 0)

    const unsafeWaterStaging = makeBot({ floorY: 62, startY: 64, wall: stagingWalls,
      solidBlocks: [{ x: 2, y: 62, z: 0, name: 'magma_block' }], hazards: [
        { x: 0, y: 64, z: 0, name: 'water' }, { x: 0, y: 63, z: 0, name: 'water' },
        { x: 1, y: 64, z: 0, name: 'water' }, { x: 1, y: 63, z: 0, name: 'water' },
      ] })
    const unsafeWaterStagingResult = await reachPosition(unsafeWaterStaging, {
      position: { x: 4.5, y: 63, z: 0.5 }, tolerance: 0.75, allowDig: false, allowScaffold: true,
      scaffoldBlocks: ['dirt'],
    })
    assert.notEqual(unsafeWaterStagingResult.status, 'reached', JSON.stringify(unsafeWaterStagingResult))
    assert.equal(unsafeWaterStaging.testState.placementAttempts, 0, 'hazardous anchor faces are never used')
    assert.equal(unsafeWaterStaging.testState.edits.length, 0)

    const cancelledWaterStaging = makeBot({ floorY: 62, startY: 64, wall: stagingWalls, navigationDelay: 200,
      hazards: [
        { x: 0, y: 64, z: 0, name: 'water' }, { x: 0, y: 63, z: 0, name: 'water' },
        { x: 1, y: 64, z: 0, name: 'water' }, { x: 1, y: 63, z: 0, name: 'water' },
      ] })
    const pendingStagedExit = reachPosition(cancelledWaterStaging, {
      position: { x: 4.5, y: 63, z: 0.5 }, tolerance: 0.75, allowDig: false, allowScaffold: true,
      scaffoldBlocks: ['dirt'],
    })
    const stagedPlacementDeadline = Date.now() + 3000
    while (!cancelledWaterStaging.testState.edits.some(edit => edit.kind === 'server_place') && Date.now() < stagedPlacementDeadline) await delay(10)
    assert.equal(cancelledWaterStaging.testState.edits.filter(edit => edit.kind === 'server_place').length, 1,
      'staging placement is server-confirmed before exercising cancellation')
    cancelledWaterStaging.interrupt_code = true
    const cancelledStagedResult = await pendingStagedExit
    assert.equal(cancelledStagedResult.status, 'cancelled', JSON.stringify(cancelledStagedResult))
    assert.equal(cancelledWaterStaging.testState.edits.filter(edit => edit.kind === 'server_place').length, 1,
      'cancellation preserves exactly the confirmed owned placement')
    assert.equal(cancelledStagedResult.edits.filter(edit => edit.kind === 'scaffold_removed').length, 0,
      'cancellation does not start an unsafe cleanup route')
    assert.ok(cancelledStagedResult.cleanupRequired.some(edit => edit.x === 2 && edit.y === 63),
      JSON.stringify(cancelledStagedResult))
    assert.equal(cancelledWaterStaging.pathfinder.movements.original, true, 'cancellation restores movement policy')

    const cancelledWaterExit = makeBot({ floorY: 61, startY: 63, corridor: true, navigationDelay: 100,
      hazards: [
        { x: 0, y: 63, z: 0, name: 'water' }, { x: 0, y: 62, z: 0, name: 'water' },
        { x: 1, y: 63, z: 0, name: 'water' }, { x: 1, y: 62, z: 0, name: 'water' },
        { x: 2, y: 62, z: 0, name: 'gravel' },
      ] })
    const originalWaterMovements = cancelledWaterExit.pathfinder.movements
    const pendingWaterExit = reachPosition(cancelledWaterExit, {
      position: { x: 3.5, y: 63, z: 0.5 }, tolerance: 0.75, allowScaffold: false,
    })
    await delay(20)
    cancelledWaterExit.interrupt_code = true
    const cancelledWaterResult = await pendingWaterExit
    assert.equal(cancelledWaterResult.status, 'cancelled', JSON.stringify(cancelledWaterResult))
    assert.equal(cancelledWaterExit.testState.edits.length, 0, 'cancellation during water departure does not edit blocks')
    assert.equal(cancelledWaterExit.pathfinder.movements, originalWaterMovements, 'cancellation restores ordinary movement policy')

    for (const [name, options, reason] of [
      ['unknown bottom', { floorY: 62, startY: 64, unknown: [{ x: 0, y: 62, z: 0 }], hazards: [
        { x: 0, y: 64, z: 0, name: 'water' }, { x: 0, y: 63, z: 0, name: 'water' },
        { x: 1, y: 63, z: 0, name: 'gravel' },
      ] }, 'water_bottom_unknown_or_too_deep'],
      ['deep water', { floorY: 60, startY: 65, hazards: [
        { x: 0, y: 65, z: 0, name: 'water' }, { x: 0, y: 64, z: 0, name: 'water' },
        { x: 0, y: 63, z: 0, name: 'water' }, { x: 0, y: 62, z: 0, name: 'water' },
        { x: 0, y: 61, z: 0, name: 'water' }, { x: 1, y: 64, z: 0, name: 'gravel' },
      ] }, 'water_bottom_unknown_or_too_deep'],
      ['submerged head', { floorY: 62, startY: 64, hazards: [
        { x: 0, y: 64, z: 0, name: 'water' }, { x: 0, y: 63, z: 0, name: 'water' },
        { x: 0, y: 65, z: 0, name: 'water' }, { x: 1, y: 63, z: 0, name: 'gravel' },
      ] }, 'head_submerged_or_unknown'],
    ]) {
      const blockedWaterStart = makeBot(options)
      const result = await reachPosition(blockedWaterStart, {
        position: { x: 4.5, y: options.startY, z: 0.5 }, tolerance: 0.75, allowScaffold: false,
      })
      assert.notEqual(result.status, 'reached', `${name}: ${JSON.stringify(result)}`)
      assert.equal(blockedWaterStart.testState.edits.length, 0, `${name}: no edits are attempted`)
      assert.ok(blockedWaterStart.output.includes(reason), `${name}: ${blockedWaterStart.output}`)
    }

    const contactHazardStart = makeBot({ floorY: 63, startY: 64, corridor: true,
      hazards: [{ x: 0, y: 63, z: 0, name: 'magma_block' }] })
    const contactHazardResult = await reachPosition(contactHazardStart, {
      position: { x: 3.5, y: 64, z: 0.5 }, tolerance: 0.75, allowScaffold: false,
    })
    assert.equal(contactHazardResult.status, 'reached', JSON.stringify({ result: contactHazardResult, output: contactHazardStart.output }))
    assert.equal(contactHazardStart.testState.edits.length, 0, 'direct contact-hazard departure requires no edits')
    assert.match(contactHazardStart.output, /"startHazard":"magma_block"/)
    assert.equal(contactHazardStart.testState.paths[0]?.path[0]?.x, 1, 'the first planned transition steps directly onto the adjacent safe surface')
    assert.equal(contactHazardStart.testState.paths.flatMap(path => path.path).some(node => node.x === 0 && node.y === 64), false,
      'the executed route does not remain on the starting hazard')

    const lowHealthHazardStart = makeBot({ floorY: 63, startY: 64, corridor: true,
      hazards: [{ x: 0, y: 63, z: 0, name: 'magma_block' }] })
    lowHealthHazardStart.health = 4
    const lowHealthHazardResult = await reachPosition(lowHealthHazardStart, {
      position: { x: 3.5, y: 64, z: 0.5 }, tolerance: 0.75, allowScaffold: false,
    })
    assert.equal(lowHealthHazardResult.status, 'blocked', JSON.stringify(lowHealthHazardResult))
    assert.equal(lowHealthHazardStart.testState.edits.length, 0)
    assert.match(lowHealthHazardStart.output, /insufficient_health/)

    const lavaStart = makeBot({ floorY: 63, startY: 64, hazards: [{ x: 0, y: 64, z: 0, name: 'lava' }] })
    const lavaStartResult = await reachPosition(lavaStart, { position: { x: 3.5, y: 64, z: 0.5 } })
    assert.equal(lavaStartResult.status, 'blocked', JSON.stringify(lavaStartResult))
    assert.equal(lavaStart.testState.edits.length, 0)
    assert.match(lavaStart.output, /unsupported_start_hazard_lava/)

    const lava = makeBot({ corridor: true, hazards: [{ x: 2, y: 64, z: 0, name: 'lava' }] })
    const lavaBlocked = await reachPosition(lava, { position: { x: 6.5, y: 64, z: 0.5 }, allowDig: true, safeWater: true })
    assert.notEqual(lavaBlocked.status, 'reached', JSON.stringify(lavaBlocked))
    assert.equal(lava.testState.edits.some(edit => edit.block === 'lava'), false, 'hazard blocks are never excavated')

    console.log('reachPosition real pathfinder movement/A* fixtures passed (open, mining, scaffolded routes, hazards, server confirmation, cancellation, chunk progression, native scope and restoration)')
  } finally {
    delete globalThis.mcRegistry
    await rm(root, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
