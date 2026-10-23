'use strict'

const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { mkdtemp, mkdir, readFile, writeFile, symlink, stat, rm } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { moduleRoot } = require('./dependency_root.cjs')

const dependencies = moduleRoot()
const dependencyRequire = createRequire(path.join(dependencies, 'package.json'))
const socketClient = dependencyRequire('socket.io-client').io
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function write(root, relative, content) {
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
}

async function connect(url, token, shouldReject = false) {
  const socket = socketClient(url, { transports: ['websocket'], reconnection: false, auth: { token } })
  const result = await new Promise(resolve => {
    socket.once('connect', () => resolve({ connected: true }))
    socket.once('connect_error', () => resolve({ connected: false }))
    setTimeout(() => resolve({ connected: false, timedOut: true }), 2000).unref()
  })
  assert.equal(result.connected, !shouldReject, 'Socket.IO admission follows the presented role credential')
  return socket
}

async function ack(socket, event, ...args) {
  return new Promise(resolve => socket.emit(event, ...args, resolve))
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-management-auth-'))
  const previousLog = console.log
  const logLines = []
  console.log = (...args) => logLines.push(args.join(' '))
  let clients = []
  let server
  let sourceSettings
  let createdAgents = 0
  try {
    const sourceRoot = path.resolve(__dirname, '..')
    await write(root, 'package.json', '{"type":"module"}')
    await symlink(dependencies, path.join(root, 'node_modules'), 'dir')
    await write(root, 'settings.js', `export default ${JSON.stringify({ management_auth_mode: 'protected', place_state_dir: null, place_world_id: null })}`)
    await write(root, 'src/utils/message_targets.js', await readFile(path.join(sourceRoot, 'src/utils/message_targets.js')))
    await write(root, 'src/mindcraft/public/settings_spec.json', await readFile(path.join(sourceRoot, 'src/mindcraft/public/settings_spec.json')))
    await write(root, 'src/mindcraft/public/index.html', '<html>protected UI</html>')
    await write(root, 'src/mindcraft/place_rpc.js', 'export function attachPlaceRpc() {}')
    await write(root, 'src/mindcraft/place_store.js', `
export class PlaceStore { static async open() { return null } }
export function attachPlaceStoreLifecycle({ socketServer, beforeClose }) {
  return { async shutdown(request) { await beforeClose(request?.reason); await new Promise(resolve => socketServer.close(resolve)); } }
}`)
    await write(root, 'src/mindcraft/mindcraft.js', `
let closeHandler = null
export async function createAgent() { globalThis.__createdAgents++; return { success: true } }
export function startAgent() { return Promise.resolve(null) }
export function stopAgent() { return Promise.resolve(null) }
export function destroyAgent() { return Promise.resolve(null) }
export function stopAllAgents() { return Promise.resolve(null) }
export function setShutdownHandler(handler) { closeHandler = handler }
export function setTaskEndingHandler() {}
export async function shutdown(request) { return closeHandler?.(request) }
`)
    const source = await readFile(path.join(sourceRoot, 'src/mindcraft/mindserver.js'))
    await write(root, 'src/mindcraft/mindserver.js', source)
    await write(root, 'src/mindcraft/worker_task_registry.js', await readFile(path.join(sourceRoot, 'src/mindcraft/worker_task_registry.js')))
    await write(root, 'src/mindcraft/worker_task_management.js', await readFile(path.join(sourceRoot, 'src/mindcraft/worker_task_management.js')))
    await write(root, 'src/mindcraft/state_poller.js', await readFile(path.join(sourceRoot, 'src/mindcraft/state_poller.js')))
    await write(root, 'src/mindcraft/bot_output_history.js', await readFile(path.join(sourceRoot, 'src/mindcraft/bot_output_history.js')))
    const fixtureSettings = await import(pathToFileURL(path.join(root, 'settings.js')).href)
    sourceSettings = fixtureSettings.default
    sourceSettings.management_auth_mode = 'protected'
    globalThis.__createdAgents = 0
    globalThis.__fixtureSocketServer = null
    const module = await import(pathToFileURL(path.join(root, 'src/mindcraft/mindserver.js')).href)
    const fixtureMindcraft = await import(pathToFileURL(path.join(root, 'src/mindcraft/mindcraft.js')).href)
    const privateDir = path.join(root, 'private')
    await mkdir(privateDir, { mode: 0o700 })
    const sessionFile = path.join(privateDir, 'session.json')
    process.env.MINDCRAFT_SESSION_FILE = sessionFile
    server = module.createMindServer(false, 0)
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    const url = `http://localhost:${server.address().port}`
    const session = JSON.parse(await readFile(sessionFile, 'utf8'))
    assert.equal((await stat(sessionFile)).mode & 0o777, 0o600, 'hub session file is private')
    assert.equal(sessionFile.startsWith(path.join(root, 'src/mindcraft/public') + path.sep), false)

    const botAConnection = module.registerAgent({ profile: { name: 'botA' }, host: 'localhost', port: 1 }, null)
    const botBConnection = module.registerAgent({ profile: { name: 'botB' }, host: 'localhost', port: 1 }, null)
    const credentialA1 = { spawnId: 'spawn-a1', token: 'a'.repeat(64) }
    const credentialB1 = { spawnId: 'spawn-b1', token: 'b'.repeat(64) }
    module.issueBotCredential('botA', credentialA1.spawnId, credentialA1.token)
    module.issueBotCredential('botB', credentialB1.spawnId, credentialB1.token)

    const anonymous = socketClient(url, { transports: ['websocket'], reconnection: false })
    clients.push(anonymous)
    const anonymousResult = await new Promise(resolve => anonymous.once('connect_error', () => resolve(false)))
    assert.equal(anonymousResult, false, 'anonymous clients are rejected before Socket.IO connection')
    const observer = await connect(url, session.observer)
    clients.push(observer)
    let observerStatusEvents = 0
    observer.on('agents-status', () => observerStatusEvents++)
    const readiness = await ack(observer, 'readiness')
    assert.deepEqual(readiness.agents.map(agent => agent.name).sort(), ['botA', 'botB'])
    observer.emit('create-agent', { profile: { name: 'denied' } })
    await delay(50)
    assert.equal(globalThis.__createdAgents, 0, 'observer cannot create agents')
    assert.equal(observerStatusEvents, 0, 'observer receives no broad agent state events')

    const operator = await connect(url, session.operator)
    clients.push(operator)
    const botA = await connect(url, credentialA1.token)
    const botB = await connect(url, credentialB1.token)
    clients.push(botA, botB)
    const regA = await ack(botA, 'connect-agent-process', 'botA', { connectionGeneration: 3 })
    const regB = await ack(botB, 'connect-agent-process', 'botB', { connectionGeneration: 7 })
    assert.equal(regA.spawnId, credentialA1.spawnId)
    assert.equal(regB.accepted, true)
    botA.emit('login-agent', 'botA')
    botB.emit('login-agent', 'botB')
    await delay(50)
    assert.equal(observerStatusEvents, 0, 'observer receives no agents-status or viewer-port broadcasts after bots connect')

    const invalidSettings = await ack(operator, 'set-agent-settings', 'botA', { profile: { name: 'botA' }, unexpected: true })
    assert.equal(invalidSettings.success, false, 'settings updates reject keys outside the fixed settings schema')
    const wrongTypeSettings = await ack(operator, 'set-agent-settings', 'botA', { profile: { name: 'botA' }, port: '55916' })
    assert.equal(wrongTypeSettings.success, false, 'settings updates reject values with the wrong schema type')

    const settingsA = await ack(botA, 'get-settings', 'botA')
    assert.equal(settingsA.management.spawnId, credentialA1.spawnId)
    assert.equal(JSON.stringify(settingsA).includes(credentialA1.token), false, 'bot token is absent from settings and fingerprint payload')
    assert.deepEqual(await ack(botA, 'get-settings', 'botB'), { success: false, error: 'MindServer authorization denied' },
      'bot identity cannot read another bot settings')

    const taskId = 'fixture-task-1'
    let receivedTask
    botB.on('send-message', (payload, acknowledge) => { receivedTask = payload; acknowledge({ accepted: true, taskId }) })
    const taskAck = await ack(operator, 'send-message', 'botB', { from: 'forged sender', message: 'do task', taskId })
    assert.equal(taskAck.success, true, 'task ACK follows the authenticated bot acceptance callback')
    assert.equal(receivedTask.from, 'ADMIN', 'operator sender is derived from authenticated role')
    await delay(25)
    const groupTaskAck = await ack(operator, 'send-message', 'botA,botB', { from: 'ADMIN', message: 'ambiguous group task', taskId: 'fixture-task-group' })
    assert.equal(groupTaskAck.success, false, 'task-ID dispatch rejects multiple recipients instead of reporting the first ACK as group acceptance')

    let receivedContext
    botB.on('task-context', (envelope, acknowledge) => {
      receivedContext = envelope
      acknowledge({ accepted: true, messageId: envelope.messageId, receiverTaskId: envelope.taskId })
    })
    const contextAck = await ack(operator, 'send-task-context', 'botB', {
      taskId: 'fixture-task-1', messageId: 'facts-1', message: 'BotA observed 12 iron ingots.'
    })
    assert.equal(contextAck.success, true, 'protected operator can send task-scoped context')
    assert.equal(contextAck.acceptance, 'receiver-inbox')
    assert.equal(receivedContext.from, 'ADMIN', 'context sender identity is assigned by MindServer')
    assert.equal(receivedContext.receiverConnectionGeneration, 7)
    assert.equal(receivedContext.hubGeneration, settingsA.management.generation)
    const botContextAck = await ack(botA, 'send-task-context', 'botB', {
      taskId: 'fixture-task-1', messageId: 'forged-facts', message: 'forged operator context'
    })
    assert.equal(botContextAck.success, false, 'protected peer identity cannot use the operator context route')
    const observerContextAck = await ack(observer, 'send-task-context', 'botB', {
      taskId: 'fixture-task-1', messageId: 'observer-facts', message: 'forged observer context'
    })
    assert.equal(observerContextAck.success, false, 'protected observers cannot use the operator context route')

    let captureRequest
    botB.on('diagnostic-capture', (request, acknowledge) => {
      captureRequest = request
      acknowledge({ accepted: true, requestId: request.requestId, ringEventCount: 3 })
    })
    const captureAck = await ack(operator, 'diagnostic-capture', 'botB', { requestId: 'capture-1' })
    assert.equal(captureAck.accepted, true, 'protected operator can request an incident capture')
    assert.deepEqual(captureRequest, { requestId: 'capture-1' })
    const observerCapture = await ack(observer, 'diagnostic-capture', 'botB', { requestId: 'observer-capture' })
    assert.equal(observerCapture.success, false, 'protected observer cannot request an incident capture')
    const peerCapture = await ack(botA, 'diagnostic-capture', 'botB', { requestId: 'peer-capture' })
    assert.equal(peerCapture.success, false, 'bot identity cannot request an incident capture from another bot')

    let workerEnvelope
    botB.on('worker-task-start', (envelope, acknowledge) => {
      workerEnvelope = envelope
      acknowledge({ accepted: true, taskId: envelope.handle.taskId, handleId: envelope.handle.id })
      setTimeout(() => {
        for (const [type, extra] of [
          ['report', { message: '模擬workerの成果報告', phase: 'final_answer' }],
          ['terminal', { outcome: { status: 'completed', completion: 'reported', operationSettlement: 'settled' } }],
        ]) botB.emit('worker-task-event', { handle: envelope.handle, handleId: envelope.handle.id,
          bot: 'botB', taskId: envelope.handle.taskId, hubGeneration: envelope.handle.hubGeneration,
          connectionGeneration: envelope.handle.connectionGeneration, type, ...extra }, () => {} )
      }, 20)
    })
    const startTask = await ack(operator, 'worker-task-start', {
      bot: 'botB', requestId: 'worker-request-1', message: '共有倉庫の鉄を確認して報告する'
    })
    assert.equal(startTask.success, true)
    assert.equal(startTask.accepted, true)
    assert.equal(workerEnvelope.message, '共有倉庫の鉄を確認して報告する')
    assert.equal(startTask.handle.connectionGeneration, 7)
    const observerTask = await ack(observer, 'worker-task-read', { handle: startTask.handle })
    assert.equal(observerTask.success, false, 'protected observer cannot read worker handles')
    const peerTask = await ack(botA, 'worker-task-wait', { handles: [startTask.handle], timeoutMs: 0 })
    assert.equal(peerTask.success, false, 'protected peer cannot wait for operator worker tasks')
    const workerWait = await ack(operator, 'worker-task-wait', { handles: [startTask.handle], timeoutMs: 1000 })
    assert.equal(workerWait.success, true)
    assert.equal(workerWait.tasks[0].report.message, '模擬workerの成果報告')
    assert.equal(workerWait.tasks[0].outcome.status, 'completed')
    const duplicateStart = await ack(operator, 'worker-task-start', {
      bot: 'botB', requestId: 'worker-request-1', message: '共有倉庫の鉄を確認して報告する'
    })
    assert.equal(duplicateStart.handle.id, startTask.handle.id, 'same request ID resolves to the same task')
    const requestCollision = await ack(operator, 'worker-task-start', {
      bot: 'botB', requestId: 'worker-request-1', message: '別の依頼'
    })
    assert.equal(requestCollision.success, false, 'same request ID with different content is rejected')

    const created = await ack(operator, 'create-agent', { profile: { name: 'operator-created' } })
    assert.equal(created.success, true, 'operator role retains authorized management control')
    assert.equal(globalThis.__createdAgents, 1)

    let botChat
    botB.on('chat-message', (sender, json, acknowledge) => {
      botChat = { sender, json }
      if (json?.nativeMessage) acknowledge({ accepted: true, messageId: json.nativeMessage.id,
        taskId: json.nativeMessage.senderTaskId, receiverTaskId: 'botB-active-task' })
    })
    botA.emit('chat-message', 'botB', { from: 'forged bot name', message: 'hello' })
    await delay(50)
    assert.equal(botChat.sender, 'botA', 'bot-to-bot chat uses authenticated source identity')
    const nativeAck = await ack(botA, 'chat-message', 'botB', { message: 'native hello', nativeMessage: {
      id: 'native-message-1', senderTaskId: 'botA-task-1', senderActionId: 'action-1',
      senderConnectionGeneration: 3, senderManagementGeneration: 2,
    } })
    assert.deepEqual(nativeAck, { accepted: true, messageId: 'native-message-1', taskId: 'botA-task-1', receiverTaskId: 'botB-active-task' },
      'native transport ACK returns recipient inbox acceptance and its separate task ID')
    assert.equal(botChat.json.nativeMessage.senderAgent, 'botA', 'hub overwrites sender identity from the authenticated socket')
    assert.equal(botChat.json.nativeMessage.senderSpawnId, 'spawn-a1')
    assert.equal(botChat.json.nativeMessage.receiverConnectionGeneration, 7)
    assert.equal(botChat.json.nativeMessage.hubGeneration, settingsA.management.generation)

    botA.disconnect()
    await delay(20)
    const reconnectA = await connect(url, credentialA1.token)
    clients.push(reconnectA)
    assert.equal((await ack(reconnectA, 'connect-agent-process', 'botA', { connectionGeneration: 4 })).accepted, true,
      'same spawned child keeps its credential across transport reconnect')
    const olderSameSpawnSocket = await connect(url, credentialA1.token)
    clients.push(olderSameSpawnSocket)
    assert.equal((await ack(olderSameSpawnSocket, 'connect-agent-process', 'botA', { connectionGeneration: 3 })).accepted, false,
      'an older authenticated socket cannot replace the current connection generation')
    assert.equal((await ack(olderSameSpawnSocket, 'chat-message', 'botB', { message: 'stale same-spawn message', nativeMessage: {
      id: 'stale-connection-message', senderTaskId: 'old-task', senderActionId: 'old-action',
      senderConnectionGeneration: 3, senderManagementGeneration: 1,
    } })).accepted, false, 'native message from an old same-spawn connection is rejected')
    reconnectA.disconnect()
    await delay(20)
    assert.equal((await ack(olderSameSpawnSocket, 'connect-agent-process', 'botA', { connectionGeneration: 3 })).accepted, false,
      'disconnecting the latest socket does not erase the generation high-water mark')
    module.issueBotCredential('botA', 'spawn-a2', 'c'.repeat(64))
    assert.deepEqual(await ack(olderSameSpawnSocket, 'get-settings', 'botA'), { success: false, error: 'MindServer authorization denied' },
      'old already-connected spawn loses authority immediately after replacement')
    const oldReconnect = await connect(url, credentialA1.token, true)
    clients.push(oldReconnect)
    const botANew = await connect(url, 'c'.repeat(64))
    clients.push(botANew)
    assert.equal((await ack(botANew, 'connect-agent-process', 'botA', { connectionGeneration: 1 })).spawnId, 'spawn-a2',
      'new spawn receives only its own generation credential')

    const staticResponse = await fetch(`${url}/`)
    assert.equal((await staticResponse.text()).includes(session.operator), false, 'operator token is never published by static files')
    assert.equal(JSON.stringify(sourceSettings).includes(session.operator), false, 'token is absent from root settings')
    assert.equal(logLines.some(line => line.includes(session.operator) || line.includes(credentialA1.token)), false,
      'synthetic credentials are absent from hub logs')

    for (const client of clients) client.disconnect()
    await fixtureMindcraft.shutdown({ reason: 'fixture-close' })
    clients = []
    await assert.rejects(stat(sessionFile), { code: 'ENOENT' }, 'hub shutdown removes its session file')
    const sentinel = 'fixture-owned-existing-file'
    await writeFile(sessionFile, sentinel, { mode: 0o600 })
    assert.throws(() => module.createMindServer(false, 0), /EEXIST/, 'hub refuses to replace a pre-existing session file')
    assert.equal(await readFile(sessionFile, 'utf8'), sentinel, 'pre-existing session file is preserved')
    const publicRoot = path.join(root, 'src/mindcraft/public')
    const publicLink = path.join(root, 'public-link')
    await symlink(publicRoot, publicLink, 'dir')
    process.env.MINDCRAFT_SESSION_FILE = path.join(publicLink, 'session.json')
    assert.throws(() => module.createMindServer(false, 0), /static root/, 'symlinked session parent cannot place credentials under static files')
    await assert.rejects(stat(path.join(publicRoot, 'session.json')), { code: 'ENOENT' })
    process.stdout.write('management_auth.test.cjs: all assertions passed\n')
  } finally {
    console.log = previousLog
    for (const client of clients) { try { client.disconnect() } catch {} }
    if (server?.listening) await new Promise(resolve => server.close(resolve))
    delete process.env.MINDCRAFT_SESSION_FILE
    delete globalThis.__createdAgents
    delete globalThis.__fixtureSocketServer
    await rm(root, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
