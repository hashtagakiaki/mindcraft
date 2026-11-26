'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { moduleRoot } = require('./dependency_root.cjs')

const repo = path.resolve(__dirname, '..')

// mcdata.js loads its game data from minecraft-data. Everything else it imports is replaced
// by an empty stub, so the recipe lookups run against the real recipes without a bot or a server.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-crafting-recipes-'))
  try {
    setupFixture(root)
    const mc = await import(pathToFileURL(path.join(root, 'src/utils/mcdata.js')))
    mc.loadMinecraftData('1.21.1')
    const flags = item => mc.getItemCraftingRecipes(item).map(([, { requiresTable }]) => requiresTable)
    assert.ok(flags('wooden_pickaxe').length > 1 && flags('wooden_pickaxe').every(Boolean), 'a 3x3 pattern needs a table, once per wood type')
    assert.ok(flags('crafting_table').every(flag => flag === false), 'the 2x2 table recipe fits the inventory grid')
    assert.ok(flags('stick').every(flag => flag === false) && flags('oak_planks').every(flag => flag === false))
    const pickaxeHeads = mc.getItemCraftingRecipes('wooden_pickaxe').map(([required]) => Object.keys(required).find(name => name.endsWith('_planks')))
    assert.ok(pickaxeHeads.includes('oak_planks') && pickaxeHeads.includes('spruce_planks'), 'each wood type has its own recipe')
    assert.equal(mc.getItemCraftingRecipes('oak_log'), null, 'a log has no recipe')
    assert.equal(mc.isLoopingItem('coal'), true)
    assert.equal(mc.isLoopingItem('stick'), false)
    console.log('crafting recipe tests passed')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
