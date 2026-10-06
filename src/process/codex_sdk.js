// Method names stay visible; detailed documentation stays deferred in the native registry.
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
        catalog: docs.size ? 'AVAILABLE MINECRAFT SDK METHODS (names only):\n'
            + [...docs.keys()].map(name => name.replace('_', '.')).join('\n') : '',
        tools: [{ type: 'namespace', name: 'minecraft_sdk',
            description: 'Read-only Minecraft SDK documentation. Choose from the AVAILABLE MINECRAFT SDK METHODS catalog in the bot instructions. To read world.getPosition, call tools.minecraft_sdk__world_getPosition({}) in functions.exec; replace the method dot with an underscore. Read selected method documentation before execution. Execute JavaScript with the directly exposed minecraft_execute outside code mode.',
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
