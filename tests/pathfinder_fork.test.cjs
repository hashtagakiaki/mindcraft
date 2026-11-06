'use strict'
// Behavior the vendored mineflayer-pathfinder fork changes or absorbs.
const assert = require('node:assert/strict')
const { moduleRoot, pathfinderFork } = require('./dependency_root.cjs')
const { createRequire } = require('node:module')
const path = require('node:path')

const req = createRequire(path.join(moduleRoot(), 'package.json'))
const { Vec3 } = req('vec3')
const { trimPassedNodes } = pathfinderFork('./lib/trim')

const move = (x, y, z, edits = {}) => Object.assign(new Vec3(x, y, z), { toBreak: edits.toBreak ?? [], toPlace: edits.toPlace ?? [] })

function testTrimKeepsMoveBeforeEditNode () {
  // Manual-play loop (2026-10-30): the bot, still in column x=-60, had the move into
  // column -59 dropped because the pillar node's raw corner looked closer.
  const pillar = move(-59, 59, -9, { toPlace: [{ x: -59, y: 57, z: -9, dx: 0, dy: 1, dz: 0, jump: true }] })
  const path = [move(-58.5, 58, -8.5), pillar]
  trimPassedNodes(path, new Vec3(-59.39, 58.2, -8.5))
  assert.equal(path.length, 2, 'the move into the pillar column is kept until it is reached')

  const reached = [move(-58.5, 58, -8.5), pillar]
  trimPassedNodes(reached, new Vec3(-58.6, 58, -8.5))
  assert.equal(reached[0], pillar, 'a reached move before an edit node is dropped')

  const plain = [move(0.5, 64, 0.5), move(1.5, 64, 0.5), move(2.5, 64, 0.5)]
  trimPassedNodes(plain, new Vec3(0.9, 64, 0.5))
  assert.equal(plain[0].x, 1.5, 'between plain nodes the passed node is still dropped')

  // Replanning mid-jump: y=66 is still above the bot, and without it the next node is out of jump reach.
  const climb = [move(-144.5, 66, -109.5), move(-143.5, 67, -108.5), move(-142.5, 68, -107.5)]
  trimPassedNodes(climb, new Vec3(-144.69, 65.75, -108.53))
  assert.equal(climb[0].y, 66, 'a node above the bot is not passed')
}

const { EventEmitter } = require('node:events')
const goto = pathfinderFork('./lib/goto')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function rejects (promise, expected) { await assert.rejects(promise, expected) }
function gotoBot () {
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0, 64, 0) }
  bot.pathfinder = {
    goal: null,
    setGoal (goal) { this.goal = goal; bot.emit('goal_updated', goal, false) },
    stop () { bot.emit('path_stop') }
  }
  return bot
}

async function testGotoContract () {
  {
    // A full-block landing at y=64 is not already at y=65. The former
    // unconditional +1 shortcut resolved collectBlock one level too early.
    const bot = gotoBot()
    bot.entity.onGround = true
    bot.pathfinder.movements = { emptyBlocks: new Set([0]) }
    bot.blockAt = () => ({ type: 0 })
    const goal = { isEnd: p => p.y === 65 }
    const moving = goto(bot, goal)
    let settled = false
    moving.then(() => { settled = true })
    await sleep(0)
    assert.equal(settled, false)
    bot.entity.position.y = 65
    bot.emit('goal_reached', goal)
    await moving

    // A grounded partial block uses the same start node as path search.
    bot.entity.position.y = 64.5
    bot.blockAt = () => ({ type: 1 })
    await goto(bot, goal)
  }
  // goto rejects failure statuses, ignores empty partial paths and stale reached events, and resolves next tick.
  {
    const bot = gotoBot()
    const goal = { reached: false, isEnd() { return this.reached } }
    const moving = goto(bot, goal)
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
    const bot = gotoBot()
    const goal = { isEnd: () => false }
    const moving = goto(bot, goal)
    bot.emit('path_update', { status, path: [{ x: 1 }] })
    await rejects(moving, { name: status === 'timeout' ? 'Timeout' : 'NoPath' })
  }
  {
    const bot = gotoBot()
    const goal = { reached: false, isEnd() { return this.reached } }
    const moving = goto(bot, goal)
    goal.reached = true
    bot.emit('goal_reached', goal)
    await moving
    assert.equal(bot.listenerCount('goal_reached'), 0)
  }
  {
    const bot = gotoBot()
    const goal = { isEnd: () => true }
    bot.pathfinder.setGoal({ isEnd: () => false })
    await goto(bot, goal)
    assert.equal(bot.pathfinder.goal, null)
  }
  {
    const bot = gotoBot()
    const goal = { isEnd: () => false }
    const moving = goto(bot, goal)
    bot.emit('goal_reached', goal)
    bot.emit('path_stop')
    await rejects(moving, { name: 'PathStopped' })
  }
  for (const event of ['death', 'end']) {
    const bot = gotoBot()
    const goal = { isEnd: () => false }
    const moving = goto(bot, goal)
    bot.emit(event)
    await rejects(moving, { name: 'BotStopped' })
    assert.equal(bot.pathfinder.goal, null)
    assert.equal(bot.listenerCount('goal_reached'), 0)
  }
}

