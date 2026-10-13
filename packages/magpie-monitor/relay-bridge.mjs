import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { safeSessionTitle, parseTimestamp, sha256 } from './identity.mjs';

const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_OUTBOX_BYTES = 4 * 1024 * 1024;
const MAX_PENDING = 1000;
const FRESH_MS = 30 * 60_000;
const HEARTBEAT_MS = 10_000;
const HELLO_TIMEOUT_MS = 5_000;

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function safeFingerprint(value) { return /^[a-f0-9]{64}$/.test(value ?? ''); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function safeTaskSession(value) {
  if (!isRecord(value) || !/^(?:codex:sess:[a-f0-9]{64}|agent_[a-f0-9]{32})$/.test(value.session_id ?? '')
    || !/^[a-z0-9._-]{1,64}$/.test(value.agent_id ?? '') || !['main', 'subagent'].includes(value.session_kind)) return undefined;
  const result = { session_id: value.session_id, agent_id: value.agent_id, session_kind: value.session_kind };
  if (typeof value.session_title === 'string' && safeSessionTitle(value.session_title)) result.session_title = safeSessionTitle(value.session_title);
  for (const key of ['source_started_at', 'source_last_activity_at']) {
    const timestamp = parseTimestamp(value[key]);
    if (timestamp) result[key] = timestamp;
  }
  return result;
}

export async function loadRelayConfig(file) {
  let info;
  let handle;
  try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('relay_config_unreadable'); }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES || (info.mode & 0o077) !== 0) {
    throw new Error('relay_config_invalid');
  }
  let value;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size || opened.size > MAX_CONFIG_BYTES) throw new Error('relay_config_invalid');
    value = JSON.parse(await handle.readFile('utf8'));
  } catch { throw new Error('relay_config_invalid'); }
  finally { await handle?.close().catch(() => {}); }
  const keys = new Set(['relay_url', 'installation_id', 'collector_token', 'sequence_floor']);
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.has(key))
    || typeof value.relay_url !== 'string' || value.relay_url.length > 2048
    || typeof value.installation_id !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.installation_id)
    || typeof value.collector_token !== 'string' || value.collector_token.length < 8 || value.collector_token.length > 512
    || (value.sequence_floor !== undefined && (!Number.isSafeInteger(value.sequence_floor) || value.sequence_floor < 0))) {
    throw new Error('relay_config_invalid');
  }
  let url;
  try { url = new URL(value.relay_url); } catch { throw new Error('relay_config_invalid'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('relay_config_invalid');
  return {
    relay_url: url.toString(), installation_id: value.installation_id,
    collector_token: value.collector_token, sequence_floor: value.sequence_floor ?? 0,
  };
}

async function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const data = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(data) > MAX_OUTBOX_BYTES) throw new Error('relay_outbox_full');
  await writeFile(temp, data, { flag: 'wx', mode: 0o600 });
  try { await rename(temp, file); } catch (error) { await rm(temp, { force: true }); throw error; }
}

