'use strict'

// Offline Codex adapter fixture. It executes only a temporary fake CLI and
// owned Node grandchildren; it never calls Codex, Minecraft, or external APIs.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { mkdtemp, readFile, readdir, rm, writeFile, chmod } = require('node:fs/promises')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const nodeBinary = '/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node'
const sourcePath = path.resolve(__dirname, '../src/models/codex.js')
const helperPath = path.resolve(__dirname, '../src/process/owned_cli.js')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const activeProcessGroups = new Map()
const activeBotProcesses = new Set()
const activeHelperProcesses = new Set()

async function waitForFile(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { return await readFile(file, 'utf8') }
    catch { await delay(10) }
  }
  throw new Error(`fixture did not create ${file}`)
}

function isRunning(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
    return state !== 'Z' && state !== 'X'
  } catch { return false }
}

function hasRunningSession(sessionId) {
  try {
    return fs.readdirSync('/proc').some(entry => {
      if (!/^\d+$/.test(entry)) return false
      try {
        const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8')
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        return fields[0] !== 'Z' && fields[0] !== 'X' && Number(fields[2]) === sessionId && Number(fields[3]) === sessionId
      } catch { return false }
    })
  } catch { return true }
}

async function waitForStopped(pids, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pids.every(pid => !isRunning(pid))) return
    await delay(20)
  }
  assert.fail(`owned fixture processes are still running: ${pids.filter(isRunning).join(', ')}`)
}

async function waitForSessionsStopped(sessionIds, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (sessionIds.every(sessionId => !hasRunningSession(sessionId))) return
    await delay(20)
  }
  assert.fail(`owned fixture sessions are still running: ${sessionIds.filter(hasRunningSession).join(', ')}`)
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function nextMessage(child, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('timed out waiting for fixture IPC message')), timeoutMs)
    const onMessage = message => { if (predicate(message)) finish(null, message) }
    const onClose = () => finish(new Error('fixture bot closed before expected IPC message'))
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

function waitForClose(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('timed out waiting for fixture bot close')), timeoutMs)
    const onClose = () => finish()
    const finish = error => {
      clearTimeout(timeout)
      child.removeListener('close', onClose)
      error ? reject(error) : resolve()
    }
    child.once('close', onClose)
  })
}

