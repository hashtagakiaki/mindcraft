'use strict'

// Offline regression fixture for furnace actions. Mineflayer's real inventory
// and furnace plugins are used with an in-memory protocol peer; no server is
// started and the shared upstream dependency tree is only read.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { mkdtemp, readFile, rm, symlink, mkdir, writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')
const { moduleRoot } = require('./dependency_root.cjs')

const root = path.resolve(__dirname, '..')
const sharedNodeModules = moduleRoot()
const depRequire = createRequire(path.join(sharedNodeModules, 'package.json'))
const inventoryPlugin = depRequire('mineflayer/lib/plugins/inventory')
const furnacePlugin = depRequire('mineflayer/lib/plugins/furnace')
const minecraftData = depRequire('minecraft-data')('1.21.1')
const Vec3 = depRequire('vec3').Vec3
const Item = depRequire('prismarine-item')(minecraftData)
const tempDirs = new Set()
const fixtureBots = new Set()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function loadRuntime() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mc-furnace-'))
  tempDirs.add(dir)
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}')
  await symlink(sharedNodeModules, path.join(dir, 'node_modules'))
  await mkdir(path.join(dir, 'src/agent/library'), { recursive: true })
  await mkdir(path.join(dir, 'src/agent'), { recursive: true })
  await mkdir(path.join(dir, 'src/utils'), { recursive: true })
  const copies = [
    ['src/agent/library/skills.js', 'src/agent/library/skills.js'],
    ['src/agent/library/operation_context.js', 'src/agent/library/operation_context.js'],
    ['src/agent/library/world.js', 'src/agent/library/world.js'],
    ['src/agent/library/crafting_sync.js', 'src/agent/library/crafting_sync.js'],
    ['src/agent/library/mining_sync.js', 'src/agent/library/mining_sync.js'],
    ['src/agent/action_manager.js', 'src/agent/action_manager.js'],
    ['src/agent/settings.js', 'src/agent/settings.js'],
    ['src/utils/mcdata.js', 'src/utils/mcdata.js'],
    ['src/utils/partial_read_capture.js', 'src/utils/partial_read_capture.js'],
    ['src/utils/minecraft_protocol_overrides.js', 'src/utils/minecraft_protocol_overrides.js'],
    ['settings.js', 'settings.js']
  ]
  for (const [source, target] of copies) {
    const destination = path.join(dir, target)
    await mkdir(path.dirname(destination), { recursive: true })
    let contents = await readFile(path.join(root, source), 'utf8')
    if (source === 'settings.js') contents = contents.replace('"minecraft_version": "auto"', '"minecraft_version": "1.21.1"')
    if (source === 'src/agent/settings.js') contents = "export default { minecraft_version: '1.21.1' };\n"
    if (source === 'src/utils/mcdata.js') {
      const anchor = 'let Item = null;'
      assert.ok(contents.includes(anchor), 'mcdata module initialization anchor')
      // A real login normally initializes these read-only registries. The
      // offline fixture initializes them directly so no createBot/network call
      // is needed; all behavior under test remains the unmodified source.
      contents = contents.replace(anchor, `${anchor}\nmcdata = minecraftData(mc_version);\nItem = prismarine_items(mc_version);`)
    }
    await writeFile(destination, contents)
  }
  const skills = await import(pathToFileURL(path.join(dir, 'src/agent/library/skills.js')))
  const { default: craftingSync } = await import(pathToFileURL(path.join(dir, 'src/agent/library/crafting_sync.js')))
  const { ActionManager } = await import(pathToFileURL(path.join(dir, 'src/agent/action_manager.js')))
  const { createOperationContext, operationResult, runOwnedOperation } = await import(pathToFileURL(path.join(dir, 'src/agent/library/operation_context.js')))
  return { dir, skills, craftingSync, ActionManager, createOperationContext, operationResult, runOwnedOperation }
}

function notch(item) { return item ? Item.toNotch(new Item(item.id, item.count)) : { present: false } }

