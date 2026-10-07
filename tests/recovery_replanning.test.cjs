'use strict'

const assert = require('node:assert/strict')
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { EventEmitter } = require('node:events')

const node = '/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node'

function vector(x = 0, y = 64, z = 0) {
  return {
    x, y, z,
    clone() { return vector(this.x, this.y, this.z) },
    distanceTo(other) { return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z) }
  }
}

async function makeModeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-replanning-'))
  const agentDir = path.join(root, 'src/agent')
  await mkdir(path.join(agentDir, 'library'), { recursive: true })
  await mkdir(path.join(root, 'src/utils'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}')
  await writeFile(path.join(agentDir, 'modes.js'), await readFile(path.join(__dirname, '../src/agent/modes.js')))
  await writeFile(path.join(agentDir, 'settings.js'), 'export default { narrate_behavior: false }\n')
  await writeFile(path.join(agentDir, 'library/skills.js'), 'export async function moveAway(bot, distance) { bot.fixtureMoves.push(distance); if (bot.fixtureMoveError) throw bot.fixtureMoveError }\n')
  await writeFile(path.join(agentDir, 'library/world.js'), 'export function getNearestBlock() { return null }\n')
  await writeFile(path.join(root, 'src/utils/mcdata.js'), 'export function isHostile() { return false }; export function isHuntable() { return false }\n')
  const { initModes } = await import(pathToFileURL(path.join(agentDir, 'modes.js')))
  const position = vector()
  const recoveryResults = []
  const automaticMessages = []
  const cleanKills = []
  const calls = { stop: [], run: [] }
  const manager = {
    currentActionLabel: 'action:fixture-old',
    currentAction: { id: 41, phase: 'running' },
    intentEpoch: 7,
    userStopped: false,
    resume_func: null,
    async stop(reason) {
      calls.stop.push({ reason, actionId: this.currentAction?.id ?? null })
      if (this.stopGate) return this.stopGate
      const result = this.stopResult || { stopped: true, reason, actionId: this.currentAction?.id ?? null, phase: `stopped:${reason}` }
      if (result.stopped) {
        this.currentAction = null
        this.currentActionLabel = ''
      }
      return result
    },
    getCancellationContext() {
      return this.currentAction ? { actionId: this.currentAction.id } : null
    },
    setPhase(phase, actionId) { calls.phase = { phase, actionId }; return true },
    async runAction(label, fn, options) {
      calls.run.push({ label, timeout: options.timeout })
      const actionId = 42
      this.currentAction = { id: actionId, phase: 'running' }
      this.currentActionLabel = label
      try {
        await fn()
        const result = this.recoveryResult || { success: true, interrupted: false, timedout: false, reason: null, actionId, phase: 'completed' }
        return { ...result, actionId }
      } catch (error) {
        return { success: false, message: String(error), interrupted: false, timedout: false, reason: 'error', actionId, phase: 'failed' }
      } finally {
        this.currentAction = null
        this.currentActionLabel = ''
      }
    }
  }
  const agent = {
    bot: {
      entity: { position },
      targetDigBlock: null,
      fixtureMoves: [],
      interrupt_code: false,
      modes: null,
      cleanKill(reason) { cleanKills.push(reason) },
      clearControlStates() {}
    },
    actions: manager,
    task: null,
    prompter: { getInitModes: () => null },
    self_prompter: { isActive: () => false, stopLoop() {} },
    isIdle: () => false,
    shut_up: true,
    onRecoveryResult(result) { recoveryResults.push(result) },
    handleMessage(...args) { automaticMessages.push(args) },
    openChat() {}
  }
  initModes(agent)
  const allModesOff = Object.fromEntries(['self_preservation', 'cowardice', 'hunting', 'item_collecting', 'torch_placing', 'elbow_room', 'self_defense', 'follow_player', 'cheat'].map(name => [name, false]))
  agent.bot.modes.loadJson(allModesOff)
  return { root, agent, calls, recoveryResults, automaticMessages, cleanKills }
}

async function updateUntil(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('fixture condition did not become true')
}

