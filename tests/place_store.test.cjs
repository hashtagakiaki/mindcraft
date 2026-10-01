'use strict'

const assert = require('node:assert/strict')
const { mkdir, readFile, readdir, rm, writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const WORLD_A = '11111111-1111-4111-8111-111111111111'
const WORLD_B = '22222222-2222-4222-8222-222222222222'

async function main() {
  const temp = await require('node:fs/promises').mkdtemp(path.join(os.tmpdir(), 'mindcraft-place-store-test-'))
  const { PlaceStore } = await import(pathToFileURL(path.join(__dirname, '../src/mindcraft/place_store.js')))
  const stateDir = path.join(temp, 'place-state')
  let store
  try {
    store = await PlaceStore.open({ stateDir, worldId: WORLD_A })
    await assert.rejects(PlaceStore.open({ stateDir, worldId: WORLD_A }), { code: 'STORE_LOCKED' })

    const farmResponse = await store.rememberPlace({
      name: 'North wheat farm', kind: 'farm', purposes: ['wheat'],
      position: { x: 4, y: 64, z: 8 }, dimension: 'overworld', source: 'user'
    })
    const farmId = farmResponse.value.id
    assert.equal(farmResponse.revision, 1)
    assert.equal(farmResponse.value.dimension, 'minecraft:overworld')

    const observedDuplicate = await store.rememberPlace({
      name: 'A second name from observation', kind: 'farm', purposes: ['food'],
      position: { x: 4, y: 64, z: 8 }, dimension: 'minecraft:overworld', source: 'observed'
    })
    assert.equal(observedDuplicate.value.id, farmId, 'exact same dimension, kind, and coordinates reuse the stable ID')
    assert.equal(observedDuplicate.value.name, 'North wheat farm')
    assert.ok(observedDuplicate.value.aliases.includes('A second name from observation'))
    assert.equal(observedDuplicate.value.existence, 'observed')
    const distantFarm = await store.rememberPlace({
      name: 'Distant wheat farm', kind: 'farm', purposes: ['wheat'],
      position: { x: 400, y: 64, z: 8 }, dimension: 'minecraft:overworld', source: 'observed'
    })
    assert.notEqual(distantFarm.value.id, farmId, 'a distant same-kind location is not merged')

    const storageResponse = await store.rememberPlace({
      name: 'Farm chest', kind: 'storage', purposes: ['wheat'],
      position: { x: 6, y: 64, z: 8 }, dimension: 'minecraft:overworld'
    })
    const chestId = storageResponse.value.id
    const relation = await store.setRelation({ fromPlaceId: farmId, toPlaceId: chestId, source: 'user' })
    assert.equal(relation.value.toPlaceId, chestId)
    assert.equal(relation.revision, 5)

    const spareId = (await store.rememberPlace({
      name: 'Spare chest', kind: 'storage', purposes: ['wheat'], position: { x: 40, y: 64, z: 8 }
    })).value.id
    const beforeExplicitConflict = store.revision
    const observedRelation = await store.setRelation({ fromPlaceId: farmId, toPlaceId: spareId, source: 'observed' })
    assert.equal(observedRelation.changed, false, 'observed relation does not replace an explicit user relation')
    assert.equal(store.revision, beforeExplicitConflict)
    assert.equal(store.getRelation(farmId).toPlaceId, chestId)
    await assert.rejects(store.setRelation({ fromPlaceId: farmId, toPlaceId: farmId }), { code: 'INVALID_RELATION' })

    const homeId = (await store.rememberPlace({
      name: 'Home', kind: 'base', position: { x: 0, y: 64, z: 0 }
    })).value.id
    await store.setAgentAlias('botA', 'Home', homeId)
    await store.setAgentAlias('botB', 'Home', farmId)
    await store.setAgentAlias('__proto__', '__proto__', farmId)
    await store.setAgentAlias('constructor', 'constructor', homeId)
    await store.setAgentPreference('botA', { homePlaceId: homeId })
    assert.equal(store.resolveAgentAlias('botA', 'HOME').id, homeId)
    assert.equal(store.resolveAgentAlias('botB', 'home').id, farmId)
    assert.equal(store.getAgentPreferences('botA').homePlaceId, homeId)
    assert.equal(store.resolveAgentAlias('__proto__', '__proto__').id, farmId)
    assert.equal(store.resolveAgentAlias('constructor', 'constructor').id, homeId)
    assert.equal(store.queryPlaces({ text: 'home', agentName: 'botA' })[0].id, homeId)

    const nearby = store.queryPlaces({ purpose: 'wheat', near: { x: 0, y: 64, z: 8 }, nearDimension: 'overworld' })
    assert.equal(nearby[0].id, farmId)
    assert.equal(store.queryPlaces({ dimension: 'minecraft:the_nether' }).length, 0)
    const oldId = (await store.rememberPlace({
      name: 'Old mine', kind: 'mine', purposes: ['iron'], position: { x: 12, y: 20, z: 2 }, recordedAt: '2020-01-01T00:00:00.000Z'
    })).value.id
    assert.equal(store.queryPlaces({ staleBefore: new Date().toISOString() }).some((place) => place.id === oldId), true)
    assert.throws(() => store.queryPlaces({ purpose: 12 }), { code: 'INVALID_INPUT' })

    const beforeVisits = store.revision
    const observed = await store.updateObservation({ placeId: farmId, existence: 'observed', availability: 'active', reportedBy: 'botA' })
    assert.equal(observed.value.source.type, 'observed')
    assert.ok(observed.value.lastVerifiedAt)
    const visit = await store.recordVisit({ placeId: farmId, status: 'arrived', reportedBy: 'botA' })
    assert.equal(visit.value.lastVisit.status, 'arrived')
    assert.ok(visit.value.recordedAt)
    assert.ok(store.revision > beforeVisits)
    const inspected = store.inspectPlace(farmId)
    assert.equal(inspected.outputStorage.id, chestId)
    assert.equal(inspected.revision, store.revision)

    await assert.rejects(store.rememberPlace({ name: 'Bad', kind: 'farm', position: { x: Infinity, y: 0, z: 0 } }), { code: 'INVALID_INPUT' })
    await assert.rejects(store.rememberPlace({ name: 'Bad dimension', kind: 'farm', position: { x: 0, y: 0, z: 0 }, dimension: 'bad dimension' }), { code: 'INVALID_INPUT' })
    await assert.rejects(store.setRelation({ fromPlaceId: farmId, toPlaceId: homeId }), { code: 'INVALID_RELATION' })
    const netherStorage = (await store.rememberPlace({ name: 'Nether chest', kind: 'storage', position: { x: 1, y: 64, z: 1 }, dimension: 'the_nether' })).value
    await assert.rejects(store.setRelation({ fromPlaceId: farmId, toPlaceId: netherStorage.id }), { code: 'DIMENSION_MISMATCH' })
    await assert.rejects(store.setRelation({ fromPlaceId: farmId, toPlaceId: chestId }, { expectedRevision: 1 }), { code: 'REVISION_CONFLICT' })

    // Two partial edits to one ID must merge against the previous queued edit.
    const patchA = store.rememberPlace({ id: farmId, aliases: ['North field'] })
    const patchB = store.rememberPlace({ id: farmId, purposes: ['wheat', 'food'] })
    await Promise.all([patchA, patchB])
    assert.deepEqual(store.getPlace(farmId).aliases, ['North field'])
    assert.deepEqual(store.getPlace(farmId).purposes, ['wheat', 'food'])
    assert.equal(store.getPlace(farmId).position.x, 4)

    const snapshot = store.snapshot()
    await store.close()
    store = null
    assert.equal(await fileExists(path.join(stateDir, '.place-store.lock')), false)
    store = await PlaceStore.open({ stateDir, worldId: WORLD_A })
    assert.deepEqual(store.snapshot(), snapshot, 'state and IDs survive store restart')
    await store.close()
    store = null

    const separateWorld = await PlaceStore.open({ stateDir, worldId: WORLD_B })
    assert.equal(separateWorld.queryPlaces({}).length, 0, 'another world UUID has an independent ledger')
    await separateWorld.rememberPlace({ name: 'Other world', kind: 'base', position: { x: 4, y: 64, z: 8 } })
    await separateWorld.close()
    const worldAPath = path.join(stateDir, 'worlds', `${WORLD_A}.json`)
    const worldBPath = path.join(stateDir, 'worlds', `${WORLD_B}.json`)
    assert.equal(JSON.parse(await readFile(worldAPath, 'utf8')).places[0].id, farmId)
    assert.equal(JSON.parse(await readFile(worldBPath, 'utf8')).places[0].name, 'Other world')

    // A failed rename must keep memory unchanged and leave the previous durable file readable.
    store = await PlaceStore.open({ stateDir, worldId: WORLD_A })
    const beforeFailure = store.snapshot()
    await rm(worldAPath)
    await mkdir(worldAPath)
    await assert.rejects(store.rememberPlace({ name: 'Cannot persist', kind: 'base', position: { x: 1, y: 2, z: 3 } }))
    assert.deepEqual(store.snapshot(), beforeFailure)
    assert.equal((await readdir(path.join(stateDir, 'worlds'))).some((name) => name.endsWith('.tmp')), false, 'failed atomic replacement removes its temporary file')
    await rm(worldAPath, { recursive: true })
    await writeFile(worldAPath, JSON.stringify(beforeFailure))
    await store.close()
    store = null

    await writeFile(worldAPath, '{broken json')
    await assert.rejects(PlaceStore.open({ stateDir, worldId: WORLD_A }), { code: 'CORRUPT_STORE' })
    assert.equal(await readFile(worldAPath, 'utf8'), '{broken json', 'corrupt source file is preserved')

    const drainStateDir = path.join(temp, 'drain-state')
    const drainingStore = await PlaceStore.open({ stateDir: drainStateDir, worldId: WORLD_B })
    let releaseAcceptedWrite
    drainingStore.queue = new Promise((resolve) => { releaseAcceptedWrite = resolve })
    const acceptedBeforeShutdown = drainingStore.rememberPlace({ name: 'Accepted before shutdown', kind: 'base', position: { x: 1, y: 64, z: 1 } })
    const closing = drainingStore.close()
    await assert.rejects(Promise.resolve().then(() => drainingStore.rememberPlace({ name: 'Rejected during shutdown', kind: 'base', position: { x: 2, y: 64, z: 2 } })), { code: 'STORE_CLOSED' })
    assert.equal(await fileExists(path.join(drainStateDir, '.place-store.lock')), true, 'close retains lock while accepted writes drain')
    releaseAcceptedWrite()
    const acceptedResult = await acceptedBeforeShutdown
    await closing
    assert.equal(acceptedResult.value.name, 'Accepted before shutdown')
    const drainedStore = await PlaceStore.open({ stateDir: drainStateDir, worldId: WORLD_B })
    assert.equal(drainedStore.queryPlaces({}).length, 1)
    await drainedStore.close()
    console.log('place_store.test.cjs: all assertions passed')
  } finally {
    if (store) await store.close()
    await rm(temp, { recursive: true, force: true })
  }
}

async function fileExists(file) {
  try { await readFile(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

const { pathToFileURL } = require('node:url')
main().catch((error) => { console.error(error); process.exitCode = 1 })