async function runSupervisedFixtures(sandbox, tmpRoot, fakeCli) {
  const botFile = path.join(sandbox, 'fixture-bot.mjs')
  await writeFile(botFile, `import { pathToFileURL } from 'node:url'
const { Codex } = await import(pathToFileURL(${JSON.stringify(sourcePath)}).href)
const mode = process.argv[2]
const marker = process.argv[3]
const controller = new AbortController()
process.on('message', message => {
  if (message?.type === 'fixture-cancel') {
    controller.abort('fixture cancellation')
    process.send?.({ type: 'fixture-cancel-received' })
  }
})
try {
  const response = await new Codex().sendRequest([marker], mode, '***', { signal: controller.signal })
  process.send?.({ type: 'fixture-result', ok: true, response }, () => process.disconnect())
} catch (error) {
  process.send?.({ type: 'fixture-result', ok: false, name: error.name, message: error.message }, () => process.disconnect())
}
`)
  const env = { ...process.env, TMPDIR: tmpRoot, MINDCRAFT_CODEX_BIN: fakeCli, MINDCRAFT_CODEX_TIMEOUT_MS: '1500' }
  const observations = {}

  const spawnBot = (mode, marker) => {
    const bot = spawn(nodeBinary, [botFile, mode, marker], {
      env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })
    activeBotProcesses.add(bot)
    bot.on('message', message => {
      if (message?.type === 'mindcraft:owned-process' && Number.isSafeInteger(message.pid) && message.pid > 1) {
        activeProcessGroups.set(message.pid, [message.pid])
      }
    })
    bot.once('close', () => activeBotProcesses.delete(bot))
    return bot
  }
  const readRegistration = async bot => {
    const registration = await nextMessage(bot, message => message?.type === 'mindcraft:owned-process')
    assert.equal(registration.role, 'cli')
    assert.ok(Number.isSafeInteger(registration.pid) && registration.pid > 1)
    assert.equal(typeof registration.requestId, 'string')
    activeProcessGroups.set(registration.pid, [registration.pid])
    return registration
  }
  const sendAck = (bot, registration, accepted) => bot.send({
    type: 'mindcraft:owned-process-ack',
    role: 'cli',
    pid: registration.pid,
    requestId: registration.requestId,
    accepted
  })
  const readResult = bot => nextMessage(bot, message => message?.type === 'fixture-result')

  // A matching directory prefix alone is insufficient authority for deletion.
  {
    const fakeDirectory = path.join(sandbox, 'mindcraft-codex-fake-prefix')
    await fs.promises.mkdir(fakeDirectory)
    const sentinel = path.join(fakeDirectory, 'keep-me')
    await writeFile(sentinel, 'unowned fixture directory')
    const helper = spawn(nodeBinary, [helperPath, 'unowned-request', fakeCli, '[]', fakeDirectory], {
      cwd: fakeDirectory,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })
    activeHelperProcesses.add(helper)
    helper.once('close', () => activeHelperProcesses.delete(helper))
    await new Promise(resolve => helper.once('spawn', resolve))
    helper.kill('SIGTERM')
    await waitForClose(helper)
    assert.equal(await readFile(sentinel, 'utf8'), 'unowned fixture directory')
    await rm(fakeDirectory, { recursive: true, force: true })
    observations.fakeTempPrefixDidNotAuthorizeDelete = true
  }

  // The bot dies before parent ACK: the unstarted helper must see IPC EOF and
  // leave no executable Codex process or request marker behind.
  {
    const marker = path.join(sandbox, 'pre-ack-cli-marker')
    const bot = spawnBot('pre-ack', marker)
    const registration = await readRegistration(bot)
    const closed = waitForClose(bot)
    bot.kill('SIGKILL')
    await closed
    await waitForStopped([registration.pid])
    activeProcessGroups.delete(registration.pid)
    assert.equal(fs.existsSync(marker), false)
    assert.deepEqual(await readdir(tmpRoot), [], 'bot death before ACK must also clean its request tempdir')
    observations.botDeathBeforeAck = { helperStopped: true, cliNeverStarted: true }
  }

  // Explicit denial and cancellation before a deliberately stale accepted ACK
  // must both fail closed without launching the CLI.
  {
    const marker = path.join(sandbox, 'denied-cli-marker')
    const bot = spawnBot('denied', marker)
    const registration = await readRegistration(bot)
    const result = readResult(bot)
    sendAck(bot, registration, false)
    const received = await result
    await waitForClose(bot)
    await waitForStopped([registration.pid])
    activeProcessGroups.delete(registration.pid)
    assert.equal(received.ok, false)
    assert.match(received.message, /rejected/)
    assert.equal(fs.existsSync(marker), false)
    assert.deepEqual(await readdir(tmpRoot), [])
    observations.deniedRegistration = { helperStopped: true, cliNeverStarted: true }
  }
  {
    const marker = path.join(sandbox, 'stale-ack-cli-marker')
    const bot = spawnBot('stale-ack', marker)
    const registration = await readRegistration(bot)
    const result = readResult(bot)
    const cancellationNotice = nextMessage(bot, message => message?.type === 'fixture-cancel-received')
    bot.send({ type: 'fixture-cancel' })
    await cancellationNotice
    sendAck(bot, registration, true)
    const received = await result
    await waitForClose(bot)
    await waitForStopped([registration.pid])
    activeProcessGroups.delete(registration.pid)
    assert.equal(received.ok, false)
    assert.equal(received.name, 'AbortError')
    assert.equal(fs.existsSync(marker), false)
    assert.deepEqual(await readdir(tmpRoot), [])
    observations.cancelBeforeLateAck = { helperStopped: true, staleAckDidNotStartCli: true }
  }

  // An accepted helper can be cancelled; its leader and TERM-ignoring
  // grandchild must be gone before the request settles.
  {
    const marker = path.join(sandbox, 'accepted-cancel.pids')
    const bot = spawnBot('accepted-cancel', marker)
    const registration = await readRegistration(bot)
    const result = readResult(bot)
    sendAck(bot, registration, true)
    const processInfo = JSON.parse(await waitForFile(marker))
    activeProcessGroups.set(registration.pid, [registration.pid, processInfo.parent, processInfo.child])
    bot.send({ type: 'fixture-cancel' })
    const received = await result
    await waitForClose(bot)
    await waitForStopped([registration.pid, processInfo.parent, processInfo.child])
    activeProcessGroups.delete(registration.pid)
    assert.equal(received.ok, false)
    assert.equal(received.name, 'AbortError')
    assert.equal(fs.existsSync(processInfo.dir), false, 'accepted cancellation must await removal of its request tempdir')
    assert.deepEqual(await readdir(tmpRoot), [], `unexpected request tempdirs remain after accepted cancellation: ${processInfo.dir}`)
    observations.acceptedCancellation = { helperCliGrandchildStopped: true, tempdirRemoved: true }
  }

  // A CLI leader can exit before its child. The helper owns the inherited
  // group and must reap the surviving descendant even without a cancel call.
  {
    const marker = path.join(sandbox, 'leader-exit.pids')
    const bot = spawnBot('leader-exit', marker)
    const registration = await readRegistration(bot)
    const result = readResult(bot)
    sendAck(bot, registration, true)
    const processInfo = JSON.parse(await waitForFile(marker))
    activeProcessGroups.set(registration.pid, [registration.pid, processInfo.child])
    const received = await result
    await waitForClose(bot)
    await waitForStopped([registration.pid, processInfo.child])
    activeProcessGroups.delete(registration.pid)
    assert.equal(received.ok, false)
    assert.ok(/no assistant message|exited/.test(received.message))
    assert.deepEqual(await readdir(tmpRoot), [])
    observations.cliLeaderExit = { grandchildStoppedBeforeTempdirRemoval: true }
  }
  return observations
}

