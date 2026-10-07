import { createHash } from "node:crypto";
import {
  EVENT_TYPES,
  isWaitingReason,
  type EventType,
  type NormalizedHookEvent,
  type SafeEventPayload,
  type WaitingReason,
} from "./types.js";

/** Keys intentionally ignored even if they appear at the top level. */
export const FORBIDDEN_KEYS = new Set([
  "prompt",
  "prompt_input",
  "user_prompt",
  "tool_input",
  "tool_result",
  "tool_response",
  "result",
  "stdout",
  "stderr",
  "output",
  "error",
  "stack",
  "transcript_path",
  "cwd",
  "workdir",
  "working_directory",
  "path",
  "file_path",
  "absolute_path",
  "env",
  "environment",
  "secret",
  "token",
  "api_key",
  "authorization",
  "password",
  "cookie",
  "command",
  "args",
  "arguments",
]);

const SAFE_TOOL_NAMES = new Map<string, string>([
  ["bash", "Bash"],
  ["read", "Read"],
  ["write", "Write"],
  ["edit", "Edit"],
  ["glob", "Glob"],
  ["grep", "Grep"],
  ["notebookedit", "NotebookEdit"],
  ["webfetch", "WebFetch"],
  ["websearch", "WebSearch"],
  ["task", "Task"],
  ["todowrite", "TodoWrite"],
  ["askuserquestion", "AskUserQuestion"],
  ["exitplanmode", "ExitPlanMode"],
  ["skill", "Skill"],
]);

const EVENT_TYPE_SET = new Set<string>(EVENT_TYPES);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Reserved source namespace used by the local Codex session watcher. */
export const CODEX_ID_PREFIX = "codex:";
const SENSITIVE_ID = /(?:^|[-_.:])(secret|token|password|api[_-]?key|authorization)(?:$|[-_.:])/i;
const SENSITIVE_TITLE = /(?:api[_ -]?key|token|secret|password|authorization)\s*[:=]|\bbearer\s+[A-Za-z0-9._~+/-]{8,}|\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16})/i;
const UNSAFE_TITLE_PATH_OR_URL = /https?:\/\//i;
const SAFE_NONCE = /^[A-Za-z0-9._:-]{1,256}$/;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MIN_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_TIMESTAMP_SKEW_MS = 366 * 24 * 60 * 60 * 1000;

export interface NormalizeOptions {
  now?: Date | (() => Date);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || !SAFE_ID.test(value) || SENSITIVE_ID.test(value)) return undefined;
  return value;
}

function escapeClaudeIdentifier(value: string | undefined, kind: "session" | "task"): string | undefined {
  if (!value?.startsWith(CODEX_ID_PREFIX)) return value;
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return `claude:${kind}:${digest}`;
}

export function safeSessionTitle(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const title = value.trim().replace(/\s+/g, " ");
  if (
    title.length < 1 || title.length > 64 ||
    UNSAFE_TITLE_PATH_OR_URL.test(title) || /[\\/]/.test(title) || SENSITIVE_TITLE.test(title)
  ) return undefined;
  return title;
}

function safeNumber(
  record: Record<string, unknown>,
  keys: string[],
  predicate: (value: number) => boolean,
): number | undefined {
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const value = record[key];
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(number) && predicate(number)) return number;
  }
  return undefined;
}

function currentDate(options?: NormalizeOptions): Date {
  const value = options?.now;
  const date = typeof value === "function" ? value() : value;
  return date instanceof Date && !Number.isNaN(date.valueOf()) ? date : new Date();
}

function safeOccurredAt(record: Record<string, unknown>, now: Date): string {
  const candidate = getString(record, "occurred_at", "occurredAt", "timestamp", "created_at", "createdAt");
  if (!candidate) return now.toISOString();

  const parsed = new Date(candidate);
  const parsedMs = parsed.valueOf();
  const nowMs = now.valueOf();
  if (
    Number.isNaN(parsedMs) ||
    parsedMs < MIN_TIMESTAMP_MS ||
    parsedMs > nowMs + MAX_TIMESTAMP_SKEW_MS
  ) {
    return now.toISOString();
  }
  return parsed.toISOString();
}

function normalizeToolName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const canonical = SAFE_TOOL_NAMES.get(value.toLowerCase());
  if (canonical) return canonical;
  // MCP tool names are metadata only. Collapse the actual server/tool name so
  // it cannot become an accidental data channel.
  if (/^mcp__[A-Za-z0-9_-]{1,120}$/.test(value)) return "mcp";
  return undefined;
}

function waitingReason(record: Record<string, unknown>, payload: Record<string, unknown>): WaitingReason | undefined {
  const hook = getString(record, "hook_event_name", "hookEventName", "event", "name")
    ?.toLowerCase().replace(/[\s_-]+/g, "");
  if (hook === "permissionrequest") return "permission";
  // A canonical event is normalized twice on its way through the Unix socket.
  // Preserve a verified scalar reason without reading any notification text.
  if (isWaitingReason(record.reason)) return record.reason;
  if (isWaitingReason(payload.reason)) return payload.reason;
  if (hook !== "notification") return undefined;
  const notificationType = getString(record, "notification_type", "notificationType");
  if (notificationType === "permission_prompt") return "permission";
  if (["elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"].includes(notificationType ?? "")) {
    return "input";
  }
  return undefined;
}

