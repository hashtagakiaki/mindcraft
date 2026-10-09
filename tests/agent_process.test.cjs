const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { pathToFileURL } = require('node:url');

const sourceRoot = path.resolve(__dirname, '..');

async function waitFor(predicate, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await sleep(25);
    }
    return Boolean(await predicate());
}

async function waitForValue(getValue, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await getValue();
        if (value) return value;
        await sleep(25);
    }
    return getValue();
}

async function groupExists(pid) {
    try { process.kill(-pid, 0); return true; }
    catch (error) { return error.code === 'EPERM'; }
}

async function processExists(pid) {
    try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
        const state = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[0];
        return state !== 'Z' && state !== 'X';
    } catch { return false; }
}

function waitForMessage(child, predicate, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('timed out waiting for fixture child message')), timeout);
        const onMessage = message => { if (predicate(message)) finish(null, message); };
        const onClose = () => finish(new Error('fixture child closed before expected message'));
        function finish(error, message) {
            clearTimeout(timer);
            child.removeListener('message', onMessage);
            child.removeListener('close', onClose);
            error ? reject(error) : resolve(message);
        }
        child.on('message', onMessage);
        child.once('close', onClose);
    });
}

async function readMarkers(marker) {
    try {
        return (await fs.readFile(marker, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch {
        return [];
    }
}

async function run() {
    const { AgentProcess } = await import(pathToFileURL(path.join(sourceRoot, 'src/process/agent_process.js')));
    const makeSupervisor = (name, port, options = {}) => new AgentProcess(name, port, { logoutAgent: () => {}, ...options });
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mindcraft-agent-process-'));
    const childFile = path.join(temp, 'fixture.mjs');
    const grandchildFile = path.join(temp, 'grandchild.mjs');
    const cliFile = path.join(temp, 'cli.mjs');
    const marker = path.join(temp, 'marker');
    const ready = path.join(temp, 'grandchild-ready');
    const cliReady = path.join(temp, 'cli-ready');
    const adapterBotFile = path.join(temp, 'adapter-bot.mjs');
    const fakeCli = path.join(temp, 'fake-codex.mjs');
    const fakeCliGrandchild = path.join(temp, 'fake-cli-grandchild.mjs');
    const integrationMarker = path.join(temp, 'adapter-processes.json');
    const integrationReady = `${integrationMarker}.grandchild-ready`;
    const authChild = path.join(temp, 'auth-child.mjs');
    await fs.writeFile(authChild, `
      import { writeFileSync } from 'node:fs'
      process.on('message', message => {
        if (message?.type === 'mindcraft:management-auth') {
          writeFileSync(process.env.FIXTURE_AUTH_MARKER, JSON.stringify({ spawnId: message.spawnId, token: message.token }))
        }
        if (message?.type === 'mindcraft:shutdown') process.exit(0)
      })
      setInterval(() => {}, 1000)
    `)
    const supervisors = [];
    let foreign = null;
    let integrationUnrelated = null;
    const previousCodexBinary = process.env.MINDCRAFT_CODEX_BIN;
    const previousIntegrationMarker = process.env.MINDCRAFT_INTEGRATION_MARKER;
    await fs.writeFile(grandchildFile, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `);
    await fs.writeFile(cliFile, `
      import { spawn } from 'node:child_process';
      import { appendFileSync } from 'node:fs';
      process.on('SIGUSR1', () => {
        const grandchild = spawn(process.execPath, [${JSON.stringify(grandchildFile)}], { stdio: 'ignore' });
        appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ cliGrandchild: grandchild.pid }) + '\\n');
        setTimeout(() => process.exit(0), 100);
      });
      process.on('message', () => {});
      import('node:fs').then(fs => fs.writeFileSync(${JSON.stringify(cliReady)}, String(process.pid)));
      setInterval(() => {}, 1000);
    `);
    await fs.writeFile(fakeCliGrandchild, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(integrationReady)}, String(process.pid));
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `);
    await fs.writeFile(fakeCli, `#!${process.execPath}
      import { spawn } from 'node:child_process';
      import { existsSync, writeFileSync } from 'node:fs';
      const grandchild = spawn(process.execPath, [${JSON.stringify(fakeCliGrandchild)}], { stdio: 'ignore' });
      while (!existsSync(${JSON.stringify(integrationReady)})) await new Promise(resolve => setTimeout(resolve, 5));
      writeFileSync(${JSON.stringify(integrationMarker)}, JSON.stringify({ cli: process.pid, grandchild: grandchild.pid, dir: process.cwd() }));
      process.stdin.resume();
      setInterval(() => {}, 1000);
    `);
    await fs.chmod(fakeCli, 0o755);
    await fs.writeFile(adapterBotFile, `
      import { pathToFileURL } from 'node:url';
      const { Codex } = await import(pathToFileURL(${JSON.stringify(path.join(sourceRoot, 'src/models/codex.js'))}).href);
      const marker = process.env.MINDCRAFT_INTEGRATION_MARKER;
      (async () => {
        void new Codex().sendRequest([], 'fixture', '***').catch(() => {});
        while (true) {
          try { await import('node:fs/promises').then(fs => fs.access(marker)); break; }
          catch { await new Promise(resolve => setTimeout(resolve, 5)); }
        }
        process.send?.({ type: 'fixture-codex-started' }, () => { while (true) {} });
      })();
    `);
    await fs.writeFile(childFile, `
      import { spawn } from 'node:child_process';
      import { appendFileSync } from 'node:fs';
      const mode = process.env.FIXTURE_MODE || 'graceful';
      const grandchild = spawn(process.execPath, [${JSON.stringify(grandchildFile)}], { stdio: 'ignore' });
      while (true) {
        try { await import('node:fs/promises').then(fs => fs.access(${JSON.stringify(ready)})); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 5)); }
      }
      appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }) + '\\n');
      process.on('message', message => {
        if (message?.type === 'mindcraft:shutdown' && mode === 'graceful') process.exit(0);
      });
      if (mode === 'cli-race') {
        const cli = spawn(process.execPath, [${JSON.stringify(cliFile)}], { detached: true, stdio: 'ignore' });
        while (true) {
          try { await import('node:fs/promises').then(fs => fs.access(${JSON.stringify(cliReady)})); break; }
          catch { await new Promise(resolve => setTimeout(resolve, 5)); }
        }
        if (process.send) {
          process.on('message', message => {
            if (message?.type === 'mindcraft:owned-process-ack' && message.pid === cli.pid && message.accepted) {
              appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ cliAccepted: cli.pid }) + '\\n');
              try { process.kill(cli.pid, 'SIGUSR1'); } catch {}
            }
          });
          process.send({ type: 'mindcraft:owned-process', role: 'cli', pid: cli.pid, requestId: 'fixture-cli-request' });
        }
        cli.unref();
        setTimeout(() => process.exit(0), 400);
      }
      if (mode === 'foreign-register' && process.send) {
        process.on('message', message => {
          if (message?.type === 'mindcraft:owned-process-ack') appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ foreignAck: message.accepted }) + '\\n');
        });
        process.send({ type: 'mindcraft:owned-process', role: 'cli', pid: Number(process.env.FOREIGN_PID), requestId: 'fixture-foreign-request' });
      }
      if (mode === 'budget') setTimeout(() => process.exit(1), Number(process.env.FIXTURE_EXIT_DELAY || 50));
      if (mode === 'child-stop-term') {
        if (process.send) process.send({ type: 'mindcraft:exit-intent', reason: 'requested-stop', restartIntent: false });
        setTimeout(() => process.kill(process.pid, 'SIGTERM'), 25);
      }
      if (mode === 'child-auto-restart') {
        if (process.send) process.send({ type: 'mindcraft:exit-intent', reason: 'startup-error', restartIntent: true });
        setTimeout(() => process.exit(0), 25);
      }
      if (mode === 'child-auto-stop-race' && process.send) {
        process.send({ type: 'mindcraft:exit-intent', reason: 'startup-error', restartIntent: true });
      }
      if (mode === 'task-complete' && process.send) {
        process.send({ type: 'mindcraft:exit-intent', reason: 'task-complete', restartIntent: false }, () => process.exit(0));
      }
      if (mode === 'task-complete-failure' && process.send) {
        process.send({ type: 'mindcraft:exit-intent', reason: 'task-complete', restartIntent: false }, () => process.exit(1));
      }
      if (mode === 'child-restart-once' && !(await import('node:fs/promises').then(fs => fs.access(${JSON.stringify(path.join(temp, 'restart-once'))}).then(() => true, () => false)))) {
        appendFileSync(${JSON.stringify(path.join(temp, 'restart-once'))}, 'requested');
        if (process.send) process.send({ type: 'mindcraft:exit-intent', reason: 'explicit-restart', restartIntent: true });
        setTimeout(() => process.exit(0), 25);
      }
      if (mode === 'fast-fail') process.exit(2);
      process.on('SIGTERM', () => { if (mode !== 'ignore-term') process.exit(0); });
      setInterval(() => {}, 1000);
    `);

    try {
        // Graceful IPC shutdown settles the owned bot group and its inherited-session descendant.
        const graceful = makeSupervisor('fixture-graceful', 1, { entrypoint: childFile, shutdownTimeout: 300, terminateTimeout: 500, killTimeout: 1000 });
        supervisors.push(graceful);
        await graceful.start();
        assert.equal(await waitFor(async () => (await readMarkers(marker)).length > 0), true);
        assert.equal(await groupExists((await readMarkers(marker))[0].child), true);
        const gracefulPid = graceful.process.pid;
        const gracefulResult = await graceful.stop();
        assert.equal(gracefulResult.groupsGone, true);
        assert.equal(await groupExists(gracefulPid), false);
        assert.equal(graceful.desiredState, 'stopped');

        // A nonresponsive child and TERM-resistant descendant require the bounded KILL fallback.
        await fs.writeFile(marker, '');
        await fs.rm(ready, { force: true });
        process.env.FIXTURE_MODE = 'ignore-term';
        const stuck = makeSupervisor('fixture-stuck', 1, { entrypoint: childFile, shutdownTimeout: 100, terminateTimeout: 100, killTimeout: 1500 });
        supervisors.push(stuck);
        await stuck.start();
        assert.equal(await waitFor(async () => (await readMarkers(marker)).length > 0), true);
        const stuckPids = (await readMarkers(marker))[0];
        assert.equal(await processExists(stuckPids.grandchild), true);
        const stuckPid = stuckPids.child;
        const stuckResult = await stuck.stop();
        assert.equal(stuckResult.groupsGone, true);
        assert.equal(await groupExists(stuckPid), false);

        // A child exit immediately after CLI registration must not produce a stale or foreign signal target.
        await fs.writeFile(marker, '');
        await fs.rm(ready, { force: true });
        process.env.FIXTURE_MODE = 'cli-race';
        const cliRace = makeSupervisor('fixture-cli-race', 1, { entrypoint: childFile, shutdownTimeout: 100, terminateTimeout: 100, killTimeout: 500 });
        supervisors.push(cliRace);
        await cliRace.start();
        assert.equal(await waitFor(() => [...cliRace.ownedGroups.keys()].some(key => key.startsWith('cli:'))), true);
        assert.equal(await waitFor(async () => (await readMarkers(marker)).some(entry => entry.cliGrandchild)), true);
        assert.equal(await waitFor(() => cliRace.process === null, 3000), true);
        assert.equal(cliRace.desiredState, 'stopped');
        assert.equal(cliRace.outcome?.reason, 'normal-exit');
        assert.equal([...cliRace.ownedGroups.values()].length, 0);
        assert.equal((await readMarkers(marker)).some(entry => entry.cliAccepted), true);

        // A private group supplied by an IPC child is rejected without affecting that foreign process.
        foreign = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
        const foreignPid = foreign.pid;
        const foreignRegistration = makeSupervisor('fixture-foreign-registration', 1, { entrypoint: childFile, shutdownTimeout: 300, terminateTimeout: 300, killTimeout: 1000 });
        supervisors.push(foreignRegistration);
        process.env.FOREIGN_PID = String(foreignPid);
        process.env.FIXTURE_MODE = 'foreign-register';
        await foreignRegistration.start();
        assert.equal(await waitFor(async () => (await readMarkers(marker)).some(entry => entry.foreignAck === false), 3000), true);
        assert.equal([...foreignRegistration.ownedGroups.values()].some(group => group.pid === foreignPid), false);
        assert.equal(await groupExists(foreignPid), true);
        try { process.kill(-foreignPid, 'SIGKILL'); } catch {}
        await waitFor(async () => !(await groupExists(foreignPid)), 1000);

        // A reused leader PID with a different starttime cannot authorize a signal to that number.
        delete process.env.FIXTURE_MODE;
        await fs.writeFile(marker, '');
        await fs.rm(ready, { force: true });
        const identityReuse = makeSupervisor('fixture-identity-reuse', 1, { entrypoint: childFile, shutdownTimeout: 300, terminateTimeout: 300, killTimeout: 1000 });
        supervisors.push(identityReuse);
        await identityReuse.start();
        assert.equal(await waitFor(async () => (await readMarkers(marker)).some(entry => entry.child === identityReuse.process?.pid)), true);
        const leaderPid = identityReuse.process.pid;
        const originalReader = identityReuse.readIdentity;
        identityReuse.readIdentity = async pid => {
            const identity = await originalReader(pid);
            return pid === leaderPid && identity ? { ...identity, starttime: 'reused-pid' } : identity;
        };
        await identityReuse.ownedGroups.get(`bot:${identityReuse.generation}`).signal('SIGTERM');
        assert.equal(await processExists(leaderPid), true);
        identityReuse.readIdentity = originalReader;
        await identityReuse.stop();

        // Unknown /proc identity is fail-held: do not treat it as a gone group or authorize a signal.
        await fs.writeFile(marker, '');
        await fs.rm(ready, { force: true });
        const unknownIdentity = makeSupervisor('fixture-unknown-identity', 1, { entrypoint: childFile, shutdownTimeout: 100, terminateTimeout: 50, killTimeout: 100 });
        supervisors.push(unknownIdentity);
        await unknownIdentity.start();
        assert.equal(await waitFor(async () => (await readMarkers(marker)).some(entry => entry.child === unknownIdentity.process?.pid)), true);
        const unknownPid = unknownIdentity.process.pid;
        const knownReader = unknownIdentity.readIdentity;
        unknownIdentity.readIdentity = async pid => pid === unknownPid
            ? { unknown: true, error: new Error('fixture identity unavailable') }
            : knownReader(pid);
        const unknownResult = await unknownIdentity.stop('fixture-unknown-identity');
        assert.equal(unknownResult.groupsGone, false, 'an unknown identity keeps the owned group in a failed-held state');
        assert.ok(unknownResult.cleanupErrors?.some(item => item.pid === unknownPid));
        assert.equal(unknownIdentity.ownedGroups.size > 0, true, 'unconfirmed process groups retain ownership records');
        unknownIdentity.readIdentity = knownReader;
        const recoveredUnknown = await unknownIdentity.stop('fixture-identity-retry');
        assert.equal(recoveredUnknown.groupsGone, true);
        assert.equal(unknownIdentity.ownedGroups.size, 0);

        // The real Codex adapter registers its helper with this AgentProcess before starting the fake CLI.
        // Once the bot enters a synchronous loop, parent shutdown must recover only the owned helper/CLI group.
        await fs.rm(integrationMarker, { force: true });
        await fs.rm(integrationReady, { force: true });
        process.env.MINDCRAFT_CODEX_BIN = fakeCli;
        process.env.MINDCRAFT_INTEGRATION_MARKER = integrationMarker;
        integrationUnrelated = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
        const adapter = makeSupervisor('fixture-codex-adapter', 1, {
            entrypoint: adapterBotFile,
            shutdownTimeout: 100,
            terminateTimeout: 1200,
            killTimeout: 1200,
        });
        supervisors.push(adapter);
        await adapter.start();
        const frozen = waitForMessage(adapter.process, message => message?.type === 'fixture-codex-started');
        const fixtureProcesses = JSON.parse(await waitForValue(async () => {
            try { return await fs.readFile(integrationMarker, 'utf8'); } catch { return false; }
        }));
        assert.equal(await processExists(fixtureProcesses.grandchild), true, 'fake CLI grandchild must be live before shutdown');
        const helperGroupKey = [...adapter.ownedGroups.keys()].find(key => key.startsWith('cli:'));
        assert.ok(helperGroupKey, 'AgentProcess must persist accepted helper ownership before CLI launch');
        const helperPid = adapter.ownedGroups.get(helperGroupKey).pid;
        await frozen;
        const agentPid = adapter.process.pid;
        const adapterOutcome = await adapter.shutdown('fixture-parent-shutdown');
        assert.equal(adapterOutcome.groupsGone, true);
        assert.equal(adapter.process, null);
        assert.equal(adapter.ownedGroups.size, 0);
        assert.equal(await processExists(agentPid), false);
        assert.equal(await processExists(helperPid), false);
        assert.equal(await processExists(fixtureProcesses.cli), false);
        assert.equal(await processExists(fixtureProcesses.grandchild), false);
        assert.equal(require('node:fs').existsSync(fixtureProcesses.dir), false, 'owned helper must remove the Codex request tempdir');
        assert.equal(await groupExists(integrationUnrelated.pid), true, 'shutdown must not signal an unrelated process group');

        // Explicit restart is one transition; a later explicit stop wins over restart intent.
        delete process.env.FIXTURE_MODE;
        const restartOnly = makeSupervisor('fixture-restart-only', 1, { entrypoint: childFile, shutdownTimeout: 500, terminateTimeout: 300, killTimeout: 1000 });
        supervisors.push(restartOnly);
        await restartOnly.start();
        const oldGeneration = restartOnly.generation;
        await Promise.all([restartOnly.forceRestart(), restartOnly.forceRestart()]);
        assert.equal(restartOnly.generation, oldGeneration + 1);
        assert.equal(restartOnly.desiredState, 'running');
        await restartOnly.stop();

        const explicit = makeSupervisor('fixture-explicit', 1, { entrypoint: childFile, shutdownTimeout: 500, terminateTimeout: 300, killTimeout: 1000 });
        supervisors.push(explicit);
        await explicit.start();
        const restart = explicit.forceRestart();
        const stopped = explicit.stop();
        await Promise.all([restart, stopped]);
        assert.equal(explicit.desiredState, 'stopped');
        assert.equal(explicit.process, null);

        const childRestart = makeSupervisor('fixture-child-restart', 1, { entrypoint: childFile, shutdownTimeout: 300, terminateTimeout: 300, killTimeout: 1000 });
        supervisors.push(childRestart);
        process.env.FIXTURE_MODE = 'child-restart-once';
        await childRestart.start();
        assert.equal(await waitFor(() => childRestart.generation === 2, 3000), true);
        await childRestart.stop();

        const childAutoRestart = makeSupervisor('fixture-child-auto-restart', 1, {
            entrypoint: childFile,
            shutdownTimeout: 300,
            terminateTimeout: 300,
            killTimeout: 1000,
            minimumRestartLifetimeMs: 0,
            restartWindowMs: 1000,
            maxAbnormalRestarts: 2,
            restartBackoffBaseMs: 10,
            restartBackoffMaxMs: 20,
        });
        supervisors.push(childAutoRestart);
        process.env.FIXTURE_MODE = 'child-auto-restart';
        await childAutoRestart.start();
        assert.equal(await waitFor(() => childAutoRestart.outcome?.reason === 'restart-budget-exhausted', 3000), true);
        assert.equal(childAutoRestart.generation, 3, 'automatic restart intent consumes the bounded restart budget');
        assert.equal(childAutoRestart.desiredState, 'stopped');

        const childAutoStopRace = makeSupervisor('fixture-child-auto-stop-race', 1, { entrypoint: childFile, shutdownTimeout: 300, terminateTimeout: 300, killTimeout: 1000 });
        supervisors.push(childAutoStopRace);
        process.env.FIXTURE_MODE = 'child-auto-stop-race';
        await childAutoStopRace.start();
        assert.equal(await waitFor(() => childAutoStopRace.childExitIntent?.reason === 'startup-error'), true);
        const stopWinsAutoRestart = await childAutoStopRace.stop('fixture-parent-stop-wins');
        assert.equal(stopWinsAutoRestart.groupsGone, true);
        assert.equal(childAutoStopRace.generation, 1, 'parent stop must beat automatic child restart intent');
        assert.equal(childAutoStopRace.desiredState, 'stopped');

        const childStop = makeSupervisor('fixture-child-stop', 1, { entrypoint: childFile, shutdownTimeout: 300, terminateTimeout: 300, killTimeout: 1000 });
        supervisors.push(childStop);
        process.env.FIXTURE_MODE = 'child-stop-term';
        await childStop.start();
        assert.equal(await waitFor(() => childStop.process === null, 3000), true);
        assert.equal(childStop.generation, 1);
        assert.equal(childStop.desiredState, 'stopped');

        const parentStop = makeSupervisor('fixture-parent-sigterm', 1, { entrypoint: childFile, shutdownTimeout: 300, terminateTimeout: 300, killTimeout: 1000 });
        supervisors.push(parentStop);
        process.env.FIXTURE_MODE = 'graceful';
        await parentStop.start();
        assert.equal(await waitFor(async () => (await readMarkers(marker)).some(entry => entry.child === parentStop.process?.pid)), true);
        await parentStop.shutdown('parent-SIGTERM');
        assert.equal(parentStop.generation, 1);
        assert.equal(parentStop.desiredState, 'stopped');
        assert.equal(parentStop.outcome.groupsGone, true);

        const budget = makeSupervisor('fixture-budget', 1, {
            entrypoint: childFile,
            shutdownTimeout: 300,
            terminateTimeout: 300,
            killTimeout: 1000,
            minimumRestartLifetimeMs: 10,
            // Keep the test's restart budget window longer than its bounded wait,
            // even when owned process-group cleanup reaches its timeout.
            restartWindowMs: 10_000,
            maxAbnormalRestarts: 2,
            restartBackoffBaseMs: 10,
            restartBackoffMaxMs: 20,
        });
        supervisors.push(budget);
        process.env.FIXTURE_MODE = 'budget';
        process.env.FIXTURE_EXIT_DELAY = '50';
        await budget.start();
        assert.equal(await waitFor(() => budget.outcome?.reason === 'restart-budget-exhausted', 3000), true);
        assert.equal(budget.generation, 3);
        assert.equal(budget.desiredState, 'stopped');

        const spawnFailure = makeSupervisor('fixture-spawn-failure', 1, {
            spawn: () => { throw new Error('fixture spawn failure'); },
        });
        supervisors.push(spawnFailure);
        const failure = await spawnFailure.start();
        assert.equal(failure.reason, 'spawn-error');
        assert.match(failure.error, /fixture spawn failure/);

        // code > 1 retains the task-ending outcome without asking this library to exit the test runner.
        process.env.FIXTURE_MODE = 'fast-fail';
        const taskEnd = makeSupervisor('fixture-task-end', 1, { entrypoint: childFile, shutdownTimeout: 100, terminateTimeout: 100, killTimeout: 300 });
        supervisors.push(taskEnd);
        await taskEnd.start();
        assert.equal(await waitFor(() => taskEnd.outcome?.state === 'task-ending', 3000), true);
        assert.equal(taskEnd.outcome.code, 2);
        assert.equal(process.exitCode, 2);
        process.exitCode = 0;

        const taskCompleteCallbacks = [];
        const taskComplete = makeSupervisor('fixture-task-complete', 1, {
            entrypoint: childFile,
            shutdownTimeout: 100,
            terminateTimeout: 100,
            killTimeout: 300,
            onTaskEnding: outcome => taskCompleteCallbacks.push(outcome),
        });
        supervisors.push(taskComplete);
        process.env.FIXTURE_MODE = 'task-complete';
        await taskComplete.start();
        assert.equal(await waitFor(() => taskComplete.outcome?.state === 'task-ending', 3000), true);
        assert.equal(taskComplete.outcome.reason, 'task-complete');
        assert.equal(taskComplete.outcome.code, 0, 'normal task completion must retain the parent exit code 0');
        assert.equal(taskComplete.outcome.childCode, 0);
        assert.equal(process.exitCode, 0);
        assert.equal(taskCompleteCallbacks.length, 1);
        assert.equal(taskCompleteCallbacks[0].code, 0);
        assert.equal(taskCompleteCallbacks[0].reason, 'task-complete');
        process.exitCode = 0;

        const taskCompleteFailureCallbacks = [];
        const taskCompleteFailure = makeSupervisor('fixture-task-complete-failure', 1, {
            entrypoint: childFile,
            shutdownTimeout: 100,
            terminateTimeout: 100,
            killTimeout: 300,
            onTaskEnding: outcome => taskCompleteFailureCallbacks.push(outcome),
        });
        supervisors.push(taskCompleteFailure);
        process.env.FIXTURE_MODE = 'task-complete-failure';
        await taskCompleteFailure.start();
        assert.equal(await waitFor(() => taskCompleteFailure.outcome?.state === 'task-ending', 3000), true);
        assert.equal(taskCompleteFailure.outcome.reason, 'task-complete');
        assert.equal(taskCompleteFailure.outcome.code, 1, 'task-complete intent must not hide an actual nonzero child exit');
        assert.equal(taskCompleteFailure.outcome.childCode, 1);
        assert.equal(process.exitCode, 1);
        assert.equal(taskCompleteFailureCallbacks.length, 1);
        assert.equal(taskCompleteFailureCallbacks[0].code, 1);
        assert.equal(taskCompleteFailureCallbacks[0].childCode, 1);
        process.exitCode = 0;

        const authRegistrations = [];
        const authRevocations = [];
        let authMarker = path.join(temp, 'auth-first.json');
        process.env.FIXTURE_AUTH_MARKER = authMarker;
        const protectedChild = makeSupervisor('fixture-protected-child', 1, {
            entrypoint: authChild,
            managementAuthMode: 'protected',
            registerBotCredential: (_name, spawnId, token) => authRegistrations.push({ spawnId, token }),
            revokeBotCredential: (_name, spawnId) => authRevocations.push(spawnId),
            shutdownTimeout: 500, terminateTimeout: 300, killTimeout: 500,
        });
        supervisors.push(protectedChild);
        await protectedChild.start();
        assert.equal(await waitFor(() => fs.access(authMarker).then(() => true, () => false)), true,
            'parent delivers bot credential over the existing child IPC channel');
        const firstAuth = JSON.parse(await fs.readFile(authMarker, 'utf8'));
        assert.deepEqual(firstAuth, authRegistrations[0], 'child receives exactly the spawn-bound credential registered with the hub');
        await protectedChild.stop('auth-fixture-restart');
        assert.deepEqual(authRevocations, [firstAuth.spawnId], 'stopping a generation revokes its credential');
        authMarker = path.join(temp, 'auth-second.json');
        process.env.FIXTURE_AUTH_MARKER = authMarker;
        await protectedChild.start();
        assert.equal(await waitFor(() => fs.access(authMarker).then(() => true, () => false)), true);
        const secondAuth = JSON.parse(await fs.readFile(authMarker, 'utf8'));
        assert.notEqual(secondAuth.spawnId, firstAuth.spawnId, 'restarted child receives a distinct spawn identity');
        assert.notEqual(secondAuth.token, firstAuth.token, 'restarted child receives a fresh private token');
        await protectedChild.stop('auth-fixture-done');

        console.log('AgentProcess supervisor fixtures passed');
    } finally {
        delete process.env.FIXTURE_MODE;
        delete process.env.FIXTURE_EXIT_DELAY;
        delete process.env.FOREIGN_PID;
        delete process.env.FIXTURE_AUTH_MARKER;
        if (previousCodexBinary === undefined) delete process.env.MINDCRAFT_CODEX_BIN;
        else process.env.MINDCRAFT_CODEX_BIN = previousCodexBinary;
        if (previousIntegrationMarker === undefined) delete process.env.MINDCRAFT_INTEGRATION_MARKER;
        else process.env.MINDCRAFT_INTEGRATION_MARKER = previousIntegrationMarker;
        for (const supervisor of supervisors) {
            try {
                await supervisor.stop('test-cleanup');
                assert.equal(supervisor.outcome?.groupsGone, true, `${supervisor.name} retained an owned group`);
                assert.equal(supervisor.ownedGroups.size, 0, `${supervisor.name} retained ownership records`);
            } catch (error) {
                console.error(`Cleanup failed for ${supervisor.name}:`, error);
                process.exitCode = 1;
            }
        }
        if (typeof foreign?.pid === 'number') {
            try { process.kill(-foreign.pid, 'SIGKILL'); } catch {}
        }
        if (typeof integrationUnrelated?.pid === 'number') {
            try { process.kill(-integrationUnrelated.pid, 'SIGKILL'); } catch {}
        }
        await fs.rm(temp, { recursive: true, force: true });
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
