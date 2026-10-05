'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const nodeBinary = '/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node'
const initSourcePath = path.resolve(__dirname, '../src/process/init_agent.js')
const historySourcePath = path.resolve(__dirname, '../src/agent/history.js')
const taskSourcePath = path.resolve(__dirname, '../src/agent/tasks/tasks.js')
const cookingSourcePath = path.resolve(__dirname, '../src/agent/tasks/cooking_tasks.js')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function nextMessage(child, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('timed out waiting for fixture message')), timeoutMs)
    const onMessage = message => { if (predicate(message)) finish(null, message) }
    const onClose = () => finish(new Error('fixture child closed before expected message'))
    const finish = (error, value) => {
      clearTimeout(timeout)
      child.removeListener('message', onMessage)
      child.removeListener('close', onClose)
      error ? reject(error) : resolve(value)
    }
    child.on('message', onMessage)
    child.once('close', onClose)
  })
}

function waitForClose(child, timeoutMs = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`timed out waiting for fixture child exit (code=${child.exitCode}, signal=${child.signalCode}, pid=${child.pid})`)), timeoutMs)
    const finish = error => {
      clearTimeout(timeout)
      child.removeListener('close', onClose)
      child.removeListener('exit', onExit)
      error ? reject(error) : resolve()
    }
    const onClose = () => finish()
    const onExit = () => finish()
    child.once('close', onClose)
    child.once('exit', onExit)
  })
}

async function runHistoryFixture(root) {
  const previousCwd = process.cwd()
  const dir = path.join(root, 'history')
  await fs.mkdir(dir, { recursive: true })
  await fs.mkdir(path.join(dir, 'stubs'))
  await fs.writeFile(path.join(dir, 'stubs/settings.js'), 'export default { max_messages: 5 }')
  let source = await fs.readFile(historySourcePath, 'utf8')
  source = source.replace("import { NPCData } from './npc/data.js';", '')
  source = source.replace("import settings from './settings.js';", "import settings from './stubs/settings.js';")
  const modulePath = path.join(dir, 'history.mjs')
  await fs.writeFile(modulePath, source)
  await fs.writeFile(path.join(dir, 'package.json'), '{"type":"module"}')
  process.chdir(dir)
  try {
    const { History } = await import(pathToFileURL(modulePath).href + `?test=${Date.now()}`)
    let resolveSummary
    const agent = {
      name: 'fixture',
      prompter: { promptMemSaving: () => new Promise(resolve => { resolveSummary = resolve }) },
      self_prompter: { state: {}, prompt: '', isStopped: () => true },
      task: { taskStartTime: 123 },
      last_sender: null,
    }
    const history = new History(agent)
    const pendingAdd = history.add('fixture', 'turn one')
      .then(() => history.add('fixture', 'turn two'))
      .then(() => history.add('fixture', 'turn three'))
      .then(() => history.add('fixture', 'turn four'))
      .then(() => history.add('fixture', 'turn five'))
    await delay(0)
    assert.equal(typeof resolveSummary, 'function', 'threshold should start a memory summary')
    const shutdown = await history.saveShutdownRecord('sigterm', { reason: 'signal' })
    assert.equal(shutdown.saved, true)
    resolveSummary('late LLM memory summary')
    assert.equal(await pendingAdd, false, 'stale add should stop after shutdown invalidates its summary')
    assert.equal(history.memory, '', 'late summary must not overwrite memory')
    assert.equal(await history.add('fixture', 'late turn'), false, 'shutdown gate must reject late history writes')
    const savedPath = path.join(dir, 'bots/fixture/memory.json')
    const savedBefore = await fs.readFile(savedPath, 'utf8')
    await history.save()
    assert.equal(await fs.readFile(savedPath, 'utf8'), savedBefore, 'ordinary late save must not replace final record')
    const saved = JSON.parse(savedBefore)
    assert.equal(saved.memory, '')
    assert.deepEqual(saved.turns.slice(0, 5).map(turn => turn.content), [
      'turn one', 'turn two', 'turn three', 'turn four', 'turn five'
    ])
    assert.match(saved.turns[5].content, /shutdown \(sigterm\).*Natural language shutdown summary skipped/)
    assert.deepEqual(shutdown, { saved: true, memoryPath: './bots/fixture/memory.json' })
    assert.deepEqual(await history.saveShutdownRecord('other', {}), shutdown, 'final save outcome must be idempotent')

    let rejectSummary
    const failedHistory = new History({
      ...agent,
      name: 'fixture-failed',
      prompter: { promptMemSaving: () => new Promise((resolve, reject) => { rejectSummary = reject }) },
    })
    const rejectedAdd = failedHistory.add('fixture-failed', 'one')
      .then(() => failedHistory.add('fixture-failed', 'two'))
      .then(() => failedHistory.add('fixture-failed', 'three'))
      .then(() => failedHistory.add('fixture-failed', 'four'))
      .then(() => failedHistory.add('fixture-failed', 'five'))
    await delay(0)
    const failedFinal = await failedHistory.saveShutdownRecord('parent-stop', {})
    rejectSummary(new Error('late summary failure'))
    assert.equal(await rejectedAdd, false, 'late summary rejection must be absorbed after shutdown')
    assert.equal(failedFinal.saved, true)
    const failedSaved = JSON.parse(await fs.readFile(path.join(dir, 'bots/fixture-failed/memory.json'), 'utf8'))
    assert.deepEqual(failedSaved.turns.slice(0, 5).map(turn => turn.content), ['one', 'two', 'three', 'four', 'five'])
    return { lateSummaryInvalidated: true, lateSummaryFailureAbsorbed: true, pendingTurnsPreserved: true, finalRecordSavedWithoutLLM: true }
  } finally {
    process.chdir(previousCwd)
  }
}

