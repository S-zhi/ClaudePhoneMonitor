import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readMagpieSnapshot } from './command.mjs';
import { normalizeSnapshot, parseTimestamp, safeSessionTitle } from './identity.mjs';
import { readCodexLifecycle } from './lifecycle.mjs';
import { readMagpieCache, readNativeTitles } from './sources.mjs';
import { startRelayBridge } from './relay-bridge.mjs';

const MAX_HISTORY_SESSIONS = 5000;
const MAX_EVENTS = 2000;
const MAX_DIAGNOSTICS = 32;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const RECENT_ACTIVITY_MS = 60_000;
const UNKNOWN_AFTER_MS = 30 * 60_000;
const TITLE_SOURCES = new Set(['codex_sqlite', 'codex_session_index', 'magpie_cache_custom', 'magpie_cache_named']);
const UNKNOWN_REASONS = new Set(['unsupported_agent', 'no_verified_lifecycle', 'source_unavailable', 'stale', 'source_rewritten', 'budget_exhausted', 'source_read_failed']);

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isoNow(now) { return now().toISOString(); }
function timestampMs(value) { const result = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(result) ? result : undefined; }

function validStoredSession(session) {
  return isRecord(session) && typeof session.session_id === 'string'
    && /^(?:codex:sess:[a-f0-9]{64}|agent_[a-f0-9]{32})$/.test(session.session_id)
    && typeof session.agent_id === 'string' && /^[a-z0-9._-]{1,64}$/.test(session.agent_id)
    && ['working', 'idle', 'unknown'].includes(session.execution_status)
    && typeof session.recently_active === 'boolean';
}

function sanitizeSession(session) {
  const result = {
    session_id: session.session_id,
    agent_id: session.agent_id,
    recently_active: session.recently_active === true,
    execution_status: ['working', 'idle'].includes(session.execution_status) ? session.execution_status : 'unknown',
  };
  const started = parseTimestamp(session.source_started_at);
  const last = parseTimestamp(session.source_last_activity_at);
  if (started) result.source_started_at = started;
  if (last) result.source_last_activity_at = last;
  if (session.activity_stale === true) result.activity_stale = true;
  if (session.session_kind === 'main' || session.session_kind === 'subagent') result.session_kind = session.session_kind;
  if (UNKNOWN_REASONS.has(session.execution_unknown_reason)) result.execution_unknown_reason = session.execution_unknown_reason;
  if (Number.isSafeInteger(session.historical_active_ms) && session.historical_active_ms >= 0) {
    result.historical_active_ms = session.historical_active_ms;
    if (session.historical_activity_basis === 'magpie_estimated_line_gaps_lt_5m') {
      result.historical_activity_basis = session.historical_activity_basis;
    }
  }
  if (TITLE_SOURCES.has(session.title_source)) {
    result.title_source = session.title_source;
  }
  if (isRecord(session.execution_evidence)
    && ['task_started', 'task_complete', 'turn_aborted'].includes(session.execution_evidence.event)
    && parseTimestamp(session.execution_evidence.occurred_at)
    && /^[a-f0-9]{64}$/.test(session.execution_evidence.turn_hash ?? '')) {
    result.execution_evidence = {
      event: session.execution_evidence.event,
      occurred_at: parseTimestamp(session.execution_evidence.occurred_at),
      turn_hash: session.execution_evidence.turn_hash,
    };
    const lastActivity = parseTimestamp(session.execution_evidence.last_activity_at);
    if (lastActivity) result.execution_evidence.last_activity_at = lastActivity;
  }
  if (typeof session.session_title === 'string') result.session_title = safeSessionTitle(session.session_title);
  if (result.session_title === undefined) delete result.session_title;
  return result;
}

