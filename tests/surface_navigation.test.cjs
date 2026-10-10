'use strict'
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { mkdtemp, mkdir, readFile, writeFile, symlink, rm } = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')
const { moduleRoot } = require('./dependency_root.cjs')
const repo = path.resolve(__dirname, '..')
const deps = moduleRoot()
const req = createRequire(path.join(deps, 'package.json'))
const registry = req('prismarine-registry')('1.21.1')
const Block = req('prismarine-block')(registry)
const Vec3 = req('vec3').Vec3
const { goals } = req('mineflayer-pathfinder')
const key = (x, y, z) => `${x},${y},${z}`

async function write(root, file, content) {
  const target = path.join(root, file)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
}

async function setup(root) {
  await write(root, 'package.json', '{"type":"module"}')
  await symlink(deps, path.join(root, 'node_modules'))
  await write(root, 'settings.js', 'export default { navigation_stall_timeout_ms: 500, navigation_check_interval_ms: 50 };')
  for (const name of ['skills', 'block_placement', 'block_interaction', 'operation_context', 'crafting_sync']) {
    await write(root, `src/agent/library/${name}.js`, await readFile(path.join(repo, `src/agent/library/${name}.js`)))
  }
  await write(root, 'src/utils/mcdata.js', 'export const getBlockId = () => 1;')
  await write(root, 'src/agent/library/world.js', 'export function getNearestBlocksWhere(bot, predicate) { return [...bot.blocks.values()].filter(predicate); }')
}

