// Minecraft Wiki access pinned to the connected server version. Articles are read
// at the last revision before the next published Minecraft version (release or
// snapshot), so text describes the game as it was when this version was current.
const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const WIKI_HOSTS = Object.freeze({ en: 'minecraft.wiki', ja: 'ja.minecraft.wiki' });
const USER_AGENT = 'mindcraft-autonomy/1.0 (personal Minecraft bot; low-volume cached article reads)';

export class WikiError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'WikiError';
        this.code = code;
    }
}

export function versionCutoff(manifest, version) {
    const versions = [...(manifest?.versions ?? [])].sort((a, b) => Date.parse(a.releaseTime) - Date.parse(b.releaseTime));
    const index = versions.findIndex(entry => entry.id === version);
    if (index < 0) throw new WikiError('unknown_version', `Minecraft version ${version} is not in the Mojang version manifest`);
    // The newest version has no successor; its current articles apply.
    return versions[index + 1]?.releaseTime ?? null;
}

const stripTags = html => html.replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function createWiki({ getVersion, fetch = globalThis.fetch }) {
    let cutoff;
    const cache = new Map();
    const getJson = async url => {
        const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
        if (!response.ok) throw new WikiError('http_error', `GET ${url} returned HTTP ${response.status}`);
        return response.json();
    };
    const api = async (lang, params) => {
        const host = WIKI_HOSTS[lang];
        const url = `https://${host}/api.php?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
        const body = await getJson(url);
        if (body.error) throw new WikiError('wiki_api_error', `${host}: ${body.error.code}: ${body.error.info}`);
        return body;
    };
    // Resolved once per process; a server version change restarts the bot.
    const getCutoff = async () => {
        const version = getVersion();
        if (typeof version !== 'string' || !version) throw new WikiError('unknown_version', 'Server Minecraft version is not known yet');
        if (cutoff?.version !== version) cutoff = { version, before: versionCutoff(await getJson(MANIFEST_URL), version) };
        return cutoff;
    };

    async function search({ query, lang, limit }) {
        const body = await api(lang, { action: 'query', list: 'search', srsearch: query, srnamespace: '0', srlimit: String(limit) });
        return { lang, query, note: 'Search uses the current wiki index; read a title to get the text for this server version.',
            results: body.query.search.map(hit => ({ title: hit.title, snippet: stripTags(hit.snippet) })) };
    }

    async function read({ title, section, lang }) {
        const { version, before } = await getCutoff();
        const revisionQuery = { action: 'query', prop: 'revisions', titles: title, redirects: '1', rvprop: 'ids|timestamp', rvlimit: '1' };
        if (before) Object.assign(revisionQuery, { rvstart: before, rvdir: 'older' });
        const page = (await api(lang, revisionQuery)).query.pages[0];
        if (page.missing) throw new WikiError('page_missing', `${WIKI_HOSTS[lang]} has no page titled ${title}`);
        const revision = page.revisions?.[0];
        if (!revision) throw new WikiError('no_revision_for_version', `${page.title} has no revision before ${before} (Minecraft ${version})`);
        const key = `${lang}:${revision.revid}:${section ?? ''}`;
        if (!cache.has(key)) {
            const parsed = (await api(lang, { action: 'parse', oldid: String(revision.revid), prop: 'wikitext|sections' })).parse;
            const sections = parsed.sections.filter(entry => /^\d+$/.test(entry.index)).map(entry => ({ index: entry.index, level: Number(entry.level), heading: stripTags(entry.line) }));
            let text = parsed.wikitext;
            if (section !== undefined) {
                const match = sections.find(entry => entry.heading.toLowerCase() === section.toLowerCase());
                if (!match) throw new WikiError('section_missing', `${page.title} has no section "${section}"; sections: ${sections.map(entry => entry.heading).join(', ')}`);
                text = (await api(lang, { action: 'parse', oldid: String(revision.revid), prop: 'wikitext', section: match.index })).parse.wikitext;
            } else {
                // Without a section, return the lead and the outline so the caller picks what to read.
                const firstHeading = text.search(/^==[^=]/m);
                if (firstHeading >= 0) text = text.slice(0, firstHeading);
            }
            cache.set(key, { lang, title: page.title, section: section ?? null, minecraftVersion: version, revisionBefore: before,
                revisionId: revision.revid, revisionTimestamp: revision.timestamp,
                url: `https://${WIKI_HOSTS[lang]}/w/${encodeURIComponent(page.title.replace(/ /g, '_'))}?oldid=${revision.revid}`,
                sections, wikitext: text.trim() });
        }
        return cache.get(key);
    }

    return { search, read };
}
