import { createHash } from "node:crypto";
import type { EventType, NormalizedHookEvent, SessionKind } from "./types.js";
import { safeSessionTitle } from "./normalize.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TURN_ID = SESSION_ID;
const MAX_TIMESTAMP_SKEW_MS = 366 * 24 * 60 * 60 * 1000;
const MIN_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const KNOWN_TOP_LEVEL_TYPES = new Set([
  "compacted", "event_msg", "inter_agent_communication_metadata", "realtime_item", "response_item",
  "retained_context", "session_meta", "token_usage_record", "turn_context", "world_state",
]);
const KNOWN_NON_LIFECYCLE_EVENTS = new Set([
  "agent_message", "agent_reasoning", "context_compacted", "item_completed", "mcp_tool_call_end",
  "patch_apply_end", "sub_agent_activity", "thread_goal_updated", "thread_settings_applied", "token_count",
  "user_message", "web_search_end",
]);

export type IgnoredCodexReason = "known_non_lifecycle" | "unknown_shape" | "unsafe_identity";

export type CodexLifecycleRecord =
  | { kind: "session_meta"; sessionHash: string; sessionKind: SessionKind }
  | { kind: "task_started"; sessionHash: string; turnHash: string; occurredAt: string; ordinal?: number }
  | { kind: "task_complete"; sessionHash: string; turnHash: string; occurredAt: string; errorKind: "none" | "server_overloaded" | "unknown"; ordinal?: number }
  | { kind: "turn_aborted"; sessionHash: string; turnHash?: string; occurredAt: string; ordinal?: number }
  | { kind: "ignored"; reason: IgnoredCodexReason; sessionHash?: string; ordinal?: number; invalidSessionMeta?: boolean };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function uuidHash(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value !== "string" || value.length !== 36 || !pattern.test(value)) return undefined;
  return createHash("sha256").update(value.toLowerCase()).digest("hex");
}

export function codexSessionId(sessionHash: string): string {
  return `codex:sess:${sessionHash}`;
}

export function codexTaskId(turnHash: string): string {
  return `codex:turn:${turnHash}`;
}

function occurredAt(row: Record<string, unknown>, payload?: Record<string, unknown>, now = Date.now()): string {
  const raw = row.timestamp;
  let ms = typeof raw === "string" ? Date.parse(raw) : NaN;
  if (!Number.isFinite(ms) && payload) {
    const epochSeconds = payload.started_at ?? payload.completed_at;
    if (typeof epochSeconds === "number" && Number.isFinite(epochSeconds)) ms = epochSeconds * 1000;
  }
  if (!Number.isFinite(ms) || ms < MIN_TIMESTAMP_MS || ms > now + MAX_TIMESTAMP_SKEW_MS) {
    return new Date(now).toISOString();
  }
  return new Date(ms).toISOString();
}

function safeOrdinal(row: Record<string, unknown>): number | undefined {
  return Number.isSafeInteger(row.ordinal) && (row.ordinal as number) >= 0
    ? row.ordinal as number
    : undefined;
}

