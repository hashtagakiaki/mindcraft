'use strict'

const assert = require('node:assert/strict')
const { cp, mkdtemp, readFile, rm, symlink, writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { moduleRoot } = require('./dependency_root.cjs')
const { pathToFileURL } = require('node:url')

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'idle-scheduling-'))
  try {
    const agentSource = await readFile(path.join(__dirname, '../src/agent/agent.js'), 'utf8')
    const npc = await readFile(path.join(__dirname, '../src/agent/npc/controller.js'), 'utf8')
    const actions = await readFile(path.join(__dirname, '../src/agent/action_manager.js'), 'utf8')
    assert.match(agentSource, /if \(this\._idleResumeTimer\) return;/, 'idle resume timer is coalesced')
    assert.match(agentSource, /this\._idleResumeTimer = null;\s*if \(!this\._shutdownStarted && !this\.managementPaused && !this\.actions\.managementIntentRequired && this\.isIdle\(\)\)/, 'resume callback clears its timer before checking shutdown, management, and idle state')
    assert.match(agentSource, /this\.actions\.userStopped\)/, 'user stop blocks self/system response handling')
    assert.match(agentSource, /if \(!isCurrent\(\)\) return false;/, 'stale user generation returns before applying a response')
    assert.match(actions, /if \(this\.userStopped\) return this\._rejectedResult\('user-stop'\)/, 'idle/resume work cannot reopen the user stop gate')
    assert.match(npc, /if \(this\.idleTimer \|\| this\.idleExecution\) return;/, 'NPC idle starts are coalesced while waiting or running')
    assert.match(npc, /this\.idleExecution = \(async \(\) => \{/)
    assert.match(npc, /finally \{ this\.idleExecution = null; \}/, 'NPC execution remains tracked through completion')

    // Import the actual Agent.handleMessage implementation in a disposable
    // source copy with the existing read-only dependency tree.
    await cp(path.join(__dirname, '../src'), path.join(root, 'src'), { recursive: true })
    await cp(path.join(__dirname, '../package.json'), path.join(root, 'package.json'))
    await writeFile(path.join(root, 'settings.js'), 'export default {}; export function setSettings() {}\n')
    await symlink(moduleRoot(), path.join(root, 'node_modules'))
    const savedHandleLog = console.log
    const savedWarn = console.warn
    console.log = () => {}
    console.warn = () => {}
    let Agent
    try {
      ({ Agent } = await import(pathToFileURL(path.join(root, 'src/agent/agent.js'))))
    } finally {
      console.log = savedHandleLog
      console.warn = savedWarn
    }
    const { default: settings } = await import(pathToFileURL(path.join(root, 'src/agent/settings.js')))
    settings.language = 'en'
    settings.max_commands = 1
    settings.show_command_syntax = 'none'

    const agent = Object.create(Agent.prototype)
    const promptGate = deferred()
    const responseRouted = []
    const executedActions = []
    let promptCalls = 0
    let generationAtPrompt = null
    agent.name = 'FixtureBot'
    agent._userIntentGeneration = 0
    agent._messageGeneration = 0
    agent.shut_up = false
    agent.checkTaskDone = async () => false
    agent.actions = {
      userStopped: false,
      executing: false,
      beginUserIntent() { this.userStopped = false },
      async stop(reason = 'user') { this.userStopped = true; this.stopReason = reason; return { stopped: true, reason } },
      cancelResume() {},
      runAction: async (...args) => { executedActions.push(args); return { success: true } }
    }
    agent.self_prompter = {
      isActive: () => false,
      shouldInterrupt: () => false,
      handleUserPromptedCmd() {}
    }
    agent.bot = { output: '', interrupt_code: false, emit() {}, modes: { flushBehaviorLog: () => '' } }
    agent.clearBotLogs = Agent.prototype.clearBotLogs
    agent.history = {
      async add() { return true },
      save() {},
      getHistory: () => []
    }
    agent.prompter = {
      promptConvo() {
        promptCalls++
        generationAtPrompt = agent._messageGeneration
        return promptGate.promise
      }
    }
    agent.routeResponse = (...args) => responseRouted.push(args)
    agent.openChat = () => {}

    const savedLog = console.log
    console.log = () => {}
    try {
      const staleResponse = agent.handleMessage('FixturePlayer', 'please act', 1)
      while (promptCalls === 0) await new Promise(resolve => setImmediate(resolve))
      const oldGeneration = generationAtPrompt
      const stopResponse = await agent.handleMessage('FixturePlayer', '!stop', 1)
      assert.equal(agent.actions.userStopped, true, '!stop sets the action gate')
      assert.equal(agent.actions.stopReason, 'user')
      assert.ok(agent._messageGeneration > oldGeneration, '!stop invalidates the pending response without opening a user-intent gate')
      const suppressedSystem = await agent.handleMessage('system', 'resume old goal', 1)
      assert.equal(suppressedSystem, false, 'system-driven goal cannot restart after user stop')
      promptGate.resolve('!newAction("stale response")')
      const staleResult = await staleResponse
      assert.equal(staleResult, false, 'late LLM response from before !stop is discarded')
      assert.equal(promptCalls, 1)
      assert.equal(executedActions.length, 0, 'stale generated command never reaches executeCommand')
      assert.equal(stopResponse, true)
      assert.ok(responseRouted.some(args => String(args[1]).includes('stop')))
    } finally {
      console.log = savedLog
    }
    console.log('idle scheduling tests passed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
