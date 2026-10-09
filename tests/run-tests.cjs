'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const repo = path.resolve(__dirname, '..')
const node = process.execPath

async function write(root, relative, content) {
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
}

async function setupFarmFixture(root) {
  await write(root, 'package.json', '{"type":"module"}')
  await write(root, 'settings.js', 'export default { block_place_delay: 0 };')
  await write(root, 'src/agent/library/skills.js', await readFile(path.join(repo, 'src/agent/library/skills.js')))
  await write(root, 'src/agent/library/block_interaction.js', await readFile(path.join(repo, 'src/agent/library/block_interaction.js')))
  await write(root, 'src/agent/library/block_placement.js', await readFile(path.join(repo, 'src/agent/library/block_placement.js')))
  await write(root, 'src/agent/library/operation_context.js', await readFile(path.join(repo, 'src/agent/library/operation_context.js')))
  await write(root, 'src/agent/library/mining_sync.js', await readFile(path.join(repo, 'src/agent/library/mining_sync.js')))
  await write(root, 'src/agent/library/crafting_sync.js', await readFile(path.join(repo, 'src/agent/library/crafting_sync.js')))
  await write(root, 'src/agent/library/index.js', await readFile(path.join(repo, 'src/agent/library/index.js')))
  await write(root, 'src/agent/library/skill_library.js', await readFile(path.join(repo, 'src/agent/library/skill_library.js')))
  await write(root, 'src/agent/library/sdk_capabilities.js', await readFile(path.join(repo, 'src/agent/library/sdk_capabilities.js')))
  await write(root, 'src/agent/settings.js', 'export default {};')
  await write(root, 'src/agent/modes.js', await readFile(path.join(repo, 'src/agent/modes.js')))
  await write(root, 'src/agent/conversation.js', 'export default {};')
  await write(root, 'src/utils/mcdata.js', 'export function mustCollectManually(name) { return name === "wheat"; }')
  await write(root, 'src/utils/math.js', 'export function cosineSimilarity() { return 0; }')
  await write(root, 'src/utils/text.js', 'export function wordOverlapScore() { return 0; }')
  await write(root, 'src/agent/library/world.js', `
export function getNearestBlocks(bot, types, distance) {
  const scenario = globalThis.farmScenario;
  const soil = scenario.plot || [...scenario.farmland, ...scenario.crops.map(crop => ({ name: 'farmland', position: crop.position.offset(0, -1, 0) }))];
  return Array.isArray(types) ? scenario.crops : types === 'farmland' ? soil.filter(block => Math.hypot(block.position.x, block.position.y, block.position.z) <= distance) : [];
}
export function getNearestBlocksWhere(bot, predicate) {
  return (globalThis.farmScenario.collectBlocks || []).filter(predicate);
}
export function getNearestBlock(bot, type, distance) {
  const scenario = globalThis.farmScenario;
  if (type === 'chest') return scenario.nearestChest;
  const soil = getNearestBlocks(bot, type, distance);
  return soil.sort((a, b) => Math.hypot(a.position.x, a.position.y, a.position.z) - Math.hypot(b.position.x, b.position.y, b.position.z))[0] || null;
}
export function getInventoryCounts() { return {}; }
export function getNearestFreeSpace() { return { x: 0, y: 0, z: 0 }; }
export function getPosition(bot) { return bot.entity.position; }
export function shouldPlaceTorch() { return false; }
`)
  await write(root, 'node_modules/vec3/package.json', '{"type":"module","exports":"./index.js"}')
  await write(root, 'node_modules/vec3/index.js', `
export default function Vec3(x, y, z) {
  return { x, y, z, plus(v) { return Vec3(x + v.x, y + v.y, z + v.z); }, offset(dx, dy, dz) { return Vec3(x + dx, y + dy, z + dz); }, toString() { return '(' + x + ', ' + y + ', ' + z + ')'; } };
}
`)
  await write(root, 'node_modules/mineflayer-pathfinder/package.json', '{"type":"module","exports":"./index.js"}')
  await write(root, 'node_modules/mineflayer-pathfinder/index.js', 'export default { goals: { GoalNear: class {} }, Movements: class { safeToBreak() { return true } } };')
}

