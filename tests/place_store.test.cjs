'use strict'

const assert = require('node:assert/strict')
const { mkdir, readFile, readdir, rm, writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const WORLD_A = '11111111-1111-4111-8111-111111111111'
const WORLD_B = '22222222-2222-4222-8222-222222222222'

async function main() {
  const temp = await require('node:fs/promises').mkdtemp(path.join(os.tmpdir(), 'mindcraft-place-store-test-'))
  const { PlaceStore, attachPlaceStoreLifecycle } = await import(pathToFileURL(path.join(__dirname, '../src/mindcraft/place_store.js')))
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

    const lifecycleStateDir = path.join(temp, 'lifecycle-state')
    const lifecycleStore = await PlaceStore.open({ stateDir: lifecycleStateDir, worldId: WORLD_A })
    let releaseAgentCleanup
    let agentCleanupStarted
    const cleanupGate = new Promise(resolve => { releaseAgentCleanup = resolve })
    const cleanupStarted = new Promise(resolve => { agentCleanupStarted = resolve })
    const order = []
    const lifecycleServer = new EventEmitter()
    const lifecycleProcess = Object.assign(new EventEmitter(), { exit(code) { order.push(`exit:${code}`); this.exitCode = code } })
    const lifecycleSocket = { close(callback) { order.push('socket-close'); lifecycleServer.emit('close'); callback() } }
    const lifecycle = attachPlaceStoreLifecycle({
      server: lifecycleServer,
      socketServer: lifecycleSocket,
      storePromise: Promise.resolve(lifecycleStore),
      processObject: lifecycleProcess,
      beforeClose: async () => {
        order.push('agent-cleanup-start')
        agentCleanupStarted()
        await cleanupGate
        order.push('agent-cleanup-complete')
        return { groupsGone: true }
      }
    })
    let releaseQueuedWrite
    lifecycleStore.queue = new Promise(resolve => { releaseQueuedWrite = resolve })
    const acceptedDuringClose = lifecycleStore.rememberPlace({ name: 'Queued before parent shutdown', kind: 'base', position: { x: 3, y: 64, z: 4 } })
    acceptedDuringClose.then(() => order.push('queued-write-complete'))
    const shutdownDrain = lifecycle.shutdown({ reason: 'test-parent-shutdown' })
    await cleanupStarted
    assert.equal(await fileExists(path.join(lifecycleStateDir, '.place-store.lock')), true, 'the lock remains held while bot cleanup is pending')
    releaseAgentCleanup()
    assert.equal(await waitUntil(() => lifecycleStore.closing), true, 'store close begins only after bot cleanup completes')
    assert.equal(await fileExists(path.join(lifecycleStateDir, '.place-store.lock')), true, 'the lock remains held while accepted store writes drain')
    releaseQueuedWrite()
    await acceptedDuringClose
    const drainedShutdown = await shutdownDrain
    assert.equal(drainedShutdown.closed, true)
    assert.deepEqual(order.slice(0, 4), ['agent-cleanup-start', 'agent-cleanup-complete', 'queued-write-complete', 'socket-close'])
    assert.equal(order.at(-1), 'exit:0')
    assert.equal(await fileExists(path.join(lifecycleStateDir, '.place-store.lock')), false, 'the lock is released after the last queued write and before transport close')
    assert.equal(JSON.parse(await readFile(path.join(lifecycleStateDir, 'worlds', `${WORLD_A}.json`), 'utf8')).places[0].name, 'Queued before parent shutdown')

    const heldStateDir = path.join(temp, 'cleanup-failure-state')
    const heldStore = await PlaceStore.open({ stateDir: heldStateDir, worldId: WORLD_B })
    const heldServer = new EventEmitter()
    const heldProcess = Object.assign(new EventEmitter(), { exit(code) { this.exitCode = code } })
    let cleanupAllowed = false
    let transportClosed = false
    const heldLifecycle = attachPlaceStoreLifecycle({
      server: heldServer,
      socketServer: { close(callback) { transportClosed = true; heldServer.emit('close'); callback() } },
      storePromise: Promise.resolve(heldStore),
      processObject: heldProcess,
      beforeClose: async () => cleanupAllowed ? { groupsGone: true } : { groupsGone: false, error: 'owned process group remains' }
    })
    const blockedShutdown = await heldLifecycle.shutdown({ reason: 'test-unclean-process' })
    assert.equal(blockedShutdown.closed, false)
    assert.equal(blockedShutdown.reason, 'agent-cleanup-incomplete')
    assert.equal(await fileExists(path.join(heldStateDir, '.place-store.lock')), true, 'unclean process ownership keeps the place lock held')
    assert.equal(transportClosed, false, 'transport stays open when owned process cleanup is unconfirmed')
    assert.equal(heldProcess.exitCode, undefined, 'parent does not exit while ownership cleanup is unconfirmed')
    cleanupAllowed = true
    const retriedShutdown = await heldLifecycle.shutdown({ reason: 'test-retry' })
    assert.equal(retriedShutdown.closed, true, 'a failed shutdown can be retried after cleanup succeeds')
    assert.equal(await fileExists(path.join(heldStateDir, '.place-store.lock')), false)
    assert.equal(heldProcess.exitCode, 0)

    const hubResult = await runHubShutdownFixture(temp)
    assert.deepEqual(hubResult, { duplicateCreateRejected: true, pendingDestroyBlockedLateSpawn: true, midStartStopWaitedForRealGroup: true, newOwnerSurvivedLateOldCreate: true, settingsMetadataMatched: true, stopAllCanceledPendingCreate: true, explicitRestartUsedParent: true, settingsRestartUsedParent: true, taskEndingStoppedSibling: true, ownedGroupFailureHeldLock: true, retryDrainedStoreBeforeTransportClose: true })
    console.log('place_store.test.cjs: all assertions passed')
  } finally {
    if (store) await store.close()
    await rm(temp, { recursive: true, force: true })
  }
}

