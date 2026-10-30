'use strict'
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { mkdtemp, mkdir, readFile, writeFile, symlink, rm } = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')
const { moduleRoot, pathfinderFork } = require('./dependency_root.cjs')
const deps = moduleRoot(), req = createRequire(path.join(deps, 'package.json'))
const { goals, Movements } = pathfinderFork()
const AStar = pathfinderFork('./lib/astar'), Move = pathfinderFork('./lib/move')
const registry = req('prismarine-registry')('1.21.1'), Block = req('prismarine-block')(registry), Vec3 = req('vec3').Vec3
const WorldSync = req('prismarine-world/src/worldsync')
async function setup(root) {
  await mkdir(path.join(root, 'src/agent/library'), { recursive: true })
  await mkdir(path.join(root, 'src/utils'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}')
  await symlink(deps, path.join(root, 'node_modules'))
  await writeFile(path.join(root, 'settings.js'), 'export default {}')
  await writeFile(path.join(root, 'src/agent/settings.js'), 'export default {narrate_behavior:false}')
  await writeFile(path.join(root, 'src/utils/mcdata.js'), 'export const isHostile=e=>e.type==="hostile"; export const isHuntable=()=>false; export const getBlockId=()=>1;')
  for (const name of ['skills', 'world', 'block_placement', 'block_interaction', 'operation_context', 'navigation_policy', 'crafting_sync'])
    await writeFile(path.join(root, `src/agent/library/${name}.js`), await readFile(path.join(__dirname, `../src/agent/library/${name}.js`)))
  await writeFile(path.join(root, 'src/agent/modes.js'), await readFile(path.join(__dirname, '../src/agent/modes.js')))
  require('node:fs').cpSync(path.join(__dirname, '../src/vendor'), path.join(root, 'src/vendor'), { recursive: true })
}
function makeBot({ enclosed = false, raised = false, gap = false } = {}) {
  const bot = new EventEmitter()
  Object.assign(bot, { registry, game: { minY: 62 }, output: '', entities: {}, interrupt_code: false,
    entity: { id: 1, position: new Vec3(.5, raised ? 68 : 64, .5), height: 1.8, onGround: true },
    inventory: { items: () => [{ type: registry.itemsByName.dirt.id, name: 'dirt', count: 64 }] },
    modes: { pause() {} }, mutations: [], installed: [] })
  bot.blockAt = p => {
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
    if (Math.abs(x) > 40 || Math.abs(z) > 40 || y < 62 || y > 72) return null
    const wall = enclosed && (Math.abs(x) === 1 || Math.abs(z) === 1) && y < 67 && Math.abs(x) <= 1 && Math.abs(z) <= 1
    const name = y < 64 && !(gap && x === 2) || wall || raised && x === 0 && z === 0 && y < 68 ? 'stone' : 'air'
    const b = Block.fromStateId(registry.blocksByName[name].defaultState)
    b.position = new Vec3(x, y, z)
    return b
  }
  bot.world = { getBlock: p => bot.blockAt(p), raycast: WorldSync.prototype.raycast }
  const route = (m, start, goal, timeout = 100) => {
    m.allowEntityDetection = false
    const p = start.floored(), a = new AStar(new Move(p.x, p.y, p.z, m.countScaffoldingItems(), 0), m, goal, timeout, timeout, 35)
    let r = a.compute(); while (r.status === 'partial') r = a.compute()
    return r
  }
  bot.pathfinder = {
    getPathTo: (m, goal, timeout) => route(m, bot.entity.position, goal, timeout),
    *getPathFromTo(m, start, goal, options) { yield { result: route(m, start, goal, options.timeout) } },
    setMovements(m) { this.movements = m },
    setGoal(goal) { this.goal = goal; if (goal) bot.installed.push(goal) }, stop() { this.goal = null }
  }
  return bot
}
const enemy = (id, x, name = 'zombie') => ({ id, name, type: 'hostile', height: 1.8, position: new Vec3(x, 64, .5) })
async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mc-enemy-retreat-'))
  try {
    await setup(root)
    const world = await import(pathToFileURL(path.join(root, 'src/agent/library/world.js')))
    const skills = await import(pathToFileURL(path.join(root, 'src/agent/library/skills.js')))
    const boxed = makeBot({ enclosed: true }), zombie = enemy(2, 4.5)
    boxed.entities[2] = zombie
    // This is the original admission rule, exercised with the real pathfinder.
    const old = new Movements(boxed); Object.assign(old, { canDig: false, canPlaceOn: false, canOpenDoors: false })
    const original = boxed.pathfinder.getPathTo(old, new goals.GoalNear(4, 64, 0, 1), 100)
    assert.equal(original.status, 'success')
    assert.ok(original.path.some(n => n.toPlace.length))
    assert.equal(await world.isClearPath(boxed, zombie), false)
    assert.deepEqual(await world.getNearbyThreats(boxed), [])
    assert.equal(await skills.avoidEnemies(boxed, 8), true)
    assert.equal(boxed.installed.length, 0, 'wall-separated enemies never start retreat')
    const ledge = makeBot({ raised: true }); ledge.entities[2] = zombie
    assert.deepEqual(await world.getNearbyThreats(ledge), [], 'a downhill route does not let the mob climb a four-block ledge')
    const ranged = makeBot({ gap: true }); ranged.entities[2] = enemy(2, 4.5, 'skeleton')
    assert.equal((await world.getNearbyThreats(ranged)).length, 1, 'clear ranged attacks across a gap remain threats')
    const blockedRanged = makeBot({ enclosed: true }); blockedRanged.entities[2] = enemy(2, 4.5, 'skeleton')
    assert.deepEqual(await world.getNearbyThreats(blockedRanged), [], 'solid wall blocks ranged threats')
    const crowd = makeBot(); crowd.entities = { 2: enemy(2, -3.5), 3: enemy(3, 4.5) }
    crowd.pathfinder.setGoal = function (goal) {
      this.goal = goal
      if (!goal) return
      crowd.installed.push(goal)
      assert.equal(goal.goals.length, 2, 'one goal accounts for both opposing enemies')
      assert.ok(goal.heuristic(new Vec3(0, 64, 12)) < goal.heuristic(new Vec3(0, 64, 0)), 'escape heuristic points away from the group')
      assert.equal(goal.isEnd(new Vec3(-5, 64, 0)), false, 'escaping one enemy into the other is not a destination')
      const route = this.getPathTo(this.movements, goal, 100)
      assert.equal(route.status, 'success', 'real search finds a route away from the group')
      assert.ok(goal.isEnd(route.path.at(-1)))
      const end = route.path.at(-1)
      crowd.entity.position = new Vec3(end.x + .5, end.y, end.z + .5)
    }
    assert.equal(await skills.avoidEnemies(crowd, 8), true)
    assert.equal(crowd.installed.length, 1)
    assert.equal(crowd.pathfinder.goal, null)
    assert.equal(crowd.listenerCount('path_update'), 0)
    const stuck = makeBot(); stuck.entities[2] = zombie
    stuck.pathfinder.setGoal = function (goal) { this.goal = goal; if (goal) stuck.emit('path_update', { status: 'noPath' }) }
    assert.equal(await skills.avoidEnemies(stuck, 8), false, 'no retreat route fails explicitly')
    assert.equal(stuck.pathfinder.goal, null)
    const circling = makeBot(); circling.entities[2] = zombie
    const now = Date.now; let elapsed = 0
    Date.now = () => now() + elapsed
    circling.pathfinder.setGoal = function (goal) { this.goal = goal; if (goal) elapsed += 5100 }
    try { assert.equal(await skills.avoidEnemies(circling, 8), false, 'no distance progress terminates retreat') }
    finally { Date.now = now }
    const cancelled = makeBot(); cancelled.entities[2] = zombie; cancelled.interrupt_code = true
    assert.equal(await skills.avoidEnemies(cancelled, 8), false)
    assert.equal(cancelled.installed.length, 0)
    const { initModes } = await import(pathToFileURL(path.join(root, 'src/agent/modes.js')))
    const modeBot = makeBot(), threat = enemy(9, 4.5)
    modeBot.entities[9] = threat
    modeBot.health = 8
    modeBot.food = 14
    const modeEvents = [], runOptions = []
    const modeAgent = { bot: modeBot, name: 'FixtureBot', shut_up: true,
      prompter: { getInitModes: () => ({ self_preservation: false, cowardice: false, self_defense: true,
        hunting: false, item_collecting: false, torch_placing: false, elbow_room: false, idle_staring: false }) },
      self_prompter: { isActive: () => false, stopLoop() {} }, isIdle: () => true,
      actions: { currentActionLabel: '', currentAction: null, runAction: async (label, fn, options) => {
        runOptions.push({ label, options }); return { success: false, message: 'fixture' }
      } },
      openChat() {} }
    modeBot._mindcraftDiagnosticRecord = (type, detail) => modeEvents.push({ type, detail })
    initModes(modeAgent)
    await modeBot.modes.update()
    const modeDecisionEvent = modeEvents.find(event => event.type === 'mode_action_triggered')
    assert.equal(modeDecisionEvent.detail.sourceMode, 'self_defense')
    assert.equal(modeDecisionEvent.detail.reason, 'nearby_threat')
    assert.equal(modeDecisionEvent.detail.evidence.target.name, 'zombie')
    assert.equal(modeDecisionEvent.detail.evidence.observed.health, 8)
    assert.equal(runOptions[0].options.interruptionContext.decisionId, modeDecisionEvent.detail.decisionId)
    assert.equal(runOptions[0].options.interruptionContext.evidence.target.id, 9,
      'the mode decision ID and captured enemy/health evidence enter ActionManager together')
    // cowardice retreats only from imminent threats; the rest is left to the running action or self-defense.
    const triggeredMode = async ({ enemies, health = 20, food = 20, damagedAgoMs = null }) => {
      const bot = makeBot()
      for (const item of enemies) bot.entities[item.id] = item
      Object.assign(bot, { health, food, lastDamageTime: damagedAgoMs === null ? 0 : Date.now() - damagedAgoMs })
      const events = []
      bot._mindcraftDiagnosticRecord = (type, detail) => events.push({ type, detail })
      initModes({ ...modeAgent, bot, prompter: { getInitModes: () => ({ self_preservation: false, cowardice: true, self_defense: true,
        hunting: false, item_collecting: false, torch_placing: false, elbow_room: false, idle_staring: false }) } })
      await bot.modes.update()
      const event = events.find(item => item.type === 'mode_action_triggered')
      return event ? `${event.detail.sourceMode}:${event.detail.reason}` : null
    }
    assert.equal(await triggeredMode({ enemies: [enemy(20, 15.5, 'skeleton')] }), null,
      'a visible distant skeleton does not interrupt a healthy undamaged bot')
    assert.equal(await triggeredMode({ enemies: [enemy(20, 15.5, 'skeleton')], damagedAgoMs: 500 }), 'cowardice:dangerous_encounter',
      'recent damage makes a visible ranged mob a retreat threat')
    assert.equal(await triggeredMode({ enemies: [enemy(20, 15.5, 'skeleton')], health: 8 }), 'cowardice:dangerous_encounter',
      'low health makes a visible ranged mob a retreat threat')
    assert.equal(await triggeredMode({ enemies: [enemy(21, 4.5), enemy(22, 15.5, 'creeper')] }), 'self_defense:nearby_threat',
      'a distant creeper does not stop self-defense against a nearby zombie')
    assert.equal(await triggeredMode({ enemies: [enemy(22, 5.5, 'creeper')] }), 'cowardice:dangerous_encounter',
      'a creeper within the retreat distance still triggers retreat')
    console.log('enemy retreat: real wall/scaffold and directional reachability, ranged sight, group escape, failure, progress, cancellation and imminent-threat retreat passed')
  } finally { await rm(root, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
