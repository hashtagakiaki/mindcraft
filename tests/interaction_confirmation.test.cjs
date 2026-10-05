'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const key = position => `${position.x},${position.y},${position.z}`

function makePosition(x, y, z, distance = 0) {
  return {
    x, y, z,
    clone() { return makePosition(x, y, z, distance) },
    floored() { return makePosition(Math.floor(x), Math.floor(y), Math.floor(z), distance) },
    offset(dx, dy, dz) { return makePosition(x + dx, y + dy, z + dz, distance) },
    plus(vector) { return this.offset(vector.x, vector.y, vector.z) },
    distanceTo() { return distance },
    equals(other) { return this.x === other.x && this.y === other.y && this.z === other.z },
    toString() { return `(${x}, ${y}, ${z})` }
  }
}

function makeBlock(name, position, { open = false, metadata = 0, type = 1 } = {}) {
  return {
    name, position, metadata, type,
    getProperties() { return { open } },
    canHarvest() { return true },
    drops: []
  }
}

function makeBot(options = {}) {
  const bot = new EventEmitter()
  const inventory = new EventEmitter()
  let items = (options.items || []).map(item => ({ ...item }))
  inventory.items = () => items
  inventory.slots = items
  inventory.findInventoryItem = name => items.find(item => item.name === name) || null
  const replaceItem = (name, count) => {
    const current = items.find(item => item.name === name)
    if (current) current.count = count
    else if (count > 0) items.push({ name, type: name, count })
    items = items.filter(item => item.count > 0)
    inventory.slots = items
    inventory.emit('updateSlot', 0)
  }
  bot.output = ''
  bot.inventory = inventory
  bot.registry = { itemsByName: { water_bucket: { id: 10 }, lava_bucket: { id: 11 }, bucket: { id: 12 } } }
  bot.game = { gameMode: 'survival' }
  bot.navigation = { block: options.block || null, blocks: options.blocks || [], entities: options.entities || [] }
  bot.entity = {
    id: 1,
    position: makePosition(0, 0, 0, options.navigationDistance ?? 0),
    height: 1
  }
  bot.modes = { isOn: () => false, pause() {}, unpause() {} }
  bot.pathfinder = {
    async getPathTo() { return { status: 'success' } },
    setMovements() {},
    async goto() {},
    stop() {}
  }
  bot.tool = { async equipForBlock() { bot.heldItem = { type: 1, enchants: [] } } }
  bot.pvp = {
    attack(entity) { options.onAttack?.(entity, bot) },
    stop() { bot.pvpStopCount = (bot.pvpStopCount || 0) + 1 }
  }
  bot.blockStates = new Map()
  if (options.blockStates) for (const [position, block] of options.blockStates) bot.blockStates.set(key(position), block)
  bot.blockAt = position => bot.blockStates.get(key(position)) || makeBlock('stone', position)
  bot.blockAtCursor = () => null
  bot.nearestEntity = () => null
  bot.chat = () => {}
  bot.lookAt = async () => {}
  bot.equip = async item => { bot.heldItem = item }
  bot.unequip = async () => { bot.heldItem = null }
  bot.activateItem = async () => options.onActivateItem?.(bot, replaceItem)
  bot.activateBlock = async block => options.onActivateBlock?.(block, bot)
  bot.setControlState = (state, enabled) => {
    bot.controlStates ??= []
    bot.controlStates.push([state, enabled])
    if (enabled && options.interruptOnForward) bot.interrupt_code = true
  }
  bot.attack = async entity => { bot.attacked = entity }
  bot.collectBlock = { async collect() {} }
  return bot
}

function emitBlock(bot, position, block) {
  const oldBlock = bot.blockAt(position)
  bot.blockStates.set(key(position), block)
  bot.emit('blockUpdate', oldBlock, block)
}

