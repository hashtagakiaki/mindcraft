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

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'action-manager-'))
  try {
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}')
    await writeFile(path.join(root, 'action_manager.js'), await readFile(path.join(__dirname, '../src/agent/action_manager.js')))
    const { ActionManager } = await import(pathToFileURL(path.join(root, 'action_manager.js')))
    let active = 0
    let maximum = 0
    const firstGate = deferred()
    const agent = {
      bot: { output: '', interrupt_code: false, emit() {} },
      self_prompter: { isActive: () => false },
      isIdle: () => true,
      clearBotLogs() { this.bot.output = '' },
      requestInterrupt() { this.bot.interrupt_code = true; firstGate.resolve() },
      history: { add() {} },
      cleanKill(message) { throw new Error(message) }
    }
    const manager = new ActionManager(agent)
    const first = manager.runAction('first', async () => {
      active++; maximum = Math.max(maximum, active)
      await firstGate.promise
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
    }, { timeout: 0 })
    const second = manager.runAction('second', async () => {
      active++; maximum = Math.max(maximum, active); active--
    }, { timeout: 0 })
    await Promise.all([first, second])
    assert.equal(maximum, 1, 'same-tick calls never overlap action bodies')

    agent.bot.interrupt_code = false
    const savedSetTimeout = global.setTimeout
    const savedClearTimeout = global.clearTimeout
    const queuedTimers = []
    let cleanKills = 0
    agent.cleanKill = () => { cleanKills++ }
    global.setTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false }
      queuedTimers.push(timer)
      return timer
    }
    global.clearTimeout = timer => { if (timer) timer.cleared = true }
    try {
      manager.executing = true
      manager.actionId = 50
      const firstTimeout = manager._startTimeout(1, 50)
      await firstTimeout.callback()
      assert.equal(agent.bot.interrupt_code, true, 'timeout requests interruption')
      const escalation = queuedTimers.at(-1)
      assert.equal(escalation.delay, 10000, 'unresponsive action retains the 10 second kill escalation')
      manager.actionId = 51
      escalation.callback()
      assert.equal(cleanKills, 0, 'old action escalation cannot kill a successor')

      manager.actionId = 52
      const unresponsiveTimeout = manager._startTimeout(1, 52)
      await unresponsiveTimeout.callback()
      queuedTimers.at(-1).callback()
      assert.equal(cleanKills, 1, 'the still-active timed-out action is escalated')
    } finally {
      global.setTimeout = savedSetTimeout
      global.clearTimeout = savedClearTimeout
      manager.executing = false
      manager.timeoutEscalations.clear()
    }

    let timeOutHandle
    manager._startTimeout = (_mins, id) => {
      timeOutHandle = { fire: async () => { if (manager.executing && manager.actionId === id) { manager.timedout = true; agent.requestInterrupt() } } }
      return timeOutHandle
    }
    const timed = manager.runAction('timed', async () => { await new Promise(resolve => setTimeout(resolve, 10)) }, { timeout: 1 })
    await new Promise(resolve => setTimeout(resolve, 0))
    await timeOutHandle.fire()
    const timedResult = await timed
    assert.equal(timedResult.timedout, true)
    agent.bot.interrupt_code = false
    const success = await manager.runAction('success', async () => {}, { timeout: 0 })
    assert.equal(success.timedout, false, 'timeout state does not leak into the next action')
    await timeOutHandle.fire()
    assert.equal(manager.timedout, false, 'stale timeout callback cannot change later action state')

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
