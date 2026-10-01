export const BOT_VIEWER_PORT_BASE = 12000;

export function getBotViewerPort(agentIndex) {
    return BOT_VIEWER_PORT_BASE + agentIndex;
}
