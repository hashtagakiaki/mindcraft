'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
let sync

const codec = {
  toNotch: item => item ? { type: item.type, count: item.count, metadata: item.metadata } : null,
  fromNotch: item => item ? { type: item.type, count: item.count, metadata: item.metadata, stackSize: 64 } : null
}

class FakeWindow {
  constructor(id = 0) {
    this.id = id
    this.type = 'minecraft:inventory'
    this.slots = Array(46).fill(null)
    this.selectedItem = null
    this.inventoryStart = 9
    this.inventoryEnd = 45
    this.recipe = null
  }
  updateResult() {
    if (this.recipe && this.slots[1]?.type === this.recipe.ingredient && this.slots[3]?.type === this.recipe.ingredient) {
      this.slots[0] = { type: this.recipe.result, count: 4, metadata: 0, stackSize: 64 }
    } else this.slots[0] = null
  }
  acceptClick({ slot, mouseButton }) {
    if (slot < 0) return []
    if (slot === 0 && this.slots[0]) {
      this.selectedItem = this.slots[0]
      this.slots[0] = null
      this.slots[1].count--
      this.slots[3].count--
      if (!this.slots[1].count) this.slots[1] = null
      if (!this.slots[3].count) this.slots[3] = null
      this.updateResult()
      return [0, 1, 3]
    }
    if (this.selectedItem) {
      if (!this.slots[slot]) {
        if (mouseButton === 1 && this.selectedItem.count > 1) {
          this.slots[slot] = { ...this.selectedItem, count: 1 }
          this.selectedItem.count--
        } else { this.slots[slot] = this.selectedItem; this.selectedItem = null }
      } else if (this.slots[slot].type === this.selectedItem.type && this.slots[slot].metadata === this.selectedItem.metadata) {
        const amount = Math.min(this.selectedItem.count, (this.slots[slot].stackSize || 64) - this.slots[slot].count)
        this.slots[slot].count += amount
        this.selectedItem.count -= amount
        if (!this.selectedItem.count) this.selectedItem = null
      }
    } else if (this.slots[slot]) {
      if (mouseButton === 1 && this.slots[slot].count > 1) {
        this.selectedItem = { ...this.slots[slot], count: 1 }
        this.slots[slot].count--
      } else {
        this.selectedItem = this.slots[slot]
        this.slots[slot] = null
      }
    }
    this.updateResult()
    return [slot]
  }
}

class FakeClient extends EventEmitter {
  constructor(bot) { super(); this.bot = bot; this.suppressStats = false; this.disconnectOnStats = false; this.swapOnSync = false; this.rejectNextClick = false; this.writes = []; this.statsResponses = 0; this.serverSlots = bot.inventory.slots.map(item => item && { ...item }); this.serverCursor = null; this.serverWindows = new Map([[bot.inventory.id, { slots: this.serverSlots, cursor: null }]]) }
  setServerFrom(window) { const state = { slots: window.slots.map(item => item && { ...item }), cursor: window.selectedItem && { ...window.selectedItem } }; this.serverWindows.set(window.id, state); if (window.id === this.bot.inventory.id) { this.serverSlots = state.slots; this.serverCursor = state.cursor } }
  state(windowId) { return this.serverWindows.get(windowId) || { slots: this.serverSlots, cursor: this.serverCursor } }
  write(name, packet) {
    this.writes.push([name, packet])
    if (name === 'window_click' && packet.slot === -999) {
      const current = this.bot.currentWindow || this.bot.inventory
      if (this.swapOnSync) this.bot.currentWindow = new FakeWindow(7)
      const server = this.state(current.id)
      const emitState = stateId => {
        this.emit('packet', { windowId: current.id, stateId, items: server.slots.map(codec.toNotch), carriedItem: codec.toNotch(server.cursor) }, { name: 'window_items' })
      }
      emitState(3) // older response still in flight
      emitState(4) // authoritative response requested by the invalid-state click
    } else if (name === 'window_click') {
      const current = this.bot.currentWindow || this.bot.inventory
      const server = this.state(current.id)
      if (this.rejectNextClick) {
        this.rejectNextClick = false
        setImmediate(() => this.emit('packet', { windowId: current.id, stateId: 5, items: server.slots.map(codec.toNotch), carriedItem: codec.toNotch(server.cursor) }, { name: 'window_items' }))
        return
      }
      this.setServerFrom(current)
      const updated = this.state(current.id)
      setImmediate(() => {
        this.emit('packet', { windowId: current.id, stateId: 5, items: updated.slots.map(codec.toNotch), carriedItem: codec.toNotch(updated.cursor) }, { name: 'window_items' })
      })
    } else if (name === 'client_command') {
      if (this.disconnectOnStats) setImmediate(() => this.emit('end', 'injected disconnect'))
      else if (!this.suppressStats) setImmediate(() => this.stats())
    }
  }
  stats() {
    this.statsResponses++
    this.emit('packet', { entries: [] }, { name: 'statistics' })
    this.emit('statistics', { entries: [] })
  }
}

