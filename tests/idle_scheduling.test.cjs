'use strict'

const assert = require('node:assert/strict')
const { readFile } = require('node:fs/promises')
const path = require('node:path')

async function main() {
  const agent = await readFile(path.join(__dirname, '../src/agent/agent.js'), 'utf8')
  const npc = await readFile(path.join(__dirname, '../src/agent/npc/controller.js'), 'utf8')
  assert.match(agent, /if \(this\._idleResumeTimer\) return;/, 'idle resume timer is coalesced')
  assert.match(agent, /this\._idleResumeTimer = null;\s*if \(this\.isIdle\(\)\)/, 'resume callback clears its timer before checking state')
  assert.match(npc, /if \(this\.idleTimer \|\| this\.idleExecution\) return;/, 'NPC idle starts are coalesced while waiting or running')
  assert.match(npc, /this\.idleExecution = \(async \(\) => \{/)
  assert.match(npc, /finally \{ this\.idleExecution = null; \}/, 'NPC execution remains tracked through completion')
  console.log('idle scheduling tests passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
