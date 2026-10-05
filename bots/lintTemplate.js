import * as skills from '../../../src/agent/library/skills.js';
import * as world from '../../../src/agent/library/world.js';
import Vec3 from 'vec3';

const log = skills.log;
const communication = { sendToBot: () => Promise.resolve({ accepted: false }) };

export async function main(bot, places, vision) {
    /* CODE HERE */
    log(bot, 'Code finished.');
}
