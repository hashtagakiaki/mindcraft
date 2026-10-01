'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { createRequire } = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const upstreamModules = '/home/akito/workspace/project/minecraft-autonomy/mindcraft-eval/runtime/upstream/node_modules'
const dependencyRequire = createRequire(path.join(upstreamModules, 'package.json'))
const { Server } = dependencyRequire('socket.io')
const { io: connect } = dependencyRequire('socket.io-client')
const WORLD_ID = '33333333-3333-4333-8333-333333333333'

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-place-rpc-test-'))
  const sourceStoreUrl = pathToFileURL(path.join(__dirname, '../src/mindcraft/place_store.js')).href
  const sourceRpcUrl = pathToFileURL(path.join(__dirname, '../src/mindcraft/place_rpc.js')).href
  const { PlaceStore, attachPlaceStoreLifecycle } = await import(sourceStoreUrl)
  const { attachPlaceRpc, requestPlaceRpc } = await import(sourceRpcUrl)
  const stateDir = path.join(temp, 'global-state')
  let store
  let io
  const clients = []
  try {
    store = await PlaceStore.open({ stateDir, worldId: WORLD_ID })
    const httpServer = require('node:http').createServer()
    io = new Server(httpServer)
    io.on('connection', (socket) => {
      let registeredName = null
      socket.on('test:register-agent', (name, ack) => {
        registeredName = ['botA', 'botB', 'botC', 'botD'].includes(name) ? name : null
        ack({ ok: Boolean(registeredName) })
      })
      attachPlaceRpc(socket, {
        getAgentName: () => registeredName,
        getPlaceStore: async () => store
      })
    })
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    const address = httpServer.address()
    for (let index = 0; index < 4; index++) {
      const client = connect(`http://127.0.0.1:${address.port}`, { forceNew: true, reconnection: false, timeout: 2000 })
      clients.push(client)
    }
    await Promise.all(clients.map((client) => new Promise((resolve, reject) => {
      client.once('connect', resolve)
      client.once('connect_error', reject)
    })))

    const ask = (client, event, payload) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${event} acknowledgement timed out`)), 2000)
      client.emit(event, payload, (response) => { clearTimeout(timeout); resolve(response) })
    })
    const unauthorized = await ask(clients[0], 'place:request', { operation: 'query', payload: {} })
    assert.equal(unauthorized.error.code, 'UNREGISTERED_SOCKET')
    const requestEnvelope = await requestPlaceRpc({ emit(_event, request, ack) { ack({ ok: true, value: request.payload, revision: 1 }) } }, 'query', { dimension: 'overworld' }, 0, 50)
    assert.deepEqual(requestEnvelope.value, { dimension: 'overworld' })
    await assert.rejects(requestPlaceRpc({ emit(_event, _request, ack) { ack({ ok: false, error: { code: 'REVISION_CONFLICT', message: 'stale' } }) } }, 'relation', {}, undefined, 50), { code: 'REVISION_CONFLICT' })
    await assert.rejects(requestPlaceRpc({ emit() {} }, 'query', {}, undefined, 15), { code: 'RPC_TIMEOUT' })

    const registerResponses = await Promise.all(clients.map((client, index) => ask(client, 'test:register-agent', `bot${String.fromCharCode(65 + index)}`)))
    assert.ok(registerResponses.every((response) => response.ok))
    const mutations = await Promise.all(clients.map((client, index) => ask(client, 'place:request', {
      operation: 'remember',
      payload: {
        place: { name: `Shared place ${index}`, kind: 'base', purposes: ['meeting'], position: { x: index * 8, y: 64, z: 0 } },
        // Client-provided scope fields are ignored; this request stays in the configured world ledger.
        place_state_dir: path.join(temp, 'attacker-state'),
        place_world_id: '44444444-4444-4444-8444-444444444444'
      }
    })))
    assert.ok(mutations.every((response) => response.ok))
    assert.deepEqual(mutations.map((response) => response.revision).sort((a, b) => a - b), [1, 2, 3, 4])
    const queries = await Promise.all(clients.map((client) => ask(client, 'place:request', {
      operation: 'query', payload: { purpose: 'meeting', place_state_dir: '/tmp/ignored', worldId: 'ignored' }
    })))
    assert.ok(queries.every((response) => response.ok && response.value.length === 4 && response.revision === 4))
    const missingPlace = await ask(clients[0], 'place:request', { operation: 'get', payload: { placeId: 'missing-place' } })
    const missingInspection = await ask(clients[1], 'place:request', { operation: 'inspect', payload: { placeId: 'missing-place' } })
    assert.deepEqual(missingPlace, { ok: true, value: null, revision: 4 })
    assert.deepEqual(missingInspection, { ok: true, value: null, revision: 4 })
    assert.equal(await pathExists(path.join(temp, 'attacker-state')), false, 'scope override never initializes another directory')

    const homeA = (await store.rememberPlace({ name: 'A home', kind: 'base', position: { x: -20, y: 64, z: 0 } })).value
    const homeB = (await store.rememberPlace({ name: 'B home', kind: 'base', position: { x: -40, y: 64, z: 0 } })).value
    assert.ok((await ask(clients[0], 'place:request', { operation: 'alias', payload: { alias: 'Home', placeId: homeA.id, agentName: 'botB' } })).ok)
    assert.ok((await ask(clients[1], 'place:request', { operation: 'alias', payload: { alias: 'Home', placeId: homeB.id, agentName: 'botA' } })).ok)
    assert.ok((await ask(clients[0], 'place:request', { operation: 'preference', payload: { homePlaceId: homeA.id, agentName: 'botB' } })).ok)
    assert.ok((await ask(clients[1], 'place:request', { operation: 'preference', payload: { homePlaceId: homeB.id, agentName: 'botA' } })).ok)
    const [botAHome, botBHome, botAPreferences, botBPreferences] = await Promise.all([
      ask(clients[0], 'place:request', { operation: 'resolve_alias', payload: { alias: 'home', agentName: 'botB' } }),
      ask(clients[1], 'place:request', { operation: 'resolve_alias', payload: { alias: 'home', agentName: 'botA' } }),
      ask(clients[0], 'place:request', { operation: 'preferences', payload: { agentName: 'botB' } }),
      ask(clients[1], 'place:request', { operation: 'preferences', payload: { agentName: 'botA' } })
    ])
    assert.equal(botAHome.value.id, homeA.id)
    assert.equal(botBHome.value.id, homeB.id)
    assert.equal(botAPreferences.value.homePlaceId, homeA.id)
    assert.equal(botBPreferences.value.homePlaceId, homeB.id)

    const farm = (await store.rememberPlace({ name: 'Garden', kind: 'farm', purposes: ['food'], position: { x: 20, y: 64, z: 0 } })).value
    const chest = (await store.rememberPlace({ name: 'Garden storage', kind: 'storage', purposes: ['food'], position: { x: 21, y: 64, z: 0 } })).value
    const linked = await ask(clients[0], 'place:request', {
      operation: 'relation', payload: { fromPlaceId: farm.id, toPlaceId: chest.id, source: 'user' }
    })
    assert.ok(linked.ok)
    assert.equal(linked.value.toPlaceId, chest.id)
    const inspect = await ask(clients[1], 'place:request', { operation: 'inspect', payload: { placeId: farm.id } })
    assert.ok(inspect.ok)
    assert.equal(inspect.value.outputStorage.id, chest.id)
    assert.equal(inspect.value.revision, inspect.revision)
    assert.equal(inspect.value.revision, store.revision)

    const conflict = await ask(clients[2], 'place:request', {
      operation: 'relation', payload: { fromPlaceId: farm.id, toPlaceId: chest.id }, expectedRevision: 1
    })
    assert.equal(conflict.error.code, 'REVISION_CONFLICT')

    const failedStartupRpc = await attachFailureProbe(attachPlaceRpc)
    assert.equal(failedStartupRpc, 'startup error fixture attached')
    await verifyRpcShutdownAdmission(attachPlaceRpc, store)

    await Promise.all(clients.map((client) => new Promise((resolve) => { client.once('disconnect', resolve); client.close() })))
    await new Promise((resolve) => io.close(resolve))
    io = null
    const storeForSignalTest = store
    store = null
    await storeForSignalTest.close()
    assert.equal(await pathExists(path.join(stateDir, '.place-store.lock')), false)
    const reopened = await PlaceStore.open({ stateDir, worldId: WORLD_ID })
    assert.equal(reopened.queryPlaces({ purpose: 'meeting' }).length, 4)
    await reopened.close()

    await verifySignalShutdown(temp, sourceStoreUrl)
    console.log('place_rpc.test.cjs: four-client RPC, scope isolation, restart, startup error, and signal lock release passed')
  } finally {
    await Promise.all(clients.map((client) => new Promise((resolve) => { client.close(); resolve() })))
    if (io) await new Promise((resolve) => io.close(resolve))
    if (store) await store.close()
    await rm(temp, { recursive: true, force: true })
  }
}

async function attachFailureProbe(attachPlaceRpc) {
  // Use the same dispatcher directly with a failed store provider to assert initialization errors reach RPC callers.
  const events = new Map()
  const fakeSocket = { on(event, handler) { events.set(event, handler) } }
  attachPlaceRpc(fakeSocket, {
    getAgentName: () => 'botA',
    getPlaceStore: async () => { throw Object.assign(new Error('Place store configuration is incomplete'), { code: 'INVALID_CONFIG' }) }
  })
  const response = await new Promise((resolve) => events.get('place:request')({ operation: 'query', payload: {} }, resolve))
  assert.equal(response.error.code, 'INVALID_CONFIG')
  return 'startup error fixture attached'
}

async function verifyRpcShutdownAdmission(attachPlaceRpc, store) {
  const events = new Map()
  let closing = false
  let releaseStoreProvider
  const providerStarted = new Promise((resolve) => {
    releaseStoreProvider = resolve
  })
  let finishStoreProvider
  const storeProvider = new Promise((resolve) => { finishStoreProvider = resolve })
  const fakeSocket = { on(event, handler) { events.set(event, handler) } }
  attachPlaceRpc(fakeSocket, {
    getAgentName: () => 'botA',
    getPlaceStore: () => { releaseStoreProvider(); return storeProvider },
    isClosing: () => closing
  })
  const handler = events.get('place:request')
  const inFlight = new Promise((resolve) => handler({ operation: 'remember', payload: { place: { name: 'Rejected in flight', kind: 'base', position: { x: 90, y: 64, z: 90 } } } }, resolve))
  await providerStarted
  closing = true
  finishStoreProvider(store)
  assert.equal((await inFlight).error.code, 'SERVER_SHUTTING_DOWN', 'mutation awaiting store admission is rejected after shutdown begins')
  const afterClosing = await new Promise((resolve) => handler({ operation: 'remember', payload: { place: { name: 'Rejected after close', kind: 'base', position: { x: 91, y: 64, z: 90 } } } }, resolve))
  assert.equal(afterClosing.error.code, 'SERVER_SHUTTING_DOWN', 'new mutation is rejected once shutdown begins')
}

async function verifySignalShutdown(temp, storeUrl) {
  for (const [signal, expectedCode, worldId] of [
    ['SIGINT', 130, '55555555-5555-4555-8555-555555555555'],
    ['SIGTERM', 143, '66666666-6666-4666-8666-666666666666']
  ]) {
    await verifyOneSignalShutdown(temp, storeUrl, signal, expectedCode, worldId)
  }
}

async function verifyOneSignalShutdown(temp, storeUrl, signal, expectedCode, worldId) {
  const stateDir = path.join(temp, `signal-state-${signal.toLowerCase()}`)
  const script = path.join(temp, `signal-child-${signal.toLowerCase()}.mjs`)
  const childSource = `
    import http from 'node:http';
    import { PlaceStore, attachPlaceStoreLifecycle } from ${JSON.stringify(storeUrl)};
    const stateDir = ${JSON.stringify(stateDir)};
    const worldId = ${JSON.stringify(worldId)};
    const storePromise = PlaceStore.open({ stateDir, worldId });
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const socketServer = { close(callback) {
        import('node:fs/promises').then(async ({ access }) => {
          try { await access(stateDir + '/.place-store.lock'); console.log('LOCK_STILL_PRESENT_AT_HTTP_CLOSE'); }
          catch (error) { if (error.code === 'ENOENT') console.log('LOCK_RELEASED_BEFORE_HTTP_CLOSE'); else throw error; }
          server.close(callback);
        });
      } };
      attachPlaceStoreLifecycle({ server, socketServer, storePromise });
      console.log('SIGNAL_TEST_READY');
    });
  `
  await writeFile(script, childSource)
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  try {
    await waitFor(() => stdout.includes('SIGNAL_TEST_READY'), 3000, () => `child did not start: ${stdout} ${stderr}`)
    child.kill(signal)
    const result = await waitForExit(child, 3000)
    assert.deepEqual(result, { code: expectedCode, signal: null }, `child shutdown result for ${signal}; stderr: ${stderr}`)
    assert.ok(stdout.includes('LOCK_RELEASED_BEFORE_HTTP_CLOSE'), `store lock must be released before HTTP close callback for ${signal}; stdout: ${stdout}; stderr: ${stderr}`)
    assert.ok(!stdout.includes('LOCK_STILL_PRESENT_AT_HTTP_CLOSE'), `store lock remained at HTTP close for ${signal}`)
    const { PlaceStore } = await import(storeUrl)
    const reopened = await PlaceStore.open({ stateDir, worldId })
    await reopened.close()
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

function waitFor(predicate, timeoutMs, errorMessage) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve()
      if (Date.now() - started >= timeoutMs) return reject(new Error(typeof errorMessage === 'function' ? errorMessage() : errorMessage))
      setTimeout(check, 10)
    }
    check()
  })
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('signal test child did not exit')), timeoutMs)
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }) })
  })
}

async function pathExists(file) {
  try { await require('node:fs/promises').stat(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
