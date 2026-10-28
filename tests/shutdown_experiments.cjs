'use strict'

// Isolated boundary experiment: uses ActionManager, crafting_sync and process
// group sources, but never opens a Minecraft or Codex connection.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const { mkdtemp, mkdir, readFile, rm, symlink, writeFile } = require('node:fs/promises')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')
const { moduleRoot } = require('./dependency_root.cjs')

const root = path.resolve(__dirname, '..')
const sharedNodeModules = moduleRoot()
const depRequire = createRequire(path.join(sharedNodeModules, 'package.json'))
const TARGET_VERSION = '1.21.1'
const minecraftData = depRequire('minecraft-data')(TARGET_VERSION)
const tempDirs = new Set()
const processGroups = new Set()

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
// A losing race deadline must not keep the process alive after the race settles.
const deadline = ms => new Promise(resolve => setTimeout(resolve, ms).unref())
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function experimentActionManager() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mc-shutdown-action-'))
  tempDirs.add(dir)
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}')
  await mkdir(path.join(dir, 'library'), { recursive: true })
  await writeFile(path.join(dir, 'library/operation_context.js'), await readFile(path.join(root, 'src/agent/library/operation_context.js')))
  await writeFile(path.join(dir, 'action_manager.js'), await readFile(path.join(root, 'src/agent/action_manager.js')))
  const { ActionManager } = await import(pathToFileURL(path.join(dir, 'action_manager.js')))
  const savedLog = console.log
  const savedWarn = console.warn
  console.log = () => {}
  console.warn = () => {}
  const gate = deferred()
  const agent = {
    bot: { output: '', interrupt_code: false, emit() {} },
    self_prompter: { isActive: () => false },
    isIdle: () => true,
    clearBotLogs() { this.bot.output = '' },
    requestInterrupt() { this.bot.interrupt_code = true },
    history: { add() {} },
    cleanKill() { throw new Error('unexpected fixture cleanKill') }
  }
  const manager = new ActionManager(agent)
  const action = manager.runAction('unresolved-wait', async () => gate.promise, { timeout: 0 })
  await delay(0)
  agent.requestInterrupt()
  await delay(15)
  assert.equal(manager.executing, true)
  let actionSettled = false
  action.finally(() => { actionSettled = true })
  await Promise.race([action, delay(10).then(() => null)])
  assert.equal(actionSettled, false, 'race timeout must not be treated as actual action settlement')
  gate.resolve()
  await action
  assert.equal(manager.executing, false)

  // Exercise the current action-identity stop watchdog with virtual timer
  // delivery. The old Wave1 timeout-escalation observation is historical.
  manager.beginUserIntent()
  agent.bot.interrupt_code = false
  const unresponsiveGate = deferred()
  agent.requestInterrupt = () => { agent.bot.interrupt_code = true }
  const unresponsive = manager.runAction('unresponsive-action-identity', async () => unresponsiveGate.promise, { timeout: 0 })
  await delay(0)
  const stuckActionId = manager.currentAction?.id
  assert.ok(stuckActionId)
  const cancellationContext = manager.getCancellationContext(stuckActionId)
  assert.equal(cancellationContext.actionId, stuckActionId)
  const savedSetTimeout = global.setTimeout
  const savedClearTimeout = global.clearTimeout
  const timers = []
  let cleanKills = 0
  agent.cleanKill = message => { cleanKills++; agent.killReason = message }
  global.setTimeout = (callback, delayMs) => {
    const timer = { callback, delay: delayMs, cleared: false }
    timers.push(timer)
    return timer
  }
  global.clearTimeout = timer => { if (timer) timer.cleared = true }
  let stopResult
  try {
    const stopPromise = manager.stop('timeout')
    assert.equal(cancellationContext.signal.aborted, true)
    assert.equal(manager.currentAction.id, stuckActionId)
    const watchdog = timers.find(timer => timer.delay === 10000)
    assert.ok(watchdog, 'current stop path arms a bounded last-resort watchdog')
    watchdog.callback()
    stopResult = await stopPromise
    assert.equal(cleanKills, 1)
    assert.equal(stopResult.stopped, false, 'watchdog escalation is not cooperative stop success')
    assert.equal(manager.executing, true, 'fallback request does not prove the action body exited')
    const successor = await manager.runAction('unsafe-successor', async () => { throw new Error('must not execute') }, { timeout: 0 })
    assert.equal(successor.reason, 'stop-failed', 'successor is rejected while the old action remains unsettled')
    assert.equal(manager.currentAction.id, stuckActionId)
  } finally {
    global.setTimeout = savedSetTimeout
    global.clearTimeout = savedClearTimeout
    unresponsiveGate.resolve()
    await unresponsive
    manager.timeoutEscalations.clear()
    console.log = savedLog
    console.warn = savedWarn
  }
  return {
    unresolvedPromise: { interruptFlagSettlesAction: false, actualActionIdRemainsCurrent: true, raceAloneProvesStop: false },
    currentStopWatchdog: { callbackInvokedWithVirtualClock: true, stopReportedSuccess: stopResult?.stopped, cleanKillRequests: cleanKills, bodyStillExecutingAtEscalation: true, successorRejected: true },
    historicalBaseline: { formerTimeoutEscalationExperimentNoLongerDescribesCurrentActionManager: true },
    reentry: { outerActionAwaitingSameManagerInnerActionCanSelfWait: 'prior investigation evidence; not executed by this fixture', attribution: 'not evidence this caused a recorded incident' }
  }
}

