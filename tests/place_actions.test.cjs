'use strict'

const assert = require('node:assert/strict')
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const repo = path.resolve(__dirname, '..')

async function write(root, relative, content) {
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
}

async function setup(root) {
  await write(root, 'package.json', '{"type":"module"}')
  await write(root, 'settings.js', 'export default { block_place_delay: 0 };')
  await write(root, 'src/agent/place_actions.js', await readFile(path.join(repo, 'src/agent/place_actions.js')))
  await write(root, 'src/agent/library/skills.js', await readFile(path.join(repo, 'src/agent/library/skills.js')))
  await write(root, 'src/agent/library/world.js', `
export function getNearestBlock(_bot, kind) { return kind === 'farmland' ? globalThis.farmFixture?.soil ?? null : globalThis.farmFixture?.nearestChest ?? null }
export function getNearestBlocks(_bot, kind) { return kind === 'farmland' ? (globalThis.farmFixture?.soil ? [globalThis.farmFixture.soil] : []) : [] }
export function getNearestBlocksWhere() { return [] }
export function getNearestEntityWhere() { return null }
export function isEntityType() { return false }
export function shouldPlaceTorch() { return false }
export function getNearbyEntities() { return [] }
export function getPosition(bot) { return bot.entity.position }
`)
  await write(root, 'src/agent/library/crafting_sync.js', 'export default { run: async (_bot, action) => action(async () => {}) }')
  await write(root, 'src/utils/mcdata.js', 'export function getBlockId() { return 1 } export function mustCollectManually() { return false }')
  await write(root, 'node_modules/vec3/package.json', '{"type":"module","exports":"./index.js"}')
  await write(root, 'node_modules/vec3/index.js', `
export default function Vec3(x, y, z) { return { x, y, z, distanceTo(other) { return Math.hypot(x-other.x, y-other.y, z-other.z) }, clone() { return this }, offset(dx,dy,dz) { return Vec3(x+dx,y+dy,z+dz) } } }
`)
  await write(root, 'node_modules/mineflayer-pathfinder/package.json', '{"type":"module","exports":"./index.js"}')
  await write(root, 'node_modules/mineflayer-pathfinder/index.js', `
class GoalNear { constructor(x,y,z,distance) { Object.assign(this,{x,y,z,distance}) } }
class Movements { constructor() { this.blocksCantBreak = new Set() } }
export default { goals: { GoalNear }, Movements }
`)
}

function makeBot(dimension = 'overworld') {
  const commands = []
  return {
    commands,
    game: { dimension },
    output: '',
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 0, clone() { return this }, offset() { return this } } },
    modes: { isOn: mode => mode === 'cheat' },
    pathfinder: {},
    chat(command) { commands.push(command) },
    pathfinder: { async getPathTo() { return { status: 'noPath' } }, setMovements() {}, async goto() {} },
    blockAt() { return null },
    inventory: { items: () => [] }
  }
}

function makeUnreachable(bot) {
  bot.modes.isOn = () => false
  bot.pathfinder.getPathTo = async () => ({ status: 'noPath' })
  bot.pathfinder.goto = async () => { throw new Error('injected unreachable path') }
  return bot
}