async function testStationaryActionIsNotInterrupted() {
  const fixture = await makeModeFixture()
  try {
    const { modes } = fixture.agent.bot
    assert.equal(modes.exists('unstuck'), false)
    modes.loadJson({ unstuck: true }) // old profiles and saved memory remain readable
    assert.equal(Object.hasOwn(modes.getJson(), 'unstuck'), false)
    assert.doesNotMatch(modes.getDocs(), /unstuck/)
    assert.doesNotMatch(modes.getMiniDocs(), /unstuck/)
    const oldNow = Date.now
    let now = oldNow()
    Date.now = () => now
    try {
      await modes.update()
      now += 60000
      await modes.update()
    } finally { Date.now = oldNow }
    assert.deepEqual(fixture.calls.stop, [])
    assert.deepEqual(fixture.calls.run, [])
    assert.deepEqual(fixture.agent.bot.fixtureMoves, [])
    assert.deepEqual(fixture.recoveryResults, [])
    assert.deepEqual(fixture.automaticMessages, [])
    assert.equal(fixture.agent.actions.currentAction.id, 41)
  } finally { await rm(fixture.root, { recursive: true, force: true }) }
}

async function makeAgentFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-agent-'))
  const put = async (relative, content) => {
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  await put('package.json', '{"type":"module"}')
  await put('src/agent/agent.js', await readFile(path.join(__dirname, '../src/agent/agent.js')))
  await put('src/agent/library/observation_scope.js', await readFile(path.join(__dirname, '../src/agent/library/observation_scope.js')))
  await put('src/utils/message_targets.js', await readFile(path.join(__dirname, '../src/utils/message_targets.js')))
  await put('src/agent/action_manager.js', await readFile(path.join(__dirname, '../src/agent/action_manager.js')))
  await put('src/agent/library/operation_context.js', await readFile(path.join(__dirname, '../src/agent/library/operation_context.js')))
  await put('src/agent/self_prompter.js', await readFile(path.join(__dirname, '../src/agent/self_prompter.js')))
  const stubs = {
    'src/agent/history.js': 'export class History {}',
    'src/agent/coder.js': 'export class Coder {}',
    'src/agent/vision/vision_interpreter.js': 'export class VisionInterpreter {}',
    'src/models/prompter.js': 'export class Prompter {}',
    'src/agent/modes.js': 'export function initModes() {}',
    'src/utils/mcdata.js': 'export function initBot() {}',
    'src/agent/commands/index.js': `
export function containsCommand(message) { return String(message || '').match(/![A-Za-z]+/)?.[0] || null }
export function commandExists(name) { return ['!stats', '!go', '!stall', '!stop', '!restart'].includes(name) }
export function isAction(name) { return name === '!go' || name === '!stall' || name === '!stop' || name === '!restart' }
export function truncCommandMessage(message) { return message }
export function blacklistCommands() {}
export async function executeCommand(agent, message) {
  if (message.startsWith('!stats')) { agent.fixtureStats++; return 'fixture stats' }
  if (message.startsWith('!stop')) { await agent.actions.stop('user'); return 'stopped' }
  if (message.startsWith('!restart')) { agent.cleanKill('restart'); return 'restarted' }
  if (message.startsWith('!go') || message.startsWith('!stall')) {
    return agent.actions.runAction('action:go', async () => {
      agent.fixtureActionStarts++
      if (agent.fixtureActionGate) await agent.fixtureActionGate
      if (message.startsWith('!go')) agent.bot.inventory.fixtureItems.push({ type: 1, name: 'stone', metadata: 0, count: 1 })
    }, { timeout: 0 })
  }
  return null
}
`,
    'src/agent/npc/controller.js': 'export class NPCContoller {}',
    'src/agent/memory_bank.js': 'export class MemoryBank {}',
    'src/agent/places.js': 'export function createPlacesFacade() { return {} }',
    'src/agent/conversation.js': `export default { isOtherAgent() { return false }, responseScheduledFor() { return false }, initAgent() {}, endAllConversations() {} }`,
    'src/utils/translator.js': 'export async function handleTranslation(text) { return text }; export async function handleEnglishTranslation(text) { return text }',
    'src/agent/vision/browser_viewer.js': 'export function addBrowserViewer() {}',
    'src/agent/mindserver_proxy.js': 'export const serverProxy = { shutdown() {}, login() {}, getNumOtherAgents() { return 0 } }; export function sendOutputToServer() {}',
    'src/agent/settings.js': 'export default { max_commands: 4, profile: {}, task: null, blocked_actions: [], show_command_syntax: "full", only_chat_with: [], speak: false, chat_ingame: false }',
    'src/agent/tasks/tasks.js': 'export class Task {}',
    'src/agent/speak.js': 'export function speak() {}',
    'src/agent/connection_handler.js': 'export function log() {}; export function validateNameFormat() { return { success: true } }; export function handleDisconnection() { return { msg: "" } }',
  }
  for (const [relative, content] of Object.entries(stubs)) await put(relative, content)
  const { Agent } = await import(pathToFileURL(path.join(root, 'src/agent/agent.js')))
  const { ActionManager } = await import(pathToFileURL(path.join(root, 'src/agent/action_manager.js')))
  const { SelfPrompter } = await import(pathToFileURL(path.join(root, 'src/agent/self_prompter.js')))
  const agent = Object.create(Agent.prototype)
  Object.assign(agent, {
    name: 'fixture-bot', shut_up: false, _userIntentGeneration: 0, _messageGeneration: 0,
    _recoverySeen: new Set(), _activeRecoveryId: null, _recoveryPromptCommand: false, _recoveryAdmissionId: null,
    fixtureStats: 0, fixtureActionStarts: 0, cleanKills: 0,
    bot: Object.assign(new EventEmitter(), {
      output: '', interrupt_code: false, inventoryUnconfirmed: false,
      entity: { position: { x: 0, y: 64, z: 0 } },
      inventory: { fixtureItems: [], items() { return [...this.fixtureItems] } },
      modes: { flushBehaviorLog() { return '' } },
    }),
    history: { add() { return true }, save() {}, getHistory() { return [] } },
    prompter: { responses: [], calls: 0, async promptConvo() { this.calls++; const response = this.responses.shift(); return await (typeof response === 'function' ? response() : response) } },
    routeResponse() {}, async openChat() {}, checkTaskDone: async () => {},
    cleanKill() { this.cleanKills++ },
    requestInterrupt() { this.bot.interrupt_code = true },
    clearBotLogs() { this.bot.output = ''; this.bot.interrupt_code = false },
    isIdle() { return !this.actions.executing },
  })
  agent.actions = new ActionManager(agent)
  agent.self_prompter = new SelfPrompter(agent)
  return { root, agent }
}