function makeBot({ ore = 3, coal = 2, furnaceSeed = {}, autoSmelt = true, smeltDelayMs = 0, fullSnapshots = true, lateClickItem = false, partialSmeltCount = null, throwTransfer = false, closeError = false, suppressFurnaceFenceSnapshot = false } = {}) {
  const bot = new EventEmitter()
  fixtureBots.add(bot)
  const client = new EventEmitter()
  client.writes = []
  bot._client = client
  bot.version = '1.21.1'
  bot.registry = minecraftData
  bot.quickBarSlot = null
  bot.QUICK_BAR_START = 36
  bot.lastDigTime = null
  bot.entity = { position: new Vec3(0, 64, 0) }
  bot.interrupt_code = false
  bot.inventoryUnconfirmed = false
  bot.output = ''
  bot.currentWindow = null
  bot.supportFeature = name => name === 'stateIdUsed'
  bot.swingArm = () => {}
  bot.lookAt = async () => {}
  bot.modes = { pause() {}, unpause() { bot.unpauseCount = (bot.unpauseCount || 0) + 1 } }
  bot._client.writes = client.writes
  inventoryPlugin(bot, { hideErrors: true })
  furnacePlugin(bot)

  const oreId = minecraftData.itemsByName.raw_iron.id
  const coalId = minecraftData.itemsByName.coal.id
  const ingotId = minecraftData.itemsByName.iron_ingot.id
  const serverInventory = Array(46).fill(null)
  serverInventory[9] = { id: oreId, count: ore }
  serverInventory[10] = { id: coalId, count: coal }
  if (lateClickItem) serverInventory[42] = { id: coalId, count: 1 }
  const serverFurnace = [furnaceSeed.input || null, furnaceSeed.fuel || null, furnaceSeed.output || null]
  let currentFurnace = null
  let windowId = 20
  let statsSequence = 0
  const writesBefore = name => client.writes.filter(write => write.name === name)

  function packetItems(windowId) {
    const source = windowId === 0 ? serverInventory : serverFurnace.concat(serverInventory.slice(9))
    return source.map(value => notch(value))
  }
  function fullSnapshot(windowId) {
    if (!fullSnapshots) return
    const items = packetItems(windowId)
    const packet = { windowId, stateId: ++statsSequence, items, carriedItem: { present: false } }
    client.emit('packet', packet, { name: 'window_items' })
    client.emit('window_items', packet)
  }
  function openForeignWindow() {
    const id = 90
    const opened = new Promise(resolve => bot.once('windowOpen', resolve))
    const packet = { windowId: id, stateId: ++statsSequence, items: Array.from({ length: 63 }, () => ({ present: false })), carriedItem: { present: false } }
    client.emit('packet', packet, { name: 'window_items' })
    client.emit('window_items', packet)
    client.emit('open_window', {
      windowId: id, inventoryType: 'minecraft:generic_9x3',
      windowTitle: JSON.stringify({ text: 'Other window' }), slotCount: 27
    })
    return opened
  }
  function setServerSlot(windowId, slot, value) {
    if (windowId === 0) serverInventory[slot] = value
    else if (slot < 3) serverFurnace[slot] = value
    else serverInventory[slot] = value
    const packet = {
      windowId, stateId: ++statsSequence, slot,
      item: notch(value)
    }
    client.emit('packet', packet, { name: 'set_slot' })
    client.emit('set_slot', packet)
  }
  function sendStatistics() {
    setImmediate(() => {
      const packet = { entries: [] }
      client.emit('packet', packet, { name: 'statistics' })
      client.emit('statistics', packet)
    })
  }
  client.write = (name, packet) => {
    client.writes.push({ name, packet })
    if (name === 'window_click' && packet.slot === -999 && packet.mode === 5) {
      if (fullSnapshots && !(suppressFurnaceFenceSnapshot && packet.windowId !== 0)) setImmediate(() => fullSnapshot(packet.windowId))
    }
    if (name === 'client_command') sendStatistics()
    if (name === 'close_window' && currentFurnace?.id === packet.windowId) {
      currentFurnace.emit('close')
      currentFurnace = null
    }
  }
  bot.openBlock = async block => {
    const id = windowId++
    const opened = new Promise(resolve => bot.once('windowOpen', resolve))
    fullSnapshot(id) // Mineflayer buffers window_items until open_window arrives.
    client.emit('open_window', {
      windowId: id, inventoryType: 'minecraft:furnace',
      windowTitle: JSON.stringify({ text: 'Furnace' }), slotCount: 3
    })
    currentFurnace = await opened
    return currentFurnace
  }
  bot.findBlocks = ({ matching }) => (Array.isArray(matching) ? matching.includes(minecraftData.blocksByName.furnace.id) : matching(minecraftData.blocksByName.furnace.id)) ? [new Vec3(1, 64, 0)] : []
  bot.blockAt = position => ({ name: 'furnace', position, diggable: true, drops: [minecraftData.itemsByName.furnace.id] })
  bot.getBlock = bot.blockAt
  bot.transfer = async ({ window, itemType, count, destStart }) => {
    if (throwTransfer) throw new Error('fixture transfer exception')
    const sourceSlot = serverInventory.findIndex((entry, slot) => slot >= 9 && entry?.id === itemType && entry.count >= count)
    if (sourceSlot < 0) throw new Error('fixture transfer source missing')
    const source = serverInventory[sourceSlot]
    setServerSlot(0, sourceSlot, source.count === count ? null : { ...source, count: source.count - count })
    const targetSlot = destStart
    setServerSlot(window.id, targetSlot, { id: itemType, count })
    if (autoSmelt && targetSlot === 0) {
      const publishOutput = () => {
        setServerSlot(window.id, 2, { id: ingotId, count: partialSmeltCount ?? count })
        setServerSlot(window.id, 0, null)
        fullSnapshot(window.id)
      }
      if (smeltDelayMs > 0) setTimeout(publishOutput, smeltDelayMs)
      else publishOutput()
    }
    if (autoSmelt && targetSlot === 1 && serverFurnace[0]) {
      const publishOutput = () => {
        setServerSlot(window.id, 2, { id: ingotId, count: partialSmeltCount ?? serverFurnace[0].count })
        setServerSlot(window.id, 0, null)
        fullSnapshot(window.id)
      }
      if (smeltDelayMs > 0) setTimeout(publishOutput, smeltDelayMs)
      else publishOutput()
    }
    fullSnapshot(window.id)
  }
  bot.putAway = async slot => {
    const value = slot < 3 ? serverFurnace[slot] : serverInventory[slot - 3 + 9]
    if (!value) throw new Error(`fixture putAway empty slot ${slot}`)
    let target = serverInventory.findIndex((entry, index) => index >= 9 && entry?.id === value.id)
    if (target < 0) target = serverInventory.findIndex((entry, index) => index >= 9 && !entry)
    if (target < 0) throw new Error('fixture player inventory full')
    const existing = serverInventory[target]
    serverInventory[target] = { id: value.id, count: (existing?.count || 0) + value.count }
    setServerSlot(currentFurnace.id, slot, null)
    setServerSlot(0, target, serverInventory[target])
    fullSnapshot(currentFurnace.id)
  }
  if (closeError) {
    const closeWindow = bot.closeWindow
    bot.closeWindow = async window => {
      if (window === currentFurnace) throw new Error('fixture close exception')
      return closeWindow(window)
    }
  }
  bot.inventory.items = function () { return this.slots.filter(Boolean) }
  bot.inventory.items = bot.inventory.items.bind(bot.inventory)
  // Open and initial inventory snapshots use the same real Mineflayer packet handlers.
  fullSnapshot(0)
  bot._fixture = { serverInventory, serverFurnace, writesBefore, fullSnapshot, openWindow: () => bot.openBlock({ position: new Vec3(1, 64, 0) }), openForeignWindow, get currentFurnace() { return currentFurnace }, oreId, coalId, ingotId }
  return bot
}

