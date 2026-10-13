#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '../..');
const pluginRoot = path.join(repoRoot, 'packages/magpie-probe');

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!['--magpie', '--bun', '--report-dir'].includes(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (arg !== '--report-dir' && !path.isAbsolute(value)) throw new Error(`${arg} must be an absolute path`);
    options[arg.slice(2)] = path.resolve(value);
  }
  if (!options.magpie || !options.bun) {
    throw new Error('Usage: node scripts/ci/magpie-plugin-probe.mjs --magpie ABSOLUTE_PATH --bun ABSOLUTE_PATH [--report-dir PATH]');
  }
  return options;
}

export function makeChildEnv(home, port, key, bun) {
  const binDirs = [...new Set([path.dirname(bun), path.dirname(process.execPath), '/usr/bin', '/bin'])];
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    MAGPIE_BUN: bun,
    MAGPIE_NO_ACCOUNTS: '1',
    MAGPIE_NO_STATS: '1',
    DO_NOT_TRACK: '1',
    MAGPIE_WEB_KEY: key,
    MAGPIE_ADDR: `127.0.0.1:${port}`,
    PATH: binDirs.join(path.delimiter),
  };
}

export function processDescendants(processes, rootIdentities) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const owned = [];
  const seen = new Set(rootIdentities.map((root) => root.pid));
  const queue = rootIdentities.flatMap((root) => {
    const live = byPid.get(root.pid);
    return live && live.started === root.started && live.command === root.command ? [root.pid] : [];
  });
  while (queue.length) {
    const parentPid = queue.shift();
    for (const entry of processes) {
      if (entry.ppid === parentPid && !seen.has(entry.pid)) {
        seen.add(entry.pid);
        owned.push(entry);
        queue.push(entry.pid);
      }
    }
  }
  return owned;
}

