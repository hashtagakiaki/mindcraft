'use strict'

// Offline fixture: real Coder/SES, ActionManager, interpreter and command parser.
// Only camera/model and unrelated skills/network output are stubbed.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')
const { moduleRoot } = require('./dependency_root.cjs')
const repo = path.resolve(__dirname, '..')

async function write(root, relative, content) {
  const target = path.join(root, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mindcraft-vision-sdk-'))
  const previousCwd = process.cwd()
  try {
    await write(root, 'package.json', '{"type":"module"}')
    await fs.symlink(moduleRoot(), path.join(root, 'node_modules'), 'dir')
    for (const relative of [
      'src/agent/coder.js', 'src/agent/action_manager.js',
      'src/agent/library/operation_context.js', 'src/agent/library/lockdown.js',
      'src/agent/library/skill_library.js', 'src/agent/library/sdk_capabilities.js', 'src/agent/library/native_sdk.js',
      'src/agent/vision/vision_interpreter.js', 'src/agent/connection_handler.js',
      'src/agent/commands/actions.js', 'src/agent/commands/queries.js', 'src/agent/commands/index.js',
      'bots/execTemplate.js', 'bots/lintTemplate.js', 'eslint.config.js',
    ]) await write(root, relative, await fs.readFile(path.join(repo, relative)))
    await write(root, 'src/agent/settings.js', 'export default { allow_insecure_coding: false, generated_code_fail_on_false: [], agent_runtime: "codex-session" };')
    await write(root, 'src/agent/library/skills.js', 'export function log(bot, text) { bot.output += String(text) + "\\n"; }')
    await write(root, 'src/agent/library/world.js', 'export function getPosition(bot) { return bot.entity.position; }')
    await write(root, 'src/agent/library/index.js', 'export function getSkillDocs() { return []; }')
    await write(root, 'src/utils/math.js', 'export function cosineSimilarity() { return 0; }')
    await write(root, 'src/utils/mcdata.js', 'export function getBlockId() { return 1; } export function getItemId() { return 1; }')
    await write(root, 'src/agent/conversation.js', 'export default {};')
    await write(root, 'src/agent/tasks/construction_tasks.js', 'export function checkLevelBlueprint() {} export function checkBlueprint() {}')
    await write(root, 'src/agent/vision/camera.js', 'export class Camera {}')
    await write(root, 'src/agent/mindserver_proxy.js', 'export function sendOutputToServer() {}')
    process.chdir(root)
    const load = relative => import(pathToFileURL(path.join(root, relative)).href)
    const { Coder } = await load('src/agent/coder.js')
    const { ActionManager } = await load('src/agent/action_manager.js')
    const { SkillLibrary } = await load('src/agent/library/skill_library.js')
    const { VisionInterpreter } = await load('src/agent/vision/vision_interpreter.js')
    const { executeCommand } = await load('src/agent/commands/index.js')
    const { parseKickReason, handleDisconnection } = await load('src/agent/connection_handler.js')
    const { getCapabilityDocs } = await load('src/agent/library/sdk_capabilities.js')
    const calls = []
    let afterLookAt = null
    let captureSignal = null
    const chest = { name: 'chest', stateId: 123, position: { x: 75, y: 73, z: -292 },
      getProperties: () => ({ facing: 'north', type: 'single', waterlogged: false }) }
    const bot = new EventEmitter()
    Object.assign(bot, {
      username: 'Fixture', output: '', interrupt_code: false,
      entity: { position: { x: 75, y: 73, z: -292 } },
      players: { Steve: { entity: { position: { x: 2, y: 64, z: 3 }, height: 1.8, yaw: 1, pitch: 0.2 } } },
      modes: { pause() {}, unpause() {}, flushBehaviorLog: () => '', isOn: () => false },
      blockAt(point) { return Math.floor(point.x) === 75 && Math.floor(point.y) === 73 && Math.floor(point.z) === -292 ? chest : null },
      async lookAt(point) { assert.ok([point.x, point.y, point.z].every(Number.isFinite)); calls.push(['lookAt', point.x, point.y, point.z]); afterLookAt?.() },
      async look(yaw, pitch) { calls.push(['look', yaw, pitch]) },
    })
    const agent = {
      name: bot.username, bot, blocked_actions: [],
      clearBotLogs() { bot.output = ''; bot.interrupt_code = false },
      requestInterrupt() { bot.interrupt_code = true },
      self_prompter: { isActive: () => false, isStopped: () => true },
      prompter: { vision_model: { sendVisionRequest() {} } },
    }
    agent.actions = new ActionManager(agent)
    agent.prompter.skill_libary = new SkillLibrary(agent, null)
    await agent.prompter.skill_libary.initSkillLibrary()
    const vision = new VisionInterpreter(agent, false)
    vision.allow_vision = true
    vision.camera = { async capture(options) { captureSignal = options.signal; calls.push(['capture']); return 'fixture' } }
    vision.analyzeImage = async () => 'fixture analysis'
    agent.vision_interpreter = vision
    const coder = Object.assign(Object.create(Coder.prototype), {
      agent, file_counter: 0, fp: '/bots/Fixture/action-code/',
      code_template: await fs.readFile(path.join(root, 'bots/execTemplate.js'), 'utf8'),
      code_lint_template: await fs.readFile(path.join(root, 'bots/lintTemplate.js'), 'utf8'),
    })
    await fs.mkdir(path.join(root, 'bots/Fixture/action-code'), { recursive: true })
    const run = code => agent.actions.runAction('action:vision-fixture', () => coder.executeCode(code), { timeout: 0, taskId: 'same-task' })
    for (const code of [
      'await vision.lookAtPosition(bot,75,73,-292);',
      'await vision.lookAtPosition(NaN,73,-292);',
      'await vision.lookAtPosition(75,Infinity,-292);',
      'await vision.lookAtPosition("75",73,-292);',
      'await vision.lookAtPosition(75,73);',
      'await vision.lookAtBlock(bot,75,73,-292);',
      'await vision.lookAtBlock(NaN,73,-292);',
      'await vision.lookAtBlock(75,Infinity,-292);',
      'await vision.lookAtBlock("75",73,-292);',
      'await vision.lookAtBlock(75,73);',
      'await vision.lookAtPlayer(bot,"Steve","at");',
      'await vision.lookAtPlayer("", "at");',
      'await vision.lookAtPlayer("Steve", "invalid");',
      'await vision.lookAtPlayer({playerName:"Steve",direction:"invalid"});',
      'await vision.lookAtBlock({position:{x:75,y:NaN,z:-292}});',
      'await vision.lookAtPosition({position:{x:75,y:73}});',
      'await vision.lookAtPosition({position:{x:"75",y:73,z:-292}});',
    ]) {
      // Each malformed variant is a fresh request; the corrected call below
      // continues the final request without resetting its owner.
      agent.actions.beginUserIntent()
      const failed = await run(code)
      assert.equal(failed.success, false)
      assert.equal(failed.executionStatus, 'error')
      assert.equal(failed.operationSettlement, 'settled')
      assert.equal(failed.taskId, 'same-task')
      assert.match(JSON.stringify(failed), /SdkArgumentError/)
      assert.equal(failed.argumentError.code, 'INVALID_ARGUMENT')
      assert.match(failed.argumentError.method, /^vision\./)
      assert.ok(failed.argumentError.example)
      assert.equal(calls.length, 0, 'invalid call has no view/capture side effects')
    }
    const good = await run('log(bot, await vision.lookAtPosition({position:{x:75,y:73,z:-292}}));')
    assert.equal(good.success, true)
    assert.equal(good.taskId, 'same-task')
    assert.equal(good.operationSettlement, 'settled')
    assert.deepEqual(calls.splice(0), [['lookAt', 75, 75, -292], ['capture']])
    agent.actions.beginUserIntent()
    const blockResult = await run('log(bot, JSON.stringify(await vision.lookAtBlock({position:{x:75.2,y:73.8,z:-291.8}})));')
    assert.equal(blockResult.success, true)
    assert.equal(blockResult.operationSettlement, 'settled')
    assert.equal(blockResult.skillResults.find(call => call.skill === 'vision.lookAtBlock').status, 'returned')
    const observation = JSON.parse(blockResult.message.slice(blockResult.message.indexOf('{'), blockResult.message.lastIndexOf('}') + 1))
    assert.equal(observation.status, 'observed')
    assert.deepEqual(observation.target.position, chest.position)
    assert.equal(observation.target.name, 'chest')
    assert.equal(observation.target.stateId, 123)
    assert.deepEqual(observation.target.properties, chest.getProperties())
    assert.equal(observation.analysis, 'fixture analysis')
    assert.ok(Number.isFinite(Date.parse(observation.observedAt)))
    assert.ok(Number.isFinite(Date.parse(observation.target.observedAt)))
    assert.deepEqual(observation.aim, { x: 75.5, y: 73.5, z: -291.5 })
    assert.deepEqual(calls.splice(0), [['lookAt', 75.5, 73.5, -291.5], ['capture']])
    assert.ok(captureSignal instanceof AbortSignal, 'block capture uses its ActionManager cancellation signal')
    agent.actions.beginUserIntent()
    const unknownResult = await run('log(bot, JSON.stringify(await vision.lookAtBlock({position:{x:1000,y:73,z:-292}})));')
    assert.equal(unknownResult.success, true)
    assert.match(unknownResult.message, /"status":"unknown"/)
    assert.match(unknownResult.message, /Target block is not loaded/)
    assert.equal(calls.length, 0, 'unknown block has no look/capture side effects')
    agent.actions.beginUserIntent()
    let stopPromise
    afterLookAt = () => { stopPromise = agent.actions.stop('user') }
    const cancelledResult = await run('log(bot, JSON.stringify(await vision.lookAtBlock({position:{x:75,y:73,z:-292}})));')
    afterLookAt = null
    assert.equal(cancelledResult.success, false)
    assert.equal(cancelledResult.operationSettlement, 'settled')
    assert.equal(cancelledResult.skillResults.find(call => call.skill === 'vision.lookAtBlock').status, 'cancelled')
    assert.equal((await stopPromise).stopped, true)
    assert.deepEqual(calls.splice(0), [['lookAt', 75.5, 73.5, -291.5]], 'Stop during aim prevents capture and analysis')
    for (const direction of [undefined, 'at', 'with']) {
      agent.actions.beginUserIntent()
      const args = direction === undefined ? '{playerName:"Steve"}' : `{playerName:"Steve",direction:"${direction}"}`
      assert.equal((await run(`log(bot, await vision.lookAtPlayer(${args}));`)).success, true)
      const actual = calls.splice(0)
      assert.equal(actual[0][0], direction === 'with' ? 'look' : 'lookAt')
      assert.equal(actual[1][0], 'capture')
    }
    assert.match(await vision.lookAtPlayer('Nobody'), /Could not find player Nobody/)
    assert.equal(calls.length, 0)
    agent.actions.beginUserIntent()
    assert.match(await executeCommand(agent, '!lookAtPosition(75,73,-292)'), /fixture analysis/)
    assert.deepEqual(calls.splice(0), [['lookAt', 75, 75, -292], ['capture']])
    agent.actions.beginUserIntent()
    assert.match(await executeCommand(agent, '!lookAtPlayer("Steve","with")'), /fixture analysis/)
    assert.equal(calls.splice(0)[0][0], 'look')
    for (const disabled of ['allow_vision', 'model']) {
      if (disabled === 'allow_vision') vision.allow_vision = false
      else { vision.allow_vision = true; agent.prompter.vision_model = {} }
      assert.match(await vision.lookAtPosition(bot, 1, 2), /Vision is disabled/)
      assert.match(await vision.lookAtPlayer(bot, 'invalid'), /Vision is disabled/)
      assert.equal((await vision.lookAtBlock(75, 73, -292)).status, 'vision_disabled')
      assert.equal(calls.length, 0)
    }
    const docs = getCapabilityDocs().join('\n')
    assert.match(docs, /vision\.lookAtPosition\(x, y, z\)/)
    assert.match(docs, /vision\.lookAtBlock\(x, y, z\)/)
    assert.match(docs, /Do not pass bot/)
    const nbt = { type: 'compound', value: { translate: { type: 'string', value: 'multiplayer.disconnect.invalid_player_movement' } } }
    for (const [reason, expected] of [
      [nbt, 'Invalid move player packet received'],
      [{ type: 'compound', value: { text: { type: 'string', value: 'Exact reason' } } }, 'Exact reason'],
      [{ type: 'string', value: 'Kick text' }, 'Kick text'],
      [{ text: 'Exact reason' }, 'Exact reason'],
      [{ text: 'A', extra: [{ text: 'B' }] }, 'AB'],
      [JSON.stringify({ text: 'Exact reason' }), 'Exact reason'],
      ['Exact reason', 'Exact reason'],
    ]) assert.equal(parseKickReason(reason, '1.21.1').msg, `Disconnected: ${expected}`)
    assert.equal(handleDisconnection('Fixture', nbt, '1.21.1').msg, '[LoginGuard] Disconnected: Invalid move player packet received')
    assert.equal(parseKickReason('Exact fallback', 'unsupported-version').msg, 'Disconnected: Exact fallback')
    assert.equal(parseKickReason(null).type, 'unknown')
    for (const [reason, type, isFatal] of [
      ['duplicate_login', 'name_conflict', true], ['whitelist', 'access_denied', true],
      ['server is full', 'server_full', false], ['outdated client', 'version_mismatch', true],
      ['maintenance', 'maintenance', false], ['timed out', 'network_error', false], ['spam', 'behavior', true],
    ]) {
      const parsed = parseKickReason(reason, '1.21.1')
      assert.equal(parsed.type, type)
      assert.equal(parsed.isFatal, isFatal)
    }
    console.log('vision SDK validation and disconnect reason fixture passed')
  } finally {
    process.chdir(previousCwd)
    await fs.rm(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
