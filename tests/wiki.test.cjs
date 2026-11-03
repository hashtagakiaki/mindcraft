'use strict'

// Version pinning and request shape with a stubbed fetch; no network is used.
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const repo = path.resolve(__dirname, '..')

const manifest = { versions: [
  { id: '24w33a', type: 'snapshot', releaseTime: '2024-08-15T12:39:34+00:00' },
  { id: '1.21.1', type: 'release', releaseTime: '2024-08-08T12:24:45+00:00' },
  { id: '1.21.1-rc1', type: 'snapshot', releaseTime: '2024-08-07T14:29:18+00:00' },
] }
const wikitext = 'Lead text.\n== Usage ==\nUse it.\n=== Detail ===\nMore.\n== History ==\nOld.'

function stubFetch(requests) {
  return async url => {
    requests.push(url)
    const parsed = new URL(url)
    const p = Object.fromEntries(parsed.searchParams)
    let body
    if (parsed.hostname === 'piston-meta.mojang.com') body = manifest
    else if (p.list === 'search') body = { query: { search: [{ title: 'Farmland', snippet: '<span class="searchmatch">Farm</span>land &amp; water' }] } }
    else if (p.prop === 'revisions') body = p.titles === 'Nowhere'
      ? { query: { pages: [{ title: 'Nowhere', missing: true }] } }
      : { query: { pages: [{ title: 'Farmland', revisions: [{ revid: 42, timestamp: '2024-08-10T00:00:00Z' }] }] } }
    else if (p.action === 'parse' && p.section) body = { parse: { wikitext: '== Usage ==\nUse it.\n=== Detail ===\nMore.' } }
    else if (p.action === 'parse') body = { parse: { wikitext, sections: [
      { index: '1', level: '2', line: 'Usage' }, { index: '2', level: '3', line: 'Detail' },
      { index: 'T-1', level: '2', line: 'Template part' }, { index: '3', level: '2', line: '<i>History</i>' }] } }
    return { ok: true, status: 200, json: async () => body }
  }
}

async function main() {
  const { createWiki, versionCutoff } = await import(pathToFileURL(path.join(repo, 'src/agent/library/wiki.js')))
  assert.equal(versionCutoff(manifest, '1.21.1'), '2024-08-15T12:39:34+00:00')
  assert.equal(versionCutoff(manifest, '24w33a'), null, 'the newest version reads current articles')
  assert.throws(() => versionCutoff(manifest, '9.9'), { code: 'unknown_version' })

  const requests = []
  const wiki = createWiki({ getVersion: () => '1.21.1', fetch: stubFetch(requests) })
  const lead = await wiki.read({ title: 'Farmland', lang: 'en' })
  const revisionUrl = new URL(requests.find(url => url.includes('prop=revisions')))
  assert.equal(revisionUrl.searchParams.get('rvstart'), '2024-08-15T12:39:34+00:00')
  assert.equal(revisionUrl.searchParams.get('rvdir'), 'older')
  assert.equal(lead.wikitext, 'Lead text.')
  assert.equal(lead.revisionId, 42)
  assert.equal(lead.url, 'https://minecraft.wiki/w/Farmland?oldid=42')
  assert.deepEqual(lead.sections.map(s => s.heading), ['Usage', 'Detail', 'History'])

  const usage = await wiki.read({ title: 'Farmland', section: 'usage', lang: 'en' })
  assert.match(usage.wikitext, /=== Detail ===/)
  assert.equal(new URL(requests.at(-1)).searchParams.get('section'), '1')
  const count = requests.length
  await wiki.read({ title: 'Farmland', section: 'usage', lang: 'en' })
  assert.equal(requests.length, count + 1, 'only the revision lookup repeats; manifest and article are cached')

  await assert.rejects(wiki.read({ title: 'Farmland', section: 'Nope', lang: 'en' }), { code: 'section_missing' })
  await assert.rejects(wiki.read({ title: 'Nowhere', lang: 'en' }), { code: 'page_missing' })
  await wiki.read({ title: 'Farmland', lang: 'ja' })
  assert.equal(new URL(requests.at(-1)).hostname, 'ja.minecraft.wiki')

  const found = await wiki.search({ query: 'farm', lang: 'en', limit: 5 })
  assert.deepEqual(found.results, [{ title: 'Farmland', snippet: 'Farmland & water' }])

  const unknown = createWiki({ getVersion: () => undefined, fetch: stubFetch([]) })
  await assert.rejects(unknown.read({ title: 'Farmland', lang: 'en' }), { code: 'unknown_version' })
  console.log('wiki tests passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