async function runProcIdentityFixtures(sandbox) {
  const fixtureDir = path.join(sandbox, 'proc-identity')
  await fs.promises.mkdir(fixtureDir, { recursive: true })
  await writeFile(path.join(fixtureDir, 'package.json'), '{"type":"module"}')
  await writeFile(path.join(fixtureDir, 'proc_mock.js'), `
import * as fs from 'node:fs'
let entries = []
let stats = new Map()
let errors = new Map()
export function setProcFixture(nextEntries, nextStats, nextErrors = new Map()) {
  entries = nextEntries
  stats = nextStats
  errors = nextErrors
}
export function readdirSync(target, ...args) {
  return target === '/proc' ? entries : fs.readdirSync(target, ...args)
}
export function readFileSync(target, ...args) {
  if (target.startsWith('/proc/') && target.endsWith('/stat')) {
    const error = errors.get(target)
    if (error) throw Object.assign(new Error(error), { code: error })
    if (!stats.has(target)) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    return stats.get(target)
  }
  return fs.readFileSync(target, ...args)
}
export const writeFileSync = fs.writeFileSync
`)
  let source = await readFile(sourcePath, 'utf8')
  source = source.replace("import { readdirSync, readFileSync, writeFileSync } from 'fs';", "import { readdirSync, readFileSync, writeFileSync } from './proc_mock.js';")
  source = source.replace('function inspectOwnedSession(', 'export function inspectOwnedSession(')
  source = source.replace('function ownedSessionExists(', 'export function ownedSessionExists(')
  const modulePath = path.join(fixtureDir, 'codex-proc-test.mjs')
  await writeFile(modulePath, source)
  const procMock = await import(pathToFileURL(path.join(fixtureDir, 'proc_mock.js')).href)
  const adapter = await import(pathToFileURL(modulePath).href + `?test=${Date.now()}`)
  const makeStat = (pid, pgid, sid, starttime) => {
    const fields = Array(20).fill('0')
    fields[0] = 'S'
    fields[1] = '1'
    fields[2] = String(pgid)
    fields[3] = String(sid)
    fields[19] = String(starttime)
    return `${pid} (fixture) ${fields.join(' ')}`
  }

  const foreignGroup = 700001
  procMock.setProcFixture(['700001', '700002'], new Map([
    ['/proc/700001/stat', makeStat(700001, foreignGroup, foreignGroup, 22)],
    ['/proc/700002/stat', makeStat(700002, foreignGroup, foreignGroup, 33)],
  ]))
  const foreignInspection = adapter.inspectOwnedSession(foreignGroup, '11')
  assert.equal(adapter.ownedSessionExists(foreignGroup, '11'), false,
    'recycled numeric group with a different leader starttime must be foreign even if it has children')
  assert.equal(foreignInspection.foreign, true, JSON.stringify(foreignInspection))

  const selfStat = fs.readFileSync('/proc/self/stat', 'utf8')
  const fields = selfStat.slice(selfStat.lastIndexOf(')') + 2).split(' ')
  const visibleGroup = Number(fields[2])
  const inaccessible = `/proc/700003/stat`
  procMock.setProcFixture(['700003'], new Map(), new Map([[inaccessible, 'EACCES']]))
  assert.equal(adapter.ownedSessionExists(visibleGroup, '1'), true,
    'unreadable process stat must remain unknown when kill(0) confirms the process group exists')
  procMock.setProcFixture(['700004'], new Map([['/proc/700004/stat', 'invalid stat']]))
  assert.equal(adapter.inspectOwnedSession(visibleGroup, '1').unknown, true,
    'invalid proc stat must not be interpreted as group disappearance')
  return { foreignPidReuseNotSignalledOrAwaited: true, unreadableAndMalformedProcStayUnknown: true }
}

