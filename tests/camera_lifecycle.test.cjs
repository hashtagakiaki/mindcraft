'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const { pathToFileURL } = require('node:url')

async function main() {
  const sourceRoot = path.resolve(__dirname, '..')
  const dependencyRoot = path.resolve(__dirname, '../../mindcraft-eval/runtime/upstream/node_modules')
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mindcraft-camera-lifecycle-'))
  await fs.symlink(dependencyRoot, path.join(fixtureRoot, 'node_modules'), 'dir')
  await fs.copyFile(path.join(sourceRoot, 'src/agent/vision/camera.js'), path.join(fixtureRoot, 'camera.js'))
  const { Camera, CAMERA_MAX_JPEG_BYTES } = await import(pathToFileURL(path.join(fixtureRoot, 'camera.js')).href)
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  let releasePosition
  let written = []
  let disposed = 0
  const makeDependencies = ({ updatePosition = async () => {}, stream = () => Readable.from([Buffer.from('jpeg')]), createWorldView = null } = {}) => ({
    canvas: { createJPEGStream: () => stream() },
    renderer: { render() {}, dispose() { disposed++ } },
    viewer: { camera: { position: { set() {} } }, setVersion() {}, listen() {}, setFirstPersonCamera() {}, update() {} },
    createWorldView: createWorldView || (() => ({ async init() {}, listenToBot() {}, removeListenersFromBot() {}, updatePosition })),
    ensureDirectory: async () => {}, writeFile: async (_name, bytes) => { written.push(bytes); },
  })
  const bot = { version: 'fixture', world: {}, entity: { position: { x: 0, y: 64, z: 0 }, height: 1.6, yaw: 0, pitch: 0 } }
  try {
    let releaseInit
    let positioned = false
    const beforeReady = new Camera(bot, '/tmp/fixture', makeDependencies({ updatePosition: async () => { positioned = true },
      createWorldView: () => ({ init: () => new Promise(resolve => { releaseInit = resolve }), listenToBot() {}, updatePosition: async () => { positioned = true } }) }))
    const waitingCapture = beforeReady.capture()
    await delay(0)
    assert.equal(positioned, false, 'capture requested before readiness cannot touch renderer state')
    releaseInit()
    await beforeReady.ready
    assert.match(await waitingCapture, /^screenshot_/, 'capture waits for world-view initialization before rendering')
    assert.equal(positioned, true)
    await beforeReady.close()
    written = []

    const failedReady = new Camera(bot, '/tmp/fixture', makeDependencies({ createWorldView: () => ({ async init() { throw new Error('fixture world init failed') }, listenToBot() {} }) }))
    await assert.rejects(failedReady.ready, /fixture world init failed/, 'initialization failure is exposed through ready')
    await assert.rejects(failedReady.capture(), /fixture world init failed/)
    await failedReady.close()

    const slow = new Camera(bot, '/tmp/fixture', makeDependencies({ updatePosition: () => new Promise(resolve => { releasePosition = resolve }) }))
    await slow.ready
    const controller = new AbortController()
    const capture = slow.capture({ signal: controller.signal })
    await delay(0)
    await assert.rejects(slow.capture(), /already in progress/, 'parallel captures are rejected rather than queued')
    controller.abort(new Error('fixture cancelled'))
    releasePosition()
    await assert.rejects(capture, /fixture cancelled/, 'cancelled capture cannot publish an image')
    assert.equal(written.length, 0)
    await slow.close()

    let streaming
    const streamCamera = new Camera(bot, '/tmp/fixture', makeDependencies({ stream: () => {
      streaming = new Readable({ read() { this.push(Buffer.from('partial-jpeg')); this._read = () => {} } })
      return streaming
    } }))
    await streamCamera.ready
    const streamCancel = new AbortController()
    const streamedCapture = streamCamera.capture({ signal: streamCancel.signal })
    await delay(0)
    assert.ok(streaming, 'fake JPEG stream is active')
    streamCancel.abort(new Error('fixture stream cancellation'))
    await assert.rejects(streamedCapture, /fixture stream cancellation/)
    assert.equal(written.length, 0, 'cancelled stream cannot publish a partial JPEG')
    await streamCamera.close()

    const overLimit = new Camera(bot, '/tmp/fixture', makeDependencies({ stream: () => Readable.from([Buffer.alloc(CAMERA_MAX_JPEG_BYTES + 1)]) }))
    await overLimit.ready
    await assert.rejects(overLimit.capture(), /exceeds/, 'JPEG byte cap is enforced during streaming')
    await overLimit.close()

    let releaseDrain
    const draining = new Camera(bot, '/tmp/fixture', makeDependencies({ updatePosition: () => new Promise(resolve => { releaseDrain = resolve }) }))
    await draining.ready
    const pending = draining.capture()
    await delay(0)
    const closeResult = await draining.close({ drainTimeoutMs: 5 })
    assert.deepEqual(closeResult, { closed: true, drained: false }, 'close reports pending renderer work instead of claiming it drained')
    releaseDrain()
    await assert.rejects(pending, /closed/)
    await delay(0)
    assert.ok(disposed >= 3, 'renderer resources dispose after pending work settles')
    assert.equal(written.length, 0, 'closed/cancelled captures never write late screenshots')
    console.log('Camera fixtures passed: readiness, concurrent rejection, cancellation, image bound, bounded close/drain')
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
