'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

async function main() {
  const repo = path.resolve(__dirname, '..')
  const helper = await fs.readFile(path.join(repo, 'src/utils/message_targets.js'), 'utf8')
  const { resolveMessageTargets, parseAddressedMessage, recipientContext } = await import(`data:text/javascript;base64,${Buffer.from(helper).toString('base64')}`)
  const agents = [
    { name: 'Bot2', in_game: true, socket_connected: true },
    { name: 'Bot3', in_game: true, socket_connected: true },
    { name: 'Bot4', in_game: false, socket_connected: true }
  ]
  assert.deepEqual(resolveMessageTargets('@all', agents), ['Bot2', 'Bot3'])
  assert.deepEqual(resolveMessageTargets(['Bot3', 'bot2', 'Bot3'], agents), ['Bot3', 'Bot2'])
  for (const text of ['@Bot2,@Bot3 build a house', '@Bot2, Bot3 build a house', '@Bot2 @Bot3 build a house', '@Bot2、@Bot3 build a house']) {
    assert.deepEqual(parseAddressedMessage(text, agents), { recipients: ['Bot2', 'Bot3'], message: 'build a house' })
  }
  assert.equal(parseAddressedMessage('hello @Bot2', agents), null)
  for (const targets of ['@Bot2,@Missing', '@Bot2,@Bot4', '@all,@Bot2', []]) assert.throws(() => resolveMessageTargets(targets, agents))
  assert.throws(() => parseAddressedMessage('@all', agents))
  assert.throws(() => resolveMessageTargets('@all', []))

  // Execute the actual hub event handler: complete validation precedes every emit.
  const source = await fs.readFile(path.join(repo, 'src/mindcraft/mindserver.js'), 'utf8')
  const handler = source.slice(source.indexOf("        socket.on('send-message'"), source.indexOf("        socket.on('bot-output'"))
  const socket = new EventEmitter()
  socket.data = { identity: { role: 'legacy' } }
  const deliveries = []
  const connections = Object.fromEntries(agents.map(agent => [agent.name, {
    in_game: agent.in_game, connectionGeneration: agent.name === 'Bot2' ? 2 : 3,
    socket: { connected: true, emit: (event, data, acknowledge) => {
      deliveries.push({ name: agent.name, event, data })
      if (event === 'task-context') acknowledge?.({ accepted: true, messageId: data.messageId, receiverTaskId: data.taskId })
      else if (data.taskId && typeof acknowledge === 'function') acknowledge({ accepted: true, taskId: data.taskId })
    } }
  }]))
  vm.runInNewContext(handler, { socket, agent_connections: connections, resolveMessageTargets, parseAddressedMessage,
    allowed: () => true, protectedMode: false, hubClosing: false, managementGeneration: 'legacy-hub-generation',
    console, setTimeout, clearTimeout })
  let result
  const send = (targets, message) => socket.emit('send-message', targets, { from: 'ADMIN', message, recipients: ['forged'] }, value => { result = value })
  send('@all', '!stop')
  assert.equal(result.success, true)
  assert.equal(deliveries.length, 2)
  for (const delivery of deliveries) {
    assert.equal(delivery.data.message, '!stop', 'literal commands are preserved')
    assert.deepEqual(Array.from(delivery.data.recipients), ['Bot2', 'Bot3'])
  }
  send(['Bot2', 'Bot4'], 'build')
  assert.equal(result.success, false)
  assert.equal(deliveries.length, 2, 'unavailable explicit recipient must prevent partial sending')
  send('Bot2', '@Bot3 gather wood')
  assert.equal(deliveries.at(-1).name, 'Bot3')
  assert.equal(deliveries.at(-1).data.message, 'gather wood')
  send('Bot2', 'hello')
  assert.equal(deliveries.at(-1).name, 'Bot2', 'legacy single target still works')
  socket.emit('send-message', 'Bot2', { from: 'SYSTEM', message: 'benchmark task', taskId: 'dispatch-task' }, value => { result = value })
  assert.equal(result.success, true)
  assert.deepEqual(Array.from(result.recipients), ['Bot2'])
  assert.equal(result.taskId, 'dispatch-task', 'dispatch ACK echoes the accepted task ID')
  socket.emit('send-task-context', 'Bot2', { taskId: 'dispatch-task', messageId: 'legacy-facts', message: 'Observed inventory facts.' }, value => { result = value })
  assert.equal(result.success, true, 'legacy operator management can route context through its existing boundary')
  assert.equal(result.acceptance, 'receiver-inbox')
  assert.equal(deliveries.at(-1).event, 'task-context')
  assert.equal(deliveries.at(-1).data.receiverConnectionGeneration, 2)
  assert.equal(deliveries.at(-1).data.hubGeneration, 'legacy-hub-generation')
  socket.emit('send-task-context', ['Bot2', 'Bot3'], { taskId: 'dispatch-task', messageId: 'group-facts', message: 'ambiguous' }, value => { result = value })
  assert.equal(result.success, false, 'context route requires exactly one explicit recipient')

  const agentSource = await fs.readFile(path.join(repo, 'src/agent/agent.js'), 'utf8')
  const setup = agentSource.slice(agentSource.indexOf('        const ignore_messages = ['), agentSource.indexOf('        this.bot.on(\'chat\''))
  const chatStart = agentSource.indexOf("        this.bot.on('chat'")
  const chatEnd = agentSource.indexOf('\n        });', chatStart) + '\n        });'.length
  const received = []
  const bot = new EventEmitter()
  const stoppingWorkers = []
  const agent = { name: 'Bot2', bot, actions: {}, _markWorkerTaskStopping: reason => stoppingWorkers.push(reason),
    handleMessage: async (...args) => received.push(args) }
  const scope = { settings: { only_chat_with: ['ADMIN'] }, convoManager: { isOtherAgent: () => false }, handleEnglishTranslation: async text => text,
    parseAddressedMessage, containsCommand: text => text.startsWith('!') ? text.split('(')[0] : null,
    isAction: () => true, serverProxy: { getAgents: () => agents, getNumOtherAgents: () => 2 },
    randomUUID: () => 'fixture-task', console }
  const install = vm.runInNewContext(`(function() {${setup}${agentSource.slice(chatStart, chatEnd)}})`, scope)
  install.call(agent)
  bot.emit('chat', 'ADMIN', '@all !stop')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(received[0][1], '!stop')
  assert.deepEqual(received[0][3].recipients, ['Bot2', 'Bot3'])
  assert.equal(stoppingWorkers.length, 1, 'an explicit operator intent marks the current worker for cancellation')
  bot.emit('chat', 'ADMIN', '@Bot3 ignore Bot2')
  bot.emit('chat', 'stranger', '@all build')
  bot.emit('chat', 'ADMIN', 'unaddressed')
  bot.emit('chat', 'ADMIN', '@Bot2,@Missing build')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(received.length, 1, 'non-recipients, denied users, and invalid addressing do not execute')
  bot.emit('whisper', 'ADMIN', 'private instruction')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(received.at(-1)[1], 'private instruction', 'ordinary whispers still work')
  assert.ok(received.at(-1)[3].intentReservation, 'operator intent reservation is passed through the same Agent boundary')
  assert.equal(stoppingWorkers.length, 2)

  // Actual command path records recipient context without changing command parsing.
  const methodStart = agentSource.indexOf('    async handleMessage(')
  const methodEnd = agentSource.indexOf('\n    async ', methodStart + 10)
  const method = agentSource.slice(methodStart, methodEnd)
  const internalStart = agentSource.indexOf('    async _handleMessageInternal(')
  const internalEnd = agentSource.indexOf('\n    async ', internalStart + 10)
  const internalMethod = agentSource.slice(internalStart, internalEnd)
  const history = []
  const commands = []
  const accepted = []
  const handle = vm.runInNewContext(`({${method}}).handleMessage`, {
    convoManager: { isOtherAgent: () => false }, containsCommand: message => message.startsWith('!') ? message.split('(')[0] : null,
    commandExists: () => true, isAction: () => true, settings: { max_commands: 1 }, recipientContext,
    executeCommand: async (_agent, message) => { commands.push(message); return null }, randomUUID: () => 'fixture-task', console,
    MAX_TASK_DISPATCH_IDS: 256
  })
  const internalHandle = vm.runInNewContext(`({${internalMethod}})._handleMessageInternal`, {
    convoManager: { isOtherAgent: () => false }, containsCommand: message => message.startsWith('!') ? message.split('(')[0] : null,
    commandExists: () => true, isAction: () => true, settings: { max_commands: 1 }, recipientContext,
    executeCommand: async (_agent, message) => { commands.push(message); return null }, randomUUID: () => 'fixture-task', console
  })
  const latestIntent = { token: 'newer' }
  let staleIntentAck
  let staleIntentStops = 0
  const concurrentAgent = { name: 'Bot2', _messageGeneration: 0, _intentReservation: latestIntent,
    _markWorkerTaskStopping() { staleIntentStops++ }, actions: {}, checkTaskDone: async () => {}, history: {}, routeResponse() {} }
  assert.equal(await internalHandle.call(concurrentAgent, 'ADMIN', 'older delayed operator intent', null, {
    intentReservation: { token: 'older' }, onAccepted: value => { staleIntentAck = value }
  }), false, 'an earlier translation cannot replace a later synchronous operator reservation')
  assert.equal(concurrentAgent._intentReservation, latestIntent)
  assert.equal(staleIntentStops, 0)
  assert.equal(staleIntentAck.accepted, false)
  const commandAgent = { name: 'Bot2', _messageGeneration: 0, actions: { beginUserIntent() {} }, checkTaskDone: async () => {},
    _markWorkerTaskStopping() {}, history: { add: async (...args) => history.push(args) }, routeResponse() {}, _handleMessageInternal: internalHandle }
  await handle.call(commandAgent, 'ADMIN', '!newAction("build")', null, { recipients: ['Bot2', 'Bot3'], taskId: 'command-task', onAccepted: value => accepted.push(value) })
  assert.match(history[0][1], /ADMIN.*Bot2, Bot3/)
  assert.equal(history[1][1], '!newAction("build")')
  assert.deepEqual(commands, ['!newAction("build")'])
  assert.deepEqual(accepted.map(value => ({ accepted: value.accepted, taskId: value.taskId })), [{ accepted: true, taskId: 'command-task' }])

  const html = await fs.readFile(path.join(repo, 'src/mindcraft/public/index.html'), 'utf8')
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1])
  // Exercise recipient selection and chat sending with disposable DOM/socket doubles.
  class Element extends EventEmitter {
    constructor() { super(); this.value = ''; this.disabled = false; this.dataset = {}; this.classes = new Set(); this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) } }
    addEventListener(event, listener) { this.on(event, listener) }
    click() { this.emit('click') }
  }
  const elements = Object.fromEntries(['recipientSummary', 'groupResult', 'chatInput', 'chatSendBtn', ...agents.map(agent => `agent-${agent.name}`)].map(id => [id, new Element()]))
  const agentsDiv = new Element()
  const document = { getElementById: id => elements[id] }
  const uiSocket = new EventEmitter()
  uiSocket.connected = true
  let uiDelivery
  let failSend = false
  uiSocket.on('send-message', (targets, data, callback) => {
    uiDelivery = { targets: Array.isArray(targets) ? Array.from(targets) : targets, data }
    callback(failSend ? { success: false, error: 'Unavailable recipient' } : { success: true, recipients: Array.isArray(targets) ? Array.from(targets) : [targets] })
  })
  const chatRecords = []
  const ui = vm.createContext({ socket: uiSocket, currentAgents: agents, agentsDiv, document, appendChatRecord: record => chatRecords.push(record) })
  const uiStart = html.indexOf('        // Individual control buttons')
  const uiEnd = html.indexOf("        const recipientMenu = document.getElementById('recipientMenu');", uiStart)
  assert.ok(uiStart > 0 && uiEnd > uiStart, 'UI selection section is present')
  vm.runInContext(html.slice(uiStart, uiEnd), ui)
  const input = elements.chatInput
  const sendBtn = elements.chatSendBtn
  const typeText = text => { input.value = text; input.emit('input') }
  const clickCard = (name, interactive = false) => agentsDiv.emit('click', { target: { closest: selector => selector === '.agent' ? { dataset: { agentName: name } } : interactive ? {} : null } })
  typeText('build together')
  assert.equal(sendBtn.disabled, true, 'no recipients means nothing to send')
  vm.runInContext("toggleRecipient('Bot2'); toggleRecipient('Bot3'); toggleRecipient('Bot4')", ui)
  assert.equal(elements['agent-Bot2'].classes.has('selected'), true)
  assert.equal(elements['agent-Bot3'].classes.has('selected'), true)
  assert.equal(elements['agent-Bot4'].classes.has('selected'), false, 'offline bots cannot be selected')
  clickCard('Bot2', true)
  assert.equal(elements['agent-Bot2'].classes.has('selected'), true, 'controls inside a card do not toggle recipients')
  assert.equal(sendBtn.disabled, false)
  assert.equal(sendBtn.textContent, 'Send to 2 bots')
  sendBtn.click()
  assert.deepEqual(uiDelivery.targets, ['Bot2', 'Bot3'])
  assert.equal(uiDelivery.data.from, 'ADMIN', 'legacy UI messages identify the configured operator')
  assert.equal(input.value, '')
  assert.match(elements.groupResult.textContent, /Bot2, Bot3/)
  assert.deepEqual(chatRecords.map(record => ({ kind: record.kind, recipients: record.recipients, message: record.message })),
    [{ kind: 'operator', recipients: ['Bot2', 'Bot3'], message: 'build together' }], 'sent messages appear in the chat')
  vm.runInContext("sendMessage('Bot2', '!stop')", ui)
  assert.equal(uiDelivery.targets, 'Bot2', 'individual control buttons retain their scope')
  clickCard('Bot2')
  assert.equal(elements['agent-Bot2'].classes.has('selected'), false, 'clicking a card toggles it as a recipient')
  typeText('retained instruction')
  let prevented = false
  input.emit('keydown', { key: 'Enter', shiftKey: false, isComposing: false, preventDefault: () => { prevented = true } })
  assert.equal(prevented, true)
  assert.deepEqual(uiDelivery.targets, ['Bot3'], 'Enter sends to the current selection')
  typeText('retained instruction')
  vm.runInContext('selectAllRecipients()', ui)
  assert.equal(elements['agent-Bot2'].classes.has('selected'), true)
  failSend = true
  sendBtn.click()
  assert.equal(input.value, 'retained instruction', 'errors keep the draft')
  assert.equal(chatRecords.length, 2, 'failed sends are not added to the chat')
  failSend = false
  vm.runInContext("currentAgents = currentAgents.filter(agent => agent.name !== 'Bot3'); updateSelectionUI()", ui)
  sendBtn.click()
  assert.deepEqual(uiDelivery.targets, ['Bot2'], 'removed recipients leave the selection')
  vm.runInContext('clearRecipients()', ui)
  typeText('@Bot2 addressed')
  assert.equal(sendBtn.disabled, false, 'an explicit address prefix can send without a selection')
  uiSocket.connected = false
  uiSocket.emit('disconnect')
  assert.equal(sendBtn.disabled, true)
  console.log('group addressing, hub delivery, Minecraft routing, command context and UI selection tests passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
