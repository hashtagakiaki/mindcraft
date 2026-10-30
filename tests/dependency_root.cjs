'use strict'

const fs = require('node:fs')
const path = require('node:path')

function moduleRoot() {
  const candidates = [
    path.resolve(__dirname, '../node_modules'),
    path.resolve(__dirname, '../../mindcraft-eval/runtime/upstream/node_modules'),
  ]
  const root = candidates.find(candidate => {
    try { return fs.statSync(candidate).isDirectory() } catch { return false }
  })
  if (!root) throw new Error(`Could not find the read-only dependency tree. Checked: ${candidates.join(', ')}`)
  return root
}

// The vendored pathfinder fork resolves its own dependencies (vec3, prismarine-*)
// from a sibling node_modules, so fixtures load it from a disposable copy that
// links the read-only dependency tree.
let forkRequire = null
function pathfinderFork(specifier = '.') {
  if (!forkRequire) {
    const os = require('node:os')
    const { createRequire } = require('node:module')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-pathfinder-fork-'))
    fs.cpSync(path.resolve(__dirname, '../src/vendor'), path.join(root, 'vendor'), { recursive: true })
    fs.symlinkSync(moduleRoot(), path.join(root, 'node_modules'))
    process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }))
    forkRequire = createRequire(path.join(root, 'vendor/mineflayer-pathfinder/package.json'))
  }
  return forkRequire(specifier)
}

module.exports = { moduleRoot, pathfinderFork }