async function experimentCraftFence() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mc-shutdown-craft-'))
  tempDirs.add(dir)
  await symlink(sharedNodeModules, path.join(dir, 'node_modules'))
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}')
  const localModule = path.join(dir, 'crafting_sync.js')
  await writeFile(localModule, await readFile(path.join(root, 'src/agent/library/crafting_sync.js')))
  await writeFile(path.join(dir, 'operation_context.js'), await readFile(path.join(root, 'src/agent/library/operation_context.js')))
  const { default: craftingSync } = await import(pathToFileURL(localModule))
  const { run } = craftingSync
  const makeBot = sendSnapshot => {
    const client = new EventEmitter()
    client.write = (name, packet) => {
      if (name === 'window_click' && packet.slot === -999 && sendSnapshot) {
        setImmediate(() => client.emit('packet', {
          windowId: 0, stateId: 10,
          items: Array.from({ length: 46 }, () => ({ present: false })),
          carriedItem: { present: false }
        }, { name: 'window_items' }))
      }
      if (name === 'client_command') {
        setImmediate(() => {
          client.emit('packet', { entries: [] }, { name: 'statistics' })
          client.emit('statistics', { entries: [] })
        })
      }
    }
    const inventory = {
      id: 0,
      type: 'minecraft:inventory',
      slots: Array(46).fill(null),
      selectedItem: null,
      inventoryStart: 9,
      inventoryEnd: 45
    }
    return { _client: client, registry: minecraftData, inventory, currentWindow: null, interrupt_code: false }
  }
  const synced = await run(makeBot(true), async () => 'ok', { timeoutMs: 100 })
  assert.equal(synced, 'ok')
  const savedError = console.error
  console.error = () => {}
  try {
    await assert.rejects(run(makeBot(false), async () => 'unexpected', { timeoutMs: 30 }), /no full inventory snapshot/)
  } finally {
    console.error = savedError
  }
  return {
    fullSnapshotBeforeStatistics: { fenceAccepted: true, callCompleted: true },
    statisticsWithoutSnapshot: { fenceAccepted: false, rejectedAs: 'no full inventory snapshot', callCompletedAsSuccess: false },
    statisticsPayloadIsNotInventory: true
  }
}

