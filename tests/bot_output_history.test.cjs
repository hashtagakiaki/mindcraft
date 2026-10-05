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
    const activeRuntime = path.join(bundles, `bundle-${'a'.repeat(32)}`, 'runtime')
    const oldHistory = path.join(bundles, `bundle-${'b'.repeat(32)}`, 'runtime', 'bots', 'Bot2', 'histories')
    const activeHistory = path.join(activeRuntime, 'bots', 'Bot2', 'histories')
    await mkdir(oldHistory, { recursive: true })
    await mkdir(activeHistory, { recursive: true })
    await writeFile(path.join(oldHistory, `codex-${'1'.repeat(32)}.jsonl`), [
      JSON.stringify({ at: '2026-01-01T00:00:00.000Z', taskId: 'old-task', type: 'model_message', text: 'older answer' }),
      JSON.stringify({ at: '2026-01-01T00:00:01.000Z', taskId: 'old-task', type: 'finished', status: 'completed', response: 'older answer' }),
      JSON.stringify({ at: '2026-01-01T00:00:02.000Z', type: 'tool_call', code: 'secret code' }),
    ].join('\n'))
    await writeFile(path.join(activeHistory, `codex-${'2'.repeat(32)}.jsonl`), [
      JSON.stringify({ at: '2026-01-02T00:00:00.000Z', taskId: 'new-task', type: 'response_reported', response: 'newer answer' }),
      JSON.stringify({ at: '2026-01-02T00:00:01.000Z', taskId: 'failed-task', type: 'finished', status: 'error', error: 'operation failed' }),
      JSON.stringify({ at: '2026-01-02T00:00:02.000Z', type: 'tool_call', code: 'secret code' }),
    ].join('\n'))

    const { readBotOutputHistory } = await import(pathToFileURL(path.resolve(__dirname, '../src/mindcraft/bot_output_history.js')))
    const entries = readBotOutputHistory(activeRuntime, ['Bot2', '../outside'])
    assert.deepEqual(entries.map(entry => entry.message), [
      'older answer', 'newer answer', 'Codex task failed: operation failed',
    ])
    assert.equal(readBotOutputHistory(root, ['Bot2']).length, 0, 'rejects a runtime path outside a bundle')
    console.log('Bot output history fixtures passed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
