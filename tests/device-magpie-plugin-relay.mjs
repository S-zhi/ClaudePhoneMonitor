#!/usr/bin/env node
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelayServer } from '../services/relay/dist/src/server.js';
import { JsonLogger } from '../services/relay/dist/src/logger.js';

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(root, 'packages/magpie-monitor');
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'magpie-plugin-usb-'));
const home = path.join(fixtureRoot, 'home');
const configHome = path.join(home, '.config');
const cacheHome = path.join(home, '.cache');
const codexHome = path.join(home, '.codex');
let reportPath = path.join(fixtureRoot, 'report.json');
const liveRelayPath = path.join(fixtureRoot, 'live-relay.json');
const webKey = randomBytes(24).toString('base64url');
const bootstrapSecret = randomBytes(32).toString('base64url');
const startedChildren = new Map();
const ownedWebRoots = new Map();
const webChildren = new Map();
const phoneSockets = new Set();
const report = { mode: 'isolated-magpie-plugin-usb', startedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, gates: [], cleanup: { complete: false } };
let relayServer;
let relayPort;
let relayBase;
let webPort;
let gatewayPort;
let webProcess;
let webCookie;
let webBase;
let webEnv;
let webConfig;
let monitorStatePath;
let syntheticPair;
let livePair;
let fixture;
let closing;
let closeAfter;

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!['--magpie', '--bun', '--port', '--report-dir'].includes(key)) throw new Error(`unknown_option_${key}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`missing_value_${key}`);
    if (key === '--port') {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid_port');
      out.port = port;
    } else if (key !== '--report-dir' && !path.isAbsolute(value)) throw new Error(`${key}_must_be_absolute`);
    else out[key.slice(2)] = path.resolve(value);
  }
  if (!out.magpie || !out.bun) throw new Error('usage: node tests/device-magpie-plugin-relay.mjs --magpie ABSOLUTE --bun ABSOLUTE [--port 18889]');
  return out;
}

function record(name, passed, detail) { report.gates.push({ name, passed, detail }); }
function ensure(condition, name, detail) {
  if (!condition) {
    record(name, false, detail);
    throw new Error(`${name}:${detail}`);
  }
  record(name, true, detail);
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
async function waitFor(check, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error(`timeout_${label}${last ? `:${last.message}` : ''}`);
}
async function run(binary, argv, env = process.env, timeout = 60_000) {
  return execFile(binary, argv, { cwd: root, env, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
}
function childEnv(options, addressPort) {
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: configHome,
    XDG_CACHE_HOME: cacheHome,
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    CODEX_HOME: codexHome,
    MAGPIE_BUN: options.bun,
    MAGPIE_NO_ACCOUNTS: '1',
    MAGPIE_NO_STATS: '1',
    DO_NOT_TRACK: '1',
    MAGPIE_WEB_KEY: webKey,
    MAGPIE_ADDR: `127.0.0.1:${addressPort}`,
    PATH: [...new Set([path.dirname(options.magpie), path.dirname(options.bun), path.dirname(process.execPath), '/usr/bin', '/bin'])].join(path.delimiter),
  };
}
function launch(binary, argv, env, name) {
  const child = spawn(binary, argv, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.name = name;
  child.closed = false;
  child.output = '';
  const keep = (chunk) => { child.output = `${child.output}${chunk.toString()}`.slice(-32_000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.once('close', () => { child.closed = true; });
  child.once('error', (error) => { child.spawnError = error; });
  startedChildren.set(child.pid, child);
  return child;
}
async function psIdentity(pid) {
  const { stdout } = await execFile('/bin/ps', ['-o', 'ppid=', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)], { env: { PATH: '/usr/bin:/bin' } }).catch(() => ({ stdout: '' }));
  const parts = stdout.trim().split(/\s+/);
  const ppid = Number(parts[0]);
  if (!Number.isInteger(ppid) || parts.length < 7) return null;
  return { ppid, started: parts.slice(1, 6).join(' '), command: parts.slice(6).join(' ') };
}
async function processTable() {
  const { stdout } = await execFile('/bin/ps', ['-axo', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'command='], { env: { PATH: '/usr/bin:/bin' }, maxBuffer: 4 * 1024 * 1024 });
  return stdout.split('\n').map((line) => {
    const p = line.trim().split(/\s+/);
    const pid = Number(p[0]); const ppid = Number(p[1]);
    return Number.isInteger(pid) && Number.isInteger(ppid) && p.length >= 8
      ? { pid, ppid, started: p.slice(2, 7).join(' '), command: p.slice(7).join(' ') } : null;
  }).filter(Boolean);
}
function descendantTree(rows, roots) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const found = []; const queue = [];
  for (const [pid, identity] of roots) {
    const current = byPid.get(pid);
    if (current?.started === identity.started && current.command === identity.command) queue.push(pid);
  }
  while (queue.length) {
    const parent = queue.shift();
    for (const row of rows) if (row.ppid === parent && !found.some((item) => item.pid === row.pid)) {
      found.push(row); queue.push(row.pid);
    }
  }
  return found;
}
async function sameIdentity(pid, identity) {
  const now = await psIdentity(pid);
  return Boolean(now && identity && now.started === identity.started && now.command === identity.command);
}
async function stopPid(pid, identity) {
  if (!await sameIdentity(pid, identity)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  try { await waitFor(async () => !await sameIdentity(pid, identity), 6000, `pid_${pid}_term`); return; } catch {}
  if (await sameIdentity(pid, identity)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
    await waitFor(async () => !await sameIdentity(pid, identity), 4000, `pid_${pid}_kill`).catch(() => {});
  }
}
async function stopWeb() {
  if (!webProcess || webProcess.closed) return;
  const identity = ownedWebRoots.get(webProcess.pid);
  const beforeStop = await processTable().catch(() => []);
  for (const child of descendantTree(beforeStop, new Map([[webProcess.pid, identity]]))) {
    webChildren.set(child.pid, { ppid: child.ppid, started: child.started, command: child.command });
  }
  try { webProcess.kill('SIGTERM'); } catch {}
  await waitFor(() => webProcess.closed, 6000, 'magpie_web_exit').catch(() => {});
  for (const [pid, childIdentity] of webChildren) {
    if (await sameIdentity(pid, childIdentity)) {
      await stopPid(pid, childIdentity);
    }
  }
  if (!webProcess.closed) {
    try { webProcess.kill('SIGKILL'); } catch {}
    await waitFor(() => webProcess.closed, 4000, 'magpie_web_kill').catch(() => {});
  }
}
async function requestJson(url, { method = 'GET', body, headers = {}, timeoutMs = 8000 } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : {}; } catch { value = { message: text.slice(0, 300) }; }
  if (!response.ok) throw new Error(`${method}_${new URL(url).pathname}_http_${response.status}:${value.error ?? value.message ?? 'request_failed'}`);
  return value;
}
async function magpieApi(route, method = 'GET', body) {
  return requestJson(`${webBase}/api/${route}`, { method, body, headers: { Cookie: webCookie }, timeoutMs: method === 'GET' ? 5000 : 45000 });
}
async function authenticateWeb() {
  webCookie = await waitFor(async () => {
    const response = await fetch(`${webBase}/?k=${encodeURIComponent(webKey)}`, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
    if (response.status !== 303) return null;
    return response.headers.get('set-cookie')?.split(';', 1)[0] || null;
  }, 20_000, 'magpie_web_auth');
  const identity = await psIdentity(webProcess.pid);
  if (!identity) throw new Error('magpie_web_process_identity_missing');
  ownedWebRoots.set(webProcess.pid, identity);
}
async function startWeb(options, usePort = webPort) {
  webPort = usePort;
  webEnv = childEnv(options, gatewayPort);
  webBase = `http://127.0.0.1:${webPort}`;
  webProcess = launch(options.magpie, ['web', '--no-open', '--gateway', '--addr', `127.0.0.1:${webPort}`], webEnv, 'magpie-web');
  await authenticateWeb();
}
async function nativeFixture() {
  const now = new Date();
  const oldId = randomUUID();
  const activeId = randomUUID();
  const uncertainId = randomUUID();
  const oldTurn = randomUUID();
  const activeTurn = randomUUID();
  const uncertainTurn = randomUUID();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const day = `${String(yesterday.getUTCFullYear())}/${String(yesterday.getUTCMonth() + 1).padStart(2, '0')}/${String(yesterday.getUTCDate()).padStart(2, '0')}`;
  const sessionsDir = path.join(codexHome, 'sessions', ...day.split('/'));
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  const rollout = (id) => path.join(sessionsDir, `rollout-${yesterday.toISOString().slice(0, 10)}T12-00-00-${id}.jsonl`);
  const oldPath = rollout(oldId); const activePath = rollout(activeId); const uncertainPath = rollout(uncertainId);
  const row = (type, payload, timestamp) => `${JSON.stringify({ type, payload, timestamp })}\n`;
  const meta = (id) => row('session_meta', { id, source: 'vscode', thread_source: 'user', cwd: '/tmp/synthetic-magpie-session', model: 'synthetic' }, yesterday.toISOString());
  await writeFile(oldPath, `${meta(oldId)}${row('event_msg', { type: 'task_started', turn_id: oldTurn }, new Date(yesterday.getTime() + 1000).toISOString())}${row('event_msg', { type: 'task_complete', turn_id: oldTurn }, new Date(yesterday.getTime() + 60_000).toISOString())}`, { mode: 0o600 });
  await writeFile(activePath, meta(activeId), { mode: 0o600 });
  await writeFile(uncertainPath, `${meta(uncertainId)}{"type":"event_msg","payload":{"type":"task_started"`, { mode: 0o600 });
  const indexPath = path.join(codexHome, 'session_index.jsonl');
  await writeFile(indexPath, [
    { id: oldId, thread_name: 'Synthetic old Codex history', first_user_message: 'Synthetic fixture prompt', updated_at: yesterday.toISOString() },
    { id: activeId, thread_name: 'Synthetic current session', first_user_message: 'Synthetic fixture prompt', updated_at: now.toISOString() },
    { id: uncertainId, thread_name: 'Synthetic uncertain session', first_user_message: 'Synthetic fixture prompt', updated_at: now.toISOString() },
  ].map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
  const dbPath = path.join(codexHome, 'state_5.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT)');
  const insert = db.prepare('INSERT INTO threads(id,name,title) VALUES(?,?,?)');
  insert.run(oldId, 'Synthetic old Codex history', 'PRIVATE_FIRST_PROMPT_MUST_NOT_BE_A_TITLE');
  insert.run(activeId, 'Synthetic current session', 'PRIVATE_FIRST_PROMPT_MUST_NOT_BE_A_TITLE');
  insert.run(uncertainId, 'Synthetic uncertain session', 'PRIVATE_UNCERTAIN_PROMPT_MUST_NOT_BE_A_TITLE');
  db.close();
  await utimes(oldPath, yesterday, yesterday);
  return { oldId, activeId, uncertainId, oldTurn, activeTurn, uncertainTurn, oldPath, activePath, uncertainPath, indexPath, dbPath, title: 'Synthetic current session', renamed: 'Synthetic Codex title renamed', startedAt: null };
}
async function writePrivate(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}
async function makePairing(id) {
  return requestJson(`${relayBase}/v1/pairing`, {
    method: 'POST', timeoutMs: 8000,
    headers: { Authorization: `Bearer ${bootstrapSecret}` },
    body: { installation_id: id, public_url: relayBase },
  });
}
async function findMonitorState(directory) {
  const queue = [directory];
  while (queue.length) {
    const current = queue.shift();
    const list = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const item of list) {
      const full = path.join(current, item.name);
      if (item.isFile() && item.name === 'state.json' && path.basename(current) === 'monitor-sessions') return full;
      if (item.isDirectory() && !item.isSymbolicLink()) queue.push(full);
    }
  }
  return null;
}
async function installPlugin() {
  const current = await magpieApi('plugins');
  ensure(Array.isArray(current.plugins) && current.plugins.length === 0, 'isolated-magpie-config', 'fresh temporary config contains no prior plugins');
  await magpieApi('plugins/add', 'POST', { spec: packageRoot });
  monitorStatePath = await waitFor(() => findMonitorState(home), 20_000, 'plugin_state');
  const pluginDataDir = path.dirname(monitorStatePath);
  const relayConfigPath = path.join(pluginDataDir, 'relay.json');
  await writePrivate(relayConfigPath, {
    relay_url: `ws://127.0.0.1:${relayPort}/ws/collector`,
    installation_id: syntheticPair.installation_id,
    collector_token: syntheticPair.collector_token,
  });
  await magpieApi('plugins/options', 'POST', {
    spec: packageRoot,
    options: { pollIntervalMs: 1000, limit: 100, commandTimeoutMs: 60_000, relayConfigFile: relayConfigPath },
  });
  await waitFor(() => relayServer.relay.stats().collector_connections > 0, 15_000, 'plugin_collector_connection');
  const pluginState = await waitFor(async () => {
    const state = JSON.parse(await readFile(monitorStatePath, 'utf8'));
    return state.tick >= 2 ? state : null;
  }, 30_000, 'plugin_native_poll');
  const pluginIdentity = await psIdentity(pluginState.ownerPid);
  ensure(pluginIdentity?.ppid === webProcess.pid, 'real-magpie-plugin-host', `Bun plugin PID ${pluginState.ownerPid} is child of Magpie web PID ${webProcess.pid}`);
  ensure(pluginState.sessions?.some((s) => s.session_id === codexId(fixture.oldId)), 'real-cli-native-history', 'official Magpie CLI discovered synthetic native Codex fixture');
  record('relay-config-private', true, 'fixture relay credentials are mode 0600 under isolated plugin directory');
}
function codexId(raw) { return `codex:sess:${createHash('sha256').update(raw.toLowerCase()).digest('hex')}`; }
async function appendTurn(file, type, turnId) {
  const line = `${JSON.stringify({ type: 'event_msg', payload: { type, turn_id: turnId }, timestamp: new Date().toISOString() })}\n`;
  await appendFile(file, line, { mode: 0o600 });
}
async function updateNativeTitle() {
  const rows = (await readFile(fixture.indexPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const entry = rows.find((item) => item.id === fixture.activeId);
  entry.thread_name = fixture.renamed;
  entry.updated_at = new Date().toISOString();
  await writeFile(fixture.indexPath, rows.map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
  const db = new DatabaseSync(fixture.dbPath);
  db.prepare('UPDATE threads SET name=? WHERE id=?').run(fixture.renamed, fixture.activeId);
  db.close();
}
async function updateFixture(operation) {
  switch (operation) {
    case 'start': await appendTurn(fixture.activePath, 'task_started', fixture.activeTurn); break;
    case 'finish': await appendTurn(fixture.activePath, 'task_complete', fixture.activeTurn); break;
    case 'rename': await updateNativeTitle(); break;
    case 'unknown': {
      const row = (type, payload, timestamp) => `${JSON.stringify({ type, payload, timestamp })}\n`;
      await writeFile(fixture.activePath, row('session_meta', { id: fixture.activeId, source: 'vscode', thread_source: 'user', cwd: '/tmp/synthetic-magpie-session', model: 'synthetic' }, new Date().toISOString()) + row('user_message', { message: 'synthetic lifecycle uncertainty fixture' }, new Date().toISOString()), { mode: 0o600 });
      break;
    }
    case 'start-after-unknown':
      await writeFile(fixture.activePath, `${JSON.stringify({ type: 'session_meta', payload: { id: fixture.activeId, source: 'vscode', thread_source: 'user' }, timestamp: new Date().toISOString() })}\n`, { mode: 0o600 });
      fixture.activeTurn = randomUUID();
      await appendTurn(fixture.activePath, 'task_started', fixture.activeTurn);
      break;
    default: throw new Error('unknown_fixture_operation');
  }
}
function stateFor(id) {
  const snapshot = relayServer.relay.snapshot(id);
  const stored = relayServer.relay.repository.listEventsAfter(id, -1);
  return {
    snapshot,
    events: stored.map(({ event }) => ({ type: event.event_type, session_id: event.session_id, title: event.session_title, sequence: event.sequence, task_id: event.task_id })),
  };
}
async function control(operation) {
  if (operation === 'disconnect-phone') {
    for (const socket of phoneSockets) socket.destroy();
    return { status: stateFor(syntheticPair.installation_id).snapshot };
  }
  if (operation === 'off') {
    await magpieApi('plugins/off', 'POST', { spec: packageRoot, off: true });
    await waitFor(async () => (await magpieApi('plugins')).plugins?.find((p) => p.spec === packageRoot)?.off === true, 10_000, 'plugin_off');
    return stateFor(syntheticPair.installation_id);
  }
  if (operation === 'on') {
    await magpieApi('plugins/off', 'POST', { spec: packageRoot, off: false });
    await waitFor(() => relayServer.relay.stats().collector_connections > 0, 15_000, 'plugin_on');
    return stateFor(syntheticPair.installation_id);
  }
  if (operation === 'restart-web') {
    await stopWeb();
    await startWeb(options);
    await waitFor(() => relayServer.relay.stats().collector_connections > 0, 15_000, 'plugin_web_restart');
    return stateFor(syntheticPair.installation_id);
  }
  await updateFixture(operation);
  return stateFor(syntheticPair.installation_id);
}
async function safeReport(error) {
  report.finishedAt = new Date().toISOString();
  if (error) report.failure = String(error.message ?? error).replaceAll(webKey, '[redacted]').replaceAll(bootstrapSecret, '[redacted]');
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

let options;
try {
  options = args(process.argv.slice(2));
  reportPath = path.join(options.reportDir ?? path.join(root, 'reports', 'device-magpie-plugin'), `${new Date().toISOString().replaceAll(':', '-')}-${randomBytes(3).toString('hex')}.json`);
  if (process.platform !== 'darwin') throw new Error('macOS_only_until_other_platforms_verified');
  await mkdir(home, { recursive: true, mode: 0o700 });
  for (const directory of [configHome, cacheHome, codexHome]) await mkdir(directory, { recursive: true, mode: 0o700 });
  fixture = await nativeFixture();
  const versionEnv = { ...childEnv(options, 0), MAGPIE_ADDR: '127.0.0.1:0' };
  const magpieVersion = (await run(options.magpie, ['--version'], versionEnv, 5000)).stdout.trim();
  const bunVersion = (await run(options.bun, ['--version'], versionEnv, 5000)).stdout.trim();
  report.versions = { magpie: magpieVersion, bun: bunVersion };
  report.fixture = { source: 'synthetic native Codex session_index.jsonl + state_5.sqlite + rollout JSONL', sessions: 3, usesLiveUserFiles: false };

  const requestedPort = options.port ?? 18889;
  relayPort = requestedPort || await freePort();
  gatewayPort = await freePort();
  webPort = await freePort();
  relayBase = `http://127.0.0.1:${relayPort}`;
  relayServer = createRelayServer({ logger: new JsonLogger({ sink: () => undefined }), config: {
    host: '127.0.0.1', port: relayPort, authMode: 'paired', bootstrapSecret,
    databasePath: path.join(fixtureRoot, 'relay.sqlite'),
    heartbeatIntervalMs: 1000, staleAfterMs: 30_000, offlineAfterMs: 60_000, bookkeepingIntervalMs: 500,
  } });
  const pairingResponse = (pair) => pair ? ({
    installation_id: pair.installation_id,
    relay_http_url: relayBase,
    relay_ws_url: pair.qr_payload && JSON.parse(pair.qr_payload).relay_ws_url,
    pairing_id: pair.pairing_id,
    pairing_code: pair.code,
  }) : { error: 'not_ready' };
  relayServer.app.get('/device-test/config', async (_request, reply) => syntheticPair ? pairingResponse(syntheticPair) : reply.code(503).send({ error: 'not_ready' }));
  relayServer.app.get('/device-test/live-config', async (_request, reply) => livePair ? pairingResponse(livePair) : reply.code(503).send({ error: 'not_ready' }));
  relayServer.app.get('/device-test/state', async (_request, reply) => syntheticPair ? stateFor(syntheticPair.installation_id) : reply.code(503).send({ error: 'not_ready' }));
  relayServer.app.get('/device-test/fixture', async (_request, reply) => fixture ? { session_id: codexId(fixture.activeId), title: fixture.title, renamed_title: fixture.renamed } : reply.code(503).send({ error: 'not_ready' }));
  relayServer.app.get('/device-test/plugin-state', async (_request, reply) => {
    try { return JSON.parse(await readFile(monitorStatePath, 'utf8')); }
    catch { return reply.code(503).send({ error: 'plugin_state_not_ready' }); }
  });
  relayServer.app.get('/device-test/health', async () => ({ status: 'ready', relay: relayServer.relay.stats(), pluginConfig: 'isolated' }));
  relayServer.app.post('/device-test/control', async (request, reply) => {
    try {
      const operation = request.body?.operation;
      if (typeof operation !== 'string') return reply.code(400).send({ error: 'operation_required' });
      return await control(operation);
    } catch (error) {
      return reply.code(500).send({ error: String(error.message ?? error).slice(0, 240) });
    }
  });
  relayServer.app.post('/device-test/shutdown', async () => {
    setImmediate(() => void close().then(() => process.exit(0), () => process.exit(1)));
    return { status: 'stopping' };
  });
  await relayServer.app.ready();
  relayServer.app.server.on('upgrade', (request, socket) => {
    if (request.url?.startsWith('/ws/android')) {
      phoneSockets.add(socket);
      socket.once('close', () => phoneSockets.delete(socket));
    }
  });
  await relayServer.app.listen({ host: '127.0.0.1', port: relayPort });
  relayPort = relayServer.app.server.address().port;
  relayBase = `http://127.0.0.1:${relayPort}`;
  syntheticPair = await makePairing(`magpie-usb-synthetic-${randomBytes(4).toString('hex')}`);
  livePair = await makePairing('magpie-usb-live');
  await writePrivate(liveRelayPath, {
    relay_url: `ws://127.0.0.1:${relayPort}/ws/collector`,
    installation_id: livePair.installation_id,
    collector_token: livePair.collector_token,
  });
  record('paired-relay-fixture', true, 'localhost-only paired Relay created with separate synthetic and live installations');

  const env = childEnv(options, gatewayPort);
  webEnv = env;
  webBase = `http://127.0.0.1:${webPort}`;
  webProcess = launch(options.magpie, ['web', '--no-open', '--gateway', '--addr', `127.0.0.1:${webPort}`], env, 'magpie-web');
  await authenticateWeb();
  const plugins = await magpieApi('plugins');
  ensure(Array.isArray(plugins.plugins) && plugins.plugins.length === 0, 'isolated-magpie-home', 'isolated HOME has no inherited plugin configuration');
  ensure(plugins.bun && plugins.bunVersion === bunVersion, 'reuse-installed-bun', `Magpie web uses installed Bun ${bunVersion}`);
  record('actual-magpie-web', true, `Magpie ${magpieVersion} started as runner child PID ${webProcess.pid}; isolated HOME/XDG and gateway only`);
  await installPlugin();
  await writePrivate(path.join(fixtureRoot, 'ready.json'), {
    status: 'ready', host_pid: process.pid, magpie_web_pid: webProcess.pid,
    device_relay_url: `${relayBase}/device-test`, relay_url: relayBase,
    installation_id: syntheticPair.installation_id, live_installation_id: livePair.installation_id,
    report_path: reportPath, live_relay_config_path: liveRelayPath,
    plugin_config_path: path.join(path.dirname(monitorStatePath), 'relay.json'),
    magpie_version: magpieVersion, bun_version: bunVersion, platform: report.platform,
  });
  const hostIdentity = await psIdentity(process.pid);
  report.fixturePid = process.pid;
  report.magpieWebPid = webProcess.pid;
  report.relayAddress = relayBase;
  report.cleanup.confirmationPending = true;
  await safeReport();
  // stdout contains paths and pairing-independent metadata only; tokens remain in mode-0600 files.
  console.log(JSON.stringify({ status: 'ready', pid: process.pid, magpieWebPid: webProcess.pid,
    deviceRelayUrl: `${relayBase}/device-test`, liveRelayConfigPath: liveRelayPath,
    readyPath: path.join(fixtureRoot, 'ready.json'), reportPath, hostIdentity: Boolean(hostIdentity) }));

  process.once('SIGINT', () => void close().then(() => process.exit(0), () => process.exit(1)));
  process.once('SIGTERM', () => void close().then(() => process.exit(0), () => process.exit(1)));
  await new Promise((resolve) => { closeAfter = resolve; });
} catch (error) {
  await safeReport(error).catch(() => {});
  await close().catch(() => {});
  console.error(`magpie_plugin_usb_fixture_failed:${String(error.message ?? error).slice(0, 500)}`);
  process.exitCode = 1;
}

async function close() {
  if (closing) return closing;
  closing = (async () => {
    await stopWeb();
    const rows = await processTable().catch(() => []);
    for (const child of descendantTree(rows, ownedWebRoots)) {
      const identity = { ppid: child.ppid, started: child.started, command: child.command };
      webChildren.set(child.pid, identity);
      await stopPid(child.pid, identity);
    }
    const remaining = [];
    for (const [pid, identity] of webChildren) if (await sameIdentity(pid, identity)) remaining.push(pid);
    const webAlive = webProcess && await sameIdentity(webProcess.pid, ownedWebRoots.get(webProcess.pid));
    report.cleanup = { complete: remaining.length === 0 && !webAlive, remainingOwnedPids: remaining, webAlive: Boolean(webAlive), stoppedAt: new Date().toISOString() };
    await relayServer?.app.close().catch(() => {});
    report.cleanup.relayClosed = true;
    await safeReport();
    if (report.cleanup.complete) await rm(fixtureRoot, { recursive: true, force: true });
    closeAfter?.();
  })();
  return closing;
}