// A one-wide corridor at z=0 (walls at z=±1) whose x=2 cell is either a stone wall to dig or a floor gap to bridge.
async function testProtectedAreasForbidRouteEdits () {
  const { Movements, goals } = pathfinderFork()
  const AStar = pathfinderFork('./lib/astar')
  const Move = pathfinderFork('./lib/move')
  const registry = req('prismarine-registry')('1.21.1')
  const Block = req('prismarine-block')(registry)
  const { createNavigationProtection } = await import(require('node:url').pathToFileURL(path.join(__dirname, '../src/agent/library/protected_areas.js')))
  const corridor = obstacle => {
    const blocks = new Map()
    const key = p => `${p.x},${p.y},${p.z}`
    for (let x = 0; x <= 4; x++) {
      blocks.set(key({ x, y: 63, z: 0 }), 'stone')
      for (const z of [-1, 1]) for (const y of [63, 64, 65]) blocks.set(key({ x, y, z }), 'stone')
    }
    if (obstacle === 'wall') for (const y of [64, 65]) blocks.set(key({ x: 2, y, z: 0 }), 'stone')
    else blocks.delete(key({ x: 2, y: 63, z: 0 }))
    const dirt = registry.itemsByName.dirt.id
    const bot = {
      registry, version: '1.21.1', game: { minY: -64, height: 384, dimension: 'overworld' },
      entity: { position: new Vec3(0.5, 64, 0.5), onGround: true, effects: {} },
      inventory: { items: () => [{ type: dirt, name: 'dirt', count: 16 }], slots: [] },
      pathfinder: { bestHarvestTool: () => null },
      supportFeature: () => false,
      blockAt (position) {
        const p = position.floored()
        const block = Block.fromStateId(registry.blocksByName[blocks.get(key(p)) ?? 'air'].defaultState, 0)
        block.position = p
        return block
      }
    }
    bot.navigationProtection = createNavigationProtection(bot)
    return bot
  }
  const route = bot => {
    const movements = Object.assign(new Movements(bot), { allowParkour: false, canDig: true, scafoldingBlocks: [registry.itemsByName.dirt.id] })
    // Stay in the corridor so pillaring over or bridging around x=2 is not an alternative.
    movements.getNeighbors = function (node) { return Movements.prototype.getNeighbors.call(this, node).filter(move => move.y === 64 && move.z === 0) }
    return new AStar(new Move(0, 64, 0, movements.countScaffoldingItems(), 0), movements, new goals.GoalBlock(4, 64, 0), 2000, 1000, -1).compute()
  }
  const area = dimension => ({ id: 'base', name: 'Base', dimension, min: { x: 2, y: 60, z: -1 }, max: { x: 2, y: 70, z: 1 } })
  for (const obstacle of ['wall', 'gap']) {
    const bot = corridor(obstacle)
    const open = route(bot)
    assert.equal(open.status, 'success', `${obstacle}: an unprotected route edits through x=2`)
    assert.ok(open.path.some(node => node.toBreak.length || node.toPlace.length), `${obstacle}: the open route needs an edit`)
    bot.navigationProtection.replace([area('minecraft:the_nether')])
    assert.equal(route(bot).status, 'success', `${obstacle}: another dimension's area does not apply`)
    bot.navigationProtection.replace([area('minecraft:overworld')])
    assert.notEqual(route(bot).status, 'success', `${obstacle}: no route edits inside a protected area`)
  }
}

