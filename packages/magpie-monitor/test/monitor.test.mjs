import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startSessionMonitor } from '../monitor.mjs';
import { readCodexLifecycle } from '../lifecycle.mjs';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const TURN = '223e4567-e89b-42d3-a456-426614174000';
const nowDate = new Date('2026-10-13T12:00:00.000Z');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeSocket {
  readyState = 0;
  listeners = new Map();
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  send() {}
  close() { this.readyState = 3; for (const fn of this.listeners.get('close') ?? []) fn({}); }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magpie-session-monitor-'));
  const home = path.join(root, 'home');
  const codex = path.join(home, '.codex');
  await mkdir(path.join(codex, 'sessions', '2026', '10', '13'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home, codex, directory: path.join(root, 'magpie-config'), sessionFile: path.join(codex, 'sessions', '2026', '10', '13', 'rollout-fixture.jsonl') };
}

function row(type, payload, timestamp = nowDate.toISOString(), ordinal) {
  return JSON.stringify({ type, payload, timestamp, ...(ordinal === undefined ? {} : { ordinal }) }) + '\n';
}

test('collects only safe metadata and verified Codex lifecycle; recent activity is separate', async (t) => {
  const f = await fixture(t);
  await writeFile(f.sessionFile, row('session_meta', { id: UUID, source: 'vscode', thread_source: 'user' }) + row('event_msg', { type: 'task_started', turn_id: TURN }, nowDate.toISOString(), 1));
  const index = path.join(f.codex, 'session_index.jsonl');
  await writeFile(index, JSON.stringify({ id: UUID, thread_name: 'Native safe name', updated_at: nowDate.toISOString(), first_user_message: 'PRIVATE PROMPT' }) + '\n');
  const secretRawId = UUID;
  const snapshot = [
    { agent: 'codex', id: secretRawId, path: `~/.codex/sessions/2026/10/13/rollout-fixture.jsonl`, cwd: '/private/work', title: 'PRIVATE PROMPT', resume: 'codex resume secret' },
    { agent: 'claude-code', id: 'claude-private-session', path: '/private/claude.jsonl', title: 'PRIVATE PROMPT' },
  ];
  const cache = path.join(f.home, '.cache', 'magpie', 'sessions.json');
  await mkdir(path.dirname(cache), { recursive: true });
  await writeFile(cache, JSON.stringify({ version: 19, files: {
    '/private/claude.jsonl': { id: 'claude-private-session', custom: 'Claude named session', named: 'Ignored fallback', title: 'PRIVATE PROMPT', first: 'PRIVATE PROMPT', days: { '2026-10-13': { a: 1234, h: [] } } },
  } }));
  const monitor = await startSessionMonitor({
    directory: f.directory,
    env: { ...process.env, HOME: f.home, CODEX_HOME: f.codex, XDG_CACHE_HOME: path.join(f.home, '.cache') },
    now: () => nowDate,
    options: {
      pollIntervalMs: 60_000,
      execSnapshot: async (args, options) => {
        assert.deepEqual(args, ['sessions', '--json', '--limit', '5000']);
        assert.equal(options.env.MAGPIE_MONITOR_SNAPSHOT_CHILD, '1');
        return JSON.stringify(snapshot);
      },
    },
  });
  t.after(() => monitor.stop());
  let state = await monitor.getState();
  const codex = state.sessions.find((session) => session.agent_id === 'codex');
  const claude = state.sessions.find((session) => session.agent_id === 'claude_code');
  assert.equal(codex.session_title, 'Native safe name');
  assert.equal(codex.execution_status, 'working');
  assert.equal(codex.session_kind, 'main');
  assert.equal(codex.recently_active, false);
  assert.equal(claude.session_title, 'Claude named session');
  assert.equal(claude.execution_status, 'unknown');
  assert.equal(claude.historical_active_ms, 1234);
  assert.equal(claude.historical_activity_basis, 'magpie_estimated_line_gaps_lt_5m');
  assert.ok(state.events.some((event) => event.type === 'session_discovered'));

  await appendFile(f.sessionFile, row('event_msg', { type: 'task_complete', turn_id: TURN }, nowDate.toISOString(), 2));
  await writeFile(index, JSON.stringify({ id: UUID, thread_name: 'Renamed safe title', updated_at: '2026-10-13T12:01:00Z' }) + '\n');
  await monitor.pollOnce();
  state = await monitor.getState();
  assert.equal(state.sessions.find((session) => session.agent_id === 'codex').execution_status, 'idle');
  assert.ok(state.events.some((event) => event.type === 'session_title_updated' && event.session_title === 'Renamed safe title'));
  for (const title of ['Native safe name', 'Renamed safe title', 'Native safe name']) {
    await writeFile(index, JSON.stringify({ id: UUID, thread_name: title, updated_at: nowDate.toISOString() }) + '\n');
    await monitor.pollOnce();
  }
  state = await monitor.getState();
  const titleTransitions = state.events.filter((event) => event.type === 'session_title_updated').map((event) => event.session_title);
  assert.deepEqual(titleTransitions, ['Renamed safe title', 'Native safe name', 'Renamed safe title', 'Native safe name']);
  const persisted = await readFile(path.join(f.directory, 'monitor-sessions', 'state.json'), 'utf8');
  for (const forbidden of [secretRawId, 'claude-private-session', 'PRIVATE PROMPT', '/private/work', 'codex resume secret', 'rollout-fixture.jsonl']) {
    assert.equal(persisted.includes(forbidden), false, `checkpoint must omit ${forbidden}`);
  }
});

test('unsafe native title explicitly clears, missing snapshot preserves history, and restart does not replay discovery', async (t) => {
  const f = await fixture(t);
  await writeFile(f.sessionFile, row('session_meta', { id: UUID }) + row('event_msg', { type: 'task_started', turn_id: TURN }, nowDate.toISOString(), 1));
  const index = path.join(f.codex, 'session_index.jsonl');
  await writeFile(index, JSON.stringify({ id: UUID, thread_name: 'Safe title', updated_at: nowDate.toISOString() }) + '\n');
  let snapshot = [{ agent: 'codex', id: UUID, path: '~/.codex/sessions/2026/10/13/rollout-fixture.jsonl', last: nowDate.toISOString() }];
  let clock = nowDate;
  let failSnapshot = false;
  const options = { pollIntervalMs: 60_000, execSnapshot: async () => {
    if (failSnapshot) throw new Error('synthetic cli failure');
    return JSON.stringify(snapshot);
  } };
  const env = { ...process.env, HOME: f.home, CODEX_HOME: f.codex };
  let monitor = await startSessionMonitor({ directory: f.directory, options, env, now: () => clock });
  assert.equal((await monitor.getState()).sessions[0].session_title, 'Safe title');
  await writeFile(index, JSON.stringify({ id: UUID, thread_name: '/private/unsafe', updated_at: '2026-10-13T12:01:00Z' }) + '\n');
  await monitor.pollOnce();
  let state = await monitor.getState();
  assert.equal(Object.hasOwn(state.sessions[0], 'session_title'), false);
  assert.ok(state.events.some((event) => event.type === 'session_title_updated' && event.session_title === null));
  const discoveryCount = state.events.filter((event) => event.type === 'session_discovered').length;
  snapshot = [];
  clock = new Date(nowDate.getTime() + 61_000);
  await monitor.pollOnce();
  state = await monitor.getState();
  assert.equal(state.sessions[0].execution_status, 'unknown');
  assert.equal(state.sessions[0].recently_active, false);
  failSnapshot = true;
  clock = new Date(nowDate.getTime() + 122_000);
  await monitor.pollOnce();
  assert.equal((await monitor.getState()).sessions[0].recently_active, false);
  await monitor.stop();
  failSnapshot = false;
  monitor = await startSessionMonitor({ directory: f.directory, options, env, now: () => clock });
  t.after(() => monitor.stop());
  state = await monitor.getState();
  assert.equal(state.events.filter((event) => event.type === 'session_discovered').length, discoveryCount);
  assert.equal(state.sessions[0].execution_status, 'unknown');
});

test('standby retries after writer stops; polling coalesces and stop aborts one slow snapshot', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const opts = { pollIntervalMs: 60_000, execSnapshot: async () => { calls += 1; return '[]'; } };
  const first = await startSessionMonitor({ directory: f.directory, options: opts, env: { ...process.env, HOME: f.home }, now: () => nowDate });
  const standby = await startSessionMonitor({ directory: f.directory, options: { ...opts, pollIntervalMs: 250 }, env: { ...process.env, HOME: f.home }, now: () => nowDate });
  assert.equal(standby.getDiagnostics().role, 'standby');
  await Promise.all([standby.pollOnce(), standby.pollOnce(), standby.pollOnce()]);
  assert.equal(calls, 1);
  await first.stop();
  await delay(300);
  assert.equal(standby.getDiagnostics().role, 'writer');
  await standby.stop();

  let aborted = false;
  let slowCalls = 0;
  const slow = await startSessionMonitor({
    directory: path.join(f.root, 'slow'), env: { ...process.env, HOME: f.home }, now: () => nowDate,
    options: { pollIntervalMs: 60_000, execSnapshot: (_args, { signal }) => {
      slowCalls += 1;
      if (slowCalls === 1) return '[]';
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
      });
    } },
  });
  const pending = slow.pollOnce();
  await delay(20);
  await slow.stop();
  await pending;
  assert.equal(aborted, true);
  assert.equal(slowCalls, 2);
});

