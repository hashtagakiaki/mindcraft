'use strict'

const assert = require('node:assert/strict')
const { mkdtemp, readFile, rm, mkdir, writeFile, symlink } = require('node:fs/promises')
const { createRequire } = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createHash, randomUUID } = require('node:crypto')
const http = require('node:http')
const { EventEmitter } = require('node:events')
const { moduleRoot } = require('./dependency_root.cjs')

const upstreamModules = moduleRoot()
const dependencyRequire = createRequire(path.join(upstreamModules, 'package.json'))
const { Server } = dependencyRequire('socket.io')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, message, timeout = 5000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (predicate()) return
    await delay(10)
  }
  throw new Error(message)
}
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function fingerprint(value) {
  const stable = item => Array.isArray(item) ? item.map(stable) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])])) : item
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-management-reconnect-'))
  const clients = []
  let ioServer
  let httpServer
  let mutationCount = 0
  let holdMutationAck = null
  let connects = 0
  let registrations = 0
  let logins = 0
  let commandsReceived = 0
  let agentInstructions = 0
  let activeSocket = null
  const settings = { profile: { name: 'botA' }, place_memory_enabled: true, place_world_id: '33333333-3333-4333-8333-333333333333' }
  const control = { generation: randomUUID(), mismatch: false, settingsMismatch: false, metadataPatch: null, pauseResult: null, restoreReject: false, restoreGate: null, settings }
  try {
    const proxyDir = path.join(temp, 'proxy')
    await mkdir(proxyDir, { recursive: true })
    await writeFile(path.join(temp, 'package.json'), '{"type":"module"}')
    await symlink(upstreamModules, path.join(temp, 'node_modules'), 'dir')
    const source = await readFile(path.join(__dirname, '../src/agent/mindserver_proxy.js'), 'utf8')
    const transformed = source.replace('const PLACE_RPC_TIMEOUT_MS = 5000;', 'const PLACE_RPC_TIMEOUT_MS = 150;')
      .replace("import { getFullState } from './library/full_state.js';", "import { getFullState } from './full_state.js';")
      .replace("import { PlaceRpcError, requestPlaceRpc } from '../mindcraft/place_rpc.js';", "import { PlaceRpcError, requestPlaceRpc } from './place_rpc.js';")
    await writeFile(path.join(proxyDir, 'mindserver_proxy.mjs'), transformed)
    await writeFile(path.join(proxyDir, 'conversation.js'), 'export default { receiveFromBot(){}, updateAgents(){} };')
    await writeFile(path.join(proxyDir, 'settings.js'), 'export function setSettings(value){ globalThis.fixtureSettings = structuredClone(value); }')
    await writeFile(path.join(proxyDir, 'full_state.js'), 'export function getFullState(){ return {}; }')
    await writeFile(path.join(proxyDir, 'place_rpc.js'), `export class PlaceRpcError extends Error { constructor(code, message) { super(message); this.code = code; } }\nexport function requestPlaceRpc(socket, operation, payload, expectedRevision, timeoutMs) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'RPC_TIMEOUT' })), timeoutMs); socket.emit('place:request', { operation, payload, expectedRevision }, response => { clearTimeout(timer); response?.ok ? resolve(response) : reject(Object.assign(new Error(response?.error?.message || 'RPC failed'), { code: response?.error?.code })); }); }); }`)
    const { MindServerProxy } = await import(pathToFileURL(path.join(proxyDir, 'mindserver_proxy.mjs')).href)
    MindServerProxy.instance = null

    httpServer = http.createServer()
    ioServer = new Server(httpServer, { transports: ['websocket'] })
    ioServer.on('connection', socket => {
      connects++
      activeSocket = socket
      let registered = false
      socket.on('get-settings', (name, ack) => {
        let data = settings
        if (control.mismatch) data = { ...settings, place_world_id: '44444444-4444-4444-8444-444444444444' }
        else if (control.settingsMismatch) data = { ...settings, task: 'changed setting' }
        ack({ settings: data, management: {
          generation: control.generation, agentName: name,
          placeMemoryEnabled: data.place_memory_enabled, placeWorldId: data.place_world_id,
          settingsFingerprint: fingerprint(data), ...control.metadataPatch
        } })
      })
      socket.on('connect-agent-process', name => { if (name === 'botA') { registered = true; registrations++ } })
      socket.on('login-agent', name => { if (registered && name === 'botA') logins++ })
      socket.on('chat-message', () => { commandsReceived++ })
      socket.on('place:request', (_request, ack) => {
        mutationCount++
        if (holdMutationAck) holdMutationAck = ack
        else ack({ ok: true, value: null, revision: mutationCount })
      })
    })
    await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve))
    const port = httpServer.address().port
    const proxy = new MindServerProxy({ ioFactory: (url) => {
      const client = dependencyRequire('socket.io-client').io(url, { transports: ['websocket'], reconnectionDelay: 20, reconnectionDelayMax: 40, timeout: 1000 })
      clients.push(client)
      return client
    } })
    globalThis.proxyFixture = proxy
    globalThis.translationGate = null
    const agentSourceRoot = path.join(temp, 'agent-source')
    await mkdir(agentSourceRoot, { recursive: true })
    const putAgentFixture = async (relative, content) => {
      const target = path.join(agentSourceRoot, relative)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content)
    }
    await writeFile(path.join(agentSourceRoot, 'package.json'), '{"type":"module"}')
    await putAgentFixture('src/agent/agent.js', await readFile(path.join(__dirname, '../src/agent/agent.js')))
    await putAgentFixture('src/utils/message_targets.js', await readFile(path.join(__dirname, '../src/utils/message_targets.js')))
    await putAgentFixture('src/agent/action_manager.js', await readFile(path.join(__dirname, '../src/agent/action_manager.js')))
    await putAgentFixture('src/agent/library/operation_context.js', await readFile(path.join(__dirname, '../src/agent/library/operation_context.js')))
    await putAgentFixture('src/agent/self_prompter.js', await readFile(path.join(__dirname, '../src/agent/self_prompter.js')))
    const agentStubs = {
      'src/agent/history.js': 'export class History {}',
      'src/agent/coder.js': 'export class Coder {}',
      'src/agent/vision/vision_interpreter.js': 'export class VisionInterpreter {}',
      'src/models/prompter.js': 'export class Prompter {}',
      'src/agent/modes.js': 'export function initModes() {}',
      'src/utils/mcdata.js': 'export function initBot() {}',
      'src/agent/commands/index.js': `
export function containsCommand(message) { return String(message || '').match(/![A-Za-z]+/)?.[0] || null }
export function commandExists(name) { return ['!stats', '!go', '!stop', '!restart'].includes(name) }
export function isAction(name) { return ['!go', '!stop', '!restart'].includes(name) }
export function truncCommandMessage(message) { return message }
export function blacklistCommands() {}
export async function executeCommand(agent, message) {
  if (message.startsWith('!stats')) { agent.fixtureStats++; return 'fixture stats' }
  if (message.startsWith('!stop')) { await agent.actions.stop('user'); return 'stopped' }
  if (message.startsWith('!restart')) { agent.cleanKill('restart'); return 'restarted' }
  if (message.startsWith('!go')) return agent.actions.runAction('action:go', async () => { agent.worldMutations++ }, { timeout: 0 })
  return null
}
`,
      'src/agent/npc/controller.js': 'export class NPCContoller {}',
      'src/agent/memory_bank.js': 'export class MemoryBank {}',
      'src/agent/places.js': 'export function createPlacesFacade() { return {} }',
      'src/agent/conversation.js': 'export default { isOtherAgent() { return false }, otherAgentInGame() { return false }, responseScheduledFor() { return false }, initAgent() {}, endAllConversations() {} }',
      'src/utils/translator.js': 'export async function handleTranslation(text) { return text }; export async function handleEnglishTranslation(text) { return globalThis.translationGate ? globalThis.translationGate(text) : text }',
      'src/agent/vision/browser_viewer.js': 'export function addBrowserViewer() {}',
      'src/agent/mindserver_proxy.js': 'export const serverProxy = globalThis.proxyFixture; export function sendOutputToServer() {}',
      'src/agent/settings.js': 'export default { max_commands: 4, profile: {}, task: null, blocked_actions: [], show_command_syntax: "none", only_chat_with: [], speak: false, chat_ingame: false }',
      'src/agent/tasks/tasks.js': 'export class Task {}',
      'src/agent/speak.js': 'export function speak() {}',
      'src/agent/connection_handler.js': 'export function log() {}; export function validateNameFormat() { return { success: true } }; export function handleDisconnection() { return { msg: "" } }'
    }
    for (const [relative, content] of Object.entries(agentStubs)) await putAgentFixture(relative, content)
    const { Agent } = await import(pathToFileURL(path.join(agentSourceRoot, 'src/agent/agent.js')).href)
    const { ActionManager } = await import(pathToFileURL(path.join(agentSourceRoot, 'src/agent/action_manager.js')).href)
    const { SelfPrompter } = await import(pathToFileURL(path.join(agentSourceRoot, 'src/agent/self_prompter.js')).href)
    const agent = new Agent()
    Object.assign(agent, {
      name: 'botA', shut_up: false, _userIntentGeneration: 0, _messageGeneration: 0,
      _recoverySeen: new Set(), _activeRecoveryId: null, _recoveryPromptCommand: false, _recoveryAdmissionId: null,
      fixtureStats: 0, worldMutations: 0, killed: 0, restored: 0, paused: 0,
      bot: Object.assign(new EventEmitter(), {
        output: '', interrupt_code: false, inventoryUnconfirmed: false,
        autoEat: {},
        entity: { position: { x: 0, y: 64, z: 0 } },
        inventory: { items: () => [] },
        modes: { flushBehaviorLog() { return '' }, async update() { agent.modeTicks++ } }
      }),
      history: { async add() {}, save() {}, getHistory() { return [] } },
      prompter: { responses: [], calls: 0, pendingPrompt: null, async promptConvo() { this.calls++; if (this.pendingPrompt) { const pending = this.pendingPrompt; this.pendingPrompt = null; return pending.promise } return this.responses.shift() || 'No new command.' } },
      modeTicks: 0, routeResponse() {}, async openChat() {}, checkTaskDone: async () => {},
      npc: { data: { goals: [{ text: 'stale NPC goal' }], curr_goal: { text: 'stale NPC goal' }, do_set_goal: true }, temp_goals: [{ text: 'stale temporary goal' }] },
      cleanKill() { this.killed++ },
      requestInterrupt() { this.bot.interrupt_code = true },
      clearBotLogs() { this.bot.output = ''; this.bot.interrupt_code = false },
      isIdle() { return !this.actions.executing }
    })
    agent.actions = new ActionManager(agent)
    agent.self_prompter = new SelfPrompter(agent)
    const rawHandleMessage = agent.handleMessage.bind(agent)
    agent.handleMessage = (...args) => { agentInstructions++; return rawHandleMessage(...args) }
    await agent._setupEventHandlers({ last_sender: 'Someone' }, null)
    const rawPause = agent.pauseManagement.bind(agent)
    agent.pauseManagement = reason => {
      agent.paused++
      return rawPause(reason).then(result => control.pauseResult ?? result)
    }
    const rawRestore = agent.restoreManagement.bind(agent)
    agent.restoreManagement = async meta => {
      agent.restoreStarted = true
      if (control.restoreGate) await control.restoreGate
      if (control.restoreReject) return { ready: false }
      const result = rawRestore(meta)
      if (result) agent.restored++
      return result
    }
    await proxy.connect('botA', port)
    proxy.setAgent(agent)
    assert.equal(proxy.managementReady, true)
    proxy.login()
    await until(() => registrations === 1 && logins === 1, 'initial registration/login missing')

    // A mutation whose acknowledgement is lost is returned as uncertain and is never replayed.
    holdMutationAck = () => {}
    const uncertain = proxy.rememberPlace({ name: 'one shot' })
    const uncertainAssertion = assert.rejects(uncertain, { code: 'RESULT_UNKNOWN' })
    await until(() => mutationCount === 1, 'mutation not received')
    const ack = holdMutationAck
    holdMutationAck = null
    control.generation = randomUUID()
    clients[0].io.engine.close()
    await until(() => !proxy.managementReady, 'proxy did not pause on disconnect')
    proxy.requestPlace('remember', { place: { name: 'must not buffer' } }).catch(() => {})
    proxy.socket.sendBuffer.push(['chat-message', 'botA', { message: 'old command' }])
    await until(() => proxy.managementReady && registrations === 2 && logins === 2, 'proxy did not re-register after reconnect')
    assert.equal(proxy.serverGeneration, control.generation, 'server generation rotation incorrectly prevented same-namespace recovery')
    await delay(100)
    assert.equal(mutationCount, 1, 'old mutation was replayed')
    assert.equal(commandsReceived, 0, 'disconnected command was replayed')
    ack({ ok: true, value: { revision: 1 }, revision: 1 })
    await uncertainAssertion
    assert.equal(agent.killed, 0, 'management loss killed the Minecraft agent')
    assert.equal(agent.restored, 1, 'management gate did not restore exactly once after the first reconnect')
    assert.equal(agent.actions.managementIntentRequired, true, 'restoring transport must still require a fresh user intent')
    assert.deepEqual(agent.npc.data.goals, [], 'management pause retained old NPC goals')
    assert.equal(agent.npc.data.curr_goal, null)
    assert.deepEqual(agent.npc.temp_goals, [])
    assert.equal((await agent.actions.resumeAction()).reason, 'management-intent-required')
    assert.equal((await agent.actions.runAction('npc:retained-goal', async () => { agent.worldMutations++ }, { timeout: 0 })).reason, 'management-intent-required')
    await agent.update(300)
    assert.equal(agent.modeTicks, 0, 'ambient modes stayed stopped until a fresh intent')
    assert.equal(agent.worldMutations, 0)

    // A completed LLM reply from a prompt already in flight is invalidated by
    // disconnect and cannot become a new command after recovery.
    const delayedReply = deferred()
    agent.prompter.pendingPrompt = delayedReply
    const promptCallsBeforeDisconnect = agent.prompter.calls
    agent.bot.emit('chat', 'Player', 'instruction whose LLM reply will be stale')
    await until(() => agent.prompter.calls > promptCallsBeforeDisconnect, 'old LLM request did not start')
    clients[0].io.engine.close()
    await until(() => !proxy.managementReady, 'disconnect during LLM request did not close readiness')
    await until(() => proxy.managementReady && registrations === 3, 'management did not recover after invalidating LLM reply')
    delayedReply.resolve('!go')
    await delay(50)
    assert.equal(agent.actions.managementIntentRequired, true, 'late LLM response cleared the fresh-intent latch')
    assert.equal(agent.worldMutations, 0, 'late LLM response started a mutation after reconnect')

    // An active cooperative action settles on the real management disconnect;
    // queued work and a retained resume candidate cannot cross the boundary.
    agent.actions.beginUserIntent()
    let bodyContext
    let actionBodySettled = false
    const activeAction = agent.actions.runAction('active-management-work', async () => {
      bodyContext = agent.actions.getCancellationContext()
      await new Promise(resolve => bodyContext.signal.addEventListener('abort', resolve, { once: true }))
      if (!bodyContext.signal.aborted) agent.worldMutations++
      actionBodySettled = true
    }, { timeout: 0 })
    await until(() => agent.actions.executing, 'cooperative action did not start')
    bodyContext = agent.actions.getCancellationContext()
    let releaseTransition
    agent.actions.transition = new Promise(resolve => { releaseTransition = resolve })
    agent.actions.resume_func = async () => { agent.worldMutations++ }
    agent.actions.resume_name = 'stale-resume-candidate'
    const queuedSuccessor = agent.actions.runAction('queued-management-successor', async () => { agent.worldMutations++ }, { timeout: 0 })
    clients[0].io.engine.close()
    await until(() => !proxy.managementReady, 'active-action disconnect did not close management readiness')
    await until(() => actionBodySettled, 'management stop did not settle the cooperative action body')
    releaseTransition()
    const queuedResult = await queuedSuccessor
    const [activeResult] = await Promise.all([activeAction])
    await until(() => proxy.managementReady && registrations === 4, 'management did not recover after stopping active work')
    assert.equal(bodyContext.signal.aborted, true, 'active action cancellation context was not aborted')
    assert.equal(activeResult.reason, 'management')
    assert.equal(queuedResult.reason, 'management-paused')
    assert.equal(agent.actions.resume_func, null, 'management pause retained a resume candidate')
    assert.equal((await agent.actions.resumeAction()).reason, 'management-intent-required')
    assert.equal(agent.worldMutations, 0, 'active/queued/resume work mutated after management disconnect')
    assert.equal(agent.killed, 0, 'cooperative management stop killed the Minecraft agent')

    // A pre-disconnect message resolving translation after recovery is stale.
    let translationStarted
    const translationStartedPromise = new Promise(resolve => { translationStarted = resolve })
    let releaseTranslation
    globalThis.translationGate = text => new Promise(resolve => { releaseTranslation = () => resolve(text); translationStarted() })
    agent.bot.emit('chat', 'Player', 'message received before management loss')
    await translationStartedPromise
    clients[0].io.engine.close()
    await until(() => !proxy.managementReady, 'disconnect during chat translation did not close readiness')
    await until(() => proxy.managementReady && registrations === 5, 'management did not recover after delayed chat arrived')
    releaseTranslation()
    await delay(50)
    assert.equal(agent.actions.managementIntentRequired, true, 'pre-disconnect translated message cleared the fresh-intent latch')
    assert.equal(agent.worldMutations, 0, 'pre-disconnect message started a mutation after recovery')
    globalThis.translationGate = null

    agent.prompter.responses.push('!go')
    agent.bot.emit('chat', 'Player', 'please continue with a new instruction')
    await until(() => agent.worldMutations === 1, 'fresh chat instruction did not start an action after recovery')
    assert.equal(agent.worldMutations, 1, 'a fresh explicit instruction can start a new action after recovery')

    control.mismatch = true
    clients[0].io.engine.close()
    await until(() => !proxy.managementReady, 'proxy did not pause before mismatch check')
    await until(() => connects >= 6, 'mismatch reconnect was not attempted')
    await delay(100)
    assert.equal(proxy.managementReady, false, 'namespace mismatch opened management gate')
    assert.equal(agent.restored, 4, 'mismatched namespace restored the agent')
    assert.equal(agent.killed, 0)
    assert.equal(agent.managementPaused, true)
    agent.bot.emit('chat', 'Player', '!stop')
    await until(() => agent.actions.userStopped, 'literal !stop did not pass through the real chat listener while management was down')
    assert.equal(agent.actions.userStopped, true, 'local user stop is recorded while management is down')
    const instructionsBeforeStaleCommand = agentInstructions
    activeSocket.emit('send-message', { from: 'user', message: 'stale instruction' })
    await delay(30)
    assert.equal(agentInstructions, instructionsBeforeStaleCommand, 'instruction reached the agent while namespace was mismatched')

    control.mismatch = false
    control.settingsMismatch = true
    clients[0].io.engine.close()
    await until(() => connects >= 7, 'settings-fingerprint mismatch reconnect was not attempted')
    await delay(80)
    assert.equal(proxy.managementReady, false, 'changed settings with the same place scope opened the gate')
    assert.equal(agent.managementPaused, true)
    assert.equal(agent.restored, 4)

    // Malformed generation/fingerprint must be rejected before registration or applying settings.
    control.settingsMismatch = false
    control.metadataPatch = { generation: null, settingsFingerprint: 'bad-hash' }
    const previousRegistrations = registrations
    const previousSettings = globalThis.fixtureSettings
    clients[0].io.engine.close()
    await until(() => connects >= 8 && !proxy.managementReady, 'malformed metadata reconnect was not rejected')
    await delay(80)
    assert.equal(registrations, previousRegistrations, 'malformed metadata registered the agent')
    assert.strictEqual(globalThis.fixtureSettings, previousSettings, 'malformed metadata changed agent settings')
    assert.equal(agent.managementPaused, true)

    // A well-formed but false settings hash is rejected before registration/application.
    control.metadataPatch = { settingsFingerprint: 'a'.repeat(64) }
    const registrationsBeforeBadHash = registrations
    clients[0].io.engine.close()
    await until(() => connects >= 9, 'bad fingerprint reconnect was not attempted')
    await delay(80)
    assert.equal(registrations, registrationsBeforeBadHash, 'false settings fingerprint registered the agent')
    assert.strictEqual(globalThis.fixtureSettings, previousSettings, 'false settings fingerprint changed agent settings')
    assert.equal(proxy.managementReady, false)

    // Recovery leaves a user stop intact. Only a later explicit intent can clear it.
    control.metadataPatch = null
    control.settingsMismatch = false
    const beforeUserStopRecovery = connects
    clients[0].io.engine.close()
    await until(() => connects > beforeUserStopRecovery && proxy.managementReady, 'same-scope recovery after local user stop failed')
    assert.equal(agent.actions.userStopped, true, 'management restore cleared userStopped')
    assert.equal(agent.actions.managementIntentRequired, true)
    agent.prompter.responses.push('!go')
    agent.bot.emit('chat', 'Player', 'I have a new explicit goal')
    await until(() => agent.worldMutations === 2, 'fresh chat intent did not clear user stop after recovery')
    assert.equal(agent.actions.userStopped, false, 'fresh intent did not clear the explicit user stop')
    assert.equal(agent.worldMutations, 2)

    // A failed cooperative stop prevents registration and readiness.
    control.pauseResult = { stopped: false }
    const registrationsBeforeStopFailure = registrations
    clients[0].io.engine.close()
    await until(() => connects >= 11, 'stop-failure reconnect was not attempted')
    await delay(80)
    assert.equal(proxy.managementReady, false)
    assert.equal(registrations, registrationsBeforeStopFailure, 'agent was registered despite an unsettled action')
    assert.equal(agent.managementPaused, true)

    // A server rejection from restoreManagement leaves the gate closed.
    control.pauseResult = null
    control.restoreReject = true
    clients[0].io.engine.close()
    await until(() => connects >= 12, 'restore-rejection reconnect was not attempted')
    await delay(100)
    assert.equal(proxy.managementReady, false)
    assert.equal(agent.managementPaused, true)

    // Disconnect while restore is pending. A late restore may not reopen the gate.
    control.restoreReject = false
    agent.restoreStarted = false
    let releaseRestore
    control.restoreGate = new Promise(resolve => { releaseRestore = resolve })
    clients[0].io.engine.close()
    await until(() => agent.restoreStarted && registrations > registrationsBeforeStopFailure, 'async restore did not start')
    const instructionsBeforeRestoreCommand = agentInstructions
    activeSocket.emit('send-message', { from: 'user', message: 'instruction during restore' })
    await delay(30)
    assert.equal(agentInstructions, instructionsBeforeRestoreCommand, 'instruction reached the agent while restore was pending')
    clients[0].io.engine.close()
    await until(() => !proxy.managementReady, 'disconnect during restore did not close readiness')
    control.metadataPatch = { generation: null }
    await until(() => connects >= 14, 'second connection after restore race was not attempted')
    releaseRestore()
    await delay(100)
    assert.equal(proxy.managementReady, false, 'stale async restore opened management readiness')
    assert.equal(agent.managementPaused, true, 'stale async restore opened the agent gate')
    assert.equal(agent.worldMutations, 2, 'autonomous work ran after reconnect without a fresh intent')
    console.log(JSON.stringify({ connects, registrations, logins, mutationCount, commandsReceived, agentInstructions, worldMutations: agent.worldMutations, killed: agent.killed, restored: agent.restored, namespaceMismatchPaused: true, malformedMetadataRejected: true, stopFailurePaused: true, restoreRejectionPaused: true, staleRestorePaused: true, userStopPreserved: true }))
  } finally {
    for (const client of clients) client.close()
    if (ioServer) await new Promise(resolve => ioServer.close(resolve))
    if (httpServer?.listening) await new Promise(resolve => httpServer.close(resolve))
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