// Routes wade and swim at the surface but never plan a node whose head cell is
// water-filled (2026-11-06 drowning: collectBlock routed through a flooded tunnel).
function testRoutesDoNotDive () {
  const { Movements, goals } = pathfinderFork()
  const AStar = pathfinderFork('./lib/astar')
  const Move = pathfinderFork('./lib/move')
  const registry = req('prismarine-registry')('1.21.1')
  const Block = req('prismarine-block')(registry)
  const key = p => `${p.x},${p.y},${p.z}`
  const world = blocks => ({
    registry, version: '1.21.1', game: { minY: -64, height: 384, dimension: 'overworld' },
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true, effects: {} },
    inventory: { items: () => [], slots: [] },
    pathfinder: { bestHarvestTool: () => null },
    supportFeature: () => false,
    blockAt (position) {
      const p = position.floored()
      const block = Block.fromStateId(registry.blocksByName[blocks.get(key(p)) ?? 'air'].defaultState, 0)
      block.position = p
      return block
    }
  })
  // One-wide corridor at z=0 from x=0..6 under a stone ceiling at y=66; x=2..4 holds `fill` at y=64 and y=65.
  const corridor = (fill, { detour = false } = {}) => {
    const blocks = new Map()
    for (let x = 0; x <= 6; x++) {
      for (const y of [63, 66]) blocks.set(key({ x, y, z: 0 }), 'stone')
      for (const z of [-1, 1]) for (const y of [63, 64, 65, 66]) blocks.set(key({ x, y, z }), 'stone')
    }
    for (let x = 2; x <= 4; x++) for (const y of [64, 65]) blocks.set(key({ x, y, z: 0 }), fill[y])
    if (detour) {
      // A dry loop through z=1..2 around the flooded cells.
      for (let x = 1; x <= 5; x++) for (const z of [1, 2]) {
        blocks.set(key({ x, y: 63, z }), 'stone')
        for (const y of [64, 65]) blocks.delete(key({ x, y, z }))
        blocks.set(key({ x, y: 66, z }), 'stone')
      }
    }
    return world(blocks)
  }
  const route = (bot, configure = () => {}, goal = new goals.GoalBlock(6, 64, 0), start = new Move(0, 64, 0, 0, 0)) => {
    const movements = Object.assign(new Movements(bot), { allowParkour: false, canDig: false })
    configure(movements)
    return new AStar(start, movements, goal, 2000, 1000, -1).compute()
  }
  const flooded = { 64: 'water', 65: 'water' }

  assert.notEqual(route(corridor(flooded)).status, 'success', 'the default movements plan no route through a flooded tunnel')
  assert.equal(route(corridor(flooded), m => { m.allowSubmerged = true }).status, 'success', 'allowSubmerged=true still dives')
  const around = route(corridor(flooded, { detour: true }))
  assert.equal(around.status, 'success', 'a dry detour is found')
  assert.ok(!around.path.some(node => node.z === 0 && node.x >= 2 && node.x <= 4), 'the route avoids the flooded cells')
  for (const plant of ['kelp', 'seagrass']) {
    assert.notEqual(route(corridor({ 64: 'water', 65: plant })).status, 'success', `${plant} at head height is water-filled`)
  }
  assert.equal(route(corridor({ 64: 'water', 65: 'air' })).status, 'success', 'wading with the head in air is allowed')
  assert.equal(Movements.isWaterFilled(Block.fromStateId(registry.blocksByName.oak_slab.minStateId, 0)), true,
    'a waterlogged block is water-filled')

  // From a submerged start only rising moves stay: two underwater steps up to air.
  const steps = new Map()
  for (const [x, y, name] of [[0, 63, 'stone'], [0, 64, 'water'], [0, 65, 'water'], [0, 66, 'water'], [1, 64, 'stone'],
    [1, 65, 'water'], [1, 66, 'water'], [2, 64, 'stone'], [2, 65, 'stone'], [-1, 63, 'stone'], [-1, 64, 'water'], [-1, 65, 'water']]) {
    steps.set(key({ x, y, z: 0 }), name)
  }
  const rising = route(world(steps), () => {}, new goals.GoalBlock(2, 66, 0))
  assert.equal(rising.status, 'success', `a submerged start can climb out: ${rising.status}`)
  const sideways = route(world(steps), () => {}, new goals.GoalBlock(-1, 64, 0))
  assert.notEqual(sideways.status, 'success', 'a submerged start does not travel further under water')
  assert.equal(route(world(steps), m => { m.allowSubmerged = true }, new goals.GoalBlock(-1, 64, 0)).status, 'success',
    'the sideways cell is reachable when diving is allowed')
}

async function main () {
  testTrimKeepsMoveBeforeEditNode()
  testRoutesDoNotDive()
  await testGotoContract()
  await testProtectedAreasForbidRouteEdits()
}

main().then(() => console.log('pathfinder fork tests passed')).catch(error => { console.error(error); process.exit(1) })