async function testAgentIntentAndRecoveryAdmission() {
  const fixture = await makeAgentFixture()
  try {
    const { agent } = fixture
    let releaseAction
    const actionTail = new Promise(resolve => { releaseAction = resolve })
    const existing = agent.actions.runAction('action:existing', async () => { await actionTail }, { timeout: 0 })
    await updateUntil(() => agent.actions.executing)
    const epoch = agent.actions.intentEpoch
    const generation = agent._messageGeneration
    await agent.handleMessage('player', '!stats')
    assert.equal(agent.fixtureStats, 1)
    assert.equal(agent.actions.executing, true, 'read-only query leaves the active action running')
    assert.equal(agent.actions.intentEpoch, epoch, 'read-only query does not create a user intent')
    assert.equal(agent._messageGeneration, generation, 'read-only query does not invalidate in-flight replies')
    releaseAction()
    await existing

    let releaseOldResponse
    agent.prompter.responses.push(() => new Promise(resolve => { releaseOldResponse = resolve }))
    agent.prompter.responses.push('I am considering this request without issuing a command.')
    const oldResponse = agent.handleMessage('player', 'do the older task')
    await updateUntil(() => typeof releaseOldResponse === 'function')
    const latestResponse = agent.handleMessage('player', 'do the newer task')
    await latestResponse
    releaseOldResponse('!go')
    assert.equal(await oldResponse, false, 'late LLM response is invalidated by a newer explicit human instruction')
    assert.equal(agent.fixtureActionStarts, 0, 'stale response cannot start an action')

    const recoveryId = 'fixture-recovery-1'
    agent._activeRecoveryId = recoveryId
    agent.actions.pauseForRecovery()
    let releaseRecoveryResponse
    agent.prompter.responses.push(() => new Promise(resolve => { releaseRecoveryResponse = resolve }))
    const recoveryPrompt = agent.handleMessage('system', 'bounded recovery request', 1, { recoveryId, generation: agent._messageGeneration })
    await updateUntil(() => typeof releaseRecoveryResponse === 'function')
    assert.equal((await agent.actions.runAction('mode:ambient', async () => {}, { timeout: 0 })).reason, 'recovery-paused')
    assert.equal((await agent.actions.runAction('npc:move', async () => {}, { timeout: 0 })).reason, 'recovery-paused')
    assert.equal((await agent.actions.resumeAction()).reason, 'recovery-paused')
    assert.equal((await agent.actions.runAction('action:parallel', async () => {}, { timeout: 0 })).reason, 'recovery-paused', 'command admission is closed while the recovery LLM is still waiting')
    const queryGeneration = agent._messageGeneration
    await agent.handleMessage('player', '!stats')
    assert.equal(agent._messageGeneration, queryGeneration, 'read-only query does not invalidate or unlock a recovery prompt')

    let releaseAdmittedAction
    agent.fixtureActionGate = new Promise(resolve => { releaseAdmittedAction = resolve })
    agent.actions.last_action_time = Date.now()
    agent.actions.recent_action_counter = 6
    releaseRecoveryResponse('!go')
    await updateUntil(() => agent.fixtureActionStarts === 1)
    assert.equal(agent._recoveryPromptCommand, true)
    assert.equal(agent._recoveryAdmissionId, recoveryId)
    assert.equal((await agent.actions.runAction('mode:parallel', async () => {}, { timeout: 0 })).reason, 'recovery-paused', 'mode actions remain blocked while a recovery action runs')
    assert.equal((await agent.actions.runAction('npc:parallel', async () => {}, { timeout: 0 })).reason, 'recovery-paused', 'NPC actions remain blocked while a recovery action runs')
    assert.equal((await agent.actions.resumeAction()).reason, 'recovery-paused', 'resume remains blocked while a recovery action runs')
    releaseAdmittedAction()
    await recoveryPrompt
    await updateUntil(() => !agent.actions.recoveryPaused)
    assert.equal(agent._activeRecoveryId, null, 'observed normal inventory progress clears the recovery gate')
    assert.equal(agent.fixtureActionStarts, 1, 'the admitted recovery plan bypasses stale rapid-repeat counters for one real action')
    agent.actions.recoveryAttempts = 1
    agent.bot.inventory.fixtureItems = [{ type: 1, metadata: 0, name: 'stone', count: 2 }]
    await agent.actions.runAction('action:stack-rearrangement', async () => {
      agent.bot.inventory.fixtureItems = [
        { type: 1, metadata: 0, name: 'stone', count: 1 },
        { type: 1, metadata: 0, name: 'stone', count: 1 },
      ]
      agent.bot.entity.position.x += 0.1
    }, { timeout: 0 })
    assert.equal(agent.actions.recoveryAttempts, 1, 'stack splitting and sub-threshold position jitter do not reset recovery budget')
  } finally { await rm(fixture.root, { recursive: true, force: true }) }
}