function randomPort() {
  return 20000 + randomBytes(2).readUInt16BE(0) % 40000;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function requestJson(baseUrl, cookie, route, method = 'GET', body) {
  const timeoutMs = method === 'GET' ? 5000 : 45000;
  try {
    const response = await fetch(new URL(`/api/${route}`, baseUrl), {
      method,
      headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} /api/${route} returned HTTP ${response.status}: ${text.slice(0, 400)}`);
    try { return JSON.parse(text); } catch { throw new Error(`${method} /api/${route} returned invalid JSON: ${text.slice(0, 400)}`); }
  } catch (error) {
    throw new Error(`${method} /api/${route} failed (timeout ${timeoutMs}ms): ${error.message}`);
  }
}

function findProbeState(root, maxDepth = 8) {
  return async () => {
    const pending = [{ dir: root, depth: 0 }];
    while (pending.length) {
      const { dir, depth } = pending.shift();
      let entries;
      try { entries = await (await import('node:fs/promises')).readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === 'state.json' && dir.endsWith('monitor-plugin-probe')) return full;
        if (entry.isDirectory() && depth < maxDepth) pending.push({ dir: full, depth: depth + 1 });
      }
    }
    return null;
  };
}

async function readState(statePath) {
  return JSON.parse(await readFile(statePath, 'utf8'));
}

function assertGate(condition, name, detail) {
  if (!condition) throw new Error(`${name}: ${detail}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomBytes(4).toString('hex')}`;
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'magpie-plugin-probe-'));
  const home = path.join(tempRoot, 'home');
  const webDir = path.join(home, '.config', 'magpie');
  const reportDir = options['report-dir'] ? path.resolve(options['report-dir']) : path.join(repoRoot, 'reports', 'magpie-plugin-probe', runId);
  const report = { runId, startedAt: new Date().toISOString(), version: null, platform: `${process.platform}/${process.arch}`, gates: [], cleanup: { complete: false } };
  const children = new Set();
  const allChildren = [];
  const verifiedPluginProcesses = new Map();
  const webProcessIdentities = new Map();
  let authKey;
  let baseUrl;
  let cookieResponse;
  let statePath;
  let currentPhase = 'setup';
  let webProcess;
  let fatal;

  const record = (name, passed, detail) => report.gates.push({ name, passed, detail });
  const verifyOwnedPlugin = async (pid, parentPid) => {
    const identity = await processIdentity(pid);
    assertGate(identity?.ppid === parentPid, 'plugin-child-identity', `plugin PID ${pid} parent=${identity?.ppid}, expected web PID=${parentPid}`);
    verifiedPluginProcesses.set(pid, identity);
    return identity;
  };
  const rememberWebProcess = async (child) => {
    const identity = await processIdentity(child.pid);
    assertGate(identity !== null, 'web-process-identity', `Magpie web PID ${child.pid} is not visible to ps`);
    webProcessIdentities.set(child.pid, identity);
  };
  const launch = (command, args, env, name) => {
    const child = spawn(command, args, { env, cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    child.label = name;
    child.closed = false;
    child.output = '';
    const collect = (chunk) => { child.output = `${child.output}${chunk.toString()}`.slice(-65536); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => { child.spawnError = error; });
    children.add(child);
    allChildren.push(child);
    child.once('close', () => { child.closed = true; children.delete(child); });
    return child;
  };
  const stopChild = async (child) => {
    if (!child || child.closed) return;
    const waitClose = (ms) => Promise.race([
      new Promise((resolve) => child.once('close', resolve)),
      sleep(ms),
    ]);
    if (!child.spawnError && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await waitClose(5000);
    if (!child.closed && !child.spawnError) {
      child.kill('SIGKILL');
      await waitClose(5000);
    }
  };

  try {
    await mkdir(webDir, { recursive: true });
    await mkdir(reportDir, { recursive: true });
    const versionEnv = makeChildEnv(home, randomPort(), randomBytes(24).toString('base64url'), options.bun);
    const bunVersion = await new Promise((resolve, reject) => {
      const child = spawn(options.bun, ['--version'], { env: versionEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`Bun version exited ${code}`)));
    });
    const magpieVersion = await new Promise((resolve, reject) => {
      const child = spawn(options.magpie, ['--version'], { env: versionEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`Magpie version exited ${code}`)));
    });
    report.version = { magpie: magpieVersion, bun: bunVersion };
    const webPort = randomPort();
    authKey = randomBytes(24).toString('base64url');
    const env = makeChildEnv(home, webPort, authKey, options.bun);
    const gatewayPort = randomPort();
    env.MAGPIE_ADDR = `127.0.0.1:${gatewayPort}`;
    baseUrl = `http://127.0.0.1:${webPort}`;
    report.web = { address: baseUrl, webPid: null, gatewayAddress: env.MAGPIE_ADDR };
    report.fixture = { namespace: 'monitor-plugin-probe', sequencesAppended: [], consumedOnce: false };
    report.visualUiVerification = 'Not attempted; browser loopback is unavailable in this environment. Calls use the installed Plugins UI management API.';
    await mkdir(path.join(webDir, 'plugins'), { recursive: true });
    cookieResponse = await (async () => {
      webProcess = launch(options.magpie, ['web', '--no-open', '--gateway', '--addr', `127.0.0.1:${webPort}`], env, 'magpie-web');
      report.web.webPid = webProcess.pid;
      return waitFor(async () => {
        if (webProcess.spawnError) throw webProcess.spawnError;
        if (webProcess.exitCode !== null) throw new Error(`Magpie web exited ${webProcess.exitCode}`);
        const response = await fetch(`${baseUrl}/?k=${encodeURIComponent(authKey)}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        if (response.status !== 303) return null;
        const setCookie = response.headers.get('set-cookie');
        if (!setCookie) throw new Error('Auth redirect did not set a cookie');
        return setCookie.split(';', 1)[0];
      }, 20000, 'Magpie web authentication');
    })();
    const initial = await requestJson(baseUrl, cookieResponse, 'plugins');
    await rememberWebProcess(webProcess);
    assertGate(Array.isArray(initial.plugins) && initial.plugins.length === 0, 'clean-plugin-list', 'isolated HOME did not start with an empty plugin list');
    assertGate(initial.bun === true && initial.bunVersion === bunVersion, 'reused-bun', `web reported Bun ${initial.bunVersion}`);
    record('runtime-and-web', true, `Magpie web PID ${webProcess.pid}; bundled Bun ${bunVersion}; gateway mode on loopback`);

    const spec = pluginRoot;
    currentPhase = 'install-plugin-via-web-api';
    await requestJson(baseUrl, cookieResponse, 'plugins/add', 'POST', { spec });
    currentPhase = 'confirm-plugin-registration';
    const installed = await waitFor(async () => {
      const state = await requestJson(baseUrl, cookieResponse, 'plugins');
      return state.plugins?.find((entry) => entry.spec === spec);
    }, 15000, 'plugin installation');
    record('installed-via-web-management-api', true, `plugins/add registered ${installed.spec}`);

    currentPhase = 'wait-for-first-plugin-tick';
    statePath = await waitFor(findProbeState(home), 20000, 'plugin state file');
    const stateDir = path.dirname(statePath);
    const fixturePath = path.join(stateDir, 'fixture.jsonl');
    const initialState = await waitFor(async () => {
      const state = await readState(statePath);
      return state.startedAt && state.runId ? state : null;
    }, 15000, 'first plugin tick');
    const firstIdentity = await verifyOwnedPlugin(initialState.ownerPid, webProcess.pid);
    const firstParentPid = firstIdentity.ppid;
    assertGate(firstParentPid === webProcess.pid, 'host-owned-first-run', `plugin process parent=${firstParentPid}, web PID=${webProcess.pid}`);
    record('host-owned-first-run', true, `plugin PID ${initialState.ownerPid} is a direct child of web PID ${webProcess.pid}`);
    const tickPeriod = 1000;
    const waitAdvancingTicks = async (beforeTick, count, budget = 12000) => waitFor(async () => {
      const state = await readState(statePath);
      assertGate(state.runId === initialState.runId && state.ownerPid === initialState.ownerPid, 'persistent-host-identity', 'plugin owner or run changed during persistent tick check');
      return state.tick >= beforeTick + count ? state : null;
    }, budget, `${count} advancing ticks`);
    const stable = await waitAdvancingTicks(initialState.tick, 3);
    record('persistent-host-ticks', true, `tick advanced ${initialState.tick} -> ${stable.tick} under Magpie web PID ${webProcess.pid}`);

    await appendFile(fixturePath, `${JSON.stringify({ probe: true, sequence: 1 })}\n`);
    const consumedOne = await waitFor(async () => {
      const state = await readState(statePath);
      assertGate(state.runId === initialState.runId && state.ownerPid === initialState.ownerPid, 'fixture-host-identity', 'plugin owner or run changed while consuming fixture sequence 1');
      return state.cursor === 1 && state.processedCount === 1 ? state : null;
    }, 8000, 'fixture sequence 1 consumption');
    await appendFile(fixturePath, `${JSON.stringify({ probe: true, sequence: 2 })}\n`);
    const consumedTwo = await waitFor(async () => {
      const state = await readState(statePath);
      assertGate(state.runId === initialState.runId && state.ownerPid === initialState.ownerPid, 'fixture-host-identity', 'plugin owner or run changed while consuming fixture sequence 2');
      return state.cursor === 2 && state.processedCount === 2 ? state : null;
    }, 8000, 'fixture sequence 2 consumption');
    report.fixture.sequencesAppended.push(1, 2);
    report.fixture.consumedOnce = consumedTwo.processedCount === 2 && consumedOne.processedCount === 1;
    record('append-exactly-once', report.fixture.consumedOnce, `cursor=${consumedTwo.cursor}, processedCount=${consumedTwo.processedCount}`);

    await requestJson(baseUrl, cookieResponse, 'plugins/off', 'POST', { spec, off: true });
    await waitFor(async () => {
      const state = await requestJson(baseUrl, cookieResponse, 'plugins');
      const entry = state.plugins?.find((item) => item.spec === spec);
      return entry?.off === true;
    }, 8000, 'plugin off state');
    const offSnapshot = await readState(statePath);
    await appendFile(fixturePath, `${JSON.stringify({ probe: true, sequence: 3 })}\n`);
    report.fixture.sequencesAppended.push(3);
    await sleep(tickPeriod * 3 + 500);
    const afterOff = await readState(statePath);
    assertGate(afterOff.runId === offSnapshot.runId && afterOff.ownerPid === initialState.ownerPid && afterOff.cursor === 2 && afterOff.processedCount === 2, 'off-preserves-checkpoint', `off state run=${afterOff.runId}, owner=${afterOff.ownerPid}, cursor=${afterOff.cursor}, processedCount=${afterOff.processedCount}`);
    const oldOwner = afterOff.ownerPid;
    await waitFor(async () => !await sameProcessIdentity(oldOwner, firstIdentity), 8000, `disabled plugin process ${oldOwner} exit`);
    assertGate(afterOff.tick === offSnapshot.tick, 'off-stops-ticks-after-snapshot', `tick changed ${offSnapshot.tick} -> ${afterOff.tick} over 3.5 periods after off completed`);
    record('off-stops-host', true, `tick remained ${afterOff.tick} for 3.5 periods; old owner PID ${oldOwner} exited`);

    await requestJson(baseUrl, cookieResponse, 'plugins/off', 'POST', { spec, off: false });
    const resumed = await waitFor(async () => {
      const state = await readState(statePath);
      return state.runId !== consumedTwo.runId && state.resumedFrom?.cursor === 2 ? state : null;
    }, 15000, 'plugin on and checkpoint resume');
    const resumedIdentity = await verifyOwnedPlugin(resumed.ownerPid, webProcess.pid);
    const resumedParentPid = resumedIdentity.ppid;
    assertGate(resumedParentPid === webProcess.pid, 'host-owned-toggle-restart', `plugin process parent=${resumedParentPid}, web PID=${webProcess.pid}`);
    record('host-owned-toggle-restart', true, `plugin PID ${resumed.ownerPid} is a direct child of web PID ${webProcess.pid}`);
    assertGate(resumed.resumedFrom?.cursor === 2 && resumed.cursor >= 2 && resumed.cursor <= 3 && resumed.processedCount === resumed.cursor, 'no-replay-after-toggle', `resumedFrom=${resumed.resumedFrom?.cursor}, cursor=${resumed.cursor}, processedCount=${resumed.processedCount}`);
    const caughtUp = await waitFor(async () => {
      const state = await readState(statePath);
      assertGate(state.runId === resumed.runId && state.ownerPid === resumed.ownerPid, 'toggle-host-identity', 'owner/run changed while catching up after enabling');
      return state.cursor === 3 && state.processedCount === 3 ? state : null;
    }, 8000, 'fixture sequence 3 catch-up');
    report.fixture.consumedOnce = caughtUp.processedCount === 3;
    record('on-resumes-checkpoint', true, `new run ${resumed.runId} resumed cursor 2 and caught up sequence 3 once`);

    const firstRun = resumed.runId;
    await stopChild(webProcess);
    await waitFor(async () => !await sameProcessIdentity(resumed.ownerPid, resumedIdentity), 8000, `pre-restart plugin process ${resumed.ownerPid} exit`);
    await appendFile(fixturePath, `${JSON.stringify({ probe: true, sequence: 4 })}\n`);
    report.fixture.sequencesAppended.push(4);
    webProcess = launch(options.magpie, ['web', '--no-open', '--gateway', '--addr', `127.0.0.1:${webPort}`], env, 'magpie-web-restart');
    report.web.restartPid = webProcess.pid;
    await waitFor(async () => {
      if (webProcess.spawnError) throw webProcess.spawnError;
      if (webProcess.exitCode !== null) throw new Error(`Magpie web restart exited ${webProcess.exitCode}`);
      const response = await fetch(`${baseUrl}/?k=${encodeURIComponent(authKey)}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      return response.status === 303;
    }, 20000, 'restarted Magpie web auth');
    await rememberWebProcess(webProcess);
    const afterRestart = await waitFor(async () => {
      const state = await readState(statePath);
      return state.runId !== firstRun && state.resumedFrom?.cursor === 3 ? state : null;
    }, 15000, 'plugin restart recovery');
    assertGate(afterRestart.resumedFrom?.cursor === 3 && afterRestart.cursor >= 3 && afterRestart.cursor <= 4 && afterRestart.processedCount === afterRestart.cursor, 'web-restart-no-replay', `resumedFrom=${afterRestart.resumedFrom?.cursor}, cursor=${afterRestart.cursor}, processedCount=${afterRestart.processedCount}`);
    const restartIdentity = await verifyOwnedPlugin(afterRestart.ownerPid, webProcess.pid);
    const ppid = restartIdentity.ppid;
    assertGate(ppid === webProcess.pid, 'host-owned-child', `plugin host ownerPid=${afterRestart.ownerPid}, parent=${ppid}, webPid=${webProcess.pid}`);
    record('host-owned-web-restart', true, `plugin PID ${afterRestart.ownerPid} is a direct child of web PID ${webProcess.pid}`);
    const finalState = await waitFor(async () => {
      const state = await readState(statePath);
      assertGate(state.runId === afterRestart.runId && state.ownerPid === afterRestart.ownerPid, 'web-restart-host-identity', 'owner/run changed after full web restart');
      return state.cursor === 4 && state.processedCount === 4 ? state : null;
    }, 8000, 'sequence 4 after full web restart');
    record('full-web-restart', true, `new web PID ${webProcess.pid} resumed cursor 3 and consumed sequence 4 once (cursor ${finalState.cursor})`);
  } catch (error) {
    fatal = error;
    report.phase = currentPhase;
    record('runner', false, error.message);
    report.diagnostics = {};
    if (baseUrl && cookieResponse) {
      try { report.diagnostics.pluginListAtFailure = await requestJson(baseUrl, cookieResponse, 'plugins'); } catch (snapshotError) { report.diagnostics.pluginListError = snapshotError.message; }
    }
    if (statePath) {
      try { report.diagnostics.stateAtFailure = await readState(statePath); } catch (snapshotError) { report.diagnostics.stateError = snapshotError.message; }
    }
  } finally {
    const processTable = await listProcesses().catch(() => []);
    const discovered = processDescendants(processTable, [...webProcessIdentities].map(([pid, identity]) => ({ pid, ...identity })));
    for (const entry of discovered) verifiedPluginProcesses.set(entry.pid, entry);
    report.cleanup.discoveredDescendants = discovered.map(({ pid, ppid, command }) => ({ pid, ppid, command }));
    for (const [pid, identity] of verifiedPluginProcesses) {
      if (await sameProcessIdentity(pid, identity)) await terminatePid(pid, identity);
    }
    for (const child of [...children]) await stopChild(child);
    const stillRunningOwned = [];
    for (const [pid, identity] of verifiedPluginProcesses) {
      if (await sameProcessIdentity(pid, identity)) stillRunningOwned.push(pid);
    }
    report.cleanup.complete = children.size === 0 && [...children].every((child) => child.closed) && stillRunningOwned.length === 0 && (!webProcess || webProcess.closed || webProcess.spawnError);
    report.cleanup.remainingOwnedPids = stillRunningOwned;
    if (!report.cleanup.complete) report.cleanup.preservedTempRoot = tempRoot;
    record('cleanup', report.cleanup.complete, report.cleanup.complete ? 'All runner-owned Magpie and plugin processes exited.' : `Runner children: ${[...children].map((child) => child.pid).join(', ')}; plugin PIDs: ${stillRunningOwned.join(', ')}`);
    report.finishedAt = new Date().toISOString();
    if (fatal) report.error = fatal.message;
    if (fatal) {
      report.diagnostics ||= {};
      report.diagnostics.childLogs = allChildren.map((child) => ({
        label: child.label,
        output: redactLog(child.output, authKey),
      }));
    }
    const safeReport = redactSecrets(report, [authKey, cookieResponse]);
    await writeFile(path.join(reportDir, 'report.json'), `${JSON.stringify(safeReport, null, 2)}\n`);
    await writeFile(path.join(reportDir, 'report.md'), renderMarkdown(safeReport));
    if (report.cleanup.complete) await rm(tempRoot, { recursive: true, force: true });
    process.exitCode = fatal || report.gates.some((gate) => !gate.passed) ? 1 : 0;
  }
}

function redactLog(value, key) {
  return key ? value.split(key).join('[redacted-web-key]') : value;
}

export function redactSecrets(value, secrets) {
  if (typeof value === 'string') return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('[redacted]'), value);
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSecrets(entry, secrets)]));
  return value;
}

