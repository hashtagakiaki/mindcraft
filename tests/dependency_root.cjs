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

module.exports = { moduleRoot }
