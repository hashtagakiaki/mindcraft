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

  // Benchmark seed 42 (2026-11-10): on a leaf canopy at y=82, the swim node 19 blocks
  // below the bot was closer than the drop into the water beside it.
  const drop = [move(-27.5, 62, 2.5), move(-28.5, 63, 2.5), move(-25.5, 63, 2.5)]
  trimPassedNodes(drop, new Vec3(-28.55, 82, 2.5))
  assert.equal(drop[0].x, -27.5, 'a drop target below the bot is not passed before the drop')

  const landed = [move(-27.5, 62, 2.5), move(-28.5, 63, 2.5), move(-25.5, 63, 2.5)]
  trimPassedNodes(landed, new Vec3(-27.6, 62.4, 2.5))
  assert.equal(landed[0].x, -28.5, 'after landing, the passed drop target is dropped')
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

  for (const unresolved of [{ x: 1, y: 63, z: 0 }, { x: 2, y: 63, z: 0 }]) {
    const bot = corridor('gap')
    bot.pathfinder.navigationUnconfirmedAt = position =>
      position.x === unresolved.x && position.y === unresolved.y && position.z === unresolved.z
    assert.notEqual(route(bot).status, 'success',
      `an unresolved scaffold reference/target at ${unresolved.x},${unresolved.y},${unresolved.z} is excluded from A*`)
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

  // Parkour across a 3-wide gap: allowed over a shallow pit, not over a ravine (qa obstacle-recovery, 2026-11-21).
  const gap = depth => {
    const blocks = new Map()
    for (const x of [0, 1, 5, 6]) blocks.set(key({ x, y: 63, z: 0 }), 'stone')
    if (depth != null) for (let x = 2; x <= 4; x++) blocks.set(key({ x, y: 63 - depth, z: 0 }), 'stone')
    return world(blocks)
  }
  const jump = movements => Object.assign(movements, { allowParkour: true, allowSprinting: true, scafoldingBlocks: [] })
  assert.equal(route(gap(2), jump, new goals.GoalBlock(6, 64, 0)).status, 'success', 'a gap with footing two blocks down can be jumped')
  assert.notEqual(route(gap(null), jump, new goals.GoalBlock(6, 64, 0)).status, 'success', 'a bottomless gap is not jumped')

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
  const swimUp = route(world(steps), m => { m.allowSubmerged = true }, new goals.GoalBlock(0, 66, 0))
  assert.equal(swimUp.status, 'success', `a submerged start can swim straight up: ${swimUp.status}`)
  assert.ok(swimUp.path.some(node => node.x === 0 && node.z === 0 && node.y > 64 && node.toPlace.length === 0),
    'swim-up is a vertical movement and does not require a scaffold')
  const sideways = route(world(steps), () => {}, new goals.GoalBlock(-1, 64, 0))
  assert.notEqual(sideways.status, 'success', 'a submerged start does not travel further under water')
  assert.equal(route(world(steps), m => { m.allowSubmerged = true }, new goals.GoalBlock(-1, 64, 0)).status, 'success',
    'the sideways cell is reachable when diving is allowed')

  const unresolved = corridor({ 64: 'air', 65: 'air' })
  let cellUnconfirmed = true
  unresolved.pathfinder.navigationUnconfirmedAt = position => cellUnconfirmed &&
    position.x === 3 && position.y === 64 && position.z === 0
  assert.notEqual(route(unresolved).status, 'success', 'an unresolved placement cell is treated as unknown during A* previews')
  cellUnconfirmed = false
  assert.equal(route(unresolved).status, 'success', 'an authoritative observation can make the same cell usable again')
}

function testLookAtBlockReachIsMeasuredFromTheEyes () {
  // obstacle-recovery qa run (2026-11-21): standing under the trunk at y=72, the log at y=75
  // was rejected before its ray was cast, so collectBlock path-searched until timeout 5 times.
  const { goals } = pathfinderFork('./index.js')
  const target = new Vec3(787, 75, -123)
  const world = { raycast: (from, direction, range) => {
    for (let t = 0; t <= range; t += 0.05) {
      const point = from.plus(direction.scaled(t)).floored()
      if (point.equals(target)) return { position: point, face: 0 }
    }
    return null
  } }
  const goal = new goals.GoalLookAtBlock(target, world)
  assert.equal(goal.isEnd(new Vec3(787, 72, -123)), true, 'a block three above the feet is within reach of the eyes')
  assert.equal(goal.isEnd(new Vec3(787, 66, -123)), false, 'a block nine above the feet is out of reach')
  assert.equal(goal.isEnd(new Vec3(787, 79, -123)), false, 'a block four below the feet is out of reach of the eyes')
}