async function waitForLine(child, expected, timeoutMs = 3000) {
  let text = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process fixture timed out; output=${text}`)), timeoutMs)
    child.stdout.on('data', chunk => {
      text += chunk
      if (text.includes(expected)) { clearTimeout(timer); resolve(text) }
    })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      if (!text.includes(expected)) { clearTimeout(timer); reject(new Error(`process fixture closed (${code}/${signal}); output=${text}`)) }
    })
  })
}

async function experimentProcessGroup() {
  if (process.platform === 'win32') throw new Error('this fixture requires POSIX process groups')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mc-shutdown-group-'))
  tempDirs.add(dir)
  const childSource = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { detached:false, stdio:'ignore' });
    fs.writeFileSync(process.argv[1], JSON.stringify({ parent:process.pid, grandchild:grandchild.pid, group:process.pid }));
    process.on('SIGTERM',()=>{}); setTimeout(()=>console.log('ready'),100); setInterval(()=>{},1000);
  `
  let child
  let closePromise
  try {
    child = spawn(process.execPath, ['-e', childSource, path.join(dir, 'pids.json')], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    processGroups.add(child.pid)
    closePromise = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
    await waitForLine(child, 'ready')
    const pids = JSON.parse(await readFile(path.join(dir, 'pids.json'), 'utf8'))
    process.kill(-pids.group, 'SIGTERM')
    await delay(30)
    const survivedTerm = [pids.parent, pids.grandchild].every(pid => { try { process.kill(pid, 0); return true } catch { return false } })
    process.kill(-pids.group, 'SIGKILL')
    const close = await Promise.race([closePromise, deadline(3000).then(() => { throw new Error('child group did not close after SIGKILL') })])
    const groupGone = await waitForGroupGone(pids.group)
    assert.equal(survivedTerm, true)
    assert.equal(close.signal, 'SIGKILL')
    assert.equal(groupGone, true)
    return { groupSignalScope: 'detached dedicated Node parent + inherited-group grandchild only', termIgnored: survivedTerm, escalation: 'SIGKILL', parentCloseObserved: true, groupGoneAfterClose: groupGone }
  } finally {
    // The leader may already have exited while a descendant remains. Always
    // recover the dedicated group, and only forget it after confirming gone.
    const group = child && child.pid
    if (group) {
      try { process.kill(-group, 'SIGTERM') } catch {}
      await delay(30)
      try { process.kill(-group, 'SIGKILL') } catch {}
      if (closePromise) await Promise.race([closePromise, deadline(1000)])
      if (await waitForGroupGone(group)) processGroups.delete(group)
    }
  }
}

async function waitForGroupGone(group) {
  for (let i = 0; i < 30; i++) {
    try { process.kill(-group, 0) } catch { return true }
    await delay(25)
  }
  return false
}

async function main() {
  const result = {
    experiment: 'shutdown and inventory boundaries',
    liveMinecraftOrCodexCalls: 0,
    sharedDependencyMutation: false,
    observations: {},
    cleanup: {}
  }
  try {
    result.observations.actionManager = await experimentActionManager()
    result.observations.craftFence = await experimentCraftFence()
    result.observations.processGroup = await experimentProcessGroup()
    result.decision = {
      inventorySync: 'statistics is only a fence marker. Actual crafting_sync.run accepts a matching full window_items snapshot preceding statistics and rejects statistics alone.',
      latePacketPolicy: 'After cancellation, do not issue follow-up clicks. If a click was already sent and acknowledgement/state is ambiguous, retain exclusive ownership and wait for server-confirmed state or mark outcome unknown; do not start another mutating action.',
      cliOwnership: 'Spawn the owned CLI in a dedicated process group, wait for close after SIGTERM, escalate the same group to SIGKILL on deadline, and confirm close before removing its tempdir. Never signal the Codex host/session group.',
      parentChildCoordination: 'Propose adding a Node standard IPC stop-intent/ack channel between parent and bot child; current spawn does not provide IPC. Parent must still own bounded process-group escalation and wait for actual child close. Socket.IO alone is insufficient during management disconnect.'
    }
  } finally {
    for (const group of [...processGroups]) {
      try { process.kill(-group, 'SIGKILL') } catch {}
      if (await waitForGroupGone(group)) processGroups.delete(group)
    }
    result.cleanup.processGroups = [...processGroups]
    result.cleanup.tempDirsBeforeRemoval = [...tempDirs]
    if (processGroups.size === 0) {
      for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })
    }
    result.cleanup.tempDirsAfterRemoval = (await Promise.all([...tempDirs].map(async dir => fs.existsSync(dir)))).filter(Boolean)
    result.cleanup.complete = processGroups.size === 0 && result.cleanup.tempDirsAfterRemoval.length === 0
  }
  assert.equal(result.cleanup.complete, true)
  console.log(JSON.stringify(result, null, 2))
}

main().catch(error => { console.error(error); process.exitCode = 1 })