/** Parse one bounded rollout row into allowlisted lifecycle metadata only. */
export function parseCodexLifecycleLine(line: string, now = Date.now(), currentSessionHash?: string): CodexLifecycleRecord | null {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return null; }
  const row = record(parsed);
  if (!row || typeof row.type !== "string") return null;

  const payload = record(row.payload);
  if (row.type === "session_meta") {
    // `id` is the rollout/thread identity. `session_id` can identify a shared
    // parent process that owns several agent threads, so never prefer it when
    // a thread id is present. A malformed explicit id fails closed instead of
    // merging the record into its parent session.
    const hasThreadId = payload !== undefined && Object.hasOwn(payload, "id");
    const source = record(payload?.source);
    const subagentSource = record(source?.subagent);
    const hasParentThread = payload !== undefined && (
      Object.hasOwn(payload, "parent_thread_id") || payload.thread_source === "subagent" ||
      subagentSource !== undefined || Object.hasOwn(subagentSource ?? {}, "thread_spawn")
    );
    const rawId = hasThreadId ? payload?.id : (hasParentThread ? undefined : payload?.session_id);
    const sessionHash = uuidHash(rawId, SESSION_ID);
    const sessionKind: SessionKind = payload?.thread_source === "subagent" ||
      (typeof source?.subagent === "string" && ["review", "compact", "other"].includes(source.subagent)) ||
      (subagentSource !== undefined && (
        record(subagentSource.thread_spawn) !== undefined ||
        // Codex also serializes its Other(String) subagent variant as an
        // externally tagged object, including guardian-review threads.
        (typeof subagentSource.other === "string" && subagentSource.other.length > 0)
      ))
      ? "subagent" : "main";
    return sessionHash ? { kind: "session_meta", sessionHash, sessionKind } : { kind: "ignored", reason: "unsafe_identity", invalidSessionMeta: true };
  }
  if (!KNOWN_TOP_LEVEL_TYPES.has(row.type)) return { kind: "ignored", reason: "unknown_shape" };
  if (row.type !== "event_msg") return { kind: "ignored", reason: "known_non_lifecycle" };
  if (!payload || typeof payload.type !== "string") return { kind: "ignored", reason: "unknown_shape" };

  const type = payload.type;
  if (type !== "task_started" && type !== "task_complete" && type !== "turn_aborted") {
    return {
      kind: "ignored",
      reason: KNOWN_NON_LIFECYCLE_EVENTS.has(type) ? "known_non_lifecycle" : "unknown_shape",
      ordinal: safeOrdinal(row),
    };
  }

  // Lifecycle records inherit the verified thread identity from this rollout's
  // session_meta row; a repeated session_id may name a shared parent process.
  // Metadata-selected rollout identity takes precedence. Some event rows
  // repeat a parent session_id shared by subagent threads.
  const sessionHash = currentSessionHash;
  const rawTurnId = payload.turn_id;
  const turnHash = uuidHash(rawTurnId, TURN_ID);
  const timestamp = occurredAt(row, payload, now);
  const ordinal = safeOrdinal(row);

  if (type === "turn_aborted") {
    return sessionHash
      ? { kind: type, sessionHash, ...(turnHash ? { turnHash } : {}), occurredAt: timestamp, ...(ordinal !== undefined ? { ordinal } : {}) }
      : { kind: "ignored", reason: "unsafe_identity", ...(ordinal !== undefined ? { ordinal } : {}) };
  }
  if (!turnHash) return { kind: "ignored", reason: "unsafe_identity", ...(sessionHash ? { sessionHash } : {}), ...(ordinal !== undefined ? { ordinal } : {}) };

  if (!sessionHash) return { kind: "ignored", reason: "unsafe_identity", ...(ordinal !== undefined ? { ordinal } : {}) };
  const common = { sessionHash, turnHash, occurredAt: timestamp, ...(ordinal !== undefined ? { ordinal } : {}) };
  if (type === "task_started") {
    return { kind: type, ...common };
  }

  let errorKind: "none" | "server_overloaded" | "unknown" = "none";
  if (Object.hasOwn(payload, "error") && payload.error !== null) {
    const error = record(payload.error);
    errorKind = error?.codex_error_info === "server_overloaded" ? "server_overloaded" : "unknown";
  }
  return { kind: type, ...common, errorKind };
}

export function codexEvent(
  event_type: EventType,
  sessionHash: string,
  turnHash: string | undefined,
  occurred_at: string,
  sessionStarted = false,
  nativeTitle?: string,
  sessionKind?: SessionKind,
): NormalizedHookEvent {
  return {
    event_type,
    ...(sessionKind ? { session_kind: sessionKind } : {}),
    session_id: codexSessionId(sessionHash),
    ...(turnHash ? { task_id: codexTaskId(turnHash) } : {}),
    ...(["session_started", "task_started", "task_finished", "session_title_updated"].includes(event_type)
      ? { session_title: safeSessionTitle(nativeTitle) ?? `Codex ${sessionHash.slice(-6)}` } : {}),
    occurred_at,
    payload: {},
  };
}