async function setupNavigationFixture(root) {
  await write(root, 'package.json', '{"type":"module"}')
  await write(root, 'settings.js', 'export default { block_place_delay: 0 };')
  await write(root, 'src/agent/library/skills.js', await readFile(path.join(repo, 'src/agent/library/skills.js')))
  await write(root, 'src/agent/library/block_interaction.js', await readFile(path.join(repo, 'src/agent/library/block_interaction.js')))
  await write(root, 'src/agent/library/block_placement.js', await readFile(path.join(repo, 'src/agent/library/block_placement.js')))
  await write(root, 'src/agent/library/operation_context.js', await readFile(path.join(repo, 'src/agent/library/operation_context.js')))
  await write(root, 'src/agent/library/operation_context.js', await readFile(path.join(repo, 'src/agent/library/operation_context.js')))
  await write(root, 'src/agent/library/crafting_sync.js', await readFile(path.join(repo, 'src/agent/library/crafting_sync.js')))
  await write(root, 'src/utils/mcdata.js', 'export function mustCollectManually(name) { return name === "wheat"; } export function getBlockId() { return 1; } export function getItemId(name) { return ({ oak_log: 1, oak_planks: 36, crafting_table: 300, wooden_pickaxe: 820, stone_pickaxe: 825, stick: 848 })[name] ?? null; } export function getItemCraftingRecipes(name) { return name === "oak_planks" || name === "stone_pickaxe" ? [[{}]] : []; } export function ingredientsFromPrismarineRecipe(recipe) { return recipe.requiredItems || {}; } export function calculateLimitingResource() { return { num: 1, limitingResource: "cobblestone" }; }')
  await write(root, 'src/agent/library/world.js', `
export function getNearestBlock(bot) { return bot.navigation.block || null; }
export function getNearestBlocksWhere(bot, predicate) { return (bot.navigation.blocks || []).filter(predicate); }
export function getNearestEntityWhere(bot, predicate) { return (bot.navigation.entities || []).find(predicate) || null; }
export function isEntityType(name) { return name === 'cow'; }
export function shouldPlaceTorch() { return false; }
export function getNearbyEntities(bot) { return bot.navigation.entities || []; }
export function getPosition(bot) { return bot.entity.position; }
export function getInventoryCounts(bot) { return bot.navigation.inventory || {}; }
export function getNearestFreeSpace(bot) { return bot.navigation.freeSpace || { x: 0, y: 0, z: 0 }; }
`)
  await write(root, 'node_modules/vec3/package.json', '{"type":"module","exports":"./index.js"}')
  await write(root, 'node_modules/vec3/index.js', 'export default function Vec3(x, y, z) { return { x, y, z, plus(v) { return Vec3(x + v.x, y + v.y, z + v.z); }, offset(dx, dy, dz) { return Vec3(x + dx, y + dy, z + dz); }, distanceTo(v) { return Math.hypot(x - v.x, y - v.y, z - v.z); }, equals(v) { return x === v.x && y === v.y && z === v.z; }, toString() { return `(${x}, ${y}, ${z})`; } }; }')
  await write(root, 'node_modules/mineflayer-pathfinder/package.json', '{"type":"module","exports":"./index.js"}')
  await write(root, 'node_modules/mineflayer-pathfinder/index.js', `
class GoalNear {
  constructor(x, y, z, range) { this.x = Math.floor(x); this.y = Math.floor(y); this.z = Math.floor(z); this.rangeSq = range * range; }
  heuristic(node) { const dx = this.x - node.x; const dy = this.y - node.y; const dz = this.z - node.z; return Math.hypot(dx, dz) + Math.abs(dy); }
}
class GoalFollow {
  constructor(entity, range) { this.entity = entity; this.x = Math.floor(entity.position.x); this.y = Math.floor(entity.position.y); this.z = Math.floor(entity.position.z); this.rangeSq = range * range; }
  heuristic(node) { const dx = this.x - node.x; const dy = this.y - node.y; const dz = this.z - node.z; return Math.hypot(dx, dz) + Math.abs(dy); }
}
class GoalInvert {
  constructor(goal) { this.goal = goal; }
  heuristic(node) { return -this.goal.heuristic(node); }
}
export default { goals: { GoalNear, GoalFollow, GoalInvert }, Movements: class { constructor() { this.blocksCantBreak = new Set(); } } };
`)
}

