'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const { Vec3 } = require('../../mindcraft-eval/runtime/upstream/node_modules/vec3')
const injectDigging = require('../../mindcraft-eval/runtime/upstream/node_modules/mineflayer/lib/plugins/digging')
const upstream = '../../mindcraft-eval/runtime/upstream/node_modules'
const registryLoader = require(`${upstream}/prismarine-registry`)
const BlockProvider = require(`${upstream}/prismarine-block`)
let mining

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const TEST_WATCHDOG_MS = 10_000

function fixture({ digMs = 40, groundTimeoutMs = 40, lookTimeoutMs = 20, confirmationGraceMs = 30 } = {}) {
  const bot = new EventEmitter()
  const position = new Vec3(1, 64, 0)
  let currentBlock
  const block = {
    name: 'stone', type: 1, position, material: 'mineable/pickaxe', hardness: 1.5,
    diggable: true, harvestTools: { 1: true }, shapes: [[0, 0, 0, 1, 1, 1]],
    canHarvest: () => true, digTime: () => digMs
  }
  bot.entity = { position: new Vec3(0, 64, 0), eyeHeight: 1.62, onGround: true, isInWater: false, effects: {} }
  bot.game = { gameMode: 'survival' }
  bot.registry = { items: [], itemsByName: {} }
  bot.inventory = { slots: [] }
  bot.heldItem = null
  bot.getEquipmentDestSlot = () => 5
  currentBlock = block
  bot.blockAt = () => currentBlock
  bot.canDigBlock = () => true
  bot.canSeeBlock = () => true
  bot.lookAt = async () => {}
  bot.swingArm = () => {}
  bot._client = new EventEmitter()
  bot._client.writes = []
  bot._client.write = (name, packet) => bot._client.writes.push({ name, ...packet })
  bot._updateBlockState = (point, stateId) => {
    const next = { type: stateId }
    bot.emit(`blockUpdate:${point}`, block, next)
    bot.emit('blockUpdate', block, next)
  }
  bot.pathfinder = {
    goal: null,
    setGoal(goal) { this.goal = goal; bot.emit('goal_updated', goal, false) },
    stop() { bot.emit('path_stop') }
  }
  injectDigging(bot)
  const state = mining.installMiningSync(bot, { groundTimeoutMs, lookTimeoutMs, confirmationGraceMs })
  return { bot, block, state, setCurrentBlock: value => { currentBlock = value } }
}

function serverAir(bot, block) {
  const air = { type: 0, name: 'air', position: block.position }
  bot.emit('blockUpdate', block, air)
  bot.emit(`blockUpdate:${block.position}`, block, air)
}

async function rejects(promise, expression) {
  await assert.rejects(promise, expression)
}

