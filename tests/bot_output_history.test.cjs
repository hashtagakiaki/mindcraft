'use strict'

const assert = require('node:assert/strict')
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-output-history-'))
  try {
    const bundles = path.join(root, 'mindcraft-bundles')
    const activeBundleId = `bundle-${'a'.repeat(32)}`
    const previousBundleId = `bundle-${'b'.repeat(32)}`
    const olderBundleId = `bundle-${'c'.repeat(32)}`
    const activeRuntime = path.join(bundles, activeBundleId, 'runtime')
    const oldHistory = path.join(bundles, previousBundleId, 'runtime', 'bots', 'Bot2', 'histories')
    const olderHistory = path.join(bundles, olderBundleId, 'runtime', 'bots', 'Bot2', 'histories')
    const activeHistory = path.join(activeRuntime, 'bots', 'Bot2', 'histories')
    await mkdir(oldHistory, { recursive: true })
    await mkdir(olderHistory, { recursive: true })
    await mkdir(activeHistory, { recursive: true })
    await writeFile(path.join(oldHistory, `codex-${'1'.repeat(32)}.jsonl`), [
      JSON.stringify({ at: '2026-01-01T00:00:00.000Z', taskId: 'old-task', type: 'model_message', text: 'older answer' }),
      JSON.stringify({ at: '2026-01-01T00:00:01.000Z', taskId: 'old-task', type: 'finished', status: 'completed', response: 'older answer' }),
      JSON.stringify({ at: '2026-01-01T00:00:02.000Z', type: 'tool_call', code: 'secret code' }),
    ].join('\n'))
    await writeFile(path.join(olderHistory, `codex-${'3'.repeat(32)}.jsonl`), JSON.stringify({
      at: '2025-12-01T00:00:00.000Z', taskId: 'older-task', type: 'response_reported', response: 'expired version answer',
    }))
    await writeFile(path.join(activeHistory, `codex-${'2'.repeat(32)}.jsonl`), [
      JSON.stringify({ at: '2026-01-02T00:00:00.000Z', taskId: 'new-task', type: 'response_reported', response: 'newer answer' }),
      JSON.stringify({ at: '2026-01-02T00:00:01.000Z', taskId: 'failed-task', type: 'finished', status: 'error', error: 'operation failed' }),
      JSON.stringify({ at: '2026-01-02T00:00:02.000Z', type: 'tool_call', code: 'secret code' }),
    ].join('\n'))
    const diagnosticsRoot = path.join(root, 'diagnostics')
    const { DiagnosticWriter } = await import(pathToFileURL(
      path.resolve(__dirname, '../src/agent/diagnostics_store.js')))
    const diagnostics = new DiagnosticWriter({ root: diagnosticsRoot, pool: 'stream', limitBytes: 1024 * 1024,
      segmentBytes: 4096, identity: { bot: 'Bot2', versionId: 'version-current' }, processRunId: 'history-reader' })
    diagnostics.append('response_reported', { taskId: 'diagnostics-task', reportedAt: '2026-01-03T00:00:00.000Z',
      response: 'diagnostics answer' })
    diagnostics.append('finished', { taskId: 'diagnostics-failed', status: 'error', error: 'diagnostics failure' })
    diagnostics.close()
    await writeFile(path.join(diagnosticsRoot, 'version-state.json'), JSON.stringify({
      schemaVersion: 1, owner: 'mindcraft-tools', currentBundleId: activeBundleId,
      previousBundleId,
    }))

    const { readBotOutputHistory } = await import(pathToFileURL(path.resolve(__dirname, '../src/mindcraft/bot_output_history.js')))
    const entries = readBotOutputHistory(activeRuntime, ['Bot2', '../outside'])
    assert.deepEqual(entries.map(entry => entry.message), [
      'older answer', 'newer answer', 'Codex task failed: operation failed', 'diagnostics answer',
      'Codex task failed: diagnostics failure',
    ])
    assert.equal(readBotOutputHistory(root, ['Bot2']).length, 0, 'rejects a runtime path outside a bundle')
    await writeFile(path.join(diagnosticsRoot, 'manifest.json'), '{broken')
    assert.throws(() => readBotOutputHistory(activeRuntime, ['Bot2']), /Diagnostics root manifest/,
      'a damaged new-format reader fails explicitly instead of falling back to legacy bundles')
    console.log('Bot output history fixtures passed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
