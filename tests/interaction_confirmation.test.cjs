'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { withAcceleratedClock } = require('./accelerated_clock.cjs')

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
    setGoal(goal) { bot.combatGoals ??= []; bot.combatGoals.push(goal); this.goal = goal },
    async goto() {},
    stop() {}
  }
  bot.tool = { async equipForBlock() { bot.heldItem = { type: 1, enchants: [] } } }
  bot.pvp = {
    meleeAttackRate: { getTicks() { return 5 } },
    attack(entity) { this.target = entity; bot.pathfinder.setGoal({ pluginFollow: entity.id }); options.onAttack?.(entity, bot) },
    stop() { bot.pvpStopCount = (bot.pvpStopCount || 0) + 1 },
    forceStop() { this.target = null; bot.pathfinder.setGoal(null); bot.pvpStopCount = (bot.pvpStopCount || 0) + 1 }
  }
  bot.blockStates = new Map()
  if (options.blockStates) for (const [position, block] of options.blockStates) bot.blockStates.set(key(position), block)
  bot.blockAt = position => options.blockAt
    ? options.blockAt(position, bot)
    : bot.blockStates.get(key(position)) || makeBlock('stone', position)
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
  const navigation = await import(pathToFileURL(path.join(fixture, 'src/agent/library/navigation_policy.js')))
  const craftingSync = (await import(pathToFileURL(path.join(fixture, 'src/agent/library/crafting_sync.js')))).default

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
    assert.equal(await withAcceleratedClock(() => skills.useToolOnBlock(bot, 'bucket', water)), false, `${mode} pickup is not success`)
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
    assert.equal(await withAcceleratedClock(() => skills.placeBlock(bot, 'water', 5, 0, 0)), false, `${mode} destination update is not success`)
    assert.equal(bot.listenerCount('blockUpdate'), 0)
  }

  const liquidCollectBot = makeBot({
    items: [{ name: 'bucket', type: 12, count: 1 }],
    blocks: [water],
    blockStates: [[waterPos, water]],
    onActivateItem() {}
  })
  assert.equal(await withAcceleratedClock(() => skills.collectBlock(liquidCollectBot, 'water')), false, 'liquid collection propagates failed bucket outcome')
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
  assert.equal(await withAcceleratedClock(() => skills.useDoor(unresponsiveDoor, doorPos)), false, 'door without open update does not move forward')
  assert.equal(unresponsiveDoor.controlStates, undefined)
  assert.equal(unresponsiveDoor.listenerCount('blockUpdate'), 0)
  const unreachableDoor = makeBot({ navigationDistance: 10, block: makeBlock('oak_door', doorPos, { open: true }), blockStates: [[doorPos, makeBlock('oak_door', doorPos, { open: true })]] })
  unreachableDoor.navigation.block = unreachableDoor.blockAt(doorPos)
  assert.equal(await skills.useDoor(unreachableDoor, doorPos), false, 'door navigation failure prevents crossing')
  assert.equal(unreachableDoor.controlStates, undefined)

  for (const name of ['oak_door', 'oak_fence_gate', 'bamboo_fence_gate', 'warped_fence_gate']) {
    let state = makeBlock(name, doorPos, { open: false })
    let activations = 0
    const gate = makeBot({ block: state, blockStates: [[doorPos, state]],
      onActivateBlock(_block, bot) {
        activations++
        state = makeBlock(name, doorPos, { open: !state.getProperties().open })
        emitBlock(bot, doorPos, state)
      }
    })
    assert.equal(await skills.useDoor(gate, doorPos, { open: true }), true, name)
    assert.equal(gate.blockAt(doorPos).getProperties().open, true)
    assert.equal(gate.controlStates, undefined, 'state selection does not cross the opening')
    assert.equal(await skills.useDoor(gate, doorPos, { open: true }), true)
    assert.equal(activations, 1, 'an already matching state is not toggled')
    assert.equal(await skills.useDoor(gate, doorPos, { open: false }), true)
    assert.equal(gate.blockAt(doorPos).getProperties().open, false)
    assert.equal(gate.listenerCount('blockUpdate'), 0)
  }
  const unresponsiveGateBlock = makeBlock('oak_fence_gate', doorPos)
  const unresponsiveGate = makeBot({ block: unresponsiveGateBlock, blockStates: [[doorPos, unresponsiveGateBlock]] })
  assert.equal(await withAcceleratedClock(() => skills.useDoor(unresponsiveGate, doorPos, { open: true })), false, 'gate changes require a server block update')
  assert.equal(unresponsiveGate.controlStates, undefined)
  assert.equal(unresponsiveGate.listenerCount('blockUpdate'), 0)

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

  const combatTarget = { id: 19, name: 'zombie', position: makePosition(1, 0, 0) }
  const scaffoldPosition = makePosition(2, 0, 0)
  const scaffoldSupport = makeBlock('stone', makePosition(1, 0, 0))
  const combat = makeBot({
    entities: [combatTarget], items: [{ name: 'iron_sword', type: 1, attackDamage: 6 }, { name: 'dirt', type: 2, count: 4 }],
    blockStates: [[scaffoldPosition, makeBlock('air', scaffoldPosition, { type: 0 })], [scaffoldSupport.position, scaffoldSupport]],
    async onAttack(_entity, bot) {
      combat.attackEquipment ??= []
      combat.attackEquipment.push(bot.heldItem?.name ?? null)
      if (combat.attackEquipment.length !== 1) return
      await bot.equip({ name: 'dirt', type: 2 })
      await bot.placeBlock(scaffoldSupport, { x: 1, y: 0, z: 0 })
      for (let attempt = 0; attempt < 100 && bot.heldItem?.name !== 'iron_sword'; attempt++)
        await new Promise(resolve => setTimeout(resolve, 10))
      combat.attackEquipment.push(bot.heldItem?.name ?? null) // simulated next strike during the same fight
      bot.emit('entityDead', combatTarget)
    }
  })
  combat.registry.itemsByName.dirt = { id: 2 }
  const movementSettings = []
  combat.pathfinder.setMovements = movement => { movementSettings.push(movement); combat.movement = movement }
  const equipped = []
  const originalEquip = combat.equip
  combat.equip = async item => { equipped.push(item.name); return originalEquip.call(combat, item) }
  combat.placeBlock = async reference => {
    const old = combat.blockAt(scaffoldPosition)
    const placed = makeBlock('dirt', scaffoldPosition, { type: 2 })
    placed.stateId = 1
    combat.blockStates.set(key(scaffoldPosition), placed)
    setImmediate(() => combat.emit('blockUpdate', old, placed))
    return placed
  }
  const combatPolicy = { allowDig: false, scaffold: 'leave', scaffoldBlocks: ['dirt'], allowTowers: false }
  assert.equal(await navigation.runWithNavigationPolicy(combat, combatPolicy, () => skills.attackEntity(combat, combatTarget)), true)
  assert.equal(movementSettings[0].canDig, false, 'combat route cannot dig')
  assert.equal(movementSettings[0].canPlaceOn, true, 'combat route can use owned scaffold inventory')
  assert.equal(movementSettings[0].allow1by1towers, false, 'combat route cannot create tall one-block pillars')
  assert.equal(combat.pvp.movements, movementSettings[0], 'PVP pursuit uses the owned route policy too')
  assert.equal(combat.blockAt(scaffoldPosition).name, 'dirt', 'confirmed combat scaffold may remain')
  assert.deepEqual(equipped, ['iron_sword', 'dirt', 'iron_sword'], 'confirmed route scaffold restores the combat weapon')
  assert.deepEqual(combat.attackEquipment, ['iron_sword', 'iron_sword'], 'the next strike during the continuing fight uses the combat weapon')

  const defendingTarget = { id: 20, name: 'zombie', type: 'hostile', position: makePosition(1, 0, 0) }
  const defendingBlockPosition = makePosition(2, 0, 0)
  const defendingSupport = makeBlock('stone', makePosition(1, 0, 0))
  const defending = makeBot({
    entities: [defendingTarget],
    items: [{ name: 'iron_sword', type: 1, attackDamage: 6 }, { name: 'dirt', type: 2, count: 4 }],
    blockStates: [[defendingBlockPosition, makeBlock('air', defendingBlockPosition, { type: 0 })], [defendingSupport.position, defendingSupport]],
    async onAttack(_entity, bot) {
      await bot.equip({ name: 'dirt', type: 2 })
      await bot.placeBlock(defendingSupport, { x: 1, y: 0, z: 0 })
      for (let attempt = 0; attempt < 100 && bot.heldItem?.name !== 'iron_sword'; attempt++)
        await new Promise(resolve => setTimeout(resolve, 10))
      bot.followupStrikeWeapon = bot.heldItem?.name ?? null
      bot.emit('entityDead', defendingTarget)
      bot.navigation.entities = []
    }
  })
  defending.entity.position.distanceTo = () => 3
  defending.registry.itemsByName.dirt = { id: 2 }
  defending.placeBlock = async () => {
    const old = defending.blockAt(defendingBlockPosition)
    const placed = makeBlock('dirt', defendingBlockPosition, { type: 2 })
    placed.stateId = 1
    defending.blockStates.set(key(defendingBlockPosition), placed)
    setImmediate(() => defending.emit('blockUpdate', old, placed))
    return placed
  }
  assert.equal(await withAcceleratedClock(() => navigation.runWithNavigationPolicy(defending, combatPolicy, () => skills.defendSelf(defending))), true)
  assert.equal(defending.followupStrikeWeapon, 'iron_sword', 'defendSelf re-equips before the next strike while combat continues')

  // A bare-handed defender starts attacking immediately, even if an opponent
  // starts close or needs pursuit. Navigation belongs to the combat plugin.
  for (const distance of [1.5, 5]) {
    const opponents = [21, 22].map(id => ({ id, name: 'zombie', type: 'hostile', position: makePosition(0, 0, distance) }))
    const engaged = []
    const defender = makeBot({
      entities: [...opponents],
      onAttack(enemy, bot) {
        engaged.push(enemy.id)
        assert.equal(bot.heldItem, undefined, 'no weapon is required')
        bot.emit('entityDead', enemy)
        // Minecraft can retain a dying entity until its later removal packet.
      }
    })
    defender.entity.position.distanceTo = () => distance
    let positioningCalls = 0
    defender.pathfinder.goto = async () => { positioningCalls++; throw new Error('separate combat positioning') }
    assert.equal(await withAcceleratedClock(() => skills.defendSelf(defender)), true)
    assert.equal(positioningCalls, 0, 'defense must not wait for separate positioning before an attack')
    assert.deepEqual(engaged, opponents.map(enemy => enemy.id), 'finish each target before switching; no loot trip between targets')
    assert.equal(defender.pvpStopCount, 2)
    assert.equal(defender.listenerCount('entityDead'), 0)
    assert.equal(defender.listenerCount('entityGone'), 0)
  }

  for (const mode of ['gone', 'interrupt', 'attack-reject', 'disconnect']) {
    const enemy = { id: 23, name: 'zombie', type: 'hostile', position: makePosition(0, 0, 3) }
    const defender = makeBot({ entities: [enemy] })
    let stalePluginStop = false
    defender.on('entityGone', gone => {
      if (defender.pvp.target?.id === gone.id) stalePluginStop = true
    })
    defender.pvp.attack = async () => {
      defender.pvp.target = enemy
      if (mode === 'gone') { defender.emit('entityGone', enemy); defender.navigation.entities = [] }
      if (mode === 'interrupt') defender.interrupt_code = true
      if (mode === 'attack-reject') throw new Error('injected asynchronous attack rejection')
      if (mode === 'disconnect') defender.emit('end')
    }
    let stopped = false
    defender.pvp.stop = () => { throw new Error('graceful PVP stop can wait five seconds at a reached goal') }
    defender.pvp.forceStop = () => { stopped = true; defender.pvp.target = null }
    assert.equal(await skills.defendSelf(defender), false, `${mode} is not a confirmed defense`)
    assert.equal(stopped, true, 'combat goal is cleared before the skill returns')
    assert.equal(stalePluginStop, false, 'PVP cannot start a delayed stop after the owned target is lost')
    assert.equal(defender.listenerCount('entityDead'), 0)
    assert.equal(defender.listenerCount('entityGone'), 1, 'the unrelated plugin listener is preserved')
    assert.equal(defender.listenerCount('end'), 0)
    assert.equal(defender.output.includes('Successfully defended'), false)
  }

  const firstThreat = { id: 31, name: 'zombie', type: 'hostile', position: makePosition(3, 0, 0) }
  const secondThreat = { id: 32, name: 'zombie', type: 'hostile', position: makePosition(4, 0, 0) }
  const switches = []
  let firstStrikeAt
  const crowd = makeBot({ entities: [firstThreat, secondThreat], onAttack(enemy, bot) {
    switches.push(enemy.id)
    bot.emit('attackedTarget')
    setImmediate(() => assert.equal(crowd.pathfinder.goal?.pluginFollow, undefined, 'tactical movement replaces PVP pursuit after every target switch'))
    if (switches.length === 1) {
      firstStrikeAt = Date.now()
      firstThreat.position.x = 9 // engaged target leaves the admission radius
      secondThreat.position.x = 2
    } else if (enemy.id === secondThreat.id) {
      assert.ok(Date.now() - firstStrikeAt >= 250, 'switching does not reset the attack cooldown')
      bot.emit('entityDead', enemy)
    } else bot.emit('entityDead', enemy)
  } })
  crowd.entity.position.distanceTo = position => Math.abs(position.x)
  const crowdDeadline = setTimeout(() => { crowd.interrupt_code = true }, 4500)
  try {
    assert.equal(await withAcceleratedClock(() => skills.defendSelf(crowd, 8)), true)
    assert.deepEqual(switches, [31, 32, 31], 'switch to the nearer threat before the first one dies, then finish the engaged target beyond the admission radius')
    assert.ok(crowd.combatGoals.some(goal => goal?.goals?.length === 2), 'retreat keeps distance from both threats')
  } finally { clearTimeout(crowdDeadline) }
  assert.equal(crowd.pathfinder.goal, null)
  assert.equal(crowd.listenerCount('attackedTarget'), 0)

  const parentSlime = { id: 33, name: 'slime', type: 'hostile', position: makePosition(2, 0, 0) }
  const childSlime = { id: 34, name: 'slime', type: 'hostile', position: makePosition(2, 0, 0) }
  const splitTargets = []
  let childTimer
  const split = makeBot({ entities: [parentSlime], onAttack(enemy, bot) {
    splitTargets.push(enemy.id)
    bot.emit('entityDead', enemy)
    if (enemy.id === parentSlime.id) childTimer = setTimeout(() => bot.navigation.entities.push(childSlime), 200)
  } })
  try {
    assert.equal(await withAcceleratedClock(() => skills.defendSelf(split)), true)
    assert.deepEqual(splitTargets, [33, 34], 'defense observes delayed death-spawned enemies')
  } finally { clearTimeout(childTimer) }

  const killedDefender = makeBot({ entities: [target], onAttack(_enemy, bot) { bot.emit('death') } })
  killedDefender.navigation.entities[0] = { ...target, type: 'hostile' }
  assert.equal(await skills.defendSelf(killedDefender), false, 'death cannot become success after automatic respawn')
  assert.equal(killedDefender.listenerCount('death'), 0)

  const chestBlock = makeBlock('chest', makePosition(1, 0, 0))
  const makeChestTransfer = ({ direction, available, requested, moved = requested, serverUpdates = true }) => {
    const bot = makeBot({ items: direction === 'deposit' ? [{ name: 'oak_log', type: 1, count: available }] : [] })
    bot.navigation.block = chestBlock
    const slots = new Array(41).fill(null)
    if (direction === 'deposit') slots[27] = { name: 'oak_log', type: 1, count: available, metadata: 0 }
    else slots[0] = { name: 'oak_log', type: 1, count: available, metadata: 0 }
    let serverSlots = slots.map(slot => slot && { ...slot })
    const client = new EventEmitter()
    bot._client = client
    bot.registry = {}
    let stateId = 0
    client.write = name => {
      if (name !== 'client_command') return
      if (serverUpdates) serverSlots = slots.map(slot => slot && { ...slot })
      client.emit('packet', { windowId: 7, stateId: ++stateId, items: serverSlots.map(slot => slot ? ({ itemId: slot.type, itemCount: slot.count, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] }) : ({ itemCount: 0, components: [], removeComponents: [] })), carriedItem: { itemCount: 0, components: [], removeComponents: [] } }, { name: 'window_items' })
      client.emit('packet', {}, { name: 'statistics' })
      client.emit('statistics', {})
    }
    const window = {
      id: 7, type: 'minecraft:chest', slots, inventoryStart: 27, inventoryEnd: 41, selectedItem: null,
      containerItems() { return slots.slice(0, 27).filter(Boolean) },
      async deposit(type, _metadata, count) {
        const amount = Math.min(moved, count)
        slots[27].count -= amount
        if (!slots[27].count) slots[27] = null
        if (!slots[0]) slots[0] = { name: 'oak_log', type, count: 0, metadata: 0 }
        slots[0].count += amount
      },
      async withdraw(type, _metadata, count) {
        const amount = Math.min(moved, count)
        slots[0].count -= amount
        if (!slots[0].count) slots[0] = null
        if (!slots[27]) slots[27] = { name: 'oak_log', type, count: 0, metadata: 0 }
        slots[27].count += amount
      },
      async close() { window.closed = true; bot.currentWindow = null }
    }
    bot.openContainer = async () => { bot.currentWindow = window; return window }
    return { bot, window, requested, serverSlots }
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

  const optimisticOnlyDeposit = makeChestTransfer({ direction: 'deposit', available: 4, requested: 4, moved: 4, serverUpdates: false })
  const optimisticOnlyResult = await runChestAction(optimisticOnlyDeposit.bot, () => skills.putInChest(optimisticOnlyDeposit.bot, 'oak_log', 4))
  assert.equal(optimisticOnlyResult.result, false, 'optimistic Mineflayer slots without server state remain unconfirmed')
  assert.equal(optimisticOnlyResult.changes.length, 0, 'a client mirror is never recorded as server confirmation')
  assert.equal(optimisticOnlyResult.uncertain[0].confirmedQuantity, null, 'missing server confirmation stays unknown rather than zero')
  assert.equal(optimisticOnlyDeposit.bot.inventoryUnconfirmed, true)

  const confirmedWithdraw = makeChestTransfer({ direction: 'withdraw', available: 5, requested: 3, moved: 3 })
  const confirmedWithdrawResult = await runChestAction(confirmedWithdraw.bot, () => skills.takeFromChest(confirmedWithdraw.bot, 'oak_log', 3))
  assert.equal(confirmedWithdrawResult.result, true)
  assert.deepEqual(confirmedWithdrawResult.changes.map(change => change.quantity), [3])
  assert.equal(confirmedWithdraw.window.closed, true)

  const originalCraftRun = craftingSync.run
  const craftCalls = []
  craftingSync.run = async (_bot, callback) => callback(async (recipe, count, table) => {
    craftCalls.push({ recipe, count, table })
    return 1
  })
  const tableRecipe = {
    result: { id: 825, count: 1 },
    inShape: [[{ id: 35 }, { id: 35 }, { id: 35 }], [null, { id: 848 }, null], [null, { id: 848 }, null]],
    delta: [{ id: 35, count: -3 }, { id: 848, count: -2 }, { id: 825, count: 1 }],
    requiredItems: { cobblestone: 3, stick: 2 },
    requiresTable: true
  }
  const inventoryRecipe = {
    result: { id: 36, count: 4 },
    inShape: [[{ id: 1 }]],
    delta: [{ id: 1, count: -1 }, { id: 36, count: 4 }],
    requiredItems: { oak_log: 1 }
  }
  const craftBot = ({ table = null, includeTableItem = false, interaction = null, disappearOnBlockRead = 0 } = {}) => {
    const items = [
      { name: 'cobblestone', type: 35, count: 3 },
      { name: 'stick', type: 848, count: 2 },
      { name: 'oak_log', type: 1, count: 1 },
      ...(includeTableItem ? [{ name: 'crafting_table', type: 300, count: 1 }] : [])
    ]
    const inventory = {
      items: () => items,
      findInventoryItem: name => items.find(item => item.name === name) || null
    }
    const bot = {
      output: '',
      navigation: { block: table, interaction, inventory: { cobblestone: 3, stick: 2, oak_log: 1, crafting_table: includeTableItem ? 1 : 0 } },
      inventory,
      game: { gameMode: 'survival' },
      entity: { position: makePosition(0, 0, 0) },
      modes: { isOn: () => false },
      recipesFor(itemId, _metadata, _count, grid) {
        if (itemId === 825) return grid ? [tableRecipe] : []
        if (itemId === 36) return [inventoryRecipe]
        return []
      },
      blockAt(position) {
        bot.tableBlockReads = (bot.tableBlockReads || 0) + 1
        if (table && position.x === table.position.x && position.y === table.position.y && position.z === table.position.z) {
          return disappearOnBlockRead && bot.tableBlockReads >= disappearOnBlockRead
            ? makeBlock('stone', position)
            : table
        }
        return makeBlock('air', position, { type: 0 })
      },
      pathfinder: {
        async getPathTo() { return { status: 'success' } },
        setMovements() {},
        async goto() {}
      },
      async equip() {},
      async lookAt() {},
      armorManager: { async equipAll() {} }
    }
    bot.entity.position.distanceTo = () => 0
    return bot
  }
  try {
    const noTableBot = craftBot({ includeTableItem: true })
    const noTableResult = await skills.craftRecipe(noTableBot, 'stone_pickaxe')
    assert.equal(noTableResult, false, 'a failed table placement cannot make a table-only recipe succeed')
    assert.equal(craftCalls.length, 0, 'do not pass a 3x3 recipe to the 2x2 inventory grid')
    assert.equal(noTableBot.navigation.inventory.cobblestone, 3, 'the rejected setup leaves required material untouched')

    const inventoryResult = await skills.craftRecipe(craftBot(), 'oak_planks')
    assert.equal(inventoryResult, true, 'an inventory-grid recipe remains available without a table')
    assert.equal(craftCalls.at(-1).table, null, 'the inventory-grid recipe retains its null-table path')

    const tableBlock = makeBlock('crafting_table', makePosition(1, 0, 0))
    const inventoryBot = craftBot()
    const inspectionsBeforeInventoryRecipe = inventoryBot.navigation.inspectCount || 0
    await skills.craftRecipe(inventoryBot, 'oak_planks')
    assert.equal(inventoryBot.navigation.inspectCount || 0, inspectionsBeforeInventoryRecipe,
      '2x2 inventory recipes do not invoke table interaction checks')

    const tableResult = await skills.craftRecipe(craftBot({ table: tableBlock }), 'stone_pickaxe')
    assert.equal(tableResult, true, 'a table recipe still reaches crafting with the observed table')
    assert.equal(craftCalls.at(-1).table, tableBlock, 'the table recipe retains its 3x3-table path')
    const craftCallsBeforeRejectedTable = craftCalls.length

    const blockedTable = craftBot({ table: tableBlock, interaction: { status: 'blocked', reason: 'no reachable surface aim point' } })
    assert.equal(await skills.craftRecipe(blockedTable, 'stone_pickaxe'), false,
      'a nearby but occluded crafting table is rejected before craft synchronization')
    assert.equal(craftCalls.length, craftCallsBeforeRejectedTable,
      'blocked interaction does not invoke the craft callback')
    assert.match(blockedTable.output, /interaction approach blocked/)

    const unknownTable = craftBot({ table: tableBlock, interaction: { status: 'unknown', reason: 'ray data unavailable' } })
    assert.equal(await skills.craftRecipe(unknownTable, 'stone_pickaxe'), false,
      'an unknown table interaction is rejected before craft synchronization')
    assert.equal(craftCalls.length, craftCallsBeforeRejectedTable,
      'an unknown interaction does not invoke the craft callback')

    const changedTable = craftBot({ table: tableBlock, disappearOnBlockRead: 2 })
    assert.equal(await skills.craftRecipe(changedTable, 'stone_pickaxe'), false,
      'a crafting table replaced after the ready observation is rejected')
    assert.equal(craftCalls.length, craftCallsBeforeRejectedTable,
      'a changed target does not invoke the craft callback')

    const cancelledTable = craftBot({ table: tableBlock })
    cancelledTable.interrupt_code = true
    await assert.rejects(skills.craftRecipe(cancelledTable, 'stone_pickaxe'), /Action cancelled before target interaction/)
    assert.equal(craftCalls.length, craftCallsBeforeRejectedTable,
      'cancellation does not invoke the craft callback')
  } finally {
    craftingSync.run = originalCraftRun
  }

  const unknownBlockMutations = []
  const unknownBlockBot = makeBot({
    blockAt: () => null,
  })
  unknownBlockBot.game.gameMode = 'creative'
  unknownBlockBot.creative = { async setInventorySlot() { unknownBlockMutations.push('creative-inventory') } }
  unknownBlockBot.dig = async () => unknownBlockMutations.push('dig')
  unknownBlockBot.placeBlock = async () => unknownBlockMutations.push('place')
  const unknownBlockOperation = ownership.createOperationContext(
    { id: 'unknown-block-observation', controller: new AbortController() },
    { bot: unknownBlockBot }, { intentEpoch: 1 }, 'unknown-block-task')
  await ownership.runOwnedOperation(unknownBlockOperation, async () => {
    assert.equal(await ownership.trackSkill('breakBlockAt', skills.breakBlockAt)(unknownBlockBot, 2, 64, 2), false,
      'unloaded break target is unknown, not a block to dig')
    assert.equal(await ownership.trackSkill('placeBlock', skills.placeBlock)(unknownBlockBot, 'oak_planks', 2, 64, 2), false,
      'unloaded placement target is unknown, not air')
    assert.equal(await ownership.trackSkill('digDown', skills.digDown)(unknownBlockBot, 2), false,
      'unloaded dig target cannot be reported as reaching the world bottom')
  })
  assert.deepEqual(unknownBlockMutations, [], 'null observations reject before the block mutation methods')
  assert.equal(ownership.operationResult(unknownBlockOperation).unconfirmedChanges.length, 3,
    'each rejected target records unknown evidence on its owning SDK call')

  console.log('interaction confirmation tests passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
