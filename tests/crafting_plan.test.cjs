'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { moduleRoot } = require('./dependency_root.cjs')

const repo = path.resolve(__dirname, '..')

// mcdata.js loads its game data from minecraft-data. Everything else it imports is replaced
// by an empty stub, so the planner runs against the real recipes without a bot or a server.
function setupFixture(root) {
  const write = (relative, content) => {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  write('package.json', '{"type":"module"}')
  write('src/utils/mcdata.js', fs.readFileSync(path.join(repo, 'src/utils/mcdata.js')))
  write('src/agent/settings.js', 'export default {};')
  write('src/vendor/mineflayer-pathfinder/index.js', 'export const pathfinder = () => {};')
  write('src/agent/library/block_interaction.js', 'export const resolveBlockInteraction = () => {};')
  write('src/agent/library/mining_sync.js', 'export const miningSyncPlugin = () => {};')
  write('src/agent/library/navigation_prediction.js', 'export const navigationPredictionPlugin = () => {};')
  write('src/agent/library/navigation_policy.js', 'export const navigationEditGatePlugin = () => {};')
  write('src/utils/minecraft_protocol_overrides.js', 'export const createMinecraftConnectionProtocolOptions = () => ({});')
  write('src/utils/partial_read_capture.js', 'export const capturePartialReadErrors = () => {};')
  for (const [name, source] of Object.entries({
    mineflayer: 'export const createBot = () => {};',
    'prismarine-item': 'export default () => class Item {};',
    'mineflayer-pvp': 'export const plugin = () => {};',
    'mineflayer-collectblock': 'export const plugin = () => {};',
    'mineflayer-auto-eat': 'export const plugin = () => {};',
    'mineflayer-armor-manager': 'export default () => {};',
  })) {
    write(`node_modules/${name}/package.json`, `{"type":"module","exports":"./index.js"}`)
    write(`node_modules/${name}/index.js`, source)
  }
  fs.symlinkSync(path.join(moduleRoot(), 'minecraft-data'), path.join(root, 'node_modules/minecraft-data'))
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-crafting-plan-'))
  try {
    setupFixture(root)
    const mc = await import(pathToFileURL(path.join(root, 'src/utils/mcdata.js')))
    mc.loadMinecraftData('1.21.1')
    const plan = (item, quantity, inventory, tableAvailable = false) => mc.planCraftingSteps(item, quantity, inventory, { tableAvailable })
    const names = result => result.steps.map(step => step.itemName)

    const fromLogs = plan('wooden_pickaxe', 1, { oak_log: 3 })
    assert.deepEqual(fromLogs.missingItems, {})
    assert.deepEqual(names(fromLogs), ['oak_planks', 'crafting_table', 'stick', 'wooden_pickaxe'],
      'ingredients come first, the target last, and a missing table is crafted before the 3x3 recipe')
    assert.deepEqual(fromLogs.steps.find(step => step.itemName === 'oak_planks'), { itemName: 'oak_planks', quantity: 9 },
      'one planks step covers the table, the pickaxe head and the sticks, so 3 logs are enough')
    assert.deepEqual(fromLogs.steps.at(-1), { itemName: 'wooden_pickaxe', quantity: 1 })

    const shortLogs = plan('wooden_pickaxe', 1, { oak_log: 2 })
    assert.deepEqual(shortLogs.steps, [], 'an unfillable plan crafts nothing')
    assert.deepEqual(shortLogs.missingItems, { oak_log: 1 })

    const spruce = plan('wooden_pickaxe', 1, { spruce_log: 3 })
    assert.deepEqual(spruce.missingItems, {})
    assert.deepEqual(names(spruce), ['spruce_planks', 'crafting_table', 'stick', 'wooden_pickaxe'],
      'a recipe for the wood type held is chosen instead of the oak one')

    const withTable = plan('wooden_pickaxe', 1, { oak_log: 2 }, true)
    assert.deepEqual(names(withTable), ['oak_planks', 'stick', 'wooden_pickaxe'], 'a table at hand is not crafted again')

    const partlyCrafted = plan('wooden_pickaxe', 1, { oak_planks: 3, stick: 2 }, true)
    assert.deepEqual(partlyCrafted.steps, [{ itemName: 'wooden_pickaxe', quantity: 1 }], 'held intermediates are used, not crafted again')

    const noStone = plan('stone_pickaxe', 1, { oak_log: 3 }, true)
    assert.deepEqual(noStone.steps, [])
    assert.equal(noStone.missingItems.cobblestone, 3)

    const stone = plan('stone_pickaxe', 1, { oak_log: 1, cobblestone: 3 }, true)
    assert.deepEqual(stone.missingItems, {})
    assert.deepEqual(names(stone), ['oak_planks', 'stick', 'stone_pickaxe'])

    const held = plan('oak_planks', 4, { oak_planks: 8, oak_log: 1 })
    assert.deepEqual(held.steps, [{ itemName: 'oak_planks', quantity: 4 }], 'the target is crafted even when the inventory already holds it')

    assert.throws(() => plan('stick', 0, {}), /positive safe integer/)
    console.log('crafting plan tests passed')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
