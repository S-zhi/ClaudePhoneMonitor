import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { codexUuid, sha256 } from './identity.mjs';

const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 2048;
const STALE_AFTER_MS = 30 * 60 * 1000;

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function sessionKindFromMeta(payload) {
  const source = payload?.source;
  const threadSource = payload?.thread_source;
  const parent = payload?.parent_thread_id ?? payload?.parent_id;
  if (['subagent', 'guardian_review', 'compact', 'review', 'other'].includes(threadSource)
    || object(source?.subagent) || codexUuid(parent)) return 'subagent';
  if (['user', 'main'].includes(threadSource) && ['vscode', 'cli'].includes(source)) return 'main';
  return undefined;
}

function parseRows(bytes, rawId, nowMs, initiallyVerified = false, initialSessionKind) {
  const lines = bytes.toString('utf8').split('\n');
  if (lines.some((line) => Buffer.byteLength(line) > MAX_LINE_BYTES)) return { status: 'unknown', reason: 'oversized_row' };
  const id = codexUuid(rawId);
  if (!id) return { status: 'unknown', reason: 'unsafe_identity' };
  let verified = initiallyVerified;
  let sessionKind = initialSessionKind;
  let currentTurn;
  let currentTurnAt;
  let currentTurnActivityAt;
  let result = { status: 'unknown', reason: 'no_verified_lifecycle' };
  let lastOrdinal = -1;
  for (const line of lines) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!object(row)) continue;
    const payload = object(row.payload) ? row.payload : undefined;
    if (row.type === 'session_meta') {
      const nativeId = codexUuid(payload?.id ?? payload?.session_id);
      verified = nativeId === id;
      sessionKind = verified ? sessionKindFromMeta(payload) : undefined;
      currentTurn = undefined;
      currentTurnAt = undefined;
      currentTurnActivityAt = undefined;
      result = { status: 'unknown', reason: verified ? 'no_verified_lifecycle' : 'identity_mismatch' };
      continue;
    }
    if (!verified) continue;
    const timestamp = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    if (currentTurn && ['response_item', 'event_msg', 'turn_context', 'token_usage_record'].includes(row.type)
      && Number.isFinite(timestamp) && timestamp >= currentTurnAt && timestamp <= nowMs) {
      currentTurnActivityAt = Math.max(currentTurnActivityAt ?? currentTurnAt, timestamp);
    }
    if (row.type !== 'event_msg' || !payload) continue;
    if (Number.isSafeInteger(row.ordinal)) {
      if (row.ordinal <= lastOrdinal) continue;
      lastOrdinal = row.ordinal;
    }
    const type = payload.type;
    const turn = codexUuid(payload.turn_id);
    const hasTurnId = Object.hasOwn(payload, 'turn_id');
    if (type === 'task_started') {
      if (!turn) continue;
      currentTurn = turn;
      currentTurnAt = Number.isFinite(timestamp) ? timestamp : undefined;
      currentTurnActivityAt = Number.isFinite(timestamp) && timestamp <= nowMs ? timestamp : undefined;
      if (Number.isFinite(timestamp)) {
        const age = nowMs - timestamp;
        result = age >= 0 && age <= STALE_AFTER_MS
          ? { status: 'working', reason: 'task_started', occurred_at: new Date(timestamp).toISOString(), turn_hash: sha256(turn) }
          : { status: 'unknown', reason: 'stale_task_started', occurred_at: new Date(timestamp).toISOString(), turn_hash: sha256(turn) };
      } else {
        result = { status: 'unknown', reason: 'invalid_timestamp' };
      }
    } else if (type === 'task_complete' && turn && currentTurn === turn
      && Number.isFinite(timestamp) && (currentTurnAt === undefined || timestamp >= currentTurnAt)) {
      currentTurn = undefined;
      currentTurnAt = undefined;
      currentTurnActivityAt = undefined;
      result = Number.isFinite(timestamp)
        ? { status: 'idle', reason: 'task_complete', occurred_at: new Date(timestamp).toISOString(), turn_hash: sha256(turn) }
        : { status: 'unknown', reason: 'invalid_timestamp' };
    } else if (type === 'turn_aborted' && currentTurn && (!hasTurnId || (turn && currentTurn === turn))
      && Number.isFinite(timestamp) && (currentTurnAt === undefined || timestamp >= currentTurnAt)) {
      const abortedTurn = currentTurn;
      currentTurn = undefined;
      currentTurnAt = undefined;
      currentTurnActivityAt = undefined;
      result = Number.isFinite(timestamp)
        ? { status: 'idle', reason: 'turn_aborted', occurred_at: new Date(timestamp).toISOString(), turn_hash: sha256(abortedTurn) }
        : { status: 'unknown', reason: 'invalid_timestamp' };
    }
  }
  if (currentTurn && ['working', 'unknown'].includes(result.status) && result.turn_hash === sha256(currentTurn)) {
    const activityAt = currentTurnActivityAt ?? currentTurnAt;
    const fresh = activityAt !== undefined && activityAt <= nowMs && nowMs - activityAt <= STALE_AFTER_MS;
    result = {
      ...result,
      status: fresh ? 'working' : 'unknown',
      reason: fresh ? 'task_started' : 'stale_task_started',
      last_activity_at: activityAt === undefined ? undefined : new Date(activityAt).toISOString(),
    };
  }
  return { ...result, ...(verified && sessionKind ? { session_kind: sessionKind } : {}) };
}