async function runHubShutdownFixture(root) {
  const fixtureRoot = path.join(root, 'hub-lifecycle')
  const sourceRoot = path.resolve(__dirname, '../src')
  const mindcraftDir = path.join(fixtureRoot, 'src/mindcraft')
  const processDir = path.join(fixtureRoot, 'src/process')
  const stubsDir = path.join(fixtureRoot, 'src/stubs')
  const nodeModules = path.join(fixtureRoot, 'node_modules')
  await Promise.all([mindcraftDir, path.join(mindcraftDir, 'public'), processDir, stubsDir, nodeModules].map(dir => mkdir(dir, { recursive: true })))
  await writeFile(path.join(fixtureRoot, 'package.json'), '{"type":"module"}')
  await writeFile(path.join(fixtureRoot, 'settings.js'), `export default ${JSON.stringify({ place_state_dir: path.join(fixtureRoot, 'state'), place_world_id: WORLD_A, bot_rules_file: path.join(fixtureRoot, 'BOT_RULES.md') })}`)
  await writeFile(path.join(mindcraftDir, 'public/settings_spec.json'), await readFile(path.join(sourceRoot, 'mindcraft/public/settings_spec.json')))
  await writeFile(path.join(mindcraftDir, 'place_store.js'), await readFile(path.join(sourceRoot, 'mindcraft/place_store.js')))
  await writeFile(path.join(mindcraftDir, 'place_rpc.js'), await readFile(path.join(sourceRoot, 'mindcraft/place_rpc.js')))
  await writeFile(path.join(processDir, 'agent_process.js'), await readFile(path.join(sourceRoot, 'process/agent_process.js')))

  let mindcraftSource = await readFile(path.join(sourceRoot, 'mindcraft/mindcraft.js'), 'utf8')
  mindcraftSource = mindcraftSource
    .replace("import { AgentProcess } from '../process/agent_process.js';", "import { FixtureAgentProcess as AgentProcess } from '../process/fixture_agent_process.js';")
    .replace("import { getServer } from './mcserver.js';", "import { getServer } from '../stubs/mcserver.js';")
    .replace("import { getBotViewerPort } from '../utils/viewer_ports.js';", "import { getBotViewerPort } from '../stubs/viewer_ports.js';")
    .replace("import open from 'open';", "import open from '../stubs/open.js';")
  await writeFile(path.join(mindcraftDir, 'mindcraft.js'), mindcraftSource)
  let mindserverSource = await readFile(path.join(sourceRoot, 'mindcraft/mindserver.js'), 'utf8')
  mindserverSource = mindserverSource.replace('placeStoreLifecycle = attachPlaceStoreLifecycle({\n', 'placeStoreLifecycle = attachPlaceStoreLifecycle({\n        processObject: globalThis.__fixtureProcess,\n')
  await writeFile(path.join(mindcraftDir, 'mindserver.js'), mindserverSource)
  await writeFile(path.join(processDir, 'fixture_agent_process.js'), `
    import { AgentProcess } from './agent_process.js'
    export class FixtureAgentProcess extends AgentProcess {
      constructor(name, port, options) {
        super(name, port, { ...options, entrypoint: globalThis.__fixtureAgentEntry, shutdownTimeout: 100, terminateTimeout: 60, killTimeout: 100, logoutAgent() {} })
      }
      async start(...args) {
        const started = super.start(...args)
        const gate = globalThis.__fixtureStartGates?.get(this.name)
        if (gate) await gate
        return started
      }
    }
  `)
  await writeFile(path.join(stubsDir, 'mcserver.js'), `
    export async function getServer(host, port, version) {
      const gate = globalThis.__fixtureServerGate
      if (gate) await gate
      return { host, port, version: version === 'auto' ? '1.20' : version }
    }
  `)
  await writeFile(path.join(stubsDir, 'viewer_ports.js'), 'export function getBotViewerPort(index) { return 12000 + index }')
  await writeFile(path.join(stubsDir, 'open.js'), 'export default async function open() {}')
  const socketPackage = path.join(nodeModules, 'socket.io')
  const expressPackage = path.join(nodeModules, 'express')
  await Promise.all([mkdir(socketPackage, { recursive: true }), mkdir(expressPackage, { recursive: true })])
  await writeFile(path.join(socketPackage, 'package.json'), '{"type":"module","exports":"./index.js"}')
  await writeFile(path.join(socketPackage, 'index.js'), `
    import { EventEmitter } from 'node:events'
    export class Server extends EventEmitter {
      constructor(server) { super(); this.server = server; globalThis.__fixtureSocketServer = this }
      close(callback) {
        globalThis.__fixtureOrder.push('transport-close')
        this.server.close(() => callback?.())
      }
    }
  `)
  await writeFile(path.join(expressPackage, 'package.json'), '{"type":"module","exports":"./index.js"}')
  await writeFile(path.join(expressPackage, 'index.js'), `export default function express() { return { use() {} } }; express.static = () => () => {}`)

  const endingMarker = path.join(fixtureRoot, 'ending-ready')
  const grandchildMarker = path.join(fixtureRoot, 'grandchild-pid')
  const siblingMarker = path.join(fixtureRoot, 'sibling-stopped')
  const childEntry = path.join(fixtureRoot, 'fixture-agent.mjs')
  await writeFile(path.join(fixtureRoot, 'grandchild.mjs'), `
    import { writeFileSync } from 'node:fs'
    writeFileSync(${JSON.stringify(grandchildMarker)}, String(process.pid))
    process.on('SIGTERM', () => {})
    setInterval(() => {}, 1000)
  `)
  await writeFile(childEntry, `
    import { spawn } from 'node:child_process'
    import { existsSync, writeFileSync } from 'node:fs'
    if (process.argv[2] === 'ending') {
      const grandchild = spawn(process.execPath, [${JSON.stringify(path.join(fixtureRoot, 'grandchild.mjs'))}], { stdio: 'ignore' })
      while (!existsSync(${JSON.stringify(grandchildMarker)})) await new Promise(resolve => setTimeout(resolve, 5))
      writeFileSync(${JSON.stringify(endingMarker)}, String(process.pid))
      process.on('message', message => { if (message?.type === 'fixture-fail-task') process.exit(2) })
    } else {
      process.on('message', message => {
        if (message?.type === 'mindcraft:shutdown') {
          writeFileSync(${JSON.stringify(siblingMarker)}, 'stopped')
          process.exit(0)
        }
      })
      process.send?.({ type: 'fixture-sibling-ready' })
    }
    setInterval(() => {}, 1000)
  `)

  const order = []
  let fakeExitCode
  const fakeProcess = Object.assign(new EventEmitter(), { exit(code) { order.push(`exit:${code}`); fakeExitCode = code } })
  globalThis.__fixtureProcess = fakeProcess
  globalThis.__fixtureOrder = order
  globalThis.__fixtureAgentEntry = childEntry
  globalThis.__fixtureServerGate = null
  globalThis.__fixtureStartGates = new Map()
  const previousCwd = process.cwd()
  process.chdir(fixtureRoot)
  let endSupervisor
  const fixtureSupervisors = []
  let fixtureStore
  let releaseQueuedWrite
  let knownEndReader
  const previousExitCode = process.exitCode
  try {
    const { PlaceStore } = await import(pathToFileURL(path.join(mindcraftDir, 'place_store.js')).href)
    const originalOpen = PlaceStore.open
    PlaceStore.open = async options => {
      fixtureStore = await originalOpen(options)
      return fixtureStore
    }
    const mindcraft = await import(pathToFileURL(path.join(mindcraftDir, 'mindcraft.js')).href)
    const { createMindServer } = await import(pathToFileURL(path.join(mindcraftDir, 'mindserver.js')).href)
    createMindServer(false, 0)
    assert.equal(await waitUntil(() => Boolean(fixtureStore)), true)
    const controlSocket = new EventEmitter()
    globalThis.__fixtureSocketServer.emit('connection', controlSocket)
    const settings = name => ({ profile: { name, bot_rules_file: '/ignored/profile.md' }, bot_rules_file: '/ignored/agent.md', host: 'localhost', port: 1, minecraft_version: '1.20' })

    const emitCreate = input => new Promise(resolve => controlSocket.emit('create-agent', input, resolve))
    const raceResults = await Promise.all([
      emitCreate(settings('same-name-race')),
      emitCreate(settings('same-name-race'))
    ])
    assert.equal(raceResults.filter(result => result.success).length, 1, 'one concurrent same-name request owns the creation')
    assert.equal(raceResults.filter(result => !result.success).length, 1)
    const raceOwner = mindcraft.getAgentProcess('same-name-race')
    assert.ok(raceOwner, 'a failed concurrent request must not destroy the successful request owner')
    fixtureSupervisors.push(raceOwner)
    await mindcraft.destroyAgent('same-name-race')

    let releaseServerGate
    globalThis.__fixtureServerGate = new Promise(resolve => { releaseServerGate = resolve })
    const pending = mindcraft.createAgent(settings('pending-destroy'))
    const duplicate = await mindcraft.createAgent(settings('pending-destroy'))
    assert.equal(duplicate.success, false, 'same-name pending creates are reserved synchronously')
    await mindcraft.destroyAgent('pending-destroy')
    releaseServerGate()
    const canceled = await pending
    assert.equal(canceled.success, false, 'destroy cancels a pending create before it can spawn')
    assert.equal(mindcraft.getAgentProcess('pending-destroy'), undefined)

    let releaseStartGate
    globalThis.__fixtureStartGates.set('mid-start-stop', new Promise(resolve => { releaseStartGate = resolve }))
    const creatingDuringStart = mindcraft.createAgent(settings('mid-start-stop'))
    assert.equal(await waitUntil(() => Boolean(mindcraft.getAgentProcess('mid-start-stop')?.process?.pid)), true)
    const midStartSupervisor = mindcraft.getAgentProcess('mid-start-stop')
    const midStartPid = midStartSupervisor.process.pid
    assert.equal(midStartSupervisor.ownedGroups.size, 1)
    const stoppedDuringStart = await mindcraft.stopAgent('mid-start-stop')
    assert.equal(stoppedDuringStart.groupsGone, true, 'stop during AgentProcess.start must await its owned group cleanup')
    assert.equal(midStartSupervisor.process, null)
    assert.equal(await processAlive(midStartPid), false)
    releaseStartGate()
    assert.equal((await creatingDuringStart).success, false, 'a create completing after stop cannot report a running agent')
    assert.equal(midStartSupervisor.desiredState, 'stopped')
    assert.equal(midStartSupervisor.ownedGroups.size, 0)
    globalThis.__fixtureStartGates.delete('mid-start-stop')

    let releaseOldOwnerStart
    globalThis.__fixtureStartGates.set('reused-name', new Promise(resolve => { releaseOldOwnerStart = resolve }))
    const oldOwnerCreate = mindcraft.createAgent(settings('reused-name'))
    assert.equal(await waitUntil(() => Boolean(mindcraft.getAgentProcess('reused-name')?.process)), true)
    const oldOwner = mindcraft.getAgentProcess('reused-name')
    fixtureSupervisors.push(oldOwner)
    await mindcraft.destroyAgent('reused-name')
    globalThis.__fixtureStartGates.delete('reused-name')
    const newOwnerResult = await mindcraft.createAgent(settings('reused-name'))
    assert.equal(newOwnerResult.success, true)
    const newOwner = mindcraft.getAgentProcess('reused-name')
    fixtureSupervisors.push(newOwner)
    releaseOldOwnerStart()
    assert.equal((await oldOwnerCreate).success, false, 'a canceled old create must not claim the new same-name owner')
    assert.equal(mindcraft.getAgentProcess('reused-name'), newOwner)
    assert.equal(newOwner.desiredState, 'running')
    const metadata = await new Promise(resolve => controlSocket.emit('get-settings', 'reused-name', resolve))
    const stable = value => Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
        : value
    const expectedFingerprint = require('node:crypto').createHash('sha256').update(JSON.stringify(stable(metadata.settings))).digest('hex')
    assert.equal(metadata.settings.profile.name, 'reused-name')
    assert.equal(metadata.settings.place_memory_enabled, true)
    assert.equal(metadata.settings.place_world_id, WORLD_A)
    assert.equal(metadata.settings.place_state_dir, undefined, 'private store root path stays server-owned')
    assert.equal(metadata.settings.bot_rules_file, path.join(fixtureRoot, 'BOT_RULES.md'), 'root rules path overrides individual settings')
    assert.match(metadata.management.generation, /^[0-9a-f-]{36}$/i)
    assert.equal(metadata.management.agentName, 'reused-name')
    assert.equal(metadata.management.placeMemoryEnabled, true)
    assert.equal(metadata.management.placeWorldId, WORLD_A)
    assert.equal(metadata.management.settingsFingerprint, expectedFingerprint)
    let releaseStopAllGate
    globalThis.__fixtureServerGate = new Promise(resolve => { releaseStopAllGate = resolve })
    const pendingAtStopAll = mindcraft.createAgent(settings('pending-stop-all'))
    const stoppedBeforeSpawn = await mindcraft.stopAllAgents('fixture-ui-stop-all')
    assert.equal(stoppedBeforeSpawn.groupsGone, true)
    releaseStopAllGate()
    assert.equal((await pendingAtStopAll).success, false, 'UI stop-all cancels pending creations without permanently closing the hub')
    globalThis.__fixtureServerGate = null

    const endingCreated = await mindcraft.createAgent(settings('ending'))
    const siblingCreated = await mindcraft.createAgent(settings('sibling'))
    assert.equal(endingCreated.success, true)
    assert.equal(siblingCreated.success, true)
    endSupervisor = mindcraft.getAgentProcess('ending')
    const siblingSupervisor = mindcraft.getAgentProcess('sibling')
    fixtureSupervisors.push(endSupervisor, siblingSupervisor)

    // A disconnected management client still restarts through the parent supervisor.
    const initialSiblingGeneration = siblingSupervisor.generation
    controlSocket.emit('restart-agent', 'sibling')
    assert.equal(await waitUntil(() => siblingSupervisor.generation === initialSiblingGeneration + 1), true, 'UI restart must use the parent supervisor when no agent socket is connected')
    const settingsRestartGeneration = siblingSupervisor.generation
    controlSocket.emit('set-agent-settings', 'sibling', settings('sibling'))
    assert.equal(await waitUntil(() => siblingSupervisor.generation === settingsRestartGeneration + 1), true, 'settings changes must restart through the parent supervisor')

    let queuedGate
    fixtureStore.queue = new Promise(resolve => { queuedGate = resolve })
    const acceptedWrite = fixtureStore.rememberPlace({ name: 'Hub shutdown accepted write', kind: 'base', position: { x: 9, y: 64, z: 4 } })
    acceptedWrite.then(() => order.push('queued-write-complete'))
    assert.equal(await waitUntil(() => require('node:fs').existsSync(endingMarker)), true, 'task-ending agent should start a descendant before exiting')
    assert.equal(await waitUntil(() => require('node:fs').existsSync(grandchildMarker)), true)
    const grandchildPid = Number(await readFile(grandchildMarker, 'utf8'))
    const leaderPid = endSupervisor.process.pid
    const knownReader = endSupervisor.readIdentity
    knownEndReader = knownReader
    endSupervisor.readIdentity = async pid => pid === leaderPid
      ? { unknown: true, error: new Error('fixture identity unavailable') }
      : knownReader(pid)
    let resolveIncomplete
    const incompleteAttempt = new Promise(resolve => { resolveIncomplete = resolve })
    const originalShutdown = endSupervisor.shutdown.bind(endSupervisor)
    endSupervisor.shutdown = (...args) => {
      const promise = originalShutdown(...args)
      promise.then(outcome => { if (outcome?.groupsGone === false) resolveIncomplete(outcome) })
      return promise
    }
    endSupervisor.process.send({ type: 'fixture-fail-task' })
    assert.equal(await waitUntil(() => require('node:fs').existsSync(siblingMarker)), true, 'task-ending lifecycle must stop the sibling agent')
    assert.equal(await waitUntil(() => endSupervisor.outcome?.state === 'task-ending'), true)
    await incompleteAttempt
    await delay(50)
    assert.equal(await fileExists(path.join(fixtureRoot, 'state/.place-store.lock')), true, 'uncertain owned group keeps the shared place lock held')
    assert.equal(globalThis.__fixtureSocketServer.server.listening, true, 'transport remains open while group ownership is uncertain')
    assert.equal(fakeExitCode, undefined, 'parent waits for a confirmed group cleanup')
    assert.equal(await processAlive(grandchildPid), true, 'unknown identity must not signal a possibly reused process group')

    endSupervisor.readIdentity = knownReader
    const retry = mindcraft.shutdown({ reason: 'fixture-retry', exitCode: 2 })
    assert.equal(await waitUntil(() => fixtureStore.closing), true, 'the retry drains accepted writes after agent groups are gone')
    assert.equal(await fileExists(path.join(fixtureRoot, 'state/.place-store.lock')), true, 'accepted queued writes keep the lock until drained')
    queuedGate()
    await acceptedWrite
    const store = await retry
    assert.equal(store.closed, true)
    assert.equal(await waitUntil(() => fakeExitCode === 2), true)
    assert.equal(await processAlive(grandchildPid), false)
    assert.equal(await fileExists(path.join(fixtureRoot, 'state/.place-store.lock')), false)
    const persisted = JSON.parse(await readFile(path.join(fixtureRoot, 'state/worlds', `${WORLD_A}.json`), 'utf8'))
    assert.equal(persisted.places[0].name, 'Hub shutdown accepted write')
    assert.deepEqual(order, ['queued-write-complete', 'transport-close', 'exit:2'])
    assert.equal(siblingSupervisor.outcome?.groupsGone, true)
    return { duplicateCreateRejected: true, pendingDestroyBlockedLateSpawn: true, midStartStopWaitedForRealGroup: true, newOwnerSurvivedLateOldCreate: true, settingsMetadataMatched: true, stopAllCanceledPendingCreate: true, explicitRestartUsedParent: true, settingsRestartUsedParent: true, taskEndingStoppedSibling: true, ownedGroupFailureHeldLock: true, retryDrainedStoreBeforeTransportClose: true }
  } finally {
    if (endSupervisor && knownEndReader) endSupervisor.readIdentity = knownEndReader
    for (const supervisor of fixtureSupervisors) {
      try { await supervisor.stop('fixture-cleanup') } catch {}
    }
    if (releaseQueuedWrite) releaseQueuedWrite()
    if (fixtureStore && !fixtureStore.closed) {
      try { await fixtureStore.close() } catch {}
    }
    if (globalThis.__fixtureSocketServer?.server?.listening) {
      await new Promise(resolve => globalThis.__fixtureSocketServer.server.close(resolve))
    }
    process.exitCode = previousExitCode
    for (const key of ['__fixtureProcess', '__fixtureOrder', '__fixtureAgentEntry', '__fixtureServerGate', '__fixtureSocketServer', '__fixtureStartGates']) delete globalThis[key]
    process.chdir(previousCwd)
  }
}

async function processAlive(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[0])
  } catch { return false }
}

async function fileExists(file) {
  try { await readFile(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return Boolean(await predicate())
}

const { pathToFileURL } = require('node:url')
main().catch((error) => { console.error(error); process.exitCode = 1 })