function testFullStopDoesNotRecenterOverAir () {
  // obstacle-recovery qa runs (2026-11-21): sneaking mid-bridge at x=825.07, a path reset's
  // fullStop moved the bot to x=825.5 over the ravine three times.
  const { recenterTarget } = pathfinderFork('./lib/recenter')
  const solid = new Set(['824,68,-123'])
  const blockAt = p => ({ boundingBox: solid.has(`${p.x},${p.y},${p.z}`) ? 'block' : 'empty' })
  assert.equal(recenterTarget(blockAt, new Vec3(825.07, 69, -122.5), true), null, 'no recentring onto an unsupported column')
  assert.deepEqual(recenterTarget(blockAt, new Vec3(825.07, 69, -122.5), false), { x: 825.5, z: -122.5 }, 'airborne recentring is unchanged')
  solid.add('825,68,-123')
  assert.deepEqual(recenterTarget(blockAt, new Vec3(825.07, 69, -122.5), true), { x: 825.5, z: -122.5 }, 'a supported column is recentred')

  // The helper alone does not cover fullStop's use of it.
  solid.delete('825,68,-123')
  const bot = Object.assign(new EventEmitter(), {
    registry: req('prismarine-registry')('1.21.1'), version: '1.21.1', game: { minY: -64, height: 384 },
    entity: { position: new Vec3(825.07, 69, -122.5), velocity: new Vec3(0, 0, 0), onGround: true },
    entities: {}, inventory: { items: () => [], slots: [] }, clearControlStates () {}, blockAt: position => blockAt(position.floored())
  })
  pathfinderFork().pathfinder(bot)
  bot.pathfinder.stop()
  bot.pathfinder.setGoal(null)
  assert.equal(bot.entity.position.x, 825.07, 'fullStop leaves a grounded bot off the unsupported column')
}

async function testDeathEndsRouteDig () {
  // qa regress-underwater-exit (2026-11-22): mineflayer drops the diggingAborted listeners on death,
  // so a route dig cut short by drowning left the respawned bot unable to take a step.
  const { pathfinder, Movements, goals } = pathfinderFork()
  const registry = req('prismarine-registry')('1.21.1')
  const Block = req('prismarine-block')(registry)
  const bot = new EventEmitter()
  Object.assign(bot, {
    registry, version: '1.21.1', game: { minY: -64, height: 384, dimension: 'overworld', gameMode: 'survival' },
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, effects: {}, height: 1.8, eyeHeight: 1.62, yaw: 0, pitch: 0 },
    entities: {}, inventory: { items: () => [], slots: [] }, heldItem: null, getEquipmentDestSlot: () => 5,
    controlState: {}, clearControlStates () {}, setControlState () {}, getControlState: () => false,
    supportFeature: () => false, _client: { write () {} }, swingArm () {}, lookAt: async () => {}, _updateBlockState () {},
    blockAt (position) {
      const p = position.floored()
      const solid = p.y === 63 || (p.x === 1 && (p.y === 64 || p.y === 65)) || (p.z !== 0 && (p.y === 64 || p.y === 65))
      const block = Block.fromStateId(registry.blocksByName[solid ? 'stone' : 'air'].defaultState, 0)
      block.position = p
      return block
    }
  })
  req('mineflayer/lib/plugins/digging')(bot)
  pathfinder(bot)
  bot.pathfinder.setMovements(Object.assign(new Movements(bot), { maxMoveCost: Infinity, allowParkour: false, scafoldingBlocks: [] }))
  bot.pathfinder.setGoal(new goals.GoalBlock(2, 64, 0))
  for (let tick = 0; tick < 50 && !bot.targetDigBlock; tick++) {
    bot.emit('physicsTick')
    await sleep(0)
  }
  assert.ok(bot.targetDigBlock, 'the route starts digging the wall')
  bot.emit('death')
  bot.pathfinder.setGoal(null)
  await sleep(0)
  assert.equal(bot.pathfinder.isMining(), false, 'a death ends the route dig, so the respawned bot can move')
}

function testWaterExitPredictionHoldsJump () {
  // seed 42 (2026-11-10): predicted without the jump the controller holds, a water exit looked unreachable.
  const Physics = pathfinderFork('./lib/physics')
  const state = { pos: new Vec3(0, 63, 0), control: {}, isInWater: true }
  Physics.prototype.getController(new Vec3(1, 64, 1), false, false)(state, 0)
  assert.equal(state.control.jump, true, 'a simulated step out of water holds jump')
}

async function main () {
  testWaterExitPredictionHoldsJump()
  testTrimKeepsMoveBeforeEditNode()
  testFullStopDoesNotRecenterOverAir()
  testLookAtBlockReachIsMeasuredFromTheEyes()
  testRoutesDoNotDive()
  await testGotoContract()
  await testProtectedAreasForbidRouteEdits()
  await testDeathEndsRouteDig()
}

main().then(() => console.log('pathfinder fork tests passed')).catch(error => { console.error(error); process.exit(1) })
