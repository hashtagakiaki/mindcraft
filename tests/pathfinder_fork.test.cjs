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

async function main () {
  testTrimKeepsMoveBeforeEditNode()
  await testGotoContract()
}

main().then(() => console.log('pathfinder fork tests passed')).catch(error => { console.error(error); process.exit(1) })
