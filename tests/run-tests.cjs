'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const repo = path.resolve(__dirname, '..')
const node = process.execPath

async function write(root, relative, content) {
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
}

async function setupFarmFixture(root) {
  await write(root, 'package.json', '{"type":"module"}')
  await write(root, 'settings.js', 'export default { block_place_delay: 0 };')
  await write(root, 'src/agent/library/skills.js', await readFile(path.join(repo, 'src/agent/library/skills.js')))
  await write(root, 'src/agent/library/crafting_sync.js', await readFile(path.join(repo, 'src/agent/library/crafting_sync.js')))
  await write(root, 'src/agent/library/index.js', await readFile(path.join(repo, 'src/agent/library/index.js')))
  await write(root, 'src/agent/library/skill_library.js', await readFile(path.join(repo, 'src/agent/library/skill_library.js')))
  await write(root, 'src/utils/mcdata.js', 'export {};')
  await write(root, 'src/utils/math.js', 'export function cosineSimilarity() { return 0; }')
  await write(root, 'src/utils/text.js', 'export function wordOverlapScore() { return 0; }')
  await write(root, 'src/agent/library/world.js', `
export function getNearestBlocks(bot, types) {
  const scenario = globalThis.farmScenario;
  return Array.isArray(types) ? scenario.crops : types === 'farmland' ? scenario.farmland : [];
}
export function getNearestBlock(bot, type) {
  const scenario = globalThis.farmScenario;
  return type === 'chest' ? scenario.nearestChest : null;
}
export function getInventoryCounts() { return {}; }
export function getNearestFreeSpace() { return { x: 0, y: 0, z: 0 }; }
export function getPosition(bot) { return bot.entity.position; }
export function shouldPlaceTorch() { return false; }
`)
  await write(root, 'node_modules/vec3/package.json', '{"type":"module","exports":"./index.js"}')
  await write(root, 'node_modules/vec3/index.js', `
export default function Vec3(x, y, z) {
  return { x, y, z, plus(v) { return Vec3(x + v.x, y + v.y, z + v.z); }, offset(dx, dy, dz) { return Vec3(x + dx, y + dy, z + dz); }, toString() { return '(' + x + ', ' + y + ', ' + z + ')'; } };
}
`)
  await write(root, 'node_modules/mineflayer-pathfinder/package.json', '{"type":"module","exports":"./index.js"}')
  await write(root, 'node_modules/mineflayer-pathfinder/index.js', 'export default { goals: { GoalNear: class {} }, Movements: class {} };')
}

function block(name, age, x = 0) {
  return { name, position: { x, y: 0, z: 0, offset(dx, dy, dz) { return { x: x + dx, y: dy, z: dz } } }, diggable: true, getProperties: () => ({ age }) }
}

function makeBot(scenario) {
  const items = scenario.items.map(item => ({ ...item }))
  const bot = {
    output: '',
    entity: { position: { x: 0, y: 0, z: 0, distanceTo: () => 0 } },
    modes: { isOn: mode => mode === 'cheat' && scenario.cheat !== false },
    inventory: { items: () => items, slots: items },
    async equip(item) { this.heldItem = item },
    blockAt(position) {
      if (position.y === 1) return { name: 'air' }
      if (scenario.explicitChest && position.x === scenario.explicitChest.position.x && position.y === scenario.explicitChest.position.y && position.z === scenario.explicitChest.position.z) return scenario.explicitChest
      return { name: 'farmland', position }
    },
    chat() {},
    async activateBlock(block) { scenario.activations.push(block.position.x); if (this.heldItem?.name === 'wheat_seeds') this.heldItem.count-- },
    async dig(crop) {
      crop.diggable = false
      const produce = crop.name === 'wheat' ? [['wheat', 1], ['wheat_seeds', 1]] : [[crop.name.slice(0, -1), 1]]
      for (const [name, count] of produce) {
        const found = items.find(item => item.name === name)
        if (found) found.count += count
        else items.push({ name, type: name, count })
      }
    },
    async openContainer(chest) {
      scenario.opened.push(chest)
      return {
        async deposit(type, metadata, count) { if (scenario.depositReject) throw new Error('injected deposit failure'); scenario.deposits.push({ type, count }); const item = items.find(candidate => candidate.type === type || candidate.name === type); if (item) item.count -= count },
        async close() { scenario.closed++ }
      }
    }
  }
  return bot
}

