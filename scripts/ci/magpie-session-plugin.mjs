#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '../..');
const packageRoot = path.join(repoRoot, 'packages/magpie-monitor');
const testPrompt = 'PRIVATE_FIRST_PROMPT_MUST_NEVER_BECOME_A_TITLE';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function randomPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--live-readonly') {
      options.liveReadonly = true;
      continue;
    }
    if (!['--magpie', '--bun', '--report-dir'].includes(flag)) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag !== '--report-dir' && !path.isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
    options[flag.slice(2)] = path.resolve(value);
  }
  if (!options.magpie || !options.bun) {
    throw new Error('Usage: node scripts/ci/magpie-session-plugin.mjs --magpie ABSOLUTE_PATH --bun ABSOLUTE_PATH [--report-dir PATH] [--live-readonly]');
  }
  return options;
}

export function makeChildEnv({ home, webPort, key, bun, magpie, sourceRoots = {} }) {
  if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535) throw new TypeError('webPort must be an integer TCP port');
  const pathDirs = [...new Set([
    path.dirname(magpie), path.dirname(bun), path.dirname(process.execPath), '/usr/bin', '/bin',
  ])];
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
    MAGPIE_ADDR: `127.0.0.1:${webPort}`,
    PATH: pathDirs.join(path.delimiter),
    ...(sourceRoots.codex ? { CODEX_HOME: sourceRoots.codex } : {}),
    ...(sourceRoots.claude ? { CLAUDE_CONFIG_DIR: sourceRoots.claude } : {}),
    ...(sourceRoots.hermes ? { HERMES_HOME: sourceRoots.hermes } : {}),
  };
}

export function processDescendants(processes, rootIdentities) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const found = [];
  const seen = new Set(rootIdentities.map((root) => root.pid));
  const queue = rootIdentities.flatMap((root) => {
    const current = byPid.get(root.pid);
    return current && current.started === root.started && current.command === root.command ? [root.pid] : [];
  });
  while (queue.length) {
    const parentPid = queue.shift();
    for (const entry of processes) {
      if (entry.ppid === parentPid && !seen.has(entry.pid)) {
        seen.add(entry.pid);
        found.push(entry);
        queue.push(entry.pid);
      }
    }
  }
  return found;
}

export function redactSecrets(value, secrets) {
  if (typeof value === 'string') return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('[redacted]'), value);
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSecrets(entry, secrets)]));
  return value;
}

