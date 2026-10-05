import { createRequire } from 'node:module'
import { recordConfirmation } from './operation_context.js'

const require = createRequire(import.meta.url)

// This module is copied into a disposable MindCraft runtime. It intentionally
// owns clicks only while a craftRecipe session is active.
const craftLocks = new WeakSet()
const poisonedBots = new WeakSet()
const FENCE_TIMEOUT_MS = 5000
const MAX_SNAPSHOT_HISTORY = 64
const MAX_ACTION_HISTORY = 32
const MAX_RECOVERY_STEPS = 128

function fail(message) { throw new Error(`craft sync: ${message}`) }
function sameWindow(bot, window) { return (bot.currentWindow || bot.inventory) === window }

async function run(bot, callback, options = {}) {
  if (!bot || !bot._client || !bot.inventory) fail('bot is not ready')
  if (poisonedBots.has(bot)) fail('connection had an ambiguous timed-out statistics fence; reconnect before crafting')
  if (craftLocks.has(bot)) fail('another craft session is active')
  craftLocks.add(bot)
  let session
  try {
    session = new Session(bot, options.timeoutMs || FENCE_TIMEOUT_MS)
    session.attach()
    session.phase = 'prepare-recovery'
    await session.prepare()
    if (bot.interrupt_code) fail('interrupted before recipe search')
    session.phase = 'skill-recipe-search'
    return await callback(session.craft.bind(session))
  } catch (error) {
    const diagnostic = session ? session.report(error) : null
    if (session && session.healthy) {
      try { await session.prepare() } catch (recoveryError) {
        error.message += `; recovery failed: ${recoveryError.message}`
      }
    }
    if (diagnostic) {
      diagnostic.message = error.message
      try { console.error(`[craft-sync] ${JSON.stringify(diagnostic)}`) } catch {}
    }
    throw error
  } finally {
    if (session) session.detach()
    craftLocks.delete(bot)
  }
}

async function snapshotWindow(bot, window, options = {}) {
  if (!bot || !bot._client || !bot.inventory) fail('bot is not ready')
  if (!window || !sameWindow(bot, window)) {
    bot.inventoryUnconfirmed = true
    fail('window is not currently owned by this bot')
  }
  if (poisonedBots.has(bot)) {
    bot.inventoryUnconfirmed = true
    fail('connection had an ambiguous timed-out statistics fence; reconnect before inventory confirmation')
  }
  if (craftLocks.has(bot)) {
    bot.inventoryUnconfirmed = true
    fail('another craft session is active')
  }
  craftLocks.add(bot)
  const session = new Session(bot, options.timeoutMs || FENCE_TIMEOUT_MS)
  try {
    session.attach()
    session.phase = 'inventory-snapshot'
    const snapshot = await session.sync(window)
    if (window === bot.inventory) bot.inventoryUnconfirmed = false
    return snapshot
  } catch (error) {
    bot.inventoryUnconfirmed = true
    throw error
  } finally {
    session.detach()
    craftLocks.delete(bot)
  }
}

async function snapshotInventory(bot, options = {}) {
  if (bot?.currentWindow && bot.currentWindow !== bot.inventory) {
    bot.inventoryUnconfirmed = true
    fail(`refusing inventory snapshot while ${bot.currentWindow.type || 'another'} window is open`)
  }
  return snapshotWindow(bot, bot?.inventory, options)
}

class Session {
  constructor(bot, timeoutMs) {
    this.bot = bot
    this.client = bot._client
    this.timeoutMs = timeoutMs
    this.healthy = true
    this.flight = Promise.resolve()
    this.sequence = 0
    this.stateIds = new Map()
    this.snapshots = []
    this.actions = []
    this.phase = 'created'
    this.recipe = null
    this.requestedCount = null
    this.completedCount = 0
    this.delta = null
    this.observedDelta = null
    this.attemptedLastClick = null
    this.pendingStats = null
    this.Item = require('prismarine-item')(bot.registry)
    this.onPacket = (packet, meta) => this.observe(packet, meta)
    this.onStats = packet => {
      if (!this.pendingStats) return
      const pending = this.pendingStats
      this.pendingStats = null
      pending.resolve(this.sequence)
    }
    this.onDisconnect = reason => {
      this.healthy = false
      if (this.pendingStats) {
        const pending = this.pendingStats
        this.pendingStats = null
        pending.reject(new Error(`connection closed: ${String(reason || '')}`))
      }
    }
  }

