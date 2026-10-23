'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, mkdirSync, writeFileSync, existsSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

function closedSegment(root, name, versionId, size, endedAt = '2026-10-22T00:00:00.000Z') {
  const directory = path.join(root, 'stream', 'segments')
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, `${name}.jsonl`)
  writeFileSync(file, Buffer.alloc(size, 0x78))
  const info = statSync(file)
  writeFileSync(`${file}.manifest.json`, JSON.stringify({ schemaVersion: 1, owner: 'mindcraft', pool: 'stream',
    file: path.basename(file), processRunId: `closed-${name}`, pid: process.pid, processStartTicks: 'unused',
    device: info.dev, inode: info.ino, versionId, openedAt: endedAt, endedAt, closed: true, bytes: size,
    reservedBytes: 0, lastWriteAt: endedAt }) + '\n')
  return file
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-diagnostics-'))
  try {
    const { DiagnosticWriter, DiagnosticQuotaError, diagnosticPoolUsage, diagnosticsFreeSpace,
      checkDiagnosticsSpace } = await import(pathToFileURL(
      path.resolve(__dirname, '../src/agent/diagnostics_store.js')))
    assert.ok(diagnosticsFreeSpace(root) > 0)
    assert.deepEqual(checkDiagnosticsSpace(root, { warningBytes: Number.MAX_SAFE_INTEGER,
      rejectBytes: Number.MAX_SAFE_INTEGER }), { freeBytes: diagnosticsFreeSpace(root), warning: true, rejected: true })
    assert.throws(() => checkDiagnosticsSpace(root, { warningBytes: 10, rejectBytes: 20 }), /reject <= warning/)
    let now = Date.parse('2026-10-23T00:00:00.000Z')
    const writer = new DiagnosticWriter({ root, pool: 'stream', limitBytes: 20_000, segmentBytes: 512,
      segmentMs: 3_600_000, clock: () => now, processRunId: 'fixture-run',
      identity: { bot: 'Bot2', taskId: 'ignored', sourceSha: 'source-sha', versionId: 'version-a',
        token: 'synthetic-secret', worldId: 'world-a' } })
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')).pools.stream,
      { limitBytes: 20_000, ownerLimitBytes: 20_000, runLimitBytes: 20_000, retentionDays: null })
    const event = writer.append('operation_start', { taskId: 'task-1', actionId: 'action-1', callId: 'call-1',
      prompt: 'Bearer synthetic-secret jwt eyJabcdefghijk.abcdefghijk.abcdefghijk',
      args: { password: 'synthetic-secret', target: { x: 2, y: 64, z: -1 }, image: 'data:image/jpeg;base64,fixture' } }, { critical: true })
    assert.equal(event.taskId, 'task-1')
    assert.equal(event.detail.args.password, '[redacted]')
    assert.equal(event.detail.prompt, 'Bearer [redacted] jwt [redacted-jwt]')
    assert.equal(event.detail.args.image, '[image omitted]')
    assert.equal(event.token, undefined)
    assert.equal(event.type, 'operation_start')

    now += 1
    writer.append('operation_result', { taskId: 'task-1', actionId: 'action-1', result: false })
    writer.append('agent_console_chunk', { stream: 'stderr', bot: 'Bot2', text: 'debug token: synthetic-secret\n' })
    const usage = diagnosticPoolUsage(root).stream
    assert.equal(usage.segments, 3)
    assert.equal(usage.openSegments, 1)
    assert.ok(usage.reservedBytes > 0)

    now += 1
    writer.append('next_version', { taskId: 'task-2' }, { critical: true })
    writer.close()
    const files = readdirSync(path.join(root, 'stream/segments')).filter(name => name.endsWith('.jsonl'))
    assert.equal(files.length, 4)
    for (const file of files) {
      const full = path.join(root, 'stream/segments', file)
      const meta = JSON.parse(readFileSync(`${full}.manifest.json`, 'utf8'))
      assert.equal(meta.closed, true)
      assert.equal(meta.reservedBytes, 0)
      assert.equal(meta.sourceSha, 'source-sha')
      assert.equal(statSync(full).mode & 0o777, 0o600)
    }
    const all = files.flatMap(file => readFileSync(path.join(root, 'stream/segments', file), 'utf8').trim().split('\n').map(JSON.parse))
      .sort((left, right) => left.sequence - right.sequence)
    assert.deepEqual(all.map(entry => entry.sequence), [1, 2, 3, 4])
    assert.ok(!JSON.stringify(all).includes('synthetic-secret'))

    const tinyRoot = path.join(root, 'quota')
    const full = new DiagnosticWriter({ root: tinyRoot, pool: 'stream', limitBytes: 96, segmentBytes: 96,
      clock: () => now, processRunId: 'quota-run' })
    assert.throws(() => full.append('critical', { text: 'too large to fit reservation' }), DiagnosticQuotaError)
    assert.equal(diagnosticPoolUsage(tinyRoot).stream.segments, 0, 'quota rejection does not create an unreserved segment')
    full.close()

    const manualRoot = path.join(root, 'manual-quota')
    mkdirSync(manualRoot, { recursive: true })
    writeFileSync(path.join(manualRoot, 'manifest.json'), JSON.stringify({ schemaVersion: 1, owner: 'mindcraft' }))
    writeFileSync(path.join(manualRoot, 'version-state.json'), JSON.stringify({ schemaVersion: 1,
      owner: 'mindcraft-tools', currentVersionId: 'current', previousVersionId: 'previous' }))
    const oldVersion = closedSegment(manualRoot, 'old-version', 'older', 10)
    const previousVersion = closedSegment(manualRoot, 'previous-version', 'previous', 100)
    const currentVersion = closedSegment(manualRoot, 'current-version', 'current', 100)
    const bounded = new DiagnosticWriter({ root: manualRoot, pool: 'stream', limitBytes: 5300,
      ownerRoot: manualRoot, ownerLimitBytes: 5300, runLimitBytes: 5300, segmentBytes: 128,
      identity: { versionId: 'current' }, clock: () => now })
    bounded.append('quota_pressure', { taskId: 'capacity-task' })
    assert.equal(existsSync(oldVersion), false, 'older versions are reclaimed first')
    assert.equal(existsSync(previousVersion), false, 'previous version is reclaimed before current')
    assert.equal(existsSync(currentVersion), true, 'current version remains when reclaiming previous is sufficient')
    assert.deepEqual(JSON.parse(readFileSync(path.join(manualRoot, 'manifest.json'), 'utf8')).lastQuotaCleanup.reasons,
      { older_version: 1, previous_capacity: 1 })
    bounded.close()

    const evalRoot = path.join(root, 'eval-quota')
    mkdirSync(evalRoot, { recursive: true })
    writeFileSync(path.join(evalRoot, 'manifest.json'), JSON.stringify({ schemaVersion: 1, owner: 'mindcraft' }))
    const expired = closedSegment(evalRoot, 'expired', null, 500, '2026-10-01T00:00:00.000Z')
    const recent = closedSegment(evalRoot, 'recent', null, 500, '2026-10-22T00:00:00.000Z')
    const retained = new DiagnosticWriter({ root: evalRoot, pool: 'stream', limitBytes: 5500,
      ownerRoot: evalRoot, ownerLimitBytes: 5500, runLimitBytes: 5500, segmentBytes: 128,
      retentionDays: 14, clock: () => Date.parse('2026-10-23T00:00:00.000Z') })
    retained.append('quota_pressure', { taskId: 'retention-task' })
    assert.equal(existsSync(expired), false, 'expired closed segments are reclaimed first')
    assert.equal(existsSync(recent), true, 'recent closed segments are retained when expiry is sufficient')
    retained.close()

    const ownerRoot = path.join(root, 'shared-owner-quota')
    const sharedOptions = { pool: 'stream', limitBytes: 8000, ownerRoot, ownerLimitBytes: 8000,
      runLimitBytes: 8000, segmentBytes: 128, segmentMs: 3_600_000, clock: () => now }
    const runA = new DiagnosticWriter({ ...sharedOptions, root: path.join(ownerRoot, 'case-a/run-a/diagnostics'), processRunId: 'run-a' })
    runA.append('accepted', { taskId: 'task-a' })
    const runB = new DiagnosticWriter({ ...sharedOptions, root: path.join(ownerRoot, 'case-b/run-b/diagnostics'), processRunId: 'run-b' })
    assert.throws(() => runB.append('rejected', { taskId: 'task-b' }), DiagnosticQuotaError,
      'independent runs share one owner reservation quota')
    runA.close()
    runB.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
  console.log('diagnostics store fixtures passed: bounded reservations, shared owner quotas, rotation and redaction')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