function validState(value) {
  return isRecord(value) && value.schemaVersion === 1 && typeof value.runId === 'string'
    && Number.isSafeInteger(value.tick) && value.tick >= 0
    && Number.isSafeInteger(value.polls) && value.polls >= 0
    && Array.isArray(value.sessions) && value.sessions.length <= MAX_HISTORY_SESSIONS
    && value.sessions.every(validStoredSession)
    && Array.isArray(value.events) && value.events.length <= MAX_EVENTS
    && value.events.every((event) => isRecord(event) && Number.isSafeInteger(event.sequence)
      && event.sequence > 0 && ['session_discovered', 'session_title_updated', 'session_activity_updated'].includes(event.type)
      && typeof event.session_id === 'string' && /^(?:codex:sess:[a-f0-9]{64}|agent_[a-f0-9]{32})$/.test(event.session_id)
      && typeof event.agent_id === 'string' && /^[a-z0-9._-]{1,64}$/.test(event.agent_id)
      && parseTimestamp(event.at)
      && (event.title_source === undefined || event.title_source === null || TITLE_SOURCES.has(event.title_source)));
}

async function openReservation(file) {
  const sqlite = process.versions.bun ? await import('bun:sqlite') : await import('node:sqlite');
  const Db = process.versions.bun ? sqlite.Database : sqlite.DatabaseSync;
  const db = new Db(file, process.versions.bun ? { create: true, readwrite: true } : { timeout: 0 });
  try {
    db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    return () => {
      try { db.exec('ROLLBACK'); } catch { /* Reservation is already gone. */ }
      db.close();
    };
  } catch (error) {
    db.close();
    if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED' || error.errcode === 5 || error.errcode === 6) return null;
    throw error;
  }
}

async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
  try { await rename(temporary, file); } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function loadState(file) {
  let raw;
  let handle;
  try {
    const before = await (await import('node:fs/promises')).lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 16 * 1024 * 1024) throw new Error('magpie_checkpoint_invalid');
    handle = await (await import('node:fs/promises')).open(file, 'r');
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size > 16 * 1024 * 1024) throw new Error('magpie_checkpoint_invalid');
    raw = JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('magpie_checkpoint_unreadable', { cause: error });
  } finally { await handle?.close().catch(() => {}); }
  if (!validState(raw)) throw new Error('magpie_checkpoint_invalid');
  return {
    schemaVersion: 1,
    ownerPid: Number.isSafeInteger(raw.ownerPid) ? raw.ownerPid : 0,
    runId: raw.runId.slice(0, 128),
    tick: raw.tick,
    polls: raw.polls,
    lastPollAt: parseTimestamp(raw.lastPollAt) ?? null,
    snapshot_stale: raw.snapshot_stale === true,
    diagnosticCodes: Array.isArray(raw.diagnosticCodes) ? raw.diagnosticCodes.filter((code) => typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code)).slice(-MAX_DIAGNOSTICS) : [],
    sessions: raw.sessions.map(sanitizeSession),
    events: raw.events.filter(isRecord).map((event) => {
      const safe = { sequence: event.sequence, type: event.type, session_id: event.session_id, agent_id: event.agent_id, at: parseTimestamp(event.at) };
      if (typeof event.session_title === 'string' || event.session_title === null) safe.session_title = safeSessionTitle(event.session_title) ?? null;
      if (TITLE_SOURCES.has(event.title_source) || event.title_source === null) safe.title_source = event.title_source;
      if (typeof event.source_started_at === 'string') safe.source_started_at = parseTimestamp(event.source_started_at);
      if (typeof event.source_last_activity_at === 'string' || event.source_last_activity_at === null) safe.source_last_activity_at = event.source_last_activity_at ? parseTimestamp(event.source_last_activity_at) : null;
      if (typeof event.recently_active === 'boolean') safe.recently_active = event.recently_active;
      if (['working', 'idle', 'unknown'].includes(event.execution_status)) safe.execution_status = event.execution_status;
      if (UNKNOWN_REASONS.has(event.execution_unknown_reason)) safe.execution_unknown_reason = event.execution_unknown_reason;
      if (isRecord(event.execution_evidence)) safe.execution_evidence = sanitizeSession({ ...raw.sessions[0], execution_evidence: event.execution_evidence }).execution_evidence;
      return safe;
    }),
    sourceBook: sanitizeSourceBook(raw.sourceBook),
  };
}

