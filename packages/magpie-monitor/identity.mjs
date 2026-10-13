import { createHash } from 'node:crypto';

const AGENT_ID = /^[a-z0-9._-]{1,64}$/;
const CODEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENSITIVE_TITLE = /(?:api[_ -]?key|token|secret|password|authorization)\s*[:=]|\bbearer\s+[A-Za-z0-9._~+/-]{8,}|\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16})/i;

export function safeAgentId(value) {
  if (typeof value !== 'string' || !AGENT_ID.test(value)) return undefined;
  return ['claude', 'claude-code', 'claude_code'].includes(value) ? 'claude_code' : value;
}

export function agentSessionId(agentId, rawId) {
  const canonical = safeAgentId(agentId);
  if (!canonical || typeof rawId !== 'string' || !rawId || rawId.length > 512) return undefined;
  if (canonical === 'codex' && CODEX_UUID.test(rawId)) {
    return `codex:sess:${createHash('sha256').update(rawId.toLowerCase()).digest('hex')}`;
  }
  return `agent_${createHash('sha256').update(`${canonical}:${rawId}`).digest('hex').slice(0, 32)}`;
}

export function codexUuid(value) {
  return typeof value === 'string' && CODEX_UUID.test(value) ? value.toLowerCase() : undefined;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function safeSessionTitle(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const title = value.trim().replace(/\s+/g, ' ');
  if (!title || [...title].length > 64 || /https?:\/\//i.test(title)
    || /[\\/]/.test(title) || SENSITIVE_TITLE.test(title)) return undefined;
  return title;
}

export function parseTimestamp(value) {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

export function normalizeSnapshot(value) {
  if (!Array.isArray(value)) throw new Error('magpie_sessions_json_not_array');
  const sessions = [];
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const agentId = safeAgentId(row.agent);
    const rawId = typeof row.id === 'string' ? row.id.trim() : '';
    const sessionId = agentSessionId(agentId, rawId);
    if (!sessionId) continue;
    const session = { session_id: sessionId, agent_id: agentId, _raw_id: rawId };
    const started = parseTimestamp(row.start);
    const last = parseTimestamp(row.last);
    if (started) session.source_started_at = started;
    if (last) session.source_last_activity_at = last;
    if (typeof row.path === 'string' && row.path.length <= 4096) session._source_path = row.path;
    sessions.push(session);
  }
  return sessions;
}