async function testNavigation(root) {
  await setupNavigationFixture(root)
  const skills = await import(pathToFileURL(path.join(root, 'src/agent/library/skills.js')))
  const { default: runtimeSettings } = await import(pathToFileURL(path.join(root, 'settings.js')))
  const { createOperationContext, operationResult, runOwnedOperation } = await import(pathToFileURL(path.join(root, 'src/agent/library/operation_context.js')))
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  Object.assign(runtimeSettings, { navigation_stall_timeout_ms: 20, navigation_check_interval_ms: 5 })
  const targetBlock = { name: 'chest', position: { x: 4, y: 0, z: 0, toString() { return '4,0,0' }, offset() { return this } } }
  const targetEntity = { name: 'cow', position: { x: 4, y: 0, z: 0, floored() { return { x: Math.floor(this.x), y: Math.floor(this.y), z: Math.floor(this.z) } } } }
  const makeBot = ({ result = true, reject = false, rejectAfter = 0, distance = 0 } = {}) => {
    const listeners = new Map()
    const bot = {
      output: '', username: 'bot', game: { gameMode: 'survival' }, players: {}, navigation: { block: targetBlock, blocks: [], entities: [targetEntity] },
      entity: { position: { x: 0, y: 0, z: 0, clone() { return this }, floored() { return { x: Math.floor(this.x), y: Math.floor(this.y), z: Math.floor(this.z) } }, offset() { return this }, distanceTo: () => result === false ? 10 : distance }, height: 1 },
      modes: { isOn: () => false, pause() {}, unpause() {} }, inventory: { slots: [], items: () => [], findInventoryItem: () => null },
      on(event, listener) { const set = listeners.get(event) || new Set(); set.add(listener); listeners.set(event, set); return this },
      removeListener(event, listener) { listeners.get(event)?.delete(listener); return this },
      emit(event, ...args) { for (const listener of listeners.get(event) || []) listener(...args); return true },
      pathfinder: { async getPathTo() { return { status: 'noPath' } }, setMovements() {}, async goto() {} },
      findBlocks: () => [{ x: 4, y: 0, z: 0 }], blockAt: () => targetBlock,
      async openContainer() { bot.navigation.opened = true; return { containerItems: () => [], async close() {}, async deposit() {}, async withdraw() {} } },
      async lookAt() {}, async activateBlock() { bot.navigation.activated = true }, async useOn() { bot.navigation.used = true },
      async equip() {}, async unequip() {}, blockAtCursor: () => null, chat() {}, tossCalls: 0,
      async toss() { this.tossCalls++ }
    }
    let gotoCalls = 0
    bot.pathfinder.goto = async () => {
      gotoCalls++
      if (reject && (!rejectAfter || gotoCalls >= rejectAfter)) throw new Error('navigation rejected')
    }
    return bot
  }

  let bot = makeBot({ result: false })
  assert.equal(await skills.goToNearestBlock(bot, 'chest'), false, 'nearest block propagates failed navigation')
  assert.equal(await skills.goToNearestEntity(bot, 'cow'), false, 'nearest entity propagates failed navigation')
  bot.navigation.block = null
  assert.equal(await skills.goToNearestBlock(bot, 'chest'), false, 'missing target returns false')

  bot = makeBot()
  assert.equal(await skills.goToPlayer(bot, 'missing'), false, 'unknown player returns false')
  bot.players.player = { entity: targetEntity }
  assert.equal(await skills.goToPlayer(bot, 'player'), true, 'successful player navigation returns true')
  bot = makeBot({ reject: true })
  bot.players.player = { entity: targetEntity }
  assert.equal(await skills.goToPlayer(bot, 'player'), false, 'pathfinding rejection maps to false')

  bot = makeBot({ result: false })
  bot.inventory.findInventoryItem = () => ({ count: 1 })
  assert.equal(await skills.putInChest(bot, 'log'), false)
  assert.equal(bot.navigation.opened, undefined, 'chest is not opened after failed navigation')
  assert.equal(await skills.takeFromChest(bot, 'log'), false)
  assert.equal(await skills.viewChest(bot), false)
  assert.equal(await skills.useToolOn(bot, 'hand', 'cow'), false)
  assert.equal(bot.navigation.used, undefined, 'entity use does not continue after failed navigation')
  assert.equal(await skills.useToolOnBlock(bot, 'hand', targetBlock), false)
  assert.equal(bot.navigation.activated, undefined, 'block use does not continue after failed navigation')

  bot = makeBot({ reject: true })
  bot.players.player = { entity: targetEntity }
  bot.inventory.findInventoryItem = () => ({ type: 1, count: 1 })
  assert.equal(await skills.giveToPlayer(bot, 'log', 'player'), false)
  assert.equal(bot.tossCalls, 0, 'item is not tossed after player navigation rejection')
  bot = makeBot({ reject: true, rejectAfter: 2, distance: 1 })
  bot.players.player = { entity: targetEntity }
  bot.inventory.findInventoryItem = () => ({ type: 1, count: 1 })
  assert.equal(await skills.giveToPlayer(bot, 'log', 'player'), false)
  assert.equal(bot.tossCalls, 0, 'item is not tossed after moving away is rejected')
  bot = makeBot()
  bot.findBlocks = () => []
  assert.equal(await skills.goToBed(bot), false)
  bot = makeBot({ result: false })
  bot.slept = false
  bot.sleep = async () => { bot.slept = true }
  assert.equal(await skills.goToBed(bot), false)
  assert.equal(bot.slept, false, 'bed is not used after failed navigation')

  bot = makeBot({ reject: true })
  assert.equal(await skills.goToNearestBlock(bot, 'chest'), false, 'rejected pathfinding resolves to navigation failure')
  bot = makeBot({ distance: 10 })
  assert.equal(await skills.goToPosition(bot, 10, 0, 0), false, 'unreached position returns false')

  bot = makeBot()
  assert.equal(await skills.goToNearestBlock(bot, 'chest'), true)
  assert.equal(await skills.goToNearestEntity(bot, 'cow'), true)
  bot = makeBot()
  let stopCalls = 0
  let rejectPending
  bot.pathfinder.goto = () => {
    setImmediate(() => bot.emit('path_update', { status: 'success', path: [{ x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }] }))
    return new Promise((resolve, reject) => { rejectPending = reject })
  }
  bot.pathfinder.stop = () => { stopCalls++; rejectPending(new Error('stopped by progress monitor')) }
  const operation = createOperationContext({ id: 'nav-stall', controller: new AbortController() }, { bot }, { intentEpoch: 1 }, 'nav-task')
  await assert.rejects(runOwnedOperation(operation, () => skills.goToGoal(bot, { heuristic: () => 10 })), /made no goal or new route-segment progress.*20ms/)
  assert.equal(stopCalls, 1, 'navigation progress monitor stops a genuinely stalled path once')

  const stalledCall = operationResult(operation).skillResults[0]
  assert.equal(stalledCall.waits[0].callId, stalledCall.id, 'wait evidence retains its SDK call ID')
  assert.equal(stalledCall.waits[0].phase, 'navigation')
  assert.equal(stalledCall.waits[0].reason, 'goal-or-new-route-segment')
  assert.equal(stalledCall.waits[0].outcome, 'stalled')

  bot = makeBot()
  stopCalls = 0
  let rejectDetour
  bot.pathfinder.goto = () => {
    setImmediate(() => bot.emit('path_update', { status: 'success', path: [0, 1, 2, 3].map(x => ({ x, y: 0, z: 0 })) }))
    return new Promise((resolve, reject) => { rejectDetour = reject })
  }
  bot.pathfinder.stop = () => { stopCalls++; rejectDetour(new Error('detour eventually timed out')) }
  const detour = skills.goToGoal(bot, { heuristic: () => 10 })
  const detourRejected = assert.rejects(detour, /made no goal or new route-segment progress/)
  await delay(12)
  bot.entity.position.x = 1
  await delay(12)
  bot.entity.position.x = 2
  await delay(12)
  bot.entity.position.x = 3
  await delay(12)
  assert.equal(stopCalls, 0, 'reaching new finite route segments keeps a necessary detour alive')
  await detourRejected
  assert.equal(stopCalls, 1)

  bot = makeBot()
  stopCalls = 0
  let rejectOscillation
  bot.pathfinder.goto = () => {
    setImmediate(() => bot.emit('path_update', { status: 'success', path: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }] }))
    return new Promise((resolve, reject) => { rejectOscillation = reject })
  }
  bot.pathfinder.stop = () => { stopCalls++; rejectOscillation(new Error('oscillation timed out')) }
  const oscillation = skills.goToGoal(bot, { heuristic: () => 10 })
  const oscillationRejected = assert.rejects(oscillation, /made no goal or new route-segment progress/)
  await delay(10)
  bot.entity.position.x = 1
  await delay(10)
  for (let index = 0; index < 8 && stopCalls === 0; index++) {
    bot.entity.position.x = index % 2 === 0 ? 0 : 1
    bot.emit('path_reset', 'replanned')
    bot.emit('path_update', { status: 'success', path: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }] })
    await delay(8)
  }
  await oscillationRejected
  assert.equal(stopCalls, 1, 'returning over the same route segment cannot renew the stall budget')

  bot = makeBot()
  bot.pathfinder.goto = async () => { bot.emit('path_update', { status: 'success', path: [] }) }
  const repeatedCalls = createOperationContext({ id: 'nav-waits', controller: new AbortController() }, { bot }, { intentEpoch: 1 }, 'nav-task')
  await runOwnedOperation(repeatedCalls, async () => {
    await skills.goToGoal(bot, { heuristic: () => 10 })
    await skills.goToGoal(bot, { heuristic: () => 10 })
  })
  const waitEvents = operationResult(repeatedCalls).skillResults.map(call => call.waits[0])
  assert.equal(new Set(waitEvents.map(wait => wait.waitId)).size, 2, 'wait IDs are unique across calls in one operation')
  assert.ok(waitEvents.every(wait => wait.callId && wait.actionId === 'nav-waits'))
  console.log('navigation contract tests passed')
}

