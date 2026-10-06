export const SCHEMA_VERSION = 1 as const;

export const EVENT_TYPES = [
  "session_started",
  "task_started",
  "tool_started",
  "tool_finished",
  "tool_failed",
  "waiting",
  "task_finished",
  "task_failed",
  "session_ended",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * The only data that may leave the workstation in an event payload.
 * Values are deliberately scalar and are produced from an allowlist in
 * normalize.ts; arbitrary hook fields are never copied into this object.
 */
export interface SafeEventPayload {
  tool_name?: string;
  duration_ms?: number;
  exit_code?: number;
}

/** Canonical v1 event wire envelope. */
export interface EventEnvelope {
  type: "event";
  schema_version: typeof SCHEMA_VERSION;
  event_id: string;
  installation_id: string;
  session_id: string;
  task_id?: string;
  session_title?: string;
  sequence: number;
  occurred_at: string;
  event_type: EventType;
  payload: SafeEventPayload;
  correlation_id?: string;
}

export interface HelloMessage {
  type: "hello";
  schema_version?: typeof SCHEMA_VERSION;
  role?: "collector";
  client_id?: string;
  installation_id: string;
  last_sequence?: number;
  pairing_id?: string;
  pairing_code?: string;
  token?: string;
}

export interface EventAckMessage {
  type: "event_ack";
  schema_version?: typeof SCHEMA_VERSION;
  event_id: string;
  sequence?: number;
  status?: "accepted" | "duplicate" | "rejected";
  accepted?: boolean;
  duplicate?: boolean;
  last_sequence?: number | null;
  next_sequence?: number | null;
  [key: string]: unknown;
}

export interface HeartbeatMessage {
  type: "heartbeat";
  schema_version?: typeof SCHEMA_VERSION;
  role?: "collector";
  installation_id?: string;
  last_sequence?: number;
  occurred_at?: string;
  heartbeat_id?: string;
  sent_at?: string;
  acknowledged?: boolean;
}

export interface ChallengeMessage {
  type: "challenge";
  schema_version?: typeof SCHEMA_VERSION;
  probe_id?: string;
  nonce?: string;
  challenge_id?: string;
  payload?: unknown;
  target_installation_id?: string;
  target_gateway?: "collector" | "android";
  target_connection_id?: string;
}

export interface ChallengeAckMessage {
  type: "challenge_ack";
  schema_version?: typeof SCHEMA_VERSION;
  probe_id?: string;
  nonce?: string;
  signature?: string;
  challenge_id?: string;
  ok?: boolean;
  payload?: unknown;
}

export interface ProbeMessage {
  type: "probe";
  schema_version?: typeof SCHEMA_VERSION;
  probe_id?: string;
  nonce?: string;
  target_installation_id?: string;
  target_gateway?: "collector" | "android";
  target_connection_id?: string;
  payload?: unknown;
}

export interface HelloAckMessage {
  type: "hello_ack";
  [key: string]: unknown;
}

export interface ServerControlMessage {
  type: "subscribe" | "snapshot" | "resume" | "error";
  [key: string]: unknown;
}

export type RelayInboundMessage =
  | HelloAckMessage
  | EventAckMessage
  | HeartbeatMessage
  | ChallengeMessage
  | ProbeMessage
  | ServerControlMessage;

export type RelayOutboundMessage =
  | HelloMessage
  | EventEnvelope
  | UsageSnapshotMessage
  | HeartbeatMessage
  | ChallengeAckMessage
  | ProbeMessage;

export type UsageQuality = "complete" | "partial" | "unavailable";
export type UsageCoverageStatus = "ready" | "partial" | "unavailable";
export interface UsageMetric { value: number | null; quality: UsageQuality }
export interface UsageProviderCoverage {
  status: UsageCoverageStatus;
  observed_responses: number;
  complete_responses: number;
}
export interface UsageAggregate {
  epoch_id: string;
  started_at: string;
  revision: number;
  observed_responses: number;
  complete_responses: number;
  provider_coverage: { claude: UsageProviderCoverage; codex: UsageProviderCoverage };
  new_input: UsageMetric;
  cached_input: UsageMetric;
  output: UsageMetric;
  actual: UsageMetric;
  total_input: UsageMetric;
  cache_hit: { numerator: number | null; denominator: number | null; quality: UsageQuality };
  quota: { start_remaining: null; current_remaining: null; unit: null; reset_at: null; availability: "unavailable" };
}
export interface UsageSnapshotMessage {
  type: "usage_snapshot";
  schema_version: 1;
  event_id: string;
  installation_id: string;
  sequence: number;
  occurred_at: string;
  usage: UsageAggregate;
}

export interface EnqueueInput<T> {
  id?: string;
  sequence?: number;
  payload: T;
  created_at?: string;
}

export interface OutboxRecord<T> {
  id: string;
  sequence: number;
  payload: T;
  created_at: string;
  attempts: number;
  available_at: number;
  last_error?: string;
}

export interface Outbox<T> {
  enqueue(input: EnqueueInput<T>): Promise<OutboxRecord<T>>;
  peek(limit?: number, now?: number): Promise<OutboxRecord<T>[]>;
  ack(idOrSequence: string | number): Promise<boolean>;
  retry(idOrSequence: string | number, error?: unknown, delayMs?: number): Promise<boolean>;
  size(): Promise<number>;
  clear(): Promise<void>;
  close?(): Promise<void>;
}

export interface NormalizedHookEvent {
  event_type: EventType;
  session_id: string;
  task_id?: string;
  session_title?: string;
  occurred_at: string;
  payload: SafeEventPayload;
  correlation_id?: string;
}

export interface Clock {
  now(): number;
}

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}

export function isSafeEventPayload(value: unknown): value is SafeEventPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "tool_name" && key !== "duration_ms" && key !== "exit_code") return false;
  }
  if (record.tool_name !== undefined && typeof record.tool_name !== "string") return false;
  if (
    record.duration_ms !== undefined &&
    (typeof record.duration_ms !== "number" || !Number.isInteger(record.duration_ms) || record.duration_ms < 0)
  ) {
    return false;
  }
  if (
    record.exit_code !== undefined &&
    (typeof record.exit_code !== "number" || !Number.isInteger(record.exit_code) || record.exit_code < -255 || record.exit_code > 255)
  ) {
    return false;
  }
  return true;
}

export function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EventEnvelope>;
  return (
    candidate.type === "event" &&
    candidate.schema_version === SCHEMA_VERSION &&
    typeof candidate.event_id === "string" &&
    typeof candidate.installation_id === "string" &&
    typeof candidate.session_id === "string" &&
    Number.isSafeInteger(candidate.sequence) &&
    typeof candidate.occurred_at === "string" &&
    isEventType(candidate.event_type) &&
    isSafeEventPayload(candidate.payload)
  );
}
