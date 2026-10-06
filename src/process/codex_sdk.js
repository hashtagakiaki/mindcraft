// Deferred documentation stays in the native registry; code mode discovers bounded names only.
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
            description: 'Read-only Minecraft SDK documentation. In functions.exec, filter ALL_TOOLS by names starting with minecraft_sdk__, match the needed method words, and print only up to 3 names. Call the selected documentation tool in code mode. Execute JavaScript with the directly exposed minecraft_execute outside code mode.',
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