function sanitizeSourceBook(value) {
  if (!isRecord(value)) return {};
  const safe = {};
  for (const [sessionId, source] of Object.entries(value).slice(-MAX_HISTORY_SESSIONS)) {
    if (!/^(?:codex:sess:[a-f0-9]{64}|agent_[a-f0-9]{32})$/.test(sessionId) || !isRecord(source)) continue;
    if (!/^[a-f0-9]{64}$/.test(source.path_hash ?? '') || !/^[a-f0-9]{64}$/.test(source.fingerprint ?? '')
      || !Number.isSafeInteger(source.dev) || !Number.isSafeInteger(source.ino) || !Number.isSafeInteger(source.size)) continue;
    safe[sessionId] = { path_hash: source.path_hash, fingerprint: source.fingerprint, dev: source.dev, ino: source.ino, size: source.size };
  }
  return safe;
}

function safeEvent(type, sequence, session, at, prior) {
  const event = { sequence, type, session_id: session.session_id, agent_id: session.agent_id, at };
  event.recently_active = session.recently_active;
  event.execution_status = session.execution_status;
  if (UNKNOWN_REASONS.has(session.execution_unknown_reason)) event.execution_unknown_reason = session.execution_unknown_reason;
  if (session.source_started_at) event.source_started_at = session.source_started_at;
  if (session.source_last_activity_at) event.source_last_activity_at = session.source_last_activity_at;
  if (session.execution_evidence) event.execution_evidence = session.execution_evidence;
  if (type === 'session_discovered') {
    if (session.session_title) event.session_title = session.session_title;
    if (session.title_source) event.title_source = session.title_source;
    if (session.source_started_at) event.source_started_at = session.source_started_at;
    if (session.source_last_activity_at) event.source_last_activity_at = session.source_last_activity_at;
    return event;
  }
  if (type === 'session_title_updated') {
    event.session_title = session.session_title ?? null;
    event.title_source = session.title_source ?? null;
    return event;
  }
  return event;
}

function safeOptions(options = {}) {
  const limit = options.sessionLimit ?? options.limit ?? 5000;
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeout = options.commandTimeoutMs ?? 30_000;
  const output = options.maxOutputBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error('magpie_invalid_limit');
  if (!Number.isSafeInteger(interval) || interval < 250 || interval > 300_000) throw new Error('magpie_invalid_interval');
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60_000) throw new Error('magpie_invalid_timeout');
  if (!Number.isSafeInteger(output) || output < 1024 || output > 16 * 1024 * 1024) throw new Error('magpie_invalid_output_limit');
  return { ...options, sessionLimit: limit, pollIntervalMs: interval, commandTimeoutMs: timeout, maxOutputBytes: output };
}

