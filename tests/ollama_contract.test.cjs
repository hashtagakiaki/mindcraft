'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const { pathToFileURL } = require('node:url')
const path = require('node:path')

async function main() {
  const { Ollama } = await import(pathToFileURL(path.resolve(__dirname, '../src/models/ollama.js')).href)
  const originalFetch = globalThis.fetch
  const originalCwd = process.cwd()
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  try {
    let observedBody
    let usageRows = []
    globalThis.fetch = async request => {
      observedBody = JSON.parse(await request.clone().text())
      return Response.json({ message: { content: 'fixture answer' }, prompt_eval_count: 12, eval_count: 4 })
    }
    const model = new Ollama('fixture-model', 'http://127.0.0.1:11434', { temperature: 0, request_timeout_ms: 80 })
    const answer = await model.sendRequest([{ role: 'user', content: 'question' }], 'system', '***', {
      requestId: 'request-fixed-at-start', purpose: 'coding', taskId: 'task-old', actionId: 'action-7',
      onUsage: row => usageRows.push(row),
    })
    assert.equal(answer, 'fixture answer', 'successful Ollama replies keep their existing string API')
    assert.equal(observedBody.temperature, 0)
    assert.equal(observedBody.request_timeout_ms, undefined, 'local timeout config is not sent as a model parameter')
    assert.equal(usageRows.length, 1)
    assert.deepEqual({ ...usageRows[0], elapsedMs: undefined }, { requestId: 'request-fixed-at-start', attempt: 1, provider: 'ollama', purpose: 'coding',
      taskId: 'task-old', actionId: 'action-7', usage: { promptTokens: 12, completionTokens: 4 }, elapsedMs: undefined })
    assert.ok(Number.isFinite(usageRows[0].elapsedMs))

    usageRows = []
    globalThis.fetch = async () => Response.json({ message: { content: 'reply without usage' } })
    assert.equal(await model.sendRequest([], 'system', { purpose: 'vision', onUsage: row => usageRows.push(row) }), 'reply without usage')
    assert.deepEqual(usageRows, [], 'absent usage stays absent rather than becoming zero')

    globalThis.fetch = async request => {
      observedBody = JSON.parse(await request.clone().text())
      return Response.json({ message: { content: 'image response' } })
    }
    const image = Buffer.from('ollama fixture image')
    assert.equal(await model.sendVisionRequest([{ role: 'user', content: 'inspect this' }], 'Describe what is visible.', image), 'image response')
    const imageUserMessage = observedBody.messages.at(-1)
    assert.equal(typeof imageUserMessage.content, 'string', 'Ollama chat vision uses a text content field')
    assert.deepEqual(imageUserMessage.images, [image.toString('base64')], 'image bytes use /api/chat base64 images payload')
    assert.equal(JSON.stringify(observedBody).includes('image_url'), false, 'OpenAI-only image_url fields are not sent to Ollama')

    globalThis.fetch = async () => new Response('offline', { status: 503 })
    await assert.rejects(model.sendRequest([], 'system'), /Ollama Status: 503/, 'provider HTTP errors reject instead of becoming assistant text')
    await assert.rejects(model.sendVisionRequest([], 'vision prompt', Buffer.from('image')),
      /Ollama Status: 503/, 'unsupported or refused vision requests remain explicit provider errors')

    let abortObserved = false
    globalThis.fetch = request => new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => { abortObserved = true; reject(request.signal.reason) }, { once: true })
    })
    const cancellation = new AbortController()
    const pending = model.sendRequest([], 'system', { signal: cancellation.signal })
    await delay(5)
    cancellation.abort('fixture cancellation')
    await assert.rejects(pending, /fixture cancellation/)
    assert.equal(abortObserved, true, 'external cancellation reaches the actual fetch signal')

    let timeoutObserved = false
    globalThis.fetch = request => new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => { timeoutObserved = true; reject(request.signal.reason) }, { once: true })
    })
    const shortTimeout = new Ollama('fixture-model', 'http://127.0.0.1:11434', { request_timeout_ms: 15 })
    await assert.rejects(shortTimeout.sendRequest([], 'system'), error => error.name === 'TimeoutError' && error.code === 'OLLAMA_REQUEST_TIMEOUT')
    assert.equal(timeoutObserved, true, 'profile timeout aborts the actual fetch')

    let resolveLateResponse
    globalThis.fetch = () => new Promise(resolve => { resolveLateResponse = resolve })
    const lateTimeoutModel = new Ollama('fixture-model', 'http://127.0.0.1:11434', { request_timeout_ms: 15 })
    const lateTimeout = lateTimeoutModel.sendRequest([], 'system')
    await delay(25)
    resolveLateResponse(Response.json({ message: { content: 'late answer' } }))
    await assert.rejects(lateTimeout, error => error.name === 'TimeoutError' && error.code === 'OLLAMA_REQUEST_TIMEOUT',
      'a fetch adapter that resolves after abort cannot turn a timed-out result into success')

    const ownerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mindcraft-ollama-owner-'))
    try {
      const dirs = ['src/agent/npc', 'src/agent/commands', 'src/agent/library', 'src/models', 'src/utils']
      for (const dir of dirs) await fs.mkdir(path.join(ownerRoot, dir), { recursive: true })
      await fs.writeFile(path.join(ownerRoot, 'package.json'), '{"type":"module"}')
      await fs.copyFile(path.resolve(__dirname, '../src/agent/history.js'), path.join(ownerRoot, 'src/agent/history.js'))
      await fs.copyFile(path.resolve(__dirname, '../src/agent/task_diagnostics.js'), path.join(ownerRoot, 'src/agent/task_diagnostics.js'))
      await fs.copyFile(path.resolve(__dirname, '../src/models/prompter.js'), path.join(ownerRoot, 'src/models/prompter.js'))
      await fs.copyFile(path.resolve(__dirname, '../src/models/ollama.js'), path.join(ownerRoot, 'src/models/ollama.js'))
      await fs.copyFile(path.resolve(__dirname, '../src/utils/text.js'), path.join(ownerRoot, 'src/utils/text.js'))
      await fs.writeFile(path.join(ownerRoot, 'src/agent/npc/data.js'), 'export class NPCData {}')
      await fs.writeFile(path.join(ownerRoot, 'src/agent/settings.js'), 'export default { max_messages: 1 }')
      await fs.writeFile(path.join(ownerRoot, 'src/agent/commands/index.js'), 'export function getCommandDocs() { return "" }; export function getCommand() { return null }')
      await fs.writeFile(path.join(ownerRoot, 'src/agent/library/skill_library.js'), 'export class SkillLibrary {}')
      await fs.writeFile(path.join(ownerRoot, 'src/utils/examples.js'), 'export class Examples {}')
      await fs.writeFile(path.join(ownerRoot, 'src/models/_model_map.js'), 'export function selectAPI() {}; export function createModel() {}')
      const { Prompter } = await import(pathToFileURL(path.join(ownerRoot, 'src/models/prompter.js')).href)
      const { History } = await import(pathToFileURL(path.join(ownerRoot, 'src/agent/history.js')).href)
      const ownedModel = new Ollama('fixture-model', 'http://127.0.0.1:11434', { request_timeout_ms: 500 })
      const prompter = Object.create(Prompter.prototype)
      Object.assign(prompter, {
        cooldown: 0, last_prompt_time: Date.now(), profile: { saving_memory: 'summarize' }, chat_model: ownedModel,
        replaceStrings: async prompt => prompt, _saveLog: async () => {},
      })
      const ownerController = new AbortController()
      let summaryFetchSignal
      globalThis.fetch = request => new Promise((resolve, reject) => {
        summaryFetchSignal = request.signal
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      })
      const agent = { name: 'summary-owner', prompter, actions: { getCancellationContext: () => ({ actionId: 'summary-action', taskId: 'summary-task', signal: ownerController.signal }) },
        self_prompter: { state: null, isStopped: () => true }, task: {}, last_sender: null }
      prompter.agent = agent
      const previousInfo = console.info
      let scopedUsage
      console.info = (label, detail) => { if (label === 'Model usage') scopedUsage = detail }
      globalThis.fetch = async () => Response.json({ message: { content: 'summary answer' }, prompt_eval_count: 6 })
      try {
        assert.equal(await prompter.promptMemSaving([{ role: 'user', content: 'memory' }]), 'summary answer')
      } finally { console.info = previousInfo }
      assert.equal(scopedUsage.purpose, 'memory-summary')
      assert.equal(scopedUsage.taskId, 'summary-task')
      assert.equal(scopedUsage.actionId, 'summary-action')
      assert.deepEqual(scopedUsage.usage, { promptTokens: 6 }, 'missing completion usage stays absent')
      prompter.profile.conversing = 'conversation prompt'
      prompter.convo_examples = []
      prompter.withBotRules = async prompt => prompt
      let conversationSignal
      let conversationCalls = 0
      globalThis.fetch = request => {
        conversationCalls++
        if (conversationCalls > 1) return Promise.resolve(Response.json({ message: { content: 'new conversation reply' } }))
        return new Promise((resolve, reject) => {
          conversationSignal = request.signal
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
        })
      }
      const oldConversation = prompter.promptConvo([])
      const requestDeadline = Date.now() + 1000
      while (!conversationSignal && Date.now() < requestDeadline) await delay(5)
      assert.ok(conversationSignal, 'conversation request reaches Ollama fetch')
      const newConversation = prompter.promptConvo([])
      assert.equal(await oldConversation, '', 'superseded conversation result is discarded')
      assert.equal(await newConversation, 'new conversation reply')
      assert.equal(conversationSignal.aborted, true, 'new conversation cancels the prior provider request')
      globalThis.fetch = request => new Promise((resolve, reject) => {
        summaryFetchSignal = request.signal
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      })
      const previousCwd = process.cwd()
      process.chdir(ownerRoot)
      try {
      const history = new History(agent)
        const checkpoint = await history.checkpointAdd('summary-owner', 'durable turn')
        assert.equal(checkpoint.saved, true)
        const deadline = Date.now() + 1500
        while (!summaryFetchSignal && Date.now() < deadline) await delay(5)
        assert.ok(summaryFetchSignal, 'History summary reaches the actual Ollama fetch')
        history.invalidateSummaries()
        assert.equal(summaryFetchSignal.aborted, true, 'History epoch cancellation aborts the provider request itself')
        await Promise.allSettled([history.summaryDrainPromise])
        assert.match(history.turns.map(turn => turn.content).join('\n'), /durable turn/)
      } finally { process.chdir(previousCwd) }
      await fs.rm(ownerRoot, { recursive: true, force: true })
    } catch (error) {
      await fs.rm(ownerRoot, { recursive: true, force: true })
      throw error
    }
    process.chdir(originalCwd)
    console.log('Ollama provider fixtures passed: success/usage/error/vision body refusal/fetch cancellation/timeout/late result discard')
  } finally {
    process.chdir(originalCwd)
    globalThis.fetch = originalFetch
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
