'use strict'
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const { moduleRoot, pathfinderFork } = require('./dependency_root.cjs')
const req = createRequire(path.join(moduleRoot(), 'package.json'))
const registry = req('prismarine-registry')('1.21.1')
const Block = req('prismarine-block')(registry)
const { Vec3 } = req('vec3')
const { Movements, goals } = pathfinderFork()
const AStar = pathfinderFork('./lib/astar')
const Move = pathfinderFork('./lib/move')

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
  const { holdClimbableDrift, CLIMB_DRIFT_TOLERANCE } = pathfinderFork('./lib/climbable')

  // B: the fork's A* avoids a same-height walk through vines when a side row is free,
  // for its own Movements and for Movements instances other plugins pass in.
  const bot = vineCorridorBot()
  const movements = Object.assign(new Movements(bot), { allowParkour: false })
  const avoided = routeThrough(movements)
  assert.ok(!avoided.some(node => ['1,0', '2,0', '3,0'].includes(node)), `route still enters vines: ${avoided}`)
  const vineRow = Object.assign(new Movements(bot), { allowParkour: false })
  vineRow.getNeighbors = function (node) { return Movements.prototype.getNeighbors.call(this, node).filter(move => move.z === 0) }
  assert.ok(routeThrough(vineRow).includes('2,0'), 'a route that must use the vine row still exists')

  // A: after the tick's controls are chosen, drifting up in a climbable stops the push.
  const vine = registry.blocksByName.vine.id
  let feetType = vine
  const controls = {}
  const fake = { entity: { position: new Vec3(2.5, 64, 0.5) }, blockAt: () => ({ type: feetType }),
    setControlState: (name, value) => { controls[name] = value } }
  const climbables = new Set([vine])
  const press = () => Object.assign(controls, { forward: true, jump: true, sprint: true })
  const node = y => Object.assign(new Vec3(3, y, 0), { toBreak: [], toPlace: [] })

  press(); holdClimbableDrift(fake, node(64), climbables)
  assert.deepEqual(controls, { forward: true, jump: false, sprint: true }, 'same level: only jump is released')

  fake.entity.position = new Vec3(2.5, 64 + CLIMB_DRIFT_TOLERANCE + 0.1, 0.5)
  press(); holdClimbableDrift(fake, node(64), climbables)
  assert.deepEqual(controls, { forward: false, jump: false, sprint: false }, 'drifted up: stop pushing')

  press(); holdClimbableDrift(fake, node(66), climbables)
  assert.deepEqual(controls, { forward: true, jump: true, sprint: true }, 'planned climb is untouched')

  feetType = registry.blocksByName.air.id
  press(); holdClimbableDrift(fake, node(64), climbables)
  assert.deepEqual(controls, { forward: true, jump: true, sprint: true }, 'outside climbables is untouched')

  feetType = vine
  press(); holdClimbableDrift(fake, Object.assign(node(64), { toPlace: [{}] }), climbables)
  assert.deepEqual(controls, { forward: true, jump: true, sprint: true }, 'an edit node is untouched')
}

main().then(() => console.log('climbable_navigation ok')).catch(error => { console.error(error); process.exit(1) })