function botFixture() {
  const bot = { registry: {}, inventory: new FakeWindow(), currentWindow: null, interrupt_code: null }
  bot.inventory.items = () => bot.inventory.slots.filter(Boolean)
  bot._client = new FakeClient(bot)
  return bot
}

function applyState(window, packet) {
  window.slots = packet.items.map(codec.fromNotch)
  window.selectedItem = codec.fromNotch(packet.carriedItem)
}

async function rejects(promise, pattern) {
  await assert.rejects(promise, pattern)
}

async function main() {
  sync = (await import(require('node:url').pathToFileURL(process.argv[2]))).default
  // The session picks the final complete state before the stats response.
  const bot = botFixture()
  bot._client.setServerFrom(bot.inventory)
  bot._client.on('packet', (packet, meta) => {
    if (meta.name === 'window_items' && packet.windowId === 0) applyState(bot.inventory, packet)
  })
  await sync.run(bot, async () => 'ok')
  assert.equal(bot._client.listenerCount('statistics'), 0)
  assert.equal(bot._client.listenerCount('packet'), 1) // only fixture's protocol model listener remains

  const rejectedBot = botFixture()
  rejectedBot.inventory.slots[9] = { type: 1, count: 2, metadata: 0, stackSize: 64 }
  rejectedBot._client.setServerFrom(rejectedBot.inventory)
  rejectedBot._client.rejectNextClick = true
  rejectedBot._client.on('packet', (packet, meta) => {
    if (meta.name === 'window_items' && packet.windowId === 0) applyState(rejectedBot.inventory, packet)
  })
  const recipe = {
    result: { id: 2, count: 4 },
    inShape: [[{ id: 1, metadata: 0 }], [{ id: 1, metadata: 0 }]],
    ingredients: null,
    delta: [{ id: 1, metadata: 0, count: -2 }, { id: 2, metadata: 0, count: 4 }]
  }
  const existingWindowBot = Object.assign(new EventEmitter(), botFixture())
  existingWindowBot._client.bot = existingWindowBot
  const existingTable = new FakeWindow(1)
  existingTable.type = 'minecraft:crafting'
  existingTable.inventoryStart = 10
  existingTable.inventoryEnd = 46
  existingTable.slots[1] = { type: 1, count: 1, metadata: 0, stackSize: 64 }
  existingTable.slots[10] = { type: 1, count: 1, metadata: 0, stackSize: 64 }
  existingWindowBot.currentWindow = existingTable
  existingWindowBot.inventory.recipe = { ingredient: 1, result: 2 }
  existingWindowBot._client.setServerFrom(existingTable)
  existingWindowBot._client.on('packet', (packet, meta) => {
    if (meta.name !== 'window_items') return
    if (packet.windowId === 0) applyState(existingWindowBot.inventory, packet)
    if (packet.windowId === 1) applyState(existingTable, packet)
  })
  existingWindowBot.closeWindow = async window => {
    existingWindowBot.inventory.slots.splice(9, 36, ...window.slots.slice(10, 46))
    existingWindowBot.currentWindow = null
    existingWindowBot._client.setServerFrom(existingWindowBot.inventory)
  }
  const recoveredCraftCount = await sync.run(existingWindowBot, async craft => {
    assert.equal(existingWindowBot.currentWindow, null)
    assert.equal(existingWindowBot.inventory.slots[9].count, 2)
    return craft(recipe, 1, null)
  })
  assert.equal(recoveredCraftCount, 1)
  assert.equal(existingWindowBot.inventory.slots[9].type, 2)
  assert.equal(existingWindowBot.inventory.slots.filter(item => item?.type === 2).reduce((n, item) => n + item.count, 0), 4)

  const reports = []
  const oldConsoleError = console.error
  console.error = (...args) => reports.push(args.join(' '))
  try { await rejects(sync.run(rejectedBot, craft => craft(recipe, 1, null)), /server rejected click/) }
  finally { console.error = oldConsoleError }
  const report = JSON.parse(reports[0].replace(/^\[craft-sync\] /, ''))
  assert.equal(report.recipe.resultId, 2)
  assert.equal(report.requestedCount, 1)
  assert.equal(report.completedCount, 0)
  assert.equal(report.phase, 'placing-input')
  assert.ok(Array.isArray(report.inputGrid))
  assert.equal(report.cursor, null)
  assert.deepEqual(report.delta.expected.map(entry => entry.count), [-2, 4])
  assert.equal(report.delta.observed, null)
  assert.equal(report.attemptedLastClick.slot, 9)
  assert.equal(rejectedBot.inventory.slots[9].count, 2)
  assert.equal(rejectedBot.inventory.slots.some(item => item?.type === 2), false)
  assert.equal(rejectedBot._client.writes.some(([name, packet]) => name === 'window_click' && packet.slot === -999 && packet.mode === 0), false)
  assert.equal(rejectedBot._client.listenerCount('statistics'), 0)
  assert.equal(rejectedBot._client.statsResponses, rejectedBot._client.writes.filter(([name]) => name === 'client_command').length)

  const timeoutBot = botFixture()
  timeoutBot._client.suppressStats = true
  await rejects(sync.run(timeoutBot, async () => true, { timeoutMs: 8 }), /timed out/)
  assert.equal(timeoutBot._client.listenerCount('statistics'), 0)
  await rejects(sync.run(timeoutBot, async () => true), /reconnect before crafting/)

  const disconnectBot = botFixture()
  disconnectBot._client.disconnectOnStats = true
  await rejects(sync.run(disconnectBot, async () => true), /connection closed/)
  assert.equal(disconnectBot._client.listenerCount('statistics'), 0)

  const errorBot = botFixture()
  await rejects(sync.run(errorBot, async () => { throw new Error('injected craft failure') }), /injected craft failure/)
  assert.equal(errorBot._client.listenerCount('statistics'), 0)
  await sync.run(errorBot, async () => true)

  const interruptBot = botFixture()
  interruptBot.interrupt_code = 'stop'
  await rejects(sync.run(interruptBot, async () => assert.fail('callback must not start')), /interrupted before recipe search/)

  for (const activateBlock of [
    () => Promise.reject(new Error('activation rejected')),
    function () { setImmediate(() => this.emit('windowOpen', { id: 3, type: 'minecraft:chest' })) }
  ]) {
    const eventBot = Object.assign(new EventEmitter(), botFixture())
    eventBot.activateBlock = activateBlock.bind(eventBot)
    await rejects(sync.run(eventBot, craft => craft(recipe, 1, { position: {} })), /activation rejected|unexpected crafting window type/)
    assert.equal(eventBot.listenerCount('windowOpen'), 0)
    assert.equal(eventBot.listenerCount('end'), 0)
    assert.equal(eventBot.listenerCount('error'), 0)
    assert.equal(eventBot._client.listenerCount('end'), 0)
    assert.equal(eventBot._client.listenerCount('error'), 0)
  }

  const invalidCountBot = botFixture()
  await rejects(sync.run(invalidCountBot, craft => craft(recipe, 0, null)), /positive integer/)
  await rejects(sync.run(invalidCountBot, craft => craft(recipe, -1, null)), /positive integer/)
  await rejects(sync.run(invalidCountBot, craft => craft(recipe, 1.5, null)), /positive integer/)

  const swapBot = botFixture()
  swapBot._client.swapOnSync = true
  await rejects(sync.run(swapBot, async () => true), /window changed/)

  const lockBot = botFixture()
  let release
  const held = sync.run(lockBot, () => new Promise(resolve => { release = resolve }))
  await new Promise(resolve => setImmediate(resolve))
  await rejects(sync.run(lockBot, async () => true), /another craft session/)
  release('done')
  assert.equal(await held, 'done')

  const noRoomBot = botFixture()
  noRoomBot.inventory.slots[9] = { type: 1, count: 64, metadata: 0, stackSize: 64 }
  noRoomBot.inventory.selectedItem = { type: 2, count: 1, metadata: 0, stackSize: 64 }
  // Full inventory is represented across usable slots; recovery must never send drop slot -999 as an operation.
  for (let i = 10; i < 45; i++) noRoomBot.inventory.slots[i] = { type: 3, count: 64, metadata: 0, stackSize: 64 }
  noRoomBot.inventory.slots[9] = { type: 1, count: 64, metadata: 0, stackSize: 64 }
  noRoomBot._client.setServerFrom(noRoomBot.inventory)
  await rejects(sync.run(noRoomBot, async () => true), /no room|refusing to drop/)
  assert.equal(noRoomBot._client.writes.some(([name, packet]) => name === 'window_click' && packet.slot === -999 && packet.mode === 0), false)

  console.log('crafting_sync tests passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
