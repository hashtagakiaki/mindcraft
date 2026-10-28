'use strict'

const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')

async function operation(body) {
  const modulePath = pathToFileURL(require('node:path').resolve(__dirname, '../src/agent/library/operation_context.js'))
  const context = await import(modulePath)
  const controller = new AbortController()
  const value = {
    actionId: 'action-1', taskId: 'task-1', intentEpoch: 2, dimension: 'overworld', connectionGeneration: 3,
    signal: controller.signal, bot: { interrupt_code: false }, accepting: true, closed: false, sequence: 0,
    calls: [], facts: [], uncertain: [], diagnostics: [], pending: new Set(),
    root: { id: null, activeChild: null, closed: false, phase: 'main' },
  }
  value.requestStop = () => controller.abort('body-error')
  return { ...await body(context, value), value }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  {
    const { createOperationContext, runOwnedOperation, trackSkill } = await import(pathToFileURL(
      require('node:path').resolve(__dirname, '../src/agent/library/operation_context.js')))
    const events = []
    const agent = { currentTaskId: 'task-link', bot: { getActionCancellationContext: () => ({ connectionGeneration: 4 }) },
      codexRuntime: { active: true, _taskScope: { record: (type, detail) => events.push({ type, ...detail }) } } }
    const controller = new AbortController()
    const action = { id: 17, controller }
    const owner = createOperationContext(action, agent, { intentEpoch: 3 }, 'task-link')
    await runOwnedOperation(owner, async () => {
      const query = trackSkill('world.getPosition', async () => ({ x: 1, y: 64, z: 2 }))
      const mutate = trackSkill('skills.breakBlockAt', async () => true)
      assert.deepEqual(await query(), { x: 1, y: 64, z: 2 })
      assert.equal(await mutate(owner.bot, { position: { x: 2, y: 64, z: 2 } }), true)
    })
    const started = events.filter(event => event.type === 'sdk_call_started')
    const settled = events.filter(event => event.type === 'sdk_call_result')
    assert.deepEqual(started.map(event => event.method), ['world.getPosition', 'skills.breakBlockAt'])
    assert.deepEqual(started[1].args, ['[bot]', { position: { x: 2, y: 64, z: 2 } }], 'the bot argument is not serialized')
    assert.ok(started.every(event => event.taskId === 'task-link' && event.actionId === 17 && event.callId))
    assert.ok(settled.every(event => event.callId && event.actionId === 17))
    assert.equal(settled.at(-1).status, 'returned_true')
  }

  await operation(async ({ operationFactsSummary }) => {
    const summary = operationFactsSummary({ confirmedChanges: [{ quantity: 3, unit: 'item', target: { itemId: 12 },
      phase: 'collect', observedAt: '2026-10-05T00:00:00.000Z', evidence: 'fenced inventory delta' }],
      unconfirmedChanges: [{ confirmedQuantity: null, unit: 'block', target: 'oak_log', phase: 'collect',
        observedAt: '2026-10-05T00:00:01.000Z', reason: 'drop collection unknown' }] });
    assert.match(summary, /3 item; itemId=12; phase=collect/)
    assert.match(summary, /fenced inventory delta/)
    assert.match(summary, /unconfirmed amount unknown; oak_log/)
    assert.doesNotMatch(summary, /unconfirmed 0 block/)
  })

  await operation(async ({ trackSkill, runOwnedOperation, operationResult }, owner) => {
    const result = await runOwnedOperation(owner, () => trackSkill('false-skill', async () => false)())
    assert.equal(result, false)
    assert.equal(operationResult(owner).operationSettlement, 'settled')
    assert.equal(operationResult(owner).skillResults[0].status, 'returned_false')
  })

  await operation(async ({ trackSkill, runOwnedOperation, operationResult }, owner) => {
    const error = Object.assign(new Error('NoPath'), { navigation: {
      code: 'route_not_found', phase: 'search', lastPathUpdate: { status: 'noPath', pathNodeCount: 0 },
      position: { x: 1.5, y: 64, z: 0.5 }, observedAt: '2026-10-23T00:00:00.000Z',
    } })
    await assert.rejects(() => runOwnedOperation(owner, () => trackSkill('goToGoal', async () => { throw error })()), /NoPath/)
    const skill = operationResult(owner).skillResults[0]
    assert.equal(skill.status, 'error')
    assert.equal(skill.error, 'Error: NoPath')
    assert.equal(skill.result.code, 'route_not_found')
    assert.equal(skill.result.diagnostics.phase, 'search', 'navigation failure diagnostics survive the thrown SDK error')
  })

  await operation(async ({ trackSkill, runOwnedOperation, operationResult }, owner) => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    let settled = false
    const task = runOwnedOperation(owner, async () => {
      trackSkill('unawaited', async () => { await gate; owner.bot.output = 'late child finished' })()
      return 'body returned'
    }).then(value => { settled = true; return value })
    await Promise.resolve()
    assert.equal(settled, false, 'operation retains an unawaited public SDK child')
    release()
    assert.equal(await task, 'body returned')
    assert.equal(owner.bot.output, 'late child finished')
    assert.equal(operationResult(owner).operationSettlement, 'settled')
  })

  await operation(async ({ trackSkill, runOwnedOperation, operationResult }, owner) => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const child = trackSkill('nested-child', async () => { await gate; return true })
    const parent = trackSkill('nested-parent', async () => { child(); return false })
    let settled = false
    const running = runOwnedOperation(owner, () => parent()).finally(() => { settled = true })
    await delay(0)
    assert.equal(settled, false, 'nested owned child keeps its parent and operation open')
    release()
    await running
    const results = operationResult(owner).skillResults
    assert.equal(results[0].status, 'returned_false')
    assert.equal(results[1].status, 'returned_true')
    assert.equal(results[1].parentCallId, results[0].id)
  })

  await operation(async ({ trackSkill, runOwnedOperation, operationResult }, owner) => {
    const delayed = trackSkill('late-root', async () => 'must not run')
    await runOwnedOperation(owner, async () => {
      setTimeout(() => { void delayed().catch(() => {}) }, 0)
    })
    await delay(5)
    const result = operationResult(owner)
    assert.equal(result.skillResults.length, 0, 'late root calls do not mutate the settled call list')
    assert.equal(result.lateDiagnostics[0].kind, 'late_sdk_call')
  })

  await operation(async ({ trackSkill, runOwnedOperation, operationResult }, owner) => {
    const result = await runOwnedOperation(owner, async () => {
      const first = trackSkill('first', async () => true)
      const second = trackSkill('parallel', async () => true)
      const firstPromise = first()
      await assert.rejects(second(), /Parallel SDK calls/)
      return await firstPromise
    })
    assert.equal(result, true)
    assert.equal(operationResult(owner).skillResults[1].status, 'rejected')
  })

  await operation(async ({ trackSkill, runOwnedOperation, operationResult }, owner) => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const failure = new Error('parent failed')
    let settled = false
    const running = runOwnedOperation(owner, async () => {
      trackSkill('owned-child', async () => { await gate })()
      throw failure
    }).finally(() => { settled = true })
    await delay(0)
    assert.equal(owner.signal.aborted, true, 'body failure requests stop for owned work')
    assert.equal(settled, false, 'failure waits for owned child settlement')
    release()
    await assert.rejects(running, /parent failed/)
    assert.equal(operationResult(owner).operationSettlement, 'settled')
  })

  console.log('operation context fixtures passed: domain false, parallel rejection, unawaited drain, late-call diagnostics, and failure cleanup')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
