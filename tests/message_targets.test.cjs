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
  const deliveries = []
  const connections = Object.fromEntries(agents.map(agent => [agent.name, {
    in_game: agent.in_game, socket: { connected: true, emit: (event, data) => deliveries.push({ name: agent.name, event, data }) }
  }]))
  vm.runInNewContext(handler, { socket, agent_connections: connections, resolveMessageTargets, parseAddressedMessage, console })
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

  const agentSource = await fs.readFile(path.join(repo, 'src/agent/agent.js'), 'utf8')
  const setup = agentSource.slice(agentSource.indexOf('        const ignore_messages = ['), agentSource.indexOf('        this.bot.on(\'chat\''))
  const chatStart = agentSource.indexOf("        this.bot.on('chat'")
  const chatEnd = agentSource.indexOf('\n        });', chatStart) + '\n        });'.length
  const received = []
  const bot = new EventEmitter()
  const agent = { name: 'Bot2', bot, actions: {}, handleMessage: async (...args) => received.push(args) }
  const scope = { settings: { only_chat_with: ['ADMIN'] }, convoManager: { isOtherAgent: () => false }, handleEnglishTranslation: async text => text,
    parseAddressedMessage, serverProxy: { getAgents: () => agents, getNumOtherAgents: () => 2 }, console }
  const install = vm.runInNewContext(`(function() {${setup}${agentSource.slice(chatStart, chatEnd)}})`, scope)
  install.call(agent)
  bot.emit('chat', 'ADMIN', '@all !stop')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(received[0][1], '!stop')
  assert.deepEqual(received[0][3].recipients, ['Bot2', 'Bot3'])
  bot.emit('chat', 'ADMIN', '@Bot3 ignore Bot2')
  bot.emit('chat', 'stranger', '@all build')
  bot.emit('chat', 'ADMIN', 'unaddressed')
  bot.emit('chat', 'ADMIN', '@Bot2,@Missing build')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(received.length, 1, 'non-recipients, denied users, and invalid addressing do not execute')
  bot.emit('whisper', 'ADMIN', 'private instruction')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(received.at(-1)[1], 'private instruction', 'ordinary whispers still work')

  // Actual command path records recipient context without changing command parsing.
  const methodStart = agentSource.indexOf('    async handleMessage(')
  const methodEnd = agentSource.indexOf('\n    async ', methodStart + 10)
  const method = agentSource.slice(methodStart, methodEnd)
  const history = []
  const commands = []
  const handle = vm.runInNewContext(`({${method}}).handleMessage`, {
    convoManager: { isOtherAgent: () => false }, containsCommand: message => message.startsWith('!') ? message.split('(')[0] : null,
    commandExists: () => true, isAction: () => true, settings: { max_commands: 1 }, recipientContext,
    executeCommand: async (_agent, message) => { commands.push(message); return null }, console
  })
  const commandAgent = { name: 'Bot2', _messageGeneration: 0, actions: { beginUserIntent() {} }, checkTaskDone: async () => {},
    history: { add: async (...args) => history.push(args) }, routeResponse() {} }
  await handle.call(commandAgent, 'ADMIN', '!newAction("build")', null, { recipients: ['Bot2', 'Bot3'] })
  assert.match(history[0][1], /ADMIN.*Bot2, Bot3/)
  assert.equal(history[1][1], '!newAction("build")')
  assert.deepEqual(commands, ['!newAction("build")'])

  const html = await fs.readFile(path.join(repo, 'src/mindcraft/public/index.html'), 'utf8')
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1])
  // Exercise the actual selection UI with disposable DOM/socket doubles.
  class Element extends EventEmitter {
    constructor() { super(); this.children = []; this.value = ''; this.checked = false; this.disabled = false }
    addEventListener(event, listener) { this.on(event, listener) }
    append(...children) { this.children.push(...children) }
    replaceChildren() { this.children = [] }
    querySelectorAll() { return this.children.flatMap(label => label.children || []).filter(input => input instanceof Element && input.checked) }
    querySelector() { return this.querySelectorAll()[0] || null }
    click() { this.emit('click') }
  }
  const elements = Object.fromEntries(['groupAll', 'groupMessage', 'groupSend', 'groupRecipients', 'groupResult'].map(id => [id, new Element()]))
  const uiSocket = new EventEmitter()
  uiSocket.connected = true
  let uiDelivery
  uiSocket.on('send-message', (targets, data, callback) => {
    uiDelivery = { targets: Array.isArray(targets) ? Array.from(targets) : targets, data }
    callback({ success: true, recipients: ['Bot2', 'Bot3'] })
  })
  const ui = vm.createContext({ socket: uiSocket, currentAgents: agents,
    document: { getElementById: id => elements[id], createElement: () => new Element(), createTextNode: text => text } })
  const uiStart = html.indexOf('        const groupAll =')
  const uiEnd = html.indexOf('        function onMsgInputChange', uiStart)
  vm.runInContext(html.slice(uiStart, uiEnd) + '\nrenderGroupRecipients();', ui)
  const choices = elements.groupRecipients.children.map(label => label.children[0])
  assert.equal(choices[2].disabled, true)
  choices[0].checked = choices[1].checked = true
  elements.groupMessage.value = 'build together'
  elements.groupMessage.emit('input')
  assert.equal(elements.groupSend.disabled, false)
  elements.groupSend.click()
  assert.deepEqual(uiDelivery.targets, ['Bot2', 'Bot3'])
  assert.equal(elements.groupMessage.value, '')
  assert.match(elements.groupResult.textContent, /Bot2, Bot3/)
  elements.groupAll.checked = true
  elements.groupAll.emit('change')
  elements.groupMessage.value = '!stop'
  elements.groupMessage.emit('input')
  elements.groupMessage.emit('keydown', { key: 'Enter' })
  assert.equal(uiDelivery.targets, '@all')
  assert.equal(uiDelivery.data.message, '!stop')
  uiSocket.connected = false
  uiSocket.emit('disconnect')
  assert.equal(elements.groupSend.disabled, true)
  console.log('group addressing, hub delivery, Minecraft routing, command context and UI selection tests passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
