'use strict'

const assert = require('node:assert/strict')
const { mkdtemp, mkdir, readFile, writeFile, rename, rm } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-bot-rules-'))
  try {
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}')
    await mkdir(path.join(root, 'stubs'))
    const stubs = {
      '../utils/examples.js': ['examples.js', 'export class Examples {}'],
      '../agent/commands/index.js': ['commands.js', 'export function getCommandDocs(){return ""} export function getCommand(){return {perform:async()=>""}}'],
      '../agent/library/skill_library.js': ['skills.js', 'export class SkillLibrary {}'],
      '../utils/text.js': ['text.js', 'export function stringifyTurns(){return ""}'],
      '../agent/settings.js': ['settings.js', 'export default {log_all_prompts:false}'],
      './_model_map.js': ['models.js', 'export function selectAPI(){} export function createModel(){}']
    }
    let source = await readFile(path.join(__dirname, '../src/models/prompter.js'), 'utf8')
    for (const [specifier, [name, contents]] of Object.entries(stubs)) {
      source = source.replaceAll(specifier, `./stubs/${name}`)
      await writeFile(path.join(root, 'stubs', name), contents)
    }
    await writeFile(path.join(root, 'prompter.js'), source)
    const { Prompter } = await import(pathToFileURL(path.join(root, 'prompter.js')))
    const { default: settings } = await import(pathToFileURL(path.join(root, 'stubs/settings.js')))
    const rulesPath = path.join(root, 'BOT_RULES.md')
    settings.bot_rules_file = rulesPath
    const firstRules = '# 荷物\n余剰資材は共有チェストへ。$NAME は原文のまま。'
    await writeFile(rulesPath, firstRules)
    const bots = ['MindcraftBot', 'Bot2', 'Bot3', 'Bot4'].map(name => {
      const requests = []
      const model = { async sendRequest(messages, prompt) {
        requests.push({ messages, prompt })
        if (prompt.startsWith('goal')) return '```json\n{"name":"wood","quantity":1}\n```'
        return prompt.startsWith('responder') ? 'respond' : 'OK'
      } }
      return Object.assign(Object.create(Prompter.prototype), {
        agent: { name, places: null, actions: {} },
        profile: { conversing: `individual ${name}: $NAME`, coding: 'code', goal_setting: 'goal', bot_responder: 'responder' },
        convo_examples: null, coding_examples: null,
        chat_model: model, code_model: model, cooldown: 0, last_prompt_time: 0,
        _saveLog: async () => {}, requests
      })
    })
    for (const bot of bots) {
      await bot.promptConvo([])
      await bot.promptCoding([])
      await bot.promptGoalSetting([], {})
      bot.agent.history = { getHistory: () => [] }
      assert.equal(await bot.promptShouldRespondToBot('hello'), true)
      assert.equal(bot.requests.length, 4)
      for (const { prompt } of bot.requests) {
        assert.ok(prompt.includes(firstRules), 'every decision path carries the same literal rules')
        assert.equal(prompt.split('SHARED BOT RULES').length, 2)
      }
    }
    // Atomic editor replacement must be visible without rebuilding or restarting.
    await writeFile(`${rulesPath}.tmp`, '# 更新\n遠出の前に荷物を整理する。')
    await rename(`${rulesPath}.tmp`, rulesPath)
    for (const bot of bots) {
      await bot.promptConvo([])
      assert.ok(bot.requests.at(-1).prompt.includes('遠出の前に荷物を整理する。'))
      assert.ok(!bot.requests.at(-1).prompt.includes(firstRules))
    }
    await rm(rulesPath)
    for (const bot of bots) {
      const count = bot.requests.length
      await assert.rejects(bot.promptConvo([]), /Cannot read shared bot rules/)
      await assert.rejects(bot.promptCoding([]), /Cannot read shared bot rules/)
      assert.equal(bot.requests.length, count, 'missing rules must not send an unruled request')
      assert.equal(bot.awaiting_coding, false)
    }
    settings.bot_rules_file = 'relative.md'
    await assert.rejects(bots[0].withBotRules('base'), /absolute path/)
    settings.bot_rules_file = rulesPath
    await writeFile(rulesPath, '\n  ')
    assert.equal(await bots[0].withBotRules('base'), 'base')
    settings.bot_rules_file = null
    assert.equal(await bots[0].withBotRules('base'), 'base')
    console.log('shared bot rules tests passed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
