'use strict'

// Focused offline checks for chest targeting and quantities. Server-fenced
// transfer behavior is also covered by interaction_confirmation.test.cjs.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { mkdtemp, mkdir, readFile, rm, symlink, writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')
const { moduleRoot } = require('./dependency_root.cjs')
const repo = path.resolve(__dirname, '..')
const dependencies = moduleRoot()
const requireDependency = createRequire(path.join(dependencies, 'package.json'))
const registry = requireDependency('minecraft-data')('1.21.1')
const Vec3 = requireDependency('vec3').Vec3

async function write(root, relative, contents) {
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, contents)
}

async function setup(root) {
  await write(root, 'package.json', '{"type":"module"}')
  await symlink(dependencies, path.join(root, 'node_modules'))
  await write(root, 'settings.js', 'export default { block_place_delay: 0 };')
  await write(root, 'src/agent/settings.js', 'export default { allow_insecure_coding: false, generated_code_fail_on_false: [], code_timeout_mins: 1 };')
  await write(root, 'src/agent/mindserver_proxy.js', 'export function sendOutputToServer() {}')
  await write(root, 'src/agent/conversation.js', 'export default {};')
  await write(root, 'src/agent/tasks/construction_tasks.js', "export function checkLevelBlueprint() { return ''; } export function checkBlueprint() { return ''; }")
  await write(root, 'src/utils/math.js', 'export function cosineSimilarity() { return 0; }')
  await write(root, 'src/utils/mcdata.js', `
import { createRequire } from 'node:module';
const registry = createRequire(import.meta.url)('minecraft-data')('1.21.1');
export function getBlockId(name) { return registry.blocksByName[name]?.id ?? null; }
export function getItemId(name) { return registry.itemsByName[name]?.id ?? null; }
export function mustCollectManually() { return false; }
`)
  for (const relative of ['src/agent/library/skills.js', 'src/agent/library/block_placement.js',
    'src/agent/library/crafting_sync.js', 'src/agent/library/mining_sync.js', 'src/agent/library/operation_context.js',
    'src/agent/library/world.js', 'src/agent/library/index.js', 'src/agent/library/skill_library.js',
    'src/agent/library/sdk_capabilities.js', 'src/agent/library/lockdown.js', 'src/agent/commands/actions.js',
    'src/agent/commands/queries.js', 'src/agent/commands/index.js', 'src/agent/coder.js',
    'src/agent/action_manager.js', 'bots/execTemplate.js', 'bots/lintTemplate.js', 'eslint.config.js']) {
    await write(root, relative, await readFile(path.join(repo, relative)))
  }
}

