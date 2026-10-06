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
  await write(root, 'src/agent/mindserver_proxy.js', 'export function sendOutputToServer() {}');
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
    'src/agent/library/skills.js', 'src/agent/library/block_placement.js',
    'src/agent/library/crafting_sync.js', 'src/agent/library/mining_sync.js',
    'src/agent/library/operation_context.js', 'src/agent/library/world.js',
    'src/agent/library/index.js', 'src/agent/library/skill_library.js',
    'src/agent/library/sdk_capabilities.js', 'src/agent/library/lockdown.js',
    'src/agent/commands/actions.js', 'src/agent/commands/queries.js',
    'src/agent/commands/index.js', 'src/agent/coder.js', 'src/agent/action_manager.js',
    'bots/execTemplate.js', 'bots/lintTemplate.js', 'eslint.config.js'
  ]) await write(root, relative, await readFile(path.join(repo, relative)))
}


const key = p => `${p.x},${p.y},${p.z}`
function makeBot() {
  const bot = new EventEmitter()
  const state = { opened: [], closed: [], digs: [], moves: [], visible: true, unknown: false, route: 'ready' }
  bot.state = state
  bot.registry = registry
  bot.version = '1.21.1'
  bot.username = 'targetFixture'; bot.output = ''; bot.interrupt_code = false
  bot.game = { dimension: 'overworld', gameMode: 'creative' }
  bot.entity = { position: new Vec3(0.5, 64, 0.5), height: 1.8 }
  bot.modes = { isOn: () => false, pause() {}, unpause() {}, flushBehaviorLog: () => '' }
  bot.inventory = { slots: [], items: () => [] }
  bot.getControlState = () => false
  bot.blockAt = p => state.unknown ? null : { name: 'chest', type: registry.blocksByName.chest.id,
    position: p.floored(), stateId: 22, getProperties: () => ({ facing: 'north', type: 'single' }) }
  bot.canSeeBlock = () => state.visible
  bot.canDigBlock = () => state.visible
  bot.world = { getBlock: p => bot.blockAt(p), raycast: () => null }
  bot.pathfinder = { movements: { original: true },
    setMovements(m) { this.movements = m }, getPathTo: () => ({ status: 'success' }),
    async goto(goal) {
      state.moves.push({ goal, movements: this.movements })
      if (state.route === 'unreachable') throw new Error('No path to target')
      if (state.onMove) await state.onMove()
      if (state.route === 'ready') { state.visible = true; bot.entity.position = new Vec3(0.5,64,0.5) }
    }, stop() { state.stop?.() }, setGoal() {} }
  bot.openContainer = async target => {
    state.opened.push(key(target.position))
    const container = { containerItems: () => [{ name: `item_${target.position.x}`, count: target.position.x + 1, slot: 0 }],
      close: async () => { state.closed.push(key(target.position)) } }
    state.onOpen?.()
    return container
  }
  bot.dig = async b => { state.digs.push(key(b.position)) }
  return bot
}
async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mc-targeted-sdk-'))
  const previous = process.cwd()
  try {
    await setup(root); process.chdir(root)
    const load = p => import(pathToFileURL(path.join(root, p)))
    const skills = await load('src/agent/library/skills.js')
    const world = await load('src/agent/library/world.js')
    const { SkillLibrary } = await load('src/agent/library/skill_library.js')
    const { Coder } = await load('src/agent/coder.js')
    const { ActionManager } = await load('src/agent/action_manager.js')
    const bot = makeBot()
    const agent = { bot, name: bot.username, blocked_actions: [],
      clearBotLogs() { bot.output = ''; bot.interrupt_code = false },
      requestInterrupt() { bot.interrupt_code = true },
      self_prompter: { isActive: () => false, isStopped: () => true } }
    const coder = Object.assign(Object.create(Coder.prototype), { agent, file_counter: 0,
      fp: '/bots/targetFixture/action-code/',
      code_template: await readFile(path.join(root,'bots/execTemplate.js'),'utf8'),
      code_lint_template: await readFile(path.join(root,'bots/lintTemplate.js'),'utf8') })
    await mkdir(path.join(root,'bots/targetFixture/action-code'),{recursive:true})
    agent.prompter = { skill_libary: new SkillLibrary(agent,null) }; await agent.prompter.skill_libary.initSkillLibrary()
    agent.coder = coder; agent.actions = new ActionManager(agent)
    const run = code => agent.actions.runAction('action:target-fixture', () => coder.executeCode(code), { timeout: 0, outputLimit:16000, taskId:'target-task' })
    const four = await run('for (const x of [0,1,2,3]) { log(bot, JSON.stringify(await skills.inspectChestAt(bot,x,64,0))); }')
    assert.equal(four.success, true)
    const results = four.message.trim().split('\n').filter(x => x.startsWith('{')).map(JSON.parse)
    assert.equal(results.length,4)
    assert.deepEqual(results.map(x=>x.position.x),[0,1,2,3])
    assert.deepEqual(results.map(x=>x.contents[0].count),[1,2,3,4])
    assert.ok(results.every(x=>x.status==='observed' && x.observedAt && x.target.properties.facing==='north'))
    assert.deepEqual(bot.state.opened,bot.state.closed)
    for (const code of ['await skills.goToPosition(0,64,0);','await skills.inspectChestAt(bot,NaN,64,0);',
      'await skills.breakBlockAt(bot,0,Infinity,0);','await skills.placeBlock(bot,"stone",0,64,"0");',
      'await skills.goToPosition(bot,0,64,0,-1);']) {
      const before = { opens:bot.state.opened.length,moves:bot.state.moves.length,digs:bot.state.digs.length }
      const result = await run(code)
      assert.equal(result.success,false)
      assert.match(result.message, /TypeError.*skills\.(goToPosition|inspectChestAt|breakBlockAt|placeBlock)/s)
      assert.deepEqual({ opens:bot.state.opened.length,moves:bot.state.moves.length,digs:bot.state.digs.length },before)
    }
    bot.state.unknown = true
    const unknown = await skills.inspectChestAt(bot,0,64,0)
    assert.equal(unknown.status,'unknown'); assert.equal(unknown.target.loaded,false)
    assert.equal(unknown.target.name,null)
    bot.state.unknown = false; bot.state.visible = false
    const original = bot.pathfinder.movements
    const recovered = await skills.approachBlock(bot,0,64,0)
    assert.equal(recovered.status,'ready')
    assert.equal(bot.pathfinder.movements,original)
    const movement = bot.state.moves.at(-1)
    assert.equal(movement.goal.constructor.name,'GoalLookAtBlock')
    assert.equal(movement.movements.canDig,false)
    assert.equal(movement.movements.canPlaceOn,false)
    assert.equal(movement.movements.allow1by1towers,false)
    bot.state.visible = false; bot.state.route = 'occluded'
    const partial = await skills.approachBlock(bot,0,64,0)
    assert.equal(partial.status,'blocked'); assert.equal(partial.target.visible,false)
    assert.match(partial.reason,/partial block face/)
    assert.equal(await skills.breakBlockAt(bot,0,64,0),false)
    assert.equal(bot.state.digs.length,0)
    bot.state.route = 'unreachable'
    const unreachable = await skills.inspectChestAt(bot,0,64,0)
    assert.equal(unreachable.status,'blocked'); assert.match(unreachable.reason,/No path/)
    const opens = bot.state.opened.length
    bot.state.route = 'ready'; bot.state.visible = true
    let stopping
    bot.state.onOpen = () => { stopping = agent.actions.stop() }
    const cancelled = await run('await skills.inspectChestAt(bot,0,64,0);')
    await stopping
    assert.equal(cancelled.success,false)
    assert.equal(bot.state.opened.length,opens+1)
    assert.equal(bot.state.closed.length,opens+1)
    bot.state.onOpen = null; bot.interrupt_code = false; bot.state.visible = false
    bot.state.onMove = async () => { stopping = agent.actions.stop() }
    const stop = await run('await skills.inspectChestAt(bot,0,64,0);')
    await stopping
    assert.equal(stop.success,false)
    assert.equal(bot.state.opened.length,opens+1)
    assert.equal(bot.pathfinder.movements,original)
    bot.state.onMove = null; bot.interrupt_code=false
    assert.equal(world.inspectBlockAt(bot,1.8,64.2,0.9).position.x,1)
    console.log('Targeted SDK real Coder/SES/ActionManager fixture passed')
  } finally { process.chdir(previous); await rm(root,{recursive:true,force:true}) }
}
main().catch(error=>{console.error(error);process.exitCode=1})