function block(name, age, x = 0, y = name === 'farmland' ? 0 : 1, z = 0) {
  const position = (x, y, z) => ({ x, y, z, offset(dx, dy, dz) { return position(x + dx, y + dy, z + dz) } });
  return { name, position: position(x, y, z), diggable: true, getProperties: () => ({ age }) };
}

function makeBot(scenario) {
  const items = scenario.items.map(item => ({ ...item }))
  const listeners = new Map()
  const bot = {
    output: '',
    entity: { id: 42, position: { x: 0, y: 0, z: 0, distanceTo: () => 0 } },
    registry: { itemsByName: { wheat: { id: 100 }, wheat_seeds: { id: 101 }, carrot: { id: 102 }, potato: { id: 103 }, beetroot: { id: 104 }, beetroot_seeds: { id: 105 } } },
    modes: { isOn: mode => mode === 'cheat' && scenario.cheat !== false },
    inventory: { items: () => items, slots: items },
    armorManager: { equipAll() {} },
    on(event, listener) {
      const eventListeners = listeners.get(event) || new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
    },
    removeListener(event, listener) { listeners.get(event)?.delete(listener) },
    listenerCount(event) { return listeners.get(event)?.size || 0 },
    emit(event, ...args) { for (const listener of listeners.get(event) || []) listener(...args) },
    async equip(item) { this.heldItem = item },
    blockAt(position) {
      const matches = block => block.position.x === position.x && block.position.y === position.y && block.position.z === position.z;
      if (scenario.unloaded?.(position)) return null;
      if (scenario.plot && position.x === 0 && position.y === 0 && position.z === 1) return { name: 'water', position };
      const crop = scenario.crops.find(matches);
      if (crop?.diggable) return crop;
      if (scenario.plot) {
        const soil = scenario.plot.find(matches);
        if (soil) return soil;
        return scenario.planted?.get(`${position.x},${position.y},${position.z}`) || { name: 'air', position };
      }
      if (position.y === 1) return scenario.planted?.get(`${position.x},${position.y},${position.z}`) || { name: 'air', position }
      if (scenario.explicitChest && position.x === scenario.explicitChest.position.x && position.y === scenario.explicitChest.position.y && position.z === scenario.explicitChest.position.z) return scenario.explicitChest
      return { name: scenario.baseBlockName || 'farmland', position }
    },
    chat(message) {
      if (!message.startsWith('/setblock ')) return
      scenario.setblockCommands ??= []
      scenario.setblockCommands.push(message)
      const [, x, y, z, name] = message.split(' ')
      const position = { x: Number(x), y: Number(y), z: Number(z) }
      const emitUpdate = () => {
        const isTargetFarmland = position.x === 30 && position.y === 0 && position.z === 2 && name === 'farmland'
        const actualName = scenario.setblockMode === 'wrong' && isTargetFarmland ? 'dirt' : name.split('[')[0]
        if (scenario.plot && actualName === 'wheat') scenario.planted.set(`${position.x},${position.y},${position.z}`, { name: actualName, position });
        bot.emit('blockUpdate', { name: 'air', position }, { name: actualName, position })
      }
      if (scenario.setblockMode === 'delayed') setTimeout(emitUpdate, 15)
      else if (scenario.setblockMode !== 'absent' && !(scenario.setblockMode === 'cropAbsent' && position.x === 30 && position.y === 1 && position.z === 2 && name === 'wheat')) emitUpdate()
    },
    async activateBlock(block) {
      scenario.activations.push(block.position.x)
      if (this.heldItem?.name === 'wheat_seeds' && !scenario.noPlant) {
        this.heldItem.count--
        const position = block.position.offset(0, 1, 0)
        const oldBlock = { name: 'air', position }
        const newBlock = { name: 'wheat', position }
        scenario.planted?.set(`${position.x},${position.y},${position.z}`, newBlock)
        for (const listener of listeners.get('blockUpdate') || []) listener(oldBlock, newBlock)
      }
    },
    async dig(crop) {
      crop.diggable = false
      const produce = crop.name === 'wheat' ? [['wheat', 1], ['wheat_seeds', 1]] : [[crop.name.slice(0, -1), 1]]
      for (const [name, count] of produce) {
        const found = items.find(item => item.name === name)
        if (found) found.count += count
        else items.push({ name, type: name, count })
      }
      const emitHarvestSignals = () => {
        const dropName = scenario.harvestMode === 'wrong' ? 'carrot' : produce[0][0]
        const entity = {
          id: Math.random(),
          position: { ...crop.position, distanceTo(other) { return Math.hypot(this.x + 0.5 - other.x, this.y + 0.5 - other.y, this.z + 0.5 - other.z) } },
          getDroppedItem() { return { type: bot.registry.itemsByName[dropName]?.id } }
        }
        bot.emit('itemDrop', entity)
        bot.emit('playerCollect', bot.entity, entity)
        bot.emit('blockUpdate', crop, { name: 'air', type: 0, position: crop.position })
      }
      if (scenario.harvestMode === 'interrupt') bot.interrupt_code = true
      else if (scenario.harvestMode === 'delayed') setTimeout(emitHarvestSignals, 15)
      else if (scenario.harvestMode !== 'absent' && scenario.harvestMode !== 'wrong') emitHarvestSignals()
      else if (scenario.harvestMode === 'wrong') {
        const entity = { id: Math.random(), position: { ...crop.position, distanceTo(other) { return Math.hypot(this.x + 0.5 - other.x, this.y + 0.5 - other.y, this.z + 0.5 - other.z) } }, getDroppedItem() { return { type: bot.registry.itemsByName.carrot.id } } }
        bot.emit('itemDrop', entity)
        bot.emit('playerCollect', bot.entity, entity)
        bot.emit('blockUpdate', crop, { name: 'air', type: 0, position: crop.position })
      }
    },
    async openContainer(chest) {
      scenario.opened.push(chest)
      return {
        async deposit(type, metadata, count) { if (scenario.depositReject) throw new Error('injected deposit failure'); scenario.deposits.push({ type, count }); const item = items.find(candidate => candidate.type === type || candidate.name === type); if (item) item.count -= count },
        async close() { scenario.closed++ }
      }
    }
  }
  return bot
}

