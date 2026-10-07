import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ClaudeState,
  ConnectionRecord,
  ConnectionStatus,
  DeviceTokenRecord,
  EventEnvelope,
  InstallationState,
  SessionSummary,
  SessionKind,
  RecentCompletion,
  PairingCreateInput,
  PairingRecord,
  SequenceStatus,
  StoredEvent,
  TokenRole,
  TokenValidation,
  UsageAggregate,
  UsageSnapshotMessage,
  ApprovalSummary,
  BlockingWaitingReason,
} from "./types.js";
import { isConnectionStatus } from "./types.js";

export interface RecordEventResult {
  stored: StoredEvent;
  duplicate: boolean;
  conflict: boolean;
  /** Frontend presentation eligibility, independent of legacy installation-state updates. */
  activity_applied: boolean;
  sequence_status: SequenceStatus;
  last_sequence: number | null;
  next_sequence: number | null;
}

export interface RecordUsageResult {
  duplicate: boolean;
  conflict: boolean;
  changed: boolean;
  sequence_status: SequenceStatus;
  last_sequence: number | null;
  next_sequence: number | null;
}

export interface CreateDeviceTokenInput {
  token_id?: string;
  role: TokenRole;
  installation_id: string;
  token: string;
  issued_at: string;
  expires_at?: string;
  device_name?: string;
}

export interface RelayRepository {
  registerConnection(input: {
    connection_id: string;
    gateway: ConnectionRecord["gateway"];
    client_id: string;
    installation_id?: string;
    connected_at: string;
  }): ConnectionRecord;
  updateConnectionIdentity(
    connectionId: string,
    identity: { client_id?: string; installation_id?: string },
  ): ConnectionRecord | undefined;
  touchConnection(connectionId: string, seenAt: string): ConnectionRecord | undefined;
  disconnectConnection(connectionId: string, disconnectedAt: string): ConnectionRecord | undefined;
  getConnection(connectionId: string): ConnectionRecord | undefined;
  listConnections(): ConnectionRecord[];
  refreshConnectionStatuses(
    now: string,
    staleAfterMs: number,
    offlineAfterMs: number,
  ): boolean;
  connectionStatusForInstallation(installationId: string): ConnectionStatus;

  findEvent(eventId: string): StoredEvent | undefined;
  recordEvent(event: EventEnvelope, receivedAt: string): RecordEventResult;
  recordUsageSnapshot(message: UsageSnapshotMessage, receivedAt: string): RecordUsageResult;
  listEventsAfter(installationId: string, sequence: number): StoredEvent[];
  listInstallationIds(): string[];
  getInstallationState(installationId: string, now?: string): InstallationState | undefined;
  listApprovals(installationId: string): ApprovalSummary[];
  putApproval(installationId: string, approval: ApprovalSummary): void;

  createPairing(
    now: string,
    ttlMs: number,
    input?: PairingCreateInput,
  ): PairingRecord;
  getPairing(pairingId: string, now: string): PairingRecord | undefined;
  claimPairing(pairingId: string, code: string, now: string, deviceName?: string): boolean;
  attachAndroidToken(
    pairingId: string,
    tokenHash: string,
    deviceName?: string,
    claimedAt?: string,
  ): PairingRecord | undefined;

  createDeviceToken(input: CreateDeviceTokenInput): DeviceTokenRecord;
  validateToken(token: string, role: TokenRole, now: string): TokenValidation | undefined;
  isTokenActive(tokenId: string, role: TokenRole, installationId: string, now: string): boolean;
  revokeToken(tokenId: string, revokedAt: string): boolean;

  /** A stable label used by health/readiness reporting. */
  readonly storageKind?: "memory" | "sqlite";
  close?(): void;
}

interface SessionState {
  session_kind?: SessionKind;
  installation_id: string;
  session_id: string;
  title?: string;
  claude_state: ClaudeState;
  waiting_reason?: BlockingWaitingReason;
  waiting_correlation_id?: string;
  waiting_tool_name?: string;
  last_sequence: number;
  /** Activity ordering is independent of the accepted event watermark. */
  last_activity_sequence?: number;
  last_activity_at: string;
  updated_at: string;
  task_id?: string;
  /** Only an observed task_started establishes a timing origin. */
  task_started_at?: string;
  ended: boolean;
  /** Task completion is terminal until a newer task starts, even after recent_completion expires. */
  terminalTask?: boolean;
  completion?: RecentCompletion;
}

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const COMPLETION_TTL_MS = 5_000;
const MAX_TASK_DURATION_MS = 86_400_000;

function taskTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!parts) return undefined;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined) return undefined;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (daysInMonth === undefined || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function taskDuration(previous: SessionState | undefined, event: EventEnvelope): number | undefined {
  if (event.session_id === "unknown" ||
      (event.event_type !== "task_finished" && event.event_type !== "task_failed") ||
      previous?.ended || (previous?.terminalTask ?? Boolean(previous?.completion)) ||
      (previous && event.sequence <= previous.last_sequence) ||
      (event.task_id && previous?.task_id && event.task_id !== previous.task_id)) return undefined;
  const start = taskTimestamp(previous?.task_started_at);
  if (start !== undefined) {
    const end = taskTimestamp(event.occurred_at);
    if (end === undefined || end < start) return undefined;
    return Math.min(end - start, MAX_TASK_DURATION_MS);
  }
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return undefined;
  const duration = (event.payload as Record<string, unknown>).duration_ms;
  return typeof duration === "number" && Number.isSafeInteger(duration) && duration >= 0 && duration <= MAX_TASK_DURATION_MS
    ? duration : undefined;
}

function eventWithTaskDuration(previous: SessionState | undefined, event: EventEnvelope): EventEnvelope {
  if (event.event_type !== "task_finished" && event.event_type !== "task_failed") return event;
  const duration = taskDuration(previous, event);
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? { ...event.payload as Record<string, unknown> } : {};
  delete payload.duration_ms;
  if (duration !== undefined) payload.duration_ms = duration;
  return { ...event, payload };
}

function sessionDisplayName(record: SessionState): string {
  const codexHash = /^codex:sess:([0-9a-f]{64})$/.exec(record.session_id)?.[1];
  if (codexHash && (!record.title || record.title === "Codex")) return `Codex ${codexHash.slice(-6)}`;
  if (record.title) return record.title;
  const suffix = createHash("sha256").update(record.session_id).digest("hex").slice(-6);
  return `会话 ${suffix}`;
}

function canUpdateSessionTitle(previous: SessionState | undefined, event: EventEnvelope): boolean {
  const knownTaskId = previous?.task_id ?? previous?.completion?.task_id;
  return Boolean(previous && event.event_type === "session_title_updated" && event.session_title &&
    event.sequence > previous.last_sequence &&
    !(event.task_id && knownTaskId && event.task_id !== knownTaskId));
}

function applySessionEvent(
  previous: SessionState | undefined,
  event: EventEnvelope,
  now = event.occurred_at,
): SessionState | undefined {
  if (event.session_id === "unknown") return previous;
  // Approval history is a separate surface and cannot reorder activity or
  // reopen a completed task when a late decision arrives.
  if (event.event_type === "approval_requested" || event.event_type === "approval_resolved") return previous;
  if (!previous && event.event_type === "session_title_updated") return undefined;
  if (
    previous &&
    event.sequence <= previous.last_sequence
  ) {
    return previous;
  }
  const next: SessionState = previous ? { ...previous } : {
    installation_id: event.installation_id,
    session_id: event.session_id,
    claude_state: "idle",
    last_sequence: -1,
    last_activity_sequence: -1,
    last_activity_at: event.event_type === "session_classification_updated" ? "1970-01-01T00:00:00.000Z" : event.occurred_at,
    updated_at: event.event_type === "session_classification_updated" ? "1970-01-01T00:00:00.000Z" : event.occurred_at,
    ended: false,
  };
  next.last_activity_sequence ??= next.last_sequence;
  next.last_sequence = event.sequence;
  next.session_kind = previous?.session_kind === "subagent" ? "subagent" : event.session_kind ?? previous?.session_kind ?? "main";
  if (event.event_type === "session_classification_updated") return next;
  if (event.event_type === "session_title_updated") {
    if (!canUpdateSessionTitle(previous, event)) return next;
    next.title = event.session_title;
    if (next.completion && (next.terminalTask ?? Boolean(next.completion)) &&
        Date.parse(now) - Date.parse(next.completion.occurred_at) <= COMPLETION_TTL_MS) {
      next.completion = { ...next.completion, display_name: sessionDisplayName(next) };
    }
    return next;
  }
  const taskTail = ["tool_started", "tool_finished", "tool_failed", "waiting", "task_finished", "task_failed"].includes(event.event_type);
  if (
    (next.ended && event.event_type !== "session_started") ||
    (taskTail && (
      Boolean(event.task_id && next.task_id && event.task_id !== next.task_id) ||
      (next.terminalTask ?? Boolean(next.completion))
    ))
  ) return next;
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown> : {};
  const waitingReason = ["permission", "question", "approval", "input"].includes(String(payload.reason))
    ? payload.reason as BlockingWaitingReason : undefined;
  const toolName = typeof payload.tool_name === "string" && /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/.test(payload.tool_name)
    ? payload.tool_name : undefined;
  if (next.claude_state === "waiting" && next.waiting_reason) {
    const bound = Boolean(next.waiting_correlation_id || next.waiting_tool_name);
    const matchingTool = next.waiting_correlation_id
      ? event.correlation_id === next.waiting_correlation_id
      : next.waiting_tool_name ? toolName === next.waiting_tool_name : true;
    const toolActivity = ["tool_started", "tool_finished", "tool_failed"].includes(event.event_type);
    const sameWaiting = event.event_type === "waiting" && waitingReason === next.waiting_reason &&
      (!event.correlation_id || event.correlation_id === next.waiting_correlation_id) &&
      (!toolName || toolName === next.waiting_tool_name);
    const preserveWaiting = (toolActivity && (!bound || event.event_type === "tool_started" || !matchingTool)) ||
      (event.event_type === "waiting" && (!waitingReason || sameWaiting || (!toolName && bound))) ||
      (event.event_type === "task_started" && Boolean(event.task_id && event.task_id === next.task_id));
    if (preserveWaiting) {
      // An unrelated parallel tool, a generic notification, or a repeated
      // permission hook cannot prove that this question was answered. Keep
      // the original activity sequence so reconnect does not create a new wait.
      if (event.event_type === "waiting" && waitingReason) next.last_activity_at = event.occurred_at;
      return next;
    }
  }
  next.waiting_reason = undefined;
  next.waiting_correlation_id = undefined;
  next.waiting_tool_name = undefined;
  next.last_activity_sequence = event.sequence;
  next.updated_at = event.occurred_at;
  next.last_activity_at = event.occurred_at;
  if (["session_started", "task_started", "task_finished"].includes(event.event_type) && event.session_title) {
    next.title = event.session_title;
  }
  switch (event.event_type) {
    case "session_started":
      next.claude_state = "idle";
      next.ended = false;
      next.task_id = undefined;
      next.task_started_at = undefined;
      next.terminalTask = false;
      next.completion = undefined;
      break;
    case "task_started":
      next.claude_state = "working";
      // Repeated starts for the same explicit task must not shorten its age.
      if (!(event.task_id && next.task_id === event.task_id && next.task_started_at && !next.terminalTask)) {
        next.task_started_at = taskTimestamp(event.occurred_at) !== undefined ? event.occurred_at : undefined;
      }
      next.task_id = event.task_id;
      next.terminalTask = false;
      next.completion = undefined;
      break;
    case "tool_started":
      if (event.task_id && next.task_id && event.task_id !== next.task_id) break;
      if (next.terminalTask ?? Boolean(next.completion)) break;
      next.claude_state = "working";
      break;
    case "waiting":
      next.claude_state = "waiting";
      next.waiting_reason = waitingReason;
      if (waitingReason) {
        next.waiting_correlation_id = event.correlation_id;
        next.waiting_tool_name = toolName;
      }
      break;
    case "tool_finished":
      if (event.task_id && next.task_id && event.task_id !== next.task_id) break;
      if (next.terminalTask ?? Boolean(next.completion)) break;
      next.claude_state = "working";
      break;
    case "task_finished":
    case "task_failed": {
      const staleTaskFinish = Boolean(
        event.task_id && next.task_id && event.task_id !== next.task_id,
      );
      if (!staleTaskFinish) {
        const completedTaskId = event.task_id ?? next.task_id;
        const duration = taskDuration(previous, event);
        next.claude_state = "idle";
        next.task_id = undefined;
        next.task_started_at = undefined;
        next.terminalTask = true;
        if (event.event_type === "task_finished") {
          next.completion = {
            session_id: event.session_id,
            ...(completedTaskId ? { task_id: completedTaskId } : {}),
            sequence: event.sequence,
            occurred_at: event.occurred_at,
            display_name: sessionDisplayName(next),
            ...(duration !== undefined ? { duration_ms: duration } : {}),
          };
        } else {
          next.completion = undefined;
        }
      }
      break;
    }
    case "session_ended":
      next.ended = true;
      next.claude_state = "idle";
      next.task_id = undefined;
      next.task_started_at = undefined;
      break;
    case "tool_failed":
      if (event.task_id && next.task_id && event.task_id !== next.task_id) break;
      next.claude_state = "idle";
      break;
  }
  return next;
}

function aggregatedState(
  records: SessionState[],
  now: string,
): Pick<
  InstallationState,
  "claude_state" | "sessions" | "running_count" | "session_count" | "recent_completion" | "active_tasks" | "main_running_count" | "main_session_count" | "total_running_count"
> {
  const nowMs = Date.parse(now);
  const allActive = records.filter((record) => !record.ended && nowMs - Date.parse(record.last_activity_at) < SESSION_TTL_MS);
  const active = allActive.filter((record) => record.session_kind !== "subagent");
  const ordered = active.sort((a, b) =>
    (b.last_activity_sequence ?? b.last_sequence) - (a.last_activity_sequence ?? a.last_sequence) ||
    (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0),
  );
  const working = active.some((record) => record.claude_state === "working");
  const mostRecent = ordered[0];
  const completion = records
    .filter((record) => record.session_kind !== "subagent")
    .map((record) => record.completion)
    .filter(
      (item): item is RecentCompletion =>
        item !== undefined && nowMs - Date.parse(item.occurred_at) <= COMPLETION_TTL_MS,
    )
    .sort((a, b) => b.sequence - a.sequence)[0];
  return {
    claude_state: working ? "working" : mostRecent?.claude_state ?? "idle",
    sessions: ordered.slice(0, 5).map((record) => ({
      session_id: record.session_id,
      session_kind: record.session_kind ?? "main",
      title: sessionDisplayName(record),
      claude_state: record.claude_state,
      task_completed: record.claude_state === "idle" && Boolean(record.completion) && (record.terminalTask ?? true),
      ...(record.claude_state === "waiting" && ["permission", "question", "approval", "input"].includes(String(record.waiting_reason))
        ? { waiting_reason: record.waiting_reason } : {}),
      last_activity_sequence: record.last_activity_sequence ?? record.last_sequence,
    })),
    main_running_count: active.filter((record) => record.claude_state === "working").length,
    main_session_count: active.length,
    total_running_count: allActive.filter((record) => record.claude_state === "working").length,
    running_count: active.filter((record) => record.claude_state === "working").length,
    session_count: active.length,
    active_tasks: ordered.flatMap((record) => {
      const start = taskTimestamp(record.task_started_at);
      if (!record.task_started_at || (record.terminalTask ?? Boolean(record.completion)) || start === undefined || !Number.isSafeInteger(nowMs)) return [];
      return [{
        session_id: record.session_id,
        ...(record.task_id ? { task_id: record.task_id } : {}),
        started_at: record.task_started_at,
        elapsed_ms: Math.min(MAX_TASK_DURATION_MS, Math.max(0, nowMs - start)),
      }];
    }),
    ...(completion ? { recent_completion: completion } : {}),
  };
}

function presentInstallationState(state: InstallationState, records: SessionState[], now: string): InstallationState {
  if (!records.length) return { ...state, active_tasks: [], main_running_count: 0, main_session_count: 0, total_running_count: 0, running_count: 0, session_count: 0 };
  const next = { ...state, ...aggregatedState(records, now) };
  if (typeof next.activity === "object" && records.some((record) =>
      record.session_id === next.activity?.session_id && record.session_kind === "subagent")) {
    delete next.activity;
  }
  return next;
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function opaqueTokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOpaqueToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createOpaqueToken(prefix: "col" | "and" = "col"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isNewerUsage(previous: UsageAggregate | undefined, incoming: UsageAggregate): boolean {
  if (!previous) return true;
  return previous.epoch_id === incoming.epoch_id &&
    previous.started_at === incoming.started_at &&
    incoming.revision > previous.revision;
}

function sequenceStatusForSequence(sequence: number, previous: number | null): SequenceStatus {
  if (previous === null) return "initial";
  if (sequence === previous + 1) return "in_order";
  if (sequence > previous + 1) return "gap";
  return "out_of_order";
}

function stateForEvent(eventType: EventEnvelope["event_type"], previous: ClaudeState): ClaudeState {
  switch (eventType) {
    case "task_started":
    case "tool_started":
      return "working";
    case "waiting":
      return "waiting";
    case "task_finished":
    case "task_failed":
    case "session_ended":
      return "idle";
    case "tool_finished":
      return "working";
    case "tool_failed":
      return "idle";
    default:
      return previous;
  }
}

function defaultPairingInput(): PairingCreateInput {
  return {
    installation_id: "",
    ws_url: "",
    collector_token_hash: "",
  };
}

function normalizePairingInput(input?: PairingCreateInput): PairingCreateInput {
  return {
    ...defaultPairingInput(),
    ...(input ?? {}),
  };
}

function pairingStatus(record: PairingRecord, now: string): PairingRecord {
  if (record.status === "pending" && Date.parse(record.expires_at) <= Date.parse(now)) {
    record.status = "expired";
  }
  return record;
}

function tokenValidation(
  record: DeviceTokenRecord,
  token: string,
  role: TokenRole,
  now: string,
): TokenValidation | undefined {
  if (record.role !== role || record.revoked_at) return undefined;
  if (record.expires_at && Date.parse(record.expires_at) <= Date.parse(now)) return undefined;
  if (!opaqueTokenMatches(token, record.token_hash)) return undefined;
  return {
    token_id: record.token_id,
    role: record.role,
    installation_id: record.installation_id,
    ...(record.device_name ? { device_name: record.device_name } : {}),
  };
}

export class InMemoryRelayRepository implements RelayRepository {
  readonly storageKind = "memory" as const;
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly eventsById = new Map<string, StoredEvent>();
  private readonly eventOrder: string[] = [];
  private readonly eventsByInstallation = new Map<string, StoredEvent[]>();
  private readonly installations = new Map<string, InstallationState>();
  private readonly usageSequences = new Map<string, Set<number>>();
  private readonly usageEventIds = new Map<string, { installation_id: string; sequence: number }>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly pairings = new Map<string, PairingRecord>();
  private readonly deviceTokens = new Map<string, DeviceTokenRecord>();
  private readonly maxStoredEvents: number;
  private readonly approvals = new Map<string, Map<string, ApprovalSummary>>();

  constructor(options: { maxStoredEvents?: number } = {}) {
    this.maxStoredEvents = Math.max(1, options.maxStoredEvents ?? 10_000);
  }

  listApprovals(installationId: string): ApprovalSummary[] {
    return [...(this.approvals.get(installationId)?.values() ?? [])].map(clone);
  }

  putApproval(installationId: string, approval: ApprovalSummary): void {
    const approvals = this.approvals.get(installationId) ?? new Map<string, ApprovalSummary>();
    approvals.set(approval.request_id, clone({ ...approval, can_respond: false }));
    this.approvals.set(installationId, approvals);
  }

  registerConnection(input: {
    connection_id: string;
    gateway: ConnectionRecord["gateway"];
    client_id: string;
    installation_id?: string;
    connected_at: string;
  }): ConnectionRecord {
    const record: ConnectionRecord = {
      ...input,
      status: "online",
      last_seen_at: input.connected_at,
    };
    this.connections.set(input.connection_id, record);
    return clone(record);
  }

  updateConnectionIdentity(
    connectionId: string,
    identity: { client_id?: string; installation_id?: string },
  ): ConnectionRecord | undefined {
    const record = this.connections.get(connectionId);
    if (!record || record.disconnected_at) return undefined;
    if (identity.client_id !== undefined && identity.client_id.trim() !== "") {
      record.client_id = identity.client_id.trim();
    }
    if (identity.installation_id !== undefined && identity.installation_id.trim() !== "") {
      record.installation_id = identity.installation_id.trim();
    }
    return clone(record);
  }

  touchConnection(connectionId: string, seenAt: string): ConnectionRecord | undefined {
    const record = this.connections.get(connectionId);
    if (!record || record.disconnected_at) return undefined;
    record.last_seen_at = seenAt;
    record.status = "online";
    return clone(record);
  }

  disconnectConnection(connectionId: string, disconnectedAt: string): ConnectionRecord | undefined {
    const record = this.connections.get(connectionId);
    if (!record) return undefined;
    record.status = "offline";
    record.disconnected_at = disconnectedAt;
    return clone(record);
  }

  getConnection(connectionId: string): ConnectionRecord | undefined {
    const record = this.connections.get(connectionId);
    return record ? clone(record) : undefined;
  }

  listConnections(): ConnectionRecord[] {
    return [...this.connections.values()].map((record) => clone(record));
  }

  refreshConnectionStatuses(
    now: string,
    staleAfterMs: number,
    offlineAfterMs: number,
  ): boolean {
    const nowMs = Date.parse(now);
    let changed = false;
    for (const record of this.connections.values()) {
      if (record.disconnected_at) continue;
      const elapsedMs = Math.max(0, nowMs - Date.parse(record.last_seen_at));
      const nextStatus: ConnectionStatus =
        elapsedMs >= offlineAfterMs
          ? "offline"
          : elapsedMs >= staleAfterMs
            ? "stale"
            : "online";
      if (!isConnectionStatus(nextStatus)) continue;
      if (record.status !== nextStatus) {
        record.status = nextStatus;
        changed = true;
      }
    }
    return changed;
  }

  connectionStatusForInstallation(installationId: string): ConnectionStatus {
    const statuses = [...this.connections.values()]
      .filter(
        (record) =>
          record.gateway === "collector" && record.installation_id === installationId,
      )
      .map((record) => record.status);
    if (statuses.includes("online")) return "online";
    if (statuses.includes("stale")) return "stale";
    return "offline";
  }

  findEvent(eventId: string): StoredEvent | undefined {
    const stored = this.eventsById.get(eventId);
    return stored ? clone(stored) : undefined;
  }

  recordEvent(event: EventEnvelope, receivedAt: string): RecordEventResult {
    const current = this.installations.get(event.installation_id);
    const byId = this.eventsById.get(event.event_id);
    const byEventSequence = this.eventsByInstallation
      .get(event.installation_id)
      ?.find((stored) => stored.event.sequence === event.sequence);
    const usageById = this.usageEventIds.get(event.event_id);
    const usageSequenceConflict = this.usageSequences.get(event.installation_id)?.has(event.sequence) ?? false;
    if (byId && byId.event.installation_id === event.installation_id && byId.event.sequence === event.sequence) {
      return {
        stored: clone(byId),
        duplicate: true,
        conflict: false,
        activity_applied: false,
        sequence_status: this.sequenceStatusForDuplicate(byId.event, current),
        last_sequence: current?.last_sequence ?? byId.event.sequence,
        next_sequence: current ? this.nextSequence(current.last_sequence) : byId.event.sequence + 1,
      };
    }
    if (byId || byEventSequence || usageById || usageSequenceConflict) {
      const stored = byId ?? byEventSequence ?? { event: clone(event), received_at: receivedAt };
      return {
        stored: clone(stored), duplicate: false, conflict: true, activity_applied: false,
        sequence_status: sequenceStatusForSequence(event.sequence, current?.last_sequence ?? null),
        last_sequence: current?.last_sequence ?? null,
        next_sequence: current ? this.nextSequence(current.last_sequence) : null,
      };
    }

    const previousSequence = current?.last_sequence ?? null;
    const sequence_status = this.sequenceStatus(event.sequence, previousSequence);
    const stored: StoredEvent = { event: clone(event), received_at: receivedAt };
    this.eventsById.set(event.event_id, stored);
    this.eventOrder.push(event.event_id);
    const installationEvents = this.eventsByInstallation.get(event.installation_id) ?? [];
    installationEvents.push(stored);
    this.eventsByInstallation.set(event.installation_id, installationEvents);

    const sessionKey = `${event.installation_id}\u0000${event.session_id}`;
    const priorSession = this.sessions.get(sessionKey);
    const updatedSession = applySessionEvent(priorSession, event, receivedAt);
    const titleUpdated = canUpdateSessionTitle(priorSession, event);
    const changesActivity = updatedSession?.session_kind !== "subagent" &&
      !["session_title_updated", "session_classification_updated"].includes(event.event_type) &&
      (event.session_id === "unknown" || updatedSession?.last_activity_sequence === event.sequence);
    stored.event = { ...eventWithTaskDuration(priorSession, stored.event), ...(updatedSession?.session_kind ? { session_kind: updatedSession.session_kind } : {}) };
    stored.activity_applied = (changesActivity || (titleUpdated && updatedSession?.session_kind !== "subagent") || event.event_type === "session_classification_updated" || updatedSession?.session_kind === "subagent") && sequence_status !== "out_of_order" &&
      !(event.session_id === "unknown" && event.event_type === "task_finished");

    const nextState: InstallationState =
      current && previousSequence !== null && event.sequence < previousSequence
        ? current
        : current && !changesActivity
          ? { ...current, last_sequence: Math.max(current.last_sequence ?? 0, event.sequence) }
        : {
            installation_id: event.installation_id,
            last_sequence:
              previousSequence === null
                ? event.sequence
                : Math.max(previousSequence, event.sequence),
            claude_state: changesActivity ? stateForEvent(event.event_type, current?.claude_state ?? "idle") : current?.claude_state ?? "idle",
            ...(changesActivity ? { activity: {
              event_type: event.event_type,
              session_id: event.session_id,
              ...(event.task_id ? { task_id: event.task_id } : {}),
              occurred_at: event.occurred_at,
            } } : {}),
            updated_at: event.occurred_at,
            ...(current?.usage ? { usage: current.usage } : {}),
          };
    this.installations.set(event.installation_id, nextState);
    if (updatedSession) this.sessions.set(sessionKey, updatedSession);
    this.pruneEvents();

    return {
      stored: clone(stored),
      duplicate: false,
      conflict: false,
      activity_applied: stored.activity_applied,
      sequence_status,
      last_sequence: nextState.last_sequence,
      next_sequence: this.nextSequence(nextState.last_sequence),
    };
  }

  recordUsageSnapshot(message: UsageSnapshotMessage, _receivedAt: string): RecordUsageResult {
    const current = this.installations.get(message.installation_id);
    const existingUsageId = this.usageEventIds.get(message.event_id);
    const exactDuplicate = existingUsageId?.installation_id === message.installation_id && existingUsageId.sequence === message.sequence;
    const conflict = Boolean(existingUsageId || this.eventsById.has(message.event_id) ||
      (this.eventsByInstallation.get(message.installation_id) ?? []).some((item) => item.event.sequence === message.sequence) ||
      (this.usageSequences.get(message.installation_id)?.has(message.sequence) ?? false));
    if (exactDuplicate || conflict) return {
      duplicate: exactDuplicate,
      conflict: !exactDuplicate,
      changed: false,
      sequence_status: sequenceStatusForSequence(message.sequence, current?.last_sequence ?? null),
      last_sequence: current?.last_sequence ?? message.sequence,
      next_sequence: current ? this.nextSequence(current.last_sequence) : message.sequence + 1,
    };
    const previousSequence = current?.last_sequence ?? null;
    const sequence_status = sequenceStatusForSequence(message.sequence, previousSequence);
    this.usageEventIds.set(message.event_id, { installation_id: message.installation_id, sequence: message.sequence });
    const sequences = this.usageSequences.get(message.installation_id) ?? new Set<number>();
    sequences.add(message.sequence);
    this.usageSequences.set(message.installation_id, sequences);
    // A delayed outbox snapshot may follow a newer state event. Usage revision
    // ordering is independent from the shared event sequence; sequence only
    // advances the installation cursor and never gates an absolute summary.
    const acceptedUsage = isNewerUsage(current?.usage, message.usage);
    const changed = acceptedUsage;
    this.installations.set(message.installation_id, {
      installation_id: message.installation_id,
      last_sequence: previousSequence === null ? message.sequence : Math.max(previousSequence, message.sequence),
      claude_state: current?.claude_state ?? "idle",
      ...(current?.activity ? { activity: current.activity } : {}),
      updated_at: current?.updated_at ?? message.occurred_at,
      ...(current?.sessions ? { sessions: current.sessions } : {}),
      ...(current?.running_count !== undefined ? { running_count: current.running_count } : {}),
      ...(current?.session_count !== undefined ? { session_count: current.session_count } : {}),
      ...(current?.recent_completion ? { recent_completion: current.recent_completion } : {}),
      ...(acceptedUsage ? { usage: clone(message.usage) } : current?.usage ? { usage: current.usage } : {}),
    });
    return {
      duplicate: false,
      conflict: false,
      changed,
      sequence_status,
      last_sequence: this.installations.get(message.installation_id)?.last_sequence ?? message.sequence,
      next_sequence: this.nextSequence(this.installations.get(message.installation_id)?.last_sequence ?? message.sequence),
    };
  }

  listEventsAfter(installationId: string, sequence: number): StoredEvent[] {
    return (this.eventsByInstallation.get(installationId) ?? [])
      .filter((stored) => stored.event.sequence > sequence)
      .sort((left, right) => left.event.sequence - right.event.sequence)
      .map((stored) => {
        const record = this.sessions.get(`${installationId}\u0000${stored.event.session_id}`);
        return clone({ ...stored, event: { ...stored.event, ...(record?.session_kind ? { session_kind: record.session_kind } : {}) } });
      });
  }

  listInstallationIds(): string[] {
    const ids = new Set<string>(this.installations.keys());
    for (const record of this.connections.values()) {
      if (record.installation_id) ids.add(record.installation_id);
    }
    for (const pairing of this.pairings.values()) {
      if (pairing.installation_id) ids.add(pairing.installation_id);
    }
    return [...ids].sort();
  }

  getInstallationState(installationId: string, now = new Date().toISOString()): InstallationState | undefined {
    const state = this.installations.get(installationId);
    if (!state) return undefined;
    const records = [...this.sessions.values()].filter((record) => record.installation_id === installationId);
    return clone(presentInstallationState(state, records, now));
  }

  createPairing(now: string, ttlMs: number, input?: PairingCreateInput): PairingRecord {
    const createdAt = Date.parse(now);
    const pairingInput = normalizePairingInput(input);
    const record: PairingRecord = {
      pairing_id: randomUUID(),
      code: randomBytes(4).toString("hex").toUpperCase(),
      created_at: now,
      expires_at: new Date(createdAt + ttlMs).toISOString(),
      status: "pending",
      installation_id: pairingInput.installation_id,
      ws_url: pairingInput.ws_url,
      ...(pairingInput.relay_url ? { relay_url: pairingInput.relay_url } : {}),
      ...(pairingInput.public_url ? { public_url: pairingInput.public_url } : {}),
      collector_token_hash: pairingInput.collector_token_hash,
    };
    this.pairings.set(record.pairing_id, record);
    return clone(record);
  }

  getPairing(pairingId: string, now: string): PairingRecord | undefined {
    const record = this.pairings.get(pairingId);
    if (!record) return undefined;
    pairingStatus(record, now);
    return clone(record);
  }

  claimPairing(pairingId: string, code: string, now: string, deviceName?: string): boolean {
    const record = this.pairings.get(pairingId);
    if (!record) return false;
    pairingStatus(record, now);
    if (record.status !== "pending" || record.code !== code.trim().toUpperCase()) return false;
    record.status = "claimed";
    record.claimed_at = now;
    if (deviceName?.trim()) record.device_name = deviceName.trim();
    return true;
  }

  attachAndroidToken(
    pairingId: string,
    tokenHash: string,
    deviceName?: string,
    claimedAt?: string,
  ): PairingRecord | undefined {
    const record = this.pairings.get(pairingId);
    if (!record || record.status !== "claimed") return undefined;
    record.android_token_hash = tokenHash;
    if (deviceName?.trim()) record.device_name = deviceName.trim();
    if (claimedAt && !record.claimed_at) record.claimed_at = claimedAt;
    return clone(record);
  }

  createDeviceToken(input: CreateDeviceTokenInput): DeviceTokenRecord {
    const record: DeviceTokenRecord = {
      token_id: input.token_id ?? `tok_${randomUUID()}`,
      role: input.role,
      installation_id: input.installation_id,
      token_hash: hashOpaqueToken(input.token),
      issued_at: input.issued_at,
      ...(input.expires_at ? { expires_at: input.expires_at } : {}),
      ...(input.device_name?.trim() ? { device_name: input.device_name.trim() } : {}),
    };
    this.deviceTokens.set(record.token_id, record);
    return clone(record);
  }

  validateToken(token: string, role: TokenRole, now: string): TokenValidation | undefined {
    if (!token.trim()) return undefined;
    for (const record of this.deviceTokens.values()) {
      const result = tokenValidation(record, token, role, now);
      if (result) return result;
    }
    return undefined;
  }

  revokeToken(tokenId: string, revokedAt: string): boolean {
    const record = this.deviceTokens.get(tokenId);
    if (!record || record.revoked_at) return false;
    record.revoked_at = revokedAt;
    return true;
  }

  isTokenActive(tokenId: string, role: TokenRole, installationId: string, now: string): boolean {
    const token = this.deviceTokens.get(tokenId);
    return Boolean(token && token.role === role && token.installation_id === installationId && !token.revoked_at &&
      (!token.expires_at || Date.parse(token.expires_at) > Date.parse(now)));
  }

  private sequenceStatus(sequence: number, previous: number | null): SequenceStatus {
    if (previous === null) return "initial";
    if (sequence === previous + 1) return "in_order";
    if (sequence > previous + 1) return "gap";
    return "out_of_order";
  }

  private sequenceStatusForDuplicate(
    event: EventEnvelope,
    current: InstallationState | undefined,
  ): SequenceStatus {
    return this.sequenceStatus(event.sequence, current?.last_sequence ?? null);
  }

  private nextSequence(lastSequence: number | null): number | null {
    return lastSequence === null ? null : lastSequence + 1;
  }

  private pruneEvents(): void {
    while (this.eventsById.size > this.maxStoredEvents) {
      const eventId = this.eventOrder.shift();
      if (!eventId) return;
      const stored = this.eventsById.get(eventId);
      if (!stored) continue;
      this.eventsById.delete(eventId);
      const installationEvents = this.eventsByInstallation.get(stored.event.installation_id);
      if (!installationEvents) continue;
      const index = installationEvents.findIndex(
        (candidate) => candidate.event.event_id === eventId,
      );
      if (index >= 0) installationEvents.splice(index, 1);
    }
  }
}

type SqlRow = Record<string, unknown>;

function stringValue(row: SqlRow, key: string): string | undefined {
  return typeof row[key] === "string" ? row[key] : undefined;
}

function numberValue(row: SqlRow, key: string): number | undefined {
  return typeof row[key] === "number" ? row[key] : undefined;
}

function optionalJson<T>(value: unknown): T | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/**
 * Synchronous SQLite repository using Node's built-in `node:sqlite` API. The
 * relay already serializes message handling, so synchronous statements keep
 * persistence atomic without adding an ORM or a native npm dependency.
 */
export class SqliteRelayRepository implements RelayRepository {
  readonly storageKind = "sqlite" as const;
  private readonly db: DatabaseSync;
  private readonly maxStoredEvents: number;
  private readonly connections = new Map<string, ConnectionRecord>();

  constructor(path: string, options: { maxStoredEvents?: number } = {}) {
    if (!path.trim()) throw new Error("SQLite database path must not be empty");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5_000 });
    this.maxStoredEvents = Math.max(1, options.maxStoredEvents ?? 10_000);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_connections (
        connection_id TEXT PRIMARY KEY,
        gateway TEXT NOT NULL,
        client_id TEXT NOT NULL,
        installation_id TEXT,
        status TEXT NOT NULL,
        connected_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        disconnected_at TEXT
      );
      CREATE TABLE IF NOT EXISTS relay_approvals (
        installation_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        approval_json TEXT NOT NULL,
        PRIMARY KEY (installation_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS relay_events (
        event_id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        activity_applied INTEGER NOT NULL DEFAULT 1,
        UNIQUE (installation_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS relay_events_installation_sequence
        ON relay_events (installation_id, sequence);
      CREATE TABLE IF NOT EXISTS relay_installations (
        installation_id TEXT PRIMARY KEY,
        last_sequence INTEGER,
        claude_state TEXT NOT NULL,
        activity_json TEXT,
        updated_at TEXT NOT NULL,
        usage_json TEXT
      );
      CREATE TABLE IF NOT EXISTS relay_usage_sequences (
        installation_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        PRIMARY KEY (installation_id, sequence),
        UNIQUE (event_id)
      );
      CREATE INDEX IF NOT EXISTS relay_usage_sequences_lookup
        ON relay_usage_sequences (installation_id, sequence);
      CREATE TABLE IF NOT EXISTS relay_sessions (
        installation_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        session_json TEXT NOT NULL,
        PRIMARY KEY (installation_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS relay_pairings (
        pairing_id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        ws_url TEXT NOT NULL,
        relay_url TEXT,
        public_url TEXT,
        collector_token_hash TEXT NOT NULL,
        claimed_at TEXT,
        android_token_hash TEXT,
        device_name TEXT
      );
      CREATE INDEX IF NOT EXISTS relay_pairings_installation
        ON relay_pairings (installation_id);
      CREATE TABLE IF NOT EXISTS relay_device_tokens (
        token_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        issued_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        device_name TEXT
      );
      CREATE INDEX IF NOT EXISTS relay_device_tokens_lookup
        ON relay_device_tokens (role, token_hash);
    `);
    const installationColumns = this.db.prepare("PRAGMA table_info(relay_installations)").all() as SqlRow[];
    if (!installationColumns.some((column) => stringValue(column, "name") === "usage_json")) {
      this.db.exec("ALTER TABLE relay_installations ADD COLUMN usage_json TEXT");
    }
    const eventColumns = this.db.prepare("PRAGMA table_info(relay_events)").all() as SqlRow[];
    if (!eventColumns.some((column) => stringValue(column, "name") === "activity_applied")) {
      this.db.exec("ALTER TABLE relay_events ADD COLUMN activity_applied INTEGER NOT NULL DEFAULT 1");
    }
    this.migrateSessionState();
  }

  private migrateSessionState(): void {
    const existing = this.db.prepare("SELECT 1 FROM relay_sessions LIMIT 1").get();
    if (existing) return;
    const rows = this.db
      .prepare("SELECT event_json FROM relay_events ORDER BY installation_id, sequence")
      .all() as SqlRow[];
    if (rows.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const sessions = new Map<string, SessionState>();
      for (const row of rows) {
        const event = optionalJson<EventEnvelope>(row.event_json);
        if (!event) continue;
        const key = `${event.installation_id}\u0000${event.session_id}`;
        const updated = applySessionEvent(sessions.get(key), event);
        if (updated) sessions.set(key, updated);
      }
      const insert = this.db.prepare(
        "INSERT INTO relay_sessions (installation_id, session_id, session_json) VALUES (?, ?, ?)",
      );
      for (const state of sessions.values()) {
        insert.run(state.installation_id, state.session_id, JSON.stringify(state));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  listApprovals(installationId: string): ApprovalSummary[] {
    const rows = this.db.prepare("SELECT approval_json FROM relay_approvals WHERE installation_id = ?").all(installationId) as SqlRow[];
    return rows.map((row) => optionalJson<ApprovalSummary>(row.approval_json)).filter((row): row is ApprovalSummary => Boolean(row));
  }

  putApproval(installationId: string, approval: ApprovalSummary): void {
    this.db.prepare(`INSERT INTO relay_approvals (installation_id, request_id, approval_json) VALUES (?, ?, ?)
      ON CONFLICT(installation_id, request_id) DO UPDATE SET approval_json = excluded.approval_json`)
      .run(installationId, approval.request_id, JSON.stringify({ ...approval, can_respond: false }));
  }

  registerConnection(input: {
    connection_id: string;
    gateway: ConnectionRecord["gateway"];
    client_id: string;
    installation_id?: string;
    connected_at: string;
  }): ConnectionRecord {
    const record: ConnectionRecord = {
      ...input,
      status: "online",
      last_seen_at: input.connected_at,
    };
    this.connections.set(input.connection_id, record);
    return clone(record);
  }

  updateConnectionIdentity(
    connectionId: string,
    identity: { client_id?: string; installation_id?: string },
  ): ConnectionRecord | undefined {
    const record = this.connections.get(connectionId);
    if (!record || record.disconnected_at) return undefined;
    if (identity.client_id !== undefined && identity.client_id.trim() !== "") {
      record.client_id = identity.client_id.trim();
    }
    if (identity.installation_id !== undefined && identity.installation_id.trim() !== "") {
      record.installation_id = identity.installation_id.trim();
    }
    return clone(record);
  }

  touchConnection(connectionId: string, seenAt: string): ConnectionRecord | undefined {
    const record = this.connections.get(connectionId);
    if (!record || record.disconnected_at) return undefined;
    record.last_seen_at = seenAt;
    record.status = "online";
    return clone(record);
  }

  disconnectConnection(connectionId: string, disconnectedAt: string): ConnectionRecord | undefined {
    const record = this.connections.get(connectionId);
    if (!record) return undefined;
    record.status = "offline";
    record.disconnected_at = disconnectedAt;
    return clone(record);
  }

  getConnection(connectionId: string): ConnectionRecord | undefined {
    const record = this.connections.get(connectionId);
    return record ? clone(record) : undefined;
  }

  listConnections(): ConnectionRecord[] {
    return [...this.connections.values()].map((record) => clone(record));
  }

  refreshConnectionStatuses(
    now: string,
    staleAfterMs: number,
    offlineAfterMs: number,
  ): boolean {
    const nowMs = Date.parse(now);
    let changed = false;
    for (const record of this.connections.values()) {
      if (record.disconnected_at) continue;
      const elapsedMs = Math.max(0, nowMs - Date.parse(record.last_seen_at));
      const nextStatus: ConnectionStatus =
        elapsedMs >= offlineAfterMs
          ? "offline"
          : elapsedMs >= staleAfterMs
            ? "stale"
            : "online";
      if (!isConnectionStatus(nextStatus) || record.status === nextStatus) continue;
      record.status = nextStatus;
      changed = true;
    }
    return changed;
  }

  connectionStatusForInstallation(installationId: string): ConnectionStatus {
    const statuses = [...this.connections.values()]
      .filter(
        (record) =>
          record.gateway === "collector" && record.installation_id === installationId,
      )
      .map((record) => record.status);
    if (statuses.includes("online")) return "online";
    if (statuses.includes("stale")) return "stale";
    return "offline";
  }

  findEvent(eventId: string): StoredEvent | undefined {
    const row = this.db
      .prepare("SELECT event_json, received_at, activity_applied FROM relay_events WHERE event_id = ?")
      .get(eventId) as SqlRow | undefined;
    return this.rowToStoredEvent(row);
  }

  recordEvent(event: EventEnvelope, receivedAt: string): RecordEventResult {
    const byId = this.findEvent(event.event_id);
    const bySequence = this.db
      .prepare(
        "SELECT event_json, received_at, activity_applied FROM relay_events WHERE installation_id = ? AND sequence = ?",
      )
      .get(event.installation_id, event.sequence) as SqlRow | undefined;
    const usageById = this.db.prepare(
      "SELECT installation_id, sequence FROM relay_usage_sequences WHERE event_id = ?",
    ).get(event.event_id) as SqlRow | undefined;
    const usageBySequence = this.db.prepare(
      "SELECT event_id FROM relay_usage_sequences WHERE installation_id = ? AND sequence = ?",
    ).get(event.installation_id, event.sequence) as SqlRow | undefined;
    const current = this.getInstallationState(event.installation_id);
    if (byId && byId.event.installation_id === event.installation_id && byId.event.sequence === event.sequence) {
      return {
        stored: clone(byId),
        duplicate: true,
        conflict: false,
        activity_applied: false,
        sequence_status: this.sequenceStatusForDuplicate(byId.event, current),
        last_sequence: current?.last_sequence ?? byId.event.sequence,
        next_sequence: current ? this.nextSequence(current.last_sequence) : byId.event.sequence + 1,
      };
    }
    const sequenceEvent = this.rowToStoredEvent(bySequence);
    if (byId || sequenceEvent || usageById || usageBySequence) {
      return {
        stored: clone(byId ?? sequenceEvent ?? { event: clone(event), received_at: receivedAt }),
        duplicate: false,
        conflict: true,
        activity_applied: false,
        sequence_status: sequenceStatusForSequence(event.sequence, current?.last_sequence ?? null),
        last_sequence: current?.last_sequence ?? null,
        next_sequence: current ? this.nextSequence(current.last_sequence) : null,
      };
    }

    const previousSequence = current?.last_sequence ?? null;
    const sequence_status = this.sequenceStatus(event.sequence, previousSequence);
    const stored: StoredEvent = { event: clone(event), received_at: receivedAt };
    const sessionRow = this.db
      .prepare("SELECT session_json FROM relay_sessions WHERE installation_id = ? AND session_id = ?")
      .get(event.installation_id, event.session_id) as SqlRow | undefined;
    const priorSession = optionalJson<SessionState>(sessionRow?.session_json);
    const updatedSession = applySessionEvent(priorSession, event, receivedAt);
    const titleUpdated = canUpdateSessionTitle(priorSession, event);
    const changesActivity = updatedSession?.session_kind !== "subagent" &&
      !["session_title_updated", "session_classification_updated"].includes(event.event_type) &&
      (event.session_id === "unknown" || updatedSession?.last_activity_sequence === event.sequence);
    stored.event = { ...eventWithTaskDuration(priorSession, stored.event), ...(updatedSession?.session_kind ? { session_kind: updatedSession.session_kind } : {}) };
    stored.activity_applied = (changesActivity || (titleUpdated && updatedSession?.session_kind !== "subagent") || event.event_type === "session_classification_updated" || updatedSession?.session_kind === "subagent") && sequence_status !== "out_of_order" &&
      !(event.session_id === "unknown" && event.event_type === "task_finished");
    const nextState: InstallationState =
      current && previousSequence !== null && event.sequence < previousSequence
        ? current
        : current && !changesActivity
          ? { ...current, last_sequence: Math.max(current.last_sequence ?? 0, event.sequence) }
        : {
            installation_id: event.installation_id,
            last_sequence:
              previousSequence === null
                ? event.sequence
                : Math.max(previousSequence, event.sequence),
            claude_state: changesActivity ? stateForEvent(event.event_type, current?.claude_state ?? "idle") : current?.claude_state ?? "idle",
            ...(changesActivity ? { activity: {
              event_type: event.event_type,
              session_id: event.session_id,
              ...(event.task_id ? { task_id: event.task_id } : {}),
              occurred_at: event.occurred_at,
            } } : {}),
            updated_at: event.occurred_at,
          };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO relay_events (event_id, installation_id, sequence, event_json, received_at, activity_applied) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          event.event_id,
          event.installation_id,
          event.sequence,
          JSON.stringify(stored.event),
          receivedAt,
          stored.activity_applied ? 1 : 0,
        );
      this.db
        .prepare(
          `INSERT INTO relay_installations (installation_id, last_sequence, claude_state, activity_json, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(installation_id) DO UPDATE SET
             last_sequence = excluded.last_sequence,
             claude_state = excluded.claude_state,
             activity_json = excluded.activity_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          nextState.installation_id,
          nextState.last_sequence,
          nextState.claude_state,
          nextState.activity ? JSON.stringify(nextState.activity) : null,
          nextState.updated_at,
        );
      if (updatedSession) {
        this.db.prepare(
          `INSERT INTO relay_sessions (installation_id, session_id, session_json) VALUES (?, ?, ?)
           ON CONFLICT(installation_id, session_id) DO UPDATE SET session_json = excluded.session_json`,
        ).run(event.installation_id, event.session_id, JSON.stringify(updatedSession));
      }
      this.pruneEvents();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      stored: clone(stored),
      duplicate: false,
      conflict: false,
      activity_applied: stored.activity_applied,
      sequence_status,
      last_sequence: nextState.last_sequence,
      next_sequence: this.nextSequence(nextState.last_sequence),
    };
  }

  recordUsageSnapshot(message: UsageSnapshotMessage, receivedAt: string): RecordUsageResult {
    const usageById = this.db.prepare(
      "SELECT installation_id, sequence FROM relay_usage_sequences WHERE event_id = ?",
    ).get(message.event_id) as SqlRow | undefined;
    const usageBySequence = this.db.prepare(
      "SELECT event_id FROM relay_usage_sequences WHERE installation_id = ? AND sequence = ?",
    ).get(message.installation_id, message.sequence) as SqlRow | undefined;
    const byEvent = this.findEvent(message.event_id);
    const bySequence = this.db.prepare(
      "SELECT event_id FROM relay_events WHERE installation_id = ? AND sequence = ?",
    ).get(message.installation_id, message.sequence) as SqlRow | undefined;
    const current = this.getInstallationState(message.installation_id);
    const exactDuplicate = usageById && stringValue(usageById, "installation_id") === message.installation_id &&
      numberValue(usageById, "sequence") === message.sequence;
    if (exactDuplicate || usageById || usageBySequence || byEvent || bySequence) return {
      duplicate: Boolean(exactDuplicate),
      conflict: !exactDuplicate,
      changed: false,
      sequence_status: sequenceStatusForSequence(message.sequence, current?.last_sequence ?? null),
      last_sequence: current?.last_sequence ?? message.sequence,
      next_sequence: current ? this.nextSequence(current.last_sequence) : message.sequence + 1,
    };
    const previousSequence = current?.last_sequence ?? null;
    const sequence_status = sequenceStatusForSequence(message.sequence, previousSequence);
    const canReplaceUsage = isNewerUsage(current?.usage, message.usage);
    const updated = canReplaceUsage;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        "INSERT INTO relay_usage_sequences (installation_id, sequence, event_id) VALUES (?, ?, ?)",
      ).run(message.installation_id, message.sequence, message.event_id);
      const nextSequence = previousSequence === null ? message.sequence : Math.max(previousSequence, message.sequence);
      const stateUpdatedAt = current?.updated_at ?? message.occurred_at;
      this.db.prepare(
        `INSERT INTO relay_installations (installation_id, last_sequence, claude_state, activity_json, updated_at, usage_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id) DO UPDATE SET
           last_sequence = excluded.last_sequence,
           usage_json = CASE WHEN ? THEN excluded.usage_json ELSE relay_installations.usage_json END`,
      ).run(
        message.installation_id,
        nextSequence,
        current?.claude_state ?? "idle",
        current?.activity ? JSON.stringify(current.activity) : null,
        stateUpdatedAt,
        canReplaceUsage ? JSON.stringify(message.usage) : null,
        canReplaceUsage ? 1 : 0,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    void receivedAt;
    return {
      duplicate: false,
      conflict: false,
      changed: updated,
      sequence_status,
      last_sequence: previousSequence === null ? message.sequence : Math.max(previousSequence, message.sequence),
      next_sequence: this.nextSequence(previousSequence === null ? message.sequence : Math.max(previousSequence, message.sequence)),
    };
  }

  listEventsAfter(installationId: string, sequence: number): StoredEvent[] {
    const rows = this.db
      .prepare(
        "SELECT event_json, received_at, activity_applied FROM relay_events WHERE installation_id = ? AND sequence > ? ORDER BY sequence ASC",
      )
      .all(installationId, sequence) as SqlRow[];
    return rows
      .map((row) => this.rowToStoredEvent(row))
      .filter((stored): stored is StoredEvent => stored !== undefined)
      .map((stored) => {
        const row = this.db.prepare("SELECT session_json FROM relay_sessions WHERE installation_id = ? AND session_id = ?")
          .get(installationId, stored.event.session_id) as SqlRow | undefined;
        const record = optionalJson<SessionState>(row?.session_json);
        return clone({ ...stored, event: { ...stored.event, ...(record?.session_kind ? { session_kind: record.session_kind } : {}) } });
      });
  }

  listInstallationIds(): string[] {
    const ids = new Set<string>();
    const rows = this.db
      .prepare(
        `SELECT installation_id FROM relay_installations
         UNION SELECT installation_id FROM relay_pairings
         UNION SELECT installation_id FROM relay_device_tokens`,
      )
      .all() as SqlRow[];
    for (const row of rows) {
      const id = stringValue(row, "installation_id");
      if (id) ids.add(id);
    }
    for (const record of this.connections.values()) {
      if (record.installation_id) ids.add(record.installation_id);
    }
    return [...ids].sort();
  }

  getInstallationState(installationId: string, now = new Date().toISOString()): InstallationState | undefined {
    const row = this.db
      .prepare("SELECT * FROM relay_installations WHERE installation_id = ?")
      .get(installationId) as SqlRow | undefined;
    if (!row) return undefined;
    const lastSequence = row.last_sequence === null ? null : numberValue(row, "last_sequence");
    const claudeState = stringValue(row, "claude_state");
    const updatedAt = stringValue(row, "updated_at");
    if (
      lastSequence === undefined ||
      !claudeState ||
      !updatedAt ||
      !["idle", "working", "waiting"].includes(claudeState)
    ) {
      return undefined;
    }
    const state: InstallationState = {
      installation_id: installationId,
      last_sequence: lastSequence,
      claude_state: claudeState as ClaudeState,
      ...(optionalJson<InstallationState["activity"]>(row.activity_json)
        ? { activity: optionalJson<InstallationState["activity"]>(row.activity_json) }
        : {}),
      updated_at: updatedAt,
      ...(optionalJson<UsageAggregate>(row.usage_json) ? { usage: optionalJson<UsageAggregate>(row.usage_json) } : {}),
    };
    const sessionRows = this.db
      .prepare("SELECT session_json FROM relay_sessions WHERE installation_id = ?")
      .all(installationId) as SqlRow[];
    const sessions = sessionRows.map((sessionRow) => optionalJson<SessionState>(sessionRow.session_json)).filter((item): item is SessionState => Boolean(item));
    return presentInstallationState(state, sessions, now);
  }

  createPairing(now: string, ttlMs: number, input?: PairingCreateInput): PairingRecord {
    const createdAt = Date.parse(now);
    const pairingInput = normalizePairingInput(input);
    const record: PairingRecord = {
      pairing_id: randomUUID(),
      code: randomBytes(4).toString("hex").toUpperCase(),
      created_at: now,
      expires_at: new Date(createdAt + ttlMs).toISOString(),
      status: "pending",
      installation_id: pairingInput.installation_id,
      ws_url: pairingInput.ws_url,
      ...(pairingInput.relay_url ? { relay_url: pairingInput.relay_url } : {}),
      ...(pairingInput.public_url ? { public_url: pairingInput.public_url } : {}),
      collector_token_hash: pairingInput.collector_token_hash,
    };
    this.db
      .prepare(
        `INSERT INTO relay_pairings
          (pairing_id, code, created_at, expires_at, status, installation_id, ws_url, relay_url, public_url, collector_token_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.pairing_id,
        record.code,
        record.created_at,
        record.expires_at,
        record.status,
        record.installation_id,
        record.ws_url,
        record.relay_url ?? null,
        record.public_url ?? null,
        record.collector_token_hash,
      );
    return clone(record);
  }

  getPairing(pairingId: string, now: string): PairingRecord | undefined {
    const row = this.db.prepare("SELECT * FROM relay_pairings WHERE pairing_id = ?").get(pairingId) as
      | SqlRow
      | undefined;
    const record = this.rowToPairing(row);
    if (!record) return undefined;
    const updated = pairingStatus(record, now);
    if (updated.status !== (stringValue(row ?? {}, "status") ?? "")) {
      this.db
        .prepare("UPDATE relay_pairings SET status = ? WHERE pairing_id = ?")
        .run(updated.status, pairingId);
    }
    return clone(updated);
  }

  claimPairing(pairingId: string, code: string, now: string, deviceName?: string): boolean {
    const record = this.getPairing(pairingId, now);
    if (!record || record.status !== "pending" || record.code !== code.trim().toUpperCase()) {
      return false;
    }
    const result = this.db
      .prepare(
        `UPDATE relay_pairings SET status = 'claimed', claimed_at = ?, device_name = ?
         WHERE pairing_id = ? AND status = 'pending' AND code = ? AND expires_at > ?`,
      )
      .run(now, deviceName?.trim() || null, pairingId, code.trim().toUpperCase(), now);
    return result.changes === 1;
  }

  attachAndroidToken(
    pairingId: string,
    tokenHash: string,
    deviceName?: string,
    claimedAt?: string,
  ): PairingRecord | undefined {
    const result = this.db
      .prepare(
        `UPDATE relay_pairings SET android_token_hash = ?, device_name = COALESCE(?, device_name),
         claimed_at = COALESCE(claimed_at, ?)
         WHERE pairing_id = ? AND status = 'claimed'`,
      )
      .run(tokenHash, deviceName?.trim() || null, claimedAt ?? null, pairingId);
    if (result.changes !== 1) return undefined;
    return this.getPairing(pairingId, claimedAt ?? new Date().toISOString());
  }

  createDeviceToken(input: CreateDeviceTokenInput): DeviceTokenRecord {
    const record: DeviceTokenRecord = {
      token_id: input.token_id ?? `tok_${randomUUID()}`,
      role: input.role,
      installation_id: input.installation_id,
      token_hash: hashOpaqueToken(input.token),
      issued_at: input.issued_at,
      ...(input.expires_at ? { expires_at: input.expires_at } : {}),
      ...(input.device_name?.trim() ? { device_name: input.device_name.trim() } : {}),
    };
    this.db
      .prepare(
        `INSERT INTO relay_device_tokens
          (token_id, role, installation_id, token_hash, issued_at, expires_at, device_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.token_id,
        record.role,
        record.installation_id,
        record.token_hash,
        record.issued_at,
        record.expires_at ?? null,
        record.device_name ?? null,
      );
    return clone(record);
  }

  validateToken(token: string, role: TokenRole, now: string): TokenValidation | undefined {
    if (!token.trim()) return undefined;
    const tokenHash = hashOpaqueToken(token);
    const row = this.db
      .prepare(
        `SELECT token_id, role, installation_id, token_hash, expires_at, revoked_at, device_name
         FROM relay_device_tokens WHERE role = ? AND token_hash = ?`,
      )
      .get(role, tokenHash) as SqlRow | undefined;
    if (!row) return undefined;
    const tokenId = stringValue(row, "token_id");
    const installationId = stringValue(row, "installation_id");
    const storedHash = stringValue(row, "token_hash");
    const revokedAt = stringValue(row, "revoked_at");
    const expiresAt = stringValue(row, "expires_at");
    if (!tokenId || !installationId || !storedHash || revokedAt) return undefined;
    if (expiresAt && Date.parse(expiresAt) <= Date.parse(now)) return undefined;
    if (!opaqueTokenMatches(token, storedHash)) return undefined;
    const deviceName = stringValue(row, "device_name");
    return {
      token_id: tokenId,
      role,
      installation_id: installationId,
      ...(deviceName ? { device_name: deviceName } : {}),
    };
  }

  revokeToken(tokenId: string, revokedAt: string): boolean {
    const result = this.db
      .prepare("UPDATE relay_device_tokens SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL")
      .run(revokedAt, tokenId);
    return result.changes === 1;
  }

  isTokenActive(tokenId: string, role: TokenRole, installationId: string, now: string): boolean {
    const row = this.db.prepare("SELECT role, installation_id, revoked_at, expires_at FROM relay_device_tokens WHERE token_id = ?").get(tokenId) as SqlRow | undefined;
    return Boolean(row && stringValue(row, "role") === role && stringValue(row, "installation_id") === installationId &&
      !stringValue(row, "revoked_at") && (!stringValue(row, "expires_at") || Date.parse(stringValue(row, "expires_at")!) > Date.parse(now)));
  }

  private rowToStoredEvent(row: SqlRow | undefined): StoredEvent | undefined {
    if (!row) return undefined;
    const event = optionalJson<EventEnvelope>(row.event_json);
    const receivedAt = stringValue(row, "received_at");
    return event && receivedAt ? { event, received_at: receivedAt, activity_applied: row.activity_applied !== 0 } : undefined;
  }

  private rowToPairing(row: SqlRow | undefined): PairingRecord | undefined {
    if (!row) return undefined;
    const pairingId = stringValue(row, "pairing_id");
    const code = stringValue(row, "code");
    const createdAt = stringValue(row, "created_at");
    const expiresAt = stringValue(row, "expires_at");
    const status = stringValue(row, "status");
    const installationId = stringValue(row, "installation_id");
    const wsUrl = stringValue(row, "ws_url");
    const collectorTokenHash = stringValue(row, "collector_token_hash");
    if (
      !pairingId ||
      !code ||
      !createdAt ||
      !expiresAt ||
      !installationId ||
      !wsUrl ||
      !collectorTokenHash ||
      !["pending", "claimed", "expired"].includes(status ?? "")
    ) {
      return undefined;
    }
    const relayUrl = stringValue(row, "relay_url");
    const publicUrl = stringValue(row, "public_url");
    const claimedAt = stringValue(row, "claimed_at");
    const androidTokenHash = stringValue(row, "android_token_hash");
    const deviceName = stringValue(row, "device_name");
    return {
      pairing_id: pairingId,
      code,
      created_at: createdAt,
      expires_at: expiresAt,
      status: status as PairingRecord["status"],
      installation_id: installationId,
      ws_url: wsUrl,
      ...(relayUrl ? { relay_url: relayUrl } : {}),
      ...(publicUrl ? { public_url: publicUrl } : {}),
      collector_token_hash: collectorTokenHash,
      ...(claimedAt ? { claimed_at: claimedAt } : {}),
      ...(androidTokenHash ? { android_token_hash: androidTokenHash } : {}),
      ...(deviceName ? { device_name: deviceName } : {}),
    };
  }

  private sequenceStatus(sequence: number, previous: number | null): SequenceStatus {
    if (previous === null) return "initial";
    if (sequence === previous + 1) return "in_order";
    if (sequence > previous + 1) return "gap";
    return "out_of_order";
  }

  private sequenceStatusForDuplicate(
    event: EventEnvelope,
    current: InstallationState | undefined,
  ): SequenceStatus {
    return this.sequenceStatus(event.sequence, current?.last_sequence ?? null);
  }

  private nextSequence(lastSequence: number | null): number | null {
    return lastSequence === null ? null : lastSequence + 1;
  }

  private pruneEvents(): void {
    const countRow = this.db.prepare("SELECT COUNT(*) AS count FROM relay_events").get() as SqlRow;
    const count = numberValue(countRow, "count") ?? 0;
    if (count <= this.maxStoredEvents) return;
    this.db
      .prepare(
        `DELETE FROM relay_events WHERE event_id IN (
          SELECT event_id FROM relay_events ORDER BY rowid ASC LIMIT ?
        )`,
      )
      .run(count - this.maxStoredEvents);
  }
}

export function createRelayRepository(
  databasePath: string | undefined,
  options: { maxStoredEvents?: number } = {},
): RelayRepository {
  return databasePath
    ? new SqliteRelayRepository(databasePath, options)
    : new InMemoryRelayRepository(options);
}