export async function createNativeFixtures(codexRoot, now = new Date()) {
  const oldId = randomUUID();
  const brokenId = randomUUID();
  const oldTurnId = randomUUID();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const dirParts = [String(yesterday.getUTCFullYear()), String(yesterday.getUTCMonth() + 1).padStart(2, '0'), String(yesterday.getUTCDate()).padStart(2, '0')];
  const sessionsDir = path.join(codexRoot, 'sessions', ...dirParts);
  await mkdir(sessionsDir, { recursive: true });
  const rolloutPath = (id) => path.join(sessionsDir, `rollout-${yesterday.toISOString().slice(0, 10)}T12-00-00-${id}.jsonl`);
  const oldRollout = rolloutPath(oldId);
  const brokenRollout = rolloutPath(brokenId);
  const oldRows = [
    { type: 'session_meta', payload: { id: oldId, cwd: '/tmp/synthetic-workspace', model: 'synthetic' } },
    { type: 'event_msg', payload: { type: 'user_message', message: testPrompt }, timestamp: yesterday.toISOString() },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: oldTurnId }, timestamp: new Date(yesterday.getTime() + 1000).toISOString() },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: oldTurnId }, timestamp: new Date(yesterday.getTime() + 60_000).toISOString() },
  ];
  const brokenRows = [
    { type: 'session_meta', payload: { id: brokenId, cwd: '/tmp/synthetic-workspace', model: 'synthetic' } },
  ];
  await writeFile(oldRollout, `${oldRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await writeFile(brokenRollout, `${JSON.stringify(brokenRows[0])}\n{"type":"event_msg","payload":{"type":"task_started"`);
  await utimes(oldRollout, yesterday, yesterday);
  const indexPath = path.join(codexRoot, 'session_index.jsonl');
  const indexRows = [
    { id: oldId, thread_name: 'Original native title', updated_at: yesterday.toISOString() },
    { id: brokenId, thread_name: 'Truncated fixture session', updated_at: now.toISOString() },
  ];
  await writeFile(indexPath, `${indexRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const dbPath = path.join(codexRoot, 'state_5.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT)');
  const insert = db.prepare('INSERT INTO threads (id, name, title) VALUES (?, ?, ?)');
  insert.run(oldId, 'Original native title', testPrompt);
  insert.run(brokenId, 'Truncated fixture session', 'PRIVATE_BROKEN_TITLE');
  db.close();
  const fixtures = {
    oldId,
    oldTurnId,
    brokenId,
    oldRollout,
    brokenRollout,
    indexPath,
    dbPath,
    yesterday,
    prompt: testPrompt,
  };
  return fixtures;
}

async function replaceNativeTitle(fixtures, newTitle, timestamp) {
  const rows = (await readFile(fixtures.indexPath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
  const current = rows.find((row) => row.id === fixtures.oldId);
  current.thread_name = newTitle;
  current.updated_at = timestamp;
  await writeFile(fixtures.indexPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const db = new DatabaseSync(fixtures.dbPath);
  db.prepare('UPDATE threads SET name = ? WHERE id = ?').run(newTitle, fixtures.oldId);
  db.close();
}

async function appendNativeEvent(rolloutPath, payload, timestamp = new Date()) {
  await appendFile(rolloutPath, `${JSON.stringify({ type: 'event_msg', payload, timestamp: timestamp.toISOString() })}\n`);
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, 'utf8'));
}

async function findMonitorState(root) {
  const queue = [root];
  while (queue.length) {
    const directory = queue.shift();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === 'state.json' && directory.endsWith('monitor-sessions')) return fullPath;
      if (entry.isDirectory()) queue.push(fullPath);
    }
  }
  return null;
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
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
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${method} /api/${route} failed (timeout ${timeoutMs}ms): ${error.message}`);
  }
}

function assertGate(condition, name, detail) {
  if (!condition) throw new Error(`${name}: ${detail}`);
}

function publicState(state) {
  return {
    tick: state.tick,
    polls: state.polls,
    diagnostics: state.diagnosticCodes,
    sessionCount: state.sessions?.length ?? 0,
    sessions: (state.sessions ?? []).map((session) => ({
      session_id: session.session_id,
      agent_id: session.agent_id,
      title_present: Boolean(session.session_title),
      execution_status: session.execution_status,
      recently_active: session.recently_active,
      historical_active_ms: session.historical_active_ms,
      historical_activity_basis: session.historical_activity_basis,
    })),
    eventCounts: (state.events ?? []).reduce((counts, event) => {
      counts[event.type] = (counts[event.type] ?? 0) + 1;
      return counts;
    }, {}),
  };
}

function summarizeLiveState(state) {
  const agents = {};
  const statuses = {};
  let titleCount = 0;
  let historicalCount = 0;
  for (const session of state.sessions ?? []) {
    agents[session.agent_id] = (agents[session.agent_id] ?? 0) + 1;
    statuses[session.execution_status] = (statuses[session.execution_status] ?? 0) + 1;
    if (session.session_title) titleCount += 1;
    if (session.historical_active_ms > 0) historicalCount += 1;
  }
  return {
    sessionCount: state.sessions?.length ?? 0,
    tick: state.tick,
    polls: state.polls,
    agentCounts: agents,
    statusCounts: statuses,
    titlesPresent: titleCount,
    historicalActivityPresent: historicalCount,
    diagnosticCodes: state.diagnosticCodes ?? [],
    eventCounts: (state.events ?? []).reduce((counts, event) => {
      counts[event.type] = (counts[event.type] ?? 0) + 1;
      return counts;
    }, {}),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomBytes(4).toString('hex')}`;
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'magpie-session-plugin-'));
  const home = path.join(tempRoot, 'home');
  const configDir = path.join(home, '.config', 'magpie');
  const cacheDir = path.join(home, '.cache', 'magpie');
  const reportDir = options['report-dir'] ? path.resolve(options['report-dir']) : path.join(repoRoot, 'reports', 'magpie-session-plugin', runId);
  const report = { runId, mode: options.liveReadonly ? 'live-readonly' : 'synthetic', startedAt: new Date().toISOString(), version: null, platform: `${process.platform}/${process.arch}`, gates: [], cleanup: { complete: false } };
  const children = new Set();
  const allChildren = [];
  const webRoots = new Map();
  const pluginProcesses = new Map();
  let webProcess;
  let webKey;
  let cookie;
  let baseUrl;
  let statePath;
  let fixtures;
  let currentPhase = 'setup';
  let fatal;
  let env;

  const record = (name, passed, detail) => report.gates.push({ name, passed, detail });
  const launch = (command, args, childEnv, label) => {
    const child = spawn(command, args, { cwd: repoRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child.label = label;
    child.closed = false;
    child.output = '';
    const collect = (chunk) => { child.output = `${child.output}${chunk.toString()}`.slice(-65536); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => { child.spawnError = error; });
    child.once('close', () => { child.closed = true; children.delete(child); });
    children.add(child);
    allChildren.push(child);
    return child;
  };
  const stopChild = async (child) => {
    if (!child || child.closed) return;
    const waitClose = (ms) => Promise.race([new Promise((resolve) => child.once('close', resolve)), sleep(ms)]);
    if (!child.spawnError && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await waitClose(5000);
    if (!child.closed && !child.spawnError) {
      child.kill('SIGKILL');
      await waitClose(5000);
    }
  };
  const trackWeb = async (child) => {
    const identity = await processIdentity(child.pid);
    assertGate(identity, 'web-process-identity', `Magpie web PID ${child.pid} not visible`);
    webRoots.set(child.pid, identity);
  };
  const trackPlugin = async (pid, parentPid) => {
    const identity = await processIdentity(pid);
    assertGate(identity?.ppid === parentPid, 'plugin-child-identity', `plugin PID ${pid} parent=${identity?.ppid}; web PID=${parentPid}`);
    pluginProcesses.set(pid, identity);
    return identity;
  };

  try {
    assertGate(process.platform === 'darwin', 'platform', 'Only macOS is currently supported by this E2E runner.');
    await mkdir(configDir, { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    await mkdir(reportDir, { recursive: true });
    const sourceHome = options.liveReadonly ? (process.env.HOME || process.env.USERPROFILE) : home;
    const sourceRoots = options.liveReadonly ? {
      codex: process.env.CODEX_HOME || path.join(sourceHome, '.codex'),
      claude: process.env.CLAUDE_CONFIG_DIR || path.join(sourceHome, '.claude'),
      hermes: process.env.HERMES_HOME || path.join(sourceHome, '.hermes'),
    } : { codex: path.join(home, '.codex') };
    const gatewayPort = await randomPort();
    const webPort = await randomPort();
    env = makeChildEnv({ home, webPort: gatewayPort, key: randomBytes(24).toString('base64url'), bun: options.bun, magpie: options.magpie, sourceRoots });
    webKey = env.MAGPIE_WEB_KEY;
    // The frontend listener and Agent gateway use distinct loopback ports.
    baseUrl = `http://127.0.0.1:${webPort}`;
    report.web = { address: baseUrl, gatewayAddress: env.MAGPIE_ADDR };
    report.visualUiVerification = 'Not attempted; using the installed Plugins page management APIs over loopback.';

    if (!options.liveReadonly) {
      currentPhase = 'create-native-fixtures';
      fixtures = await createNativeFixtures(sourceRoots.codex);
      report.fixture = { type: 'synthetic Codex rollout/index/SQLite; Magpie session cache is generated by the real CLI', sessionCount: 2, expectedEvents: ['session_discovered', 'session_title_updated', 'session_activity_updated'] };
    } else {
      report.liveReadOnly = { sourceRoots: Object.fromEntries(Object.entries(sourceRoots).map(([name, value]) => [name, path.basename(value)])), titlesAndIdsOmitted: true };
    }

    currentPhase = 'verify-installed-runtimes';
    const versionEnv = makeChildEnv({ home, webPort, key: webKey, bun: options.bun, magpie: options.magpie });
    const bunVersion = await runVersion(options.bun, versionEnv, 'Bun');
    const magpieVersion = await runVersion(options.magpie, versionEnv, 'Magpie');
    report.version = { magpie: magpieVersion, bun: bunVersion };

    currentPhase = 'start-isolated-magpie-web';
    webProcess = launch(options.magpie, ['web', '--no-open', '--gateway', '--addr', `127.0.0.1:${webPort}`], env, 'magpie-web');
    report.web.webPid = webProcess.pid;
    cookie = await waitFor(async () => {
      if (webProcess.spawnError) throw webProcess.spawnError;
      if (webProcess.exitCode !== null) throw new Error(`Magpie web exited with ${webProcess.exitCode}`);
      const response = await fetch(`${baseUrl}/?k=${encodeURIComponent(webKey)}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (response.status !== 303) return null;
      return response.headers.get('set-cookie')?.split(';', 1)[0] || null;
    }, 20000, 'Magpie Web authentication');
    await trackWeb(webProcess);
    const cleanState = await requestJson(baseUrl, cookie, 'plugins');
    assertGate(Array.isArray(cleanState.plugins) && cleanState.plugins.length === 0, 'isolated-plugin-config', 'temporary Magpie home was not empty');
    assertGate(cleanState.bun && cleanState.bunVersion === bunVersion, 'reused-bun', `web reported Bun ${cleanState.bunVersion}`);
    record('isolated-web-and-bun', true, `Magpie ${magpieVersion}, Bun ${bunVersion}, web PID ${webProcess.pid}, isolated HOME/XDG`);

    currentPhase = 'install-and-configure-session-plugin';
    const spec = packageRoot;
    await requestJson(baseUrl, cookie, 'plugins/add', 'POST', { spec });
    await requestJson(baseUrl, cookie, 'plugins/options', 'POST', {
      spec,
      options: {
        pollIntervalMs: options.liveReadonly ? 5000 : 1000,
        limit: options.liveReadonly ? 5000 : 100,
        commandTimeoutMs: options.liveReadonly ? 60000 : 30000,
        magpieCachePath: path.join(cacheDir, 'sessions.json'),
      },
    });
    record('installed-by-web-management-api', true, `Installed through /api/plugins/options (${options.liveReadonly ? '5-second/5000-session read-only observation' : '1-second/100-session fixture run'}); cache remains isolated.`);
    statePath = await waitFor(() => findMonitorState(home), 20000, 'monitor state file');

    if (options.liveReadonly) {
      currentPhase = 'verify-live-readonly-observation';
      const first = await waitFor(async () => {
        const state = await readJson(statePath);
        return state.tick >= 2 && state.sessions?.length ? state : null;
      }, 90000, 'live session snapshot');
      const identity = await trackPlugin(first.ownerPid, webProcess.pid);
      await waitFor(async () => (await readJson(statePath)).tick >= first.tick + 2, 20000, 'live read-only poll advancement');
      const last = await readJson(statePath);
      assertGate(last.sessions.length > 0, 'live-session-coverage', 'No native Agent sessions were observed under the configured read-only roots.');
      report.liveReadOnly.observation = summarizeLiveState(last);
      report.liveReadOnly.pluginPid = first.ownerPid;
      report.liveReadOnly.webPid = webProcess.pid;
      record('live-read-only-observation', true, `Observed ${last.sessions.length} sessions over successive polls; report contains only aggregate counts and status coverage.`);
      assertGate(identity.ppid === webProcess.pid, 'live-host-owned-plugin', 'monitor process not owned by the isolated Magpie web host');
    } else {
      currentPhase = 'verify-initial-history-title-and-unknown';
      let initial = await waitFor(async () => {
        const state = await readJson(statePath);
        const oldSession = findSession(state, fixtures.oldId);
        const brokenSession = findSession(state, fixtures.brokenId);
        return state.tick >= 2 && oldSession && brokenSession ? { state, oldSession, brokenSession } : null;
      }, 20000, 'initial Codex history snapshot');
      const initialOwner = initial.state.ownerPid;
      await trackPlugin(initialOwner, webProcess.pid);
      assertGate(initial.oldSession.execution_status === 'idle', 'historical-session-idle', `status=${initial.oldSession.execution_status}`);
      assertGate(initial.oldSession.recently_active === false, 'historical-session-stale', `recent=${initial.oldSession.recently_active}`);
      assertGate(initial.oldSession.session_title === 'Original native title', 'native-title-only', `unexpected native title source`);
      assertGate(initial.oldSession.historical_active_ms > 0 && initial.oldSession.historical_activity_basis === 'magpie_estimated_line_gaps_lt_5m', 'historical-activity', `active ms=${initial.oldSession.historical_active_ms}`);
      assertGate(initial.brokenSession.execution_status === 'unknown', 'truncated-rollout-unknown', `status=${initial.brokenSession.execution_status}`);
      record('native-history-title-and-truncation', true, 'Old native session is idle with native title/history; truncated rollout remains unknown.');

      currentPhase = 'verify-fresh-task-and-native-title-rename';
      const startAt = new Date();
      const firstTurn = randomUUID();
      await appendNativeEvent(fixtures.oldRollout, { type: 'task_started', turn_id: firstTurn }, startAt);
      const working = await waitFor(async () => {
        const state = await readJson(statePath);
        const session = findSession(state, fixtures.oldId);
        return session?.execution_status === 'working' && session.recently_active ? { state, session } : null;
      }, 8000, 'fresh task_started');
      assertGate(working.state.ownerPid === initialOwner, 'host-persistent-snapshot', 'session runtime unexpectedly rotated while polling');
      assertNoPromptLeak(working.state, fixtures.prompt);
      record('fresh-task-working', true, 'Fresh native task_started reports working/recent without retaining first prompt text.');

      const renamed = 'Renamed native title';
      await replaceNativeTitle(fixtures, renamed, new Date().toISOString());
      const titled = await waitFor(async () => {
        const state = await readJson(statePath);
        const session = findSession(state, fixtures.oldId);
        const count = countEvents(state, fixtures.oldId, 'session_title_updated');
        return session?.session_title === renamed && count >= 1 ? { state, session, count } : null;
      }, 10000, 'native title update');
      assertNoPromptLeak(titled.state, fixtures.prompt);
      record('native-title-update', true, `Native rename emitted session_title_updated (${titled.count} event).`);

      const terminalAt = new Date();
      await appendNativeEvent(fixtures.oldRollout, { type: 'task_complete', turn_id: firstTurn }, terminalAt);
      const idle = await waitFor(async () => {
        const state = await readJson(statePath);
        const session = findSession(state, fixtures.oldId);
        return session?.execution_status === 'idle' ? { state, session } : null;
      }, 8000, 'task_complete');
      assertNoPromptLeak(idle.state, fixtures.prompt);
      record('task-complete-idle', true, 'Matching native task_complete returns execution status to idle.');

      currentPhase = 'verify-off-on-catch-up';
      await requestJson(baseUrl, cookie, 'plugins/off', 'POST', { spec, off: true });
      await waitFor(async () => (await requestJson(baseUrl, cookie, 'plugins')).plugins?.find((item) => item.spec === spec)?.off === true, 8000, 'plugin off');
      const frozenText = await readFile(statePath, 'utf8');
      const frozenState = JSON.parse(frozenText);
      const firstIdentity = await processIdentity(frozenState.ownerPid);
      const offTurn = randomUUID();
      await appendNativeEvent(fixtures.oldRollout, { type: 'task_started', turn_id: offTurn }, new Date());
      await sleep(3500);
      assertGate(await readFile(statePath, 'utf8') === frozenText, 'off-stops-monitor', 'State changed during 3.5 poll intervals while disabled.');
      await waitFor(async () => !await sameProcessIdentity(frozenState.ownerPid, firstIdentity), 8000, 'disabled monitor host exit');
      record('off-stops-monitor', true, `Tick and state stayed frozen for 3.5 poll intervals; PID ${frozenState.ownerPid} exited.`);

      await requestJson(baseUrl, cookie, 'plugins/off', 'POST', { spec, off: false });
      const resumed = await waitFor(async () => {
        const state = await readJson(statePath);
        const session = findSession(state, fixtures.oldId);
        return state.ownerPid !== frozenState.ownerPid && session?.execution_status === 'working' ? { state, session } : null;
      }, 15000, 'plugin on catch-up');
      const resumedIdentity = await trackPlugin(resumed.state.ownerPid, webProcess.pid);
      assertGate(resumed.session.session_title === renamed, 'title-retained-after-toggle', 'Native title was lost after plugin re-enable.');
      assertNoPromptLeak(resumed.state, fixtures.prompt);
      record('on-catches-up-once', true, 'New monitor process resumes and sees the task appended while disabled; title/history remain available.');

      currentPhase = 'verify-full-web-restart';
      await stopChild(webProcess);
      await waitFor(async () => !await sameProcessIdentity(resumed.state.ownerPid, resumedIdentity), 8000, 'monitor process exit before web restart');
      const nextTurn = randomUUID();
      await appendNativeEvent(fixtures.oldRollout, { type: 'task_complete', turn_id: offTurn }, new Date(Date.now() + 1));
      await appendNativeEvent(fixtures.oldRollout, { type: 'task_started', turn_id: nextTurn }, new Date(Date.now() + 2));
      webProcess = launch(options.magpie, ['web', '--no-open', '--gateway', '--addr', `127.0.0.1:${webPort}`], env, 'magpie-web-restart');
      report.web.restartPid = webProcess.pid;
      cookie = await waitFor(async () => {
        if (webProcess.spawnError) throw webProcess.spawnError;
        if (webProcess.exitCode !== null) throw new Error(`Restarted Magpie web exited with ${webProcess.exitCode}`);
        const response = await fetch(`${baseUrl}/?k=${encodeURIComponent(webKey)}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        if (response.status !== 303) return null;
        return response.headers.get('set-cookie')?.split(';', 1)[0] || null;
      }, 20000, 'restarted Magpie Web authentication');
      await trackWeb(webProcess);
      const restored = await waitFor(async () => {
        const state = await readJson(statePath);
        const session = findSession(state, fixtures.oldId);
        return state.ownerPid !== resumed.state.ownerPid && session?.execution_status === 'working' && session?.session_title === renamed
          ? { state, session } : null;
      }, 20000, 'unprimed full Web restart restore');
      await trackPlugin(restored.state.ownerPid, webProcess.pid);
      assertGate(restored.state.events.filter((event) => event.type === 'session_title_updated').length === 1, 'no-title-replay-after-restart', 'Title update was duplicated or lost after full Web restart.');
      assertNoPromptLeak(restored.state, fixtures.prompt);
      record('full-web-restart-history-title-working', true, 'Web restarted without CLI/API priming; native title, history and current working status recovered.');
    }
  } catch (error) {
    fatal = error;
    report.phase = currentPhase;
    report.error = error.message;
    record('runner', false, error.message);
    if (statePath) {
      try {
        const state = await readJson(statePath);
        report.diagnostics = options.liveReadonly ? summarizeLiveState(state) : publicState(state);
      } catch (snapshotError) { report.diagnostics = { stateError: snapshotError.message }; }
    }
  } finally {
    const processTable = await listProcesses().catch(() => []);
    const discovered = processDescendants(processTable, [...webRoots].map(([pid, identity]) => ({ pid, ...identity })));
    for (const entry of discovered) pluginProcesses.set(entry.pid, entry);
    report.cleanup.discoveredDescendants = discovered.map(({ pid, ppid, command }) => ({ pid, ppid, ...(options.liveReadonly ? {} : { command }) }));
    for (const [pid, identity] of pluginProcesses) {
      if (await sameProcessIdentity(pid, identity)) await terminatePid(pid, identity);
    }
    for (const child of [...children]) await stopChild(child);
    const remaining = [];
    for (const [pid, identity] of pluginProcesses) if (await sameProcessIdentity(pid, identity)) remaining.push(pid);
    report.cleanup.remainingOwnedPids = remaining;
    report.cleanup.complete = children.size === 0 && remaining.length === 0 && (!webProcess || webProcess.closed || webProcess.spawnError);
    record('cleanup', report.cleanup.complete, report.cleanup.complete ? 'All runner-owned Magpie and plugin processes exited.' : `Owned plugin PIDs still alive: ${remaining.join(', ')}`);
    if (!report.cleanup.complete) report.cleanup.preservedTempRoot = tempRoot;
    if (fatal && allChildren.length) {
      report.diagnostics ||= {};
      report.diagnostics.childLogs = allChildren.map((child) => ({
        label: child.label,
        ...(options.liveReadonly ? { outputOmitted: true } : { output: child.output }),
      }));
    }
    if (options.liveReadonly) {
      delete report.diagnostics?.sessions;
    }
    report.finishedAt = new Date().toISOString();
    const safe = redactSecrets(report, [webKey, cookie, fixtures?.prompt]);
    await writeFile(path.join(reportDir, 'report.json'), `${JSON.stringify(safe, null, 2)}\n`);
    await writeFile(path.join(reportDir, 'report.md'), renderReport(safe));
    if (report.cleanup.complete) await rm(tempRoot, { recursive: true, force: true });
    process.exitCode = fatal || report.gates.some((gate) => !gate.passed) ? 1 : 0;
  }
}

function findSession(state, rawId) {
  const digest = createHash('sha256').update(rawId.toLowerCase()).digest('hex');
  return state.sessions?.find((session) => session.session_id === `codex:sess:${digest}`);
}

function countEvents(state, sessionId, eventType) {
  const id = findSession(state, sessionId)?.session_id;
  return (state.events ?? []).filter((event) => event.session_id === id && event.type === eventType).length;
}

function assertNoPromptLeak(state, prompt) {
  assertGate(!JSON.stringify(state).includes(prompt), 'prompt-redacted', 'Synthetic first-prompt text appeared in monitor state.');
}

async function runVersion(binary, env, name) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--version'], { env, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(text.trim()) : reject(new Error(`${name} version command exited ${code}`)));
  });
}

async function processIdentity(pid) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-o', 'ppid=', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)], { env: { PATH: '/usr/bin:/bin' } }, (error, stdout) => {
      if (error) return resolve(null);
      const parts = stdout.trim().split(/\s+/);
      const ppid = Number(parts[0]);
      if (!Number.isInteger(ppid) || parts.length < 7) return resolve(null);
      resolve({ ppid, started: parts.slice(1, 6).join(' '), command: parts.slice(6).join(' ') });
    });
  });
}

