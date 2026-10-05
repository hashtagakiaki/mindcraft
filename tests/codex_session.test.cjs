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
    const { CodexRuntime, validateCodexRuntime, observedState } = await load('src/agent/codex_runtime.js')
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
      agent.prompter = { profile: { model: 'codex/gpt-6-luna' }, skill_libary: { getAllSkillDocs: async () => ['skills.wait\nWait for a bounded number of milliseconds.', 'skills.goToPlayer\nNavigate to a named player and return false when it is missing.'] }, withBotRules: async text => { rules.push(text); return text + '\nCURRENT RULES' } }
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
    await fs.writeFile(binary, `#!${node}\nimport {createInterface} from 'node:readline';\nlet turn=0; const out=m=>process.stdout.write(JSON.stringify(m)+'\\n');\ncreateInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);\nif(m.method==='initialize')out({id:m.id,result:{}});\nif(m.method==='thread/start')out({id:m.id,result:{model:m.params.model,reasoningEffort:'medium',thread:{id:'t'}}});\nif(m.method==='turn/start'){turn++;out({id:m.id,result:{turn:{id:'u'+turn}}});if(turn===1)out({id:900,method:'item/tool/call',params:{threadId:'t',turnId:'u1',tool:'minecraft_execute',arguments:{code:'log(bot, "from tool");\\nawait Promise.resolve();'}}});else {out({method:'item/completed',params:{item:{type:'agentMessage',text:'verified'}}});out({method:'turn/completed',params:{turn:{id:'u'+turn,status:'completed'}}});}}\nif(m.method==='turn/interrupt'){out({id:m.id,result:{}});out({method:'turn/completed',params:{turn:{id:m.params.turnId,status:'interrupted'}}});}\n});`)
    await fs.chmod(binary, 0o700)
    process.env.MINDCRAFT_CODEX_BIN = binary
    const events = [], gate = deferred()
    let calls = 0
    const session = new CodexSession({ model: 'gpt-6-luna', record: (type, detail) => events.push({ type, detail }), execute: async () => { calls++; return gate.promise } })
    try {
      await session.open('fixture', new AbortController().signal)
      const first = await session.runTurn('do work')
      assert.ok(first.operation)
      assert.equal(calls, 1)
      assert.equal(events.at(-1).detail.status, 'interrupted')
      let settled = false
      first.operation.then(() => { settled = true })
      await delay(100)
      assert.equal(settled, false, 'model interruption retains the action promise')
      gate.resolve({ success: true, value: 42 })
      assert.equal((await first.operation).value, 42)
      const second = await session.runTurn('completed value 42')
      assert.equal(second.operation, null)
      assert.deepEqual(second.messages, ['verified'])
      assert.equal(calls, 1)
    } finally { await session.close() }
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
    let resolveSummary
    let summarySignal
    const summaryPendingAgent = makeAgent('SummaryPending')
    summaryPendingAgent.prompter.promptMemSaving = (_turns, options) => {
      summarySignal = options.signal
      return new Promise(resolve => { resolveSummary = resolve })
    }
    summaryPendingAgent.history = new History(summaryPendingAgent)
    for (let index = 1; index <= 4; index++) await summaryPendingAgent.history.add('SummaryPending', `older turn ${index}`)
    const summaryPendingRuntime = new CodexRuntime(summaryPendingAgent, { makeSession: () => ({
      open: async () => {}, runTurn: async () => ({ operation: null, messages: ['The answer is checkpointed and reported.'] }), close: async () => {}
    }) })
    summaryPendingAgent.codexRuntime = summaryPendingRuntime
    let finishRoute
    summaryPendingAgent.routeResponse = async () => new Promise(resolve => { finishRoute = resolve })
    const summaryRun = summaryPendingRuntime.run('operator', () => true, 'summary-pending-task')
    await until(() => typeof finishRoute === 'function')
    assert.equal(typeof resolveSummary, 'function', 'threshold summary remains pending while task ends')
    assert.ok(summarySignal && !summarySignal.aborted, 'pending summary has a request owner signal')
    const summaryPendingFiles = await fs.readdir(path.join(root, 'bots/SummaryPending/histories'))
    const summaryTracePath = path.join(root, 'bots/SummaryPending/histories', summaryPendingFiles.find(file => file.startsWith('codex-')))
    const beforeRouteEvents = (await fs.readFile(summaryTracePath, 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line))
    assert.equal(beforeRouteEvents.filter(event => event.type === 'response_checkpoint').length, 1)
    assert.equal(beforeRouteEvents.some(event => ['response_reported', 'finished'].includes(event.type)), false,
      'generated response is checkpointed before routing, and terminal waits for route completion')
    finishRoute()
    assert.equal(await summaryRun, true, 'pending summary does not block report routing or task terminal')
    const summaryPendingEvents = (await fs.readFile(summaryTracePath, 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(summaryPendingEvents.filter(event => ['response_checkpoint', 'response_reported', 'finished'].includes(event.type)).map(event => event.type),
      ['response_checkpoint', 'response_reported', 'finished'], 'generation checkpoint, actual report, and terminal are recorded independently')
    const summaryPendingMemory = JSON.parse(await fs.readFile(path.join(root, 'bots/SummaryPending/memory.json'), 'utf8'))
    assert.match(summaryPendingMemory.turns.map(turn => turn.content).join('\n'), /The answer is checkpointed and reported\./,
      'response turn is durable before the summary finishes')
    summaryPendingAgent.history.invalidateSummaries()
    assert.equal(summarySignal.aborted, true, 'new summary epoch cancels the actual provider request')
    resolveSummary('late summary from an invalidated epoch')
    await delay(0)
    assert.equal(summaryPendingAgent.history.memory, '', 'late summary after invalidation cannot overwrite newer state')

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
      open: async (_instructions, signal) => { signal.addEventListener('abort', () => {}, { once: true }) },
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
    // Rule contents can change between turns; never freeze an old snapshot in baseInstructions.
    const ruleAgent = makeAgent('Rules')
    let rule = 'first rule', base, turnCount = 0
    const inputs = []
    ruleAgent.prompter.withBotRules = async text => text + '\n' + rule
    const ruleRuntime = new CodexRuntime(ruleAgent, { makeSession: ({ execute }) => ({
      open: async instructions => { base = instructions },
      runTurn: async input => { inputs.push(input); turnCount++; if (turnCount === 1) { rule = 'updated rule'; return { operation: execute('await Promise.resolve();'), messages: [] } } return { operation: null, messages: ['done'] } },
      close: async () => {}
    }) })
    ruleAgent.codexRuntime = ruleRuntime
    await until(() => ruleAgent.coder.code_template && ruleAgent.coder.code_lint_template)
    assert.equal(await ruleRuntime.run('operator', () => true), true)
    assert.ok(!base.includes('first rule'))
    assert.ok(inputs[0].endsWith('first rule'))
    assert.ok(inputs[1].endsWith('updated rule'))
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
    console.log('codex session fixtures passed: compound/lint/false domain result/unawaited SDK drain/partial/stall/owned transport/pause/resume/cancellation')
  } finally {
    process.chdir(oldCwd)
    if (oldBin === undefined) delete process.env.MINDCRAFT_CODEX_BIN; else process.env.MINDCRAFT_CODEX_BIN = oldBin
    await fs.rm(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
