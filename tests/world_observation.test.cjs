'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { moduleRoot } = require('./dependency_root.cjs')

async function main() {
  const repo = path.resolve(__dirname, '..')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mindcraft-world-observation-'))
  try {
    await fs.mkdir(path.join(root, 'src/agent/library'), { recursive: true })
    await fs.mkdir(path.join(root, 'src/agent'), { recursive: true })
    await fs.mkdir(path.join(root, 'src/utils'), { recursive: true })
    await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}')
    await fs.writeFile(path.join(root, 'settings.js'), 'export default {};')
    await fs.writeFile(path.join(root, 'src/agent/settings.js'), 'export default {};')
    await fs.writeFile(path.join(root, 'src/agent/conversation.js'), 'export default { getInGameAgents() { return [] } };')
    await fs.writeFile(path.join(root, 'src/utils/mcdata.js'), `
export function getBlockId() { return 1; }
export function getAllBlockIds() { return []; }
export function getAllBiomes() { return [{ name: 'plains' }]; }
`)
    for (const file of ['world.js', 'observation_scope.js', 'full_state.js']) {
      await fs.copyFile(path.join(repo, 'src/agent/library', file), path.join(root, 'src/agent/library', file))
    }
    await fs.symlink(moduleRoot(), path.join(root, 'node_modules'))
    const load = relative => import(pathToFileURL(path.join(root, relative)))
    const world = await load('src/agent/library/world.js')
    const { createObservationScope } = await load('src/agent/library/observation_scope.js')
    const { getFullState } = await load('src/agent/library/full_state.js')
    const position = { x: 3, y: 64, z: -2, offset(dx, dy, dz) { return { x: this.x + dx, y: this.y + dy, z: this.z + dz } } }
    const bot = {
      entity: { position },
      game: { dimension: 'overworld', gameMode: 'survival' },
      time: { timeOfDay: 1000 },
      inventory: { slots: [], items: () => [] },
      entities: {},
      world: { getBiome: () => 0 },
      health: 20,
      food: 20,
      modes: { getMiniDocs: () => [] },
      blockAt: () => null,
    }
    assert.equal(world.getBlockAtPosition(bot, 0, 0, 0), null, 'unloaded block remains null instead of fabricated air')
    assert.deepEqual(world.getSurroundingBlocks(bot), [
      'Block Below: unknown', 'Block at Legs: unknown', 'Block at Head: unknown',
    ])
    assert.equal(world.getFirstBlockAboveHead(bot, null, 4), 'unknown', 'an unloaded gap ends the scan as unknown')

    let lookedAt = 0
    bot.blockAt = () => ++lookedAt === 1 ? { name: 'air' } : null
    assert.equal(world.getFirstBlockAboveHead(bot, null, 4), 'unknown', 'a higher solid cannot be claimed past an unknown gap')
    bot.blockAt = point => point.y === 66 ? { name: 'air' } : point.y === 67 ? { name: 'stone' } : null
    assert.equal(world.getFirstBlockAboveHead(bot, null, 4), 'stone (1 blocks up)', 'known air and solid blocks retain their prior result')

    const observationScope = createObservationScope(bot, { connectionGeneration: 7, serverGeneration: 'hub-generation-1', ready: true })
    assert.match(observationScope.observedAt, /^\d{4}-\d\d-\d\dT/)
    assert.equal(observationScope.dimension, 'overworld')
    assert.equal(observationScope.worldConnectionGeneration, null, 'management generation is not presented as a Minecraft connection generation')
    assert.equal(observationScope.managementConnectionGeneration, 7)
    assert.equal(observationScope.managementConnectionReady, true)
    assert.equal(observationScope.managementServerGeneration, 'hub-generation-1')
    const staleManagement = createObservationScope(bot, { connectionGeneration: 7, serverGeneration: 'old-hub-generation', ready: false })
    assert.equal(staleManagement.managementConnectionReady, false)
    assert.equal(staleManagement.managementServerGeneration, null, 'stale management server generation is not exposed as ready')
    bot.blockAt = () => null
    const state = getFullState({ name: 'FixtureBot', bot, isIdle: () => true, actions: {} }, {
      connectionGeneration: 7, serverGeneration: 'hub-generation-1', ready: true,
    })
    assert.deepEqual(state.surroundings, {
      below: 'unknown', legs: 'unknown', head: 'unknown', firstBlockAboveHead: 'unknown',
    })
    assert.equal(state.observationScope.dimension, 'overworld')
    assert.equal(state.observationScope.managementConnectionGeneration, 7)
    assert.equal(state.observationScope.managementConnectionReady, true)
    console.log('world observation fixtures passed')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