function makeBot({ inventoryCounts = [4], chestCounts = [3] } = {}) {
  const bot = new EventEmitter()
  const state = { opened: [], closed: [], approached: [], depositCalls: [], withdrawCalls: [], invisible: false, missing: new Set() }
  const chestPositions = [{ x: 2, y: 64, z: 0 }, { x: 8, y: 64, z: 0 }]
  const key = p => `${p.x},${p.y},${p.z}`
  const makeChest = position => ({ name: 'chest', type: registry.blocksByName.chest.id,
    position: new Vec3(position.x, position.y, position.z), stateId: 22,
    getProperties: () => ({ facing: 'north', type: 'single' }) })
  const chestBlocks = chestPositions.map(makeChest)
  const itemType = registry.itemsByName.oak_log.id
  const inventory = { slots: [], items: () => inventory.slots,
    findInventoryItem: name => inventory.slots.find(item => item?.name === name) || null }
  inventoryCounts.forEach((count, index) => { inventory.slots[index] = { name: 'oak_log', type: itemType, count } })
  bot.state = state; bot.registry = registry; bot.version = '1.21.1'
  bot.username = 'chestFixture'; bot.output = ''; bot.interrupt_code = false
  bot.game = { dimension: 'overworld', gameMode: 'survival' }
  bot.entity = { position: new Vec3(0.5, 64, 0.5), height: 1.8 }
  bot.modes = { isOn: () => false, pause() {}, unpause() {}, flushBehaviorLog: () => '' }
  bot.chat = () => {}
  bot.inventory = inventory
  bot.getControlState = () => false
  bot.findBlocks = ({ matching }) => chestBlocks.filter(block => matching.includes(block.type)).map(block => block.position)
  bot.blockAt = position => {
    const p = position.floored()
    if (state.missing.has(key(p))) return null
    return chestBlocks.find(block => key(block.position) === key(p)) || { name: 'stone', type: 1, position: p, getProperties: () => ({}) }
  }
  bot.canSeeBlock = () => !state.invisible
  bot.canDigBlock = () => !state.invisible
  bot.world = { getBlock: p => bot.blockAt(p), raycast: () => null }
  bot.pathfinder = { movements: { original: true }, setMovements(m) { this.movements = m },
    getPathTo: () => ({ status: 'success' }), async goto(goal) {
      state.approached.push(key(goal.blockPosition || goal.position || chestPositions[1]))
      bot.entity.position = new Vec3(7.5, 64, 0.5)
      state.invisible = false
    }, stop() {}, setGoal() {} }
  bot.openContainer = async target => {
    const targetKey = key(target.position)
    state.opened.push(targetKey)
    const slots = new Array(41).fill(null)
    if (targetKey !== '2,64,0') chestCounts.forEach((count, index) => { slots[index] = { name: 'oak_log', type: itemType, count } })
    inventory.slots.forEach((item, index) => { slots[27 + index] = item || null })
    const window = { inventoryStart: 27, inventoryEnd: 41, slots,
      containerItems: () => slots.slice(0, 27).filter(Boolean),
      async deposit(type, _metadata, count) {
        state.depositCalls.push({ type, count })
        let remaining = count
        for (let index = window.inventoryStart; index < window.inventoryEnd && remaining > 0; index++) {
          const item = slots[index]
          if (item?.type !== type) continue
          const amount = Math.min(remaining, item.count)
          item.count -= amount
          if (!item.count) { slots[index] = null; inventory.slots[index - window.inventoryStart] = null }
          let destination = slots.slice(0, window.inventoryStart).find(slot => slot?.type === type)
          if (!destination) { destination = { name: 'oak_log', type, count: 0 }; slots[0] = destination }
          destination.count += amount
          remaining -= amount
        }
      },
      async withdraw(type, _metadata, count) {
        state.withdrawCalls.push({ type, count })
        let remaining = count
        for (let index = 0; index < window.inventoryStart && remaining > 0; index++) {
          const item = slots[index]
          if (item?.type !== type) continue
          const amount = Math.min(remaining, item.count)
          item.count -= amount
          if (!item.count) slots[index] = null
          let destination = slots.slice(window.inventoryStart, window.inventoryEnd).find(slot => slot?.type === type)
          if (!destination) { destination = { name: 'oak_log', type, count: 0 }; slots[window.inventoryStart] = destination; inventory.slots[0] = destination }
          destination.count += amount
          remaining -= amount
        }
      },
      async close() { state.closed.push(targetKey) } }
    state.onOpen?.()
    return window
  }
  return bot
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mc-chest-transfer-'))
  const previous = process.cwd()
  try {
    await setup(root); process.chdir(root)
    const skills = await import(pathToFileURL(path.join(root, 'src/agent/library/skills.js')))
    const craftingSync = (await import(pathToFileURL(path.join(root, 'src/agent/library/crafting_sync.js')))).default
    const ownership = await import(pathToFileURL(path.join(root, 'src/agent/library/operation_context.js')))
    let snapshots = 0
    let failChestSnapshot = false
    craftingSync.snapshotWindow = async (_bot, window) => {
      snapshots++
      if (failChestSnapshot) throw new Error('fixture snapshot unavailable')
      return { items: window.slots.map(item => item ? ({ type: item.type, count: item.count }) : null),
        inventoryStart: window.inventoryStart, inventoryEnd: window.inventoryEnd }
    }

    const bot = makeBot()
    assert.equal(await skills.putInChest(bot, 'oak_log', 2, { chestPosition: { x: 8, y: 64, z: 0 } }), true)
    assert.deepEqual(bot.state.opened, ['8,64,0'], 'deposit opens only the requested chest')
    assert.deepEqual(bot.state.closed, ['8,64,0'])
    assert.equal(snapshots, 2, 'deposit remains fenced by before and after snapshots')

    for (const [count, stacks] of [[262, [64, 64, 64, 64, 6]], [104, [64, 40]]]) {
      const stacked = makeBot({ inventoryCounts: stacks, chestCounts: [] })
      const owner = ownership.createOperationContext(
        { id: `deposit-${count}`, controller: { signal: new AbortController().signal } },
        { bot: stacked }, { intentEpoch: 1 }, 'chest-quantity'
      )
      const result = await ownership.runOwnedOperation(owner, () => skills.putInChest(stacked, 'oak_log', -1, {
        chestPosition: { x: 8, y: 64, z: 0 }
      }))
      assert.equal(result, true, `all ${count} matching items transfer successfully`)
      assert.deepEqual(stacked.state.depositCalls, [{ type: registry.itemsByName.oak_log.id, count }], 'all matching stacks use one deposit call')
      const operation = ownership.operationResult(owner)
      assert.deepEqual(operation.confirmedChanges.map(change => change.quantity), [count], 'confirmed fact aggregates every transferred stack')
      const summary = stacked.output.match(/Chest deposit: (\{[^\n]+\})/)
      assert.ok(summary, 'machine-readable deposit summary is logged')
      assert.deepEqual(JSON.parse(summary[1]), {
        requestedQuantity: count, confirmedQuantity: count, remainingQuantity: 0,
        chestPosition: { x: 8, y: 64, z: 0 }
      })
      assert.equal(stacked.inventoryUnconfirmed, undefined, 'fully confirmed multi-stack deposit keeps inventory gate clear')
    }

    const shortInventory = makeBot({ inventoryCounts: [64, 64, 64, 64, 6], chestCounts: [] })
    assert.equal(await skills.putInChest(shortInventory, 'oak_log', 300, { chestPosition: { x: 8, y: 64, z: 0 } }), false,
      'a shortage does not silently turn a larger requested deposit into success')
    assert.deepEqual(shortInventory.state.depositCalls.map(call => call.count), [262])
    assert.equal(shortInventory.inventoryUnconfirmed, undefined, 'a fenced, fully transferred available amount does not create an unknown-state gate')
    assert.match(shortInventory.output, /"requestedQuantity":300,"confirmedQuantity":262,"remainingQuantity":38/)

    const shortChest = makeBot({ inventoryCounts: [1], chestCounts: [64, 40] })
    assert.equal(await skills.takeFromChest(shortChest, 'oak_log', 100, { chestPosition: { x: 8, y: 64, z: 0 } }), true)
    assert.deepEqual(shortChest.state.withdrawCalls.map(call => call.count), [100], 'withdraw crosses multiple chest stacks in one call')
    assert.equal(shortChest.inventoryUnconfirmed, undefined)

    const allChest = makeBot({ inventoryCounts: [1], chestCounts: [64, 40] })
    assert.equal(await skills.takeFromChest(allChest, 'oak_log', -1, { chestPosition: { x: 8, y: 64, z: 0 } }), true)
    assert.deepEqual(allChest.state.withdrawCalls.map(call => call.count), [104], '-1 withdraws all matching stacks')

    const insufficientChest = makeBot({ inventoryCounts: [1], chestCounts: [64, 40] })
    assert.equal(await skills.takeFromChest(insufficientChest, 'oak_log', 130, { chestPosition: { x: 8, y: 64, z: 0 } }), false,
      'withdrawal below the exact requested quantity returns false')
    assert.deepEqual(insufficientChest.state.withdrawCalls.map(call => call.count), [104])
    assert.equal(insufficientChest.inventoryUnconfirmed, undefined, 'known chest shortage does not create an unknown-state gate')
    assert.match(insufficientChest.output, /"requestedQuantity":130,"confirmedQuantity":104,"remainingQuantity":26/)

    const unknownChest = makeBot({ inventoryCounts: [1], chestCounts: [64, 40] })
    failChestSnapshot = true
    await assert.rejects(() => skills.takeFromChest(unknownChest, 'oak_log', -1, { chestPosition: { x: 8, y: 64, z: 0 } }), /fixture snapshot unavailable/)
    failChestSnapshot = false
    assert.match(unknownChest.output, /"requestedQuantity":null,"confirmedQuantity":null,"remainingQuantity":null/,
      'an unknown chest snapshot does not substitute player inventory for requested chest quantity')
    assert.equal(unknownChest.inventoryUnconfirmed, true)

    bot.state.opened.length = 0; bot.state.closed.length = 0
    assert.equal(await skills.takeFromChest(bot, 'oak_log', 1, { chestPosition: { x: 8, y: 64, z: 0 } }), true)
    assert.deepEqual(bot.state.opened, ['8,64,0'], 'withdraw opens only the requested chest')
    assert.deepEqual(bot.state.closed, ['8,64,0'])

    const cancelled = makeBot()
    cancelled.state.onOpen = () => { cancelled.interrupt_code = true }
    assert.equal(await skills.putInChest(cancelled, 'oak_log', 1, { chestPosition: { x: 8, y: 64, z: 0 } }), false)
    assert.deepEqual(cancelled.state.opened, ['8,64,0'])
    assert.deepEqual(cancelled.state.closed, ['8,64,0'], 'cancelled transfer still closes its opened window')

    for (const mode of ['unknown', 'not_chest', 'blocked', 'disappeared']) {
      const failed = makeBot()
      if (mode === 'unknown') failed.state.missing.add('8,64,0')
      if (mode === 'blocked') { failed.state.invisible = true; failed.pathfinder.getPathTo = () => ({ status: 'partial' }); failed.pathfinder.goto = async () => { throw new Error('No path to target') } }
      if (mode === 'not_chest') failed.blockAt = position => position.x === 8
        ? { name: 'stone', type: 1, position: position.floored(), getProperties: () => ({}) }
        : makeBot().blockAt(position)
      if (mode === 'disappeared') {
        const originalGoto = failed.pathfinder.goto
        failed.pathfinder.goto = async goal => { await originalGoto.call(failed.pathfinder, goal); failed.state.missing.add('8,64,0') }
      }
      assert.equal(await skills.putInChest(failed, 'oak_log', 1, { chestPosition: { x: 8, y: 64, z: 0 } }), false, `${mode} target is rejected`)
      assert.equal(failed.state.opened.length, 0, `${mode} target causes no container operation`)
      assert.match(failed.output, /unknown|not a chest|Could not reach|became unknown/i)
    }

    const legacy = makeBot()
    legacy.modes.isOn = mode => mode === 'cheat'
    assert.equal(await skills.putInChest(legacy, 'oak_log', 1), true, 'three-argument nearest call retains boolean result')
    assert.deepEqual(legacy.state.opened, ['2,64,0'], 'legacy call still chooses the nearest chest')

    const invalid = makeBot()
    await assert.rejects(() => skills.putInChest(invalid, 'oak_log', 1, { chestPosition: { x: 8, y: NaN, z: 0 } }), /finite x, y and z/)
    assert.equal(invalid.state.opened.length, 0, 'invalid coordinates fail before interaction')

    for (const quantity of [0, -2, 1.5, NaN, Infinity]) {
      const badQuantity = makeBot()
      await assert.rejects(() => skills.putInChest(badQuantity, 'oak_log', quantity), TypeError)
      assert.equal(badQuantity.state.opened.length, 0, `${quantity} is rejected before container interaction`)
      await assert.rejects(() => skills.takeFromChest(badQuantity, 'oak_log', quantity), TypeError)
      assert.equal(badQuantity.state.opened.length, 0, `${quantity} withdrawal is rejected before container interaction`)
    }
    console.log('Chest transfer explicit-target fixture passed')
  } finally { process.chdir(previous); await rm(root, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