async function testRecoveryDedupAndUserStopRace() {
  const duplicate = await makeAgentFixture()
  try {
    const { agent } = duplicate
    agent._messageGeneration = 1
    agent.prompter.responses.push('No action available.')
    const event = { eventId: 77, kind: 'timeout', reason: 'timeout', interruptedAction: 'long-task', interruptedActionId: 12, stopResult: { stopped: true, reason: 'timeout', actionId: 12 } }
    assert.equal(agent.onRecoveryResult(event), true)
    assert.equal(agent.onRecoveryResult(event), false, 'duplicate stop callback is ignored')
    for (const [eventId, reason] of [[78, 'death'], [79, 'management'], [80, 'superseded'], [81, 'user']]) {
      assert.equal(agent.onRecoveryResult({ eventId, kind: reason, reason, stopResult: { stopped: true, reason } }), false, `${reason} does not start autonomous replanning`)
    }
    await updateUntil(() => agent.prompter.calls === 1)
    await updateUntil(() => agent._recoveryReportId === 'recovery-77')
    assert.equal(agent.prompter.calls, 1, 'one settled failure produces one internal recovery prompt')
    assert.equal(agent.actions.recoveryPaused, true, 'no-action recovery response leaves admission paused')
  } finally { await rm(duplicate.root, { recursive: true, force: true }) }

  const stopped = await makeAgentFixture()
  try {
    const { agent } = stopped
    agent._messageGeneration = 4
    agent._activeRecoveryId = 'recovery-stop-race'
    agent.actions.pauseForRecovery()
    let releaseLate
    agent.prompter.responses.push(() => new Promise(resolve => { releaseLate = resolve }))
    const pending = agent.handleMessage('system', 'replan', 1, { recoveryId: agent._activeRecoveryId, generation: agent._messageGeneration })
    await updateUntil(() => typeof releaseLate === 'function')
    await agent.handleMessage('player', '!stop')
    releaseLate('!go')
    assert.equal(await pending, false, 'user stop invalidates a late recovery model response')
    assert.equal(agent.fixtureActionStarts, 0, 'late recovery command cannot run after user stop')
    assert.equal(agent.actions.userStopped, true)
  } finally { await rm(stopped.root, { recursive: true, force: true }) }
}

