'use strict'

// Disposable, offline checks of the public API, server-state confirmation,
// command parser, generated-code docs, and SES options boundary.
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
const genericPlace = requireDependency('mineflayer/lib/plugins/generic_place')
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
  await write(root, 'src/agent/settings.js', 'export default { allow_insecure_coding: false, generated_code_fail_on_false: [], code_timeout_mins: 1 };')
  await write(root, 'src/agent/conversation.js', 'export default {};')
  await write(root, 'src/agent/tasks/construction_tasks.js', "export function checkLevelBlueprint() { return ''; } export function checkBlueprint() { return ''; }")
  await write(root, 'src/utils/math.js', 'export function cosineSimilarity() { return 0; }')
  await write(root, 'src/utils/mcdata.js', `
import { createRequire } from 'node:module';
const registry = createRequire(import.meta.url)('minecraft-data')('1.21.1');
export function getBlockId(name) { return registry.blocksByName[name]?.id ?? null; }
export function getItemId(name) { return registry.itemsByName[name]?.id ?? null; }
export function mustCollectManually() { return false; }
`)
  for (const relative of [
    'src/agent/library/skills.js', 'src/agent/library/block_interaction.js', 'src/agent/library/block_placement.js',
    'src/agent/library/crafting_sync.js', 'src/agent/library/mining_sync.js',
    'src/agent/library/operation_context.js', 'src/agent/library/world.js',
    'src/agent/library/index.js', 'src/agent/library/skill_library.js',
    'src/agent/library/sdk_capabilities.js', 'src/agent/library/lockdown.js',
    'src/agent/commands/actions.js', 'src/agent/commands/queries.js',
    'src/agent/commands/index.js', 'src/agent/coder.js',
    'bots/execTemplate.js', 'bots/lintTemplate.js', 'eslint.config.js'
  ]) await write(root, relative, await readFile(path.join(repo, relative)))
}

const key = p => `${p.x},${p.y},${p.z}`
function block(name, position, properties = {}) {
  return { name, position, type: registry.blocksByName[name]?.id ?? 0,
    boundingBox: ['air', 'cave_air', 'void_air'].includes(name) ? 'empty' : 'block',
    shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]],
    getProperties: () => ({ ...properties }) }
}

