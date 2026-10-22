'use strict'

const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')

async function main() {
  const { WorkerTaskRegistry } = await import(pathToFileURL(require('node:path').resolve(__dirname, '../src/mindcraft/worker_task_registry.js')).href)
  const registry = new WorkerTaskRegistry('hub-1')
  const first = registry.begin({ bot: 'Bot1', requestId: 'r1', message: 'same', connectionGeneration: 2 })
  assert.equal(first.accepted, true)
  const same = registry.begin({ bot: 'Bot1', requestId: 'r1', message: 'same', connectionGeneration: 2 })
  assert.equal(same.duplicate, true)
  assert.equal(same.record, first.record)
  assert.equal(registry.begin({ bot: 'Bot2', requestId: 'r1', message: 'same', connectionGeneration: 4 }).accepted, false)
  assert.equal(registry.begin({ bot: 'Bot1', requestId: 'r1', message: 'different', connectionGeneration: 2 }).accepted, false)

  const record = first.record
  const handle = { ...record.handle }
  registry.accept(record)
  const event = (type, extra = {}) => registry.recordAgentEvent(record, {
    handle, handleId: handle.id, bot: handle.bot, taskId: handle.taskId,
    hubGeneration: handle.hubGeneration, connectionGeneration: handle.connectionGeneration,
    type, ...extra,
  }, { bot: handle.bot, connectionGeneration: handle.connectionGeneration, hubGeneration: 'hub-1' })

  const before = registry.snapshot(record).cursor
  const wait = registry.wait([{ ...handle, cursor: before }], 1000)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(event('report', { message: 'done', phase: 'final_answer' }).accepted, true)
  assert.equal(event('terminal', { outcome: { status: 'completed', operationSettlement: 'settled' } }).accepted, true)
  const received = await wait
  assert.equal(received.timedOut, false)
  assert.equal(received.tasks[0].report.message, 'done')
  assert.equal(received.tasks[0].outcome.status, 'completed')

  const late = registry.wait([{ ...handle, cursor: before }], 0)
  assert.equal((await late).tasks[0].events.length, 2, 'wait returns events completed before subscription')
  const forged = { ...handle, taskId: 'newer-task' }
  assert.equal(registry.find({ handle: forged }), null, 'old handles cannot select a newer task')

  const second = registry.begin({ bot: 'Bot1', requestId: 'r2', message: 'pending', connectionGeneration: 2 }).record
  registry.markDisconnected('Bot1', 2)
  assert.equal(registry.snapshot(second).status, 'unknown')
  assert.equal(registry.snapshot(second).terminal, true)

  const timed = registry.begin({ bot: 'Bot2', requestId: 'r3', message: 'still running', connectionGeneration: 9 }).record
  registry.accept(timed)
  const cursorBeforeProgress = timed.sequence
  const progress = eventFor(timed, 'progress', { kind: 'operation-result', operation: 1, success: true })
  assert.equal(registry.recordAgentEvent(timed, progress.payload, progress.scope).accepted, true)
  const beforeWait = Date.now()
  const timeout = await registry.wait([{ ...timed.handle, cursor: cursorBeforeProgress }], 20)
  assert.equal(timeout.timedOut, true)
  assert.ok(Date.now() - beforeWait >= 15, 'progress is retained without waking the supervisor early')
  assert.equal(timeout.tasks[0].progress.kind, 'operation-result')
  assert.equal(timeout.tasks[0].events[0].type, 'progress')
  assert.equal(timed.status, 'running', 'wait timeout does not cancel or mutate the task')

  const uncertain = registry.begin({ bot: 'Bot2', requestId: 'r4', message: 'ack may have been lost', connectionGeneration: 9 }).record
  registry.acceptanceUnknown(uncertain)
  assert.equal(registry.snapshot(registry.find({ bot: 'Bot2', requestId: 'r4' })).status, 'unknown',
    'request ID recovers an uncertain acknowledgement without replaying task start')
  assert.equal(registry.begin({ bot: 'Bot2', requestId: 'r4', message: 'ack may have been lost', connectionGeneration: 9 }).duplicate, true)
  const pendingSettlement = registry.begin({ bot: 'Bot2', requestId: 'r5', message: 'cleanup pending', connectionGeneration: 9 }).record
  registry.accept(pendingSettlement)
  const pendingTerminal = eventFor(pendingSettlement, 'terminal', { status: 'unknown', operationSettlement: 'pending' })
  assert.equal(registry.recordAgentEvent(pendingSettlement, pendingTerminal.payload, pendingTerminal.scope).accepted, true)
  assert.equal(pendingSettlement.terminal, false, 'unsettled operation remains busy instead of becoming idle')
  process.stdout.write('worker_task_registry.test.cjs: all assertions passed\n')
}

function eventFor(record, type, outcome) {
  const handle = record.handle
  return { payload: { handle, handleId: handle.id, bot: handle.bot, taskId: handle.taskId,
    hubGeneration: handle.hubGeneration, connectionGeneration: handle.connectionGeneration,
    type, ...(type === 'progress' ? { progress: outcome } : { outcome }) },
  scope: { bot: handle.bot, connectionGeneration: handle.connectionGeneration, hubGeneration: handle.hubGeneration } }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
