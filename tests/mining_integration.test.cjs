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
  bot.entity = { id: 1, position: { x: 0, y: 0, z: 0 } }
  bot.inventory = { items: () => scenario.items ?? [], slots: scenario.items ?? [] }
  bot.modes = { isOn: () => true }
  bot.tool = { async equipForBlock() { bot.heldItem = scenario.heldItem ?? { type: 1, enchants: [] } } }
  bot.collectBlock = {
    async collect(block) {
      await scenario.collect(block, bot)
      scenario.collectBlocks.shift()
    }
  }
  bot.dig = async block => scenario.dig?.(block, bot)
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
    assert.equal(await collectBlock(bot, 'iron_ore'), true, `pickup remains confirmed when storage occurs ${storage} it`)
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

  // The normal unstuck mode discards stationary time while a finite mining operation is protected.
  {
    const { initModes } = await import(pathToFileURL(path.join(root, 'src/agent/modes.js')))
    const position = {
      x: 0, y: 0, z: 0,
      clone() { return { ...this, clone: this.clone, distanceTo: () => 0 } },
      distanceTo: () => 0
    }
    const bot = new EventEmitter()
    bot.entity = { id: 1, position }
    bot.targetDigBlock = ore()
    bot.stopDigging = () => {}
    const { installMiningSync } = await import(pathToFileURL(path.join(root, 'src/agent/library/mining_sync.js')))
    const miningState = installMiningSync(bot)
    let runActionCount = 0
    const agent = {
      bot,
      task: null,
      prompter: { getInitModes: () => Object.fromEntries([
        'self_preservation', 'unstuck', 'cowardice', 'self_defense', 'hunting',
        'item_collecting', 'torch_placing', 'elbow_room', 'idle_staring', 'cheat'
      ].map(name => [name, name === 'unstuck'])) },
      actions: {
        currentActionLabel: 'mining',
        async runAction() { runActionCount++; return { message: 'captured', interrupted: true } }
      },
      self_prompter: { isActive: () => false },
      isIdle: () => false,
      cleanKill() { throw new Error('unexpected cleanKill') }
    }
    initModes(agent)
    const originalNow = Date.now
    let now = originalNow()
    Date.now = () => now
    try {
      await bot.modes.update()
      miningState.activeDig = { startedAt: now, deadline: now + 60_000, serverConfirmed: false }
      now += 30_000
      await bot.modes.update()
      assert.equal(runActionCount, 0, 'protected digging time does not trigger unstuck')
      miningState.activeDig = null
      now += 30_000
      await bot.modes.update()
      assert.equal(runActionCount, 1, 'stationary time after digging is counted again')
    } finally {
      Date.now = originalNow
    }
  }
  console.log('mining integration tests passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