function safeEnvelope(source) {
  if (!isRecord(source) || source.type !== 'event' || typeof source.event_id !== 'string'
    || !Number.isSafeInteger(source.sequence) || source.sequence < 1
    || typeof source.installation_id !== 'string' || typeof source.session_id !== 'string'
    || typeof source.event_type !== 'string' || !parseTimestamp(source.occurred_at)) return undefined;
  const allowedTypes = new Set(['session_metadata_updated', 'session_title_updated', 'task_started', 'task_finished', 'task_failed']);
  if (!allowedTypes.has(source.event_type) || !/^(?:codex:sess:[a-f0-9]{64}|agent_[a-f0-9]{32})$/.test(source.session_id)) return undefined;
  const payload = {};
  if (source.event_type === 'session_metadata_updated' && isRecord(source.payload)) {
    for (const key of ['source_started_at', 'source_last_activity_at']) {
      const value = parseTimestamp(source.payload[key]);
      if (value) payload[key] = value;
    }
    if (source.payload.source_execution_status === 'unknown') payload.source_execution_status = 'unknown';
  }
  if (source.event_type === 'task_failed' && isRecord(source.payload) && /^[a-z0-9._-]{1,128}$/.test(source.payload.error_code ?? '')) {
    payload.error_code = source.payload.error_code;
  }
  if (isRecord(source.payload)) {
    for (const key of ['duration_ms', 'exit_code']) {
      if (Number.isSafeInteger(source.payload[key]) && source.payload[key] >= 0) payload[key] = source.payload[key];
    }
  }
  const envelope = {
    type: 'event', schema_version: 1, event_id: source.event_id,
    agent_id: source.agent_id === 'codex' ? 'codex' : 'magpie',
    installation_id: source.installation_id, session_id: source.session_id,
    sequence: source.sequence, occurred_at: parseTimestamp(source.occurred_at),
    event_type: source.event_type, payload,
  };
  if (typeof source.task_id === 'string' && /^codex:turn:[a-f0-9]{64}$/.test(source.task_id)) envelope.task_id = source.task_id;
  if (typeof source.session_title === 'string' && safeSessionTitle(source.session_title)) envelope.session_title = safeSessionTitle(source.session_title);
  if (source.session_kind === 'main' || source.session_kind === 'subagent') envelope.session_kind = source.session_kind;
  if (typeof source.correlation_id === 'string' && source.correlation_id.length <= 256) envelope.correlation_id = source.correlation_id;
  return envelope;
}

function validOutbox(value, installationId) {
  const exactKeys = (record, keys) => isRecord(record) && Object.keys(record).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(record, key));
  let priorSequence = 0;
  const pendingSafe = Array.isArray(value?.pending) && value.pending.every((event) => {
    const safe = safeEnvelope(event);
    const valid = safe && event.installation_id === installationId
      && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(event.event_id ?? '')
      && event.sequence > priorSequence && JSON.stringify(canonical(safe)) === JSON.stringify(canonical(event));
    if (valid) priorSequence = event.sequence;
    return Boolean(valid);
  });
  const fingerprintsSafe = isRecord(value?.source?.fingerprints) && Object.entries(value.source.fingerprints).every(([id, encoded]) => {
    if (!/^(?:codex:sess:[a-f0-9]{64}|agent_[a-f0-9]{32})$/.test(id) || typeof encoded !== 'string' || encoded.length > 4096) return false;
    let fields;
    try { fields = JSON.parse(encoded); } catch { return false; }
    return Array.isArray(fields) && fields.length === 5
      && (fields[0] === null || (typeof fields[0] === 'string' && safeSessionTitle(fields[0]) === fields[0]))
      && (fields[1] === null || parseTimestamp(fields[1]) === fields[1])
      && (fields[2] === null || parseTimestamp(fields[2]) === fields[2])
      && (fields[3] === null || ['main', 'subagent'].includes(fields[3]))
      && (fields[4] === null || fields[4] === 'unknown');
  });
  return exactKeys(value, ['schemaVersion', 'installationId', 'nextSequence', 'lastAcknowledgedSequence', 'pending', 'source'])
    && exactKeys(value.source, ['sourceSequence', 'fingerprints', 'tasks'])
    && value.schemaVersion === 1 && value.installationId === installationId
    && Number.isSafeInteger(value.nextSequence) && value.nextSequence >= 1
    && Number.isSafeInteger(value.lastAcknowledgedSequence) && value.lastAcknowledgedSequence >= 0 && value.lastAcknowledgedSequence < value.nextSequence
    && Array.isArray(value.pending) && value.pending.length <= MAX_PENDING
    && pendingSafe
    && new Set(value.pending.map((event) => event.event_id)).size === value.pending.length
    && new Set(value.pending.map((event) => event.sequence)).size === value.pending.length
    && value.pending.every((event) => event.sequence < value.nextSequence)
    && isRecord(value.source) && Number.isSafeInteger(value.source.sourceSequence) && value.source.sourceSequence >= 0
    && fingerprintsSafe
    && isRecord(value.source.tasks) && Object.entries(value.source.tasks).every(([id, task]) =>
      /^(?:codex:sess:[a-f0-9]{64}|agent_[a-f0-9]{32})$/.test(id) && exactKeys(task, ['turn_hash', 'task_id', 'fingerprint', 'started_at', 'session'])
      && safeFingerprint(task.turn_hash) && typeof task.task_id === 'string' && /^codex:turn:[a-f0-9]{64}$/.test(task.task_id)
      && typeof task.fingerprint === 'string' && task.fingerprint.startsWith(`${task.turn_hash}:`)
      && parseTimestamp(task.started_at) === task.started_at && safeTaskSession(task.session)
      && JSON.stringify(canonical(safeTaskSession(task.session))) === JSON.stringify(canonical(task.session)));
}