function makeBot() {
  const bot = new EventEmitter()
  bot.registry = registry
  bot.output = ''
  bot.interrupt_code = false
  bot.game = { minY: -16, height: 48 }
  bot.entity = { position: new Vec3(0.5, 1, 0.5), height: 1.8, onGround: false }
  bot.blocks = new Map()
  bot.put = (x, y, z, name) => {
    const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0)
    block.position = new Vec3(x, y, z)
    bot.blocks.set(key(x, y, z), block)
    return block
  }
  bot.blockAt = position => {
    const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z)
    if (bot.unknown?.has(key(x, y, z))) return null
    return bot.blocks.get(key(x, y, z)) ?? bot.put(x, y, z, y < 12 ? 'air' : 'air')
  }
  bot.modes = { isOn: () => false }
  bot.pathfinder = {
    movements: null,
    setMovements(movements) { this.movements = movements },
    getPathTo(_movements, goal) {
      bot.lastGoal = goal
      return { status: 'success' }
    },
    async goto(goal) {
      assert.equal(this.movements.canDig, false)
      assert.equal(this.movements.canPlaceOn, false)
      assert.equal(this.movements.allow1by1towers, false)
      assert.equal(this.movements.canOpenDoors, false)
      if (bot.failNavigation) throw new Error('fixture path failure')
      if (bot.leavePosition) return
      const selected = goal.goals.find(candidate => bot.reachable?.has(key(candidate.x, candidate.y, candidate.z))) ?? goal.goals[0]
      bot.entity.position = new Vec3(selected.x + 0.5, selected.y, selected.z + 0.5)
      bot.entity.onGround = true
    },
    stop() {},
  }
  bot.fillSurface = () => {
    for (let x = -10; x <= 10; x++) for (let z = -10; z <= 10; z++) bot.put(x, 12, z, 'stone')
  }
  return bot
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mc-surface-navigation-'))
  try {
    await setup(root)
    const { goToSurface } = await import(pathToFileURL(path.join(root, 'src/agent/library/skills.js')))
    const { runOwnedOperation } = await import(pathToFileURL(path.join(root, 'src/agent/library/operation_context.js')))
    const runSurface = bot => {
      const operation = { bot, nativeNavigationNoEdits: true, signal: new AbortController().signal,
        root: { id: null, activeChild: null, closed: false, phase: 'main' }, pending: new Set(), accepting: true,
        calls: [], facts: [], uncertain: [], diagnostics: [], sequence: 0, waitSequence: 0 }
      return runOwnedOperation(operation, () => goToSurface(bot))
    }

    let bot = makeBot()
    bot.fillSurface()
    bot.failNavigation = true
    assert.equal(await runSurface(bot), false, 'path failure does not become a surface success')

    bot = makeBot()
    bot.fillSurface()
    bot.leavePosition = true
    assert.equal(await runSurface(bot), false, 'a settled path without actual arrival is not success')

    bot = makeBot()
    bot.fillSurface()
    const center = bot.entity.position
    bot.unknown = new Set([key(0, 31, 0)])
    assert.equal(await runSurface(bot), true, `unknown space in one column falls back to a loaded neighbor: ${bot.output} at ${bot.entity.position}`)
    assert.notDeepEqual([Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.z)], [Math.floor(center.x), Math.floor(center.z)])

    bot = makeBot()
    bot.fillSurface()
    bot.put(0, 13, 0, 'water')
    bot.put(1, 13, 0, 'oak_leaves')
    bot.put(2, 13, 0, 'stone')
    bot.put(2, 14, 0, 'stone')
    bot.reachable = new Set([key(0, 13, 0), key(1, 13, 0), key(2, 13, 0)])
    assert.equal(await runSurface(bot), true)
    assert.equal(bot.lastGoal.goals.some(candidate => candidate.x === 2 && candidate.y === 13 && candidate.z === 0), false, 'a roof removes cave-floor candidates below it')
    assert.notDeepEqual([Math.floor(bot.entity.position.x), bot.entity.position.y, Math.floor(bot.entity.position.z)], [0, 13, 0], 'liquid standing space is rejected')
    assert.notDeepEqual([Math.floor(bot.entity.position.x), bot.entity.position.y, Math.floor(bot.entity.position.z)], [1, 13, 0], 'leaf canopy is rejected as a support surface')
    assert.notDeepEqual([Math.floor(bot.entity.position.x), bot.entity.position.y, Math.floor(bot.entity.position.z)], [2, 13, 0], 'blocked head space is rejected')

    bot = makeBot()
    bot.fillSurface()
    bot.put(0, 13, 0, 'cobweb')
    bot.put(1, 13, 0, 'sweet_berry_bush')
    bot.reachable = new Set([key(0, 13, 0), key(1, 13, 0)])
    assert.equal(await runSurface(bot), true)
    assert.notDeepEqual([Math.floor(bot.entity.position.x), bot.entity.position.y, Math.floor(bot.entity.position.z)], [0, 13, 0], 'a collision-free avoided block is not standing space')
    assert.notDeepEqual([Math.floor(bot.entity.position.x), bot.entity.position.y, Math.floor(bot.entity.position.z)], [1, 13, 0], 'unsafe vegetation is not standing space')

    bot = makeBot()
    bot.fillSurface()
    bot.interrupt_code = true
    await assert.rejects(goToSurface(bot), /Action cancelled/, 'an already cancelled action follows the existing cancellation contract')

    bot = makeBot()
    bot.game.height = 0
    assert.equal(await runSurface(bot), false, 'missing dimension bounds are reported as a finite search failure')

    bot = makeBot()
    bot.fillSurface()
    bot.reachable = new Set([key(1, 13, 0)])
    assert.equal(await runSurface(bot), true, 'composite goals may choose a reachable neighboring surface')
    assert.equal(bot.lastGoal.constructor.name, 'GoalCompositeAny')
    assert.equal(bot.entity.position.x, 1.5)

    bot = makeBot()
    bot.fillSurface()
    for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) {
      for (let y = 13; y <= 17; y++) bot.put(x, y, z, 'stone')
    }
    for (let y = 13; y <= 17; y++) bot.put(0, y, 0, 'air')
    bot.reachable = new Set([key(1, 18, 0)])
    assert.equal(await runSurface(bot), true, 'an open vertical shaft does not make its low floor the surface')
    assert.equal(bot.lastGoal.goals.some(candidate => candidate.x === 0 && candidate.y === 13 && candidate.z === 0), false)
    assert.equal(bot.entity.position.y, 18)

    bot = makeBot()
    bot.fillSurface()
    for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) {
      if (Math.abs(x) <= 3 && Math.abs(z) <= 3) bot.put(x, 12, z, 'grass_block')
      else for (let y = 13; y <= 17; y++) bot.put(x, y, z, 'stone')
    }
    bot.reachable = new Set([key(1, 13, 0)])
    assert.equal(await runSurface(bot), true, 'connected lower ground remains a surface beside a nearby high roof')
    assert.equal(bot.lastGoal.goals.some(candidate => candidate.x === 1 && candidate.y === 13 && candidate.z === 0), true,
      'connected low candidates are not discarded based on nearby maximum height')

    bot = makeBot()
    bot.fillSurface()
    for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) {
      for (let y = -16; y <= 12; y++) bot.put(x, y, z, 'air')
    }
    assert.equal(await runSurface(bot), false, 'no local loaded surface is not reported as impossible or successful')

    console.log('surface navigation focused fixture passed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