async function testFarm(root) {
  await setupFarmFixture(root)
  const { tendNearbyFarm, tillAndSow } = await import(pathToFileURL(path.join(root, 'src/agent/library/skills.js')))
  const { getSkillDocs } = await import(pathToFileURL(path.join(root, 'src/agent/library/index.js')))
  const { SkillLibrary } = await import(pathToFileURL(path.join(root, 'src/agent/library/skill_library.js')))

  const nearChest = { name: 'chest', position: { x: 8, y: 0, z: 0 } }
  const explicitChest = { name: 'trapped_chest', position: { x: 4, y: 0, z: 0 } }
  const scenario = {
    crops: [block('wheat', 7, 1), block('wheat', 3, 2)],
    farmland: [block('farmland', null, 3), block('farmland', null, 4)],
    items: [{ name: 'wheat_seeds', type: 'wheat_seeds', count: 1 }],
    nearestChest: nearChest,
    explicitChest,
    opened: [], deposits: [], closed: 0, activations: [], planted: new Map(), cheat: true
  }
  globalThis.farmScenario = scenario
  let bot = makeBot(scenario)
  let result = await tendNearbyFarm(bot, { scope: 'radius', radius: 16, seedReserve: 1, chestPosition: { x: 4.9, y: 0.5, z: 0.1 } })
  assert.deepEqual(result, { harvested: 1, planted: 1, stored: 2 })
  assert.deepEqual(scenario.opened, [explicitChest])
  assert.equal(scenario.closed, 1)
  assert.deepEqual(scenario.deposits, [{ type: 'wheat', count: 1 }, { type: 'wheat_seeds', count: 1 }])
  assert.equal(bot.inventory.items().find(item => item.name === 'wheat_seeds').count, 1)

  function plotScenario() {
    const plot = [0, 1, 2, 3, 4].map(x => block('farmland', null, x));
    plot.push(block('farmland', null, 0, 0, 2), block('farmland', null, 5, 0, 1), block('farmland', null, 2, 1, 1));
    return { plot, farmland: [], crops: [block('wheat', 7, 4), block('wheat', 7, 0, 1, 2), block('wheat', 7, 5, 1, 1), block('wheat', 7, 2, 2, 1)],
      items: [{ name: 'wheat_seeds', type: 'wheat_seeds', count: 8 }],
      opened: [], deposits: [], closed: 0, activations: [], planted: new Map(), cheat: true };
  }
  let connected = plotScenario();
  globalThis.farmScenario = connected;
  let connectedBot = makeBot(connected);
  result = await tendNearbyFarm(connectedBot, { searchRadius: 1 });
  assert.deepEqual(result, { harvested: 1, planted: 5, stored: 0 }, 'connected plot extends beyond the starting search distance');
  assert.ok(connected.crops.slice(1).every(crop => crop.diggable), 'water gaps, diagonals and different heights are separate plots');
  assert.equal(connected.planted.size, 5, 'empty soil joins the same plot and harvested soil is replanted');

  connected = plotScenario();
  globalThis.farmScenario = connected;
  connectedBot = makeBot(connected);
  result = await tendNearbyFarm(connectedBot);
  assert.equal(result.harvested, 1, 'connected is the default scope');

  connected = plotScenario();
  globalThis.farmScenario = connected;
  connectedBot = makeBot(connected);
  result = await tendNearbyFarm(connectedBot, { startPosition: { x: 0.9, y: 0.1, z: 2.9 } });
  assert.equal(result.harvested, 1);
  assert.ok(connected.crops[0].diggable, 'explicit start selects the requested plot');
  assert.equal(connected.planted.size, 1);

  connected = plotScenario();
  globalThis.farmScenario = connected;
  connectedBot = makeBot(connected);
  result = await tendNearbyFarm(connectedBot, { scope: 'radius', radius: 2 });
  assert.equal(result.harvested, 1, 'radius mode covers separate plots within its work radius');
  assert.ok(connected.crops[0].diggable, 'radius mode excludes farmland outside its radius');

  connected = plotScenario();
  connected.unloaded = position => position.x === 5 && position.z === 0;
  globalThis.farmScenario = connected;
  connectedBot = makeBot(connected);
  await assert.rejects(tendNearbyFarm(connectedBot), /boundary is not loaded/);
  assert.ok(connected.crops.every(crop => crop.diggable), 'unloaded boundary fails before harvesting');
  for (const options of [32, { radius: 5 }, { scope: 'radius', searchRadius: 5 }, { scope: 'radius', startPosition: { x: 0, y: 0, z: 0 } }, { scope: 'unknown' }, { searchRadius: -1 }, { seedReserve: -1 }, { startPosition: { x: 20, y: 0, z: 0 } }]) {
    await assert.rejects(tendNearbyFarm(connectedBot, options));
  }
  globalThis.farmScenario = scenario;

  connected = plotScenario();
  connected.plot = Array.from({ length: 600 }, (_, x) => block('farmland', null, x));
  connected.crops = [block('wheat', 7, 599)];
  connected.items = [];
  globalThis.farmScenario = connected;
  connectedBot = makeBot(connected);
  connectedBot.entity.position.distanceTo = position => Math.hypot(position.x, position.y, position.z);
  result = await tendNearbyFarm(connectedBot, { searchRadius: 1 });
  assert.equal(result.harvested, 1, 'connected plot is not truncated by the old 512-block limit');
  assert.match(connectedBot.output, /Teleported to 599, 1, 0/, 'distant crop is approached before harvest');

  connected = plotScenario();
  connected.plot = []; connected.crops = [];
  globalThis.farmScenario = connected;
  assert.deepEqual(await tendNearbyFarm(makeBot(connected)), { harvested: 0, planted: 0, stored: 0 }, 'no farmland is a no-op');
  globalThis.farmScenario = scenario;

  const occupiedFarmScenario = {
    crops: [], farmland: [], items: [{ name: 'wheat_seeds', type: 'wheat_seeds', count: 1 }],
    opened: [], deposits: [], closed: 0, activations: [], planted: new Map(), cheat: false
  }
  occupiedFarmScenario.planted.set('21,1,0', { name: 'carrots', position: { x: 21, y: 1, z: 0 } })
  globalThis.farmScenario = occupiedFarmScenario
  bot = makeBot(occupiedFarmScenario)
  assert.equal(await tillAndSow(bot, 21, 0, 0, 'wheat'), false, 'existing different crop is not successful wheat planting')
  occupiedFarmScenario.planted.set('21,1,0', { name: 'wheat', position: { x: 21, y: 1, z: 0 } })
  bot = makeBot(occupiedFarmScenario)
  assert.equal(await tillAndSow(bot, 21, 0, 0, 'wheat'), true, 'existing requested crop satisfies planting')
  assert.equal(scenario.crops[1].diggable, true, 'unripe crops remain untouched')
  for (const harvestMode of ['delayed', 'absent', 'wrong', 'interrupt']) {
    const confirmationScenario = {
      crops: [block('wheat', 7)], farmland: [], items: [{ name: 'wheat', type: 100, count: 5 }],
      nearestChest: nearChest, opened: [], deposits: [], closed: 0, activations: [], planted: new Map(),
      cheat: true, harvestMode
    }
    globalThis.farmScenario = confirmationScenario
    const confirmationBot = makeBot(confirmationScenario)
    result = await tendNearbyFarm(confirmationBot, { scope: 'radius', radius: 32, seedReserve: 0 })
    assert.equal(result.harvested, harvestMode === 'delayed' ? 1 : 0, `${harvestMode} harvest confirmation`)
    if (harvestMode !== 'delayed') {
      assert.equal(result.stored, 0, 'failed harvest leaves pre-existing crop inventory unstored')
      assert.deepEqual(confirmationScenario.opened, [], 'failed harvest does not open chest')
    }
    assert.equal(confirmationBot.listenerCount('itemDrop'), 0)
    assert.equal(confirmationBot.listenerCount('playerCollect'), 0)
    assert.equal(confirmationBot.listenerCount('blockUpdate'), 0)
  }
  globalThis.farmScenario = scenario

  scenario.crops = []
  scenario.farmland = [block('farmland', null, 11), block('farmland', null, 12)]
  scenario.items = [{ name: 'wheat_seeds', type: 'wheat_seeds', count: 2 }]
  scenario.opened = []; scenario.deposits = []; scenario.closed = 0; scenario.activations = []; scenario.planted = new Map(); scenario.cheat = false
  bot = makeBot(scenario)
  result = await tendNearbyFarm(bot, { scope: 'radius', radius: 16, seedReserve: 1 })
  assert.equal(result.planted, 1)
  assert.deepEqual(scenario.activations, [11], 'normal-mode planting uses only seed inventory above reserve')
  assert.equal(bot.inventory.items().find(item => item.name === 'wheat_seeds').count, 1, 'one seed is consumed and reserve remains')

  scenario.crops = []
  scenario.farmland = []
  scenario.items = [{ name: 'carrot', type: 'carrot', count: 1 }]
  scenario.opened = []; scenario.deposits = []; scenario.closed = 0
  bot = makeBot(scenario)
  result = await tendNearbyFarm(bot, { scope: 'radius', radius: 16, seedReserve: 1 })
  assert.deepEqual(result, { harvested: 0, planted: 0, stored: 0 })
  assert.deepEqual(scenario.opened, [], 'default chest is unused when there are no deposits')

  scenario.crops = [block('wheat', 7)]
  scenario.farmland = []
  scenario.items = []
  scenario.nearestChest = null
  scenario.opened = []; scenario.deposits = []; scenario.closed = 0
  bot = makeBot(scenario)
  result = await tendNearbyFarm(bot, { scope: 'radius' })
  assert.equal(result.harvested, 1)
  assert.match(bot.output, /Could not find a nearby chest/)
  assert.equal(scenario.closed, 0)

  scenario.crops = [block('wheat', 7)]
  scenario.items = []
  scenario.nearestChest = nearChest
  scenario.opened = []; scenario.deposits = []; scenario.closed = 0; scenario.cheat = true; scenario.depositReject = false
  bot = makeBot(scenario)
  result = await tendNearbyFarm(bot, { scope: 'radius', radius: 32, seedReserve: 0 })
  assert.equal(result.stored, 2)
  assert.deepEqual(scenario.opened, [nearChest], 'default chest lookup is used')
  assert.equal(scenario.closed, 1, 'opened container is closed')

  scenario.crops = [block('wheat', 7)]
  scenario.items = []
  scenario.depositReject = true
  scenario.opened = []; scenario.deposits = []; scenario.closed = 0; scenario.cheat = true
  bot = makeBot(scenario)
  await assert.rejects(tendNearbyFarm(bot, { scope: 'radius', radius: 32, seedReserve: 0 }), /injected deposit failure/)
  assert.equal(scenario.closed, 1, 'container closes when a deposit fails')

  const plantingScenario = {
    crops: [], farmland: [block('farmland', null, 20)],
    items: [{ name: 'wheat', count: 8 }, { name: 'wheat_seeds', type: 'wheat_seeds', count: 2 }],
    opened: [], deposits: [], closed: 0, activations: [], planted: new Map(), cheat: false
  }
  globalThis.farmScenario = plantingScenario
  bot = makeBot(plantingScenario)
  assert.equal(await tillAndSow(bot, 20, 0, 0, 'wheat'), true, 'crop-name alias plants using its seed item')
  assert.equal(bot.heldItem.name, 'wheat_seeds', 'wheat alias equips wheat seeds, not wheat grain')
  assert.equal(bot.blockAt({ x: 20, y: 1, z: 0 }).name, 'wheat', 'planting is confirmed by the block update')
  assert.equal(bot.inventory.items().find(item => item.name === 'wheat_seeds').count, 1)

  plantingScenario.planted = new Map()
  plantingScenario.noPlant = true
  bot = makeBot(plantingScenario)
  assert.equal(await tillAndSow(bot, 20, 0, 0, 'wheat'), false, 'planting returns false without a block update')
  assert.match(bot.output, /Could not confirm planting wheat_seeds/)
  assert.equal(bot.listenerCount('blockUpdate'), 0, 'plant listener is removed after timeout')

  const cheatPlantingScenario = { crops: [], farmland: [], items: [], opened: [], deposits: [], closed: 0, activations: [], planted: new Map(), cheat: true }
  globalThis.farmScenario = cheatPlantingScenario
  bot = makeBot(cheatPlantingScenario)
  assert.equal(await tillAndSow(bot, 30, 0, 2, 'wheat'), true, 'cheat planting waits for authoritative farmland and crop updates')
  assert.deepEqual(cheatPlantingScenario.setblockCommands.filter(command => command.endsWith(' farmland') || command.endsWith(' wheat')).map(command => command.split(' ').at(-1)), ['wheat'], 'existing farmland is accepted and requested crop is still confirmed')
  assert.equal(bot.listenerCount('blockUpdate'), 0)
  for (const setblockMode of ['absent', 'wrong', 'cropAbsent', 'delayed']) {
    const scenario = { crops: [], farmland: [], items: [], opened: [], deposits: [], closed: 0, activations: [], planted: new Map(), cheat: true, baseBlockName: 'dirt', setblockMode }
    globalThis.farmScenario = scenario
    bot = makeBot(scenario)
    assert.equal(await tillAndSow(bot, 30, 0, 2, 'wheat'), setblockMode === 'delayed', `${setblockMode} cheat planting update handling`)
    assert.equal(bot.listenerCount('blockUpdate'), 0)
    if (setblockMode === 'absent' || setblockMode === 'wrong') {
      assert.equal(scenario.setblockCommands.filter(command => command.endsWith(' wheat')).length, 0, 'crop placement waits until farmland is confirmed')
    }
  }

  const docs = getSkillDocs()
  assert.ok(docs.some(doc => doc.startsWith('skills.tendNearbyFarm\n') && doc.includes('seedReserve')))
  const library = new SkillLibrary({}, null)
  await library.initSkillLibrary()
  const alwaysDocs = await library.getRelevantSkillDocs('build a wall', 0)
  assert.ok(!alwaysDocs.includes('skills.tendNearbyFarm'))
  assert.ok(alwaysDocs.includes('vision.lookAtPlayer'))
  assert.ok(alwaysDocs.includes('vision.lookAtPosition'))
  const farmDoc = library.skill_docs.find(doc => doc.startsWith('skills.tendNearbyFarm\n'))
  const fallbackAllDocs = await library.getRelevantSkillDocs('tend the farm', -1)
  assert.ok(fallbackAllDocs.includes(farmDoc), 'null embedding all-doc selection uses the docs themselves')
  library.skill_docs_embeddings = { [farmDoc]: [1] } // partial embedding map left by a failed embed operation
  const fallbackFarmDocs = await library.getRelevantSkillDocs('connected farmland harvest mature crops replant empty soil store produce', 1)
  assert.ok(fallbackFarmDocs.includes(farmDoc), 'null embedding fallback always scores full docs, even with partial vectors')
  library.skill_docs_embeddings = { [farmDoc]: [1] }
  library.embedding_model = { async embed() { return [1] } }
  assert.ok((await library.getRelevantSkillDocs('tend the farm', 1)).includes(farmDoc), 'farm docs remain selectable')
  console.log('farm skill tests passed')
}