function metadataFingerprint(session) {
  const material = JSON.stringify([
    session.session_title ?? null, session.source_started_at ?? null,
    session.source_last_activity_at ?? null, session.session_kind ?? null,
    session.execution_status === 'unknown' ? 'unknown' : null,
  ]);
  return material;
}

function isFresh(value, now) {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) && time <= now && now - time <= FRESH_MS;
}

function wireTitle(session) {
  if (safeSessionTitle(session.session_title)) return safeSessionTitle(session.session_title);
  return session.agent_id === 'codex' ? 'Codex session' : `${session.agent_id.slice(0, 52)} session`;
}

function makeEnvelope(config, state, eventType, session, taskId, occurredAt, payload = {}) {
  const sequence = state.nextSequence++;
  const event = {
    type: 'event', schema_version: 1, event_id: randomUUID(), agent_id: session.agent_id,
    installation_id: config.installation_id, session_id: session.session_id,
    session_kind: session.session_kind, sequence, occurred_at: parseTimestamp(occurredAt) ?? new Date().toISOString(),
    event_type: eventType, payload,
  };
  if (taskId) event.task_id = taskId;
  if (eventType !== 'session_metadata_updated') event.correlation_id = taskId ?? `session:${session.session_id}`;
  if (['session_started', 'session_title_updated', 'task_started'].includes(eventType)) event.session_title = wireTitle(session);
  return event;
}

async function readOutbox(file, installationId, sequenceFloor) {
  let stat;
  try { stat = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, installationId, nextSequence: sequenceFloor + 1, lastAcknowledgedSequence: sequenceFloor, pending: [], source: { fingerprints: {}, tasks: {}, sourceSequence: 0 } }; throw new Error('relay_outbox_invalid'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_OUTBOX_BYTES || (stat.mode & 0o077) !== 0) throw new Error('relay_outbox_invalid');
  let value;
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.size > MAX_OUTBOX_BYTES) throw new Error('relay_outbox_invalid');
    value = JSON.parse(await handle.readFile('utf8'));
  } catch { throw new Error('relay_outbox_invalid'); }
  finally { await handle?.close().catch(() => {}); }
  if (!validOutbox(value, installationId) || value.nextSequence < sequenceFloor + 1
    || value.pending.some((event) => event.sequence <= sequenceFloor || event.sequence >= value.nextSequence)) throw new Error('relay_outbox_invalid');
  return value;
}

