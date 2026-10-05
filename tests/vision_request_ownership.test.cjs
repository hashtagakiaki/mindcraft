'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mindcraft-vision-owner-'))
  try {
    const sourcePath = path.resolve(__dirname, '../src/agent/vision/vision_interpreter.js')
    const fixtureSource = path.join(root, 'src/agent/vision')
    const vec3Path = path.join(root, 'node_modules/vec3')
    await fs.mkdir(fixtureSource, { recursive: true })
    await fs.mkdir(vec3Path, { recursive: true })
    await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}')
    await fs.writeFile(path.join(fixtureSource, 'vision_interpreter.js'), await fs.readFile(sourcePath))
    await fs.writeFile(path.join(fixtureSource, 'camera.js'), 'export class Camera {}')
    await fs.writeFile(path.join(vec3Path, 'package.json'), '{"type":"module","exports":"./index.js"}')
    await fs.writeFile(path.join(vec3Path, 'index.js'), 'export class Vec3 { constructor(x,y,z) { Object.assign(this,{x,y,z}) } }')
    const { VisionInterpreter } = await import(pathToFileURL(path.join(fixtureSource, 'vision_interpreter.js')).href)
    await fs.writeFile(path.join(root, 'capture.jpg'), Buffer.from('fixture image'))
    const controller = new AbortController()
    const context = { actionId: 'vision-action', taskId: 'vision-task', signal: controller.signal }
    let received
    const agent = {
      name: 'Fixture', bot: { blockAtCursor: () => null }, history: { getHistory: () => [] },
      actions: { getCancellationContext: () => context },
      prompter: { promptVision: async (_messages, image, options) => { received = { image, options }; return 'fixture analysis' } },
    }
    const interpreter = new VisionInterpreter(agent, false)
    interpreter.fp = root
    const result = await interpreter.analyzeImage('capture')
    assert.match(result, /fixture analysis/)
    assert.equal(received.options.signal, controller.signal, 'vision SDK caller passes its owned cancellation signal to the provider path')
    assert.equal(received.options.context, context)
    assert.equal(received.image.toString(), 'fixture image')
    console.log('vision request ownership fixture passed')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