function deriveEventType(record: Record<string, unknown>): EventType | undefined {
  const direct = getString(record, "event_type", "eventType");
  if (direct && EVENT_TYPE_SET.has(direct)) return direct as EventType;

  const hookName = getString(record, "hook_event_name", "hookEventName", "event", "name");
  if (!hookName) return undefined;
  const normalized = hookName.toLowerCase().replace(/[\s-]+/g, "_");
  const mappings: Record<string, EventType> = {
    sessionstart: "session_started",
    sessionstarted: "session_started",
    session_started: "session_started",
    sessiontitleupdated: "session_title_updated",
    session_title_updated: "session_title_updated",
    sessionend: "session_ended",
    sessionended: "session_ended",
    session_end: "session_ended",
    sessionstop: "session_ended",
    prestop: "task_finished",
    stop: "task_finished",
    stopfailure: "task_failed",
    taskstart: "task_started",
    taskstarted: "task_started",
    task_started: "task_started",
    task_started_hook: "task_started",
    taskend: "task_finished",
    taskended: "task_finished",
    taskfinished: "task_finished",
    task_finished: "task_finished",
    taskfail: "task_failed",
    taskfailed: "task_failed",
    task_failure: "task_failed",
    task_failed: "task_failed",
    waiting: "waiting",
    idle: "waiting",
    pretooluse: "tool_started",
    toolstarted: "tool_started",
    tool_started: "tool_started",
    before_tool: "tool_started",
    posttooluse: "tool_finished",
    toolfinished: "tool_finished",
    tool_finished: "tool_finished",
    after_tool: "tool_finished",
    posttoolusefailure: "tool_failed",
    toolfailed: "tool_failed",
    tool_failed: "tool_failed",
    userpromptsubmit: "task_started",
    notification: "waiting",
    permissionrequest: "waiting",
  };
  return mappings[normalized];
}

/**
 * Return only canonical v1 metadata from a Claude hook event.
 *
 * This is an allowlist, not a scrubber: unrecognized fields are never copied.
 * In particular, prompt/tool input/result/stdout/stderr/path/secret material
 * cannot reach the returned object regardless of their shape or nesting.
 */
export function normalizeHookEvent(
  input: unknown,
  options?: NormalizeOptions,
): NormalizedHookEvent | null {
  const record = asRecord(input);
  if (!record) return null;

  const eventType = deriveEventType(record);
  if (!eventType) return null;

  const now = currentDate(options);
  const rawSessionId = getString(record, "session_id", "sessionId");
  const taskId = escapeClaudeIdentifier(
    safeIdentifier(getString(record, "task_id", "taskId"))
      ?? safeIdentifier(getString(record, "prompt_id", "promptId")),
    "task",
  );
  // Accept only explicit native labels on lifecycle/title metadata events;
  // prompt text, commands and paths are never considered title sources.
  const sessionTitle = ["session_started", "task_started", "task_finished", "session_title_updated"].includes(eventType)
    ? safeSessionTitle(getString(record, "session_title", "sessionTitle"))
    : undefined;
  if (eventType === "session_title_updated" && !sessionTitle) return null;
  const correlationId = safeIdentifier(
    getString(record, "correlation_id", "correlationId", "tool_use_id", "toolUseId"),
  );

  // The hook adapter sends this already-normalized object over the local
  // socket. Read only the same allowlisted scalar fields when they are
  // nested under payload; all other nested data remains ignored.
  const nestedPayload = asRecord(record.payload) ?? {};
  const toolName = normalizeToolName(
    getString(record, "tool_name", "toolName") ?? getString(nestedPayload, "tool_name", "toolName"),
  );
  const duration =
    safeNumber(
      record,
      ["duration_ms", "durationMs"],
      (value) => Number.isInteger(value) && value >= 0 && value <= MAX_DURATION_MS,
    ) ??
    safeNumber(
      nestedPayload,
      ["duration_ms", "durationMs"],
      (value) => Number.isInteger(value) && value >= 0 && value <= MAX_DURATION_MS,
    );
  const exitCode =
    safeNumber(
      record,
      ["exit_code", "exitCode"],
      (value) => Number.isInteger(value) && value >= -255 && value <= 255,
    ) ??
    safeNumber(
      nestedPayload,
      ["exit_code", "exitCode"],
      (value) => Number.isInteger(value) && value >= -255 && value <= 255,
    );

  const payload: SafeEventPayload = {};
  if (toolName) payload.tool_name = toolName;
  if (duration !== undefined) payload.duration_ms = duration;
  if (exitCode !== undefined) payload.exit_code = exitCode;
  if (eventType === "waiting") {
    const reason = waitingReason(record, nestedPayload);
    if (reason !== undefined) payload.reason = reason;
  }

  const safeSession =
    escapeClaudeIdentifier(safeIdentifier(rawSessionId), "session") ?? "unknown";

  return {
    event_type: eventType,
    session_id: safeSession,
    ...(taskId ? { task_id: taskId } : {}),
    ...(sessionTitle ? { session_title: sessionTitle } : {}),
    occurred_at: safeOccurredAt(record, now),
    payload: eventType === "session_title_updated" ? {} : payload,
    ...(correlationId ? { correlation_id: correlationId } : {}),
  };
}

export const sanitizeHookEvent = normalizeHookEvent;
export const normalizeEvent = normalizeHookEvent;

export function isSafeNonce(value: unknown): value is string {
  return typeof value === "string" && SAFE_NONCE.test(value);
}

export function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value) && !SENSITIVE_ID.test(value);
}
