export const RELAY_SCHEMA_VERSION = 1 as const;

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
export type Gateway = "collector" | "android";
export type TokenRole = "collector" | "android";
export type AuthMode = "development" | "paired";
export type ConnectionStatus = "online" | "stale" | "offline";
export type ComputerState = ConnectionStatus;
export type ClaudeState = "idle" | "working" | "waiting";
export type SequenceStatus = "initial" | "in_order" | "gap" | "out_of_order";
export type EventAckStatus = "accepted" | "duplicate" | "rejected";

export interface EventEnvelope {
  type: "event";
  schema_version: typeof RELAY_SCHEMA_VERSION;
  event_id: string;
  installation_id: string;
  session_id: string;
  session_title?: string;
  task_id?: string;
  sequence: number;
  occurred_at: string;
  event_type: EventType;
  payload: unknown;
  correlation_id?: string;
}

export interface StoredEvent {
  event: EventEnvelope;
  received_at: string;
}

export interface SnapshotActivity {
  event_type: EventType;
  session_id: string;
  task_id?: string;
  occurred_at: string;
}

export interface SessionSummary {
  session_id: string;
  title: string;
  claude_state: ClaudeState;
  last_activity_sequence: number;
}

export interface RecentCompletion {
  session_id: string;
  task_id?: string;
  sequence: number;
  occurred_at: string;
  display_name: string;
}

export interface SnapshotMessage {
  type: "snapshot";
  schema_version: typeof RELAY_SCHEMA_VERSION;
  installation_id: string;
  computer_state: ComputerState;
  claude_state: ClaudeState;
  activity?: string | SnapshotActivity;
  last_sequence: number | null;
  updated_at: string;
  sessions?: SessionSummary[];
  running_count?: number;
  session_count?: number;
  recent_completion?: RecentCompletion;
}

export interface HelloMessage {
  type: "hello";
  schema_version?: typeof RELAY_SCHEMA_VERSION;
  client_id?: string;
  role?: "collector" | "phone" | "relay";
  installation_id?: string;
  pairing_id?: string;
  pairing_code?: string;
  token?: string;
}

export interface HelloAckMessage {
  type: "hello_ack";
  schema_version: typeof RELAY_SCHEMA_VERSION;
  connection_id: string;
  accepted: boolean;
  server_time: string;
  installation_id?: string;
  snapshot?: SnapshotMessage;
  resume?: {
    status: "resumed" | "reset";
    session_id?: string;
    replay_from?: number;
    latest_sequence?: number;
    reason?: "session_mismatch" | "history_expired" | "sequence_ahead";
    snapshot_sequence?: number;
  };
}

export interface HeartbeatMessage {
  type: "heartbeat";
  schema_version?: typeof RELAY_SCHEMA_VERSION;
  sent_at?: string;
  occurred_at?: string;
  nonce?: string;
  role?: "collector" | "phone" | "relay";
  installation_id?: string;
  last_sequence?: number;
  heartbeat_id?: string;
  acknowledged?: boolean;
}

export interface SubscribeMessage {
  type: "subscribe";
  schema_version?: typeof RELAY_SCHEMA_VERSION;
  installation_ids?: string[];
  installation_id?: string;
  all?: boolean;
  android_token?: string;
  token?: string;
}

export interface ResumeMessage {
  type: "resume";
  schema_version?: typeof RELAY_SCHEMA_VERSION;
  installation_id: string;
  last_sequence?: number;
}

export interface ProbeMessage {
  type: "probe";
  schema_version?: typeof RELAY_SCHEMA_VERSION;
  nonce?: string;
  probe_id?: string;
  timeout_ms?: number;
  target_installation_id?: string;
  target_gateway?: Gateway;
  target_connection_id?: string;
  payload?: unknown;
}

export interface ChallengeMessage {
  type: "challenge";
  schema_version?: typeof RELAY_SCHEMA_VERSION;
  challenge?: string;
  challenge_id?: string;
  probe_id?: string;
  nonce?: string;
  expires_at?: string;
  target_installation_id?: string;
  target_gateway?: Gateway;
  target_connection_id?: string;
  payload?: unknown;
}

export interface ChallengeAckMessage {
  type: "challenge_ack";
  schema_version?: typeof RELAY_SCHEMA_VERSION;
  challenge?: string;
  challenge_id?: string;
  probe_id?: string;
  nonce?: string;
  proof?: string;
  signature?: string;
  ok?: boolean;
  payload?: unknown;
}

export interface EventAckMessage {
  type: "event_ack";
  schema_version: typeof RELAY_SCHEMA_VERSION;
  event_id: string;
  sequence: number;
  accepted: boolean;
  duplicate?: boolean;
  status?: EventAckStatus;
  sequence_status?: SequenceStatus;
  last_sequence?: number | null;
  next_sequence?: number | null;
  received_at?: string;
  error?: string;
}

export interface ErrorMessage {
  type: "error";
  schema_version: typeof RELAY_SCHEMA_VERSION;
  code: string;
  message: string;
  retryable?: boolean;
  request_id?: string;
}

export type ClientMessage =
  | HelloMessage
  | EventEnvelope
  | HeartbeatMessage
  | SubscribeMessage
  | ResumeMessage
  | ProbeMessage
  | ChallengeMessage
  | ChallengeAckMessage;

export type ServerMessage =
  | HelloAckMessage
  | EventEnvelope
  | EventAckMessage
  | HeartbeatMessage
  | SubscribeMessage
  | SnapshotMessage
  | ErrorMessage
  | ProbeMessage
  | ChallengeMessage
  | ChallengeAckMessage;

export interface ConnectionRecord {
  connection_id: string;
  gateway: Gateway;
  client_id: string;
  installation_id?: string;
  status: ConnectionStatus;
  connected_at: string;
  last_seen_at: string;
  disconnected_at?: string;
}

export interface InstallationState {
  installation_id: string;
  last_sequence: number | null;
  claude_state: ClaudeState;
  activity?: SnapshotActivity;
  updated_at: string;
  sessions?: SessionSummary[];
  running_count?: number;
  session_count?: number;
  recent_completion?: RecentCompletion;
}

export interface PairingRecord {
  pairing_id: string;
  code: string;
  created_at: string;
  expires_at: string;
  status: "pending" | "claimed" | "expired";
  installation_id: string;
  ws_url: string;
  relay_url?: string;
  public_url?: string;
  collector_token_hash: string;
  claimed_at?: string;
  android_token_hash?: string;
  device_name?: string;
}

export interface DeviceTokenRecord {
  token_id: string;
  role: TokenRole;
  installation_id: string;
  token_hash: string;
  issued_at: string;
  expires_at?: string;
  revoked_at?: string;
  device_name?: string;
}

export interface PairingCreateInput {
  installation_id: string;
  ws_url: string;
  relay_url?: string;
  public_url?: string;
  collector_token_hash: string;
}

export interface TokenValidation {
  token_id: string;
  role: TokenRole;
  installation_id: string;
  device_name?: string;
}

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}

export function isGateway(value: unknown): value is Gateway {
  return value === "collector" || value === "android";
}

export function isConnectionStatus(value: unknown): value is ConnectionStatus {
  return value === "online" || value === "stale" || value === "offline";
}
