'use strict'

const assert = require('node:assert/strict')
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('condition did not become true')
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'action-manager-'))
  try {
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}')
    await writeFile(path.join(root, 'action_manager.js'), await readFile(path.join(__dirname, '../src/agent/action_manager.js')))
    const { ActionManager } = await import(pathToFileURL(path.join(root, 'action_manager.js')))
    let active = 0
    let maximum = 0
    let cleanKills = 0
    let selfPrompterStops = 0
    const interruptGate = deferred()
    const agent = {
      bot: { output: '', interrupt_code: false, emit() {} },
      self_prompter: { isActive: () => false, stop() { selfPrompterStops++; this.active = false } },
      isIdle: () => true,
      clearBotLogs() { this.bot.output = ''; this.bot.interrupt_code = false },
      requestInterrupt() { this.bot.interrupt_code = true; interruptGate.resolve() },
      history: { add() {} },
      cleanKill() { cleanKills++ }
    }
    const manager = new ActionManager(agent)

    const bodyTail = deferred()
    const writes = []
    const first = manager.runAction('first', async () => {
      active++; maximum = Math.max(maximum, active)
      await interruptGate.promise
      await bodyTail.promise
      writes.push('old-body-finished')
      active--
    }, { timeout: 0 })
    await until(() => manager.executing)
    const firstContext = manager.getCancellationContext()
    assert.equal(firstContext.actionId, manager.actionId)
    assert.equal(manager.setPhase('waiting-fixture', firstContext.actionId), true)
    assert.equal(firstContext.phase, 'waiting-fixture', 'captured context reads the current action phase')
    const second = manager.runAction('second', async () => {
      active++; maximum = Math.max(maximum, active); active--
      writes.push('new-body')
    }, { timeout: 0 })
    await until(() => firstContext.signal.aborted)
    assert.equal(firstContext.signal.reason, 'superseded')
    assert.equal(manager.setPhase('late-write', firstContext.actionId), true, 'phase stays scoped to the old action while it owns the body')
    assert.deepEqual(writes, [], 'new body waits for the actual old-body settlement')
    bodyTail.resolve()
    const [firstResult, secondResult] = await Promise.all([first, second])
    assert.equal(maximum, 1, 'same-tick calls never overlap action bodies')
    assert.equal(firstResult.reason, 'superseded')
    assert.equal(firstResult.interrupted, true)
    assert.equal(secondResult.success, true)
    assert.deepEqual(writes, ['old-body-finished', 'new-body'])
    assert.equal(manager.setPhase('stale', firstContext.actionId), false, 'finished action context cannot mutate a successor')

    // User stop is coalesced, aborts the exposed action signal and stays latched
    // until an explicit human intent reopens the gate.
    const userBodyTail = deferred()
    const userInterrupt = deferred()
    agent.requestInterrupt = () => { agent.bot.interrupt_code = true; userInterrupt.resolve() }
    const userAction = manager.runAction('user-stop-target', async () => {
      await userInterrupt.promise
      await userBodyTail.promise
      writes.push('user-body-finished')
    }, { timeout: 0 })
    await until(() => manager.executing)
    const userContext = manager.getCancellationContext()
    const userStop = manager.stop('user')
    const coalescedStop = manager.stop('user')
    assert.equal(userStop, coalescedStop, 'concurrent stops share the same stop promise')
    await until(() => userContext.signal.aborted)
    assert.equal(manager.userStopped, true)
    assert.equal(selfPrompterStops >= 1, true, 'user stop synchronously suppresses self prompting')
    const blockedCalls = []
    assert.equal((await manager.resumeAction()).reason, 'user-stop')
    assert.equal((await manager.runAction('must-not-start', async () => blockedCalls.push('ran'), { timeout: 0 })).reason, 'user-stop')
    assert.deepEqual(blockedCalls, [])
    let stopSettled = false
    userStop.then(() => { stopSettled = true })
    await Promise.resolve()
    assert.equal(stopSettled, false, 'stop does not race away a still-running action body')
    userBodyTail.resolve()
    const userResult = await userAction
    const stopResult = await userStop
    assert.equal(userResult.reason, 'user')
    assert.equal(stopResult.stopped, true)
    assert.equal(stopResult.actionId, userContext.actionId)

    manager.beginUserIntent()
    assert.equal((await manager.runAction('new-user-instruction', async () => {}, { timeout: 0 })).success, true)

    // A queued replacement that predates !stop is discarded even if the
    // superseded body subsequently settles.
    const queuedBodyTail = deferred()
    const queuedInterrupt = deferred()
    agent.requestInterrupt = () => { agent.bot.interrupt_code = true; queuedInterrupt.resolve() }
    const queuedOld = manager.runAction('queued-old', async () => {
      await queuedInterrupt.promise
      await queuedBodyTail.promise
    }, { timeout: 0 })
    await until(() => manager.executing)
    const queuedNewCalls = []
    const queuedNew = manager.runAction('queued-new', async () => queuedNewCalls.push('ran'), { timeout: 0 })
    await until(() => manager.currentAction?.stopPromise)
    const queuedUserStop = manager.stop('user')
    queuedBodyTail.resolve()
    await Promise.all([queuedOld, queuedNew, queuedUserStop])
    assert.deepEqual(queuedNewCalls, [], 'stop invalidates an already queued action')

    // Fire one real ActionManager timeout callback with virtual timers. The
    // unresolved body remains active and reaches the existing last-resort
    // cleanKill only after the bounded stop watchdog expires.
    manager.beginUserIntent()
    manager.recent_action_counter = 0
    manager.last_action_time = 0
    const timeoutGate = deferred()
    const timeoutInterrupt = deferred()
    agent.requestInterrupt = () => { agent.bot.interrupt_code = true; timeoutInterrupt.resolve() }
    const timed = manager.runAction('timed-unresponsive', async () => {
      await timeoutInterrupt.promise
      await timeoutGate.promise
    }, { timeout: 0 })
    await until(() => manager.executing)
    const timedId = manager.actionId
    const savedSetTimeout = global.setTimeout
    const savedClearTimeout = global.clearTimeout
    const timers = []
    let timeoutHandle
    let watchdog
    global.setTimeout = (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer }
    global.clearTimeout = () => {}
    try {
      timeoutHandle = manager._startTimeout(1, timedId)
      const timeoutPromise = timeoutHandle.callback()
      await Promise.resolve()
      await Promise.resolve()
      watchdog = timers.find(timer => timer.delay === 10000)
      assert.ok(watchdog, 'unresponsive action uses the existing ten-second bound')
      watchdog.callback()
      await timeoutPromise
      assert.equal(cleanKills, 1)
      assert.equal(manager.executing, true, 'a mock cleanKill does not pretend the old body exited')
      timeoutGate.resolve()
      global.setTimeout = savedSetTimeout
      global.clearTimeout = savedClearTimeout
      const timedResult = await timed
      assert.equal(timedResult.reason, 'timeout')
    } finally {
      global.setTimeout = savedSetTimeout
      global.clearTimeout = savedClearTimeout
    }
    assert.equal(manager.setPhase('late-timeout', timedId), false)
    assert.equal(cleanKills, 1, 'old timeout does not escalate a successor')

    manager.recent_action_counter = 0
    manager.last_action_time = 0
    const successorGate = deferred()
    const successorInterrupt = deferred()
    agent.requestInterrupt = () => { agent.bot.interrupt_code = true; successorInterrupt.resolve() }
    const successor = manager.runAction('successor-after-timeout', async () => {
      await successorGate.promise
    }, { timeout: 0 })
    await until(() => manager.executing)
    await timeoutHandle.callback()
    watchdog.callback()
    assert.equal(cleanKills, 1, 'stale watchdog cannot cleanKill a successor')
    assert.equal(manager.timedout, false, 'stale timeout callback cannot mark a successor timed out')
    successorGate.resolve()
    assert.equal((await successor).success, true)

    manager.recent_action_counter = 0
    manager.last_action_time = 0
    const cooperativeInterrupt = deferred()
    agent.requestInterrupt = () => { agent.bot.interrupt_code = true; cooperativeInterrupt.resolve() }
    const cooperative = manager.runAction('cooperative-timeout', async () => {
      await cooperativeInterrupt.promise
    }, { timeout: 0 })
    await until(() => manager.executing)
    manager.timedout = true
    const cooperativeStop = manager.stop('timeout')
    const cooperativeStopResult = await cooperativeStop
    const cooperativeResult = await cooperative
    assert.equal(cooperativeResult.timedout, true)
    assert.equal(cooperativeResult.reason, 'timeout')
    assert.equal(cooperativeStopResult.stopped, true)
    assert.equal(cleanKills, 1, 'cooperative timeout settles without cleanKill')

    manager.beginUserIntent()
    manager.recent_action_counter = 0
    manager.last_action_time = 0
    assert.equal((await manager.runAction('resume workflow', async () => {}, { resume: true, timeout: 0 })).success, true)
    assert.equal((await manager.runAction('store resume', async () => {}, { timeout: 0 })).success, true)
    assert.equal((await manager.runAction('resume', async () => {}, { resume: true, timeout: 0 })).success, true)
    await assert.rejects(manager.resumeAction(null, async () => {}), /actionLabel is required/)
    console.log('action manager tests passed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