function makeFarmFixture({ chestX = 8, unloadedUntilApproach = false, neverLoads = false, depositMode = 'success', chestExists = true, mature = true } = {}) {
  const state = { cropHarvested: false, chestLoaded: !unloadedUntilApproach && !neverLoads, opened: 0, deposits: [], depositMode, inventory: [], chestX, chestExists, observations: [] }
  const pos = (x, y, z) => ({ x, y, z, offset(dx, dy, dz) { return pos(x + dx, y + dy, z + dz) }, distanceTo(other) { return Math.hypot(x - other.x, y - other.y, z - other.z) }, toString() { return `${x},${y},${z}` } })
  state.soil = { name: 'farmland', position: pos(0, 64, 0) }
  const crop = { name: 'wheat', position: pos(0, 65, 0), diggable: true, getProperties: () => ({ age: mature ? 7 : 0 }) }
  state.nearestChest = { name: 'chest', position: pos(chestX, 64, 0) }
  globalThis.farmFixture = state
  const listeners = new Map()
  const bot = {
    game: { dimension: 'overworld' }, output: '', username: 'bot', entity: { id: 4, position: pos(0, 64, 0) },
    registry: { itemsByName: { wheat: { id: 100 }, wheat_seeds: { id: 101 } } },
    modes: { isOn: mode => mode === 'cheat' }, inventory: { items: () => state.inventory, slots: state.inventory },
    pathfinder: {},
    on(event, listener) { const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set) },
    removeListener(event, listener) { listeners.get(event)?.delete(listener) },
    listenerCount(event) { return listeners.get(event)?.size ?? 0 },
    emit(event, ...args) { for (const listener of listeners.get(event) ?? []) listener(...args) },
    blockAt(position) {
      if (position.x === 0 && position.y === 64 && position.z === 0) return state.soil
      if (position.x === chestX && position.y === 64 && position.z === 0) return state.chestLoaded ? (state.chestExists ? state.nearestChest : { name: 'air', position }) : null
      if (position.y === 64) return { name: 'dirt', position }
      if (position.x === 0 && position.y === 65 && position.z === 0) return state.cropHarvested ? { name: 'air', position } : crop
      return { name: 'air', position }
    },
    chat(command) {
      if (!command.startsWith('/tp ')) return
      const [, , x, y, z] = command.split(' ')
      Object.assign(this.entity.position, { x: Number(x), y: Number(y), z: Number(z) })
      if (unloadedUntilApproach && !neverLoads && Number(x) === chestX) state.chestLoaded = true
    },
    async dig() {
      state.cropHarvested = true
      state.inventory.push({ name: 'wheat', type: 100, count: 1 }, { name: 'wheat_seeds', type: 101, count: 1 })
      const drop = { id: 55, position: pos(0.5, 65.5, 0.5), getDroppedItem: () => ({ type: 100 }) }
      this.emit('itemDrop', drop)
      this.emit('playerCollect', this.entity, drop)
      this.emit('blockUpdate', crop, { name: 'air', type: 0, position: crop.position })
    },
    async openContainer(chest) {
      assert.equal(chest.name, 'chest')
      state.opened++
      if (state.depositMode === 'openFailure') throw new Error('injected open failure')
      return {
        async deposit(type, _metadata, count) {
          const item = state.inventory.find(entry => entry.type === type)
          if (state.depositMode === 'partial' && type === 100) {
            item.count -= 1
            state.deposits.push({ type, count: 1 })
            throw new Error('injected partial deposit')
          }
          if (state.depositMode === 'failure') throw new Error('injected deposit failure')
          item.count -= count
          state.deposits.push({ type, count })
        },
        async close() {}
      }
    }
  }
  return { state, bot }
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-place-actions-'))
  try {
    await setup(root)
    const { createPlaceActions } = await import(pathToFileURL(path.join(root, 'src/agent/place_actions.js')))
    const skills = await import(pathToFileURL(path.join(root, 'src/agent/library/skills.js')))
    const bot = makeBot()
    const visitCalls = []
    const client = {
      async inspectPlace() { return { place: { id: 'base-1', kind: 'base', dimension: 'minecraft:overworld', position: { x: 10, y: 64, z: 20 }, approachPosition: { x: 9, y: 64, z: 20 } }, relation: null, outputStorage: null, revision: 1 } },
      async recordPlaceVisit(visit) { visitCalls.push(visit); return { ok: true, revision: 2 } }
    }
    const actions = createPlaceActions({ bot }, client)
    assert.deepEqual(await actions.goTo('base-1'), { ok: true, status: 'visited', placeId: 'base-1' })
    assert.deepEqual(bot.commands, ['/tp @s 9 64 20'], 'goTo uses saved approach coordinates')
    assert.deepEqual(visitCalls, [{ placeId: 'base-1', status: 'visited' }])

    bot.game.dimension = 'the_nether'
    const wrongDimension = await actions.goTo('base-1')
    assert.equal(wrongDimension.status, 'dimension_mismatch')
    assert.equal(wrongDimension.confirmationRequired, true)
    assert.equal(visitCalls.length, 1, 'dimension mismatch does not move or record a visit')

    const unreachableBot = makeUnreachable(makeBot())
    const unreachableVisits = []
    const unreachableActions = createPlaceActions({ bot: unreachableBot }, {
      ...client,
      async recordPlaceVisit(visit) { unreachableVisits.push(visit); return { ok: true } }
    })
    const unreachableVisit = await unreachableActions.goTo('base-1')
    assert.equal(unreachableVisit.status, 'unreachable')
    assert.deepEqual(unreachableVisits, [{ placeId: 'base-1', status: 'unreachable' }])

    bot.game.dimension = 'overworld'
    const farmQueries = []
    const farmClient = {
      async inspectPlace() { return { place: { id: 'farm-1', kind: 'farm', purposes: ['wheat'], dimension: 'minecraft:overworld', position: { x: 2, y: 64, z: 3 } }, relation: null, outputStorage: null, revision: 4 } },
      async queryPlaces(criteria) {
        farmQueries.push(criteria)
        return criteria.purpose === 'food_storage'
          ? [{ id: 'chest-a', kind: 'storage', dimension: 'minecraft:overworld', position: { x: 5, y: 64, z: 5 } }, { id: 'chest-b', kind: 'storage', dimension: 'minecraft:overworld', position: { x: 6, y: 64, z: 6 } }]
          : []
      }
    }
    const farmActions = createPlaceActions({ bot }, farmClient)
    bot.blockAt = position => position.x === 2 && position.y === 64 && position.z === 3 ? { name: 'farmland', position } : null
    const ambiguous = await farmActions.tendFarm('farm-1')
    assert.equal(ambiguous.status, 'storage_candidates_ambiguous')
    assert.equal(ambiguous.confirmationRequired, true)
    assert.deepEqual(farmQueries.map(query => query.purpose), ['food_storage', 'wheat'])
    assert.deepEqual(bot.commands.at(-1), '/tp @s 2 64 3', 'farm approach is reached before resolving its plot')

    const missingTargetClient = {
      async inspectPlace() { return { place: { id: 'farm-2', kind: 'farm', dimension: 'minecraft:overworld', position: { x: 2, y: 64, z: 3 } }, relation: { toPlaceId: 'gone', revision: 3, source: 'user' }, outputStorage: null, revision: 4 } }
    }
    const missingTarget = await createPlaceActions({ bot }, missingTargetClient).tendFarm('farm-2')
    assert.equal(missingTarget.status, 'explicit_storage_target_missing')
    assert.equal(missingTarget.confirmationRequired, true)

    function storageClient({ relation = null, switchDuringTravel = false, switchDuringObservation = false, relationDisappearsAtResolve = false, failRecord = false, candidate = true } = {}) {
      const farm = { id: 'farm-live', kind: 'farm', purposes: ['wheat'], dimension: 'minecraft:overworld', position: { x: 0, y: 64, z: 0 } }
      const targetA = { id: 'storage-a', kind: 'storage', existence: 'observed', dimension: farm.dimension, position: { x: 8, y: 64, z: 0 } }
      const targetB = { id: 'storage-b', kind: 'storage', existence: 'observed', dimension: farm.dimension, position: { x: 10, y: 64, z: 0 } }
      const relationA = { fromPlaceId: farm.id, type: 'output_storage', toPlaceId: targetA.id, source: 'user', revision: 7 }
      const relationB = { ...relationA, toPlaceId: targetB.id, revision: 8 }
      let inspectCount = 0
      let relationOverride
      const calls = { inspect: 0, queries: [], records: [], relationWrites: [], latestReads: 0 }
      return {
        calls,
        async inspectPlace() {
          inspectCount++
          calls.inspect++
          if (relationDisappearsAtResolve && inspectCount >= 2) relationOverride = null
          else if (switchDuringTravel && inspectCount >= 3) relationOverride = relationB
          const currentRelation = relationOverride === undefined ? relation : relationOverride
          const target = currentRelation?.toPlaceId === targetB.id ? targetB : currentRelation ? targetA : null
          return { place: farm, relation: currentRelation, outputStorage: target, revision: currentRelation?.revision ?? 9 }
        },
        async queryPlaces(criteria) {
          calls.queries.push(criteria)
          return candidate && criteria.purpose === 'food_storage' ? [targetA] : []
        },
        async getPlace(id) {
          calls.latestReads++
          return id === targetA.id ? targetA : id === targetB.id ? targetB : null
        },
        async recordPlaceVisit(visit) { calls.records.push(visit); return { ok: true } },
        async updatePlaceObservation(observation) {
          calls.observations ??= []
          calls.observations.push(observation)
          if (switchDuringObservation && observation.placeId === targetA.id) relationOverride = relationB
          return { ok: true, revision: 10 }
        },
        async setPlaceRelation(value) {
          calls.relationWrites.push(value)
          return failRecord ? { ok: false } : { ok: true, revision: 10 }
        }
      }
    }

    const unreachableFarmFixture = makeFarmFixture()
    makeUnreachable(unreachableFarmFixture.bot)
    const unreachableFarmClient = storageClient()
    const unreachableFarmResult = await createPlaceActions({ bot: unreachableFarmFixture.bot }, unreachableFarmClient).tendFarm('farm-live')
    assert.equal(unreachableFarmResult.status, 'farm_unreachable')
    assert.equal(unreachableFarmClient.calls.observations?.length ?? 0, 0, 'unreachable farm position is not recorded missing or observed')

    let fixture = makeFarmFixture({ unloadedUntilApproach: true })
    let placeClient = storageClient()
    let liveActions = createPlaceActions({ bot: fixture.bot }, placeClient)
    let farmResult = await liveActions.tendFarm('farm-live')
    assert.equal(farmResult.ok, true)
    assert.equal(farmResult.harvested, 1)
    assert.equal(farmResult.stored, 1, 'storage is counted from observed inventory decrease above the seed reserve')
    assert.equal(fixture.state.opened, 1)
    assert.equal(fixture.state.chestLoaded, true, 'a distant unloaded chest is loaded by travelling before block verification')
    assert.deepEqual(placeClient.calls.relationWrites, [{ fromPlaceId: 'farm-live', type: 'output_storage', toPlaceId: 'storage-a', source: 'observed' }])
    assert.equal(fixture.state.inventory.reduce((total, item) => total + item.count, 0), 1, 'the reserved seed remains with the bot')
    assert.deepEqual(placeClient.calls.observations.map(entry => [entry.placeId, entry.existence]), [['farm-live', 'observed'], ['storage-a', 'observed']])

    fixture = makeFarmFixture()
    placeClient = storageClient({ relation: { fromPlaceId: 'farm-live', type: 'output_storage', toPlaceId: 'storage-a', source: 'user', revision: 7 }, switchDuringTravel: true })
    farmResult = await createPlaceActions({ bot: fixture.bot }, placeClient).tendFarm('farm-live')
    assert.equal(farmResult.status, 'relation_changed')
    assert.equal(farmResult.stored, 0)
    assert.equal(fixture.state.opened, 0, 'a changed relation prevents deposit into the old target')
    assert.equal(placeClient.calls.relationWrites.length, 0)

    fixture = makeFarmFixture()
    placeClient = storageClient({ relation: { fromPlaceId: 'farm-live', type: 'output_storage', toPlaceId: 'storage-a', source: 'user', revision: 7 }, switchDuringObservation: true })
    farmResult = await createPlaceActions({ bot: fixture.bot }, placeClient).tendFarm('farm-live')
    assert.equal(farmResult.status, 'relation_changed', 'relation changes during the observation acknowledgement stop deposit')
    assert.equal(fixture.state.opened, 0)

    fixture = makeFarmFixture()
    placeClient = storageClient({ relation: { fromPlaceId: 'farm-live', type: 'output_storage', toPlaceId: 'storage-a', source: 'user', revision: 7 }, relationDisappearsAtResolve: true })
    farmResult = await createPlaceActions({ bot: fixture.bot }, placeClient).tendFarm('farm-live')
    assert.equal(farmResult.status, 'explicit_storage_relation_missing')
    assert.equal(fixture.state.opened, 0, 'a nearby chest is not used if an explicit relation disappears')

    fixture = makeFarmFixture({ depositMode: 'partial' })
    placeClient = storageClient()
    farmResult = await createPlaceActions({ bot: fixture.bot }, placeClient).tendFarm('farm-live')
    assert.equal(farmResult.status, 'partial_storage_failed')
    assert.equal(farmResult.stored, 1, 'partial throw preserves the server-confirmed inventory delta')
    assert.equal(fixture.state.opened, 1)
    assert.equal(placeClient.calls.relationWrites.length, 1, 'confirmed partial storage can record the observed output relation')

    fixture = makeFarmFixture({ depositMode: 'failure' })
    placeClient = storageClient()
    farmResult = await createPlaceActions({ bot: fixture.bot }, placeClient).tendFarm('farm-live')
    assert.equal(farmResult.storageStatus, 'storage_failed')
    assert.equal(farmResult.stored, 0)
    assert.equal(placeClient.calls.relationWrites.length, 0, 'failed storage does not create an observed relation')

    fixture = makeFarmFixture()
    placeClient = storageClient({ failRecord: true })
    farmResult = await createPlaceActions({ bot: fixture.bot }, placeClient).tendFarm('farm-live')
    assert.equal(farmResult.stored, 1)
    assert.equal(farmResult.actionAlreadyCompleted, true, 'ledger failure reports completion without inviting another work cycle')
    assert.match(farmResult.relationRecordError, /acknowledgement/)
    assert.equal(placeClient.calls.relationWrites.length, 1, 'the failed observed-relation write is reported after work completes')

    fixture = makeFarmFixture()
    placeClient = storageClient({ relation: { fromPlaceId: 'farm-live', type: 'output_storage', toPlaceId: 'storage-a', source: 'user', revision: 7 } })
    farmResult = await createPlaceActions({ bot: fixture.bot }, placeClient).tendFarm('farm-live')
    assert.equal(farmResult.stored, 1)
    assert.equal(placeClient.calls.relationWrites.length, 0, 'explicit user relation is preserved after confirmed storage')

    fixture = makeFarmFixture({ chestX: 99 })
    fixture.state.chestLoaded = false
    fixture.state.nearestChest.position.x = 99
    placeClient = storageClient({ candidate: false })
    farmResult = await createPlaceActions({ bot: fixture.bot }, placeClient).tendFarm('farm-live')
    assert.equal(farmResult.status, 'storage_candidate_missing')
    assert.equal(fixture.state.opened, 0, 'no fallback chest is used when a selected storage relation is unavailable')

    fixture = makeFarmFixture({ neverLoads: true })
    placeClient = storageClient()
    farmResult = await createPlaceActions({ bot: fixture.bot }, placeClient).tendFarm('farm-live')
    assert.equal(farmResult.status, 'target_unloaded')
    assert.equal(farmResult.stored, 0)
    assert.deepEqual(placeClient.calls.observations.map(entry => [entry.placeId, entry.existence]), [['farm-live', 'observed']], 'an unloaded chest is not marked missing')

    fixture = makeFarmFixture({ chestExists: false })
    placeClient = storageClient()
    farmResult = await createPlaceActions({ bot: fixture.bot }, placeClient).tendFarm('farm-live')
    assert.equal(farmResult.status, 'target_missing')
    assert.equal(farmResult.stored, 0)
    assert.equal(placeClient.calls.relationWrites.length, 0, 'a loaded missing chest is not marked as an observed relation')

    fixture = makeFarmFixture({ depositMode: 'openFailure' })
    placeClient = storageClient()
    farmResult = await createPlaceActions({ bot: fixture.bot }, placeClient).tendFarm('farm-live')
    assert.equal(farmResult.storageStatus, 'storage_failed')
    assert.equal(farmResult.stored, 0)
    assert.equal(placeClient.calls.relationWrites.length, 0, 'container-open failure does not create a relation')

    fixture = makeFarmFixture({ mature: false })
    placeClient = storageClient()
    farmResult = await createPlaceActions({ bot: fixture.bot }, placeClient).tendFarm('farm-live')
    assert.equal(farmResult.status, 'no_work')
    assert.deepEqual({ harvested: farmResult.harvested, planted: farmResult.planted, stored: farmResult.stored }, { harvested: 0, planted: 0, stored: 0 })
    assert.equal(placeClient.calls.relationWrites.length, 0, 'zero-work cycle does not create an observed relation')
    console.log('place action adapter tests passed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