async function listProcesses() {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-axo', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'command='], { env: { PATH: '/usr/bin:/bin' }, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout.split('\n').map((line) => {
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[0]);
        const ppid = Number(parts[1]);
        if (!Number.isInteger(pid) || !Number.isInteger(ppid) || parts.length < 8) return null;
        return { pid, ppid, started: parts.slice(2, 7).join(' '), command: parts.slice(7).join(' ') };
      }).filter(Boolean));
    });
  });
}

async function sameProcessIdentity(pid, identity) {
  if (!identity) return false;
  const current = await processIdentity(pid);
  return Boolean(current && current.started === identity.started && current.command === identity.command);
}

async function terminatePid(pid, identity) {
  if (!await sameProcessIdentity(pid, identity)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  try {
    await waitFor(async () => !await sameProcessIdentity(pid, identity), 8000, `plugin child ${pid} exit`);
  } catch {
    if (await sameProcessIdentity(pid, identity)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
      await waitFor(async () => !await sameProcessIdentity(pid, identity), 5000, `plugin child ${pid} SIGKILL`).catch(() => {});
    }
  }
}

function renderReport(report) {
  const lines = [
    '# Magpie session plugin E2E', '',
    `- Run: \`${report.runId}\``,
    `- Mode: ${report.mode}`,
    `- Magpie/Bun: ${report.version?.magpie ?? 'unavailable'} / ${report.version?.bun ?? 'unavailable'}`,
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
