import * as Mindcraft from '../mindcraft/mindcraft.js';
import settings from '../../settings.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

function parseArguments() {
    return yargs(hideBin(process.argv))
        .option('mindserver_port', {
            type: 'number',
            describe: 'Mindserver port',
            default: settings.mindserver_port
        })
        .help()
        .alias('help', 'h')
        .parse();
}

const args = parseArguments();

settings.mindserver_port = args.mindserver_port;
if (process.env.MINDCRAFT_MANAGEMENT_AUTH_MODE) settings.management_auth_mode = process.env.MINDCRAFT_MANAGEMENT_AUTH_MODE;

let signalShutdown = null;
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
        if (signalShutdown) return;
        signalShutdown = Promise.resolve(Mindcraft.shutdown({ reason: `signal-${signal}` }))
            .then(() => process.exit(0), error => {
                console.error(`Mindcraft shutdown failed after ${signal}`);
                process.exit(1);
            });
    });
}

Mindcraft.init(settings.mindserver_port);

console.log(`Mindcraft initialized with MindServer at localhost:${settings.mindserver_port}`);
