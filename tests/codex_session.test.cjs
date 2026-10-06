'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')
const { moduleRoot } = require('./dependency_root.cjs')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const repo = path.resolve(__dirname, '..')
const node = process.execPath
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function until(check) { for (let i = 0; i < 300; i++) { if (check()) return; await delay(10) } throw new Error('fixture condition timed out') }

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mindcraft-native-test-'))
  const oldCwd = process.cwd()
  const oldBin = process.env.MINDCRAFT_CODEX_BIN
  try {
    await fs.cp(path.join(repo, 'src'), path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}')
    await fs.writeFile(path.join(root, 'settings.js'), 'export default {}; export function setSettings() {}')
    await fs.symlink(moduleRoot(), path.join(root, 'node_modules'))
    await fs.mkdir(path.join(root, 'bots'))
    for (const file of ['bots/execTemplate.js', 'bots/lintTemplate.js', 'eslint.config.js']) await fs.copyFile(path.join(repo, file), path.join(root, file))
    process.chdir(root)
    const load = relative => import(pathToFileURL(path.join(root, relative)))
    const { default: settings } = await load('src/agent/settings.js')
    Object.assign(settings, { agent_runtime: 'codex-session', allow_insecure_coding: true, codex_session: { stall_timeout_ms: 60, action_timeout_ms: 2000, output_limit: 16000 }, language: 'en' })
    const { CodexRuntime: NativeCodexRuntime, validateCodexRuntime, observedState } = await load('src/agent/codex_runtime.js')
    // Scripted model decisions use the same wait-for-tool-result boundary as app-server.
    // Existing multi-step scripts remain useful for host ownership/error/budget scenarios.
    class CodexRuntime extends NativeCodexRuntime {
      constructor(agent, options = {}) {
        const factory = options.makeSession
        super(agent, !factory ? options : { ...options, makeSession: opts => {
          const session = factory(opts)
          const decide = session.runTurn.bind(session)
          session.threadId ||= 'fixture-thread'
          session.runTurn = async input => {
            while (true) {
              const decision = await decide(input)
              if (!decision.operation) return decision
              const result = await decision.operation
              input = (await opts.prepareResult(result)).contentItems[0].text
            }
          }
          return session
        } })
      }
    }
    const { operationFactsSummary, beginOwnedWait, markOwnedWaitProgress, finishOwnedWait } = await load('src/agent/library/operation_context.js')
    const { ActionManager } = await load('src/agent/action_manager.js')
    const { Coder } = await load('src/agent/coder.js')
    const { CodexSession } = await load('src/process/codex_session.js')
    const { History } = await load('src/agent/history.js')
    const { Agent } = await load('src/agent/agent.js')
    const { EventEmitter } = require('node:events')
    assert.throws(() => validateCodexRuntime({ model: 'openai/gpt-6-luna' }), /explicit codex/)
    settings.allow_insecure_coding = false
    assert.throws(() => validateCodexRuntime({ model: 'codex/gpt-6-luna' }), /allow_insecure/)
    settings.allow_insecure_coding = true
    settings.codex_session.stall_timeout_ms = 0
    assert.throws(() => validateCodexRuntime({ model: 'codex/gpt-6-luna' }), /Invalid/)
    settings.codex_session.stall_timeout_ms = 60
    const rules = [], routed = [], rows = []
    const makeAgent = name => {
      const agent = Object.create(Agent.prototype)
      agent.name = name
      agent._messageGeneration = 0
      agent._managementGeneration = 0
      agent.checkTaskDone = async () => false
      agent.bot = Object.assign(new EventEmitter(), { output: '', interrupt_code: false, players: {}, game: { dimension: 'overworld' }, entity: { position: { x: 0, y: 64, z: 0 } }, inventory: { items: () => [] }, modes: { isOn: () => false, pause() {}, unpause() {}, flushBehaviorLog: () => '' } })
      agent.clearBotLogs = () => { agent.bot.output = ''; agent.bot.interrupt_code = false }
      agent.requestInterrupt = () => { agent.bot.interrupt_code = true; agent.interrupt?.() }
      agent.prompter = { profile: { model: 'codex/gpt-6-luna' }, skill_libary: { getAllSkillDocs: async () => ['skills.wait\nWait for a bounded number of milliseconds.', 'skills.goToPlayer\nNavigate to a named player and return false when it is missing.', 'communication.sendToBot\nSend a bounded peer message into an authenticated native task inbox.', 'diagnostics.lastTask\nRead bounded previous task diagnostics.'] }, withBotRules: async text => { rules.push(text); return text + '\nCURRENT RULES' } }
      agent.history = { memory: 'vision used to be unavailable', invalidations: 0, invalidateSummaries() { this.invalidations++ }, getHistory: () => [{ role: 'user', content: 'test' }], add: async (...args) => rows.push(args), checkpointAdd: async (...args) => { rows.push(args); await agent.history.save(); return { saved: true } }, save: async () => {} }
      agent.routeResponse = (source, text) => routed.push(text)
      agent.self_prompter = { state: null, prompt: '', stopForRecovery() {}, isStopped: () => true, isActive: () => false, shouldInterrupt: () => false }
      agent.actions = new ActionManager(agent)
      agent.coder = new Coder(agent)
      return agent
    }
    const agent = makeAgent('NativeFixture')
    const nativeObservation = observedState(agent.bot, agent.getObservationScope())
    assert.equal(nativeObservation.observationScope.dimension, 'overworld')
    assert.equal(nativeObservation.observationScope.worldConnectionGeneration, null,
      'native snapshots do not relabel a management socket epoch as a Minecraft connection generation')
    assert.equal(nativeObservation.observationScope.managementConnectionGeneration, 0)
    assert.equal(nativeObservation.observationScope.managementConnectionReady, false)
    assert.equal(nativeObservation.observationScope.managementServerGeneration, null)
    assert.match(nativeObservation.observationScope.observedAt, /^\d{4}-\d\d-\d\dT/)
    await until(() => agent.coder.code_template && agent.coder.code_lint_template)
    const result = await agent.actions.runAction('compound', () => agent.coder.executeCode('log(bot, "first");\nawait Promise.resolve();\nlog(bot, "second");'), { timeout: 0, outputLimit: 16000 })
    assert.equal(result.success, true)
    assert.match(result.message, /first[\s\S]*second/)
    settings.generated_code_fail_on_false = []
    const falseDefault = await agent.actions.runAction('generated-false-default', () => agent.coder.executeCode('await skills.goToPlayer(bot, "missing");\nlog(bot, "continued after false");'), { timeout: 0 })
    assert.equal(falseDefault.success, true, 'default SDK mode preserves boolean false')
    assert.match(falseDefault.message, /continued after false/)
    settings.generated_code_fail_on_false = ['goToPlayer']
    const { goToPlayer } = await load('src/agent/library/skills.js')
    assert.equal(await goToPlayer(agent.bot, 'missing'), false, 'direct SDK/skill callers retain the standard boolean API')
    const falseConfigured = await agent.actions.runAction('generated-false-configured', () => agent.coder.executeCode('await skills.goToPlayer(bot, "missing");\nlog(bot, "must not run");'), { timeout: 0 })
    assert.equal(falseConfigured.success, false, 'configured generated SDK false stops the generated action')
    assert.match(falseConfigured.message, /skills\.goToPlayer returned false/)
    assert.doesNotMatch(falseConfigured.message, /must not run/)
    assert.equal(falseConfigured.skillResults.some(call => call.skill === 'skills.goToPlayer' && call.status === 'returned_false'), true)
    const caughtFalse = await agent.actions.runAction('generated-caught-false', () => agent.coder.executeCode(
      'try { await skills.goToPlayer(bot, "missing"); } catch (error) { log(bot, error.message); }\nlog(bot, "continued after catch");'), { timeout: 0 })
    assert.equal(caughtFalse.success, true, 'generated code can explicitly recover from configured false errors')
    assert.match(caughtFalse.message, /continued after catch/)
    const unhandledSdkRejections = []
    const onUnhandledSdkRejection = reason => unhandledSdkRejections.push(reason)
    process.on('unhandledRejection', onUnhandledSdkRejection)
    const unawaitedFalse = await agent.actions.runAction('generated-unawaited-false', () => agent.coder.executeCode('skills.goToPlayer(bot, "missing");\nawait Promise.resolve();'), { timeout: 0 })
    await delay(20)
    process.removeListener('unhandledRejection', onUnhandledSdkRejection)
    assert.equal(unawaitedFalse.success, true, 'unawaited domain false remains a completed generated action')
    assert.equal(unawaitedFalse.skillResults.some(call => call.skill === 'skills.goToPlayer' && call.status === 'returned_false'), true, 'the owned derived promise is drained into the action result')
    assert.deepEqual(unhandledSdkRejections, [], 'the generated false mode does not leak an unhandled rejection')
    settings.generated_code_fail_on_false = []
    const domainFalse = await agent.actions.runAction('domain-false', async () => false, { timeout: 0 })
    assert.equal(domainFalse.success, true, 'executor success remains independent of a false domain return')
    assert.equal(domainFalse.domainReturn, false)
    assert.equal(domainFalse.executionStatus, 'completed')
    const legacyFalse = operationFactsSummary({ ...domainFalse, skillResults: [{ skill: 'collect', status: 'returned_false' }] })
    assert.match(legacyFalse, /executor=success; execution=completed; domain=returned false/)
    assert.match(legacyFalse, /skill collect=returned_false/)
    const legacyError = operationFactsSummary({ success: false, executionStatus: 'error', skillResults: [{ skill: 'craft', status: 'error', error: 'recipe failed' }] })
    assert.match(legacyError, /executor=failure; execution=error; skill craft=error \(recipe failed\)/)
    const lateOutput = await agent.actions.runAction('unawaited-sdk-child', () => agent.coder.executeCode(
      'skills.wait(bot, 80).then(() => log(bot, "late child completed")).catch(() => {});\nawait Promise.resolve();'), { timeout: 0 })
    assert.equal(lateOutput.success, true)
    assert.match(lateOutput.message, /late child completed/, 'ActionManager settlement includes the unawaited SDK child output')
    const settledOutput = agent.bot.output
    await delay(130)
    assert.equal(agent.actions.executing, false)

    // Native peer communication is an owned SDK call and is acknowledged only after inbox acceptance.
    const { default: convoManager } = await load('src/agent/conversation.js')
    const { serverProxy } = await load('src/agent/mindserver_proxy.js')
    const savedProxy = { socket: serverProxy.socket, managementReady: serverProxy.managementReady,
      managementCredential: serverProxy.managementCredential, connectionGeneration: serverProxy.connectionGeneration,
      serverGeneration: serverProxy.serverGeneration }
    const sentNative = []
    serverProxy.socket = { emit(event, recipient, payload, acknowledge) {
      sentNative.push({ event, recipient, payload })
      acknowledge({ accepted: true, messageId: payload.nativeMessage.id,
        taskId: payload.nativeMessage.senderTaskId, receiverTaskId: 'peer-current-task' })
    } }
    serverProxy.managementReady = true
    serverProxy.managementCredential = { token: 'synthetic-token', spawnId: 'synthetic-spawn' }
    serverProxy.connectionGeneration = 5
    serverProxy.serverGeneration = 'synthetic-hub-generation'
    const peerAgent = makeAgent('PeerSender')
    peerAgent.currentTaskId = 'peer-sender-task'
    convoManager.initAgent(peerAgent)
    convoManager.updateAgents([{ name: 'PeerSender', in_game: true }, { name: 'PeerReceiver', in_game: true }])
    let nativeRuntime
    const peerInputs = []
    nativeRuntime = new CodexRuntime(peerAgent, { makeSession: () => ({
      open: async () => {},
      runTurn: async input => {
        peerInputs.push(input)
        if (peerInputs.length === 1) {
          const native = { id: 'peer-message-1', senderTaskId: 'other-task', senderActionId: 'other-action',
            senderConnectionGeneration: 4, senderManagementGeneration: 2, senderAgent: 'PeerReceiver',
            senderSpawnId: 'other-spawn', receiverConnectionGeneration: 5, hubGeneration: 'synthetic-hub-generation' }
          assert.equal(nativeRuntime.acceptPeerMessage('PeerReceiver', 'please inspect the chest', native,
            { connectionGeneration: 5 }).accepted, true)
          const duplicate = nativeRuntime.acceptPeerMessage('PeerReceiver', 'please inspect the chest', native,
            { connectionGeneration: 5 })
          assert.equal(duplicate.accepted, true)
          assert.equal(duplicate.duplicate, true, 'same sender/message ID is accepted idempotently')
          for (let index = nativeRuntime.seenNativeMessageIds.size; index < 256; index++) nativeRuntime.seenNativeMessageIds.add(`filled-${index}`)
          const oldAfterCapacity = nativeRuntime.acceptPeerMessage('PeerReceiver', 'duplicate', native,
            { connectionGeneration: 5 })
          assert.equal(oldAfterCapacity.duplicate, true, 'seen IDs remain retained at the dedupe cap')
          const overCapacity = nativeRuntime.acceptPeerMessage('PeerReceiver', 'new', { ...native, id: 'new-at-cap' },
            { connectionGeneration: 5 })
          assert.equal(overCapacity.accepted, false, 'new IDs are rejected instead of evicting replay protection')
          const oldConnection = nativeRuntime.acceptPeerMessage('PeerReceiver', 'old connection', { ...native, id: 'old-conn' },
            { connectionGeneration: 4 })
          assert.equal(oldConnection.accepted, false, 'inbox admission rejects a replaced receiver connection')
          return { operation: Promise.resolve({ success: true }) }
        }
        return { operation: null, messages: ['task finished'] }
      }, close: async () => {} }) })
    peerAgent.codexRuntime = nativeRuntime
    assert.equal(await nativeRuntime.run('operator', () => true, 'peer-sender-task'), true)
    assert.equal(peerInputs.filter(input => input.includes('please inspect the chest')).length, 1,
      'an accepted peer message appears once at the following native turn')
    assert.equal(peerInputs[1].includes('sender task other-task'), true, 'sender task identity is distinct from receiver task')
    assert.equal(peerAgent.currentTaskId, 'peer-sender-task')
    const invalidatedAgent = makeAgent('NativeInboxInvalidation')
    invalidatedAgent.currentTaskId = 'receiver-old-task'
    const invalidatedRuntime = new CodexRuntime(invalidatedAgent)
    invalidatedRuntime.taskId = 'receiver-old-task'
    invalidatedRuntime.active = true
    invalidatedRuntime.acceptingNativeInbox = true
    invalidatedRuntime._taskScope = { taskId: 'receiver-old-task', messageGeneration: 0, managementGeneration: 0,
      connectionGeneration: 5, isCurrent: () => invalidatedAgent.currentTaskId === 'receiver-old-task'
        && invalidatedAgent._messageGeneration === 0 && serverProxy.connectionGeneration === 5 }
    const invalidationEnvelope = { id: 'invalidate-on-stop', senderTaskId: 'other-task', senderActionId: 'action',
      senderConnectionGeneration: 4, senderManagementGeneration: 2, senderAgent: 'PeerReceiver',
      senderSpawnId: 'other-spawn', receiverConnectionGeneration: 5, hubGeneration: 'synthetic-hub-generation' }
    assert.equal(invalidatedRuntime.acceptPeerMessage('PeerReceiver', 'queued before stop', invalidationEnvelope,
      { connectionGeneration: 5 }).accepted, true)
    invalidatedAgent.currentTaskId = 'receiver-new-task'
    invalidatedAgent._messageGeneration++
    assert.equal(invalidatedRuntime.acceptPeerMessage('PeerReceiver', 'old message', { ...invalidationEnvelope, id: 'after-new-task' },
      { connectionGeneration: 5 }).accepted, false, 'a superseded native task cannot accept more inbox messages')
    invalidatedRuntime.cancel('superseded')
    assert.equal(invalidatedRuntime.nativeInbox.length, 0, 'Stop/task replacement invalidates already queued inbox messages')

    const nativeSendAgent = makeAgent('NativeSend')
    await until(() => nativeSendAgent.coder.code_template && nativeSendAgent.coder.code_lint_template)
    nativeSendAgent.currentTaskId = 'native-send-task'
    convoManager.initAgent(nativeSendAgent)
    convoManager.updateAgents([{ name: 'NativeSend', in_game: true }, { name: 'PeerReceiver', in_game: true }])
    // Exercise the actual generated SDK + ActionManager ownership with a one-operation fake session.
    const nativeSendRuntime = new CodexRuntime(nativeSendAgent, { makeSession: ({ execute }) => {
      let turn = 0
      return { open: async () => {}, runTurn: async () => ++turn === 1
        ? { operation: execute('await communication.sendToBot("PeerReceiver", "owned send");\nlog(bot, "ack retained");') }
        : { operation: null, messages: ['sent'] }, close: async () => {} }
    } })
    nativeSendAgent.codexRuntime = nativeSendRuntime
    const sendOutput = await nativeSendRuntime.run('operator', () => true, 'native-send-task')
    assert.equal(sendOutput, true)
    assert.equal(sentNative.length, 1)
    assert.equal(sentNative[0].event, 'chat-message')
    assert.equal(sentNative[0].recipient, 'PeerReceiver')
    assert.equal(sentNative[0].payload.nativeMessage.senderTaskId, 'native-send-task')
    assert.equal(typeof sentNative[0].payload.nativeMessage.senderActionId, 'string')
    assert.ok(sentNative[0].payload.nativeMessage.senderActionId.length > 0)
    const sendTraceFile = (await fs.readdir(path.join(root, 'bots/NativeSend/histories')))[0]
    const sendTrace = (await fs.readFile(path.join(root, 'bots/NativeSend/histories', sendTraceFile), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line))
    assert.match(sendTrace.find(event => event.type === 'operation_result').result.message, /ack retained/)

    // A stopped owner rejects the pending send; a late transport ACK cannot revive it.
    const lateAck = deferred()
    serverProxy.socket.emit = (event, recipient, payload, acknowledge) => { sentNative.push({ event, recipient, payload }); lateAck.resolve(acknowledge) }
    const cancelAgent = makeAgent('NativeCancel')
    await until(() => cancelAgent.coder.code_template && cancelAgent.coder.code_lint_template)
    cancelAgent.currentTaskId = 'cancelled-send-task'
    convoManager.initAgent(cancelAgent)
    convoManager.updateAgents([{ name: 'NativeCancel', in_game: true }, { name: 'PeerReceiver', in_game: true }])
    let cancelRuntime
    cancelRuntime = new CodexRuntime(cancelAgent, { makeSession: ({ execute }) => {
      let turn = 0
      return { open: async () => {}, runTurn: async () => ++turn === 1
        ? { operation: execute('await communication.sendToBot("PeerReceiver", "cancel me");') }
        : { operation: null, messages: ['unexpected'] }, close: async () => {} }
    } })
    cancelAgent.codexRuntime = cancelRuntime
    const cancelRun = cancelRuntime.run('operator', () => true, 'cancelled-send-task')
    const lateAcknowledge = await lateAck.promise
    cancelRuntime.cancel('user-stop')
    await cancelAgent.actions.stop('user-stop')
    assert.equal(await cancelRun, false, 'cancelled send does not complete or report the native task')
    lateAcknowledge({ accepted: true, messageId: sentNative.at(-1).payload.nativeMessage.id,
      taskId: 'cancelled-send-task', receiverTaskId: 'late-task' })
    assert.equal(cancelRuntime.nativeInbox.length, 0, 'late ACK cannot restore an invalidated inbox')

    // Normal legacy chat still uses the original anonymous chat-message shape.
    settings.chat_bot_messages = false
    convoManager.initAgent(peerAgent)
    convoManager.updateAgents([{ name: 'PeerSender', in_game: true }, { name: 'PeerReceiver', in_game: true }])
    convoManager.sendToBot('PeerReceiver', 'legacy conversation')
    assert.equal(sentNative.at(-1).payload.nativeMessage, undefined)
    assert.equal(sentNative.at(-1).payload.message, 'legacy conversation')
    Object.assign(serverProxy, savedProxy)

    assert.equal(agent.bot.output, settledOutput, 'no late output mutates state after action settlement')
    const bad = await agent.actions.runAction('lint', () => agent.coder.executeCode('await skills.nonexistent(bot);'), { timeout: 0 })
    assert.equal(bad.success, false)
    assert.match(bad.message, /functions do not exist/)
    const partial = await agent.actions.runAction('partial', () => agent.coder.executeCode('log(bot, "kept mutation");\nawait Promise.resolve();\nthrow new Error("boom");'), { timeout: 0 })
    assert.match(partial.message, /kept mutation[\s\S]*boom/)
    const nativeNavigation = agent.actions.runAction('navigation-phase-route-progress', async () => {
      agent.actions.setPhase('navigation')
      const wait = beginOwnedWait({ phase: 'navigation', reason: 'goal-or-new-route-segment', timeoutMs: 180 })
      await delay(40)
      markOwnedWaitProgress(wait)
      await delay(45)
      finishOwnedWait(wait, { outcome: 'settled' })
    }, { timeout: 0, stallTimeoutMs: 60 })
    assert.equal((await nativeNavigation).success, true, 'a new owned route segment refreshes the native stall timer')
    const noRouteProgressStartedAt = Date.now()
    const noRouteProgress = await agent.actions.runAction('navigation-phase-no-progress', async () => {
      agent.actions.setPhase('navigation')
      const wait = beginOwnedWait({ phase: 'navigation', reason: 'goal-or-new-route-segment', timeoutMs: 180 })
      await new Promise(resolve => agent.actions.currentAction.controller.signal.addEventListener('abort', () => {
        finishOwnedWait(wait, { outcome: 'cancelled' })
        resolve()
      }, { once: true }))
    }, { timeout: 0, stallTimeoutMs: 60 })
    assert.equal(noRouteProgress.reason, 'stall', 'an unresponsive navigation still stops at the existing native stall limit')
    assert.ok(Date.now() - noRouteProgressStartedAt < 500, 'unresponsive native navigation does not inherit the longer source-navigation timeout')
    const stopped = deferred()
    agent.interrupt = () => stopped.resolve()
    const stall = await agent.actions.runAction('action:codex-code', async () => { agent.bot.output = 'x'.repeat(4232); await stopped.promise }, { timeout: 1, stallTimeoutMs: 60, outputLimit: 16000 })
    assert.equal(stall.reason, 'stall')
    assert.ok(stall.message.includes('x'.repeat(4232)), '4232-character result is retained')
    assert.equal(agent.actions.executing, false)
    // A native task suppresses the old recovery actor and NPC idle during inference.
    agent.codexRuntime = { active: true }
    assert.equal(agent.isIdle(), false)
    assert.equal(agent.onRecoveryResult({ reason: 'timeout' }), false)
    agent.codexRuntime = null

    // Real transport + owned helper, disposable fake app-server. No model/network.
    const binary = path.join(root, 'fake-codex')
    await fs.writeFile(binary, `#!${node}\nimport {createInterface} from 'node:readline';\nlet turn=0; const out=m=>process.stdout.write(JSON.stringify(m)+'\\n');\ncreateInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);\nif(m.method==='initialize')out({id:m.id,result:{}});\nif(m.method==='thread/start')out({id:m.id,result:{model:m.params.model,reasoningEffort:'medium',thread:{id:'t'}}});\nif(m.method==='turn/start'){turn++;out({id:m.id,result:{turn:{id:'u'+turn}}});if(turn===1)out({id:900,method:'item/tool/call',params:{threadId:'t',turnId:'u1',tool:'minecraft_execute',arguments:{code:'log(bot, "from tool");\\nawait Promise.resolve();'}}});else {out({method:'item/completed',params:{item:{type:'agentMessage',text:'verified'}}});out({method:'turn/completed',params:{turn:{id:'u'+turn,status:'completed'}}});}}\nif(m.method==='thread/resume')out({id:m.id,result:{model:m.params.model,reasoningEffort:'medium',thread:{id:m.params.threadId}}});\nif(m.id===900&&!m.method){if(!m.result?.contentItems?.[0]?.text)throw Error('missing completed tool result');out({method:'item/completed',params:{item:{type:'agentMessage',text:'checking state',phase:'commentary'}}});out({method:'item/completed',params:{item:{type:'agentMessage',text:'verified',phase:'final_answer'}}});out({method:'turn/completed',params:{turn:{id:'u1',status:'completed'}}});}\nif(m.method==='turn/interrupt')throw Error('unexpected model interruption');\n});`)
    await fs.chmod(binary, 0o700)
    process.env.MINDCRAFT_CODEX_BIN = binary
    const events = [], gate = deferred()
    let calls = 0
    const session = new CodexSession({ model: 'gpt-6-luna', record: (type, detail) => events.push({ type, detail }), execute: async () => { calls++; return gate.promise } })
    const nativeRequest = session.request.bind(session)
    let threadParams
    session.request = (method, params) => { if (method === 'thread/start') threadParams = params; return nativeRequest(method, params) }
    try {
      await session.open(new AbortController().signal)
      assert.equal(Object.hasOwn(threadParams, 'baseInstructions'), false)
      assert.equal(Object.hasOwn(threadParams, 'environments'), false, 'default workspace access enables native AGENTS discovery')
      assert.deepEqual(threadParams.selectedCapabilityRoots, [], 'unrelated capabilities remain unselected')
      assert.equal(await fs.readFile(path.join(session.cwd, 'AGENTS.md'), 'utf8'), await fs.readFile(path.join(root, 'src/process/codex/AGENTS.md'), 'utf8'))
      let finished = false
      const running = session.runTurn('do work').finally(() => { finished = true })
      await until(() => calls === 1)
      await delay(100)
      assert.equal(finished, false, 'turn waits for the actual operation result')
      assert.equal(events.some(event => event.type === 'turn_completed'), false)
      gate.resolve({ success: true, value: 42 })
      const first = await running
      assert.deepEqual(first.messages, ['verified'], 'commentary cannot become a terminal response')
      assert.equal(events.at(-1).detail.status, 'completed')
      assert.equal(calls, 1, 'the settled operation is never replayed')
    } finally { await session.close() }
    // A failed rule refresh must close admission before another queued operation can start.
    let queuedExecutions = 0
    const queued = new CodexSession({ model: 'fixture', execute: async () => { queuedExecutions++; return { success: true } },
      prepareResult: async () => { throw Error('rules unreadable') } })
    queued.threadId = 'queued-thread'
    queued.turn = { reject() {} }
    const toolCall = id => ({ id, method: 'item/tool/call', params: { threadId: queued.threadId,
      turnId: 'queued-turn', tool: 'minecraft_execute', arguments: { code: 'await Promise.resolve();' } } })
    await Promise.all([queued.receive(toolCall(1)), queued.receive(toolCall(2))])
    assert.equal(queuedExecutions, 1)
    assert.match(queued.failure.message, /rules unreadable/)
    queued.turn = null
    await queued.close()
    // Fast completion and controller resume exactly once on the same thread.
    const native = new CodexRuntime(agent)
    agent.codexRuntime = native
    assert.equal(await native.run('operator', () => true), true)
    assert.equal(routed.at(-1), 'verified')
    assert.equal(native.active, false)
    assert.ok(rules.length >= 3, 'shared rules are reread before resumed model judgment')
    const mainAgent = makeAgent('MainPath')
    await until(() => mainAgent.coder.code_template && mainAgent.coder.code_lint_template)
    let acknowledgement
    assert.equal(await mainAgent.handleMessage('operator', 'do the fixture task', null,
      { taskId: 'eval-task-1', onAccepted: value => { acknowledgement = value } }), true)
    assert.ok(mainAgent.codexRuntime, 'actual Agent.handleMessage uses the native runtime')
    assert.equal(mainAgent.history.invalidations, 1, 'new accepted task invalidates any earlier summary epoch')
    assert.deepEqual(acknowledgement, { accepted: true, taskId: 'eval-task-1' })
    assert.equal(mainAgent.codexRuntime.taskId, 'eval-task-1')
    const traceFiles = await fs.readdir(path.join(root, 'bots/MainPath/histories'))
    const taskEvents = (await fs.readFile(path.join(root, 'bots/MainPath/histories', traceFiles[0]), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line))
    assert.equal(taskEvents.filter(event => event.type === 'task_accepted').length, 1)
    assert.equal(taskEvents.filter(event => event.type === 'finished').length, 1)
    assert.equal(taskEvents.filter(event => event.type === 'response_checkpoint').length, 1)
    assert.equal(taskEvents.filter(event => event.type === 'response_reported').length, 1)
    assert.ok(Date.parse(taskEvents.find(event => event.type === 'response_checkpoint').generatedAt)
      <= Date.parse(taskEvents.find(event => event.type === 'response_reported').reportedAt),
      'model generation checkpoint and actual report time remain separate events')
    assert.ok(taskEvents.every(event => event.taskId === 'eval-task-1'), 'accepted task ID reaches every task event')
    let replayAck
    const invalidationsBeforeReplay = mainAgent.history.invalidations
    const intentEpochBeforeReplay = mainAgent.actions.intentEpoch
    assert.equal(await mainAgent.handleMessage('operator', 'must not replay', null,
      { taskId: 'eval-task-1', onAccepted: value => { replayAck = value } }), false,
      'a completed operator task ID is rejected instead of starting a new native task')
    assert.equal(replayAck.accepted, false)
    assert.equal(mainAgent.history.invalidations, invalidationsBeforeReplay, 'stale duplicate does not cancel or invalidate the current turn')
    assert.equal(mainAgent.actions.intentEpoch, intentEpochBeforeReplay, 'stale duplicate does not begin a second user intent')
    assert.equal((await fs.readdir(path.join(root, 'bots/MainPath/histories'))).length, traceFiles.length,
      'stale duplicate does not create a second task trace or terminal')

    const dedupeAgent = Object.create(Agent.prototype)
    dedupeAgent._messageGeneration = 0
    let admissionGate = deferred()
    let admissionRuns = 0
    dedupeAgent._handleMessageInternal = async (_source, _message, _limit, options) => {
      admissionRuns++
      dedupeAgent.currentTaskId = options.taskId
      dedupeAgent.codexRuntime = { active: true }
      options.onAccepted({ accepted: true, taskId: options.taskId })
      await admissionGate.promise
      return true
    }
    const acceptedAcks = []
    const firstDispatch = dedupeAgent.handleMessage('operator', 'one task', null,
      { taskId: 'active-dispatch', onAccepted: value => acceptedAcks.push(value) })
    await until(() => acceptedAcks.length === 1)
    assert.equal(await dedupeAgent.handleMessage('operator', 'duplicate', null,
      { taskId: 'active-dispatch', onAccepted: value => acceptedAcks.push(value) }), true,
      'resending the active task ID receives idempotent acceptance')
    assert.equal(admissionRuns, 1, 'same active task ID is never executed twice')
    assert.equal(acceptedAcks[1].duplicate, true)
    admissionGate.resolve()
    await firstDispatch
    dedupeAgent.codexRuntime.active = false
    assert.equal(await dedupeAgent.handleMessage('operator', 'old replay', null, { taskId: 'active-dispatch' }), false,
      'the same ID cannot restart after its accepted task has ended')
    const cappedAdmissionAgent = Object.create(Agent.prototype)
    cappedAdmissionAgent.currentTaskId = 'retained-old-id'
    cappedAdmissionAgent.codexRuntime = { active: true }
    cappedAdmissionAgent._externalTaskAdmissions = new Map(Array.from({ length: 256 }, (_, index) => [
      index === 0 ? 'retained-old-id' : `accepted-${index}`, { status: 'accepted', settled: Promise.resolve() }
    ]))
    assert.equal(await cappedAdmissionAgent.handleMessage('operator', 'old ID retry', null, { taskId: 'retained-old-id' }), true,
      'the bounded admission cache retains old IDs rather than evicting replay protection')
    let capacityAck
    assert.equal(await cappedAdmissionAgent.handleMessage('operator', 'new task at cap', null,
      { taskId: 'new-at-cap', onAccepted: value => { capacityAck = value } }), false)
    assert.equal(capacityAck.accepted, false, 'capacity exhaustion rejects new task IDs explicitly')
    const saveFailureAgent = makeAgent('SaveFailure')
    await until(() => saveFailureAgent.coder.code_template && saveFailureAgent.coder.code_lint_template)
    saveFailureAgent.history.save = async () => { throw new Error('fixture save failure') }
    const saveFailureRuntime = new CodexRuntime(saveFailureAgent, { makeSession: () => ({
      open: async () => {}, runTurn: async () => ({ operation: null, messages: ['I completed the request.'] }), close: async () => {}
    }) })
    saveFailureAgent.codexRuntime = saveFailureRuntime
    assert.equal(await saveFailureRuntime.run('operator', () => true, 'save-failure-task'), false)
    const saveFailureFiles = await fs.readdir(path.join(root, 'bots/SaveFailure/histories'))
    const saveFailureEvents = (await fs.readFile(path.join(root, 'bots/SaveFailure/histories', saveFailureFiles[0]), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line))
    const saveFailureTerminals = saveFailureEvents.filter(event => event.type === 'finished')
    assert.equal(saveFailureTerminals.length, 1, 'save failure still emits one terminal event')
    assert.equal(saveFailureTerminals[0].completion, 'reported')
    assert.equal(saveFailureTerminals[0].saveSucceeded, false)
    assert.equal(saveFailureTerminals[0].diagnosticSaveSucceeded, false, 'diagnostic checkpoint failure is separately reported')
    assert.equal(saveFailureTerminals[0].response, 'I completed the request.')
    assert.ok(Number.isFinite(Date.parse(saveFailureTerminals[0].reportedAt)), 'response route time is preserved independently of save failure')
    assert.equal(saveFailureEvents.filter(event => event.type === 'response_checkpoint').length, 1)
    assert.equal(saveFailureEvents.filter(event => event.type === 'history_checkpoint_error').length, 1)
    assert.equal(saveFailureEvents.filter(event => event.type === 'response_reported').length, 1,
      'history I/O failure does not relabel a successfully routed response as unreported')

    const brokenTracePath = path.join(root, 'trace-write-failure-directory')
    await fs.mkdir(brokenTracePath)
    const traceFailureAgent = makeAgent('TraceWriteFailure')
    await until(() => traceFailureAgent.coder.code_template && traceFailureAgent.coder.code_lint_template)
    const traceFailureRuntime = new CodexRuntime(traceFailureAgent, { traceFilePath: brokenTracePath, makeSession: () => ({
      open: async () => {}, runTurn: async () => ({ operation: null, messages: ['The trace writer is unavailable.'] }), close: async () => {}
    }) })
    traceFailureAgent.codexRuntime = traceFailureRuntime
    assert.equal(await traceFailureRuntime.run('operator', () => true, 'trace-write-failure-task'), true,
      'JSONL checkpoint or terminal I/O failure does not block an otherwise accepted response')
    assert.deepEqual(routed.filter(message => message === 'The trace writer is unavailable.'), ['The trace writer is unavailable.'],
      'response routing is preserved when trace writes fail')
    assert.equal(traceFailureRuntime.terminalOutcome.completion, 'reported')
    assert.equal(traceFailureRuntime.terminalOutcome.saveSucceeded, true, 'memory checkpoint result remains distinct from task trace failure')
    assert.equal(traceFailureRuntime.terminalOutcome.terminalWritten, false, 'failed terminal append is not reported as persisted')
    assert.equal(traceFailureRuntime.terminalOutcome.traceSaveSucceeded, false)
    assert.ok(traceFailureRuntime.terminalOutcome.traceWriteFailures.some(failure => failure.type === 'response_checkpoint'))
    assert.ok(traceFailureRuntime.terminalOutcome.traceWriteFailures.some(failure => failure.type === 'finished'))

    settings.max_messages = 5
    const summaryPendingAgent = makeAgent('SummaryPending')
    let summaryCalls = 0
    summaryPendingAgent.prompter.promptMemSaving = async () => { summaryCalls++; throw Error('native summary model must not run') }
    summaryPendingAgent.history = new History(summaryPendingAgent)
    summaryPendingAgent.history.max_messages = 4
    for (let index = 1; index <= 4; index++) await summaryPendingAgent.history.add('SummaryPending', `older turn ${index}`)
    const summaryPendingRuntime = new CodexRuntime(summaryPendingAgent, { makeSession: () => ({
      open: async () => {}, runTurn: async () => ({ messages: ['The answer is checkpointed and reported.'] }), close: async () => {}
    }) })
    summaryPendingAgent.codexRuntime = summaryPendingRuntime
    let finishRoute
    summaryPendingAgent.routeResponse = async () => new Promise(resolve => { finishRoute = resolve })
    const summaryRun = summaryPendingRuntime.run('operator', () => true, 'summary-pending-task')
    await until(() => typeof finishRoute === 'function')
    const summaryPendingFiles = await fs.readdir(path.join(root, 'bots/SummaryPending/histories'))
    const summaryTracePath = path.join(root, 'bots/SummaryPending/histories', summaryPendingFiles.find(file => file.startsWith('codex-')))
    const beforeRouteEvents = (await fs.readFile(summaryTracePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(beforeRouteEvents.filter(event => event.type === 'response_checkpoint').length, 1)
    assert.equal(beforeRouteEvents.some(event => ['response_reported', 'finished'].includes(event.type)), false)
    finishRoute()
    assert.equal(await summaryRun, true)
    const summaryPendingMemory = JSON.parse(await fs.readFile(path.join(root, 'bots/SummaryPending/memory.json'), 'utf8'))
    assert.equal(summaryPendingMemory.turns.length, 4, 'native UI history is bounded without another model')
    assert.match(summaryPendingMemory.turns.at(-1).content, /The answer is checkpointed/)
    assert.equal(summaryCalls, 0, 'Codex owns native compaction, not promptMemSaving')

    // Stored native threads survive a new runtime/History instance, but never cross scopes.
    settings.place_world_id = 'harness-world'
    const persistentAgent = makeAgent('Persistent')
    persistentAgent.history = new History(persistentAgent)
    await until(() => persistentAgent.coder.code_template && persistentAgent.coder.code_lint_template)
    await persistentAgent.history.add('operator', 'OLDER_REQUEST_MARKER')
    persistentAgent.currentTaskId = 'persistent-first'
    const firstRuntime = new CodexRuntime(persistentAgent)
    persistentAgent.codexRuntime = firstRuntime
    assert.equal(await firstRuntime.run('operator', () => true, persistentAgent.currentTaskId), true)
    assert.equal(firstRuntime.session.resumed, undefined)
    const savedThread = persistentAgent.history.codexThread
    assert.equal(savedThread.threadId, 't')
    assert.equal(savedThread.scope.worldId, 'harness-world')
    persistentAgent.history = new History(persistentAgent)
    assert.equal(persistentAgent.history.codexThread, null, 'without load_memory, a new instance starts fresh')
    persistentAgent.history.load()
    await persistentAgent.history.add('system', 'NEW_RECIPIENT_CONTEXT')
    await persistentAgent.history.add('system', 'NEW_BEHAVIOR_LOG')
    await persistentAgent.history.add('operator', 'LATEST_REQUEST_MARKER')
    persistentAgent.currentTaskId = 'persistent-second'
    const secondRuntime = new CodexRuntime(persistentAgent)
    persistentAgent.codexRuntime = secondRuntime
    assert.equal(await secondRuntime.run('operator', () => true, persistentAgent.currentTaskId), true)
    assert.equal(secondRuntime.session.resumed, true)
    const persistentTraces = (await Promise.all((await fs.readdir('bots/Persistent/histories')).filter(name => name.startsWith('codex-'))
      .map(name => fs.readFile('bots/Persistent/histories/' + name, 'utf8')))).join('\n').trim().split('\n').filter(Boolean).map(JSON.parse)
    const resumedStart = persistentTraces.find(row => row.taskId === 'persistent-second' && row.type === 'task_start')
    assert.match(resumedStart.input, /LATEST_REQUEST_MARKER/)
    assert.match(resumedStart.input, /NEW_RECIPIENT_CONTEXT/)
    assert.match(resumedStart.input, /NEW_BEHAVIOR_LOG/)
    assert.doesNotMatch(resumedStart.input, /verified/, 'the previous native answer was already part of the thread')
    assert.doesNotMatch(resumedStart.input, /OLDER_REQUEST_MARKER/, 'resumed thread is not fed the old conversation again')
    assert.doesNotMatch(await fs.readFile(path.join(root, 'src/process/codex/AGENTS.md'), 'utf8'), /Wait for a bounded number/, 'full SDK stays out of fixed instructions')
    assert.equal(resumedStart.instructionsFile, 'src/process/codex/AGENTS.md')
    assert.equal(resumedStart.capabilities.max_block_edits_per_check, 8)
    assert.match(persistentTraces.find(row => row.taskId === 'persistent-second' && row.type === 'turn_input').input, /CURRENT CAPABILITIES/)
    for (const scope of [{ ...savedThread.scope, bot: 'Other' }, { ...savedThread.scope, worldId: 'another-world' },
      { ...savedThread.scope, model: 'another-model' }, { ...savedThread.scope, sdk: 'changed-sdk' }]) {
      assert.equal(persistentAgent.history.getCodexThread(scope), null)
    }
    settings.place_world_id = 'another-world'
    await persistentAgent.history.add('operator', 'fresh world request')
    persistentAgent.currentTaskId = 'persistent-new-world'
    const newWorldRuntime = new CodexRuntime(persistentAgent)
    persistentAgent.codexRuntime = newWorldRuntime
    assert.equal(await newWorldRuntime.run('operator', () => true, persistentAgent.currentTaskId), true)
    assert.equal(newWorldRuntime.session.resumed, undefined)
    persistentAgent.history.clear()
    assert.equal(persistentAgent.history.codexThread, null, 'clear invalidates the native thread pointer')
    settings.place_world_id = null

    // Real interpreter + Coder + ActionManager: native image bypasses the helper model.
    const { VisionInterpreter } = await load('src/agent/vision/vision_interpreter.js')
    const imageAgent = makeAgent('NativeImage')
    imageAgent.bot.blockAtCursor = () => null
    imageAgent.bot.lookAt = async () => {}
    imageAgent.prompter.skill_libary.getAllSkillDocs = async () => ['vision.lookAtPosition\nCapture an image at coordinates.']
    imageAgent.prompter.promptVision = async () => { throw Error('second vision model must not run') }
    imageAgent.vision_interpreter = new VisionInterpreter(imageAgent, false)
    imageAgent.vision_interpreter.allow_vision = true
    imageAgent.vision_interpreter.camera = { capture: async () => 'fixture' }
    await fs.mkdir('bots/NativeImage/screenshots', { recursive: true })
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    await fs.writeFile('bots/NativeImage/screenshots/fixture.jpg', jpeg)
    imageAgent.currentTaskId = 'native-image-task'
    let imageResult
    const imageRuntime = new NativeCodexRuntime(imageAgent, { makeSession: ({ execute, prepareResult, tools, readDocumentation }) => ({
      open: async () => {
        assert.equal(tools[0].tools[0].deferLoading, true)
        assert.match(readDocumentation('vision_lookAtPosition'), /Capture an image/)
        assert.throws(() => readDocumentation('unknown'), /Unknown SDK/)
      },
      runTurn: async () => {
        const result = await execute('log(bot, await vision.lookAtPosition(1,64,3));')
        assert.equal(result.success, true)
        assert.match(result.message, /Screenshot attached/)
        imageResult = await prepareResult(result)
        return { messages: ['image observed'] }
      }, close: async () => {}
    }) })
    imageAgent.codexRuntime = imageRuntime
    await until(() => imageAgent.coder.code_template && imageAgent.coder.code_lint_template)
    assert.equal(await imageRuntime.run('operator', () => true, imageAgent.currentTaskId), true)
    assert.equal(imageResult.contentItems[1].type, 'inputImage')
    assert.equal(imageResult.contentItems[1].imageUrl, 'data:image/jpeg;base64,' + jpeg.toString('base64'))
    assert.match(imageResult.contentItems[0].text, /CURRENT RULES/)
    const imageTraceFile = (await fs.readdir('bots/NativeImage/histories'))[0]
    assert.doesNotMatch(await fs.readFile('bots/NativeImage/histories/' + imageTraceFile, 'utf8'), /data:image|\/9j\//,
      'host trace and diagnostics retain image metadata, not base64')
    assert.throws(() => imageRuntime.attachImage(jpeg, {}), /current owned native operation/)
    // Bound attachment count/bytes in a current owned action, including partial failure.
    let boundedResult
    const boundedRuntime = new NativeCodexRuntime(imageAgent, { makeSession: ({ execute, prepareResult }) => ({
      open: async () => {}, runTurn: async () => {
        await fs.writeFile('bots/NativeImage/screenshots/fixture.jpg', Buffer.alloc(2 * 1024 * 1024 + 1))
        const tooLarge = await execute('await vision.lookAtPosition(1,64,3);')
        assert.equal(tooLarge.success, false)
        assert.match(tooLarge.message, /Screenshot exceeds/)
        await prepareResult(tooLarge)
        await fs.writeFile('bots/NativeImage/screenshots/fixture.jpg', jpeg)
        const tooMany = await execute('for (let i = 0; i < 5; i++) { await vision.lookAtPosition(1,64,3); }')
        assert.equal(tooMany.success, false)
        assert.match(tooMany.message, /At most 4 screenshots/)
        boundedResult = await prepareResult(tooMany)
        return { messages: ['partial images retained'] }
      }, close: async () => {}
    }) })
    imageAgent.currentTaskId = 'native-image-bounds'
    imageAgent.codexRuntime = boundedRuntime
    assert.equal(await boundedRuntime.run('operator', () => true, imageAgent.currentTaskId), true)
    assert.equal(boundedResult.contentItems.filter(item => item.type === 'inputImage').length, 4)
    assert.equal(boundedResult.success, false, 'an SDK failure remains visible alongside partial screenshots')

    // Cross-task diagnostics are a projection in existing memory, never replayed code.
    settings.place_world_id = 'fixture-world-a'
    const diagnosticAgent = makeAgent('Diagnostics')
    diagnosticAgent.history = new History(diagnosticAgent)
    await until(() => diagnosticAgent.coder.code_template && diagnosticAgent.coder.code_lint_template)
    const faultyCode = 'log(bot, "partial before error");\nawait Promise.resolve();\nbot.health = 19;\nbot.modes.missing.isOn();'
    const diagnosticRuntime = new CodexRuntime(diagnosticAgent, { makeSession: ({ execute }) => {
      let turn = 0
      return { open: async () => {}, runTurn: async () => ++turn === 1
        ? { operation: execute(faultyCode) } : { messages: ['An isOn TypeError stopped the operation.'] }, close: async () => {} }
    } })
    diagnosticAgent.codexRuntime = diagnosticRuntime
    assert.equal(await diagnosticRuntime.run('operator', () => true, 'failed-diagnostic-task'), true)
    const storedDiagnostic = JSON.parse(await fs.readFile(path.join(root, 'bots/Diagnostics/memory.json'), 'utf8')).task_diagnostics
    assert.equal(storedDiagnostic.scope.bot, 'Diagnostics')
    assert.equal(storedDiagnostic.scope.worldId, 'fixture-world-a')
    assert.equal(storedDiagnostic.status, 'completed')
    assert.equal(storedDiagnostic.operations[0].success, false, 'task reporting is distinct from operation failure')
    assert.equal(storedDiagnostic.lastFailure.code, faultyCode)
    assert.match(storedDiagnostic.lastFailure.error, /TypeError[\s\S]*isOn/)
    assert.match(storedDiagnostic.lastFailure.output, /partial before error/)
    assert.equal(storedDiagnostic.lastFailure.observed.health, 19, 'state after partial raw mutation survives the error')
    assert.ok(Number.isFinite(Date.parse(storedDiagnostic.lastFailure.observedAt)))
    // Loading the copied memory simulates the existing bundle handoff format.
    diagnosticAgent.history = new History(diagnosticAgent)
    diagnosticAgent.history.load()
    let diagnosticInput
    const explanationRuntime = new CodexRuntime(diagnosticAgent, { makeSession: ({ execute }) => {
      let turn = 0
      return { open: async () => {}, runTurn: async input => {
        if (++turn === 1) {
          diagnosticInput = input
          return { operation: execute('await Promise.resolve();\nlog(bot, JSON.stringify(diagnostics.lastTask()));') }
        }
        assert.match(input, /TypeError[\s\S]*isOn/)
        assert.match(input, /bot\.modes\.missing\.isOn/)
        return { messages: ['The previous operation failed while calling bot.modes.missing.isOn().'] }
      }, close: async () => {} }
    } })
    diagnosticAgent.codexRuntime = explanationRuntime
    assert.equal(await explanationRuntime.run('operator', () => true, 'explain-diagnostic-task'), true)
    assert.match(diagnosticInput, /failed-diagnostic-task/)
    assert.doesNotMatch(diagnosticInput, /partial before error/, 'initial input provides an index rather than injecting all traces')
    assert.equal(diagnosticAgent.bot.health, 19, 'diagnostic lookup never replays the earlier mutation')
    const explanationFiles = await fs.readdir(path.join(root, 'bots/Diagnostics/histories'))
    const diagnosticEvents = (await Promise.all(explanationFiles.filter(file => file.startsWith('codex-')).map(file =>
      fs.readFile(path.join(root, 'bots/Diagnostics/histories', file), 'utf8')))).join('\n').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const lookupResult = diagnosticEvents.find(event => event.taskId === 'explain-diagnostic-task' && event.type === 'operation_result')
    assert.equal(lookupResult.result.success, true, 'SDK is available through real Coder/SES/linter/ActionManager')
    assert.match(lookupResult.result.message, /failed-diagnostic-task/)
    assert.doesNotMatch(lookupResult.result.message, /\"taskId\":\"explain-diagnostic-task\"/, 'lookup returns prior task even after the current task begins')
    const otherBot = makeAgent('OtherDiagnosticBot')
    otherBot.history = new History(otherBot)
    otherBot.history.memory_fp = diagnosticAgent.history.memory_fp
    otherBot.history.load()
    assert.match(otherBot.history.getTaskDiagnostics().reason, /different bot\/world/)
    settings.place_world_id = 'fixture-world-b'
    assert.match(diagnosticAgent.history.getTaskDiagnostics().reason, /different bot\/world/)
    settings.place_world_id = null
    assert.match(diagnosticAgent.history.getTaskDiagnostics().reason, /scope unavailable/)
    settings.place_world_id = 'fixture-world-a'
    const { createTaskDiagnostics, appendOperationDiagnostic, readTaskDiagnostics } = await load('src/agent/task_diagnostics.js')
    const boundedDiagnostic = createTaskDiagnostics(diagnosticAgent, 'bounded-task')
    for (let index = 0; index < 20; index++) appendOperationDiagnostic(boundedDiagnostic, 'x'.repeat(10000), {
      success: index !== 0, message: 'y'.repeat(10000), executionStatus: index === 0 ? 'error' : 'completed',
      skillResults: Array.from({ length: 100 }, () => ({ skill: 'example', status: 'returned', error: 'z'.repeat(10000) })),
      confirmedChanges: [{ quantity: 3, target: { x: 1, y: 64, z: 2 }, observedAt: new Date().toISOString() }],
      unconfirmedChanges: [{ reason: 'cancelled after partial mutation', confirmedQuantity: 1 }],
    })
    assert.equal(boundedDiagnostic.operations.length, 6)
    assert.equal(boundedDiagnostic.operationsTruncated, true)
    assert.equal(boundedDiagnostic.lastFailure.success, false, 'latest failure remains available after later successful operations')
    assert.equal(boundedDiagnostic.operations[0].codeTruncated, true)
    assert.equal(boundedDiagnostic.operations[0].skillResultsTruncated, true)
    assert.equal(boundedDiagnostic.operations[0].confirmedChanges[0].quantity, 3)
    assert.equal(boundedDiagnostic.operations[0].unconfirmedChanges[0].confirmedQuantity, 1)
    assert.ok(JSON.stringify(boundedDiagnostic).length < 256000)
    assert.equal(readTaskDiagnostics(diagnosticAgent, boundedDiagnostic).available, true)
    assert.equal(readTaskDiagnostics(diagnosticAgent, null).available, false)
    const legacyMemoryAgent = makeAgent('LegacyDiagnosticMemory')
    legacyMemoryAgent.history = new History(legacyMemoryAgent)
    await fs.writeFile(legacyMemoryAgent.history.memory_fp, JSON.stringify({ memory: 'old format', turns: [] }))
    legacyMemoryAgent.history.load()
    assert.match(legacyMemoryAgent.history.getTaskDiagnostics().reason, /no previous/)

    // A draining replaced task cannot overwrite a newer task's checkpoint.
    const replacementAgent = makeAgent('DiagnosticReplacement')
    replacementAgent.history = new History(replacementAgent)
    const replacementBody = deferred(), replacementStarted = deferred()
    replacementAgent.coder.executeCode = async () => { replacementStarted.resolve(); await replacementBody.promise }
    replacementAgent.interrupt = () => {}
    let oldCurrent = true
    const oldRuntime = new CodexRuntime(replacementAgent, { makeSession: ({ execute }) => ({
      open: async () => {}, runTurn: async () => ({ operation: execute('old mutation') }), close: async () => {}
    }) })
    replacementAgent.codexRuntime = oldRuntime
    const oldRun = oldRuntime.run('operator', () => oldCurrent, 'replaced-diagnostic-task')
    await replacementStarted.promise
    oldCurrent = false
    await oldRuntime.cancel('superseded')
    const newerRuntime = new CodexRuntime(replacementAgent, { makeSession: () => ({
      open: async () => {}, runTurn: async () => ({ messages: ['newer response'] }), close: async () => {}
    }) })
    replacementAgent.codexRuntime = newerRuntime
    assert.equal(await newerRuntime.run('operator', () => true, 'replacement-diagnostic-task'), true)
    replacementBody.resolve()
    assert.equal(await oldRun, false)
    const replacementMemory = JSON.parse(await fs.readFile(replacementAgent.history.memory_fp, 'utf8'))
    assert.equal(replacementMemory.task_diagnostics.taskId, 'replacement-diagnostic-task')
    assert.equal(replacementMemory.task_diagnostics.status, 'completed')
    settings.place_world_id = null

    const eventsFor = async name => {
      const files = await fs.readdir(path.join(root, `bots/${name}/histories`))
      return (await fs.readFile(path.join(root, `bots/${name}/histories`, files[0]), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    }
    const taskBudgets = { ...settings.codex_session, task_budget_ms: 30, max_operations: 24, max_turns: 30 }
    settings.codex_session = taskBudgets
    // Elapsed limits cancel model waits and produce exactly one terminal.
    const modelWaitAgent = makeAgent('ModelWaitBudget')
    await until(() => modelWaitAgent.coder.code_template && modelWaitAgent.coder.code_lint_template)
    let modelWaitClosed = false
    const modelWaitRuntime = new CodexRuntime(modelWaitAgent, { makeSession: () => ({
      open: async signal => { signal.addEventListener('abort', () => {}, { once: true }) },
      runTurn: async () => new Promise((resolve, reject) => {
        const abort = () => reject(new Error('model wait aborted'))
        modelWaitRuntime.abort.signal.addEventListener('abort', abort, { once: true })
      }), close: async () => { modelWaitClosed = true }
    }) })
    modelWaitAgent.codexRuntime = modelWaitRuntime
    assert.equal(await modelWaitRuntime.run('operator', () => true, 'model-wait-budget'), false)
    const modelWaitEvents = await eventsFor('ModelWaitBudget')
    const modelWaitTerminals = modelWaitEvents.filter(event => event.type === 'finished')
    assert.equal(modelWaitTerminals.length, 1)
    assert.equal(modelWaitTerminals[0].terminationReason, 'task-budget:elapsed-time')
    assert.equal(modelWaitTerminals[0].taskBudget.threadTurns, 1)
    assert.equal(modelWaitClosed, true)

    // Elapsed stop request does not claim settlement while SDK work is still draining.
    const operationWaitAgent = makeAgent('OperationWaitBudget')
    await until(() => operationWaitAgent.coder.code_template && operationWaitAgent.coder.code_lint_template)
    const operationBody = deferred(), operationStarted = deferred()
    operationWaitAgent.coder.executeCode = async () => { operationStarted.resolve(); await operationBody.promise; return 'drained' }
    operationWaitAgent.interrupt = () => {}
    const operationWaitRuntime = new CodexRuntime(operationWaitAgent, { makeSession: ({ execute }) => ({
      open: async () => {}, runTurn: async () => ({ operation: execute('await skills.wait(bot, 80);'), messages: [] }), close: async () => {}
    }) })
    operationWaitAgent.codexRuntime = operationWaitRuntime
    let operationRunSettled = false
    const operationRun = operationWaitRuntime.run('operator', () => true, 'operation-wait-budget').finally(() => { operationRunSettled = true })
    await operationStarted.promise
    await delay(60)
    assert.equal(operationWaitAgent.actions.executing, true)
    assert.equal(operationRunSettled, false, 'task terminal waits for the actual operation drain after stop is requested')
    assert.equal((await eventsFor('OperationWaitBudget')).some(event => event.type === 'finished'), false, 'no terminal claims a still-pending operation settled')
    operationBody.resolve()
    assert.equal(await operationRun, false)
    const operationWaitTerminals = (await eventsFor('OperationWaitBudget')).filter(event => event.type === 'finished')
    assert.equal(operationWaitTerminals.length, 1)
    assert.equal(operationWaitTerminals[0].operationSettlement, 'settled')
    assert.equal(operationWaitTerminals[0].terminationReason, 'task-budget:elapsed-time')

    // Accepted operation and thread-turn caps are counted independently.
    settings.codex_session = { ...taskBudgets, task_budget_ms: 1000, max_operations: 1, max_turns: 30 }
    const operationCapAgent = makeAgent('OperationCap')
    await until(() => operationCapAgent.coder.code_template && operationCapAgent.coder.code_lint_template)
    operationCapAgent.coder.executeCode = async () => true
    const operationCapRuntime = new CodexRuntime(operationCapAgent, { makeSession: ({ execute }) => {
      let calls = 0
      return { open: async () => {}, runTurn: async () => {
        if (++calls === 1) return { operation: execute('operation-1'), messages: [] }
        try { await execute('operation-2') } catch {}
        return { operation: null, messages: [] }
      }, close: async () => {} }
    } })
    operationCapAgent.codexRuntime = operationCapRuntime
    assert.equal(await operationCapRuntime.run('operator', () => true, 'operation-cap'), false)
    const operationCapTerminal = (await eventsFor('OperationCap')).find(event => event.type === 'finished')
    assert.equal(operationCapTerminal.terminationReason, 'task-budget:accepted-operations')
    assert.equal(operationCapTerminal.taskBudget.acceptedOperations, 1)

    settings.codex_session = { ...taskBudgets, task_budget_ms: 1000, max_operations: 24, max_turns: 1 }
    const turnCapAgent = makeAgent('TurnCap')
    await until(() => turnCapAgent.coder.code_template && turnCapAgent.coder.code_lint_template)
    turnCapAgent.coder.executeCode = async () => true
    const turnCapRuntime = new CodexRuntime(turnCapAgent, { makeSession: ({ execute }) => ({
      open: async () => {}, runTurn: async () => ({ operation: execute('one operation'), messages: [] }), close: async () => {}
    }) })
    turnCapAgent.codexRuntime = turnCapRuntime
    assert.equal(await turnCapRuntime.run('operator', () => true, 'turn-cap'), false)
    const turnCapTerminal = (await eventsFor('TurnCap')).find(event => event.type === 'finished')
    assert.equal(turnCapTerminal.terminationReason, 'task-budget:thread-turns')
    assert.equal(turnCapTerminal.taskBudget.threadTurns, 1)
    settings.codex_session = taskBudgets
    assert.equal(await mainAgent.handleMessage('operator', '!stop'), true)
    assert.equal(mainAgent.history.invalidations, 2, 'Stop also invalidates any outstanding summary epoch')
    assert.equal(mainAgent.actions.userStopped, true, 'literal Stop remains available')
    // Rule contents can change between decisions; keep them out of the fixed AGENTS.md.
    const ruleAgent = makeAgent('Rules')
    let rule = 'first rule', turnCount = 0
    const inputs = []
    const acceptedRequest = { role: 'user', content: 'Complete the original requested outcome.' }
    ruleAgent.history.getHistory = () => [acceptedRequest]
    ruleAgent.prompter.withBotRules = async text => text + '\n' + rule
    const ruleRuntime = new CodexRuntime(ruleAgent, { makeSession: ({ execute }) => ({
      open: async () => {},
      runTurn: async input => { inputs.push(input); turnCount++; if (turnCount === 1) { rule = 'updated rule'; ruleAgent.history.getHistory = () => [{ role: 'system', content: 'Later operation context.' }]; return { operation: execute('await Promise.resolve();'), messages: [] } } return { operation: null, messages: ['done'] } },
      close: async () => {}
    }) })
    ruleAgent.codexRuntime = ruleRuntime
    await until(() => ruleAgent.coder.code_template && ruleAgent.coder.code_lint_template)
    assert.equal(await ruleRuntime.run('operator', () => true), true)
    assert.doesNotMatch(await fs.readFile(path.join(root, 'src/process/codex/AGENTS.md'), 'utf8'), /first rule/)
    assert.ok(inputs[0].endsWith('first rule'))
    assert.ok(inputs[1].endsWith('updated rule'))
    const resumedRequest = inputs[1].split('CURRENT OPERATOR REQUEST (still active):\n')[1].split('\nCURRENT CAPABILITIES:')[0]
    assert.deepEqual(JSON.parse(resumedRequest), acceptedRequest, 'resumed decisions retain the accepted goal even when later history changes')
    // Stop/new intent/management/shutdown invalidate retained work; stale result cannot resume.
    for (const reason of ['user', 'superseded', 'management', 'shutdown']) {
      const testAgent = makeAgent('Cancel' + reason)
      const body = deferred(), started = deferred()
      testAgent.coder.executeCode = async () => { started.resolve(); await body.promise }
      testAgent.interrupt = () => body.resolve()
      let turns = 0, closed = false
      const runtime = new CodexRuntime(testAgent, { makeSession: ({ execute }) => ({
        open: async () => {}, runTurn: async () => { turns++; return { operation: execute('test'), messages: [] } }, close: async () => { closed = true }
      }) })
      testAgent.codexRuntime = runtime
      let current = true
      const running = runtime.run('operator', () => current)
      await started.promise
      current = false
      await runtime.cancel(reason)
      await testAgent.actions.stop(reason)
      assert.equal(await running, false)
      assert.equal(turns, 1)
      assert.equal(closed, true)
      assert.equal(testAgent.actions.executing, false)
      const terminals = (await eventsFor('Cancel' + reason)).filter(event => event.type === 'finished')
      assert.equal(terminals.length, 1, `${reason} cancellation writes one terminal record`)
    }
    console.log('codex session fixtures passed: compound/lint/false domain result/unawaited SDK drain/partial/stall/owned transport/tool-result wait/phases/cancellation')
  } finally {
    process.chdir(oldCwd)
    if (oldBin === undefined) delete process.env.MINDCRAFT_CODEX_BIN; else process.env.MINDCRAFT_CODEX_BIN = oldBin
    await fs.rm(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