  attach() {
    this.client.on('packet', this.onPacket)
    this.client.on('statistics', this.onStats)
    this.client.on('end', this.onDisconnect)
    this.client.on('error', this.onDisconnect)
  }
  detach() {
    this.client.removeListener('packet', this.onPacket)
    this.client.removeListener('statistics', this.onStats)
    this.client.removeListener('end', this.onDisconnect)
    this.client.removeListener('error', this.onDisconnect)
    if (this.pendingStats) {
      clearTimeout(this.pendingStats.timer)
      this.pendingStats.reject(new Error('craft session ended'))
      this.pendingStats = null
    }
  }
  observe(packet, meta = {}) {
    this.sequence += 1
    const name = meta.name
    if (name === 'window_items') {
      this.stateIds.set(packet.windowId, packet.stateId)
      this.snapshots.push({ sequence: this.sequence, windowId: packet.windowId, packet })
      if (this.snapshots.length > MAX_SNAPSHOT_HISTORY) this.snapshots.shift()
    } else if (name === 'set_slot' && packet.windowId >= 0 && packet.windowId < 255) {
      this.stateIds.set(packet.windowId, packet.stateId)
    }
  }

  fence(window) {
    if (!this.healthy) return Promise.reject(new Error('connection is not healthy'))
    if (!sameWindow(this.bot, window)) return Promise.reject(new Error('crafting window changed'))
    const start = this.sequence
    const cursor = this.Item.toNotch(window.selectedItem)
    this.client.write('window_click', {
      windowId: window.id, stateId: -1, slot: -999, mouseButton: 2, mode: 5,
      changedSlots: [], cursorItem: cursor
    })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingStats === pending) this.pendingStats = null
        this.healthy = false // statistics has no request id; late response cannot be reused safely
        poisonedBots.add(this.bot)
        reject(new Error('statistics fence timed out'))
      }, this.timeoutMs)
      const pending = {
        resolve: fenceSequence => {
          clearTimeout(timer)
          if (!sameWindow(this.bot, window)) return reject(new Error('crafting window changed during fence'))
          const found = this.snapshots.filter(s => s.sequence > start && s.sequence < fenceSequence && s.windowId === window.id)
          const selected = found[found.length - 1]
          if (!selected) return reject(new Error(`no full inventory snapshot before fence for window ${window.id}`))
          resolve(selected)
        },
        reject: error => { clearTimeout(timer); reject(error) },
        timer
      }
      this.pendingStats = pending
      this.client.write('client_command', { actionId: 1 })
    })
  }

  async sync(window) {
    const snap = await this.fence(window)
    // The Mineflayer window listener processes window_items before statistics.
    // Verify its model agrees with the exact final packet selected above.
    const packet = snap.packet
    if (packet.items && window.slots) {
      const actual = window.slots.map(item => item && [item.type, item.count, item.metadata])
      const expected = packet.items.map(item => {
        const value = this.Item.fromNotch(item)
        return value && [value.type, value.count, value.metadata]
      })
      const actualCursor = window.selectedItem && [window.selectedItem.type, window.selectedItem.count, window.selectedItem.metadata]
      const notchCursor = packet.carriedItem && this.Item.fromNotch(packet.carriedItem)
      const expectedCursor = notchCursor && [notchCursor.type, notchCursor.count, notchCursor.metadata]
      if (JSON.stringify(actual) !== JSON.stringify(expected) || JSON.stringify(actualCursor) !== JSON.stringify(expectedCursor)) fail('client window does not match fenced server snapshot')
    }
    return snap
  }

  click(window, slot, button = 0) {
    const runClick = this.flight.then(async () => {
      if (!this.healthy || !sameWindow(this.bot, window)) fail('window changed before click')
      if (this.bot.interrupt_code && !this.recovering) fail('interrupted')
      const stateId = this.stateIds.get(window.id)
      if (stateId == null) fail(`no server stateId for window ${window.id}`)
      const changed = window.acceptClick({
        slot, mouseButton: button, mode: 0, id: stateId, windowId: window.id,
        item: slot < 0 ? null : window.slots[slot]
      })
      const changedSlots = changed.map(index => ({ location: index, item: this.Item.toNotch(window.slots[index]) }))
      const expected = new Map(changed.map(index => [index, window.slots[index] && [window.slots[index].type, window.slots[index].count, window.slots[index].metadata]]))
      const expectedCursor = window.selectedItem && [window.selectedItem.type, window.selectedItem.count, window.selectedItem.metadata]
      this.attemptedLastClick = { windowId: window.id, slot, button, stateId, phase: this.phase, sequenceBeforeSend: this.sequence }
      this.client.write('window_click', {
        windowId: window.id, stateId, slot, mouseButton: button, mode: 0,
        changedSlots, cursorItem: this.Item.toNotch(window.selectedItem)
      })
      await this.sync(window)
      const mismatch = [...expected].some(([index, value]) => JSON.stringify(window.slots[index] && [window.slots[index].type, window.slots[index].count, window.slots[index].metadata]) !== JSON.stringify(value))
      const actualCursor = window.selectedItem && [window.selectedItem.type, window.selectedItem.count, window.selectedItem.metadata]
      if (mismatch || JSON.stringify(actualCursor) !== JSON.stringify(expectedCursor)) fail(`server rejected click at slot ${slot}`)
      this.actions.push({ windowId: window.id, slot, button, stateId, sequence: this.sequence })
      if (this.actions.length > MAX_ACTION_HISTORY) this.actions.shift()
    })
    this.flight = runClick.catch(() => {})
    return runClick
  }

  async storeCursor(window) {
    let guard = 0
    while (window.selectedItem) {
      if (++guard > MAX_RECOVERY_STEPS) fail('cursor recovery made no bounded progress')
      const cursor = window.selectedItem
      const start = window.inventoryStart == null ? 9 : window.inventoryStart
      const end = window.inventoryEnd == null ? window.slots.length : window.inventoryEnd
      let target = -1
      for (let i = start; i < end; i++) {
        const item = window.slots[i]
        if (item && item.type === cursor.type && item.metadata === cursor.metadata && item.count < item.stackSize) { target = i; break }
      }
      if (target < 0) {
        for (let i = start; i < end; i++) if (!window.slots[i]) { target = i; break }
      }
      if (target < 0) fail('inventory has no room for cursor; refusing to drop item')
      await this.click(window, target, 0)
    }
  }

  canStore(window, item) {
    if (!item) return true
    const start = window.inventoryStart == null ? 9 : window.inventoryStart
    const end = window.inventoryEnd == null ? Math.min(45, window.slots.length) : window.inventoryEnd
    let space = 0
    for (let i = start; i < end; i++) {
      const slot = window.slots[i]
      if (!slot) space += item.stackSize || 64
      else if (slot.type === item.type && slot.metadata === item.metadata) space += Math.max(0, (slot.stackSize || 64) - slot.count)
    }
    return space >= item.count
  }

  async prepare() {
    const window = this.bot.currentWindow || this.bot.inventory
    if (window !== this.bot.inventory && (!window.type || !window.type.includes('crafting'))) {
      fail(`unexpected window type during craft preparation: ${window.type}`)
    }
    await this.recover(window)
    if (window !== this.bot.inventory) {
      await this.closeCraftingWindow(window, true)
    }
  }

  async recover(window = this.bot.currentWindow || this.bot.inventory) {
    this.phase = 'recover-inventory'
    await this.sync(window)
    this.recovering = true
    try {
    if (window.type && window.type.includes('crafting')) {
      await this.storeCursor(window)
      const start = 1
      const end = Math.min(window.inventoryStart == null ? 10 : window.inventoryStart, window.slots.length)
      for (let slot = start; slot < end; slot++) {
        while (window.slots[slot]) {
          await this.storeCursor(window)
          await this.click(window, slot, 0)
          if (window.selectedItem) await this.storeCursor(window)
        }
      }
    } else {
      await this.storeCursor(window)
      if (window === this.bot.inventory) {
        for (let slot = 1; slot < Math.min(5, window.slots.length); slot++) {
          while (window.slots[slot]) {
            await this.click(window, slot, 0)
            await this.storeCursor(window)
          }
        }
      }
    }
    } finally { this.recovering = false }
  }

  async craft(recipe, count, table) {
    if (!Number.isInteger(count) || count < 1) fail(`craft count must be a positive integer; got ${count}`)
    this.recipe = { resultId: recipe?.result?.id ?? null, resultCount: recipe?.result?.count ?? null }
    this.requestedCount = count
    this.completedCount = 0
    this.delta = (recipe.delta || []).map(item => ({ id: item.id, metadata: item.metadata, count: item.count }))
    this.phase = 'craft-start'
    let completed = 0
    while (completed < count) {
      if (this.bot.interrupt_code) break
      if (await this.executeRecipe(recipe, table)) completed += 1
      else break
      this.completedCount = completed
    }
    this.phase = 'craft-complete'
    return completed
  }

  report(error) {
    const window = this.bot.currentWindow || this.bot.inventory
    const itemSummary = item => item && ({ type: item.type, count: item.count, metadata: item.metadata })
    const inventoryWindow = window && window.type && window.type.includes('crafting')
      ? window
      : this.bot.inventory
    return {
      message: error.message,
      phase: this.phase,
      recipe: this.recipe,
      requestedCount: this.requestedCount,
      completedCount: this.completedCount,
      inputGrid: inventoryWindow && inventoryWindow.slots.slice(1, Math.min(inventoryWindow.type && inventoryWindow.type.includes('crafting') ? 10 : 5, inventoryWindow.slots.length)).map(itemSummary),
      cursor: itemSummary(window && window.selectedItem),
      delta: { expected: this.delta, observed: this.observedDelta },
      attemptedLastClick: this.attemptedLastClick,
      window: window && { id: window.id, type: window.type },
      recentActions: this.actions,
      recentSnapshots: this.snapshots.slice(-8).map(s => ({ sequence: s.sequence, windowId: s.windowId, stateId: s.packet.stateId }))
    }
  }

  itemCount(type, metadata, window = this.bot.inventory) {
    const start = window.inventoryStart == null ? 9 : window.inventoryStart
    const end = window.inventoryEnd == null ? Math.min(45, window.slots.length) : window.inventoryEnd
    return window.slots.slice(start, end).filter(item => item && item.type === type && (metadata == null || item.metadata === metadata)).reduce((n, item) => n + item.count, 0)
  }

  async executeRecipe(recipe, table) {
    const bot = this.bot
    this.observedDelta = null
    let window = bot.inventory
    let opened = false
    this.phase = table ? 'open-crafting-table' : 'open-inventory-grid'
    if (table) {
      if (typeof bot.activateBlock !== 'function') fail('activateBlock is unavailable')
      window = await this.openTable(table)
      opened = true
    } else if (bot.currentWindow && bot.currentWindow !== bot.inventory) {
      fail('unexpected non-inventory window is open')
    }
    try {
      if (!window || !sameWindow(bot, window)) fail('crafting window did not become active')
      await this.sync(window)
      this.phase = 'placing-input'
      const gridSlots = window.type && window.type.includes('crafting') ? 9 : 4
      const gridStart = 1
      const shape = recipe.inShape || []
      const baseline = new Map()
      for (const delta of recipe.delta || []) baseline.set(`${delta.id}:${delta.metadata ?? 0}`, this.itemCount(delta.id, delta.metadata, window))
      const ingredients = []
      if (shape.length) {
        for (let row = 0; row < shape.length; row++) for (let col = 0; col < (shape[row] || []).length; col++) {
          const ingredient = shape[row][col]
          if (ingredient) ingredients.push({ ingredient, target: gridStart + row * (gridSlots === 9 ? 3 : 2) + col })
        }
      } else {
        for (let i = 0; i < (recipe.ingredients || []).length; i++) ingredients.push({ ingredient: recipe.ingredients[i], target: gridStart + i })
      }
      for (const { ingredient, target } of ingredients) {
        const type = ingredient.id == null ? ingredient.type : ingredient.id
        if (type === -1) continue
        const metadata = ingredient.metadata
        const invStart = window.inventoryStart == null ? 9 : window.inventoryStart
        const invEnd = window.inventoryEnd == null ? Math.min(45, window.slots.length) : window.inventoryEnd
        const source = window.slots.findIndex((item, index) => index >= invStart && index < invEnd && item && item.type === type && (metadata == null || item.metadata === metadata))
        if (source < 0) { await this.returnGrid(window, gridStart, gridSlots); return false }
        await this.click(window, source, 1)
        await this.click(window, target, 1)
        await this.storeCursor(window)
      }
      const result = window.slots[0]
      this.phase = 'checking-server-result'
      if (!result || result.type !== recipe.result.id || result.count < recipe.result.count) {
        await this.returnGrid(window, gridStart, gridSlots)
        return false
      }
      if (!this.canStore(window, { ...result, count: recipe.result.count })) {
        await this.returnGrid(window, gridStart, gridSlots)
        fail('inventory has no room for recipe result; refusing to drop item')
      }
      await this.click(window, 0, 0)
      this.phase = 'taking-server-result'
      await this.storeCursor(window)
      // The result has left the server-owned result slot and is in a fenced
      // player inventory slot. Preserve this item-level fact even if later
      // ingredient cleanup or recipe-delta validation fails. This does not
      // certify a completed recipe; that requires the exact delta below.
      recordConfirmation({ phase: 'taking-server-result', quantity: recipe.result.count, unit: 'item', target: { itemId: recipe.result.id },
        evidence: 'server result slot click and fenced cursor placement in player inventory' })
      this.phase = 'recovering-grid'
      await this.returnGrid(window, gridStart, gridSlots)
      this.phase = 'validating-inventory-delta'
      this.observedDelta = []
      for (const delta of recipe.delta || []) {
        const key = `${delta.id}:${delta.metadata ?? 0}`
        const before = baseline.get(key) ?? 0
        const after = this.itemCount(delta.id, delta.metadata, window)
        const observed = after - before
        this.observedDelta.push({ id: delta.id, metadata: delta.metadata, before, after, expected: delta.count, observed })
        if (observed !== delta.count) fail(`inventory delta mismatch for item ${delta.id}: expected ${delta.count}, observed ${observed}`)
      }
      recordConfirmation({ phase: 'validating-recipe-delta', quantity: 1, unit: 'recipe', target: this.recipe,
        evidence: 'server result slot and exact fenced recipe inventory delta' })
      return true
    } finally {
      if (opened && sameWindow(bot, window)) await this.closeCraftingWindow(window)
    }
  }

  async closeCraftingWindow(window, recovered = false) {
    if (!window.type || !window.type.includes('crafting')) fail(`refusing to close unexpected window type: ${window.type}`)
    if (!recovered) await this.recover(window)
    await this.bot.closeWindow(window)
    if (this.bot.currentWindow && this.bot.currentWindow !== this.bot.inventory) fail('crafting window did not close')
    this.phase = 'verify-inventory-after-close'
    await this.sync(this.bot.inventory)
  }

  openTable(table) {
    const bot = this.bot
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        bot.removeListener('windowOpen', onOpen)
        bot.removeListener('end', onDisconnect)
        bot.removeListener('error', onDisconnect)
        this.client.removeListener('end', onDisconnect)
        this.client.removeListener('error', onDisconnect)
      }
      const finish = (error, window) => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(error)
        else if (!window.type || !window.type.includes('crafting')) reject(new Error(`unexpected crafting window type: ${window.type}`))
        else resolve(window)
      }
      const onOpen = window => {
        finish(null, window)
      }
      const onDisconnect = reason => finish(new Error(`connection closed while opening crafting table: ${String(reason || '')}`))
      const timer = setTimeout(() => {
        poisonedBots.add(bot)
        finish(new Error('crafting window open timed out'))
      }, this.timeoutMs)
      bot.once('windowOpen', onOpen)
      bot.once('end', onDisconnect)
      bot.once('error', onDisconnect)
      this.client.once('end', onDisconnect)
      this.client.once('error', onDisconnect)
      try {
        const activation = bot.activateBlock(table)
        if (activation && typeof activation.then === 'function') activation.catch(error => finish(error))
      } catch (error) {
        finish(error)
      }
    })
  }

  async returnGrid(window, start, count) {
    this.phase = 'recovering-grid'
    for (let slot = start; slot < start + count; slot++) {
      while (window.slots[slot]) {
        await this.storeCursor(window)
        await this.click(window, slot, 0)
        if (window.selectedItem) await this.storeCursor(window)
      }
    }
  }
}

export default { run, snapshotWindow, snapshotInventory }
