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
    const { CodexRuntime, validateCodexRuntime } = await load('src/agent/codex_runtime.js')
    const { ActionManager } = await load('src/agent/action_manager.js')
    const { Coder } = await load('src/agent/coder.js')
    const { CodexSession } = await load('src/process/codex_session.js')
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
      agent.bot = Object.assign(new EventEmitter(), { output: '', interrupt_code: false, entity: { position: { x: 0, y: 64, z: 0 } }, inventory: { items: () => [] }, modes: { pause() {}, unpause() {}, flushBehaviorLog: () => '' } })
      agent.clearBotLogs = () => { agent.bot.output = ''; agent.bot.interrupt_code = false }
      agent.requestInterrupt = () => { agent.bot.interrupt_code = true; agent.interrupt?.() }
      agent.prompter = { profile: { model: 'codex/gpt-6-luna' }, skill_libary: { getAllSkillDocs: async () => [] }, withBotRules: async text => { rules.push(text); return text + '\nCURRENT RULES' } }
      agent.history = { memory: 'vision used to be unavailable', getHistory: () => [{ role: 'user', content: 'test' }], add: async (...args) => rows.push(args), save: async () => {} }
      agent.routeResponse = (source, text) => routed.push(text)
      agent.self_prompter = { stopForRecovery() {}, isActive: () => false, shouldInterrupt: () => false }
      agent.actions = new ActionManager(agent)
      agent.coder = new Coder(agent)
      return agent
    }
    const agent = makeAgent('NativeFixture')
    await until(() => agent.coder.code_template && agent.coder.code_lint_template)
    const result = await agent.actions.runAction('compound', () => agent.coder.executeCode('log(bot, "first");\nawait Promise.resolve();\nlog(bot, "second");'), { timeout: 0, outputLimit: 16000 })
    assert.equal(result.success, true)
    assert.match(result.message, /first[\s\S]*second/)
    const bad = await agent.actions.runAction('lint', () => agent.coder.executeCode('await skills.nonexistent(bot);'), { timeout: 0 })
    assert.equal(bad.success, false)
    assert.match(bad.message, /functions do not exist/)
    const partial = await agent.actions.runAction('partial', () => agent.coder.executeCode('log(bot, "kept mutation");\nawait Promise.resolve();\nthrow new Error("boom");'), { timeout: 0 })
    assert.match(partial.message, /kept mutation[\s\S]*boom/)
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
    assert.equal(await mainAgent.handleMessage('operator', 'do the fixture task'), true)
    assert.ok(mainAgent.codexRuntime, 'actual Agent.handleMessage uses the native runtime')
    assert.equal(await mainAgent.handleMessage('operator', '!stop'), true)
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
    }
    console.log('codex session fixtures passed: compound/lint/partial/stall/owned transport/pause/resume/cancellation')
  } finally {
    process.chdir(oldCwd)
    if (oldBin === undefined) delete process.env.MINDCRAFT_CODEX_BIN; else process.env.MINDCRAFT_CODEX_BIN = oldBin
    await fs.rm(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