async function loadSourceFixture(source, target, importReplacements, stubs) {
  let content = await readFile(source, 'utf8')
  for (const [from, to] of importReplacements) content = content.replaceAll(from, to)
  await writeFile(target, content)
  for (const [relative, stub] of Object.entries(stubs)) {
    const filename = path.join(path.dirname(target), relative)
    await fs.promises.mkdir(path.dirname(filename), { recursive: true })
    await writeFile(filename, stub)
  }
  return import(pathToFileURL(target).href + `?fixture=${Date.now()}-${Math.random()}`)
}

async function runCoderPrompterFixtures(sandbox) {
  const fixtureDir = path.join(sandbox, 'source-fixtures')
  await fs.promises.mkdir(fixtureDir, { recursive: true })
  await writeFile(path.join(fixtureDir, 'package.json'), '{"type":"module"}')
  const previousCwd = process.cwd()
  process.chdir(fixtureDir)
  try {
    await fs.promises.mkdir('bots', { recursive: true })
    await writeFile('bots/execTemplate.js', '/* CODE HERE */')
    await writeFile('bots/lintTemplate.js', '/* CODE HERE */')
    const coderModule = path.join(fixtureDir, 'coder.js')
    const coderStubs = {
      'stubs/lockdown.js': `export function lockdown() {} export function makeCompartment() { return { evaluate() { return async () => { globalThis.fixtureExecCount++; }; } }; }`,
      'stubs/skills.js': 'export function unused() {}',
      'stubs/settings.js': 'export default { generated_code_fail_on_false: [] };',
      'library/operation_context.js': await readFile(path.resolve(previousCwd, 'src/agent/library/operation_context.js'), 'utf8'),
      'stubs/world.js': 'export function unused() {}',
      'stubs/vec3.js': 'export class Vec3 {}',
      'stubs/eslint.js': 'export class ESLint { async lintText() { return []; } }'
    }
    const { Coder } = await loadSourceFixture(
      path.resolve(previousCwd, 'src/agent/coder.js'), coderModule,
      [
        ["'./library/lockdown.js'", "'./stubs/lockdown.js'"],
        ["'./library/skills.js'", "'./stubs/skills.js'"],
        ["'./settings.js'", "'./stubs/settings.js'"],
        ["'./library/world.js'", "'./stubs/world.js'"],
        ["'vec3'", "'./stubs/vec3.js'"],
        ['"eslint"', '"./stubs/eslint.js"']
      ], coderStubs
    )
    const prompterModule = path.join(fixtureDir, 'prompter.js')
    const prompterStubs = {
      'stubs/fs.js': 'export const readFileSync=()=>"{}"; export const mkdirSync=()=>{}; export const writeFileSync=()=>{}; export { promises } from "node:fs";',
      'stubs/examples.js': 'export class Examples {}',
      'stubs/commands.js': 'export function getCommandDocs(){return ""} export function getCommand(){return {perform:async()=>""}}',
      'stubs/skill_library.js': 'export class SkillLibrary {}',
      'stubs/text.js': 'export function stringifyTurns(){return ""}',
      'stubs/settings.js': 'export default {base_profile:"",num_examples:0,relevant_docs_count:0,log_all_prompts:false}',
      'stubs/model_map.js': 'export function selectAPI(){return {api:"fixture"}} export function createModel(){return {}}'
    }
    const { Prompter } = await loadSourceFixture(
      path.resolve(previousCwd, 'src/models/prompter.js'), prompterModule,
      [
        ["'fs'", "'./stubs/fs.js'"],
        ["'../utils/examples.js'", "'./stubs/examples.js'"],
        ["'../agent/commands/index.js'", "'./stubs/commands.js'"],
        ['"../agent/library/skill_library.js"', '"./stubs/skill_library.js"'],
        ["'../utils/text.js'", "'./stubs/text.js'"],
        ["'../agent/settings.js'", "'./stubs/settings.js'"],
        ["'./_model_map.js'", "'./stubs/model_map.js'"]
      ], prompterStubs
    )

    const controller = new AbortController()
    const pending = deferred()
    const logEntries = []
    let providerStarted = 0
    const prompter = Object.create(Prompter.prototype)
    Object.assign(prompter, {
      awaiting_coding: false,
      cooldown: 0,
      last_prompt_time: 0,
      profile: { coding: 'fixture prompt' },
      coding_examples: null,
      agent: { actions: { getCancellationContext: () => context }, places: null },
      code_model: { constructor: { prefix: 'openai' }, sendRequest: () => { providerStarted++; return pending.promise } },
      replaceStrings: async prompt => prompt,
      _saveLog: async (...args) => { logEntries.push(args) }
    })
    const context = { actionId: 1, signal: controller.signal }
    const promptRequest = prompter.promptCoding([], context)
    await delay(0)
    assert.equal(providerStarted, 1, 'provider request should be pending before cancellation')
    controller.abort('cancel generation')
    assert.equal(await promptRequest, null, 'unsupported provider response wrapper should settle at cancellation')
    assert.equal(prompter.awaiting_coding, false)
    pending.resolve('```stale```')
    await delay(0)
    assert.deepEqual(logEntries, [], 'late provider response must not be logged or returned')

    const preparationController = new AbortController()
    const preparationGate = deferred()
    let modelCalls = 0
    let preparationStarted = false
    const preparing = Object.create(Prompter.prototype)
    Object.assign(preparing, {
      awaiting_coding: false, cooldown: 0, last_prompt_time: 0,
      profile: { coding: 'fixture prompt' }, coding_examples: null,
      agent: { actions: { getCancellationContext: () => null }, places: null },
      code_model: { constructor: { prefix: 'openai' }, sendRequest: () => { modelCalls++; return Promise.resolve('should not run') } },
      replaceStrings: () => { preparationStarted = true; return preparationGate.promise },
      _saveLog: async () => { assert.fail('cancelled prompt preparation must not be logged') }
    })
    const preparationRequest = preparing.promptCoding([], { actionId: 9, signal: preparationController.signal })
    await delay(0)
    assert.equal(preparationStarted, true, 'prompt preparation should be pending before cancellation')
    preparationController.abort('stop while preparing')
    assert.equal(await preparationRequest, null, 'prompt preparation should settle on cancellation')
    preparationGate.resolve('late prompt')
    await delay(0)
    assert.equal(modelCalls, 0, 'late prompt preparation must not start a model request')
    assert.equal(preparing.awaiting_coding, false)

    const failed = Object.create(Prompter.prototype)
    Object.assign(failed, {
      awaiting_coding: false, cooldown: 0, last_prompt_time: 0,
      profile: { coding: 'fixture prompt' }, coding_examples: null,
      agent: { actions: { getCancellationContext: () => null }, places: null },
      code_model: { constructor: { prefix: 'openai' }, sendRequest: () => Promise.reject(new Error('provider failure')) },
      replaceStrings: async prompt => prompt,
      _saveLog: async () => {}
    })
    await assert.rejects(failed.promptCoding([]), /provider failure/)
    assert.equal(failed.awaiting_coding, false, 'generation error must restore awaiting_coding')
    failed.code_model.sendRequest = async () => 'valid response'
    assert.equal(await failed.promptCoding([]), 'valid response', 'next valid generation must proceed after an error')

    const modes = { paused: false, pause() { this.paused = true }, unpause() { this.paused = false } }
    const phases = []
    let promptImpl
    const makeAgent = contextForAction => ({
      bot: { interrupt_code: false, modes },
      actions: {
        getCancellationContext: () => contextForAction,
        setPhase: (phase, id) => { phases.push({ phase, id }); return true },
        getBotOutputSummary: () => 'fixture output'
      },
      prompter: { promptCoding: (...args) => promptImpl(...args) },
      places: null
    })
    const history = { getHistory: () => [] }
    let stageCalls = 0
    let lintCalls = 0
    let executionCalls = 0
    const coderController = new AbortController()
    const actionContext = { actionId: 2, signal: coderController.signal }
    const coder = new Coder(makeAgent(actionContext))
    coder._stageCode = async () => { stageCalls++; return { func: { main: async () => { executionCalls++ } }, src_lint_copy: '' } }
    coder._lintCode = async () => { lintCalls++; return null }

    const generationGate = deferred()
    promptImpl = () => generationGate.promise
    const duringGeneration = coder.generateCode(history)
    await delay(0)
    coderController.abort('stop during generation')
    generationGate.resolve('```stale code```')
    assert.equal(await duringGeneration, null)
    assert.equal(stageCalls, 0, 'cancelled generation must not stage late code')
    assert.equal(executionCalls, 0, 'cancelled generation must not execute late code')
    assert.equal(modes.paused, false, 'unstuck must be unpaused after cancellation')

    const stageController = new AbortController()
    coder.agent.actions.getCancellationContext = () => ({ actionId: 3, signal: stageController.signal })
    const stageGate = deferred()
    coder._stageCode = () => { stageCalls++; return stageGate.promise }
    promptImpl = async () => '```stage code```'
    const duringStage = coder.generateCode(history)
    await delay(0)
    stageController.abort('stop during staging')
    stageGate.resolve({ func: { main: async () => { executionCalls++ } }, src_lint_copy: '' })
    assert.equal(await duringStage, null)
    assert.equal(lintCalls, 0, 'cancellation after staging must skip lint and execution')
    assert.equal(executionCalls, 0)
    assert.equal(modes.paused, false)

    const lintController = new AbortController()
    coder.agent.actions.getCancellationContext = () => ({ actionId: 4, signal: lintController.signal })
    const lintGate = deferred()
    coder._stageCode = async () => { stageCalls++; return { func: { main: async () => { executionCalls++ } }, src_lint_copy: '' } }
    coder._lintCode = () => { lintCalls++; return lintGate.promise }
    const duringLint = coder.generateCode(history)
    await delay(0)
    lintController.abort('stop during lint')
    lintGate.resolve(null)
    assert.equal(await duringLint, null)
    assert.equal(executionCalls, 0, 'cancellation after lint must skip execution')
    assert.equal(modes.paused, false)
    assert.deepEqual(phases.map(entry => entry.phase), ['generating', 'generating', 'staging', 'generating', 'staging', 'linting'])

    const validController = new AbortController()
    coder.agent.actions.getCancellationContext = () => ({ actionId: 5, signal: validController.signal })
    coder._lintCode = async () => null
    promptImpl = async () => '```valid code```'
    const validResult = await coder.generateCode(history)
    assert.match(validResult, /Agent wrote this code/)
    assert.equal(executionCalls, 1, 'next valid generation must execute once after cancellation')
    assert.equal(modes.paused, false)
    assert.ok(phases.some(entry => entry.phase === 'executing' && entry.id === 5))
    return { lateResponseCannotStageOrExecute: true, cancellationAtStageAndLintStopsExecution: true, nextGenerationSucceeds: true }
  } finally {
    process.chdir(previousCwd)
  }
}

