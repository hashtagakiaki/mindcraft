import { Agent } from '../agent/agent.js';
import { serverProxy } from '../agent/mindserver_proxy.js';
import yargs from 'yargs';

const args = process.argv.slice(2);
if (args.length < 1) {
    console.log('Usage: node init_agent.js -n <agent_name> -p <port> -l <load_memory> -m <init_message> -c <count_id>');
    process.exit(1);
}

const argv = yargs(args)
    .option('name', {
        alias: 'n',
        type: 'string',
        description: 'name of agent'
    })
    .option('load_memory', {
        alias: 'l',
        type: 'boolean',
        description: 'load agent memory from file on startup'
    })
    .option('init_message', {
        alias: 'm',
        type: 'string',
        description: 'automatically prompt the agent on startup'
    })
    .option('count_id', {
        alias: 'c',
        type: 'number',
        default: 0,
        description: 'identifying count for multi-agent scenarios',
    })
    .option('port', {
        alias: 'p',
        type: 'number',
        description: 'port of mindserver'
    })
    .option('management-auth-required', { type: 'boolean', default: false })
    .argv;

const agent = new Agent();
const EXIT_INTENT_FLUSH_MS = 500;
const EXIT_INTENT_MESSAGE_MAX_CHARS = 1000;
let resolveAuthBootstrap;
const authBootstrap = argv.managementAuthRequired ? new Promise(resolve => { resolveAuthBootstrap = resolve; }) : Promise.resolve(true);
let shutdownRequested = null;
let shutdownPromise = null;

function waitForParentMessage(message) {
    if (typeof process.send !== 'function' || process.connected !== true) return Promise.resolve();
    return new Promise(resolve => {
        let settled = false;
        const timeout = setTimeout(() => finish(), EXIT_INTENT_FLUSH_MS);
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve();
        };
        try { process.send(message, finish); }
        catch { finish(); }
    });
}

function requestShutdown(reason, options = {}) {
    if (shutdownPromise) return shutdownPromise;
    const intent = {
        reason: String(reason || 'shutdown'),
        restartIntent: options.restartIntent === true,
        code: Number.isInteger(options.code) ? options.code : 0,
        message: typeof options.message === 'string' ? options.message.slice(0, EXIT_INTENT_MESSAGE_MAX_CHARS) : null,
    };
    // This synchronous gate is checked after each startup await and before
    // Agent.start can construct a Minecraft bot.
    shutdownRequested = intent;
    shutdownPromise = Promise.resolve().then(async () => {
        let exitCode = intent.code;
        let outcome = null;
        try {
            outcome = await agent.shutdown?.(intent.reason, {
                restartIntent: intent.restartIntent,
                code: intent.code,
                message: intent.message,
            });
        } catch (error) {
            console.error('Agent shutdown failed:', error);
            exitCode = exitCode || 1;
        }
        let serializableOutcome = null;
        try { serializableOutcome = outcome == null ? null : JSON.parse(JSON.stringify(outcome)); }
        catch (error) { serializableOutcome = { serializationError: String(error?.message || error) }; }
        await waitForParentMessage({
            type: 'mindcraft:exit-intent',
            reason: intent.reason,
            restartIntent: intent.restartIntent,
            code: intent.code,
            outcome: serializableOutcome,
        });
        process.exit(exitCode);
    });
    return shutdownPromise;
}

Object.defineProperty(agent, 'requestShutdown', {
    configurable: false,
    enumerable: false,
    value: (reason, options) => requestShutdown(reason, options),
});

process.on('message', message => {
    if (message?.type === 'mindcraft:management-auth') {
        try {
            serverProxy.setManagementCredential({ spawnId: message.spawnId, token: message.token });
            resolveAuthBootstrap?.(true);
            resolveAuthBootstrap = null;
        } catch {
            resolveAuthBootstrap?.(false);
            resolveAuthBootstrap = null;
        }
        return;
    }
    if (message?.type !== 'mindcraft:shutdown') return;
    void requestShutdown(message.reason || 'parent-shutdown', {
        restartIntent: message.restartIntent === true,
        code: 0,
    });
});
process.on('SIGINT', () => { void requestShutdown('sigint', { restartIntent: false, code: 0 }); });
process.on('SIGTERM', () => { void requestShutdown('sigterm', { restartIntent: false, code: 0 }); });
if (typeof process.send === 'function') {
    process.once('disconnect', () => { void requestShutdown('parent-disconnect', { restartIntent: false, code: 0 }); });
}

function canStart() {
    return shutdownRequested === null && (typeof process.send !== 'function' || process.connected === true);
}

async function startAgent() {
    try {
        if (!canStart()) return void requestShutdown('parent-disconnected-before-start');
        if (await authBootstrap !== true) throw new Error('Private MindServer child credential was not received over IPC');
        console.log('Connecting to MindServer');
        await serverProxy.connect(argv.name, argv.port);
        if (!canStart()) return void requestShutdown('shutdown-during-connect');
        console.log('Starting agent');
        serverProxy.setAgent(agent);
        if (!canStart()) return void requestShutdown('shutdown-before-agent-start');
        await agent.start(argv.load_memory, argv.init_message, argv.count_id);
        if (shutdownRequested) return;
    } catch (error) {
        console.error('Failed to start agent process:');
        console.error(error.message);
        console.error(error.stack);
        if (!shutdownRequested) void requestShutdown('startup-error', { restartIntent: true, code: 1 });
    }
}

void startAgent();