function expandHome(value, home) {
  if (value === '~') return home;
  return value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
}

async function secureStat(file, sessionsRoot) {
  const resolved = path.resolve(file);
  const rel = path.relative(sessionsRoot, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  let current = sessionsRoot;
  const rootStat = await fs.lstat(current).catch(() => undefined);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return undefined;
  const parts = rel.split(path.sep);
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    const info = await fs.lstat(current).catch(() => undefined);
    if (!info || info.isSymbolicLink()) return undefined;
    if (i < parts.length - 1 && !info.isDirectory()) return undefined;
    if (i === parts.length - 1 && !info.isFile()) return undefined;
  }
  return fs.lstat(resolved);
}

async function readLifecycleFile(file, root, rawId, nowMs, budget) {
  const info = await secureStat(file, path.join(root, 'sessions'));
  if (!info || !path.basename(file).startsWith('rollout-') || !file.endsWith('.jsonl') || info.size > MAX_FILE_BYTES) {
    return { result: { status: 'unknown', reason: 'unsafe_or_oversized_file' } };
  }
  const amount = Math.min(info.size, MAX_HEAD_BYTES + MAX_TAIL_BYTES);
  if (budget.used + amount > MAX_TOTAL_BYTES || budget.files >= MAX_FILES) {
    return { result: { status: 'unknown', reason: 'poll_budget_exhausted' } };
  }
  budget.used += amount;
  budget.files += 1;
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino || !opened.isFile()) {
      return { result: { status: 'unknown', reason: 'file_changed_during_read' }, info: opened };
    }
    let bytes;
    let parsed;
    if (opened.size <= MAX_TAIL_BYTES) {
      bytes = Buffer.alloc(opened.size);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      bytes = bytes.subarray(0, bytesRead);
      parsed = parseRows(bytes, rawId, nowMs);
    } else {
      const head = Buffer.alloc(Math.min(MAX_HEAD_BYTES, opened.size));
      const tail = Buffer.alloc(Math.min(MAX_TAIL_BYTES, opened.size));
      const first = await handle.read(head, 0, head.length, 0);
      const last = await handle.read(tail, 0, tail.length, Math.max(0, opened.size - tail.length));
      let headPart = head.subarray(0, first.bytesRead);
      const lastHeadNewline = headPart.lastIndexOf(0x0a);
      headPart = lastHeadNewline < 0 ? Buffer.alloc(0) : headPart.subarray(0, lastHeadNewline + 1);
      let tailPart = tail.subarray(0, last.bytesRead);
      const firstTailNewline = tailPart.indexOf(0x0a);
      tailPart = firstTailNewline < 0 ? Buffer.alloc(0) : tailPart.subarray(firstTailNewline + 1);
      bytes = Buffer.concat([headPart, Buffer.from('\n'), tailPart]);
      const verifiedHead = headPart.toString('utf8').split('\n').some((line) => {
        try {
          const row = JSON.parse(line);
          const nativeId = row?.type === 'session_meta' && (row.payload?.id ?? row.payload?.session_id);
          if (codexUuid(nativeId) !== codexUuid(rawId)) return false;
          parsed = { session_kind: sessionKindFromMeta(row.payload) };
          return true;
        } catch { return false; }
      });
      parsed = verifiedHead ? parseRows(tailPart, rawId, nowMs, true, parsed.session_kind)
        : { status: 'unknown', reason: 'session_meta_unverified' };
    }
    const source = { path_hash: sha256(file), dev: opened.dev, ino: opened.ino, size: opened.size, fingerprint: sha256(bytes) };
    return { result: { ...parsed, _source: source }, info: opened, fingerprint: source.fingerprint };
  } catch { return { result: { status: 'unknown', reason: 'source_read_failed' }, info }; }
  finally { await handle?.close().catch(() => {}); }
}

export async function readCodexLifecycle(sessions, codexRoot, home, now) {
  const output = new Map();
  const budget = { used: 0, files: 0 };
  const nowMs = now().getTime();
  for (const session of sessions) {
    if (session.agent_id !== 'codex' || !session._raw_id || !session._source_path) continue;
    const fullPath = path.resolve(expandHome(session._source_path, home));
    const sessionsRoot = path.resolve(codexRoot, 'sessions');
    const relative = path.relative(sessionsRoot, fullPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      output.set(session.session_id, { status: 'unknown', reason: 'path_outside_codex_sessions' });
      continue;
    }
    const result = await readLifecycleFile(fullPath, codexRoot, session._raw_id, nowMs, budget);
    const priorSource = session._prior_source;
    const source = result.result._source;
    if (source && priorSource && (source.path_hash !== priorSource.path_hash || source.dev !== priorSource.dev
      || source.ino !== priorSource.ino || source.size < priorSource.size
      || (source.size === priorSource.size && source.fingerprint !== priorSource.fingerprint))) {
      output.set(session.session_id, { status: 'unknown', reason: 'source_rewritten', _source: source });
    } else output.set(session.session_id, result.result);
  }
  return output;
}

export const LIFECYCLE_LIMITS = Object.freeze({ MAX_FILE_BYTES, MAX_TAIL_BYTES, MAX_HEAD_BYTES, MAX_LINE_BYTES, MAX_TOTAL_BYTES, STALE_AFTER_MS });