test('standby opens relay bridge only after it acquires writer ownership', async (t) => {
  const f = await fixture(t);
  const monitorDir = path.join(f.directory, 'monitor-sessions');
  await mkdir(monitorDir, { recursive: true });
  await writeFile(path.join(monitorDir, 'relay.json'), JSON.stringify({ relay_url: 'ws://127.0.0.1:18765/ws',
    installation_id: 'standby-install', collector_token: 'col_standby_test_token' }), { mode: 0o600 });
  const sockets = [];
  const options = { pollIntervalMs: 250, execSnapshot: async () => '[]',
    websocketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; } };
  const env = { ...process.env, HOME: f.home };
  const writer = await startSessionMonitor({ directory: f.directory, options, env, now: () => nowDate });
  const standby = await startSessionMonitor({ directory: f.directory, options, env, now: () => nowDate });
  assert.equal(sockets.length, 1);
  assert.equal(standby.getDiagnostics().role, 'standby');
  await writer.stop();
  await delay(350);
  assert.equal(standby.getDiagnostics().role, 'writer');
  assert.equal(sockets.length, 2);
  await standby.stop();
  assert.equal(sockets[1].readyState, 3);
});

test('large lifecycle reads never combine head starts with discarded middle completions', async (t) => {
  const f = await fixture(t);
  const prefix = row('session_meta', { id: UUID }) + row('event_msg', { type: 'task_started', turn_id: TURN }, nowDate.toISOString(), 1);
  const middle = row('event_msg', { type: 'task_complete', turn_id: TURN }, nowDate.toISOString(), 2);
  await writeFile(f.sessionFile, `${prefix}${middle}${'{}\n'.repeat(4_500_000)}`);
  const result = await readCodexLifecycle([{
    agent_id: 'codex', _raw_id: UUID, _source_path: f.sessionFile,
    session_id: 'codex:sess:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }], f.codex, f.home, () => nowDate);
  assert.equal([...result.values()][0].status, 'unknown');
});

test('bounded larger tails accept fresh same-turn activity after an old start, then expire it', async (t) => {
  const f = await fixture(t);
  const oldStart = new Date(nowDate.getTime() - 31 * 60_000).toISOString();
  const recent = new Date(nowDate.getTime() - 2 * 60_000).toISOString();
  const sessionMeta = row('session_meta', { id: UUID });
  const start = row('event_msg', { type: 'task_started', turn_id: TURN }, oldStart, 1);
  const activity = row('response_item', { type: 'message' }, recent, 2);
  await writeFile(f.sessionFile, `${sessionMeta}${start}${'{}\n'.repeat(1_500_000)}${activity}`);
  const session = { agent_id: 'codex', _raw_id: UUID, _source_path: f.sessionFile, session_id: 'codex:sess:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
  let result = await readCodexLifecycle([session], f.codex, f.home, () => nowDate);
  assert.equal([...result.values()][0].status, 'working');
  assert.equal([...result.values()][0].last_activity_at, recent);

  await writeFile(f.sessionFile, `${sessionMeta}${row('event_msg', { type: 'task_started', turn_id: TURN }, oldStart, 1)}`);
  result = await readCodexLifecycle([session], f.codex, f.home, () => nowDate);
  assert.equal([...result.values()][0].status, 'unknown');

  await writeFile(f.sessionFile, `${sessionMeta}${row('event_msg', { type: 'task_started', turn_id: TURN }, recent, 1)}${row('response_item', { text: 'x'.repeat(1024 * 1024 + 1) }, recent, 2)}`);
  result = await readCodexLifecycle([session], f.codex, f.home, () => nowDate);
  assert.equal([...result.values()][0].status, 'unknown');
  assert.equal([...result.values()][0].reason, 'oversized_row');
});

test('malformed CLI snapshots retain checkpoint and child entry guard exports only plugin function', async (t) => {
  const f = await fixture(t);
  let output = '[]';
  const monitor = await startSessionMonitor({ directory: f.directory, options: { pollIntervalMs: 60_000, execSnapshot: async () => output }, env: { ...process.env, HOME: f.home }, now: () => nowDate });
  t.after(() => monitor.stop());
  output = '{broken';
  await monitor.pollOnce();
  const state = await monitor.getState();
  assert.equal(state.tick, 2);
  assert.deepEqual(state.sessions, []);
  assert.ok(state.diagnosticCodes.includes('magpie_snapshot_invalid'));
  const entry = await import('../index.mjs');
  assert.deepEqual(Object.keys(entry), ['default']);
});