async function main() {
  const fixture = path.resolve(process.argv[2])
  const skills = await import(pathToFileURL(path.join(fixture, 'src/agent/library/skills.js')))
  const ownership = await import(pathToFileURL(path.join(fixture, 'src/agent/library/operation_context.js')))

  const waterPos = makePosition(1, 0, 0)
  const water = makeBlock('water', waterPos)
  const pickup = makeBot({
    items: [{ name: 'bucket', type: 12, count: 1 }],
    blockStates: [[waterPos, water]],
    onActivateItem(bot, replaceItem) {
      replaceItem('bucket', 0)
      replaceItem('water_bucket', 1)
    }
  })
  assert.equal(await skills.useToolOnBlock(pickup, 'bucket', water), true, 'pickup succeeds when inventory confirms water bucket; source may remain')
  assert.equal(pickup.listenerCount('blockUpdate'), 0)

  for (const mode of ['absent', 'wrong-inventory', 'interrupt', 'reject']) {
    const bot = makeBot({
      items: [{ name: 'bucket', type: 12, count: 1 }],
      blockStates: [[waterPos, water]],
      onActivateItem(target, replaceItem) {
        if (mode === 'wrong-inventory') {
          replaceItem('bucket', 0)
          replaceItem('lava_bucket', 1)
        } else if (mode === 'interrupt') {
          target.interrupt_code = true
        } else if (mode === 'reject') {
          throw new Error('injected activation rejection')
        }
      }
    })
    assert.equal(await skills.useToolOnBlock(bot, 'bucket', water), false, `${mode} pickup is not success`)
    assert.equal(bot.listenerCount('blockUpdate'), 0)
  }

  const destination = makePosition(5, 0, 0)
  const support = makePosition(5, -1, 0)
  const supportBlock = makeBlock('stone', support)
  const placeBot = mode => makeBot({
    items: [{ name: 'water_bucket', type: 10, count: 1 }],
    blockStates: [[destination, makeBlock('air', destination, { type: 0 })], [support, supportBlock]],
    onActivateItem(bot, replaceItem) {
      replaceItem('water_bucket', 0)
      replaceItem('bucket', 1)
      if (mode === 'correct') emitBlock(bot, destination, makeBlock('water', destination))
      if (mode === 'wrong') emitBlock(bot, destination, makeBlock('lava', destination))
    }
  })
  assert.equal(await skills.placeBlock(placeBot('correct'), 'water', 5, 0, 0), true, 'bucket placeBlock confirms destination fluid')
  for (const mode of ['wrong', 'absent']) {
    const bot = placeBot(mode)
    assert.equal(await skills.placeBlock(bot, 'water', 5, 0, 0), false, `${mode} destination update is not success`)
    assert.equal(bot.listenerCount('blockUpdate'), 0)
  }

  const liquidCollectBot = makeBot({
    items: [{ name: 'bucket', type: 12, count: 1 }],
    blocks: [water],
    blockStates: [[waterPos, water]],
    onActivateItem() {}
  })
  assert.equal(await skills.collectBlock(liquidCollectBot, 'water'), false, 'liquid collection propagates failed bucket outcome')
  assert.equal(liquidCollectBot.listenerCount('blockUpdate'), 0)

  const missingDoorBot = makeBot()
  assert.equal(await skills.useDoor(missingDoorBot), false, 'missing door is a boolean failure')
  const doorPos = makePosition(2, 0, 0)
  let doorBlock = makeBlock('oak_door', doorPos, { open: false })
  const closedDoor = makeBot({
    block: doorBlock,
    blockStates: [[doorPos, doorBlock]],
    onActivateBlock(oldBlock, bot) {
      if (!oldBlock.getProperties().open) {
        doorBlock = makeBlock('oak_door', doorPos, { open: true })
        emitBlock(bot, doorPos, doorBlock)
      } else {
        doorBlock = makeBlock('oak_door', doorPos, { open: false })
        emitBlock(bot, doorPos, doorBlock)
      }
    }
  })
  closedDoor.navigation.block = doorBlock
  assert.equal(await skills.useDoor(closedDoor, doorPos), true, 'door opens before traversal')
  assert.deepEqual(closedDoor.controlStates, [['forward', true], ['forward', false]])
  assert.equal(closedDoor.listenerCount('blockUpdate'), 0)
  const unresponsiveDoor = makeBot({ block: makeBlock('oak_door', doorPos, { open: false }), blockStates: [[doorPos, makeBlock('oak_door', doorPos, { open: false })]] })
  unresponsiveDoor.navigation.block = unresponsiveDoor.blockAt(doorPos)
  assert.equal(await skills.useDoor(unresponsiveDoor, doorPos), false, 'door without open update does not move forward')
  assert.equal(unresponsiveDoor.controlStates, undefined)
  assert.equal(unresponsiveDoor.listenerCount('blockUpdate'), 0)
  const unreachableDoor = makeBot({ navigationDistance: 10, block: makeBlock('oak_door', doorPos, { open: true }), blockStates: [[doorPos, makeBlock('oak_door', doorPos, { open: true })]] })
  unreachableDoor.navigation.block = unreachableDoor.blockAt(doorPos)
  assert.equal(await skills.useDoor(unreachableDoor, doorPos), false, 'door navigation failure prevents crossing')
  assert.equal(unreachableDoor.controlStates, undefined)

  const target = { id: 17, name: 'zombie', position: makePosition(1, 0, 0) }
  for (const mode of ['matching-dead', 'other-dead-and-gone', 'gone', 'interrupt', 'attack-reject']) {
    const bot = makeBot({
      entities: [target],
      onAttack(_entity, attacker) {
        if (mode === 'matching-dead') attacker.emit('entityDead', target)
        if (mode === 'other-dead-and-gone') {
          attacker.emit('entityDead', { id: 18 })
          attacker.navigation.entities = []
        }
        if (mode === 'gone') attacker.emit('entityGone', target)
        if (mode === 'interrupt') attacker.interrupt_code = true
        if (mode === 'attack-reject') throw new Error('injected attack rejection')
      }
    })
    assert.equal(await skills.attackEntity(bot, target, true), mode === 'matching-dead', `${mode} kill result`)
    assert.equal(bot.pvpStopCount, 1)
    assert.equal(bot.listenerCount('entityDead'), 0)
    assert.equal(bot.listenerCount('entityGone'), 0)
    assert.equal(Boolean(bot.output.includes('Successfully killed')), mode === 'matching-dead')
  }
  const failedNonlethal = makeBot({ navigationDistance: 10 })
  assert.equal(await skills.attackEntity(failedNonlethal, target, false), false, 'nonlethal attack propagates navigation failure')
  assert.equal(failedNonlethal.attacked, undefined)

  const chestBlock = makeBlock('chest', makePosition(1, 0, 0))
  const makeChestTransfer = ({ direction, available, requested, moved = requested }) => {
    const bot = makeBot({ items: direction === 'deposit' ? [{ name: 'oak_log', type: 1, count: available }] : [] })
    bot.navigation.block = chestBlock
    const slots = new Array(41).fill(null)
    if (direction === 'deposit') slots[27] = { name: 'oak_log', type: 1, count: available }
    else slots[0] = { name: 'oak_log', type: 1, count: available }
    const window = {
      slots, inventoryStart: 27, inventoryEnd: 41,
      containerItems() { return slots.slice(0, 27).filter(Boolean) },
      async deposit(type, _metadata, count) {
        const amount = Math.min(moved, count)
        slots[27].count -= amount
        if (!slots[0]) slots[0] = { name: 'oak_log', type, count: 0 }
        slots[0].count += amount
      },
      async withdraw(type, _metadata, count) {
        const amount = Math.min(moved, count)
        slots[0].count -= amount
        if (!slots[27]) slots[27] = { name: 'oak_log', type, count: 0 }
        slots[27].count += amount
      },
      async close() { window.closed = true }
    }
    bot.openContainer = async () => window
    return { bot, window, requested }
  }
  const runChestAction = async (bot, action) => {
    const manager = { intentEpoch: 4 }
    const owner = ownership.createOperationContext({ id: 8, controller: { signal: new AbortController().signal } }, { bot }, manager, 'chest-task')
    const result = await ownership.runOwnedOperation(owner, () => ownership.trackSkill('skills.chest', () => action())())
    return { result, changes: ownership.operationResult(owner).confirmedChanges, uncertain: ownership.operationResult(owner).unconfirmedChanges }
  }
  const partialDeposit = makeChestTransfer({ direction: 'deposit', available: 4, requested: 4, moved: 2 })
  const partialDepositResult = await runChestAction(partialDeposit.bot, () => skills.putInChest(partialDeposit.bot, 'oak_log', 4))
  assert.equal(partialDepositResult.result, false, 'partial chest deposit is not full success')
  assert.deepEqual(partialDepositResult.changes.map(change => [change.quantity, change.unit]), [[2, 'item']])
  assert.equal(partialDepositResult.uncertain[0].requestedQuantity, 4)
  assert.equal(partialDeposit.bot.inventoryUnconfirmed, true, 'ambiguous chest remainder preserves the existing action gate')
  assert.equal(partialDeposit.window.closed, true)

  const confirmedWithdraw = makeChestTransfer({ direction: 'withdraw', available: 5, requested: 3, moved: 3 })
  const confirmedWithdrawResult = await runChestAction(confirmedWithdraw.bot, () => skills.takeFromChest(confirmedWithdraw.bot, 'oak_log', 3))
  assert.equal(confirmedWithdrawResult.result, true)
  assert.deepEqual(confirmedWithdrawResult.changes.map(change => change.quantity), [3])
  assert.equal(confirmedWithdraw.window.closed, true)

  console.log('interaction confirmation tests passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
