// Codex's tool_search indexes these deferred specifications. No second search index/model.
export function createSdkDocumentation(documents) {
    const docs = new Map();
    for (const document of documents) {
        const method = document.split('\n', 1)[0].trim();
        if (!/^[a-zA-Z]+\.[a-zA-Z]\w*$/.test(method)) throw new Error(`Invalid SDK documentation name: ${method}`);
        const name = method.replace('.', '_');
        if (docs.has(name)) throw new Error(`Duplicate SDK documentation: ${method}`);
        docs.set(name, document);
    }
    return {
        tools: [{ type: 'namespace', name: 'minecraft_sdk',
            description: 'Read-only Minecraft SDK documentation: movement, mining, crafting, containers, world observations, places, screenshots, diagnostics and peer messages. Discover with tool_search; execute the documented JavaScript through minecraft_execute.',
            tools: [...docs].map(([name, documentation]) => ({ type: 'function', name, deferLoading: true,
                description: `Read documentation only; does not execute a game operation.\n${documentation}`,
                inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } })),
        }],
        readDocumentation(name) {
            if (!docs.has(name)) throw new Error(`Unknown SDK documentation: ${name}`);
            return docs.get(name);
        },
    };
}