async function terminatePid(pid, identity) {
  if (!await sameProcessIdentity(pid, identity)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  try {
    await waitFor(async () => !await sameProcessIdentity(pid, identity), 8000, `owned plugin process ${pid} exit`);
  } catch {
    if (await sameProcessIdentity(pid, identity)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* Process already exited. */ }
      await waitFor(async () => !await sameProcessIdentity(pid, identity), 5000, `owned plugin process ${pid} SIGKILL`).catch(() => {});
    }
  }
}

async function processParentPid(pid) {
  return (await processIdentity(pid))?.ppid ?? null;
}

async function processIdentity(pid) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-o', 'ppid=', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)], { env: { PATH: '/usr/bin:/bin' } }, (error, stdout) => {
      if (error) return resolve(null);
      const fields = stdout.trim().split(/\s+/);
      const parent = Number(fields[0]);
      if (!Number.isInteger(parent) || parent < 1 || fields.length < 7) return resolve(null);
      resolve({ ppid: parent, started: fields.slice(1, 6).join(' '), command: fields.slice(6).join(' ') });
    });
  });
}

async function listProcesses() {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-axo', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'command='], { env: { PATH: '/usr/bin:/bin' }, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      const rows = stdout.split('\n').map((line) => {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 8) return null;
        const pid = Number(fields[0]);
        const ppid = Number(fields[1]);
        if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return null;
        return { pid, ppid, started: fields.slice(2, 7).join(' '), command: fields.slice(7).join(' ') };
      }).filter(Boolean);
      resolve(rows);
    });
  });
}

async function sameProcessIdentity(pid, expected) {
  const actual = await processIdentity(pid);
  return Boolean(actual && expected && actual.started === expected.started && actual.command === expected.command);
}

function renderMarkdown(report) {
  const lines = [
    '# Magpie plugin probe', '',
    `- Run: \`${report.runId}\``,
    `- Version: ${report.version?.magpie ?? 'unavailable'} (Magpie), ${report.version?.bun ?? 'unavailable'} (Bun)`,
    `- Platform: ${report.platform}`,
    `- Cleanup: ${report.cleanup.complete ? 'complete' : 'incomplete'}`,
    '', '## Gates', '',
  ];
  for (const gate of report.gates) lines.push(`- ${gate.passed ? 'PASS' : 'FAIL'} — ${gate.name}: ${gate.detail}`);
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
