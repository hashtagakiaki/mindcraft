'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-output-policy-test-'))
const captureRoot = path.join(root, 'captures')
mkdirSync(captureRoot)

function write(name, contents) {
  const file = path.join(root, name)
  writeFileSync(file, contents)
  return file
}

const driver = write('driver.cjs', `
const { runFixture } = require(${JSON.stringify(path.join(__dirname, 'run-tests.cjs'))})
try {
  runFixture(process.execPath, process.argv[2], [], process.argv[3])
} catch {
  process.exitCode = 1
}
`)

function runProbe(script, label) {
  const result = spawnSync(process.execPath, [driver, script, label], {
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: captureRoot }
  })
  assert.ifError(result.error)
  assert.deepEqual(readdirSync(captureRoot), [], 'fixture capture directory is removed after each run')
  return result
}

try {
  const successProbe = write('success.cjs', `
const fs = require('node:fs')
fs.writeSync(1, 'usage: expected diagnostic text\\n')
fs.writeSync(2, 'error: expected diagnostic text\\n')
`)
  const success = runProbe(successProbe, 'success-probe')
  assert.equal(success.status, 0)
  assert.equal(success.stdout, '[ok] success-probe\n')
  assert.equal(success.stderr, '')

  const failureProbe = write('failure.cjs', `
const fs = require('node:fs')
fs.writeSync(1, 'stdout-first\\n')
fs.writeSync(2, 'stderr-second\\n')
fs.writeSync(2, 'large-diagnostic:' + 'x'.repeat(70000) + '\\n')
fs.writeSync(1, 'stdout-third\\n')
process.exit(23)
`)
  const failure = runProbe(failureProbe, 'failure-probe')
  assert.equal(failure.status, 1, 'fixture failure fails its invoking runner')
  assert.equal(failure.stdout, '')
  assert.match(failure.stderr, /\[failed\] failure-probe \(exit 23\)/)
  const first = failure.stderr.indexOf('stdout-first\n')
  const second = failure.stderr.indexOf('stderr-second\n')
  const third = failure.stderr.indexOf('stdout-third\n')
  assert.ok(first >= 0 && first < second && second < third, 'combined output preserves stdout/stderr write order')
  assert.ok(failure.stderr.includes(`large-diagnostic:${'x'.repeat(70000)}\n`), 'failure output is not truncated')
  assert.match(failure.stderr, /\[end failed fixture: failure-probe\]/)

  const signalProbe = write('signal.cjs', `
const fs = require('node:fs')
fs.writeSync(1, 'signal-diagnostic\\n')
process.kill(process.pid, 'SIGTERM')
`)
  const signaled = runProbe(signalProbe, 'signal-probe')
  assert.equal(signaled.status, 1)
  assert.match(signaled.stderr, /\[failed\] signal-probe \(signal SIGTERM\)/)
  assert.match(signaled.stderr, /signal-diagnostic\n/)

  console.log('test output policy fixtures passed: quiet success, complete ordered failure logs, exit status, signal status, and cleanup')
} finally {
  rmSync(root, { recursive: true, force: true })
}