async function main() {
  if (process.argv[2] === '--navigation-only') {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-focused-navigation-'))
    try { await testNavigation(path.join(temp, 'navigation-fixture')) }
    finally { await rm(temp, { recursive: true, force: true }) }
    return
  }
  if (process.argv[2] === '--interaction-confirmation-only') {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-focused-interaction-'))
    try {
      const fixture = path.join(temp, 'navigation-fixture')
      await setupNavigationFixture(fixture)
      await write(temp, 'node_modules/prismarine-item/package.json', '{"main":"index.js"}')
      await write(temp, 'node_modules/prismarine-item/index.js', 'module.exports = () => class Item { static toNotch(item) { return item ? { itemId: item.type, itemCount: item.count, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] } : { itemCount: 0, components: [], removeComponents: [] } } static fromNotch(item) { if (!item || item.present === false || item.itemCount === 0) return null; const type = item.itemId ?? item.blockId ?? item.type; const count = item.itemCount ?? item.count; return type == null ? null : { type, count, metadata: item.metadata ?? item.itemDamage ?? 0, stackSize: 64 } } };')
      execFileSync(node, [path.join(__dirname, 'interaction_confirmation.test.cjs'), fixture], { stdio: 'inherit' })
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
    return
  }
  execFileSync(node, [path.join(__dirname, 'tree_felling.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'block_interaction.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'native_sdk.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'codex_session.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'ollama_contract.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'state_poller.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'camera_lifecycle.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'vision_request_ownership.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'vision_sdk_validation.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'message_targets.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'partial_read_capture.test.cjs'), path.join(repo, 'src/utils/partial_read_capture.js')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'minecraft_protocol_overrides.test.mjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'place_store.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'place_rpc.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'block_placement.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'targeted_sdk.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'chest_transfer.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'place_actions.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'place_agent.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'action_manager.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'operation_context.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'idle_scheduling.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'generation_cancellation.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'furnace_lifecycle.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'recovery_replanning.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'management_reconnect.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'management_auth.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'agent_process.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'agent_shutdown.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'world_observation.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'shutdown_experiments.cjs')], { stdio: 'inherit' })
  const temp = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-owned-tests-'))
  try {
    const helper = path.join(temp, 'crafting_sync.js')
    await writeFile(helper, await readFile(path.join(repo, 'src/agent/library/crafting_sync.js')))
    await writeFile(path.join(temp, 'operation_context.js'), await readFile(path.join(repo, 'src/agent/library/operation_context.js')))
    await write(temp, 'node_modules/prismarine-item/package.json', '{"main":"index.js"}')
    await write(temp, 'node_modules/prismarine-item/index.js', 'module.exports = () => class Item { static toNotch(item) { return item ? { itemId: item.type, itemCount: item.count, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] } : { itemCount: 0, components: [], removeComponents: [] } } static fromNotch(item) { if (!item || item.present === false || item.itemCount === 0) return null; const type = item.itemId ?? item.blockId ?? item.type; const count = item.itemCount ?? item.count; return type == null ? null : { type, count, metadata: item.metadata ?? item.itemDamage ?? 0, stackSize: 64 } } };')
    execFileSync(node, [path.join(__dirname, 'crafting_sync.test.cjs'), helper], { stdio: 'inherit' })
    execFileSync(node, [path.join(__dirname, 'mining_sync.test.cjs'), path.join(repo, 'src/agent/library/mining_sync.js')], { stdio: 'inherit' })
    const farmRoot = path.join(temp, 'farm-fixture')
    await testFarm(farmRoot)
    await testNavigation(path.join(temp, 'navigation-fixture'))
    execFileSync(node, [path.join(__dirname, 'interaction_confirmation.test.cjs'), path.join(temp, 'navigation-fixture')], { stdio: 'inherit' })
    execFileSync(node, [path.join(__dirname, 'mining_integration.test.cjs'), farmRoot], { stdio: 'inherit' })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
