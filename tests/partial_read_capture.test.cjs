'use strict'

const assert = require('node:assert/strict')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

async function main() {
  const captureModulePath = process.argv[2]
  assert.ok(captureModulePath, 'pass the source module path')
  const { capturePartialReadErrors } = await import(pathToFileURL(captureModulePath))
  const originalCwd = process.cwd()
  const temp = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-partial-read-'))
  const oldWarn = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args)

  try {
    process.chdir(temp)
    const partialRead = Object.assign(new Error('synthetic short frame'), { partialReadError: true })
    const parser = {
      proto: { read: () => ({ value: 0x2a, size: 1 }) },
      parsePacketBuffer(frame) {
        if (frame[0] === 0xff) throw partialRead
        return { data: frame[0] }
      }
    }
    const client = {
      state: 'play',
      deserializer: parser,
      setSerializer() {
        this.deserializer = {
          proto: { read: () => ({ value: 0x2b, size: 1 }) },
          parsePacketBuffer() { throw partialRead }
        }
      }
    }
    const bot = { username: 'Bot/One', version: '1.21.1', _client: client }
    capturePartialReadErrors(bot)

    const frame = Buffer.from([0xff, 0x01, 0x02])
    assert.throws(() => parser.parsePacketBuffer(frame), error => error === partialRead)
    assert.throws(() => parser.parsePacketBuffer(frame), error => error === partialRead)
    assert.deepEqual(parser.parsePacketBuffer(Buffer.from([0x01])), { data: 0x01 })

    const logPath = path.join(temp, 'bots', 'Bot_One', 'logs', 'partial-read-errors.jsonl')
    const records = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(records.length, 1, 'identical frames should be deduplicated')
    assert.equal(records[0].bot, 'Bot/One')
    assert.equal(records[0].clientVersion, '1.21.1')
    assert.equal(records[0].protocolState, 'play')
    assert.equal(records[0].direction, 'server-to-client')
    assert.equal(records[0].packetId, 0x2a)
    assert.equal(records[0].frameLength, frame.length)
    assert.equal(records[0].frameHex, frame.toString('hex'))
    assert.match(records[0].frameSha256, /^[a-f0-9]{64}$/)
    assert.equal(warnings.length, 1)

    client.setSerializer('play')
    assert.throws(() => client.deserializer.parsePacketBuffer(Buffer.from([0xfe, 0x01])), error => error === partialRead)
    const updatedRecords = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(updatedRecords.length, 2, 'replacement protocol-state parsers should also be instrumented')
    assert.equal(updatedRecords[1].packetId, 0x2b)
    console.log('partial read frame capture tests passed')
  } finally {
    console.warn = oldWarn
    process.chdir(originalCwd)
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
