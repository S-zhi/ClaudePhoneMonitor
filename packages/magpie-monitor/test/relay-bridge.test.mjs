import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startRelayBridge } from '../relay-bridge.mjs';

const installation = 'install-test-742';
const sessionId = `codex:sess:${'a'.repeat(64)}`;
const turnHash = 'b'.repeat(64);
const now = () => new Date('2026-10-13T12:00:00.000Z');
const startedAt = '2026-10-13T11:59:00.000Z';

class FakeSocket {
  readyState = 0;
  sent = [];
  listeners = new Map();
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  emit(type, data) { for (const fn of this.listeners.get(type) ?? []) fn(data); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.emit('close', {}); }
  open() { this.readyState = 1; this.emit('open', {}); }
  message(value) { this.emit('message', { data: JSON.stringify(value) }); }
}

async function fixture(t, installId = installation) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magpie-relay-bridge-'));
  const directory = path.join(root, 'config');
  const monitorDir = path.join(directory, 'monitor-sessions');
  await mkdir(monitorDir, { recursive: true, mode: 0o700 });
  const configFile = path.join(monitorDir, 'relay.json');
  await writeFile(configFile, JSON.stringify({ relay_url: 'ws://127.0.0.1:18765/ws', installation_id: installId,
    collector_token: 'col_synthetic_test_token', sequence_floor: 700 }), { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const sockets = [];
  const bridge = await startRelayBridge({ directory, configFile, now, options: {
    websocketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
  } });
  return { root, directory, monitorDir, configFile, sockets, bridge };
}

function session(overrides = {}) {
  return {
    session_id: sessionId, agent_id: 'codex', session_kind: 'main', session_title: 'Safe Codex title',
    source_started_at: '2026-10-13T11:50:00.000Z', source_last_activity_at: startedAt,
    execution_status: 'working', execution_evidence: { event: 'task_started', occurred_at: startedAt,
      last_activity_at: startedAt, turn_hash: turnHash },
    ...overrides,
  };
}

function snapshot(sequence, row) {
  return { tick: sequence, events: [{ sequence }], sessions: row ? [row] : [] };
}

async function connect(bridge, socket) {
  socket.open();
  assert.equal(socket.sent[0].type, 'hello');
  assert.equal(socket.sent[0].installation_id, installation);
  assert.equal(socket.sent[0].token, 'col_synthetic_test_token');
  socket.message({ type: 'hello_ack', accepted: true, installation_id: installation });
  await bridge.ingestSnapshot(snapshot(1, session()));
}

test('opt-in bridge queues safe metadata and fresh Codex task, then durably replays IDs until ACK', async (t) => {
  const f = await fixture(t);
  const [socket] = f.sockets;
  await connect(f.bridge, socket);
  const sent = socket.sent.filter((message) => message.type === 'event');
  const metadata = sent.find((event) => event.event_type === 'session_metadata_updated');
  const taskStart = sent.find((event) => event.event_type === 'task_started');
  assert.ok(metadata);
  assert.equal(metadata.session_title, 'Safe Codex title');
  assert.equal(metadata.session_kind, 'main');
  assert.equal(metadata.payload.source_last_activity_at, startedAt);
  assert.ok(taskStart);
  assert.equal(taskStart.task_id, `codex:turn:${turnHash}`);
  assert.equal(taskStart.occurred_at, startedAt);
  const persisted = await readFile(path.join(f.monitorDir, `relay-outbox-${(await import('../identity.mjs')).sha256(installation).slice(0, 16)}.json`), 'utf8');
  for (const forbidden of ['col_synthetic_test_token', 'PRIVATE PROMPT', '/private/work', 'raw-native-id']) assert.equal(persisted.includes(forbidden), false);
  const firstId = taskStart.event_id;
  const firstSequence = taskStart.sequence;
  await f.bridge.stop();

  const replaySockets = [];
  const replay = await startRelayBridge({ directory: f.directory, configFile: f.configFile, now, options: {
    websocketFactory: () => { const socket2 = new FakeSocket(); replaySockets.push(socket2); return socket2; },
  } });
  t.after(() => replay.stop());
  const second = replaySockets[0];
  second.open();
  second.message({ type: 'hello_ack', accepted: true, installation_id: installation });
  const replayedStart = second.sent.find((event) => event.event_id === firstId);
  assert.equal(replayedStart.sequence, firstSequence);
  second.message({ type: 'event_ack', event_id: firstId, sequence: firstSequence, accepted: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(replay.getStatus().pending, sent.length - 1);
});

test('old idle and unknown transitions never synthesize DONE; unknown metadata revokes working state', async (t) => {
  const f = await fixture(t);
  const socket = f.sockets[0];
  await connect(f.bridge, socket);
  const start = socket.sent.find((event) => event.event_type === 'task_started');
  await f.bridge.ingestSnapshot(snapshot(2, session({ execution_status: 'unknown', execution_unknown_reason: 'source_unavailable', execution_evidence: undefined })));
  let queued = JSON.parse(await readFile(path.join(f.monitorDir, `relay-outbox-${(await import('../identity.mjs')).sha256(installation).slice(0, 16)}.json`), 'utf8'));
  assert.ok(queued.pending.some((event) => event.payload.source_execution_status === 'unknown'));
  assert.equal(queued.pending.some((event) => ['task_finished', 'task_failed'].includes(event.event_type)), false);

  await f.bridge.ingestSnapshot({ tick: 5, events: [{ sequence: 1 }], sessions: [session()] });
  await f.bridge.ingestSnapshot({ tick: 6, events: [{ sequence: 1 }], sessions: [session({
    execution_status: 'unknown', execution_unknown_reason: 'source_unavailable', execution_evidence: undefined,
  })] });
  queued = JSON.parse(await readFile(path.join(f.monitorDir, `relay-outbox-${(await import('../identity.mjs')).sha256(installation).slice(0, 16)}.json`), 'utf8'));
  assert.ok(queued.pending.filter((event) => event.payload.source_execution_status === 'unknown').length >= 2,
    'status changes are forwarded even when the journal sequence does not advance');

  await f.bridge.ingestSnapshot(snapshot(3, session()));
  await f.bridge.ingestSnapshot(snapshot(4, session({ execution_status: 'idle', execution_evidence: {
    event: 'task_complete', occurred_at: '2026-10-13T10:00:00.000Z', turn_hash: turnHash,
  } })));
  queued = JSON.parse(await readFile(path.join(f.monitorDir, `relay-outbox-${(await import('../identity.mjs')).sha256(installation).slice(0, 16)}.json`), 'utf8'));
  assert.ok(queued.pending.some((event) => event.event_id === start.event_id));
  assert.equal(queued.pending.some((event) => event.event_type === 'task_finished'), false);
});

test('initial negative hello acknowledgement waits for authentication; accepted acknowledgement releases events', async (t) => {
  const f = await fixture(t);
  const socket = f.sockets[0];
  await f.bridge.ingestSnapshot(snapshot(1, session()));
  assert.equal(socket.sent.length, 0);
  socket.open();
  assert.deepEqual(socket.sent.map((message) => message.type), ['hello']);
  socket.message({ type: 'hello_ack', accepted: false });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(socket.sent.filter((message) => message.type === 'event').length, 0);
  assert.equal(f.bridge.getStatus().connected, false);
  socket.message({ type: 'hello_ack', accepted: true, installation_id: installation });
  assert.ok(socket.sent.some((message) => message.type === 'event'));
  assert.equal(f.bridge.getStatus().connected, true);
});

test('negative hello only releases no events and fails closed on handshake timeout', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magpie-relay-timeout-'));
  const directory = path.join(root, 'config');
  const monitorDir = path.join(directory, 'monitor-sessions');
  await mkdir(monitorDir, { recursive: true, mode: 0o700 });
  const configFile = path.join(monitorDir, 'relay.json');
  await writeFile(configFile, JSON.stringify({ relay_url: 'ws://127.0.0.1:18765/ws', installation_id: installation,
    collector_token: 'col_synthetic_test_token' }), { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const sockets = [];
  const bridge = await startRelayBridge({ directory, configFile, now, options: {
    handshakeTimeoutMs: 25,
    websocketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
  } });
  t.after(() => bridge.stop());
  const socket = sockets[0];
  await bridge.ingestSnapshot(snapshot(1, session()));
  socket.open();
  socket.message({ type: 'hello_ack', accepted: false });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(socket.sent.filter((message) => message.type === 'event').length, 0);
  assert.equal(bridge.getStatus().connected, false);
  assert.equal(bridge.getStatus().errorCode, 'relay_handshake_timeout');
});

test('explicit unauthorized blocks reconnect but keeps durable local ingest active', async (t) => {
  const f = await fixture(t);
  const socket = f.sockets[0];
  socket.open();
  socket.message({ type: 'error', code: 'unauthorized' });
  assert.equal(f.bridge.getStatus().errorCode, 'relay_unauthorized');
  await f.bridge.ingestSnapshot(snapshot(1, session()));
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal(f.sockets.length, 1, 'bad credentials must not trigger an automatic retry loop');
  assert.equal(f.bridge.getStatus().pending, 2);
});

test('fresh matching completion and abort close only previously emitted turns once', async (t) => {
  const f = await fixture(t);
  const socket = f.sockets[0];
  socket.open();
  socket.message({ type: 'hello_ack', accepted: true, installation_id: installation });
  await f.bridge.ingestSnapshot(snapshot(1, session()));
  await f.bridge.ingestSnapshot(snapshot(2, session({ execution_status: 'idle', execution_evidence: {
    event: 'task_complete', occurred_at: '2026-10-13T11:59:20.000Z', turn_hash: turnHash,
  } })));
  await f.bridge.ingestSnapshot(snapshot(2, session({ execution_status: 'idle', execution_evidence: {
    event: 'task_complete', occurred_at: '2026-10-13T11:59:20.000Z', turn_hash: turnHash,
  } })));
  assert.equal(socket.sent.filter((event) => event.event_type === 'task_finished').length, 1);

  const nextTurn = 'c'.repeat(64);
  await f.bridge.ingestSnapshot(snapshot(3, session({ execution_evidence: {
    event: 'task_started', occurred_at: '2026-10-13T11:59:30.000Z', last_activity_at: '2026-10-13T11:59:30.000Z', turn_hash: nextTurn,
  } })));
  await f.bridge.ingestSnapshot(snapshot(4, session({ execution_status: 'idle', execution_evidence: {
    event: 'turn_aborted', occurred_at: '2026-10-13T11:59:40.000Z', turn_hash: nextTurn,
  } })));
  await f.bridge.ingestSnapshot(snapshot(4, session({ execution_status: 'idle', execution_evidence: {
    event: 'turn_aborted', occurred_at: '2026-10-13T11:59:40.000Z', turn_hash: nextTurn,
  } })));
  assert.equal(socket.sent.filter((event) => event.event_type === 'task_failed').length, 1);
});

test('installation namespaces do not reuse outbox sequence', async (t) => {
  const f = await fixture(t);
  await f.bridge.stop();
  const otherConfig = path.join(f.monitorDir, 'relay-other.json');
  await writeFile(otherConfig, JSON.stringify({ relay_url: 'ws://127.0.0.1:18765/ws', installation_id: 'install-other',
    collector_token: 'col_other_test_token', sequence_floor: 4 }), { mode: 0o600 });
  const otherSockets = [];
  const other = await startRelayBridge({ directory: f.directory, configFile: otherConfig, now, options: {
    websocketFactory: () => { const socket = new FakeSocket(); otherSockets.push(socket); return socket; },
  } });
  t.after(() => other.stop());
  assert.equal(other.getStatus().last_sequence, 4);
  assert.notEqual(path.basename(otherConfig), path.basename(f.configFile));
  await other.stop();

});

test('outbox restore rejects foreign installation, duplicate sequence, and prompt/path payload injection', async (t) => {
  const { sha256 } = await import('../identity.mjs');
  for (const mutate of [
    (outbox) => { outbox.pending[0].installation_id = 'install-foreign'; },
    (outbox) => { outbox.pending[1].sequence = outbox.pending[0].sequence; },
    (outbox) => { outbox.pending[0].payload.prompt = 'PRIVATE PROMPT'; outbox.pending[0].payload.path = '/private/work'; },
  ]) {
    const f = await fixture(t);
    const socket = f.sockets[0];
    socket.open(); socket.message({ type: 'hello_ack', accepted: true, installation_id: installation });
    await f.bridge.ingestSnapshot(snapshot(1, session()));
    await f.bridge.stop();
    const outboxFile = path.join(f.monitorDir, `relay-outbox-${sha256(installation).slice(0, 16)}.json`);
    const outbox = JSON.parse(await readFile(outboxFile, 'utf8'));
    assert.ok(outbox.pending.length >= 2);
    mutate(outbox);
    await writeFile(outboxFile, JSON.stringify(outbox), { mode: 0o600 });
    await assert.rejects(startRelayBridge({ directory: f.directory, configFile: f.configFile, now,
      options: { websocketFactory: () => new FakeSocket() } }), /relay_outbox_invalid/);
  }
});

test('relay configuration rejects symlinks and remains opt-in', async (t) => {
  const f = await fixture(t);
  await f.bridge.stop();
  const link = path.join(f.monitorDir, 'relay-link.json');
  await symlink(f.configFile, link);
  await assert.rejects(startRelayBridge({ directory: f.directory, configFile: link, now }), /relay_config_invalid/);
  const disabled = await startRelayBridge({ directory: path.join(f.root, 'empty'), now });
  assert.equal(disabled, null);
});
