'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

function createBot(scenario) {
  globalThis.farmScenario = scenario
  const bot = new EventEmitter()
  bot.output = ''
  bot.registry = { items: [], itemsByName: { iron_ore: { id: 20 }, wheat: { id: 30 }, wheat_seeds: { id: 31 } } }
  bot.registry.items[10] = { name: 'raw_iron' }
  bot.registry.items[20] = { name: 'iron_ore' }
  bot.registry.items[30] = { name: 'wheat' }
  bot.registry.items[31] = { name: 'wheat_seeds' }
  bot.entity = { id: 1, position: { x: 0, y: 0, z: 0, floored() { return this } } }
  bot.pathfinder = { goals: [], setMovements() {}, getPathTo: () => ({ status: 'success' }),
    async goto(goal) { this.goals.push(goal) } }
  bot.inventory = { items: () => scenario.items ?? [], slots: scenario.items ?? [] }
  bot.modes = { isOn: () => true }
  bot.tool = { async equipForBlock() { bot.heldItem = scenario.heldItem ?? { type: 1, enchants: [] } } }
  // collectBlock digs directly; the plugin's unbounded collect() is not used.
  bot.collectBlock = { async collect() { throw new Error('plugin collect must not be used') } }
  bot.dig = async block => {
    if (scenario.dig) return scenario.dig(block, bot)
    await scenario.collect(block, bot)
    scenario.collectBlocks.shift()
  }
  bot.nearestEntity = () => null
  bot.blockAt = () => scenario.currentAir
    ? { name: 'air', type: 0 }
    : { name: scenario.collectBlocks[0]?.name ?? 'iron_ore', type: 15 }
  bot.chat = () => {}
  return bot
}

function ore({ drops = [10], name = 'iron_ore' } = {}) {
  return {
    name,
    drops,
    position: { x: 1, y: 0, z: 0, offset(dx, dy, dz) { return { x: 1 + dx, y: dy, z: dz } } },
    canHarvest: () => true
  }
}

let nextEntityId = 10
function droppedItem(type = 10, x = 1.5) {
  return {
    id: nextEntityId++,
    position: { x, y: 0.5, z: 0.5, distanceTo(other) { return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z) } },
    getDroppedItem() { return { type } }
  }
}

function spawnAndPickup(bot, entity = droppedItem()) {
  bot.emit('itemDrop', entity)
  bot.emit('playerCollect', bot.entity, entity)
}

function scenarioFor(block, collect) {
  return { collectBlocks: [block], currentAir: false, collect }
}

