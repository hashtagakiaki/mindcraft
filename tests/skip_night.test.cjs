'use strict'

// Offline checks for skills.skipNight (carried bed placement, recovery, wait
// limit) and the nightfall split between the busy-task notice and the idle
// sleeping mode.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { mkdtemp, mkdir, readFile, rm, symlink, writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')
const { moduleRoot } = require('./dependency_root.cjs')
const repo = path.resolve(__dirname, '..')
const dependencies = moduleRoot()
const requireDependency = createRequire(path.join(dependencies, 'package.json'))
const registry = requireDependency('minecraft-data')('1.21.1')
const Vec3 = requireDependency('vec3').Vec3
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function write(root, relative, text) {
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, text)
}

async function setup(root) {
  await write(root, 'package.json', '{"type":"module"}')
  await symlink(dependencies, path.join(root, 'node_modules'))
  await write(root, 'settings.js', 'export default { block_place_delay: 0 };')
  await write(root, 'src/agent/settings.js', 'export default { narrate_behavior: false };')
  await write(root, 'src/utils/mcdata.js', `
import { createRequire } from 'node:module';
const registry = createRequire(import.meta.url)('minecraft-data')('1.21.1');
export function getBlockId(name) { return registry.blocksByName[name]?.id ?? null; }
export function getItemId(name) { return registry.itemsByName[name]?.id ?? null; }
export function mustCollectManually() { return false; }
export const isHostile = () => false;
export const isHuntable = () => false;
`)
  for (const relative of [
    'src/agent/library/skills.js', 'src/agent/library/block_interaction.js', 'src/agent/library/block_placement.js',
    'src/agent/library/crafting_sync.js', 'src/agent/library/operation_context.js', 'src/agent/library/navigation_policy.js',
    'src/agent/library/world.js', 'src/agent/library/native_sdk.js', 'src/agent/modes.js',
  ]) await write(root, relative, await readFile(path.join(repo, relative)))
}

const key = p => `${p.x},${p.y},${p.z}`
function block(name, position, properties = {}) {
  const solid = registry.blocksByName[name]?.boundingBox === 'block'
  return { name, position, type: registry.blocksByName[name]?.id ?? 0, boundingBox: solid ? 'block' : 'empty',
    shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [], getProperties: () => ({ ...properties }) }
}

