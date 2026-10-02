// Shared addressing rules for Minecraft chat and the management UI.
export function resolveMessageTargets(targets, agents) {
    const known = new Map(agents.map(agent => [agent.name.toLowerCase(), agent]));
    const tokens = Array.isArray(targets) ? targets : typeof targets === 'string' ? targets.split(/[\s,、]+/) : [];
    if (!tokens.length || tokens.some(token => typeof token !== 'string' || !token.trim())) throw new Error('Select at least one bot.');
    const names = tokens.map(token => token.replace(/^@/, '').toLowerCase());
    if (names.includes('all')) {
        if (names.length !== 1) throw new Error('@all cannot be combined with other recipients.');
        const ready = agents.filter(agent => agent.in_game && agent.socket_connected).map(agent => agent.name);
        if (!ready.length) throw new Error('No bots are connected.');
        return ready;
    }
    return [...new Set(names.map(name => {
        const agent = known.get(name);
        if (!agent) throw new Error(`Unknown bot: ${name}`);
        if (!agent.in_game || !agent.socket_connected) throw new Error(`Bot is not connected: ${agent.name}`);
        return agent.name;
    }))];
}

export function parseAddressedMessage(message, agents) {
    if (typeof message !== 'string' || !message.trimStart().startsWith('@')) return null;
    // Accept @Bot2,@Bot3, @Bot2 @Bot3, and @Bot2,Bot3.
    const match = message.trimStart().match(/^(@[\w]+(?:\s*[,、]\s*@?[\w]+|\s+@[\w]+)*)(?:\s+)([\s\S]+)$/);
    if (!match) throw new Error('Use @all <message> or @Bot2,@Bot3 <message>.');
    return { recipients: resolveMessageTargets(match[1], agents), message: match[2].trim() };
}

export function recipientContext(source, recipients) {
    return `Operator instruction from ${source} was sent simultaneously to: ${recipients.join(', ')}. The same instruction was addressed to every listed bot; coordinate with them when needed. This records recipients, not confirmation of completion.`;
}