async function main() {
  const root = path.resolve(process.argv[2])
  const { collectBlock } = await import(pathToFileURL(path.join(root, 'src/agent/library/skills.js')))

  // An inventory increase alone or another player's pickup is not a target collection.
  for (const pickup of ['none', 'other-player']) {
    const scenario = scenarioFor(ore(), async (_block, bot) => {
      const entity = droppedItem()
      bot.emit('itemDrop', entity)
      if (pickup === 'other-player') bot.emit('playerCollect', { id: 2 }, entity)
      scenario.currentAir = true
    })
    const bot = createBot(scenario)
    assert.equal(await collectBlock(bot, 'iron_ore'), false)
    assert.equal(bot.listenerCount('itemDrop'), 0)
    assert.equal(bot.listenerCount('playerCollect'), 0)
    assert.equal(bot.listenerCount('blockUpdate'), 0)
  }
  // Chest storage before or after a target pickup does not replace the authoritative collect packet.
  for (const storage of ['before', 'after']) {
    const scenario = scenarioFor(ore(), async (_block, bot) => {
      if (storage === 'before') bot.inventory.slots.length = 0
      const entity = droppedItem()
      bot.emit('itemDrop', entity)
      bot.emit('playerCollect', bot.entity, entity)
      if (storage === 'after') bot.inventory.slots.length = 0
      scenario.currentAir = true
    })
    scenario.items = [{ name: 'raw_iron', type: 10, count: 20 }]
    const bot = createBot(scenario)
    assert.equal(await collectBlock(bot, 'iron_ore'), true, `pickup remains confirmed when storage occurs ${storage} it\n${bot.output}`)
    assert.equal(bot.pathfinder.goals.length, 1)
    assert.equal(bot.pathfinder.goals[0].range, 2, 'ore collection first uses a dig-enabled near goal')
  }
  // Slot movement without a playerCollect packet is not a pickup, in either update order.
  for (const destinationFirst of [true, false]) {
    const scenario = scenarioFor(ore(), async (_block, bot) => {
      const entity = droppedItem()
      bot.emit('itemDrop', entity)
      if (destinationFirst) {
        bot.inventory.slots.push({ name: 'raw_iron', type: 10, count: 1 })
        bot.inventory.slots.shift()
      } else {
        bot.inventory.slots.shift()
        bot.inventory.slots.push({ name: 'raw_iron', type: 10, count: 1 })
      }
      scenario.currentAir = true
    })
    scenario.items = [{ name: 'raw_iron', type: 10, count: 1 }]
    assert.equal(await collectBlock(createBot(scenario), 'iron_ore'), false)
  }

  // Unrelated drops, even with the right item type, are outside the target block radius.
  {
    const scenario = scenarioFor(ore(), async (_block, bot) => {
      const entity = droppedItem(10, 10)
      bot.emit('itemDrop', entity)
      bot.emit('playerCollect', bot.entity, entity)
      scenario.currentAir = true
    })
    assert.equal(await collectBlock(createBot(scenario), 'iron_ore'), false)
  }

  // Matching nearby drop pickup plus server target-air confirms; either signal alone fails.
  {
    const scenario = scenarioFor(ore(), async (_block, bot) => {
      spawnAndPickup(bot)
      scenario.currentAir = true
    })
    const bot = createBot(scenario)
    assert.equal(await collectBlock(bot, 'iron_ore'), true)
    assert.match(bot.output, /Collected 1 iron_ore/)
    assert.equal(bot.listenerCount('itemDrop'), 0)
  }
  {
    const scenario = scenarioFor(ore(), async (_block, bot) => spawnAndPickup(bot))
    assert.equal(await collectBlock(createBot(scenario), 'iron_ore'), false)
  }

  // Static drops and held silk-touch enchantments select distinct item IDs.
  {
    const scenario = scenarioFor(ore(), async (_block, bot) => {
      spawnAndPickup(bot, droppedItem(20))
      scenario.currentAir = true
    })
    const bot = createBot(scenario)
    bot.tool.equipForBlock = async () => { bot.heldItem = { type: 1, enchants: [{ name: 'silk_touch', lvl: 1 }] } }
    assert.equal(await collectBlock(bot, 'iron_ore'), true)
  }
  {
    const scenario = scenarioFor(ore(), async (_block, bot) => {
      spawnAndPickup(bot, droppedItem(10))
      scenario.currentAir = true
    })
    const bot = createBot(scenario)
    bot.tool.equipForBlock = async () => { bot.heldItem = { type: 1, enchants: [{ name: 'silk_touch', lvl: 1 }] } }
    assert.equal(await collectBlock(bot, 'iron_ore'), false)
  }

  // Mature wheat can produce wheat even when its guaranteed seed drop is absent.
  {
    const wheat = ore({ name: 'wheat', drops: [31] })
    const scenario = scenarioFor(wheat, async () => { throw new Error('wheat uses manual collection') })
    scenario.dig = async (_block, bot) => {
      spawnAndPickup(bot, droppedItem(30))
      scenario.currentAir = true
    }
    assert.equal(await collectBlock(createBot(scenario), 'wheat'), true)
  }
  {
    const scenario = scenarioFor(ore(), async (_block, bot) => {
      spawnAndPickup(bot, droppedItem(20))
      scenario.currentAir = true
    })
    assert.equal(await collectBlock(createBot(scenario), 'iron_ore'), false)
  }

  // Block count and partial-success behavior are preserved for num > 1.
  {
    const first = ore()
    const second = ore({ name: 'deepslate_iron_ore' })
    const scenario = {
      collectBlocks: [first, second], currentAir: false,
      async collect(_block, bot) {
        if (scenario.collectBlocks.length === 2) {
          spawnAndPickup(bot)
          scenario.currentAir = true
        } else {
          scenario.currentAir = true
        }
      }
    }
    const bot = createBot(scenario)
    assert.equal(await collectBlock(bot, 'iron_ore', 2), true)
    assert.match(bot.output, /Collected 1 iron_ore/)
  }

  // Native results separate requested, confirmed and remaining blocks; legacy stays boolean.
  const skills = await import(pathToFileURL(path.join(root, 'src/agent/library/skills.js')))
  const { createOperationContext, operationResult, runOwnedOperation } = await import(pathToFileURL(path.join(root, 'src/agent/library/operation_context.js')))
  const { createNativeSdk } = await import(pathToFileURL(path.join(root, 'src/agent/library/native_sdk.js')))
  const owned = async (bot, body) => {
    const owner = createOperationContext({ id: 1, controller: new AbortController() }, { bot }, { intentEpoch: 0 })
    const value = await runOwnedOperation(owner, body)
    return { value, operation: operationResult(owner) }
  }
  const pickupScenario = count => ({
    collectBlocks: Array.from({ length: count }, () => ore()), currentAir: false,
    async collect(block, bot) {
      const entity = droppedItem()
      entity.getDroppedItem = () => ({ type: 10, name: 'raw_iron', count: 1 })
      spawnAndPickup(bot, entity)
      bot.emit('blockUpdate', { position: block.position }, { type: 0, name: 'air' })
    }
  })
  {
    const bot = createBot(pickupScenario(1))
    const sdk = createNativeSdk({ bot, skills })
    const { value, operation } = await owned(bot, () => sdk.skills.collectBlock({ blockType: 'iron_ore', count: 10 }))
    assert.equal(value.ok, false, '1 of 10 collected blocks is not native success')
    assert.equal(value.status, 'partial')
    assert.equal(value.code, 'not_found')
    assert.equal(value.unit, 'block')
    assert.deepEqual([value.requestedQuantity, value.confirmedQuantity, value.remainingQuantity], [10, 1, 9])
    assert.deepEqual(value.collectedItems, { raw_iron: 1 }, 'picked-up drops are a separate observation from block quantity')
    assert.equal(operation.skillResults.find(call => call.skill === 'skills.collectBlock').result.code, 'not_found', 'the same outcome reaches skillResults')
    const legacyBot = createBot(pickupScenario(1))
    const legacy = await owned(legacyBot, () => collectBlock(legacyBot, 'iron_ore', 10))
    assert.equal(legacy.value, true, 'legacy partial collection keeps its boolean contract')
  }
  {
    const bot = createBot(pickupScenario(2))
    const sdk = createNativeSdk({ bot, skills })
    const { value } = await owned(bot, () => sdk.skills.collectBlock({ blockType: 'iron_ore', count: 2 }))
    assert.equal(value.ok, true)
    assert.equal(value.status, 'complete')
    assert.deepEqual([value.requestedQuantity, value.confirmedQuantity, value.remainingQuantity], [2, 2, 0])
  }
  {
    const scenario = scenarioFor(ore(), async () => {})
    const bot = createBot(scenario)
    bot.tool.equipForBlock = async () => { bot.heldItem = null }
    scenario.collectBlocks[0].canHarvest = () => false
    const { value } = await owned(bot, () => createNativeSdk({ bot, skills }).skills.collectBlock({ blockType: 'iron_ore', count: 3 }))
    assert.equal(value.ok, false)
    assert.equal(value.status, 'failed')
    assert.equal(value.code, 'missing_tool')
    assert.deepEqual([value.requestedQuantity, value.confirmedQuantity, value.remainingQuantity], [3, 0, 3])
  }

  // Item quantity, self-feeding and held-use contracts on the same owned native path.
  const itemBot = items => {
    const bot = createBot({ collectBlocks: [], items })
    bot.inventory.findInventoryItem = name => items.find(item => item.name === name && item.count > 0) ?? null
    bot.inventory.items = () => items.filter(item => item.count > 0)
    bot.toss = async (type, _metadata, count) => { items.find(item => item.type === type).count -= count }
    bot.equip = async item => { bot.heldItem = item }
    bot.unequip = async () => {}
    bot.game = { gameMode: 'survival' }
    bot.food = 10
    return bot
  }
  {
    const bot = itemBot([{ name: 'oak_log', type: 5, count: 2 }])
    const { value } = await owned(bot, () => createNativeSdk({ bot, skills }).skills.discard({ itemName: 'oak_log', quantity: 10 }))
    assert.equal(value.ok, false, '2 of 10 discarded items is not native success')
    assert.equal(value.status, 'partial')
    assert.equal(value.code, 'insufficient_items')
    assert.deepEqual([value.unit, value.requestedQuantity, value.confirmedQuantity, value.remainingQuantity], ['item', 10, 2, 8])
    const full = itemBot([{ name: 'oak_log', type: 5, count: 4 }])
    const complete = await owned(full, () => createNativeSdk({ bot: full, skills }).skills.discard({ itemName: 'oak_log', quantity: 3 }))
    assert.deepEqual([complete.value.ok, complete.value.status, complete.value.confirmedQuantity], [true, 'complete', 3])
    const legacyBot = itemBot([{ name: 'oak_log', type: 5, count: 2 }])
    assert.equal((await owned(legacyBot, () => skills.discard(legacyBot, 'oak_log', 10))).value, true, 'legacy discard stays boolean')
  }
  {
    const eaten = []
    const foods = items => {
      const bot = itemBot(items)
      bot.registry.foodsByName = { apple: { foodPoints: 4 }, bread: { foodPoints: 5 }, rotten_flesh: { foodPoints: 4 }, golden_apple: { foodPoints: 4 } }
      bot.consume = async () => { eaten.push(bot.heldItem.name); bot.heldItem.count-- }
      return bot
    }
    const bot = foods([{ name: 'rotten_flesh', type: 1, count: 3 }, { name: 'apple', type: 2, count: 1 }, { name: 'golden_apple', type: 3, count: 1 }])
    const sdk = createNativeSdk({ bot, skills })
    const first = await owned(bot, () => sdk.skills.consume())
    assert.deepEqual([first.value.ok, first.value.status, first.value.itemName], [true, 'complete', 'apple'], 'omitted itemName selects eligible food')
    const empty = await owned(bot, () => sdk.skills.consume({ itemName: '' }))
    assert.deepEqual([empty.value.ok, empty.value.code], [false, 'no_food'], 'excluded foods are never default choices')
    const explicit = await owned(bot, () => sdk.skills.consume({ itemName: 'rotten_flesh' }))
    assert.deepEqual([explicit.value.ok, explicit.value.itemName], [true, 'rotten_flesh'], 'an explicit item is used as named')
    const missing = await owned(bot, () => sdk.skills.consume({ itemName: 'bread' }))
    assert.deepEqual([missing.value.ok, missing.value.code], [false, 'missing_item'], 'a missing explicit item never substitutes another food')
    assert.deepEqual(eaten, ['apple', 'rotten_flesh'])
    const best = foods([{ name: 'apple', type: 2, count: 1 }, { name: 'bread', type: 4, count: 1 }])
    assert.equal((await owned(best, () => createNativeSdk({ bot: best, skills }).skills.consume())).value.itemName, 'bread')
  }
  {
    const villager = { id: 7, entityType: 99, metadata: [], position: { x: 0, y: 0, z: 0 } }
    const tradeBot = maxUses => {
      const items = [{ name: 'emerald', type: 60, metadata: 0, count: 20 }]
      const bot = itemBot(items)
      bot.registry.entitiesByName = { villager: { id: 99 } }
      bot.registry.items[61] = { name: 'bread' }
      bot.entities = { 7: villager }
      bot.entity.position.distanceTo = () => 1
      const trade = { inputItem1: { type: 60, metadata: 0, count: 1, displayName: 'Emerald' }, outputItem: { type: 61, count: 2, displayName: 'Bread' },
        maximumNbTradeUses: maxUses, nbTradeUses: 0, disabled: false }
      bot.openVillager = async () => ({ trades: [trade], slots: items, close() {} })
      bot.trade = async (_window, _index, times) => {
        const bread = items.find(item => item.name === 'bread') ?? items[items.push({ name: 'bread', type: 61, count: 0 }) - 1]
        bread.count += times * 2
      }
      return bot
    }
    const limited = tradeBot(2)
    const { value } = await owned(limited, () => createNativeSdk({ bot: limited, skills }).skills.tradeWithVillager({ entityId: 7, index: 1, times: 10 }))
    assert.equal(value.ok, false, '2 of 10 trades is not native success')
    assert.deepEqual([value.status, value.code, value.unit], ['partial', 'trade_limit', 'trade'])
    assert.deepEqual([value.requestedQuantity, value.confirmedQuantity, value.remainingQuantity], [10, 2, 8])
    const open = tradeBot(10)
    const complete = await owned(open, () => createNativeSdk({ bot: open, skills }).skills.tradeWithVillager({ entityId: 7, index: 1, times: 3 }))
    assert.deepEqual([complete.value.ok, complete.value.status, complete.value.confirmedQuantity], [true, 'complete', 3])
  }
  {
    const useBot = () => {
      const bot = itemBot([{ name: 'bow', type: 70, count: 1 }, { name: 'shield', type: 71, count: 1 }])
      bot.entities = { 9: { id: 9, height: 2, position: { x: 3, y: 0, z: 0, offset(dx, dy, dz) { return { x: 3 + dx, y: dy, z: dz } } } } }
      bot.packets = []
      bot.lookAt = async point => { bot.packets.push(['look', point.y]) }
      bot.activateItem = offHand => { bot.usingHeldItem = true; bot.packets.push(['use', offHand]) }
      bot.deactivateItem = () => { bot.usingHeldItem = false; bot.packets.push(['release']) }
      return bot
    }
    const once = useBot()
    const single = await owned(once, () => createNativeSdk({ bot: once, skills }).skills.useItem({ itemName: 'bow' }))
    assert.deepEqual([single.value.ok, single.value.released, single.value.effect], [true, true, 'not_observed'], 'input success is not a hit claim')
    assert.deepEqual(once.packets, [['use', false], ['release']], 'a one-shot use never leaves the item in use')
    const held = useBot()
    const hold = await owned(held, () => createNativeSdk({ bot: held, skills }).skills.useItem({ itemName: 'bow', holdMs: 60, entity: held.entities[9] }))
    assert.equal(hold.value.ok, true)
    assert.ok(hold.value.heldMs >= 50, 'the requested hold elapses before release')
    assert.deepEqual(held.packets, [['look', 1], ['use', false], ['release']], 'aim, use and release happen in one call')
    const missing = useBot()
    missing.entities = {}
    const gone = await owned(missing, () => createNativeSdk({ bot: missing, skills }).skills.useItem({ itemName: 'bow', entity: { id: 9, position: { x: 0, y: 0, z: 0 } } }))
    assert.deepEqual([gone.value.ok, gone.value.code], [false, 'target_not_found'])
    assert.deepEqual(missing.packets, [], 'an absent target sends no use input')
    const cancelled = useBot()
    const controller = new AbortController()
    const owner = createOperationContext({ id: 2, controller }, { bot: cancelled }, { intentEpoch: 0 })
    const running = runOwnedOperation(owner, () => createNativeSdk({ bot: cancelled, skills }).skills.useItem({ itemName: 'shield', hand: 'off', holdMs: 5000 }))
    setTimeout(() => { cancelled.interrupt_code = true; controller.abort('stop') }, 40)
    const result = await running
    assert.deepEqual([result.ok, result.code], [false, 'cancelled'])
    assert.equal(cancelled.usingHeldItem, false, 'cancellation releases the held item')
    assert.deepEqual(cancelled.packets, [['use', true], ['release']])
  }

  console.log('mining integration tests passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
