'use strict'
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')
const { moduleRoot } = require('./dependency_root.cjs')
const req = createRequire(path.join(moduleRoot(), 'package.json'))
const registry = req('prismarine-registry')('1.21.1')
const Block = req('prismarine-block')(registry)
const { Vec3 } = req('vec3')
const { Movements, goals } = req('mineflayer-pathfinder')
const AStar = req('mineflayer-pathfinder/lib/astar')
const Move = req('mineflayer-pathfinder/lib/move')
const repo = path.resolve(__dirname, '..')

// Floor at y=63 from x=0..4, z=-1..1; a vine column fills x=1..3 at z=0.
function vineCorridorBot() {
  const blocks = new Map()
  const key = p => `${p.x},${p.y},${p.z}`
  for (let x = 0; x <= 4; x++) for (let z = -1; z <= 1; z++) blocks.set(key({ x, y: 63, z }), 'stone')
  for (let x = 1; x <= 3; x++) blocks.set(key({ x, y: 64, z: 0 }), 'vine')
  const bot = {
    registry, version: '1.21.1', game: { minY: -64, height: 384 },
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true },
    inventory: { items: () => [], slots: [] },
    supportFeature: () => false,
    blockAt(position) {
      const p = position.floored()
      const name = blocks.get(key(p)) ?? 'air'
      const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0)
      block.position = p
      return block
    }
  }
  return bot
}

function routeThrough(movements) {
  const result = new AStar(new Move(0, 64, 0, 0, 0), movements, new goals.GoalBlock(4, 64, 0), 1000, 1000, -1).compute()
  assert.equal(result.status, 'success')
  return result.path.map(node => `${node.x},${node.z}`)
}

async function main() {
  const { penalizeHorizontalClimbableMoves, climbableNavigationPlugin, CLIMB_DRIFT_TOLERANCE } =
    await import(pathToFileURL(path.join(repo, 'src/agent/library/climbable_navigation.js')))

  // B: a same-height walk through vines is avoided when a side row is free.
  const bot = vineCorridorBot()
  const plain = new Movements(bot)
  plain.allowParkour = false
  assert.ok(routeThrough(plain).includes('2,0'), 'baseline walks the vine row')
  const penalized = penalizeHorizontalClimbableMoves(Object.assign(new Movements(bot), { allowParkour: false }))
  assert.equal(penalizeHorizontalClimbableMoves(penalized), penalized)
  const avoided = routeThrough(penalized)
  assert.ok(!avoided.some(node => ['1,0', '2,0', '3,0'].includes(node)), `route still enters vines: ${avoided}`)

  // A: controls set by pathfinder are overridden after it while in a climbable block.
  const fake = new EventEmitter()
  const vine = registry.blocksByName.vine.id
  let feetType = vine
  const controls = {}
  const calls = []
  fake.entity = { position: new Vec3(2.5, 64, 0.5) }
  fake.blockAt = () => ({ type: feetType })
  fake.setControlState = (name, value) => { controls[name] = value }
  fake.pathfinder = {
    movements: { climbables: new Set([vine]) },
    isMoving: () => true,
    getPathFromTo (movements, ...args) { calls.push([movements, args]); return 'generator' }
  }
  climbableNavigationPlugin(fake)
  const searchMovements = { getNeighbors: () => [] }
  assert.equal(fake.pathfinder.getPathFromTo(searchMovements, 'start', 'goal'), 'generator')
  assert.equal(calls[0][0], searchMovements)
  assert.deepEqual(calls[0][1], ['start', 'goal'])
  assert.notEqual(searchMovements.getNeighbors.toString(), '() => []', 'search movements are penalized')

  const press = () => Object.assign(controls, { forward: true, jump: true, sprint: true })
  const route = [Object.assign(new Vec3(3, 64, 0), { toBreak: [], toPlace: [] })]
  fake.emit('path_update', { path: route })

  press(); fake.emit('physicsTick')
  assert.deepEqual(controls, { forward: true, jump: false, sprint: true }, 'same level: only jump is released')

  fake.entity.position = new Vec3(2.5, 64 + CLIMB_DRIFT_TOLERANCE + 0.1, 0.5)
  press(); fake.emit('physicsTick')
  assert.deepEqual(controls, { forward: false, jump: false, sprint: false }, 'drifted up: stop pushing')

  route[0] = Object.assign(new Vec3(3, 66, 0), { toBreak: [], toPlace: [] })
  press(); fake.emit('physicsTick')
  assert.deepEqual(controls, { forward: true, jump: true, sprint: true }, 'planned climb is untouched')

  route[0] = Object.assign(new Vec3(3, 64, 0), { toBreak: [], toPlace: [] })
  feetType = registry.blocksByName.air.id
  press(); fake.emit('physicsTick')
  assert.deepEqual(controls, { forward: true, jump: true, sprint: true }, 'outside climbables is untouched')

  feetType = vine
  fake.emit('path_reset')
  press(); fake.emit('physicsTick')
  assert.deepEqual(controls, { forward: true, jump: true, sprint: true }, 'reset path is forgotten')
}

main().then(() => console.log('climbable_navigation ok')).catch(error => { console.error(error); process.exit(1) })
