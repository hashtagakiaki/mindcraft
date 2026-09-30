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
  await write(root, 'src/agent/library/mining_sync.js', await readFile(path.join(repo, 'src/agent/library/mining_sync.js')))
  await write(root, 'src/agent/library/crafting_sync.js', await readFile(path.join(repo, 'src/agent/library/crafting_sync.js')))
  await write(root, 'src/agent/library/index.js', await readFile(path.join(repo, 'src/agent/library/index.js')))
  await write(root, 'src/agent/library/skill_library.js', await readFile(path.join(repo, 'src/agent/library/skill_library.js')))
  await write(root, 'src/agent/modes.js', await readFile(path.join(repo, 'src/agent/modes.js')))
  await write(root, 'src/agent/settings.js', 'export default {};')
  await write(root, 'src/agent/conversation.js', 'export default {};')
  await write(root, 'src/utils/mcdata.js', 'export function mustCollectManually(name) { return name === "wheat"; }')
  await write(root, 'src/utils/math.js', 'export function cosineSimilarity() { return 0; }')
  await write(root, 'src/utils/text.js', 'export function wordOverlapScore() { return 0; }')
  await write(root, 'src/agent/library/world.js', `
export function getNearestBlocks(bot, types) {
  const scenario = globalThis.farmScenario;
  return Array.isArray(types) ? scenario.crops : types === 'farmland' ? scenario.farmland : [];
}
export function getNearestBlocksWhere(bot, predicate) {
  return (globalThis.farmScenario.collectBlocks || []).filter(predicate);
}
export function getNearestBlock(bot, type) {
  const scenario = globalThis.farmScenario;
  return type === 'chest' ? scenario.nearestChest : null;
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
  await write(root, 'src/agent/library/crafting_sync.js', await readFile(path.join(repo, 'src/agent/library/crafting_sync.js')))
  await write(root, 'src/utils/mcdata.js', 'export function mustCollectManually(name) { return name === "wheat"; } export function getBlockId() { return 1; }')
  await write(root, 'src/agent/library/world.js', `
export function getNearestBlock(bot) { return bot.navigation.block || null; }
export function getNearestBlocksWhere(bot, predicate) { return (bot.navigation.blocks || []).filter(predicate); }
export function getNearestEntityWhere(bot, predicate) { return (bot.navigation.entities || []).find(predicate) || null; }
export function isEntityType(name) { return name === 'cow'; }
export function shouldPlaceTorch() { return false; }
export function getNearbyEntities() { return []; }
export function getPosition(bot) { return bot.entity.position; }
`)
  await write(root, 'node_modules/vec3/package.json', '{"type":"module","exports":"./index.js"}')
  await write(root, 'node_modules/vec3/index.js', 'export default function Vec3(x, y, z) { return { x, y, z }; }')
  await write(root, 'node_modules/mineflayer-pathfinder/package.json', '{"type":"module","exports":"./index.js"}')
  await write(root, 'node_modules/mineflayer-pathfinder/index.js', 'export default { goals: { GoalNear: class {}, GoalFollow: class {}, GoalInvert: class {} }, Movements: class { constructor() { this.blocksCantBreak = new Set(); } } };')
}

async function testNavigation(root) {
  await setupNavigationFixture(root)
  const skills = await import(pathToFileURL(path.join(root, 'src/agent/library/skills.js')))
  const targetBlock = { name: 'chest', position: { x: 4, y: 0, z: 0, toString() { return '4,0,0' }, offset() { return this } } }
  const targetEntity = { name: 'cow', position: { x: 4, y: 0, z: 0 } }
  const makeBot = ({ result = true, reject = false, rejectAfter = 0, distance = 0 } = {}) => {
    const bot = {
      output: '', username: 'bot', game: { gameMode: 'survival' }, players: {}, navigation: { block: targetBlock, blocks: [], entities: [targetEntity] },
      entity: { position: { x: 0, y: 0, z: 0, clone() { return this }, offset() { return this }, distanceTo: () => result === false ? 10 : distance }, height: 1 },
      modes: { isOn: () => false, pause() {}, unpause() {} }, inventory: { slots: [], items: () => [], findInventoryItem: () => null },
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
  console.log('navigation contract tests passed')
}

function block(name, age, x = 0) {
  return { name, position: { x, y: 0, z: 0, offset(dx, dy, dz) { return { x: x + dx, y: dy, z: dz } } }, diggable: true, getProperties: () => ({ age }) }
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
  let result = await tendNearbyFarm(bot, 16, 1, { x: 4.9, y: 0.5, z: 0.1 })
  assert.deepEqual(result, { harvested: 1, planted: 1, stored: 2 })
  assert.deepEqual(scenario.opened, [explicitChest])
  assert.equal(scenario.closed, 1)
  assert.deepEqual(scenario.deposits, [{ type: 'wheat', count: 1 }, { type: 'wheat_seeds', count: 1 }])
  assert.equal(bot.inventory.items().find(item => item.name === 'wheat_seeds').count, 1)

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
    result = await tendNearbyFarm(confirmationBot, 32, 0)
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
  result = await tendNearbyFarm(bot, 16, 1)
  assert.equal(result.planted, 1)
  assert.deepEqual(scenario.activations, [11], 'normal-mode planting uses only seed inventory above reserve')
  assert.equal(bot.inventory.items().find(item => item.name === 'wheat_seeds').count, 1, 'one seed is consumed and reserve remains')

  scenario.crops = []
  scenario.farmland = []
  scenario.items = [{ name: 'carrot', type: 'carrot', count: 1 }]
  scenario.opened = []; scenario.deposits = []; scenario.closed = 0
  bot = makeBot(scenario)
  result = await tendNearbyFarm(bot, 16, 1)
  assert.deepEqual(result, { harvested: 0, planted: 0, stored: 0 })
  assert.deepEqual(scenario.opened, [], 'default chest is unused when there are no deposits')

  scenario.crops = [block('wheat', 7)]
  scenario.farmland = []
  scenario.items = []
  scenario.nearestChest = null
  scenario.opened = []; scenario.deposits = []; scenario.closed = 0
  bot = makeBot(scenario)
  result = await tendNearbyFarm(bot)
  assert.equal(result.harvested, 1)
  assert.match(bot.output, /Could not find a nearby chest/)
  assert.equal(scenario.closed, 0)

  scenario.crops = [block('wheat', 7)]
  scenario.items = []
  scenario.nearestChest = nearChest
  scenario.opened = []; scenario.deposits = []; scenario.closed = 0; scenario.cheat = true; scenario.depositReject = false
  bot = makeBot(scenario)
  result = await tendNearbyFarm(bot, 32, 0)
  assert.equal(result.stored, 2)
  assert.deepEqual(scenario.opened, [nearChest], 'default chest lookup is used')
  assert.equal(scenario.closed, 1, 'opened container is closed')

  scenario.crops = [block('wheat', 7)]
  scenario.items = []
  scenario.depositReject = true
  scenario.opened = []; scenario.deposits = []; scenario.closed = 0; scenario.cheat = true
  bot = makeBot(scenario)
  await assert.rejects(tendNearbyFarm(bot, 32, 0), /injected deposit failure/)
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
  assert.ok(library.always_show_skills.includes('skills.tendNearbyFarm'))
  assert.ok(library.always_show_skills_docs['skills.tendNearbyFarm'].includes('Harvest every mature nearby farmland crop'))
  console.log('farm skill tests passed')
}

async function main() {
  execFileSync(node, [path.join(__dirname, 'action_manager.test.cjs')], { stdio: 'inherit' })
  execFileSync(node, [path.join(__dirname, 'idle_scheduling.test.cjs')], { stdio: 'inherit' })
  const temp = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-owned-tests-'))
  try {
    const helper = path.join(temp, 'crafting_sync.js')
    await writeFile(helper, await readFile(path.join(repo, 'src/agent/library/crafting_sync.js')))
    await write(temp, 'node_modules/prismarine-item/package.json', '{"main":"index.js"}')
    await write(temp, 'node_modules/prismarine-item/index.js', 'module.exports = () => class Item { static toNotch(item) { return item ? { type: item.type, count: item.count, metadata: item.metadata } : null } static fromNotch(item) { return item ? { ...item, stackSize: 64 } : null } };')
    execFileSync(node, [path.join(__dirname, 'crafting_sync.test.cjs'), helper], { stdio: 'inherit' })
    execFileSync(node, [path.join(__dirname, 'mining_sync.test.cjs'), path.join(repo, 'src/agent/library/mining_sync.js')], { stdio: 'inherit' })
    const farmRoot = path.join(temp, 'farm-fixture')
    await testFarm(farmRoot)
    await testNavigation(path.join(temp, 'navigation-fixture'))
    execFileSync(node, [path.join(__dirname, 'mining_integration.test.cjs'), farmRoot], { stdio: 'inherit' })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