async function main() {
  const helper = process.argv[2] || path.resolve(__dirname, '../src/agent/library/mining_sync.js')
  mining = await import(require('node:url').pathToFileURL(helper))

  // Correct only the returned block instance; harvest rules still govern eligibility.
  const registry = registryLoader('1.21.1')
  const Block = BlockProvider(registry)
  const ironInfo = registry.blocksByName.iron_ore
  const ironBlock = Block.fromStateId(ironInfo.defaultState, 0)
  ironBlock.position = new Vec3(4, 64, 0)
  const ironBot = new EventEmitter()
  let currentBlock = ironBlock
  ironBot.registry = registry
  ironBot.blockAt = () => currentBlock
  const stonePickaxeId = registry.itemsByName.stone_pickaxe.id
  ironBot.digTime = block => block.digTime(stonePickaxeId, false, false, false, [], {})
  ironBot.pathfinder = { bestHarvestTool: block => block.digTime(stonePickaxeId, false, false, false, [], {}) }
  ironBot.tool = {
    getDigTime: block => block.digTime(stonePickaxeId, false, false, false, [], {}),
    equipForBlock: block => block.material
  }
  const ironState = mining.installMiningSync(ironBot)
  assert.equal(mining.installMiningSync(ironBot), ironState)
  assert.equal(ironBot.blockAt(ironBlock.position), ironBlock)
  assert.equal(ironBlock.material, 'mineable/pickaxe')
  assert.equal(ironBlock.digTime(registry.itemsByName.stone_pickaxe.id, false, false, false, [], {}), 1150)
  assert.equal(ironBlock.canHarvest(registry.itemsByName.stone_pickaxe.id), true)
  assert.equal(Boolean(ironBlock.canHarvest(registry.itemsByName.wooden_pickaxe.id)), false)
  assert.equal(ironBot.digTime(ironBlock), 1150)
  assert.equal(ironBot.pathfinder.bestHarvestTool(ironBlock), 1150)
  assert.equal(ironBot.tool.getDigTime(ironBlock), 1150)
  assert.equal(ironBot.tool.equipForBlock(ironBlock), 'mineable/pickaxe')
  const deepslateInfo = registry.blocksByName.deepslate_iron_ore
  const deepslate = Block.fromStateId(deepslateInfo.defaultState, 0)
  deepslate.position = new Vec3(5, 64, 0)
  currentBlock = deepslate
  assert.equal(ironBot.blockAt(deepslate.position).material, 'mineable/pickaxe')
  assert.equal(deepslate.digTime(registry.itemsByName.stone_pickaxe.id, false, false, false, [], {}), 1700)
  assert.equal(deepslate.digTime(registry.itemsByName.iron_pickaxe.id, false, false, false, [], {}), 1150)
  assert.equal(deepslate.digTime(registry.itemsByName.diamond_pickaxe.id, false, false, false, [], {}), 850)
  assert.equal(registry.blocksByName.iron_ore.material, 'incorrect_for_wooden_tool')
  const obsidianInfo = registry.blocksByName.obsidian
  const obsidian = Block.fromStateId(obsidianInfo.defaultState, 0)
  obsidian.position = new Vec3(6, 64, 0)
  currentBlock = obsidian
  assert.equal(ironBot.blockAt(obsidian.position).material, 'mineable/pickaxe')
  assert.equal(obsidian.digTime(registry.itemsByName.diamond_pickaxe.id, false, false, false, [], {}), 9400)
  const nonPickaxe = Block.fromStateId(registry.blocksByName.dirt.defaultState, 0)
  nonPickaxe.position = new Vec3(7, 64, 0)
  currentBlock = nonPickaxe
  assert.notEqual(ironBot.blockAt(nonPickaxe.position).material, 'mineable/pickaxe')
  // Local inferred air stays hidden, while an authoritative target update resolves.
  {
    const { bot, block } = fixture({ digMs: 15 })
    const digging = bot.dig(block, 'ignore')
    await sleep(0)
    bot._updateBlockState(block.position, 0)
    assert.equal(mining.isMiningProtected(bot), true)
    await sleep(25)
    assert.equal(mining.getMiningState(bot).inferredAir, true)
    assert.equal(bot.targetDigBlock, null)
    assert.equal(bot.listenerCount(`blockUpdate:${block.position}`), 2)
    serverAir(bot, block)
    await digging
    assert.equal(mining.getMiningState(bot), null)
    assert.equal(bot.listenerCount(`blockUpdate:${block.position}`), 0)
  }
  // Server air arriving before the client timer cancels that timer and is sufficient.
  {
    const { bot, block } = fixture({ digMs: 25 })
    const digging = bot.dig(block, 'ignore')
    await sleep(0)
    serverAir(bot, block)
    await digging
    await sleep(35)
    assert.deepEqual(bot._client.writes.map(packet => packet.status), [0])
    assert.equal(bot.listenerCount(`blockUpdate:${block.position}`), 0)
  }
  // Mineflayer emits global blockUpdate before coordinate blockUpdate; pathfinder's global
  // listener may stop digging in between, after the authoritative air is already known.
  {
    const { bot, block } = fixture({ digMs: 500 })
    const globalListenersBefore = bot.listenerCount('blockUpdate')
    const stopOnGlobalAir = (oldBlock, newBlock) => {
      if (oldBlock?.position?.equals?.(block.position) && newBlock?.type === 0) bot.stopDigging()
    }
    bot.on('blockUpdate', stopOnGlobalAir)
    const digging = bot.dig(block, 'ignore')
    await sleep(0)
    serverAir(bot, block)
    await digging
    assert.deepEqual(bot._client.writes.map(packet => packet.status), [0])
    assert.equal(bot.listenerCount(`blockUpdate:${block.position}`), 0)
    assert.equal(bot.listenerCount('blockUpdate'), globalListenersBefore + 1)
    bot.removeListener('blockUpdate', stopOnGlobalAir)
  }
  // No server confirmation rejects at a finite deadline and cleans up the dependency listener.
  {
    const { bot, block } = fixture({ digMs: 12, confirmationGraceMs: 20 })
    await rejects(bot.dig(block, 'ignore'), /Server did not confirm/)
    assert.equal(bot.listenerCount(`blockUpdate:${block.position}`), 0)
    assert.equal(bot.targetDigBlock, null)
  }
  // A normal long dig stays protected beyond the historical 20-second unstuck threshold.
  {
    const { bot, block } = fixture({ digMs: 30_000, confirmationGraceMs: 2_000 })
    const digging = bot.dig(block, 'ignore')
    await sleep(0)
    assert.equal(mining.isMiningProtected(bot), true)
    const state = mining.getMiningState(bot)
    assert.equal(state.expectedDigMs, 30_000)
    assert.equal(mining.isMiningProtected(bot, state.startedAt + 25_000), true)
    assert.equal(mining.isMiningProtected(bot, state.deadline), false)
    serverAir(bot, block)
    await digging
    assert.equal(mining.isMiningProtected(bot), false)
  }
  // Finish has nulled target/face, so external stop must restore them before delegating.
  {
    const { bot, block } = fixture({ digMs: 10, confirmationGraceMs: 500 })
    const digging = bot.dig(block, 'ignore')
    await sleep(18)
    assert.equal(bot.targetDigBlock, null)
    assert.equal(bot.listenerCount(`blockUpdate:${block.position}`), 2)
    bot.stopDigging()
    await rejects(digging, /Digging aborted/)
    assert.equal(bot.listenerCount(`blockUpdate:${block.position}`), 0)
    assert.deepEqual(bot._client.writes.map(packet => packet.status), [0, 2, 1])
  }
  // Immediate stop on a grounded bot is observed before the dig packet is sent.
  {
    const { bot, block } = fixture()
    const digging = bot.dig(block, 'ignore')
    bot.stopDigging()
    await rejects(digging, /Digging aborted/)
    assert.deepEqual(bot._client.writes.map(packet => packet.status), [0, 1])
    assert.equal(bot.listenerCount(`blockUpdate:${block.position}`), 0)
  }

  // Stop/end while the dependency awaits lookAt cannot emit a late start packet.
  {
    const { bot, block } = fixture({ lookTimeoutMs: 30 })
    let finishLook
    bot.lookAt = () => new Promise(resolve => { finishLook = resolve })
    const digging = bot.dig(block, true)
    await sleep(0)
    bot.stopDigging()
    await rejects(digging, /turning to the block/)
    finishLook()
    await sleep(0)
    assert.deepEqual(bot._client.writes, [])
    assert.equal(bot.listenerCount(`blockUpdate:${block.position}`), 0)
  }
  // Server air before the dependency has sent start must cancel its deferred lookAt;
  // otherwise its completion listener is installed too late and the dig hangs.
  {
    const { bot, block } = fixture({ lookTimeoutMs: 30 })
    let finishLook
    bot.lookAt = () => new Promise(resolve => { finishLook = resolve })
    const digging = bot.dig(block, true)
    await sleep(0)
    serverAir(bot, block)
    finishLook()
    await rejects(digging, /Target block changed before dig start/)
    assert.deepEqual(bot._client.writes, [])
    assert.equal(bot.listenerCount(`blockUpdate:${block.position}`), 0)
    assert.equal(bot.listenerCount('blockUpdate'), 0)
  }
  {
    const { bot, block } = fixture({ lookTimeoutMs: 10 })
    bot.lookAt = () => new Promise(() => {})
    await rejects(bot.dig(block, true), /Timed out turning to the block/)
    assert.deepEqual(bot._client.writes, [])
    assert.equal(bot.listenerCount(`blockUpdate:${block.position}`), 0)
  }
  // Death and end abort both before and after the dependency's local finish callback.
  for (const event of ['death', 'end']) {
    for (const afterFinish of [false, true]) {
      const { bot, block } = fixture({ digMs: 12, confirmationGraceMs: 100 })
      const digging = bot.dig(block, 'ignore')
      if (afterFinish) await sleep(18)
      else await sleep(0)
      bot.emit(event)
      await rejects(digging, /Digging aborted/)
      assert.equal(bot.listenerCount(`blockUpdate:${block.position}`), 0)
      assert.equal(bot.targetDigBlock, null)
    }
  }
  // Reaching a new target cannot be inferred from a stale goal event or another block update.
  {
    const { bot, block } = fixture({ digMs: 100 })
    const digging = bot.dig(block, 'ignore')
    await sleep(0)
    serverAir(bot, { ...block, position: new Vec3(9, 64, 0) })
    assert.equal(bot.listenerCount(`blockUpdate:${block.position}`), 2)
    bot.stopDigging()
    await rejects(digging, /Digging aborted/)
  }
  // Falling waits for physics contact; timeout, interrupt, special movement, range, visibility, and stale target are bounded.
  {
    const { bot, block } = fixture({ digMs: 15, groundTimeoutMs: 50 })
    bot.entity.onGround = false
    const digging = bot.dig(block, 'ignore')
    await sleep(5)
    assert.equal(mining.getMiningState(bot), null)
    bot.entity.onGround = true
    bot.emit('physicsTick')
    await sleep(0)
    assert.equal(mining.getMiningState(bot).expectedDigMs, 15)
    serverAir(bot, block)
    await digging
  }
  {
    const { bot, block } = fixture({ groundTimeoutMs: 10 })
    bot.entity.onGround = false
    await rejects(bot.dig(block, 'ignore'), /Timed out waiting for ground contact/)
    assert.equal(bot.listenerCount('physicsTick'), 0)
  }
  {
    const { bot, block } = fixture()
    bot.entity.onGround = false
    const digging = bot.dig(block, 'ignore')
    await sleep(0)
    bot.stopDigging()
    await rejects(digging, /aborted while waiting for ground contact/)
    bot.entity.onGround = true
    bot.emit('physicsTick')
    assert.deepEqual(bot._client.writes, [])
    assert.equal(bot.listenerCount('physicsTick'), 0)
  }
  {
    const { bot, block } = fixture({ groundTimeoutMs: 10 })
    bot.entity.onGround = false
    bot.entity.isInWater = true
    const digging = bot.dig(block, 'ignore')
    await sleep(0)
    assert.ok(mining.getMiningState(bot))
    serverAir(bot, block)
    await digging
  }
  for (const [method, message] of [['canDigBlock', /out of digging range/], ['canSeeBlock', /not visible/]]) {
    const { bot, block } = fixture()
    bot[method] = () => false
    await rejects(bot.dig(block, 'ignore'), message)
    assert.equal(bot.listenerCount(`blockUpdate:${block.position}`), 0)
  }
  {
    const { bot, block } = fixture()
    bot.blockAt = () => ({ ...block, type: 0, name: 'air' })
    await rejects(bot.dig(block, 'ignore'), /Target block changed/)
  }
  {
    const { bot, block, setCurrentBlock } = fixture()
    const freshBlock = { ...block, name: 'fresh_stone' }
    setCurrentBlock(freshBlock)
    const observed = []
    const digTime = bot.digTime
    bot.digTime = candidate => { observed.push(candidate); return digTime(candidate) }
    const digging = bot.dig(block, 'ignore')
    await sleep(0)
    assert.ok(observed.includes(freshBlock))
    serverAir(bot, freshBlock)
    await digging
  }
  // goto rejects failure statuses, ignores empty partial paths and stale reached events, and resolves next tick.
  {
    const { bot } = fixture()
    const goal = { reached: false, isEnd() { return this.reached } }
    const moving = bot.pathfinder.goto(goal)
    bot.emit('path_update', { status: 'partial', path: [] })
    bot.emit('goal_reached', { isEnd: () => true })
    let settled = false
    moving.then(() => { settled = true }, () => {})
    await sleep(0)
    assert.equal(settled, false)
    bot.emit('path_update', { status: 'noPath', path: [] })
    await rejects(moving, { name: 'NoPath' })
    for (const event of ['goal_reached', 'path_update', 'goal_updated', 'path_stop']) assert.equal(bot.listenerCount(event), 0)
  }
  for (const status of ['noPath', 'timeout']) {
    const { bot } = fixture()
    const goal = { isEnd: () => false }
    const moving = bot.pathfinder.goto(goal)
    bot.emit('path_update', { status, path: [{ x: 1 }] })
    await rejects(moving, { name: status === 'timeout' ? 'Timeout' : 'NoPath' })
  }
  {
    const { bot } = fixture()
    const goal = { reached: false, isEnd() { return this.reached } }
    const moving = bot.pathfinder.goto(goal)
    goal.reached = true
    bot.emit('goal_reached', goal)
    await moving
    assert.equal(bot.listenerCount('goal_reached'), 0)
  }
  {
    const { bot } = fixture()
    const goal = { isEnd: () => true }
    bot.pathfinder.setGoal({ isEnd: () => false })
    await bot.pathfinder.goto(goal)
    assert.equal(bot.pathfinder.goal, null)
  }
  {
    const { bot } = fixture()
    const goal = { isEnd: () => false }
    const moving = bot.pathfinder.goto(goal)
    bot.emit('goal_reached', goal)
    bot.emit('path_stop')
    await rejects(moving, { name: 'PathStopped' })
  }
  for (const event of ['death', 'end']) {
    const { bot } = fixture()
    const goal = { isEnd: () => false }
    const moving = bot.pathfinder.goto(goal)
    bot.emit(event)
    await rejects(moving, { name: 'BotStopped' })
    assert.equal(bot.pathfinder.goal, null)
    assert.equal(bot.listenerCount('goal_reached'), 0)
  }
  // The real plugin loader and collectblock plugin defer mineflayer-tool; the mining plugin's
  // late pass must run after that dependency has installed its real Tool instance.
  {
    const pluginLoader = require(`${upstream}/mineflayer/lib/plugin_loader`)
    const collectBlockPlugin = require(`${upstream}/mineflayer-collectblock/lib/index`).plugin
    const bot = new EventEmitter()
    const lateIron = Block.fromStateId(ironInfo.defaultState, 0)
    lateIron.position = new Vec3(8, 64, 0)
    pluginLoader(bot, {})
    bot.loadPlugin(target => {
      target._client = new EventEmitter()
      target._client.write = () => {}
      target.registry = registry
      target.entity = { position: new Vec3(0, 64, 0), eyeHeight: 1.62, onGround: true, effects: {} }
      target.game = { gameMode: 'survival' }
      target.inventory = { slots: [] }
      target.getEquipmentDestSlot = () => 5
      target.blockAt = () => lateIron
      target._updateBlockState = () => {}
      target.dig = async () => {}
      target.stopDigging = () => {}
      target.digTime = block => block.digTime(stonePickaxeId, false, false, false, [], {})
      target.pathfinder = { goal: null, setGoal(goal) { this.goal = goal } }
    })
    bot.loadPlugin(collectBlockPlugin)
    bot.loadPlugin(mining.miningSyncPlugin)
    assert.equal(bot.dig, undefined)
    bot.emit('inject_allowed')
    assert.equal(typeof bot.dig, 'function')
    assert.ok(mining.getMiningState(bot) === null)
    assert.equal(bot.tool, undefined)
    await sleep(0)
    assert.equal(bot.blockAt(lateIron.position).material, 'mineable/pickaxe')
    assert.equal(bot.tool.getDigTime(lateIron, { type: stonePickaxeId }), 1150)
    assert.equal(bot.collectBlock.movements.canDig, true)
  }
  // Installer state and cleanup are bot-local.
  const botA = fixture().bot
  const botB = fixture().bot
  assert.notEqual(mining.installMiningSync(botA), mining.installMiningSync(botB))
  console.log('mining_sync.test.cjs: PASS')
}

const watchdog = setTimeout(() => {
  console.error(`mining_sync.test.cjs: FAILED to finish within ${TEST_WATCHDOG_MS}ms`)
  process.exit(1)
}, TEST_WATCHDOG_MS)
main().then(() => clearTimeout(watchdog), error => {
  clearTimeout(watchdog)
  console.error(error)
  process.exitCode = 1
})