async function runInitFixture(root) {
  const dir = path.join(root, 'init-agent')
  await fs.mkdir(dir, { recursive: true })
  await fs.mkdir(path.join(dir, 'stubs'))
  const initPath = path.join(dir, 'init_agent.mjs')
  let source = await fs.readFile(initSourcePath, 'utf8')
  source = source.replace("import { Agent } from '../agent/agent.js';", "import { Agent } from './stubs/agent.js';")
  source = source.replace("import { serverProxy } from '../agent/mindserver_proxy.js';", "import { serverProxy } from './stubs/proxy.js';")
  source = source.replace("import yargs from 'yargs';", "import yargs from './stubs/yargs.js';")
  await fs.writeFile(initPath, source)
  await fs.writeFile(path.join(dir, 'package.json'), '{"type":"module"}')
  await fs.writeFile(path.join(dir, 'stubs/agent.js'), `
import { appendFileSync } from 'node:fs'
export class Agent {
  async start() {
    appendFileSync(process.env.FIXTURE_TRACE, 'agent-started\\n')
    process.send?.({ type: 'fixture-agent-started' })
    return new Promise(() => {})
  }
  async shutdown(reason, options) {
    appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify({ type: 'shutdown', reason, options }) + '\\n')
    if (process.connected) process.send?.({ type: 'fixture-agent-shutdown', reason, options })
    return { reason, stopped: false, stopResult: { stopped: false, phase: 'awaiting-coding' }, saveResult: { saved: true }, ended: true }
  }
}
`)
  await fs.writeFile(path.join(dir, 'stubs/proxy.js'), `
import { appendFileSync } from 'node:fs'
export const serverProxy = {
  async connect() {
    appendFileSync(process.env.FIXTURE_TRACE, 'connect\\n')
    process.send?.({ type: 'fixture-connect-entered' })
    await new Promise(resolve => setTimeout(resolve, 300))
  },
  setAgent() { appendFileSync(process.env.FIXTURE_TRACE, 'agent-attached\\n'); process.send?.({ type: 'fixture-agent-attached' }) }
}
`)
  await fs.writeFile(path.join(dir, 'stubs/yargs.js'), `
export default function yargs(args) {
  const parser = { option() { return parser } }
  Object.defineProperty(parser, 'argv', { get() {
    const result = {}
    const keys = { '-n': 'name', '--name': 'name', '-p': 'port', '--port': 'port', '-l': 'load_memory', '--load_memory': 'load_memory', '-m': 'init_message', '--init_message': 'init_message', '-c': 'count_id', '--count_id': 'count_id' }
    for (let i = 0; i < args.length; i++) {
      const key = keys[args[i]]
      if (key) result[key] = key === 'load_memory' ? args[++i] === 'true' : args[++i]
    }
    result.count_id = Number(result.count_id || 0)
    result.port = Number(result.port || 1)
    return result
  } })
  return parser
}
`)
  const runCase = async trigger => {
    const trace = path.join(dir, `${trigger}.trace`)
    const child = spawn(nodeBinary, [initPath, '-n', 'fixture', '-p', '1', '-l', 'false', '-c', '0'], {
      env: { ...process.env, FIXTURE_TRACE: trace },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })
    const messages = []
    child.on('message', message => messages.push(message))
    try {
      if (trigger === 'early-ipc') {
        await nextMessage(child, message => message?.type === 'fixture-connect-entered')
        child.send({ type: 'mindcraft:shutdown', reason: 'early-parent-stop', restartIntent: false })
      } else {
        await nextMessage(child, message => message?.type === 'fixture-connect-entered')
        if (trigger === 'ipc') child.send({ type: 'mindcraft:shutdown', reason: 'parent-stop', restartIntent: false })
        else if (trigger === 'sigterm') child.kill('SIGTERM')
        else if (trigger === 'sigint') child.kill('SIGINT')
        else if (trigger === 'disconnect') child.disconnect()
      }
      await waitForClose(child)
      assert.equal(child.exitCode, 0, `${trigger} should shut down cleanly`)
      const traceContents = await fs.readFile(trace, 'utf8')
      assert.equal(traceContents.includes('agent-started'), false,
        `${trigger} during connection must prevent late Agent.start`)
      assert.equal(traceContents.includes('agent-attached'), false,
        `${trigger} during connection must prevent attaching a late agent`)
      const shutdown = traceContents.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line) } catch { return null }
      }).find(message => message?.type === 'shutdown')
      assert.ok(shutdown, `${trigger} should await Agent.shutdown`)
      const expectedReason = trigger === 'ipc' ? 'parent-stop'
        : trigger === 'early-ipc' ? 'early-parent-stop'
          : trigger === 'disconnect' ? 'parent-disconnect' : trigger
      assert.equal(shutdown.reason, expectedReason)
      if (trigger !== 'disconnect') {
        const exitIntent = messages.find(message => message?.type === 'mindcraft:exit-intent')
        assert.equal(exitIntent?.restartIntent, false)
        assert.equal(exitIntent?.outcome?.stopResult?.phase, 'awaiting-coding', 'init forwards serializable stop evidence to the parent')
        assert.equal(exitIntent?.outcome?.saveResult?.saved, true)
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL') } catch {}
        await waitForClose(child)
      }
    }
  }
  await runCase('early-ipc')
  await runCase('ipc')
  await runCase('sigterm')
  await runCase('sigint')
  await runCase('disconnect')
  return { earlyShutdownGate: true, shutdownDuringConnectPreventsLateAgentStart: true, signalsAndDisconnectHandled: true }
}

