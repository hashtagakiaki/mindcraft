'use strict'

const assert = require('node:assert/strict')
const { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { moduleRoot } = require('./dependency_root.cjs')

const repo = path.resolve(__dirname, '..')
const dependencyRoot = moduleRoot()
const WORLD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

async function write(root, relative, content) {
  const target = path.resolve(root, relative)
  const rootPath = path.resolve(root)
  const relativeTarget = path.relative(rootPath, target)
  if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) throw new Error(`Fixture write escaped its root: ${relative}`)
  let current = rootPath
  for (const segment of relativeTarget.split(path.sep).slice(0, -1)) {
    current = path.join(current, segment)
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Fixture write refuses to traverse a symlink: ${relative}`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await mkdir(current)
    }
  }
  await writeFile(target, content)
}

async function copy(root, relative) {
  await write(root, relative, await readFile(path.join(repo, relative)))
}

function namedExports(source, prefix, lines) {
  const names = [...new Set([...source.matchAll(new RegExp(`${prefix}\\.([A-Za-z_$][\\w$]*)`, 'g'))].map((match) => match[1]))]
  return names.filter((name) => name !== 'js' && !(prefix === 'skills' && name === 'log')).map((name) => lines(name)).join('\n')
}

async function setupFixture(root) {
  await write(root, 'package.json', '{"type":"module"}')
  const fixtureNodeModules = path.join(root, 'node_modules')
  await mkdir(fixtureNodeModules, { recursive: true })
  for (const dependency of ['cheerio', 'vec3', 'ses', 'eslint', 'globals', 'eslint-plugin-no-floating-promise']) {
    await symlink(path.join(dependencyRoot, dependency), path.join(fixtureNodeModules, dependency), 'dir')
  }
  await mkdir(path.join(fixtureNodeModules, '@eslint'), { recursive: true })
  await symlink(path.join(dependencyRoot, '@eslint/js'), path.join(fixtureNodeModules, '@eslint/js'), 'dir')
  await write(root, 'settings.js', `const settings = { allow_insecure_coding: false, code_timeout_mins: 1 }; export default settings;`)
  await write(root, 'src/agent/settings.js', `const settings = { place_memory_enabled: false, place_world_id: null }; export default settings;`)
  await write(root, 'src/agent/conversation.js', `export default {};`)
  await copy(root, 'src/agent/library/operation_context.js')
  await write(root, 'src/agent/tasks/construction_tasks.js', `export function checkLevelBlueprint() { return ''; } export function checkBlueprint() { return ''; }`)
  await write(root, 'src/utils/mcdata.js', `export function getBlockId() { return 1; } export function getItemId() { return 1; } export function getDetailedCraftingPlan() { return []; }`)

  const actionsSource = await readFile(path.join(repo, 'src/agent/commands/actions.js'), 'utf8')
  const querySource = await readFile(path.join(repo, 'src/agent/commands/queries.js'), 'utf8')
  await write(root, 'src/agent/library/skills.js', `
export function log(bot, message) { bot.output = (bot.output || '') + String(message) + '\\n'; }
${namedExports(actionsSource, 'skills', (name) => `export async function ${name}() { return true; }`)}
`)
  await write(root, 'src/agent/library/world.js', namedExports(querySource, 'world', (name) => `export function ${name}() { return ${name === 'getInventoryCounts' ? '{}' : '[]'}; }`))
  await copy(root, 'src/agent/commands/actions.js')
  await copy(root, 'src/agent/commands/queries.js')
  await copy(root, 'src/agent/commands/index.js')
  await copy(root, 'src/agent/memory_bank.js')
  await copy(root, 'src/agent/places.js')
  await copy(root, 'src/agent/coder.js')
  await copy(root, 'src/agent/library/lockdown.js')
  await copy(root, 'src/agent/library/sdk_capabilities.js')
  await copy(root, 'src/agent/library/operation_context.js')
  await write(root, 'src/agent/place_actions.js', `export function createPlaceActions(agent, client) { return {
  async goTo(placeId) { return agent.testTravelResult || { ok: false, status: 'unreachable', placeId }; },
  async tendFarm(farmId) { return agent.testFarmResult || { ok: false, status: 'storage_candidates_ambiguous', farmId }; }
}; }`)
  await copy(root, 'bots/execTemplate.js')
  await copy(root, 'bots/lintTemplate.js')
  await copy(root, 'eslint.config.js')
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-place-agent-test-'))
  const previousCwd = process.cwd()
  try {
    await setupFixture(temp)
    await assert.rejects(write(temp, 'node_modules/cheerio/package.json', '{"type":"module"}'), /refuses to traverse a symlink/)
    await assert.rejects(write(temp, '../outside-fixture.txt', 'unsafe'), /escaped its root/)
    process.chdir(temp)
    const fixtureUrl = (relative) => pathToFileURL(path.join(temp, relative)).href
    const [{ executeCommand, parseCommandMessage }, { MemoryBank }, { createPlacesFacade }, settingsModule, storeModule] = await Promise.all([
      import(fixtureUrl('src/agent/commands/index.js')),
      import(fixtureUrl('src/agent/memory_bank.js')),
      import(fixtureUrl('src/agent/places.js')),
      import(fixtureUrl('src/agent/settings.js')),
      import(pathToFileURL(path.join(repo, 'src/mindcraft/place_store.js')).href)
    ])
    const { PlaceStore } = storeModule
    const persistent = { places: [], revision: 0, aliases: new Map(), homes: new Map(), relation: null }
    const makeClient = (agentName) => ({
      async queryPlaces(criteria = {}) {
        return persistent.places.filter((place) => (!criteria.dimension || place.dimension === criteria.dimension) &&
          (!criteria.kind || place.kind === criteria.kind) && (!criteria.purpose || place.purposes.includes(criteria.purpose)) &&
          (!criteria.text || [place.name, place.kind, ...place.purposes, ...(place.aliases || [])].some((value) => value.toLowerCase().includes(criteria.text.toLowerCase())))).slice(0, criteria.limit || 20)
      },
      async getPlace(id) { return persistent.places.find((place) => place.id === id) || null },
      async inspectPlace(id) {
        const place = persistent.places.find((entry) => entry.id === id)
        return place ? { place, outputStorage: persistent.places.find((entry) => entry.id === persistent.relation?.toPlaceId) || null, relation: persistent.relation, revision: persistent.revision } : null
      },
      async resolvePlaceAlias(alias) { const id = persistent.aliases.get(`${agentName}:${alias.toLowerCase()}`); return persistent.places.find((place) => place.id === id) || null },
      async getPlacePreferences() { return { aliases: Object.fromEntries([...persistent.aliases].filter(([key]) => key.startsWith(`${agentName}:`)).map(([key, id]) => [key.slice(agentName.length + 1), id])), homePlaceId: persistent.homes.get(agentName) } },
      async rememberPlace(input, { alias } = {}) {
        const place = { ...input, id: input.id || `place-${persistent.places.length + 1}`, aliases: [], recordedAt: new Date().toISOString(), ...(input.existence === 'observed' ? { lastVerifiedAt: input.observedAt } : {}) }
        persistent.places.push(place); persistent.revision++
        if (alias) persistent.aliases.set(`${agentName}:${alias.toLowerCase()}`, place.id)
        return { ok: true, value: place, revision: persistent.revision }
      },
      async updatePlaceObservation({ placeId, existence, observedAt }) { const place = persistent.places.find((entry) => entry.id === placeId); place.existence = existence; place.lastCheckedAt = observedAt || new Date().toISOString(); if (existence === 'observed') place.lastVerifiedAt = place.lastCheckedAt; persistent.revision++; return { ok: true, value: place, revision: persistent.revision } },
      async recordPlaceVisit({ placeId, status }) { return { ok: true, value: { placeId, status } } },
      async setPlaceRelation(relation) { persistent.relation = relation; persistent.revision++; return { ok: true, value: relation } },
      async setPlaceAlias(alias, placeId) { persistent.aliases.set(`${agentName}:${alias.toLowerCase()}`, placeId); return { ok: true } },
      async setPlacePreference({ homePlaceId }) { persistent.homes.set(agentName, homePlaceId); return { ok: true } }
    })

    const bot = {
      game: { dimension: 'overworld' },
      entity: { position: { x: 10, y: 64, z: 20 } },
      output: '',
      blockAt(position) {
        const key = `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
        return ({ '1,64,1': { name: 'stone', boundingBox: 'block' }, '4,63,2': { name: 'farmland', boundingBox: 'block' }, '5,63,2': { name: 'chest', boundingBox: 'block' } })[key] || null
      },
      interrupt_code: false,
      emit() {}
    }
    const clientA = makeClient('botA')
    const agent = { name: 'botA', bot, blocked_actions: [], actions: { async runAction(_label, action) { await action(); return { success: true, message: bot.output } } } }
    agent.places = createPlacesFacade(agent, clientA)
    agent.memory_bank = new MemoryBank(clientA, 'botA', () => agent.places.isEnabled())

    assert.equal(parseCommandMessage('!rememberHere("session-home")').commandName, '!rememberHere', 'real command parser recognizes the backward-compatible syntax')
    const sessionResult = await executeCommand(agent, '!rememberHere("session-home")')
    assert.match(sessionResult, /Session bookmark/)
    assert.deepEqual(await agent.memory_bank.recallPlace('session-home'), [10, 64, 20])
    await assert.rejects(executeCommand(agent, '!findPlace("forest")'), /disabled/)

    settingsModule.default.place_memory_enabled = true
    settingsModule.default.place_world_id = WORLD_ID
    const remembered = await executeCommand(agent, '!rememberHere("botA-home")')
    assert.match(remembered, /Saved observed place/)
    const home = await clientA.resolvePlaceAlias('botA-home')
    assert.equal(home.position.x, 10)
    assert.equal(home.existence, 'observed')

    await assert.rejects(executeCommand(agent, '!recordPlaceBlock("bad-farm", "farm", "food", 1, 64, 1)'), /does not match place kind/)
    const savedFarm = await executeCommand(agent, '!recordPlaceBlock("field", "farm", "food", 4, 63, 2)')
    assert.match(savedFarm, /loaded farmland/)
    const farm = persistent.places.find((place) => place.name === 'field')
    assert.equal(farm.existence, 'observed')
    assert.equal(farm.position.y, 63)
    await assert.rejects(agent.places.sdk.rememberHere('fake-chest', 'storage', 'food'), /requires a loaded target block/)
    assert.equal((await agent.places.sdk.verify(farm.id)).status, 'observed', 'loaded farmland verifies a saved farm')

    const wrongFarm = (await clientA.rememberPlace({ name: 'missing field', kind: 'farm', purposes: ['food'], dimension: 'minecraft:overworld', position: { x: 1, y: 64, z: 1 }, source: 'user', existence: 'unverified' })).value
    assert.equal((await agent.places.sdk.verify(wrongFarm.id)).status, 'missing', 'loaded wrong target block marks the saved target missing')
    assert.equal((await clientA.getPlace(wrongFarm.id)).existence, 'missing')
    const unloadedRecord = (await clientA.rememberPlace({ name: 'unloaded field', kind: 'farm', purposes: ['food'], dimension: 'minecraft:overworld', position: { x: 8, y: 64, z: 8 }, source: 'user', existence: 'unverified' })).value
    await assert.rejects(agent.places.sdk.verify(unloadedRecord.id), /not loaded/)
    assert.equal((await clientA.getPlace(unloadedRecord.id)).existence, 'unverified', 'unloaded target does not become observed or missing')
    bot.game.dimension = 'the_nether'
    await assert.rejects(agent.places.sdk.verify(farm.id), /Cannot verify/)
    bot.game.dimension = 'overworld'

    const representative = (await clientA.rememberPlace({ name: 'base point', kind: 'base', purposes: ['shelter'], dimension: 'minecraft:overworld', position: { x: 10, y: 64, z: 20 }, source: 'user', existence: 'unverified' })).value
    assert.equal((await agent.places.sdk.verify(representative.id)).status, 'observed_point', 'representative base point is verified by current bot position, not air block checks')
    bot.entity.position = { x: 100, y: 64, z: 20 }
    assert.equal((await agent.places.sdk.verify(representative.id)).status, 'not_nearby')
    bot.entity.position = { x: 10, y: 64, z: 20 }

    for (let index = 0; index < 6; index++) await clientA.rememberPlace({ name: `forest ${index}`, kind: 'forest', purposes: ['wood'], dimension: 'minecraft:overworld', position: { x: 30 + index, y: 64, z: 30 }, source: 'observed', existence: 'observed', observedAt: new Date().toISOString() })
    const forestMatches = await agent.places.sdk.find('forest')
    assert.equal(forestMatches.split('\n').length, 6, 'search includes all matches returned by the bounded RPC query')
    assert.equal((agent.places.getPromptContext().match(/forest \d+ \[/g) || []).length, 5, 'coding context carries at most five candidate IDs')

    const chestResponse = await clientA.rememberPlace({ name: 'field chest', kind: 'storage', purposes: ['food'], dimension: 'minecraft:overworld', position: { x: 5, y: 63, z: 2 }, source: 'observed', existence: 'observed', observedAt: new Date().toISOString() })
    const relation = await agent.places.sdk.setOutputStorage(farm.id, chestResponse.value.id)
    assert.equal(relation.ok, true)
    const inspectText = await agent.places.sdk.inspect(farm.id)
    assert.match(inspectText, /Output storage/)
    await agent.places.sdk.setHome(farm.id)
    assert.equal((await agent.places.sdk.resolveAlias('home')).place.id, farm.id, 'legacy home resolution falls back to the bot personal home preference')
    assert.match(await agent.memory_bank.getKeys(), /home/, 'saved place list includes a home preference without a separate alias')
    const netherChest = await clientA.rememberPlace({ name: 'nether chest', kind: 'storage', purposes: ['food'], dimension: 'minecraft:the_nether', position: { x: 5, y: 63, z: 2 }, source: 'observed', existence: 'observed', observedAt: new Date().toISOString() })
    await assert.rejects(agent.places.sdk.setOutputStorage(farm.id, netherChest.value.id), /same dimension/)
    bot.game.dimension = 'the_nether'
    await assert.rejects(agent.places.sdk.goTo(farm.id), /Cannot travel/)
    bot.game.dimension = 'overworld'

    const userReport = await agent.places.sdk.rememberReported('distant mine', 'mine', 'iron', { x: 200, y: 20, z: -100 }, 'the_nether')
    assert.match(userReport, /unverified/)
    const reported = persistent.places.find((place) => place.name === 'distant mine')
    assert.equal(reported.existence, 'unverified')
    assert.equal(reported.dimension, 'the_nether')
    await assert.rejects(agent.places.sdk.verify(reported.id), /Cannot verify/)
    assert.equal((await clientA.getPlace(reported.id)).existence, 'unverified', 'different-dimension source remains unchanged')

    const unreachable = await agent.places.sdk.goTo(farm.id)
    assert.equal(unreachable.ok, false)
    assert.equal(unreachable.status, 'unreachable', 'facade preserves the adapter failure instead of claiming arrival')
    assert.match(agent.places.getPromptContext(), /Selected place:/, 'stable selected ID is passed into coding context')
    const logResult = await executeCommand(agent, `!goToPlace("${farm.id}")`)
    assert.match(logResult, /Could not confirm travel/)
    assert.match(bot.output, /unreachable/, 'action output includes the adapter status')
    agent.testTravelResult = { ok: true, status: 'visited', recordError: 'visit ack failed' }
    const recordWarning = await executeCommand(agent, `!goToPlace("${farm.id}")`)
    assert.match(recordWarning, /do not repeat the movement/)
    agent.testTravelResult = null
    agent.testFarmResult = { ok: true, status: 'completed', harvested: 2, planted: 1, stored: 2, relationRecordError: 'relation ack failed', actionAlreadyCompleted: true }
    const farmWarning = await executeCommand(agent, `!tendSavedFarm("${farm.id}")`)
    assert.match(farmWarning, /without repeating completed farm work/)
    assert.match(farmWarning, /relation ack failed/)
    agent.testFarmResult = null

    const storeDir = path.join(temp, 'persistent-ledger')
    const diskStore = await PlaceStore.open({ stateDir: storeDir, worldId: WORLD_ID })
    const homeId = (await diskStore.rememberPlace({ name: 'Shared Home', kind: 'base', source: 'observed', existence: 'observed', position: { x: 7, y: 65, z: 8 } })).value.id
    await diskStore.setAgentAlias('botA', 'home', homeId)
    const otherHomeId = (await diskStore.rememberPlace({ name: 'Other Home', kind: 'base', source: 'observed', existence: 'observed', position: { x: 70, y: 65, z: 80 } })).value.id
    await diskStore.setAgentAlias('botB', 'home', otherHomeId)
    await diskStore.close()
    const restartedStore = await PlaceStore.open({ stateDir: storeDir, worldId: WORLD_ID })
    assert.equal(restartedStore.resolveAgentAlias('botA', 'home').id, homeId)
    assert.equal(restartedStore.resolveAgentAlias('botB', 'home').id, otherHomeId)
    await restartedStore.close()

    const { Coder } = await import(fixtureUrl('src/agent/coder.js'))
    const { getCapabilityDocs } = await import(fixtureUrl('src/agent/library/sdk_capabilities.js'))
    agent.prompter = { skill_libary: { async getAllSkillDocs() { return getCapabilityDocs() } } }
    agent.history = { getHistory() { return [] } }
    const coder = new Coder(agent)
    await waitFor(() => coder.code_template.includes('async (bot, places)') && coder.code_lint_template.includes('main(bot, places, vision)'), 3000, 'coder templates did not load')
    const generated = await coder._stageCode("const result = await places.find('forest'); log(bot, result);")
    assert.equal(await coder._lintCode(generated.src_lint_copy), null, 'place SDK use passes the actual Coder lint/template path')
    bot.output = ''
    await generated.func.main(bot, agent.places.sdk)
    assert.match(bot.output, /forest 0 \[place-/, 'the actual SES code template receives only the place facade')
    const visionCalls = []
    agent.vision_interpreter = {
      async lookAtPlayer(...args) { visionCalls.push(['player', ...args]); return 'player image analysis' },
      async lookAtPosition(...args) { visionCalls.push(['position', ...args]); return 'position image analysis' }
    }
    const visionCode = await coder._stageCode("log(bot, await vision.lookAtPlayer('Alex', 'with')); log(bot, await vision.lookAtPosition(10, 64, 20)); log(bot, Object.keys(vision).join(','));")
    assert.equal(await coder._lintCode(visionCode.src_lint_copy), null, 'vision SDK calls pass the actual lint/template path')
    bot.output = ''
    await visionCode.func.main(bot, agent.places.sdk)
    assert.deepEqual(visionCalls, [['player', 'Alex', 'with'], ['position', 10, 64, 20]])
    assert.match(bot.output, /player image analysis/)
    assert.match(bot.output, /position image analysis/)
    assert.match(bot.output, /lookAtPlayer,lookAtBlock,lookAtPosition/, 'vision exposes only the three observation methods')
    const invalidVision = await coder._stageCode('await vision.capture();')
    assert.match(await coder._lintCode(invalidVision.src_lint_copy), /These functions do not exist/)
    console.log('place_agent.test.cjs: parser, session fallback, observation grounding, selected place context, private aliases, and SES SDK path passed')
  } finally {
    process.chdir(previousCwd)
    await rm(temp, { recursive: true, force: true })
  }
}

function waitFor(predicate, timeoutMs, errorMessage) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve()
      if (Date.now() - started >= timeoutMs) return reject(new Error(errorMessage))
      setTimeout(check, 10)
    }
    check()
  })
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