function cancellationContext() {
  const controller = new AbortController()
  let phase = ''
  return {
    controller,
    context: { signal: controller.signal, setPhase(value) { phase = value }, get phase() { return phase } }
  }
}

async function main() {
  const { skills, craftingSync, ActionManager, createOperationContext, operationResult, runOwnedOperation } = await loadRuntime()
  const cases = {}
  const successful = makeBot()
  assert.equal(await skills.smeltItem(successful, 'raw_iron', 2), true, `successful smelt fixture: ${successful.output}`)
  assert.equal(successful.inventoryUnconfirmed, false)
  assert.equal(successful._fixture.writesBefore('close_window').length, 1)
  assert.equal(await skills.clearNearestFurnace(successful), true, 'clear should preserve its boolean success contract')
  cases.success = { smelt: true, clear: true, closedOwnedWindow: true, inventoryConfirmed: true }

  const delayedOutput = makeBot({ ore: 1, coal: 1, smeltDelayMs: 350 })
  const waitOperation = createOperationContext({ id: 'delayed-smelt', controller: new AbortController() }, { bot: delayedOutput }, { intentEpoch: 1 }, 'smelt-task')
  assert.equal(await runOwnedOperation(waitOperation, () => skills.smeltItem(delayedOutput, 'raw_iron', 1)), true,
    'output arriving after several poll intervals remains a valid bounded wait')
  const smeltWait = operationResult(waitOperation).skillResults[0].waits[0]
  assert.equal(smeltWait.callId, operationResult(waitOperation).skillResults[0].id)
  assert.equal(smeltWait.phase, 'waiting-for-smelting')
  assert.equal(smeltWait.reason, 'furnace-output-or-quiet-timeout')
  assert.equal(smeltWait.timeoutMs, 11_000)
  assert.equal(smeltWait.deadlineKind, 'quiet-period-reset-on-output')
  assert.equal(smeltWait.outcome, 'requested-output-observed')
  cases.delayedOutput = { waitPhaseAndCallIdRecorded: true, quietTimeoutMs: 11000, outputAfterPolls: true }

  const silentFurnace = makeBot({ ore: 1, coal: 1, autoSmelt: false })
  const quietOperation = createOperationContext({ id: 'silent-smelt', controller: new AbortController() }, { bot: silentFurnace }, { intentEpoch: 1 }, 'smelt-task')
  assert.equal(await runOwnedOperation(quietOperation, () => skills.smeltItem(silentFurnace, 'raw_iron', 1)), false,
    'silence remains bounded by the existing quiet timeout')
  const quietWait = operationResult(quietOperation).skillResults[0].waits[0]
  assert.equal(quietWait.timeoutMs, 11_000)
  assert.equal(quietWait.outcome, 'quiet-timeout')
  cases.silentOutput = { success: false, quietTimeoutMs: 11000, noInfiniteWait: true }

  const short = makeBot({ ore: 2, coal: 0 })
  const shortContext = cancellationContext()
  short.getActionCancellationContext = () => shortContext.context
  const shortResult = await skills.smeltItem(short, 'raw_iron', 2)
  assert.equal(shortResult, false, 'insufficient fuel cannot be reported as success')
  assert.equal(short._fixture.writesBefore('window_click').filter(({ packet }) => packet.windowId !== 0 && packet.slot >= 0).length, 0, 'shortage must not transfer input/fuel')
  cases.shortage = { success: false, noFurnaceTransfer: true }

  const partial = makeBot({ partialSmeltCount: 1 })
  let partialTransferCalls = 0
  const transferPartial = partial.transfer
  partial.transfer = async options => { partialTransferCalls++; return transferPartial(options) }
  assert.equal(await skills.smeltItem(partial, 'raw_iron', 2), false, 'partial result must not be returned as success')
  assert.equal(partialTransferCalls, 2, 'partial output must not trigger automatic retry')
  assert.equal(partial._fixture.writesBefore('close_window').length, 1)
  assert.match(partial.output, /Only smelted 1 .*no retry was started/)
  cases.partialOutput = { success: false, noAutomaticRetry: true, ownedWindowClosed: true }

  const exception = makeBot({ throwTransfer: true })
  await assert.rejects(skills.smeltItem(exception, 'raw_iron', 2), /fixture transfer exception/)
  assert.equal(exception._fixture.writesBefore('close_window').length, 1)
  assert.equal(exception.inventoryUnconfirmed, false, 'full furnace and player snapshots confirm that no transfer occurred')
  cases.transferException = { propagated: true, ownedWindowClosed: true, stateConfirmed: true }

  const aborted = makeBot()
  const abortContext = cancellationContext()
  aborted.getActionCancellationContext = () => abortContext.context
  let abortOnFurnaceOpen = true
  const originalOpenBlock = aborted.openBlock
  aborted.openBlock = async block => {
    const window = await originalOpenBlock(block)
    if (abortOnFurnaceOpen) {
      abortOnFurnaceOpen = false
      abortContext.controller.abort('fixture stop')
      await aborted._fixture.openForeignWindow()
    }
    return window
  }
  const abortedResult = await skills.smeltItem(aborted, 'raw_iron', 2)
  assert.equal(abortedResult, false)
  assert.equal(aborted._fixture.writesBefore('close_window').filter(({ packet }) => packet.windowId === 90).length, 0, 'cleanup must not close a foreign window opened after furnace ownership changed')
  assert.equal(aborted.currentWindow.id, 90)
  assert.equal(aborted.inventoryUnconfirmed, true, 'foreign active window prevents player inventory fence and retains action gate')
  assert.equal(aborted._fixture.writesBefore('window_click').filter(({ packet }) => packet.windowId === 20 && packet.slot >= 0).length, 0, 'abort after opening must not transfer input or fuel')
  cases.foreignWindowOwnership = { foreignWindowLeftOpen: true, foreignClosePacket: false, unconfirmedInventoryGate: true }

  const confirmedAbort = makeBot()
  const confirmedAbortContext = cancellationContext()
  confirmedAbort.getActionCancellationContext = () => confirmedAbortContext.context
  const confirmedOpenBlock = confirmedAbort.openBlock
  confirmedAbort.openBlock = async block => {
    const window = await confirmedOpenBlock(block)
    confirmedAbortContext.controller.abort('fixture stop with owned window')
    return window
  }
  assert.equal(await skills.smeltItem(confirmedAbort, 'raw_iron', 1), false)
  assert.equal(confirmedAbort._fixture.writesBefore('close_window').length, 1)
  assert.equal(confirmedAbort.inventoryUnconfirmed, false, 'both read-only shutdown fences confirm a safe new action')
  const afterStopManager = new ActionManager({
    bot: confirmedAbort,
    self_prompter: { isActive: () => false },
    isIdle: () => true,
    clearBotLogs() { confirmedAbort.output = '' }
  })
  afterStopManager.beginUserIntent()
  assert.equal((await afterStopManager.runAction('new-explicit-intent-after-confirmed-stop', async () => {}, { timeout: 0 })).success, true)
  assert.equal(confirmedAbort.inventoryUnconfirmed, false)
  cases.cancelAfterOpen = { success: false, ownedWindowClosed: true, noInputOrFuelClicks: true }
  cases.confirmedCancelResume = { bothShutdownSnapshotsConfirmed: true, newExplicitIntentCanRun: true }
  cases.foreignWindowOwnership = { foreignWindowLeftOpen: true, foreignClosePacket: false, unconfirmedInventoryGate: true }

  const delayed = makeBot()
  const delayedContext = cancellationContext()
  delayed.getActionCancellationContext = () => delayedContext.context
  const releaseOpen = deferred()
  const openBlock = delayed.openBlock
  delayed.openBlock = async block => { await releaseOpen.promise; return openBlock(block) }
  let delayedSettled = false
  const delayedAction = skills.smeltItem(delayed, 'raw_iron', 1).finally(() => { delayedSettled = true })
  await waitUntil(() => delayedContext.context.phase === 'opening-furnace', 3000, 'smelt action did not reach opening-furnace')
  delayedContext.controller.abort('cancel delayed window open')
  await delay(25)
  assert.equal(delayedSettled, false, 'unresolved openFurnace wait cannot be abandoned with a race')
  assert.equal(delayed._fixture.writesBefore('close_window').length, 0)
  releaseOpen.resolve()
  assert.equal(await delayedAction, false)
  assert.equal(delayed._fixture.writesBefore('close_window').length, 1, 'late-opened owned window must close after waiter settles')
  assert.equal(delayed._fixture.writesBefore('window_click').filter(({ packet }) => packet.windowId === 20 && packet.slot >= 0).length, 0)
  cases.delayedOpenAbort = { pendingUntilOpenSettles: true, lateOwnedWindowClosed: true, postAbortTransfer: false }

  const context = cancellationContext()
  const recovered = makeBot()
  recovered.getActionCancellationContext = () => context.context
  context.controller.abort('already cancelled')
  const cancelledBeforeOpen = await skills.clearNearestFurnace(recovered)
  assert.equal(cancelledBeforeOpen, false)
  assert.equal(recovered._fixture.writesBefore('close_window').length, 0)
  cases.clearCancelledBeforeOpen = { success: false, leftUnownedWindowsAlone: true }

  // Keep actual plugin click prediction in play during an owned action: the
  // guarded click waits in Mineflayer's dig throttle, cancellation occurs
  // before its packet write, then the furnace snapshot guard restores state.
  const late = makeBot({ lateClickItem: true })
  const lateContext = cancellationContext()
  late.getActionCancellationContext = () => lateContext.context
  const preTransfer = late.transfer
  let lateClickOutcome
  late.transfer = async options => {
    const owned = options.window
    const authoritativeSlot = owned.slots[36] && { type: owned.slots[36].type, count: owned.slots[36].count }
    late.lastDigTime = Date.now()
    const click = late.clickWindow(36, 0, 0).then(() => 'sent', error => error.message)
    setTimeout(() => lateContext.controller.abort('late click fixture'), 20)
    lateClickOutcome = await click
    assert.deepEqual(owned.slots[36] && { type: owned.slots[36].type, count: owned.slots[36].count }, authoritativeSlot, 'cancelled Mineflayer optimistic prediction must roll back')
    throw new Error(lateClickOutcome)
  }
  const beforeLateClick = late._fixture.writesBefore('window_click').filter(({ packet }) => packet.windowId === 20 && packet.slot >= 0).length
  assert.equal(await skills.smeltItem(late, 'raw_iron', 1), false, 'late guarded click cancellation cannot succeed')
  late.transfer = preTransfer
  assert.equal(lateClickOutcome, 'furnace action cancelled before click packet was sent')
  assert.equal(late._fixture.writesBefore('window_click').filter(({ packet }) => packet.windowId === 20 && packet.slot >= 0).length, beforeLateClick)
  assert.equal(late._fixture.writesBefore('close_window').length, 1)
  const skillSource = await readFile(path.join(root, 'src/agent/library/skills.js'), 'utf8')
  assert.match(skillSource, /getActionCancellationContext/, 'generated and NPC bot-only calls inherit cancellation context')
  cases.lateClick = { mineflayerOptimisticPredictionRolledBack: true, latePacketSuppressed: true, ownedWindowClosed: true }

  // Inventory-only confirmation clears an existing uncertainty only when it
  // has the full window_items + statistics fence. Missing snapshots stay gated.
  const confirmed = makeBot()
  confirmed.inventoryUnconfirmed = true
  await craftingSync.snapshotInventory(confirmed)
  assert.equal(confirmed.inventoryUnconfirmed, false)
  const unknown = makeBot({ fullSnapshots: false })
  unknown.inventoryUnconfirmed = false
  await assert.rejects(craftingSync.snapshotInventory(unknown, { timeoutMs: 20 }), /snapshot/)
  assert.equal(unknown.inventoryUnconfirmed, true)
  cases.inventoryFence = { fullInventoryImageClearsUnconfirmed: true, missingSnapshotMarksUnconfirmed: true }

  const closeFailure = makeBot({ closeError: true })
  await assert.rejects(skills.smeltItem(closeFailure, 'raw_iron', 1), /fixture close exception/)
  assert.equal(closeFailure.unpauseCount, 1, 'mode cleanup runs even when owned-window close fails')
  assert.equal(closeFailure.inventoryUnconfirmed, true, 'open/ambiguous furnace after close failure gates later actions')
  cases.closeFailure = { propagated: true, inventoryUnconfirmed: true, modesUnpaused: true }

  const unknownFurnace = makeBot({ suppressFurnaceFenceSnapshot: true })
  await assert.rejects(skills.smeltItem(unknownFurnace, 'raw_iron', 1), /no full inventory snapshot/, 'furnace state without a full snapshot is not successful')
  assert.equal(unknownFurnace._fixture.writesBefore('close_window').length, 1)
  assert.equal(unknownFurnace.inventoryUnconfirmed, true, 'inventory snapshot cannot erase an unknown furnace transaction')
  const unknownManager = new ActionManager({ bot: unknownFurnace, self_prompter: { isActive: () => false }, isIdle: () => true })
  assert.equal((await unknownManager.runAction('blocked-after-unknown-furnace', async () => {}, { timeout: 0 })).reason, 'inventory-unconfirmed')
  cases.unknownFurnaceSnapshot = { success: false, closedOwnedWindow: true, inventoryUnconfirmed: true, nextActionBlocked: true }

  const managerBot = { inventoryUnconfirmed: true, output: '', interrupt_code: false, emit() {} }
  const manager = new ActionManager({ bot: managerBot, self_prompter: { isActive: () => false }, isIdle: () => true })
  let nextActionRan = false
  assert.equal((await manager.runAction('inventory-unknown', async () => { nextActionRan = true }, { timeout: 0 })).reason, 'inventory-unconfirmed')
  assert.equal((await manager.runAction('resume-inventory-unknown', async () => { nextActionRan = true }, { timeout: 0, resume: true })).reason, 'inventory-unconfirmed')
  assert.equal((await manager.resumeAction('direct-resume-inventory-unknown', async () => { nextActionRan = true })).reason, 'inventory-unconfirmed')
  assert.equal(nextActionRan, false)
  cases.managerAdmission = { nextActionRejected: true, resumeRejected: true }

  // Same connection remains usable for smelt -> inventory read -> the actual
  // crafting_sync.run prepare/admission contract, with no process restart.
  const chain = makeBot()
  assert.equal(await skills.smeltItem(chain, 'raw_iron', 1), true)
  const ingotCount = chain.inventory.items().filter(item => item.name === 'iron_ingot').reduce((sum, item) => sum + item.count, 0)
  assert.equal(ingotCount, 1)
  await craftingSync.snapshotInventory(chain)
  let craftCallbackReceived = false
  const craftAdmission = await craftingSync.run(chain, async craft => {
    craftCallbackReceived = typeof craft === 'function'
    return 'craft-sync-admitted'
  }, { timeoutMs: 100 })
  assert.equal(craftAdmission, 'craft-sync-admitted')
  assert.equal(craftCallbackReceived, true)
  cases.sameConnectionSequence = { smelt: true, inventoryReadAfterSmelt: true, craftingSyncRunPrepareAndAdmission: true, pidRestart: false }

  assert.match(await readFile(path.join(root, 'src/agent/commands/actions.js'), 'utf8'), /name: '!smeltItem'[\s\S]*?getActionCancellationContext/)
  assert.match(await readFile(path.join(root, 'src/agent/commands/actions.js'), 'utf8'), /name: '!clearFurnace'[\s\S]*?getActionCancellationContext/)
  const commandSource = await readFile(path.join(root, 'src/agent/commands/actions.js'), 'utf8')
  const smeltCommand = commandSource.match(/name: '!smeltItem',[\s\S]*?\n    },/)
  assert.ok(smeltCommand)
  assert.doesNotMatch(smeltCommand[0], /restart|reconnect|process\.exit/i, 'smelt command stays in the current bot process')
  console.log(JSON.stringify({ fixture: 'furnace lifecycle', liveCalls: 0, cases }, null, 2))
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await delay(Math.min(10, deadline - Date.now()))
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  for (const bot of fixtureBots) {
    bot._fixture?.currentFurnace?.removeAllListeners()
    bot.inventory?.removeAllListeners()
    bot.removeAllListeners()
    bot._client?.removeAllListeners()
  }
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })
})