export async function startSessionMonitor({ directory, options = {}, env = process.env, now = () => new Date(), waitForInitialPoll = true }) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('directory is required');
  const config = safeOptions(options);
  const root = path.join(directory, 'monitor-sessions');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const statePath = path.join(root, 'state.json');
  const reservationPath = path.join(root, 'lock.db');
  const home = env.HOME || os.homedir();
  const codexRoot = path.resolve(config.codexRoot ?? env.CODEX_HOME ?? path.join(home, '.codex'));
  const cachePath = config.magpieCachePath ?? path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'magpie', 'sessions.json');
  const runId = randomUUID();
  let releaseReservation = await openReservation(reservationPath);
  let role = releaseReservation ? 'writer' : 'standby';
  let state = null;
  let stopped = false;
  let timer;
  let controller;
  let inFlight = Promise.resolve();
  let pollActive;
  let initializing = true;
  let currentError = null;
  const diagnostics = new Set();
  let nextEventSequence = 1;
  let sourceBook = {};
  let relayBridge = null;
  let relayErrorCode;
  let relayInitialized = false;

  const addDiagnostic = (code) => {
    diagnostics.add(code);
    while (diagnostics.size > MAX_DIAGNOSTICS) diagnostics.delete(diagnostics.values().next().value);
  };
  const relayStatus = () => relayBridge?.getStatus()
    ?? { connected: false, pending: 0, last_sequence: 0, ...(relayErrorCode ? { errorCode: relayErrorCode } : {}) };

  const restore = async () => {
    const previous = await loadState(statePath);
    const sessions = (previous?.sessions ?? []).map(sanitizeSession);
    state = {
      schemaVersion: 1, ownerPid: process.pid, runId, tick: previous?.tick ?? 0,
      polls: previous?.polls ?? 0, lastPollAt: previous?.lastPollAt ?? null,
      diagnosticCodes: [...(previous?.diagnosticCodes ?? [])].slice(-MAX_DIAGNOSTICS),
      sessions, events: previous?.events ?? [],
    };
    nextEventSequence = (state.events.at(-1)?.sequence ?? 0) + 1;
    sourceBook = sanitizeSourceBook(previous?.sourceBook);
    for (const code of state.diagnosticCodes) diagnostics.add(code);
  };

  const initializeRelay = async () => {
    if (role !== 'writer' || relayInitialized) return;
    relayInitialized = true;
    try { relayBridge = await startRelayBridge({ directory, configFile: config.relayConfigFile, options: config, env, now }); }
    catch (error) { relayErrorCode = error?.message === 'relay_config_invalid' ? 'relay_config_invalid' : 'relay_bridge_unavailable'; }
  };

  const runPoll = async () => {
    if (stopped) return;
    if (role === 'standby') {
      releaseReservation = await openReservation(reservationPath);
      if (!releaseReservation) return;
      role = 'writer';
      try { await restore(); } catch (error) {
        releaseReservation(); releaseReservation = null; role = 'failed'; currentError = error; addDiagnostic('magpie_checkpoint_invalid'); return;
      }
      await initializeRelay();
    }
    if (role !== 'writer') return;
    controller = new AbortController();
    let candidate;
    const sourceBookCandidate = structuredClone(sourceBook);
    let eventSequenceCandidate = nextEventSequence;
    const at = isoNow(now);
    try {
      const rawSnapshot = await readMagpieSnapshot({
        options: config, env, signal: controller.signal, runner: config.execSnapshot, limit: config.sessionLimit,
      });
      const current = normalizeSnapshot(rawSnapshot)
        .sort((a, b) => (timestampMs(b.source_last_activity_at) ?? 0) - (timestampMs(a.source_last_activity_at) ?? 0))
        .slice(0, config.sessionLimit);
      for (const row of current) row._prior_source = sourceBookCandidate[row.session_id];
      const [nativeTitles, cacheTitles, execution] = await Promise.all([
        readNativeTitles(codexRoot, current),
        readMagpieCache(cachePath, current, home),
        readCodexLifecycle(current, codexRoot, home, now),
      ]);
      const priorById = new Map(state.sessions.map((session) => [session.session_id, session]));
      const outputById = new Map(state.sessions.map((session) => [session.session_id, sanitizeSession(session)]));
      const eventCandidates = [];
      for (const input of current) {
        const prior = priorById.get(input.session_id);
        const output = outputById.get(input.session_id) ?? {
          session_id: input.session_id, agent_id: input.agent_id, recently_active: false, execution_status: 'unknown',
        };
        output.agent_id = input.agent_id;
        if (input.source_started_at) output.source_started_at = input.source_started_at;
        if (input.source_last_activity_at) output.source_last_activity_at = input.source_last_activity_at;
        const lastMs = timestampMs(output.source_last_activity_at);
        output.recently_active = lastMs !== undefined && lastMs <= now().getTime() && now().getTime() - lastMs <= RECENT_ACTIVITY_MS;

        const native = nativeTitles.get(input.session_id);
        const cached = cacheTitles.get(input.session_id);
        const cachedTitle = input.agent_id === 'codex' ? undefined : cached;
        const selected = native ?? cachedTitle;
        if (selected && !(prior?.title_source === 'codex_sqlite' && selected.title_source === 'codex_session_index')) {
          if (selected.title === null) {
            delete output.session_title;
            delete output.title_source;
          } else if (selected.title) {
            output.session_title = selected.title;
            output.title_source = selected.title_source;
          }
        }
        const history = cached;
        if (history?.historical_active_ms !== undefined) {
          output.historical_active_ms = history.historical_active_ms;
          output.historical_activity_basis = history.historical_activity_basis;
        }

        const lifecycle = execution.get(input.session_id);
        const changedSource = lifecycle?.reason === 'source_rewritten';
        if (lifecycle?.session_kind === 'main' || lifecycle?.session_kind === 'subagent') output.session_kind = lifecycle.session_kind;
        else if (changedSource) delete output.session_kind;
        if (lifecycle?._source) sourceBookCandidate[input.session_id] = lifecycle._source;
        if (changedSource) {
          output.execution_status = 'unknown';
          output.activity_stale = true;
          delete output.execution_evidence;
        } else if (lifecycle) {
          output.execution_status = lifecycle.status;
          if (lifecycle.occurred_at && lifecycle.turn_hash) {
            output.execution_evidence = { event: lifecycle.reason, occurred_at: lifecycle.occurred_at, turn_hash: lifecycle.turn_hash };
            if (lifecycle.last_activity_at) output.execution_evidence.last_activity_at = lifecycle.last_activity_at;
          } else delete output.execution_evidence;
          if (lifecycle.reason === 'stale_task_started') output.activity_stale = true;
          else if (lifecycle.status !== 'unknown') delete output.activity_stale;
        } else {
          output.execution_status = 'unknown';
          output.execution_unknown_reason = input.agent_id === 'codex' ? 'source_unavailable' : 'unsupported_agent';
          output.activity_stale = true;
          delete output.execution_evidence;
        }
        if (output.execution_status !== 'unknown') delete output.execution_unknown_reason;
        else if (changedSource) output.execution_unknown_reason = 'source_rewritten';
        else if (lifecycle?.reason === 'poll_budget_exhausted') output.execution_unknown_reason = 'budget_exhausted';
        else if (lifecycle?.reason === 'source_read_failed') output.execution_unknown_reason = 'source_read_failed';
        else if (lifecycle?.reason === 'stale_task_started') output.execution_unknown_reason = 'stale';
        else if (lifecycle?.reason === 'no_verified_lifecycle') output.execution_unknown_reason = 'no_verified_lifecycle';
        outputById.set(input.session_id, output);

        if (!prior) eventCandidates.push(safeEvent('session_discovered', eventSequenceCandidate++, output, at));
        else {
          if ((prior.session_title ?? null) !== (output.session_title ?? null)) {
            eventCandidates.push(safeEvent('session_title_updated', eventSequenceCandidate++, output, at, prior));
          }
          const activityChanged = prior.recently_active !== output.recently_active
            || prior.execution_status !== output.execution_status
            || prior.execution_evidence?.occurred_at !== output.execution_evidence?.occurred_at
            || prior.execution_evidence?.turn_hash !== output.execution_evidence?.turn_hash
            || prior.execution_unknown_reason !== output.execution_unknown_reason
            || prior.source_last_activity_at !== output.source_last_activity_at;
          if (activityChanged) eventCandidates.push(safeEvent('session_activity_updated', eventSequenceCandidate++, output, at, prior));
        }
      }

      // Omitted sessions remain historical, but cannot retain current execution claims.
      const currentIds = new Set(current.map((row) => row.session_id));
      for (const [sessionId, output] of outputById) {
        if (currentIds.has(sessionId)) continue;
        const lastMs = timestampMs(output.source_last_activity_at);
        output.recently_active = lastMs !== undefined && lastMs <= now().getTime() && now().getTime() - lastMs <= RECENT_ACTIVITY_MS;
        const prior = priorById.get(sessionId);
        if (output.execution_status !== 'unknown' || output.execution_unknown_reason !== 'source_unavailable') {
          output.execution_status = 'unknown';
          output.activity_stale = true;
          output.execution_unknown_reason = 'source_unavailable';
          delete output.execution_evidence;
          eventCandidates.push(safeEvent('session_activity_updated', eventSequenceCandidate++, output, at, prior));
        }
      }
      let sessions = [...outputById.values()].map(sanitizeSession);
      sessions.sort((a, b) => (timestampMs(b.source_last_activity_at) ?? 0) - (timestampMs(a.source_last_activity_at) ?? 0));
      sessions = sessions.slice(0, MAX_HISTORY_SESSIONS);
      const events = [...state.events, ...eventCandidates];
      while (events.length > MAX_EVENTS) events.shift();
      candidate = {
        ...state,
        ownerPid: process.pid,
        runId,
        tick: state.tick + 1,
        polls: state.polls + 1,
        lastPollAt: at,
        diagnosticCodes: [...diagnostics].slice(-MAX_DIAGNOSTICS),
        sessions,
        events,
        sourceBook: sourceBookCandidate,
        snapshot_stale: false,
        relay: relayStatus(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const code = controller.signal.aborted ? 'magpie_cli_timeout' : message.startsWith('magpie_snapshot_invalid') || message.startsWith('magpie_sessions_json') ? 'magpie_snapshot_invalid' : 'magpie_poll_failed';
      addDiagnostic(code);
      currentError = error;
      const staleSessions = state.sessions.map((session) => {
        const lastMs = timestampMs(session.source_last_activity_at);
        const recentlyActive = lastMs !== undefined && lastMs <= now().getTime() && now().getTime() - lastMs <= RECENT_ACTIVITY_MS;
        const evidenceAt = timestampMs(session.execution_evidence?.last_activity_at ?? session.execution_evidence?.occurred_at ?? session.source_last_activity_at);
        const unchanged = sanitizeSession({ ...session, recently_active: recentlyActive });
        if (session.execution_status !== 'working' || (!initializing && (evidenceAt === undefined || now().getTime() - evidenceAt <= UNKNOWN_AFTER_MS))) return unchanged;
        const stale = unchanged;
        stale.execution_status = 'unknown';
        stale.activity_stale = true;
        delete stale.execution_evidence;
        return stale;
      });
      candidate = { ...state, ownerPid: process.pid, runId, tick: state.tick + 1, polls: state.polls + 1,
        lastPollAt: at, snapshot_stale: true, diagnosticCodes: [...diagnostics].slice(-MAX_DIAGNOSTICS), sessions: staleSessions, relay: relayStatus() };
    } finally { controller = undefined; }
    if (stopped || !candidate) return;
    try {
      candidate.diagnosticCodes = [...diagnostics].slice(-MAX_DIAGNOSTICS);
      await atomicJson(statePath, candidate);
      state = candidate;
      sourceBook = sourceBookCandidate;
      nextEventSequence = eventSequenceCandidate;
      initializing = false;
      if (relayBridge) {
        try { await relayBridge.ingestSnapshot(candidate); relayErrorCode = undefined; }
        catch { relayErrorCode = 'relay_outbox_write_failed'; }
      }
    } catch (error) {
      currentError = error;
      addDiagnostic('magpie_checkpoint_write_failed');
      role = 'failed';
      releaseReservation?.(); releaseReservation = null;
      throw error;
    }
  };

  const pollOnce = () => {
    if (pollActive) return pollActive;
    const next = runPoll();
    pollActive = next.finally(() => { pollActive = null; });
    inFlight = pollActive.catch((error) => { currentError = error; addDiagnostic('magpie_poll_failed'); });
    return pollActive;
  };
  const schedule = () => {
    if (stopped || role === 'failed') return;
    timer = setTimeout(() => { void pollOnce().catch(() => {}).finally(schedule); }, config.pollIntervalMs);
    timer.unref?.();
  };

  if (role === 'writer') {
    try {
      await restore();
      await initializeRelay();
    } catch (error) {
      releaseReservation?.(); releaseReservation = null; role = 'failed'; throw error;
    }
  }
  else {
    try {
      const previous = await loadState(statePath);
      state = previous ? { ...previous, sessions: previous.sessions.map((session) => ({ ...sanitizeSession(session), execution_status: 'unknown' })) }
        : { schemaVersion: 1, ownerPid: process.pid, runId, tick: 0, polls: 0, lastPollAt: null, diagnosticCodes: [], sessions: [], events: [] };
    } catch (error) { currentError = error; state = { schemaVersion: 1, ownerPid: process.pid, runId, tick: 0, polls: 0, lastPollAt: null, diagnosticCodes: ['magpie_checkpoint_invalid'], sessions: [], events: [] }; }
  }
  const initialPoll = pollOnce();
  if (waitForInitialPoll) await initialPoll;
  else void initialPoll.catch(() => {});
  schedule();
  return {
    pollOnce,
    getState: async () => { await inFlight; return state ? { ...structuredClone(state), relay: relayStatus() } : null; },
    getDiagnostics: () => ({ role, tick: state?.tick ?? 0, polls: state?.polls ?? 0, sessionCount: state?.sessions.length ?? 0, codes: [...diagnostics], errorCode: relayErrorCode ?? (currentError ? 'magpie_internal_error' : undefined), relay: relayBridge?.getStatus() ?? { connected: false, pending: 0, last_sequence: 0 } }),
    async stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      await inFlight;
      await relayBridge?.stop();
      releaseReservation?.(); releaseReservation = null;
    },
  };
}