// A cheat-mode bot: oriented placement and breaking go through /setblock, and
// the fixture applies survival inventory effects to beds.
function makeBot({ blocks = [], beds = 1, time = 14000 } = {}) {
  const bot = new EventEmitter()
  const world = new Map()
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) world.set(`${x},64,${z}`, block('stone', new Vec3(x, 64, z)))
  for (const [name, x, y, z] of blocks) world.set(`${x},${y},${z}`, block(name, new Vec3(x, y, z)))
  const state = { world, beds, commands: [], placed: [], wakes: 0 }
  Object.assign(bot, { state, registry, version: '1.21.1', username: 'fixture', output: '', interrupt_code: false, isSleeping: false, health: 20,
    game: { dimension: 'overworld', gameMode: 'survival' }, time: { timeOfDay: time, day: 1 },
    entity: { position: new Vec3(0.5, 65, 0.5), height: 1.8, yaw: 0, pitch: 0, onGround: true },
    modes: { isOn: name => name === 'cheat', pause() {}, unpause() {} } })
  bot.inventory = {
    slots: [],
    items: () => state.beds > 0 ? [{ name: 'gray_bed', type: registry.itemsByName.gray_bed.id, count: state.beds }] : [],
    findInventoryItem: name => name === 'gray_bed' && state.beds > 0 ? { name, count: state.beds } : null,
  }
  bot.blockAt = p => world.get(key(p)) ?? block('air', new Vec3(p.x, p.y, p.z))
  bot.findBlocks = ({ matching, maxDistance }) => {
    state.search = { maxDistance }
    return [...world.values()].filter(b => matching(b)).map(b => b.position)
  }
  bot.nearestEntity = () => null
  const publish = (p, next) => {
    const before = bot.blockAt(p)
    world.set(key(p), next)
    bot.emit('blockUpdate', before, next)
  }
  bot.chat = command => {
    state.commands.push(command)
    const match = command.match(/^\/setblock (-?\d+) (-?\d+) (-?\d+) ([a-z_]+)(?:\[([^\]]*)\])?/)
    if (!match) return
    const p = new Vec3(Number(match[1]), Number(match[2]), Number(match[3]))
    const properties = Object.fromEntries((match[5] || '').split(',').filter(Boolean).map(entry => entry.split('=')))
    if (match[4] === 'air') {
      const old = bot.blockAt(p)
      if (old.name.endsWith('_bed')) {
        // Breaking either half removes the whole bed and drops one item.
        for (const other of [...world.values()].filter(b => b.name === old.name)) publish(other.position, block('air', other.position))
        state.beds++
      } else publish(p, block('air', p))
      return
    }
    if (match[4].endsWith('_bed') && properties.part === 'foot') { state.beds--; state.placed.push({ position: p, properties }) }
    publish(p, block(match[4], p, properties))
  }
  bot.sleep = async bed => {
    if (!bed?.name?.endsWith('_bed')) throw new Error('wrong block : not a bed block')
    state.sleptIn = bed.name
    bot.isSleeping = true
    if (state.morningAfterMs != null) setTimeout(() => { bot.time.timeOfDay = 0; bot.time.day = 2; bot.isSleeping = false; bot.emit('wake') }, state.morningAfterMs)
  }
  bot.wake = async () => { state.wakes++; bot.isSleeping = false }
  return bot
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mc-skip-night-'))
  const previousCwd = process.cwd()
  try {
    await setup(root)
    process.chdir(root)
    const load = relative => import(pathToFileURL(path.join(root, relative)))
    const skills = await load('src/agent/library/skills.js')
    const { createNativeSdk } = await load('src/agent/library/native_sdk.js')
    const { createOperationContext, runOwnedOperation } = await load('src/agent/library/operation_context.js')
    const native = bot => {
      const op = createOperationContext({ id: 'skip-night-fixture', controller: new AbortController() }, { bot }, { intentEpoch: 1 })
      return runOwnedOperation(op, () => createNativeSdk({ bot, skills }).skills.skipNight({}))
    }

    // Daytime or outside the overworld: no search, no bed use.
    {
      const bot = makeBot({ time: 6000 })
      const result = await native(bot)
      assert.equal(result.ok, false)
      assert.equal(result.code, 'not_night')
      assert.equal(bot.state.search, undefined, 'daytime does not search for beds')
      const nether = makeBot()
      nether.game.dimension = 'the_nether'
      assert.equal((await native(nether)).code, 'not_night', 'beds are never used outside the overworld')
    }

    // A carried bed is placed on open floor, the night passes, and the bed returns to the inventory.
    {
      // grass_block occupies (1,65,0); short grass at (-1,65,0) may be replaced.
      const bot = makeBot({ blocks: [['grass_block', 1, 65, 0], ['short_grass', -1, 65, 0]] })
      bot.state.morningAfterMs = 20
      const result = await native(bot)
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(bot.state.search.maxDistance, 64, 'placed beds are searched within 64 blocks')
      assert.equal(bot.state.placed.length, 1)
      const [{ position, properties }] = bot.state.placed
      assert.notDeepEqual([position.x, position.y, position.z], [0, 65, 0], 'the bed is not placed in the bot cell')
      assert.notDeepEqual([position.x, position.y, position.z], [1, 65, 0], 'occupied cells are skipped')
      assert.notDeepEqual([position.x, position.y, position.z], [-1, 65, 0], 'plant-free floor is preferred over short grass')
      assert.equal(position.y, 65, 'the bed rests on the floor')
      assert.equal(bot.state.sleptIn, 'gray_bed')
      assert.deepEqual(result.bed, { name: 'gray_bed', position: { x: position.x, y: position.y, z: position.z }, placed: true, recovered: true })
      assert.equal(bot.state.beds, 1, 'the carried bed is picked back up')
      assert.equal(properties.facing && ['north', 'south', 'east', 'west'].includes(properties.facing), true)
      assert.equal(bot.state.wakes, 0, 'the server woke the bot at morning')
    }

    // On grassland the plants in the chosen cells are cut before the bed is placed.
    {
      const grass = []
      for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) if (x || z) grass.push(['short_grass', x, 65, z])
      const bot = makeBot({ blocks: grass })
      bot.state.morningAfterMs = 10
      const result = await native(bot)
      assert.equal(result.ok, true, JSON.stringify(result))
      const [{ position, properties }] = bot.state.placed
      const head = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[properties.facing]
      const cleared = bot.state.commands.filter(command => / air$/.test(command))
      assert.ok(cleared.includes(`/setblock ${position.x} 65 ${position.z} air`) && cleared.includes(`/setblock ${position.x + head[0]} 65 ${position.z + head[1]} air`),
        'both bed cells are cleared of grass first')
      assert.equal(bot.state.beds, 1)
    }

    // An existing bed is preferred over the carried bed; bedrock is not a bed.
    {
      const bot = makeBot({ blocks: [['bedrock', 2, 65, 2], ['red_bed', -2, 65, -2]] })
      bot.state.morningAfterMs = 10
      const navigation = []
      bot.pathfinder = { setMovements() {}, async goto(goal) { navigation.push(goal) }, stop() {} }
      const result = await native(bot)
      assert.equal(bot.state.sleptIn, 'red_bed', 'bedrock is ignored and the placed bed is used')
      assert.equal(bot.state.placed.length, 0, 'the carried bed stays in the inventory')
      assert.equal(result.bed.placed, false)
    }

    // The night does not pass: get up after the wait limit and still recover the bed.
    {
      const bot = makeBot()
      const started = Date.now()
      assert.equal(await skills.skipNight(bot, { waitMs: 120 }), false)
      assert.ok(Date.now() - started >= 120)
      assert.equal(bot.state.wakes, 1, 'the bot gets up itself')
      assert.equal(bot.state.beds, 1, 'the placed bed is recovered after a failed night')
      assert.match(bot.output, /the night did not pass/)
    }

    // Cancellation leaves the bed immediately.
    {
      const bot = makeBot()
      const pending = skills.skipNight(bot, { waitMs: 60000 })
      await delay(50)
      bot.interrupt_code = true
      assert.equal(await pending, false)
      assert.equal(bot.state.wakes, 1)
      assert.match(bot.output, /Sleeping was interrupted/)
    }

    // No bed anywhere.
    {
      const bot = makeBot({ beds: 0 })
      assert.equal((await native(bot)).code, 'target_not_found')
    }

    // Nightfall: a busy task gets one notice; an idle bot sleeps without starting a turn.
    {
      const { initModes } = await load('src/agent/modes.js')
      const bot = makeBot({ beds: 0 })
      const off = { self_preservation: false, cowardice: false, self_defense: false, hunting: false, item_collecting: false,
        torch_placing: false, elbow_room: false, idle_staring: false, cheat: false }
      const runs = []
      const agent = {
        bot, task: null,
        prompter: { getInitModes: () => off },
        self_prompter: { isActive: () => false, stopLoop() {} },
        codexRuntime: { active: true, notices: [], acceptSystemEvent(message) { this.notices.push(message); return { accepted: true } } },
        actions: {
          executing: false, currentActionLabel: null, currentAction: null, resume_func: null,
          getCancellationContext: () => null, setPhase() {},
          async runAction(label, fn) {
            runs.push(label); this.executing = true; this.currentActionLabel = label
            try { await fn(); return { success: true, message: 'ok' } } finally { this.executing = false; this.currentActionLabel = null }
          },
        },
        isIdle() { return !this.actions.executing && !this.codexRuntime.active },
        handleMessage() { throw new Error('an idle night must not start a model turn') },
        openChat() {},
      }
      initModes(agent)
      const settle = async () => { for (let i = 0; i < 20 && agent.actions.executing; i++) await delay(10) }

      await bot.modes.update()
      await bot.modes.update()
      assert.equal(agent.codexRuntime.notices.length, 1, 'a busy task is notified once per night')
      assert.match(agent.codexRuntime.notices[0], /skills\.skipNight/)
      assert.deepEqual(runs, [], 'a busy bot is not sent to bed')
      agent.codexRuntime.active = false
      await bot.modes.update(); await settle()
      assert.deepEqual(runs, [], 'after the notice the idle bot does not sleep that night')

      bot.time.day = 2
      await bot.modes.update(); await settle()
      assert.deepEqual(runs, ['mode:sleeping'], 'an idle bot goes to bed on a new night')
      await bot.modes.update(); await settle()
      assert.equal(runs.length, 1, 'a failed attempt waits for the cooldown')
      assert.equal(agent.codexRuntime.notices.length, 1, 'idle nights send no notice')

      bot.emit('sleep')
      bot.modes.setOn('sleeping', true)
      agent.codexRuntime.active = true
      await bot.modes.update()
      assert.equal(agent.codexRuntime.notices.length, 1, 'getting into a bed settles the night for the notice too')

      bot.time.day = 3
      bot.modes.setOn('sleeping', false)
      await bot.modes.update()
      assert.equal(agent.codexRuntime.notices.length, 1, 'sleeping:false disables the notice')
      agent.codexRuntime.active = false
      await bot.modes.update(); await settle()
      assert.equal(runs.length, 1, 'sleeping:false disables the idle mode')

      bot.modes.setOn('sleeping', true)
      bot.time.timeOfDay = 6000
      await bot.modes.update(); await settle()
      assert.equal(runs.length, 1, 'nothing happens during the day')
    }
    console.log('skip night fixture passed')
  } finally {
    process.chdir(previousCwd)
    await rm(root, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exit(1) })