export async function startRelayBridge({ directory, configFile, options = {}, env = process.env, now = () => new Date() }) {
  const configPath = configFile ?? options.relayConfigFile ?? path.join(directory, 'monitor-sessions', 'relay.json');
  const config = await loadRelayConfig(configPath);
  if (!config) return null;
  const root = path.dirname(configPath) === path.join(directory, 'monitor-sessions')
    ? path.dirname(configPath) : path.join(directory, 'monitor-sessions');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const outboxFile = path.join(root, `relay-outbox-${sha256(config.installation_id).slice(0, 16)}.json`);
  let disk = await readOutbox(outboxFile, config.installation_id, config.sequence_floor);
  let socket;
  let connected = false;
  let accepted = false;
  let closed = false;
  let authBlocked = false;
  let retryTimer;
  let heartbeatTimer;
  let helloTimer;
  let retryMs = 1000;
  let errorCode;
  const inFlightIds = new Set();
  const helloTimeoutMs = Number.isSafeInteger(options.handshakeTimeoutMs) && options.handshakeTimeoutMs > 0
    ? Math.min(options.handshakeTimeoutMs, 30_000) : HELLO_TIMEOUT_MS;
  let mutation = Promise.resolve();
  const exclusive = (work) => {
    const next = mutation.then(work, work);
    mutation = next.catch(() => {});
    return next;
  };
  const WebSocketCtor = options.WebSocket ?? globalThis.WebSocket;
  const socketFactory = options.websocketFactory ?? ((url) => new WebSocketCtor(url));

  const save = async (next) => { await atomicJson(outboxFile, next); disk = next; };
  const status = () => ({ connected: connected && accepted, pending: disk.pending.length, last_sequence: disk.lastAcknowledgedSequence, ...(errorCode ? { errorCode } : {}) });
  const send = (message) => {
    if (!connected || !accepted || !socket || socket.readyState !== 1) return false;
    try { socket.send(JSON.stringify(message)); return true; } catch { return false; }
  };
  const flush = () => {
    if (!connected || !accepted) return;
    for (const event of disk.pending) {
      if (inFlightIds.has(event.event_id)) continue;
      if (send(event)) inFlightIds.add(event.event_id);
    }
  };
  const schedule = () => {
    if (closed || authBlocked || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = undefined; connect(); }, retryMs);
    retryTimer.unref?.();
    retryMs = Math.min(30_000, retryMs * 2);
  };
  const heartbeat = () => send({ type: 'heartbeat', schema_version: 1, role: 'collector', installation_id: config.installation_id, last_sequence: disk.nextSequence - 1, heartbeat_id: `monitor-${randomUUID()}`, sent_at: now().toISOString(), occurred_at: now().toISOString() });
  const dropSocket = (ws, code) => {
    if (!ws || socket !== ws) return;
    socket = undefined; connected = false; accepted = false; inFlightIds.clear();
    clearTimeout(helloTimer); helloTimer = undefined;
    clearInterval(heartbeatTimer); heartbeatTimer = undefined;
    if (code) errorCode = code;
    try { ws.close(); } catch { /* reconnect below */ }
    if (!closed) schedule();
  };
  const handle = async (raw) => {
    let message;
    try { message = JSON.parse(typeof raw === 'string' ? raw : raw?.data?.toString?.() ?? raw?.data); } catch { return; }
    if (!isRecord(message) || typeof message.type !== 'string') return;
    if (message.type === 'hello_ack') {
      if (message.accepted !== true) return;
      if (message.installation_id !== undefined && message.installation_id !== config.installation_id) {
        dropSocket(socket, 'relay_handshake_rejected');
        return;
      }
      clearTimeout(helloTimer); helloTimer = undefined;
      accepted = true;
      connected = true;
      errorCode = undefined;
      flush();
      return;
    }
    if (message.type === 'error' && message.code === 'unauthorized') {
      authBlocked = true;
      dropSocket(socket, 'relay_unauthorized');
      return;
    }
    if (message.type === 'event_ack') {
      const acceptedAck = message.accepted === true || message.status === 'accepted' || message.status === 'duplicate' || message.duplicate === true;
      if (!acceptedAck) { errorCode = 'relay_event_rejected'; return; }
      const pending = disk.pending.find((event) => event.event_id === message.event_id);
      if (!pending || (Number.isSafeInteger(message.sequence) && pending.sequence !== message.sequence)) return;
      inFlightIds.delete(message.event_id);
      await exclusive(async () => {
        if (!disk.pending.some((event) => event.event_id === message.event_id)) return;
        await save({ ...disk, lastAcknowledgedSequence: Math.max(disk.lastAcknowledgedSequence, pending.sequence), pending: disk.pending.filter((event) => event.event_id !== message.event_id) });
        errorCode = undefined;
      });
      return;
    }
    if (message.type === 'heartbeat') {
      if (!message.acknowledged) send({ ...message, schema_version: 1, role: 'collector', installation_id: config.installation_id, acknowledged: true, sent_at: now().toISOString() });
      return;
    }
    if (message.type === 'challenge') {
      const ack = { type: 'challenge_ack', schema_version: 1 };
      if (typeof message.challenge_id === 'string') { ack.challenge_id = message.challenge_id; ack.ok = true; }
      if (typeof message.probe_id === 'string') ack.probe_id = message.probe_id;
      if (typeof message.nonce === 'string') ack.nonce = message.nonce;
      send(ack);
    }
  };
  const disconnect = (ws, code) => {
    if (socket !== ws) return;
    socket = undefined; connected = false; accepted = false; inFlightIds.clear();
    clearTimeout(helloTimer); helloTimer = undefined;
    clearInterval(heartbeatTimer); heartbeatTimer = undefined;
    if (code) errorCode = code;
    try { ws.close(); } catch { /* reconnect below */ }
    if (!closed) schedule();
  };
  const connect = () => {
    if (closed || authBlocked || socket) return;
    let ws;
    try { ws = socketFactory(config.relay_url); } catch { errorCode = 'relay_connect_failed'; schedule(); return; }
    socket = ws;
    const add = (name, fn) => ws.addEventListener ? ws.addEventListener(name, fn) : ws.on?.(name, fn);
    add('open', () => {
      if (closed || socket !== ws) return;
      connected = true;
      retryMs = 1000;
      accepted = false;
      inFlightIds.clear();
      try { ws.send(JSON.stringify({ type: 'hello', schema_version: 1, role: 'collector', installation_id: config.installation_id, last_sequence: disk.lastAcknowledgedSequence, token: config.collector_token })); }
      catch { errorCode = 'relay_handshake_failed'; }
      clearTimeout(helloTimer);
      helloTimer = setTimeout(() => dropSocket(ws, 'relay_handshake_timeout'), helloTimeoutMs);
      helloTimer.unref?.();
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
      heartbeatTimer.unref?.();
    });
    add('message', (event) => { if (socket === ws) void handle(event).catch(() => { errorCode = 'relay_outbox_write_failed'; }); });
    add('close', () => dropSocket(ws));
    add('error', () => dropSocket(ws, 'relay_socket_error'));
    if (ws.readyState === 1) queueMicrotask(() => {
      try { ws.dispatchEvent?.(new Event('open')); } catch { /* Already-open adapters may not dispatch. */ }
    });
  };

  await mkdir(root, { recursive: true, mode: 0o700 });
  connect();

  const ingestSnapshot = (snapshot) => exclusive(async () => {
    if (closed || !isRecord(snapshot) || !Array.isArray(snapshot.sessions)) return;
    const next = structuredClone(disk);
    const sourceSequence = Number.isSafeInteger(snapshot.events?.at?.(-1)?.sequence) ? snapshot.events.at(-1).sequence : next.source.sourceSequence;
    next.source.sourceSequence = Math.max(next.source.sourceSequence, sourceSequence);
    const byRecency = snapshot.sessions.filter((session) => isRecord(session) && typeof session.session_id === 'string')
      .sort((a, b) => Date.parse(b.source_last_activity_at ?? '') - Date.parse(a.source_last_activity_at ?? ''));
    const working = byRecency.filter((session) => session.execution_status === 'working');
    const selected = new Map();
    for (const session of working.slice(0, 100)) selected.set(session.session_id, session);
    for (const session of byRecency) { if (selected.size >= 100) break; selected.set(session.session_id, session); }
    const rowsById = new Map(byRecency.map((session) => [session.session_id, session]));
    for (const [id, task] of Object.entries(next.source.tasks)) {
      if (selected.has(id)) continue;
      const session = rowsById.get(id) ?? task.session;
      if (session) selected.set(id, { ...session, execution_status: 'unknown', execution_unknown_reason: 'source_unavailable' });
    }
    const timestamp = now().getTime();
    for (const session of selected.values()) {
      const id = session.session_id;
      const priorTask = next.source.tasks[id];
      if (!['main', 'subagent'].includes(session.session_kind) && priorTask?.session?.session_kind) session.session_kind = priorTask.session.session_kind;
      const kind = session.session_kind;
      if (!['main', 'subagent'].includes(kind)) continue;
      const metadataKey = metadataFingerprint(session);
      const priorFingerprint = next.source.fingerprints[id];
      if (priorFingerprint !== metadataKey) {
        const payload = {};
        if (parseTimestamp(session.source_started_at)) payload.source_started_at = parseTimestamp(session.source_started_at);
        if (parseTimestamp(session.source_last_activity_at)) payload.source_last_activity_at = parseTimestamp(session.source_last_activity_at);
        if (session.execution_status === 'unknown') payload.source_execution_status = 'unknown';
        const envelope = makeEnvelope(config, next, 'session_metadata_updated', session, undefined,
          session.source_last_activity_at ?? session.source_started_at ?? now().toISOString(), payload);
        envelope.session_title = wireTitle(session);
        next.pending.push(envelope);
        next.source.fingerprints[id] = metadataKey;
      }
      const evidence = session.execution_evidence;
      const turnHash = evidence?.event === 'task_started' ? evidence.turn_hash : undefined;
      const activityAt = evidence?.last_activity_at;
      if (session.agent_id === 'codex' && session.execution_status === 'working' && safeFingerprint(turnHash)
        && isFresh(activityAt, timestamp)) {
        const fingerprint = `${turnHash}:${activityAt}`;
        if (!priorTask || priorTask.fingerprint !== fingerprint) {
          const taskId = `codex:turn:${turnHash}`;
          next.pending.push(makeEnvelope(config, next, 'task_started', session, taskId, activityAt));
          next.source.tasks[id] = { turn_hash: turnHash, task_id: taskId, fingerprint, started_at: priorTask?.started_at ?? activityAt, session: safeTaskSession(session) };
        }
      } else if (session.agent_id === 'codex' && ['task_complete', 'turn_aborted'].includes(evidence?.event)
        && safeFingerprint(evidence.turn_hash) && isFresh(evidence.occurred_at, timestamp)) {
        const priorTask = next.source.tasks[id];
        if (priorTask?.turn_hash === evidence.turn_hash) {
          const eventType = evidence.event === 'task_complete' ? 'task_finished' : 'task_failed';
          next.pending.push(makeEnvelope(config, next, eventType, session, priorTask.task_id, evidence.occurred_at));
          delete next.source.tasks[id];
        }
      } else if (session.execution_status !== 'working') {
        delete next.source.tasks[id];
      }
    }
    if (next.pending.length > MAX_PENDING) {
      errorCode = 'relay_outbox_full';
      return;
    }
    await save(next);
    flush();
  });

  return {
    ingestSnapshot,
    getStatus: status,
    async stop() {
      if (closed) return;
      closed = true;
      await mutation;
      clearTimeout(retryTimer); clearInterval(heartbeatTimer); clearTimeout(helloTimer);
      connected = false; accepted = false;
      const ws = socket; socket = undefined;
      try { ws?.close(1000, 'monitor_stopped'); } catch { /* best-effort close */ }
    },
  };
}

export const RELAY_BRIDGE_LIMITS = Object.freeze({ MAX_CONFIG_BYTES, MAX_OUTBOX_BYTES, MAX_PENDING, FRESH_MS, HEARTBEAT_MS });