async function testActionTimeoutHasSingleRecoveryOwner() {
  const fixture = await makeAgentFixture()
  try {
    const { agent } = fixture
    const results = []
    agent.onRecoveryResult = result => results.push(result)
    agent.actions._startTimeout = () => {
      setImmediate(() => { void agent.actions.stop('timeout') })
      return null
    }
    const waitForAbort = async () => {
      const { signal } = agent.actions.getCancellationContext()
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cooperatively stopped')), { once: true }))
    }

    const normalResult = await agent.actions.runAction('action:ordinary', waitForAbort, { timeout: 1 })
    await updateUntil(() => results.length === 1)
    assert.equal(normalResult.reason, 'timeout')
    assert.equal(results[0].interruptedAction, 'action:ordinary', 'ordinary action timeout still belongs to ActionManager')
  } finally { await rm(fixture.root, { recursive: true, force: true }) }
}

async function testRapidRepeatRunsOneBoundedPlan() {
  const fixture = await makeAgentFixture()
  try {
    const { agent } = fixture
    agent.prompter.responses.push('!go')
    agent.actions.last_action_time = Date.now()
    agent.actions.recent_action_counter = 5
    let repeatedBodyCalls = 0
    const fastLoop = await agent.actions.runAction('action:repeat', async () => { repeatedBodyCalls++ }, { timeout: 0 })
    assert.equal(fastLoop.reason, 'rapid-repeat')
    await updateUntil(() => agent.fixtureActionStarts === 1 && !agent.actions.executing)
    assert.equal(repeatedBodyCalls, 0, 'the over-limit repeated body does not run')
    assert.equal(agent.fixtureActionStarts, 1, 'one new plan runs after the loop is stopped')
    assert.equal(agent.actions.recoveryPaused, false, 'observed inventory progress reopens admission')
    assert.equal(agent.actions.recoveryAttempts, 0, 'budget resets on observed normal progress')
  } finally { await rm(fixture.root, { recursive: true, force: true }) }
}

async function testRecoveryBudgetExhaustionStaysConnected() {
  const fixture = await makeAgentFixture()
  try {
    const { agent } = fixture
    agent.prompter.responses.push('!stall', '!stall')
    const event = { eventId: 88, kind: 'timeout', reason: 'timeout', interruptedAction: 'stalled-goal', interruptedActionId: 14, stopResult: { stopped: true, reason: 'timeout', actionId: 14 } }
    agent.onRecoveryResult(event)
    await updateUntil(() => agent.prompter.calls === 2 && agent._recoveryReportId === 'recovery-88')
    assert.equal(agent.fixtureActionStarts, 2, 'the small plan budget permits two distinct attempts')
    assert.equal(agent.actions.recoveryAttempts, 3)
    assert.equal(agent.actions.recoveryPaused, true)
    assert.equal(agent.actions.executing, false)
    assert.equal(agent.cleanKills, 0, 'budget exhaustion keeps the agent process connected')
  } finally { await rm(fixture.root, { recursive: true, force: true }) }
}

async function testModelCannotRestartButHumanCommandCan() {
  const fixture = await makeAgentFixture()
  try {
    const { agent } = fixture
    agent.prompter.responses.push('!restart', '!restart')
    await agent.handleMessage('player', 'Should you restart now?', 1)
    await agent.handleMessage('system', 'Continue and decide what to do.', 1)
    assert.equal(agent.cleanKills, 0, 'neither human-request LLM output nor system LLM output may restart the process')
    await agent.handleMessage('player', '!restart', 1)
    assert.equal(agent.cleanKills, 1, 'the literal forced human restart command remains available')
  } finally { await rm(fixture.root, { recursive: true, force: true }) }
}

async function main() {
  const source = await readFile(path.join(__dirname, '../src/agent/modes.js'), 'utf8')
  assert.doesNotMatch(source, /agent\.cleanKill\(/, 'modes do not kill the bot from a detached timer')
  assert.match(source, /finally \{\s*mode\.active = false;/, 'all recovery outcomes clear mode.active')
  assert.match(source, /agent\.handleMessage\('system'/, 'mode-generated replanning stays an internal message')
  await testStationaryActionIsNotInterrupted()
  await testAgentIntentAndRecoveryAdmission()
  await testRecoveryDedupAndUserStopRace()
  await testActionTimeoutHasSingleRecoveryOwner()
  await testRapidRepeatRunsOneBoundedPlan()
  await testRecoveryBudgetExhaustionStaysConnected()
  await testModelCannotRestartButHumanCommandCan()
  console.log('recovery replanning tests passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