async function main() {
  assert.ok(fs.existsSync(nodeBinary), `required Node 20 binary missing: ${nodeBinary}`)
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'mc-generation-cancel-test-'))
  const tmpRoot = path.join(sandbox, 'codex-tmp')
  await fs.promises.mkdir(tmpRoot)
  const fakeCli = path.join(sandbox, 'fake-codex')
  await writeFile(fakeCli, `#!${nodeBinary}
const fs = require('node:fs')
const path = require('node:path')
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  const request = JSON.parse(input)
  const mode = request.systemMessage
  if (mode === 'success-model') {
    fs.writeFileSync(request.turns[0], JSON.stringify(process.argv.slice(2)))
    process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok***tail' } }) + '\\n')
    return
  }
  if (mode === 'success') {
    process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok***tail' } }) + '\\n')
    return
  }
  process.on('SIGTERM', () => {})
  const grandchild = require('node:child_process').spawn(${JSON.stringify(nodeBinary)}, ['-e', "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{},1000)", path.join(process.cwd(), 'grandchild.pid')], { stdio: 'ignore' })
  const stat = fs.readFileSync('/proc/' + process.pid + '/stat', 'utf8')
  const pgrp = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2])
  fs.writeFileSync(request.turns[0], JSON.stringify({ parent: process.pid, child: grandchild.pid, group: pgrp, dir: process.cwd() }))
  if (mode === 'leader-exit') process.exit(0)
  if (mode === 'blocked') process.stdout.write(JSON.stringify({ type: 'item.started' }) + '\\n')
  if (mode === 'malformed') process.stdout.write('{not-json}\\n')
  setInterval(() => {}, 1000)
})
`)
  await chmod(fakeCli, 0o755)

  const priorEnv = {
    TMPDIR: process.env.TMPDIR,
    MINDCRAFT_CODEX_BIN: process.env.MINDCRAFT_CODEX_BIN,
    MINDCRAFT_CODEX_TIMEOUT_MS: process.env.MINDCRAFT_CODEX_TIMEOUT_MS
  }
  process.env.TMPDIR = tmpRoot
  process.env.MINDCRAFT_CODEX_BIN = fakeCli
  process.env.MINDCRAFT_CODEX_TIMEOUT_MS = '500'
  const { Codex } = await import(pathToFileURL(sourcePath).href + '?fixture=normal')
  const codex = new Codex('gpt-6-luna')
  const observed = {}

  try {
    assert.equal(await codex.sendRequest([], 'success'), 'ok')
    observed.compatibleSuccessAndStopSequence = true
    const modelArgsFile = path.join(sandbox, 'model-args.json')
    assert.equal(await codex.sendRequest([modelArgsFile], 'success-model'), 'ok')
    const modelArgs = JSON.parse(await readFile(modelArgsFile, 'utf8'))
    const modelIndex = modelArgs.indexOf('--model')
    assert.ok(modelIndex >= 0 && modelArgs[modelIndex + 1] === 'gpt-6-luna', 'legacy CLI receives the selected profile model')
    observed.profileModelForwardedToLegacyCli = true

    const controller = new AbortController()
    const abortMarker = path.join(sandbox, 'abort.pids')
    const aborting = codex.sendRequest([abortMarker], 'abort', '***', { signal: controller.signal })
    const abortInfo = JSON.parse(await waitForFile(abortMarker))
    const abortDir = abortInfo.dir
    const pids = abortInfo
    activeProcessGroups.set(pids.group, [pids.parent, pids.child])
    controller.abort(new Error('stop generation'))
    await assert.rejects(aborting, error => error.name === 'AbortError' && error.message === 'stop generation')
    await waitForStopped([pids.parent, pids.child])
    activeProcessGroups.delete(pids.group)
    assert.equal(fs.existsSync(abortDir), false, 'tempdir must be removed after owned process group exits')
    observed.abort = { leaderAndGrandchildStopped: true, tempdirRemovedAfterStop: true }

    for (const [mode, expected] of [['blocked', /tool use was blocked/], ['malformed', /malformed JSON/], ['timeout', /timed out/]]) {
      const marker = path.join(sandbox, `${mode}.pids`)
      const request = codex.sendRequest([marker], mode)
      const rejection = assert.rejects(request, expected)
      const modePids = JSON.parse(await waitForFile(marker))
      const requestDir = modePids.dir
      activeProcessGroups.set(modePids.group, [modePids.parent, modePids.child])
      await rejection
      await waitForStopped([modePids.parent, modePids.child])
      activeProcessGroups.delete(modePids.group)
      assert.equal(fs.existsSync(requestDir), false, `${mode} tempdir should be removed after process cleanup`)
      observed[mode] = { leaderAndGrandchildStopped: true, tempdirRemoved: true }
    }

    process.env.MINDCRAFT_CODEX_BIN = path.join(sandbox, 'does-not-exist')
    const { Codex: SpawnFailureCodex } = await import(pathToFileURL(sourcePath).href + '?fixture=spawn-failure')
    await assert.rejects(new SpawnFailureCodex().sendRequest([], 'spawn failure'), /Could not start Codex CLI/)
    assert.deepEqual(await readdir(tmpRoot), [], 'spawn failure must remove its tempdir')
    observed.spawnError = { rejected: true, tempdirRemoved: true }

    const visionController = new AbortController()
    const visionMarker = path.join(sandbox, 'vision.pids')
    const vision = codex.sendVisionRequest([visionMarker], 'timeout', Buffer.from('fixture-image'), { signal: visionController.signal })
    const visionRejection = assert.rejects(vision, /cancelled/, 'vision requests share the same owned cancellation contract')
    const visionPids = JSON.parse(await waitForFile(visionMarker))
    activeProcessGroups.set(visionPids.group, [visionPids.parent, visionPids.child])
    visionController.abort('vision cancellation')
    await visionRejection
    await waitForStopped([visionPids.parent, visionPids.child])
    activeProcessGroups.delete(visionPids.group)
    observed.visionCancellation = { leaderAndGrandchildStopped: true, tempdirRemoved: true }
    assert.deepEqual(await readdir(tmpRoot), [], 'all request tempdirs must be removed')
    observed.supervisedHelper = await runSupervisedFixtures(sandbox, tmpRoot, fakeCli)
    observed.procIdentity = await runProcIdentityFixtures(sandbox)
    observed.coderPrompter = await runCoderPrompterFixtures(sandbox)
  } finally {
    let cleanupFailure = null
    const stopTrackedChildren = async children => {
      const live = [...children].filter(child => child.exitCode === null && child.signalCode === null)
      for (const child of live) {
        try { child.kill('SIGTERM') } catch {}
      }
      if (live.length) await delay(50)
      for (const child of live.filter(child => child.exitCode === null && child.signalCode === null)) {
        try { child.kill('SIGKILL') } catch {}
      }
      for (const child of live) {
        try { await waitForClose(child, 3000) }
        catch (error) { cleanupFailure ||= error }
      }
    }
    // Stop bots first so IPC disconnect reaches any pre-start helper, then
    // stop direct helper fixtures before scanning the owned process groups.
    await stopTrackedChildren(activeBotProcesses)
    await stopTrackedChildren(activeHelperProcesses)
    const outstandingPids = [...activeProcessGroups.values()].flat()
    for (const groupId of activeProcessGroups.keys()) {
      try { process.kill(-groupId, 'SIGTERM') } catch {}
    }
    if (activeProcessGroups.size) {
      await delay(50)
      for (const groupId of activeProcessGroups.keys()) {
        try { process.kill(-groupId, 'SIGKILL') } catch {}
      }
      try { await waitForStopped(outstandingPids) }
      catch (error) { cleanupFailure = error }
      try { await waitForSessionsStopped([...activeProcessGroups.keys()]) }
      catch (error) { cleanupFailure ||= error }
    }
    activeProcessGroups.clear()
    try {
      const remaining = await readdir(tmpRoot)
      if (remaining.length) cleanupFailure ||= new Error(`request tempdirs remain after fixture cleanup: ${remaining.join(', ')}`)
    } catch (error) { cleanupFailure ||= error }
    if (priorEnv.TMPDIR === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = priorEnv.TMPDIR
    if (priorEnv.MINDCRAFT_CODEX_BIN === undefined) delete process.env.MINDCRAFT_CODEX_BIN
    else process.env.MINDCRAFT_CODEX_BIN = priorEnv.MINDCRAFT_CODEX_BIN
    if (priorEnv.MINDCRAFT_CODEX_TIMEOUT_MS === undefined) delete process.env.MINDCRAFT_CODEX_TIMEOUT_MS
    else process.env.MINDCRAFT_CODEX_TIMEOUT_MS = priorEnv.MINDCRAFT_CODEX_TIMEOUT_MS
    if (cleanupFailure) {
      throw new Error(`fixture process cleanup failed; preserving ${sandbox}: ${cleanupFailure.message}`)
    }
    await rm(sandbox, { recursive: true, force: true })
  }

  process.stdout.write(`${JSON.stringify(observed, null, 2)}\n`)
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