async function testFarm(root) {
  await setupFarmFixture(root)
  const { tendNearbyFarm } = await import(pathToFileURL(path.join(root, 'src/agent/library/skills.js')))
  const { getSkillDocs } = await import(pathToFileURL(path.join(root, 'src/agent/library/index.js')))
  const { SkillLibrary } = await import(pathToFileURL(path.join(root, 'src/agent/library/skill_library.js')))

  const nearChest = { name: 'chest', position: { x: 8, y: 0, z: 0 } }
  const explicitChest = { name: 'trapped_chest', position: { x: 4, y: 0, z: 0 } }
  const scenario = {
    crops: [block('wheat', 7, 1), block('wheat', 3, 2)],
    farmland: [block('farmland', null, 3), block('farmland', null, 4)],
    items: [{ name: 'wheat_seeds', type: 'wheat_seeds', count: 1 }],
    nearestChest: nearChest,
    explicitChest,
    opened: [], deposits: [], closed: 0, activations: [], cheat: true
  }
  globalThis.farmScenario = scenario
  let bot = makeBot(scenario)
  let result = await tendNearbyFarm(bot, 16, 1, { x: 4.9, y: 0.5, z: 0.1 })
  assert.deepEqual(result, { harvested: 1, planted: 1, stored: 2 })
  assert.deepEqual(scenario.opened, [explicitChest])
  assert.equal(scenario.closed, 1)
  assert.deepEqual(scenario.deposits, [{ type: 'wheat', count: 1 }, { type: 'wheat_seeds', count: 1 }])
  assert.equal(bot.inventory.items().find(item => item.name === 'wheat_seeds').count, 1)
  assert.equal(scenario.crops[1].diggable, true, 'unripe crops remain untouched')

  scenario.crops = []
  scenario.farmland = [block('farmland', null, 11), block('farmland', null, 12)]
  scenario.items = [{ name: 'wheat_seeds', type: 'wheat_seeds', count: 2 }]
  scenario.opened = []; scenario.deposits = []; scenario.closed = 0; scenario.activations = []; scenario.cheat = false
  bot = makeBot(scenario)
  result = await tendNearbyFarm(bot, 16, 1)
  assert.equal(result.planted, 1)
  assert.deepEqual(scenario.activations, [11], 'normal-mode planting uses only seed inventory above reserve')
  assert.equal(bot.inventory.items().find(item => item.name === 'wheat_seeds').count, 1, 'one seed is consumed and reserve remains')

  scenario.crops = []
  scenario.farmland = []
  scenario.items = [{ name: 'carrot', type: 'carrot', count: 1 }]
  scenario.opened = []; scenario.deposits = []; scenario.closed = 0
  bot = makeBot(scenario)
  result = await tendNearbyFarm(bot, 16, 1)
  assert.deepEqual(result, { harvested: 0, planted: 0, stored: 0 })
  assert.deepEqual(scenario.opened, [], 'default chest is unused when there are no deposits')

  scenario.crops = [block('wheat', 7)]
  scenario.farmland = []
  scenario.items = []
  scenario.nearestChest = null
  scenario.opened = []; scenario.deposits = []; scenario.closed = 0
  bot = makeBot(scenario)
  result = await tendNearbyFarm(bot)
  assert.equal(result.harvested, 1)
  assert.match(bot.output, /Could not find a nearby chest/)
  assert.equal(scenario.closed, 0)

  scenario.crops = [block('wheat', 7)]
  scenario.items = []
  scenario.nearestChest = nearChest
  scenario.opened = []; scenario.deposits = []; scenario.closed = 0; scenario.cheat = true; scenario.depositReject = false
  bot = makeBot(scenario)
  result = await tendNearbyFarm(bot, 32, 0)
  assert.equal(result.stored, 2)
  assert.deepEqual(scenario.opened, [nearChest], 'default chest lookup is used')
  assert.equal(scenario.closed, 1, 'opened container is closed')

  scenario.crops = [block('wheat', 7)]
  scenario.items = []
  scenario.depositReject = true
  scenario.opened = []; scenario.deposits = []; scenario.closed = 0; scenario.cheat = true
  bot = makeBot(scenario)
  await assert.rejects(tendNearbyFarm(bot, 32, 0), /injected deposit failure/)
  assert.equal(scenario.closed, 1, 'container closes when a deposit fails')

  const docs = getSkillDocs()
  assert.ok(docs.some(doc => doc.startsWith('skills.tendNearbyFarm\n') && doc.includes('seedReserve')))
  const library = new SkillLibrary({}, null)
  await library.initSkillLibrary()
  assert.ok(library.always_show_skills.includes('skills.tendNearbyFarm'))
  assert.ok(library.always_show_skills_docs['skills.tendNearbyFarm'].includes('Harvest every mature nearby farmland crop'))
  console.log('farm skill tests passed')
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-owned-tests-'))
  try {
    const helper = path.join(temp, 'crafting_sync.js')
    await writeFile(helper, await readFile(path.join(repo, 'src/agent/library/crafting_sync.js')))
    await write(temp, 'node_modules/prismarine-item/package.json', '{"main":"index.js"}')
    await write(temp, 'node_modules/prismarine-item/index.js', 'module.exports = () => class Item { static toNotch(item) { return item ? { type: item.type, count: item.count, metadata: item.metadata } : null } static fromNotch(item) { return item ? { ...item, stackSize: 64 } : null } };')
    execFileSync(node, [path.join(__dirname, 'crafting_sync.test.cjs'), helper], { stdio: 'inherit' })
    await testFarm(path.join(temp, 'farm-fixture'))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