function makeBot({ initial = null, result = { name: 'furnace', properties: { facing: 'north' } }, cheat = false, update = 'immediate', support = true, item = 'furnace' } = {}) {
  const bot = new EventEmitter()
  const position = new Vec3(0, 65, 0)
  const world = new Map()
  if (initial) world.set(key(position), block(initial.name, position, initial.properties))
  if (support) world.set('0,64,0', block('stone', new Vec3(0, 64, 0)))
  const state = { world, position, packets: [], commands: [], controls: [], pluginCalls: 0, digs: 0, equips: 0, movements: null, result, update }
  bot.state = state
  bot.version = '1.21.1'
  bot.registry = registry
  bot.username = 'fixture'
  bot.output = ''
  bot.interrupt_code = false
  bot.game = { dimension: 'overworld', gameMode: 'survival' }
  bot.entity = { position: new Vec3(0.5, 65, -3.5), height: 1.8, yaw: 0, pitch: 0, onGround: true }
  bot.physics = { playerHeight: 1.8 }
  bot.modes = { isOn: name => cheat && name === 'cheat', pause() {}, unpause() {} }
  bot.inventory = { slots: [], items: () => item ? [{ name: item, type: registry.itemsByName[item].id, count: 8 }] : [], findInventoryItem: name => item === name ? { name: item, type: registry.itemsByName[item].id, count: 8 } : null }
  bot.pathfinder = {
    movements: { fixtureOriginal: true },
    setMovements(value) { this.movements = value; state.movements = value },
    async goto(goal) { state.goal = goal },
    async getPathTo() { return { status: 'success' } },
    setGoal() {}, stop() {}
  }
  bot.blockAt = p => world.has(key(p)) ? world.get(key(p)) : block('air', p)
  bot.world = { getBlock: p => bot.blockAt(p), raycast: () => support ? { position: new Vec3(0, 64, 0), face: 1 } : null }
  bot.lookAt = async point => {
    const eye = bot.entity.position.offset(0, bot.getControlState('sneak') ? 1.27 : 1.62, 0)
    const dx = point.x - eye.x, dy = point.y - eye.y, dz = point.z - eye.z
    bot.entity.yaw = Math.atan2(-dx, -dz)
    bot.entity.pitch = Math.atan2(dy, Math.hypot(dx, dz))
    bot._client.write('look', { yaw: (Math.PI - bot.entity.yaw) * 180 / Math.PI, pitch: -bot.entity.pitch * 180 / Math.PI })
  }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; bot._client.write('look', { yaw: (Math.PI - yaw) * 180 / Math.PI, pitch: -pitch * 180 / Math.PI }) }
  bot.getControlState = name => state.controls.findLast(entry => entry[0] === name)?.[1] ?? false
  bot.setControlState = (name, value) => { state.controls.push([name, value]) }
  bot.equip = async value => { bot.heldItem = value; state.equips++ }
  bot.dig = async () => { state.digs++; throw new Error('Placement must not dig') }
  bot.supportFeature = name => name === 'blockPlaceHasInsideBlock'
  bot.swingArm = () => {}
  bot.waitForTicks = async () => delay(1)
  bot._client = { write(name, packet) { state.packets.push([name, packet]) } }
  genericPlace(bot)
  const publish = (name, p, properties) => {
    const before = bot.blockAt(p)
    const after = block(name, p, properties)
    world.set(key(p), after)
    bot.emit('blockUpdate', before, after)
    bot.emit(`blockUpdate:${p}`, before, after)
  }
  state.publish = publish
  bot._placeBlockWithOptions = async (reference, face, options) => {
    state.pluginCalls++
    state.placementPosture = { reference: reference.name, sneak: bot.getControlState('sneak') }
    state.activeMovements = bot.pathfinder.movements
    await bot._genericPlace(reference, face, options)
    const publishResult = () => {
      if (state.update === 'unknown') { world.set(key(position), null); bot.emit('blockUpdate', block('air', position), null); return }
      if (state.result) publish(state.result.name, position, state.result.properties)
    }
    if (state.update === 'immediate' || state.update === 'throwAfterUpdate' || state.update === 'unknown') publishResult()
    if (state.update === 'delayed') setTimeout(publishResult, 15)
    if (state.update === 'throwAfterUpdate') throw new Error('plugin rejected after authoritative state update')
  }
  bot.placeBlock = async (reference, face) => bot._placeBlockWithOptions(reference, face, {})
  bot.chat = command => {
    state.commands.push(command)
    if (!command.startsWith('/setblock ') || state.update === 'absent') return
    const match = command.match(/^\/setblock (-?\d+) (-?\d+) (-?\d+) ([a-z_]+)(?:\[([^\]]*)\])? keep$/)
    assert.ok(match, 'cheat uses safe registry-derived block state and keep')
    const p = new Vec3(Number(match[1]), Number(match[2]), Number(match[3]))
    const properties = Object.fromEntries((match[5] || '').split(',').filter(Boolean).map(entry => entry.split('=')))
    const name = state.update === 'wrong' ? 'stone' : match[4]
    if (state.update === 'partial' && state.commands.length > 1) return
    if (state.update === 'delayed') setTimeout(() => publish(name, p, properties), 15)
    else publish(name, p, properties)
  }
  return bot
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mc-oriented-placement-'))
  const previousCwd = process.cwd()
  try {
    await setup(root)
    process.chdir(root)
    const load = relative => import(pathToFileURL(path.join(root, relative)))
    const skills = await load('src/agent/library/skills.js')
    const { normalizePlacement, makePlacementGoal } = await load('src/agent/library/block_placement.js')
    const { createOperationContext, runOwnedOperation, operationResult } = await load('src/agent/library/operation_context.js')
    const invoke = (bot, name = 'furnace', options = { facing: 'north' }, dontCheat = false) => skills.placeBlock(bot, name, 0, 65, 0, options, dontCheat)
    const owned = async (bot, fn) => {
      const controller = new AbortController()
      const op = createOperationContext({ id: 'placement-fixture', controller }, { bot }, { intentEpoch: 1 })
      const value = await runOwnedOperation(op, fn)
      return { value, result: operationResult(op) }
    }

    // Registry validation maps item names to resulting block state without
    // deriving expected values from the implementation's placement plan.
    for (const [name, options, expectedName, expectedProperties] of [
      ['oak_log', { axis: 'x' }, 'oak_log', { axis: 'x' }],
      ['oak_slab', { half: 'top' }, 'oak_slab', { type: 'top' }],
      ['torch', { attachTo: 'north', facing: 'south' }, 'wall_torch', { facing: 'south' }],
      ['ladder', { facing: 'east' }, 'ladder', { facing: 'east' }],
      ['lever', { attachTo: 'top', facing: 'west' }, 'lever', { face: 'ceiling', facing: 'west' }],
      ['observer', { facing: 'up' }, 'observer', { facing: 'up' }]
    ]) {
      const request = normalizePlacement(makeBot(), name, { x: 0, y: 65, z: 0 }, options)
      assert.equal(request.name, expectedName)
      assert.deepEqual(request.properties, expectedProperties)
    }

    for (const [name, options, properties] of [
      ['oak_stairs', { facing: 'north', half: 'bottom' }, { facing: 'north', half: 'bottom' }],
      ['oak_slab', { half: 'bottom' }, { type: 'bottom' }]
    ]) {
      const floorBot = makeBot({ item: name, result: { name, properties } })
      floorBot.entity.position = new Vec3(0.5, 65, 3.5)
      const request = normalizePlacement(floorBot, name, { x: 0, y: 65, z: 0 }, options)
      const floorGoal = makePlacementGoal(floorBot, request)
      assert.ok(floorGoal.facesPos.length, 'lower stairs/slabs retain the top face of floor support')
      assert.equal(await invoke(floorBot, name, options), true, `${name} lower half can be placed on a floor`)
      assert.equal(floorBot.state.packets.filter(([name]) => name === 'block_place').length, 1)
    }
    const sneakBot = makeBot({ item: 'piston' })
    sneakBot.state.world.set('0,65,-1', block('stone', new Vec3(0, 65, -1)))
    const sneakRequest = normalizePlacement(sneakBot, 'piston', { x: 0, y: 65, z: 0 }, { facing: 'down' })
    const sneakGoal = makePlacementGoal(sneakBot, sneakRequest)
    // Geometry only: ray visibility is tested separately by the ordinary API.
    sneakGoal.options.LOS = false
    const sneakNode = new Vec3(1, 63, -1)
    sneakBot.entity.position = sneakNode.offset(0.5, 0, 0.5)
    assert.equal(sneakGoal.getFaceAndRef(sneakNode.offset(0.5, 1.6, 0.5)), null, 'standing eye height cannot satisfy this upward look')
    assert.ok(sneakGoal.getFaceAndRef(sneakNode.offset(0.5, 1.27, 0.5)), 'the prospective sneaking eye height can satisfy it')
    assert.equal(sneakGoal.isEnd(sneakNode), true, 'navigation admits positions valid for the actual placement sneak posture')

    const offsetBot = makeBot()
    offsetBot.entity.position = new Vec3(0.5, 65, -3.99)
    const offsetRequest = normalizePlacement(offsetBot, 'furnace', { x: 0, y: 65, z: 0 }, { facing: 'north' })
    const offsetGoal = makePlacementGoal(offsetBot, offsetRequest)
    const offsetNode = offsetBot.entity.position.floored()
    assert.ok(offsetGoal.getFaceAndRef(offsetNode.offset(0.5, 1.27, 0.5)), 'the synthetic center of this cell appears in placement range')
    assert.equal(offsetGoal.getFaceAndRef(offsetBot.entity.position.offset(0, 1.27, 0)), null, 'the actual off-center bot is outside placement range')
    assert.equal(offsetGoal.isEnd(offsetNode), false, 'an invalid actual start position is not reported already at goal')
    assert.equal(offsetGoal.isEnd(offsetNode.offset(0, 1, 0)), false, 'the pathfinder phantom node one block above the actual position is not already at goal')

    let bot = makeBot({ initial: { name: 'furnace', properties: { facing: 'north' } }, item: null, support: false })
    let ownedResult = await owned(bot, () => invoke(bot))
    assert.equal(ownedResult.value, true, 'existing requested state is a no-op even without item/support')
    assert.equal(bot.state.pluginCalls, 0)
    assert.equal(bot.state.equips, 0)
    assert.equal(bot.state.digs, 0)
    assert.ok(ownedResult.result.confirmedChanges.every(change => !change.quantity), 'no-op does not count a newly placed block')

    for (const initial of [{ name: 'furnace', properties: { facing: 'south' } }, { name: 'chest', properties: { facing: 'north' } }]) {
      bot = makeBot({ initial })
      ownedResult = await owned(bot, () => invoke(bot))
      assert.equal(ownedResult.value, false, 'occupied blocks are never rotated or replaced')
      assert.equal(bot.state.pluginCalls, 0)
      assert.equal(bot.state.digs, 0)
      assert.ok(ownedResult.result.unconfirmedChanges.length)
    }

    for (const [name, options] of [
      ['furnace', { facing: 'northeast' }], ['furnace', { axis: 'x' }],
      ['furnace', { facing: 'north', typo: true }], ['furnace', []],
      ['furnace', null], ['furnace', false], ['furnace', 32],
      ['oak_log', { facing: 'north', axis: 'x' }], ['oak_log', { axis: 'invalid' }],
      ['oak_log', { axis: 'x', attachTo: 'bottom' }],
      ['oak_stairs', { half: 'upper' }], ['furnace[facing=north]', { facing: 'north' }],
      ['furnace', { attachTo: 'side' }], ['torch', { attachTo: 'north', facing: 'north' }]
    ]) {
      bot = makeBot()
      assert.equal(await invoke(bot, name, options), false, `reject invalid ${name} ${JSON.stringify(options)}`)
      assert.equal(bot.state.pluginCalls + bot.state.equips + bot.state.digs + bot.state.commands.length, 0, 'invalid requests reject before mutation')
    }
    for (const coordinate of [NaN, Infinity, '0']) {
      bot = makeBot()
      assert.equal(await skills.placeBlock(bot, 'furnace', coordinate, 65, 0, { facing: 'north' }), false)
      assert.equal(bot.state.pluginCalls + bot.state.equips, 0)
    }

    bot = makeBot()
    bot.state.world.set('0,65,0', null)
    assert.equal(await invoke(bot), false, 'unloaded target is unknown, not air')
    assert.equal(bot.state.pluginCalls, 0)
    bot = makeBot({ support: false })
    assert.equal(await invoke(bot), false, 'missing support rejects before placement')
    bot = makeBot()
    assert.equal(await invoke(bot, 'furnace', { facing: 'north', attachTo: 'east' }), false, 'strict attachment does not fall back to available bottom support')
    assert.equal(bot.state.pluginCalls, 0)

    for (const update of ['immediate', 'delayed', 'throwAfterUpdate']) {
      bot = makeBot({ update })
      ownedResult = await owned(bot, () => invoke(bot))
      assert.equal(ownedResult.value, true, `${update} authoritative matching state wins over plugin settlement`)
      assert.equal(bot.state.packets.filter(([name]) => name === 'block_place').length, 1)
      assert.equal(bot.listenerCount('blockUpdate'), 0, 'confirmation listener removed')
      assert.equal(ownedResult.result.skillResults[0].status, 'returned_true')
      assert.ok(ownedResult.result.confirmedChanges.some(change => change.quantity === 1))
      assert.equal(bot.state.digs, 0)
      assert.deepEqual(bot.state.placementPosture, { reference: 'stone', sneak: false }, 'ordinary support keeps normal placement semantics')
      assert.equal(bot.getControlState('sneak'), false, 'owned sneak state restored')
      assert.equal(bot.pathfinder.movements.fixtureOriginal, true, 'original movements restored')
      assert.equal(bot.state.activeMovements.canDig, false, 'navigation cannot dig')
      assert.equal(bot.state.activeMovements.allow1by1towers, false)
      assert.deepEqual(bot.state.activeMovements.scafoldingBlocks, [])
    }
    bot = makeBot()
    bot.state.world.set('0,64,0', block('furnace', new Vec3(0, 64, 0), { facing: 'north' }))
    assert.equal(await invoke(bot), true)
    assert.deepEqual(bot.state.placementPosture, { reference: 'furnace', sneak: true }, 'interactive support is bypassed by crouching')
    assert.equal(bot.getControlState('sneak'), false, 'interactive support crouch is restored')

    bot = makeBot()
    bot.setControlState('sneak', true)
    assert.equal(await invoke(bot), true)
    assert.deepEqual(bot.state.placementPosture, { reference: 'stone', sneak: false }, 'ordinary support temporarily releases an existing crouch')
    assert.equal(bot.getControlState('sneak'), true, 'the original crouch is restored after normal placement')

    bot = makeBot()
    bot.entity.position = new Vec3(50, 65, 50)
    bot.pathfinder.goto = async () => { throw new Error('injected unreachable path') }
    assert.equal(await invoke(bot), false, 'unreachable placement does not send a packet')
    assert.equal(bot.state.pluginCalls, 0)
    bot = makeBot()
    bot.waitForTicks = async () => bot.state.world.set('0,65,0', block('chest', new Vec3(0, 65, 0), { facing: 'north' }))
    assert.equal(await invoke(bot), false, 'new occupant before transmission prevents placement')
    assert.equal(bot.state.pluginCalls, 0)
    assert.equal(bot.state.digs, 0)
    assert.equal(bot.getControlState('sneak'), false)

    bot = makeBot()
    let lookAttempts = 0
    const transmittedLook = bot.lookAt
    bot.lookAt = async point => { if (++lookAttempts > 1) await transmittedLook(point) }
    const originalWriter = bot._client.write
    assert.equal(await invoke(bot), true, 'already-matching local look without an outgoing packet triggers a fresh ordinary look')
    assert.equal(lookAttempts, 2)
    assert.equal(bot._client.write, originalWriter, 'physics packet observer restored after success')
    assert.equal(bot.state.packets.at(-1)[0], 'block_place', 'placement packet follows confirmed look')

    bot = makeBot()
    const timeoutWriter = bot._client.write
    bot.lookAt = async () => {}
    bot.look = async () => {}
    assert.equal(await invoke(bot), false, 'untransmitted yaw/pitch cannot permit a placement packet')
    assert.equal(bot.state.pluginCalls, 0)
    assert.equal(bot._client.write, timeoutWriter, 'physics writer restored after look timeout')
    assert.equal(bot.getControlState('sneak'), false)
    assert.equal(bot.pathfinder.movements.fixtureOriginal, true)
    assert.match(bot.output, /transmission timed out/)

    bot = makeBot()
    const lookCancelWriter = bot._client.write
    bot.lookAt = async () => {}
    bot.look = async () => {}
    const lookCancelController = new AbortController()
    bot.getActionCancellationContext = () => ({ signal: lookCancelController.signal })
    const lookCancelPending = invoke(bot)
    setTimeout(() => lookCancelController.abort('cancel unsent look'), 20)
    assert.equal(await lookCancelPending, false)
    assert.equal(bot.state.pluginCalls, 0)
    assert.equal(bot._client.write, lookCancelWriter)
    assert.equal(bot.getControlState('sneak'), false)

    bot = makeBot({ result: { name: 'furnace', properties: { facing: 'south' } } })
    ownedResult = await owned(bot, () => invoke(bot))
    assert.equal(ownedResult.value, false, 'wrong server facing is not success')
    assert.equal(bot.state.pluginCalls, 1, 'wrong placement is not retried')
    assert.match(bot.output, /south/)
    assert.ok(ownedResult.result.unconfirmedChanges.length)
    assert.equal(ownedResult.result.skillResults[0].status, 'returned_false')
    assert.equal(bot.listenerCount('blockUpdate'), 0)
    bot = makeBot({ update: 'unknown' })
    assert.equal(await invoke(bot), false, 'unloaded result is not confirmed')
    assert.equal(bot.listenerCount('blockUpdate'), 0)

    bot = makeBot({ cheat: true })
    assert.equal(await invoke(bot, 'furnace', { facing: 'north', attachTo: 'east' }), false, 'cheat preserves the explicit support requirement')
    assert.equal(bot.state.commands.length, 0)
    bot = makeBot({ cheat: true })
    ownedResult = await owned(bot, () => invoke(bot))
    assert.equal(ownedResult.value, true)
    assert.deepEqual(bot.state.commands, ['/setblock 0 65 0 furnace[facing=north] keep'])
    assert.equal(bot.state.pluginCalls, 0)
    bot = makeBot({ cheat: true, update: 'wrong' })
    assert.equal(await invoke(bot), false, 'cheat command submission alone is not success')
    bot = makeBot({ cheat: true })
    assert.equal(await invoke(bot, 'furnace', { facing: 'north' }, true), true, 'dontCheat preserves normal placement')
    assert.equal(bot.state.commands.length, 0)
    assert.equal(bot.state.pluginCalls, 1)
    bot = makeBot({ cheat: true, item: 'oak_door', update: 'partial' })
    ownedResult = await owned(bot, () => invoke(bot, 'oak_door', { facing: 'north' }))
    assert.equal(ownedResult.value, false, 'partial door placement requires both halves')
    assert.equal(bot.state.commands.length, 2)
    assert.equal(bot.blockAt(new Vec3(0, 65, 0)).name, 'oak_door', 'partial placement is left observable')
    assert.equal(bot.state.digs, 0)
    assert.ok(ownedResult.result.unconfirmedChanges.length)

    bot = makeBot({ cheat: true, update: 'absent' })
    assert.equal(await invoke(bot), false, 'missing server updates time out')
    assert.equal(bot.listenerCount('blockUpdate'), 0)
    bot = makeBot({ update: 'absent' })
    const controller = new AbortController()
    bot.getActionCancellationContext = () => ({ signal: controller.signal })
    const pending = invoke(bot)
    await delay(20)
    bot.interrupt_code = true
    controller.abort('fixture stop')
    assert.equal(await pending, false, 'stopped confirmation cannot report success')
    assert.equal(bot.state.pluginCalls, 1)
    assert.equal(bot.listenerCount('blockUpdate'), 0)

    bot = makeBot({ cheat: true, update: 'absent' })
    assert.equal(await invoke(bot, 'furnace', 'north'), true, 'legacy string preference retains its existing behavior')
    assert.deepEqual(bot.state.commands, ['/setblock 0 65 0 furnace'])

    bot = makeBot({ update: 'absent' })
    let releasePlugin
    const pluginGate = new Promise(resolve => { releasePlugin = resolve })
    const placeAdapter = bot._placeBlockWithOptions
    bot._placeBlockWithOptions = async (...args) => { await placeAdapter(...args); await pluginGate }
    const drainController = new AbortController()
    bot.getActionCancellationContext = () => ({ signal: drainController.signal })
    let placementSettled = false
    const drainPending = invoke(bot).then(value => { placementSettled = true; return value })
    await delay(20)
    drainController.abort('fixture stop during plugin')
    await delay(40)
    assert.equal(placementSettled, false, 'cancellation does not claim the owned plugin has settled')
    releasePlugin()
    assert.equal(await drainPending, false)
    assert.equal(bot.listenerCount('blockUpdate'), 0)
    assert.equal(bot.getControlState('sneak'), false)
    assert.equal(bot.pathfinder.movements.fixtureOriginal, true)

    const { SkillLibrary } = await load('src/agent/library/skill_library.js')
    const library = new SkillLibrary({}, null)
    await library.initSkillLibrary()
    const docs = await library.getRelevantSkillDocs('place oriented blocks', 0)
    assert.match(docs, /skills\.placeBlock/)
    for (const option of ['facing', 'axis', 'half', 'attachTo']) assert.match(docs, new RegExp(option), 'options appear in always-selected model docs')

    const { parseCommandMessage, executeCommand } = await load('src/agent/commands/index.js')
    assert.deepEqual(parseCommandMessage('!placeBlockFacing("furnace", 0, 65, 0, "north")'), { commandName: '!placeBlockFacing', args: ['furnace', 0, 65, 0, 'north'] })
    assert.match(parseCommandMessage('!placeBlockFacing("furnace", 0, 65, 0)'), /requires 5/)
    bot = makeBot({ cheat: true, update: 'wrong' })
    const agent = { name: 'placement-fixture', bot, blocked_actions: [] }
    agent.actions = { async runAction(_label, fn) {
      const { value, result } = await owned(bot, fn)
      return { success: true, message: bot.output, domainReturn: value, ...result }
    } }
    const commandResult = await executeCommand(agent, '!placeBlockFacing("furnace", 0, 65, 0, "north")')
    assert.match(commandResult, /returned_false|returned false|failed|Could not confirm/i, 'command reports failed placement even when executor settled successfully')

    const { Coder } = await load('src/agent/coder.js')
    agent.prompter = { skill_libary: library }
    agent.history = { getHistory: () => [] }
    const coder = new Coder(agent)
    for (let tries = 0; !coder.code_template || !coder.code_lint_template; tries++) { assert.ok(tries < 100); await delay(10) }
    const generated = await coder._stageCode("log(bot, await skills.placeBlock(bot, 'oak_stairs', 0, 65, 0, { facing: 'west', half: 'top' }));")
    assert.equal(await coder._lintCode(generated.src_lint_copy), null, 'object options pass the actual generated-code lint path')
    bot = makeBot({ cheat: true, item: 'oak_stairs' })
    bot.state.world.set('0,66,0', block('stone', new Vec3(0, 66, 0)))
    ownedResult = await owned(bot, () => generated.func.main(bot))
    assert.equal(bot.state.commands.length, 1)
    assert.match(bot.state.commands[0], /facing=west/)
    assert.match(bot.state.commands[0], /half=top/)
    assert.ok(ownedResult.result.skillResults.some(call => call.skill === 'skills.placeBlock' && call.returnValue === true), 'SES reaches tracked public skill with both options')
    console.log('block_placement.test.cjs: strict options, no-op/occupancy, server confirmation, cheat, stop/cleanup, command/docs/SES passed')
  } finally {
    process.chdir(previousCwd)
    await rm(root, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
