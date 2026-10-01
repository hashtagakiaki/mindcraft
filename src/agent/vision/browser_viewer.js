import settings from '../settings.js';
import prismarineViewer from 'prismarine-viewer';
import { getBotViewerPort } from '../../utils/viewer_ports.js';
const mineflayerViewer = prismarineViewer.mineflayer;

export function addBrowserViewer(bot, count_id) {
    if (settings.render_bot_view)
        mineflayerViewer(bot, { port: getBotViewerPort(count_id), firstPerson: true, });
}
