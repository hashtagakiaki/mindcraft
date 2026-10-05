'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

async function main() {
  const { createStatePoller } = await import(pathToFileURL(path.resolve(__dirname, '../src/mindcraft/state_poller.js')).href)
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  let connections
  let events = []
  let badCalls = 0
  let respondMissing = true
  const good = { in_game: true, socket: { connected: true, emit: (event, callback) => callback({ gameplay: { health: 20 } }) } }
  const missing = { in_game: true, socket: { connected: true, emit: (_event, callback) => {
    if (respondMissing) callback({ gameplay: { hunger: 20 } })
    else badCalls++
  } } }
  connections = { good, missing }
  const poller = createStatePoller({ getConnections: () => connections, emit: state => events.push(state), intervalMs: 4, ackTimeoutMs: 15 })
  poller.start()
  const firstPollDeadline = Date.now() + 100
  while (!events.length && Date.now() < firstPollDeadline) await delay(1)
  assert.ok(events.length >= 1)
  assert.equal(events[0].missing._freshness.status, 'fresh')
  respondMissing = false
  const staleDeadline = Date.now() + 100
  while (!events.some(event => event.missing._freshness.status === 'stale') && Date.now() < staleDeadline) await delay(1)
  poller.stop()
  assert.equal(events[0].good._freshness.status, 'fresh', 'one bot updates while a second bot with missing ACK times out')
  const stale = events.find(event => event.missing._freshness.status === 'stale')
  assert.equal(stale.missing.gameplay.hunger, 20, 'last known bot state remains available but marked stale')
  assert.ok(badCalls >= 1)
  const callsAtStop = badCalls
  await delay(25)
  assert.equal(badCalls, callsAtStop, 'last-listener stop clears future polling')

  events = []
  let releaseOld
  const oldConnection = { in_game: true, socket: { connected: true, emit: (_event, callback) => { releaseOld = callback } } }
  connections = { bot: oldConnection }
  const replacementPoller = createStatePoller({ getConnections: () => connections, emit: state => events.push(state), intervalMs: 100, ackTimeoutMs: 60 })
  replacementPoller.start()
  await delay(1)
  connections = { bot: { in_game: true, socket: { connected: true, emit: (_event, callback) => callback({ marker: 'new-socket' }) } } }
  releaseOld({ marker: 'old-socket' })
  await delay(5)
  replacementPoller.stop()
  assert.equal(events[0].bot.marker, undefined, 'a delayed old-connection state is never accepted')
  assert.equal(events[0].bot._freshness.status, 'unknown')

  events = []
  let releaseStopped
  connections = { bot: { in_game: true, socket: { connected: true, emit: (_event, callback) => { releaseStopped = callback } } } }
  const stoppedPoller = createStatePoller({ getConnections: () => connections, emit: state => events.push(state), ackTimeoutMs: 100 })
  stoppedPoller.start()
  await delay(1)
  stoppedPoller.stop()
  releaseStopped({ marker: 'after-stop' })
  await delay(2)
  assert.deepEqual(events, [], 'callback from an invalidated listener generation is discarded')
  console.log('State poller fixtures passed: single-flight timeout, per-bot freshness, connection replacement, listener stop')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
