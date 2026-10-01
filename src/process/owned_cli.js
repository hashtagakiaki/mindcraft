import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const START_TIMEOUT_MS = 5000;
const TERMINATE_GRACE_MS = 250;
const GROUP_POLL_MS = 20;

const [requestId, command, serializedArgs, expectedWorkingDirectory] = process.argv.slice(2);
const args = JSON.parse(serializedArgs || '[]');
let input = '';
let inputClosed = false;
let started = false;
let stopping = false;
let cli = null;
let killTimer = null;
let stopPollTimer = null;
let exitCode = null;
let forceKillDeadline = null;

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
    inputClosed = true;
    if (cli?.stdin.writable) cli.stdin.end();
});

const startTimer = setTimeout(() => {
    if (!started) exitAfterCleanup();
}, START_TIMEOUT_MS);

process.on('message', message => {
    if (!message || typeof message !== 'object' || message.requestId !== requestId) return;
    if (message.type === 'start' && !started && !stopping) {
        started = true;
        clearTimeout(startTimer);
        startCli();
    } else if (message.type === 'cancel') {
        stopOwnedGroup();
    }
});

process.on('disconnect', () => {
    if (started) stopOwnedGroup();
    else exitAfterCleanup();
});

process.on('SIGTERM', () => {
    if (started) stopOwnedGroup();
    else exitAfterCleanup();
});

process.on('SIGINT', () => {
    if (started) stopOwnedGroup();
    else exitAfterCleanup();
});

if (!process.connected) exitAfterCleanup();

function startCli() {
    try {
        cli = spawn(command, args, {
            stdio: ['pipe', 'inherit', 'ignore'],
            detached: false
        });
    } catch (error) {
        sendError(error);
        exitCode = 1;
        finishIfGroupEmpty();
        return;
    }

    cli.on('error', error => {
        sendError(error);
        exitCode = 1;
    });
    cli.on('close', (code, signal) => {
        exitCode = code ?? (signal ? 1 : 0);
        finishIfGroupEmpty();
    });
    cli.stdin.on('error', () => {});
    if (inputClosed) cli.stdin.end(input);
    else {
        cli.stdin.write(input);
        process.stdin.on('data', chunk => {
            if (cli?.stdin.writable) cli.stdin.write(chunk);
        });
    }
}

function sendError(error) {
    if (!process.connected) return;
    try {
        process.send({ type: 'owned-cli-error', requestId, message: `Could not start Codex CLI: ${error.message}` });
    } catch {}
}

function stopOwnedGroup() {
    if (stopping) return;
    stopping = true;
    signalGroup('SIGTERM');
    forceKillDeadline = Date.now() + TERMINATE_GRACE_MS;
    killTimer = setTimeout(() => {
        signalDescendants('SIGKILL');
        pollForStop();
    }, TERMINATE_GRACE_MS);
    pollForStop();
}

function pollForStop() {
    if (!hasLiveDescendant()) {
        clearTimeout(killTimer);
        clearTimeout(stopPollTimer);
        process.exitCode = exitCode ?? 0;
        exitAfterCleanup();
        return;
    }
    if (stopping && forceKillDeadline !== null && Date.now() >= forceKillDeadline) signalDescendants('SIGKILL');
    stopPollTimer = setTimeout(pollForStop, GROUP_POLL_MS);
}

function finishIfGroupEmpty() {
    if (hasLiveDescendant()) {
        stopOwnedGroup();
        return;
    }
    clearTimeout(startTimer);
    process.exitCode = exitCode ?? 0;
    exitAfterCleanup();
}

function exitAfterCleanup() {
    clearTimeout(startTimer);
    const workingDirectory = process.cwd();
    let ownsWorkingDirectory = false;
    try { ownsWorkingDirectory = readFileSync(path.join(workingDirectory, '.mindcraft-codex-owner'), 'utf8') === requestId; }
    catch {}
    if (ownsWorkingDirectory && path.resolve(workingDirectory) === path.resolve(expectedWorkingDirectory) &&
        /^mindcraft-codex-[A-Za-z0-9_-]+$/.test(path.basename(workingDirectory))) {
        try { rmSync(workingDirectory, { recursive: true, force: true }); }
        catch {}
    }
    process.exit();
}

function signalGroup(signal) {
    let ownIdentity;
    try { ownIdentity = readSessionIdentity(process.pid); }
    catch { return false; }
    if (!ownIdentity || ownIdentity.pgid !== process.pid || ownIdentity.sid !== process.pid || !hasLiveDescendant()) return;
    try { process.kill(-process.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
}

function signalDescendants(signal) {
    let members;
    try { members = liveDescendantPids(); }
    catch { return false; }
    for (const { pid, identity: captured } of members) {
        let identity;
        try { identity = readSessionIdentity(pid); }
        catch { return false; }
        if (!identity) continue;
        if (identity.starttime !== captured.starttime || identity.pgid !== process.pid || identity.sid !== process.pid) continue;
        try { process.kill(pid, signal); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    return true;
}

function readSessionIdentity(pid) {
    let stat;
    try {
        stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
        throw error;
    }
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const state = fields[0];
    const pgid = Number(fields[2]);
    const sid = Number(fields[3]);
    const starttime = fields[19];
    if (!/^[A-Za-z]$/.test(state || '') || !Number.isSafeInteger(pgid) || !Number.isSafeInteger(sid) ||
        !/^\d+$/.test(starttime || '')) throw new Error(`Invalid /proc/${pid}/stat identity`);
    return { state, pgid, sid, starttime };
}

function liveDescendantPids() {
    return readdirSync('/proc')
        .filter(entry => /^\d+$/.test(entry) && Number(entry) !== process.pid)
        .map(Number)
        .map(pid => ({ pid, identity: readSessionIdentity(pid) }))
        .filter(({ identity }) => identity && identity.pgid === process.pid && identity.sid === process.pid && identity.state !== 'Z' && identity.state !== 'X');
}

function hasLiveDescendant() {
    try { return liveDescendantPids().length > 0; }
    catch {
        // Missing process visibility is unknown, never evidence of cleanup.
        return true;
    }
}