async function makeAgentSourceFixture(root) {
  const src = path.join(root, 'agent-source')
  const put = async (relative, content) => {
    const target = path.join(src, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
  await fs.writeFile(path.join(root, 'agent-source.package.json'), '{"type":"module"}')
  await put('src/agent/agent.js', await fs.readFile(path.resolve(__dirname, '../src/agent/agent.js')))
  await put('src/agent/library/observation_scope.js', await fs.readFile(path.resolve(__dirname, '../src/agent/library/observation_scope.js')))
  await put('src/utils/message_targets.js', await fs.readFile(path.resolve(__dirname, '../src/utils/message_targets.js')))
  await put('src/agent/action_manager.js', await fs.readFile(path.resolve(__dirname, '../src/agent/action_manager.js')))
  await put('src/agent/library/operation_context.js', await fs.readFile(path.resolve(__dirname, '../src/agent/library/operation_context.js')))
  await put('src/agent/commands/actions.js', await fs.readFile(path.resolve(__dirname, '../src/agent/commands/actions.js')))
  const stubs = {
    'src/agent/history.js': 'export class History {}',
    'src/agent/coder.js': 'export class Coder {}',
    'src/agent/vision/vision_interpreter.js': 'export class VisionInterpreter {}',
    'src/models/prompter.js': `export let examplesGate = Promise.resolve(); export function setExamplesGate(gate) { examplesGate = gate }; export class Prompter { constructor() { this.profile = {}; } getName() { return 'FixtureBot' } async initExamples() { await examplesGate } }`,
    'src/agent/modes.js': 'export function initModes() {}',
    'src/utils/mcdata.js': 'export let botCreateCount = 0; export function initBot() { botCreateCount++; return {} }',
    'src/agent/commands/index.js': `
export function containsCommand(message) { return String(message || '').match(/![A-Za-z]+/)?.[0] || null }
export function commandExists(command) { return ['!stop', '!restart', '!stfu'].includes(command) }
export function isAction(command) { return command === '!restart' }
export function truncCommandMessage(message) { return message }
export function blacklistCommands() {}
export async function executeCommand(agent, message) {
  if (message.startsWith('!restart')) return agent.requestShutdown('explicit-restart', { restartIntent: true, code: 0 })
  return null
}
`,
    'src/agent/npc/controller.js': 'export class NPCContoller {}',
    'src/agent/memory_bank.js': 'export class MemoryBank {}',
    'src/agent/places.js': 'export function createPlacesFacade() { return {} }',
    'src/agent/self_prompter.js': 'export class SelfPrompter {}',
    'src/agent/conversation.js': `export default { isOtherAgent() { return false }, responseScheduledFor() { return false }, initAgent() {}, endAllConversations() {}, isOtherAgent() { return false } }`,
    'src/utils/translator.js': `
let englishGate = Promise.resolve()
let englishTransform = text => text
export function setEnglishFixture(gate, transform = text => text) { englishGate = gate; englishTransform = transform }
export async function handleTranslation(text) { return text }
export async function handleEnglishTranslation(text) { await englishGate; return englishTransform(text) }
`,
    'src/agent/vision/browser_viewer.js': 'export function addBrowserViewer() {}',
    'src/agent/mindserver_proxy.js': 'export const serverProxy = { shutdown() {}, login() {}, getNumOtherAgents() { return 0 } }; export function sendOutputToServer() {}',
    'src/agent/settings.js': 'export default { max_commands: 1, profile: {}, task: null, blocked_actions: [], show_command_syntax: "none", only_chat_with: [], speak: false, chat_ingame: false }',
    'src/agent/tasks/tasks.js': 'export class Task {}',
    'src/agent/speak.js': 'export function speak() {}',
    'src/agent/connection_handler.js': 'export function log() {}; export function validateNameFormat() { return { success: true } }; export function handleDisconnection() { return { msg: "" } }',
    'src/agent/library/skills.js': '',
    'src/agent/conversation-actions.js': 'export default {}',
  }
  for (const [relative, content] of Object.entries(stubs)) await put(relative, content)
  await put('src/agent/commands/stubs/settings.js', 'export default { allow_insecure_coding: true, code_timeout_mins: 1, show_command_syntax: "none", only_chat_with: [], speak: false, chat_ingame: false }')
  await put('src/agent/commands/stubs/conversation.js', 'export default {}')
  await put('src/agent/commands/actions.js', (await fs.readFile(path.resolve(__dirname, '../src/agent/commands/actions.js'), 'utf8'))
    .replace("'../library/skills.js'", "'../library/skills.js'")
    .replace("'../settings.js'", "'./stubs/settings.js'")
    .replace("'../conversation.js'", "'./stubs/conversation.js'"))
  const { Agent } = await import(pathToFileURL(path.join(src, 'src/agent/agent.js')).href + `?fixture=${Date.now()}`)
  const { ActionManager } = await import(pathToFileURL(path.join(src, 'src/agent/action_manager.js')).href + `?fixture=${Date.now()}`)
  const prompterModule = await import(pathToFileURL(path.join(src, 'src/models/prompter.js')).href)
  const mcdataModule = await import(pathToFileURL(path.join(src, 'src/utils/mcdata.js')).href)
  const { actionsList } = await import(pathToFileURL(path.join(src, 'src/agent/commands/actions.js')).href + `?fixture=${Date.now()}`)
  const translator = await import(pathToFileURL(path.join(src, 'src/utils/translator.js')).href)
  return { Agent, ActionManager, actionsList, translator, prompterModule, mcdataModule }
}

function makeMinimalAgent(Agent, stop, save) {
  const events = { ends: 0, shutdowns: [], stopCalls: 0, clearCalls: 0, resumeCancels: 0 }
  const agent = Object.create(Agent.prototype)
  Object.assign(agent, {
    name: 'FixtureBot',
    managementPaused: false,
    shut_up: false,
    _messageGeneration: 0,
    _userIntentGeneration: 0,
    _recoverySeen: new Set(),
    bot: {
      output: '', interrupt_code: false,
      end() { events.ends++ },
      chat() {}, emit() {}, pathfinder: { stop() {} }, pvp: { stop() {} },
      stopDigging() {}, collectBlock: { cancelTask() {} },
      modes: { flushBehaviorLog() { return '' } },
    },
    actions: {
      executing: false,
      managementPaused: false,
      managementIntentRequired: false,
      userStopped: false,
      beginUserIntent() {},
      stop(reason) { events.stopCalls++; return stop(reason) },
      cancelResume() { events.resumeCancels++ },
    },
    self_prompter: { isActive: () => false, stop() {}, stopForShutdown() {} },
    history: {
      add() {},
      saveShutdownRecord(reason, outcome) { events.shutdowns.push({ reason, outcome }); return save(reason, outcome) },
    },
    task: { taskStartTime: 1 },
    prompter: { profile: {} },
    requestInterrupt() {},
    clearBotLogs() { events.clearCalls++; this.bot.output = ''; this.bot.interrupt_code = false },
    checkTaskDone: async () => {},
    routeResponse() {},
    openChat: async () => {},
    isIdle: () => true,
    requestShutdown(reason, options) { events.shutdowns.push({ reason, outcome: options }) },
  })
  return { agent, events }
}

async function runAgentShutdownFixtures(root) {
  const { Agent, ActionManager, actionsList, translator, prompterModule, mcdataModule } = await makeAgentSourceFixture(root)
  const failures = []
  const check = async (label, operation) => {
    try { await operation() }
    catch (error) { failures.push({ label, message: error.message }) }
  }

  await check('bounded-stop-and-idempotent-cleanup', async () => {
    let resolveStop
    const stopGate = new Promise(resolve => { resolveStop = resolve })
    const { agent, events } = makeMinimalAgent(Agent, () => stopGate, async () => ({ saved: true }))
    agent.actions.executing = true
    assert.equal(typeof agent.shutdown, 'function', 'Agent.shutdown must be implemented')
    const startedAt = Date.now()
    const first = agent.shutdown('parent-stop', { restartIntent: false, code: 0 })
    const duplicate = agent.shutdown('explicit-restart', { restartIntent: true, code: 1 })
    assert.strictEqual(first, duplicate, 'concurrent shutdown requests must share the same Promise')
    const outcome = await Promise.race([first, delay(4800).then(() => { throw new Error('shutdown exceeded supervisor grace') })])
    assert.ok(Date.now() - startedAt < 4800, 'child cleanup must finish before parent five-second deadline')
    assert.equal(outcome.reason, 'parent-stop', 'first shutdown intent remains authoritative')
    assert.equal(outcome.restartIntent, false, 'duplicate request cannot change restart intent')
    assert.equal(outcome.stopped, false, 'a pending action stop race is not successful stop evidence')
    assert.ok(outcome.stopResult?.phase || outcome.stopResult?.stopRequestedPhase, 'stop failure records phase evidence')
    assert.equal(outcome.saveResult?.saved, true)
    assert.equal(events.shutdowns.length, 1)
    assert.equal(events.ends, 1, 'Minecraft end is called once after the final record')
    resolveStop({ stopped: true, phase: 'late-settled' })
    await delay(0)
    assert.equal(events.shutdowns.length, 1, 'late stop completion cannot trigger a second final save')
    assert.equal(events.ends, 1)
  })

  await check('save-failure-does-not-skip-end', async () => {
    const { agent, events } = makeMinimalAgent(Agent, async () => ({ stopped: true }), async () => ({ saved: false, error: 'fixture disk error' }))
    assert.equal(typeof agent.shutdown, 'function', 'Agent.shutdown must be implemented')
    const outcome = await agent.shutdown('connection-lost', { restartIntent: true, code: 1 })
    assert.equal(outcome.saveResult?.saved, false, 'save failure remains visible to parent')
    assert.equal(events.ends, 1, 'save failure must not prevent Minecraft.end')
  })

  await check('real-action-manager-cooperative-stop-and-successor-gate', async () => {
    const events = { ends: 0, ownedWindowCloses: 0, foreignWindowCloses: 0, clicks: 0 }
    let shutdownPromise
    let reenteredPromise
    let saves = 0
    const agent = Object.assign(Object.create(Agent.prototype), {
      managementPaused: false,
      bot: { output: '', interrupt_code: false, end() { events.ends++ }, emit() {}, modes: { flushBehaviorLog() { return '' } } },
      self_prompter: { stopForShutdown() {} },
      clearBotLogs() { this.bot.output = ''; this.bot.interrupt_code = false },
      requestInterrupt() {},
      onRecoveryPlanActionStarted() {}, onRecoveryPlanActionSettled() {},
      isIdle() { return false },
    })
    agent.actions = new ActionManager(agent)
    const executing = agent.actions.runAction('test:owned-window', async () => {
      const current = agent.actions.getCancellationContext()
      agent.actions.setPhase('transfer', current.actionId)
      current.signal.addEventListener('abort', () => {
        reenteredPromise = agent.shutdown('reentrant-restart', { restartIntent: true, code: 1 })
      }, { once: true })
      try {
        await new Promise(resolve => current.signal.addEventListener('abort', resolve, { once: true }))
      } finally {
        events.ownedWindowCloses++
      }
    })
    while (!agent.actions.currentAction) await delay(0)
    const { agent: lifecycleAgent } = makeMinimalAgent(Agent, async () => ({ stopped: true }), async () => ({ saved: true }))
    Object.assign(agent, { history: { beginShutdown() {}, saveShutdownRecord() { saves++; return { saved: true } } }, _shutdownStarted: false, _managementGeneration: 0, _messageGeneration: 0, _managementWaiters: new Set() })
    agent.actions.agent = agent
    shutdownPromise = agent.shutdown('fixture-stop', { restartIntent: false, code: 0 })
    const result = await shutdownPromise
    assert.strictEqual(reenteredPromise, shutdownPromise, 'abort listener reentry receives the stored cleanup promise')
    const actionResult = await executing
    const successor = await agent.actions.runAction('test:successor', async () => { events.clicks++ })
    assert.equal(result.stopped, true)
    assert.equal(actionResult.interrupted, true)
    assert.equal(successor.reason, 'shutdown')
    assert.equal(events.ownedWindowCloses, 1, 'cooperative body finalizer closes its owned window')
    assert.equal(events.foreignWindowCloses, 0)
    assert.equal(events.clicks, 0, 'successor cannot click after shutdown gate')
    assert.equal(events.ends, 1)
    assert.equal(saves, 1, 'reentrant shutdown persists one final record')
  })

  await check('real-action-manager-pending-transfer-is-reported-and-not-mutated-late', async () => {
    const events = { ends: 0, clicks: 0, foreignWindowCloses: 0 }
    let releaseTransfer
    const transferGate = new Promise(resolve => { releaseTransfer = resolve })
    const agent = Object.assign(Object.create(Agent.prototype), {
      managementPaused: false,
      bot: { output: '', interrupt_code: false, end() { events.ends++ }, emit() {}, modes: { flushBehaviorLog() { return '' } } },
      self_prompter: { stopForRecovery() {} },
      clearBotLogs() { this.bot.output = ''; this.bot.interrupt_code = false },
      requestInterrupt() {},
      onRecoveryPlanActionStarted() {}, onRecoveryPlanActionSettled() {},
      isIdle() { return false },
    })
    agent.actions = new ActionManager(agent)
    const executing = agent.actions.runAction('test:pending-transfer', async () => {
      const context = agent.actions.getCancellationContext()
      agent.actions.setPhase('awaiting-transfer', context.actionId)
      await transferGate
      if (context.signal.aborted) return
      events.clicks++
      events.foreignWindowCloses++
    })
    while (!agent.actions.currentAction) await delay(0)
    const { agent: lifecycleAgent } = makeMinimalAgent(Agent, async () => ({ stopped: true }), async () => ({ saved: true }))
    Object.assign(agent, { history: lifecycleAgent.history, _shutdownStarted: false, _managementGeneration: 0, _messageGeneration: 0, _managementWaiters: new Set() })
    const outcome = await agent.shutdown('fixture-pending-transfer', { restartIntent: false, code: 0 })
    assert.equal(outcome.stopped, false, 'unsettled action must not be reported as stopped')
    assert.equal(outcome.stopResult.actionPhase, 'awaiting-transfer')
    assert.equal(events.ends, 1)
    releaseTransfer()
    await executing
    assert.equal(events.clicks, 0, 'late transfer response cannot click after cancellation')
    assert.equal(events.foreignWindowCloses, 0, 'pending action cannot close a foreign window after cancellation')
    assert.equal(events.ends, 1)
  })

  await check('late-init-examples-cannot-create-bot', async () => {
    let releaseExamples
    prompterModule.setExamplesGate(new Promise(resolve => { releaseExamples = resolve }))
    const agent = new Agent()
    const starting = agent.start(false, null, 0)
    await delay(0)
    assert.equal(mcdataModule.botCreateCount, 0)
    try { await agent.shutdown('fixture-startup-cancel', { restartIntent: false, code: 0 }) }
    finally { releaseExamples() }
    await starting
    assert.equal(mcdataModule.botCreateCount, 0, 'late initExamples completion must not create the Minecraft bot')
    prompterModule.setExamplesGate(Promise.resolve())
  })

  await check('actual-task-init-honors-shutdown-after-delay', async () => {
    const taskDir = path.join(root, 'agent-source/src/agent/tasks')
    await fs.mkdir(path.join(taskDir, 'stubs'), { recursive: true })
    let taskSource = await fs.readFile(taskSourcePath, 'utf8')
    taskSource = taskSource.replace("import { getPosition } from '../library/world.js';", "import { getPosition } from './stubs/world.js';")
    taskSource = taskSource.replace("import { ConstructionTaskValidator, Blueprint } from './construction_tasks.js';", "import { ConstructionTaskValidator, Blueprint } from './stubs/construction_tasks.js';")
    taskSource = taskSource.replace("import { CookingTaskInitiator } from './cooking_tasks.js';", "import { CookingTaskInitiator } from './cooking_fixture.mjs';")
    await fs.writeFile(path.join(taskDir, 'tasks.mjs'), taskSource)
    let cookingSource = await fs.readFile(cookingSourcePath, 'utf8')
    cookingSource = cookingSource.replace('import { getPosition } from "../library/world.js";', "import { getPosition } from './stubs/world.js';")
    await fs.writeFile(path.join(taskDir, 'cooking_fixture.mjs'), cookingSource)
    await fs.writeFile(path.join(taskDir, 'stubs/world.js'), 'export function getPosition() { return { x: 0, y: 64, z: 0 } }')
    await fs.writeFile(path.join(taskDir, 'stubs/construction_tasks.js'), 'export class ConstructionTaskValidator {}; export class Blueprint {}')
    const { Task } = await import(pathToFileURL(path.join(taskDir, 'tasks.mjs')).href + `?fixture=${Date.now()}`)
    const { CookingTaskInitiator } = await import(pathToFileURL(path.join(taskDir, 'cooking_fixture.mjs')).href + `?fixture=${Date.now()}`)
    const commands = []
    const taskAgent = { name: 'FixtureBot', count_id: 0, _shutdownStarted: false, bot: { async chat(message) { commands.push(message) } }, actions: {}, killAll() {} }
    const task = new Task(taskAgent, { task_id: 'fixture', type: 'other', goal: 'go', conversation: null, agent_count: 1, human_count: 0 })
    const starting = task.initBotTask()
    await delay(20)
    taskAgent._shutdownStarted = true
    assert.equal(await starting, false, 'delayed task startup reports cancellation')
    assert.deepEqual(commands, ['/clear FixtureBot'], 'late task startup sends no teleport or goal command')

    const managementCommands = []
    const managementAgent = { name: 'FixtureBot', count_id: 0, _managementGeneration: 0, managementPaused: false, actions: { intentEpoch: 0, managementPaused: false, managementIntentRequired: false, userStopped: false }, bot: { async chat(message) { managementCommands.push(message) } }, killAll() {} }
    const managementTask = new Task(managementAgent, { task_id: 'fixture', type: 'other', goal: 'go', conversation: null, agent_count: 1, human_count: 0 })
    const managementStart = managementTask.initBotTask()
    await delay(20)
    managementAgent.managementPaused = true
    managementAgent.actions.managementIntentRequired = true
    managementAgent.actions.userStopped = true
    managementAgent._managementGeneration++
    managementAgent.actions.intentEpoch++
    managementAgent.managementPaused = false
    managementAgent.actions.managementIntentRequired = false
    managementAgent.actions.userStopped = false
    assert.equal(await managementStart, false, 'management interruption invalidates task initialization')
    assert.deepEqual(managementCommands, ['/clear FixtureBot'], 'paused task initialization cannot teleport or issue a goal')

    let continueCooking = true
    const cookingCommands = []
    const cookingAgent = { _managementGeneration: 0, managementPaused: false, actions: { intentEpoch: 0, managementPaused: false, managementIntentRequired: false, userStopped: false } }
    const cookingTask = new Task(cookingAgent, { task_id: 'fixture', type: 'other', goal: null, conversation: null, agent_count: 1, human_count: 0 })
    const cookingGuard = cookingTask.captureTaskSetupGuard()
    const cooking = new CookingTaskInitiator({}, { entity: { position: { x: 0, y: 64, z: 0 } }, async chat(message) {
      cookingCommands.push(message)
      if (cookingCommands.length === 2) {
        cookingAgent.managementPaused = true
        cookingAgent.actions.userStopped = true
        cookingAgent._managementGeneration++
        cookingAgent.actions.intentEpoch++
        cookingAgent.managementPaused = false
        cookingAgent.actions.userStopped = false
      }
    } }, () => continueCooking && cookingGuard())
    assert.equal(await cooking.init(), false, 'cooking setup reports cancellation')
    assert.equal(cookingCommands.length, 2, 'cooking setup sends no commands after cancellation')
  })

  await check('explicit-restart-bypasses-unsettled-body', async () => {
    const { agent, events } = makeMinimalAgent(Agent, async () => ({ stopped: false, phase: 'stop-failed' }), async () => ({ saved: true }))
    agent.actions.executing = true
    agent.actions.currentAction = { id: 44, phase: 'awaiting-coding' }
    agent.beginUserIntent = () => {}
    await agent.handleMessage('FixturePlayer', '!restart', 1)
    assert.equal(events.stopCalls, 0, 'literal !restart bypasses ordinary superseded-body wait')
    assert.equal(events.shutdowns[0]?.reason, 'explicit-restart')
    assert.equal(events.shutdowns[0]?.outcome.restartIntent, true)
  })

  await check('stop-command-reports-stop-failure-truthfully', async () => {
    const { agent } = makeMinimalAgent(Agent, async () => ({ stopped: false, reason: 'stop-failed', phase: 'awaiting-coding' }), async () => ({ saved: true }))
    const response = await actionsList.find(action => action.name === '!stop').perform(agent)
    assert.doesNotMatch(response, /Agent stopped\./, 'failed cooperative stop must not claim that the agent stopped')
    assert.match(response, /still connected|stop failed|not stopped/i)
  })

  await check('late-translation-is-invalidated-and-restart-command-kept-literal', async () => {
    const { agent } = makeMinimalAgent(Agent, async () => ({ stopped: false }), async () => ({ saved: true }))
    const { EventEmitter } = require('node:events')
    agent.bot = new EventEmitter()
    agent.bot.autoEat = {}
    agent.bot.modes = { flushBehaviorLog() { return '' } }
    agent.bot.output = ''
    agent.self_prompter = { isActive: () => false }
    const handled = []
    agent.handleMessage = async (source, message) => { handled.push({ source, message }) }
    await agent._setupEventHandlers(null, null)
    let releaseTranslation
    translator.setEnglishFixture(new Promise(resolve => { releaseTranslation = resolve }), text => `translated:${text}`)
    const stale = agent.respondFunc('FixturePlayer', 'old human request')
    await delay(0)
    agent._shutdownStarted = true
    releaseTranslation()
    await stale
    const lateTranslationWasDiscarded = handled.length === 0

    agent._shutdownStarted = false
    handled.length = 0
    const restartGate = new Promise(resolve => { releaseTranslation = resolve })
    translator.setEnglishFixture(restartGate, text => `translated:${text}`)
    const restart = agent.respondFunc('FixturePlayer', '!restart')
    await delay(0)
    releaseTranslation()
    await restart
    assert.deepEqual(handled, [{ source: 'FixturePlayer', message: '!restart' }],
      'literal restart command survives translation unchanged')
    assert.equal(lateTranslationWasDiscarded, true, 'late translation must not reach handleMessage after shutdown begins')
    translator.setEnglishFixture(Promise.resolve())
  })

  assert.deepEqual(failures, [], `Agent shutdown acceptance fixture failures: ${JSON.stringify(failures)}`)
  return { boundedStop: true, idempotentCleanup: true, saveFailureReported: true, explicitRestartBypassesActionWait: true, stopResultTruthful: true }
}

async function main() {
  assert.ok(await fs.access(nodeBinary).then(() => true, () => false), `required Node 20 binary missing: ${nodeBinary}`)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-agent-shutdown-test-'))
  try {
    const history = await runHistoryFixture(root)
    const init = await runInitFixture(root)
    const agent = await runAgentShutdownFixtures(root)
    process.stdout.write(`${JSON.stringify({ history, init, agent }, null, 2)}\n`)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
