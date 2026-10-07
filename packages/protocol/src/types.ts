import {
  CLAUDE_STATES,
  COMPUTER_STATES,
  EVENT_TYPES,
  MESSAGE_TYPES,
  MONITOR_STATUS,
  PROTOCOL_VERSION,
} from "./constants.js";

export type ProtocolVersion = typeof PROTOCOL_VERSION;
export type SequenceNumber = number;
/** Epoch milliseconds used by the pure reducer and timer helpers. */
export type Timestamp = number;
/** Wire timestamps are ISO-8601 strings; validators also document this boundary. */
export type WireTimestamp = string;

export type MonitorStatus = (typeof MONITOR_STATUS)[keyof typeof MONITOR_STATUS];
export type BaseMonitorStatus =
  | typeof MONITOR_STATUS.IDLE
  | typeof MONITOR_STATUS.WORKING
  | typeof MONITOR_STATUS.WAITING
  | typeof MONITOR_STATUS.OFFLINE;
export type TransientMonitorStatus =
  | typeof MONITOR_STATUS.FINISH
  | typeof MONITOR_STATUS.ERROR;
export type ProtocolMessageType =
  (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];
export type MonitorEventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
export type EventType = MonitorEventType;
export type ComputerState = (typeof COMPUTER_STATES)[keyof typeof COMPUTER_STATES];
export type ConnectionStatus = ComputerState;
export type ClaudeState = (typeof CLAUDE_STATES)[keyof typeof CLAUDE_STATES];
export type SessionKind = "main" | "subagent";
export type WaitingReason = "permission" | "question" | "approval" | "input" | "unknown";
export type ApprovalStatus = "pending" | "approved" | "denied" | "resolved" | "unknown";
export type ApprovalSource = "claude_code" | "codex";
export type ApprovalDecision = "allow" | "deny" | "computer";

/** Metadata only: the original operation must be reviewed on the computer. */
export interface ApprovalSummary {
  readonly request_id: string;
  readonly session_id: string;
  readonly task_id?: string;
  readonly display_name: string;
  readonly sequence: SequenceNumber;
  readonly requested_at: WireTimestamp;
  readonly resolved_at?: WireTimestamp;
  readonly expires_at?: WireTimestamp;
  readonly source: ApprovalSource;
  readonly status: ApprovalStatus;
  readonly tool_name?: string;
  readonly can_respond: boolean;
}
export type SequenceStatus = "initial" | "in_order" | "gap" | "out_of_order";
export type EventAckStatus = "accepted" | "duplicate" | "rejected";

/** Allowlisted metadata shape shared by collector normalizers and envelopes. */
export interface SafeEventPayload {
  readonly tool_name?: string;
  readonly duration_ms?: number;
  readonly exit_code?: number;
  readonly error_code?: string;
  readonly reason?: WaitingReason;
  readonly request_id?: string;
  readonly source?: ApprovalSource;
  readonly status?: ApprovalStatus;
  readonly can_respond?: boolean;
  readonly expires_at?: WireTimestamp;
}

export interface NormalizedEvent {
  readonly event_type: MonitorEventType;
  readonly session_id: string;
  readonly task_id?: string;
  /** Safe native session/task label; never derived from prompts or paths. */
  readonly session_title?: string;
  readonly session_kind?: SessionKind;
  readonly occurred_at: WireTimestamp;
  readonly payload: SafeEventPayload;
  readonly correlation_id?: string;
}

export type EmptyPayload = Readonly<Record<string, never>>;

/** Only sanitized metadata crosses the event boundary; never prompt/tool input/result. */
export interface EventPayloadByType {
  readonly [EVENT_TYPES.SESSION_STARTED]: EmptyPayload;
  readonly [EVENT_TYPES.SESSION_CLASSIFICATION_UPDATED]: EmptyPayload;
  readonly [EVENT_TYPES.SESSION_TITLE_UPDATED]: EmptyPayload;
  readonly [EVENT_TYPES.TASK_STARTED]: EmptyPayload;
  readonly [EVENT_TYPES.TOOL_STARTED]: {
    readonly tool_name?: string;
  };
  readonly [EVENT_TYPES.TOOL_FINISHED]: {
    readonly tool_name?: string;
    readonly duration_ms?: number;
    readonly exit_code?: number;
  };
  readonly [EVENT_TYPES.TOOL_FAILED]: {
    readonly tool_name?: string;
    readonly error_code?: string;
    readonly duration_ms?: number;
    readonly exit_code?: number;
  };
  readonly [EVENT_TYPES.WAITING]: {
    readonly reason?: WaitingReason;
    readonly tool_name?: string;
  };
  readonly [EVENT_TYPES.APPROVAL_REQUESTED]: {
    readonly request_id: string;
    readonly source: ApprovalSource;
    readonly status: "pending";
    readonly can_respond: boolean;
    readonly expires_at?: WireTimestamp;
    readonly tool_name?: string;
  };
  readonly [EVENT_TYPES.APPROVAL_RESOLVED]: {
    readonly request_id: string;
    readonly source: ApprovalSource;
    readonly status: Exclude<ApprovalStatus, "pending">;
    readonly can_respond: false;
    readonly expires_at?: WireTimestamp;
    readonly tool_name?: string;
  };
  readonly [EVENT_TYPES.TASK_FINISHED]: {
    readonly duration_ms?: number;
    readonly exit_code?: number;
  };
  readonly [EVENT_TYPES.TASK_FAILED]: {
    readonly error_code?: string;
    readonly duration_ms?: number;
    readonly exit_code?: number;
  };
  readonly [EVENT_TYPES.SESSION_ENDED]: {
    readonly reason?: "closed" | "crashed" | "shutdown" | "unknown";
  };
}

export type EventPayload<T extends MonitorEventType> = EventPayloadByType[T];

export interface EventEnvelopeBase<T extends MonitorEventType = MonitorEventType> {
  readonly type: typeof MESSAGE_TYPES.EVENT;
  readonly schema_version: ProtocolVersion;
  readonly event_id: string;
  readonly installation_id: string;
  readonly session_id: string;
  readonly task_id?: string;
  readonly session_title?: string;
  readonly session_kind?: SessionKind;
  readonly sequence: SequenceNumber;
  readonly occurred_at: WireTimestamp;
  readonly event_type: T;
  readonly payload: EventPayload<T>;
  readonly correlation_id?: string;
}

export type EventEnvelope<T extends MonitorEventType = MonitorEventType> = {
  [K in T]: EventEnvelopeBase<K>;
}[T];

export type MonitorEvent = EventEnvelope;

export interface SnapshotActivity {
  readonly event_type: MonitorEventType;
  readonly session_id: string;
  readonly task_id?: string;
  readonly occurred_at: WireTimestamp;
}

export interface SessionSummary {
  readonly session_kind?: SessionKind;
  readonly session_id: string;
  readonly title: string;
  readonly claude_state: ClaudeState;
  readonly waiting_reason?: Exclude<WaitingReason, "unknown">;
  readonly last_activity_sequence: SequenceNumber;
}

export interface RecentCompletion {
  readonly session_id: string;
  readonly task_id?: string;
  readonly sequence: SequenceNumber;
  readonly occurred_at: WireTimestamp;
  readonly display_name: string;
  readonly duration_ms?: number;
}

/** Task timing is independent of the five-row session presentation limit. */
export interface ActiveTask {
  readonly session_id: string;
  readonly task_id?: string;
  readonly started_at: WireTimestamp;
  readonly elapsed_ms: number;
}

export interface Snapshot {
  readonly type: typeof MESSAGE_TYPES.SNAPSHOT;
  readonly schema_version: ProtocolVersion;
  readonly installation_id: string;
  readonly computer_state: ComputerState;
  readonly claude_state: ClaudeState;
  /** Short, sanitized label or event metadata; never a prompt/tool input/result. */
  readonly activity?: string | SnapshotActivity;
  readonly sessions?: readonly SessionSummary[];
  readonly main_running_count?: number;
  readonly main_session_count?: number;
  readonly total_running_count?: number;
  readonly running_count?: number;
  readonly session_count?: number;
  readonly recent_completion?: RecentCompletion;
  readonly active_tasks?: readonly ActiveTask[];
  /** Explicit bridge lifecycle; missing on older or observation-only sources. */
  readonly approvals?: readonly ApprovalSummary[];
  /** Optional server-authoritative Usage aggregate; older clients may ignore it. */
  readonly usage?: UsageAggregate;
  readonly last_sequence: SequenceNumber | null;
  readonly updated_at: WireTimestamp;
}

export type UsageQuality = "complete" | "partial" | "unavailable";
export type UsageCoverageStatus = "ready" | "partial" | "unavailable";

export interface UsageMetric {
  readonly value: number | null;
  readonly quality: UsageQuality;
}

export interface UsageProviderCoverage {
  readonly status: UsageCoverageStatus;
  readonly observed_responses: number;
  readonly complete_responses: number;
}

export interface UsageAggregate {
  readonly epoch_id: string;
  readonly started_at: WireTimestamp;
  readonly revision: SequenceNumber;
  readonly observed_responses: number;
  readonly complete_responses: number;
  readonly provider_coverage: Readonly<{
    claude: UsageProviderCoverage;
    codex: UsageProviderCoverage;
  }>;
  readonly new_input: UsageMetric;
  readonly cached_input: UsageMetric;
  readonly output: UsageMetric;
  readonly actual: UsageMetric;
  readonly total_input: UsageMetric;
  readonly cache_hit: Readonly<{
    numerator: number | null;
    denominator: number | null;
    quality: UsageQuality;
  }>;
  readonly quota: Readonly<{
    start_remaining: null;
    current_remaining: null;
    unit: null;
    reset_at: null;
    availability: "unavailable";
  }>;
}

/** Collector-only absolute aggregate message. Relay never broadcasts this message. */
export interface UsageSnapshotMessage {
  readonly type: typeof MESSAGE_TYPES.USAGE_SNAPSHOT;
  readonly schema_version: ProtocolVersion;
  readonly event_id: string;
  readonly installation_id: string;
  readonly sequence: SequenceNumber;
  readonly occurred_at: WireTimestamp;
  readonly usage: UsageAggregate;
}

export type MonitorSnapshot = Snapshot;

export interface HelloMessage {
  readonly type: typeof MESSAGE_TYPES.HELLO;
  readonly schema_version: ProtocolVersion;
  readonly installation_id: string;
  readonly client_id?: string;
  readonly role?: "collector" | "phone" | "relay";
  readonly last_sequence?: SequenceNumber;
}

export interface HelloAckMessage {
  readonly type: typeof MESSAGE_TYPES.HELLO_ACK;
  readonly schema_version: ProtocolVersion;
  readonly connection_id: string;
  readonly accepted: boolean;
  readonly approval_bridge_available?: boolean;
  readonly server_time: WireTimestamp;
  readonly installation_id?: string;
  readonly snapshot?: Snapshot;
  readonly resume?: ResumeResult;
}

export type EventMessage = EventEnvelope;

export interface EventAckMessage {
  readonly type: typeof MESSAGE_TYPES.EVENT_ACK;
  readonly schema_version: ProtocolVersion;
  readonly event_id: string;
  readonly sequence: SequenceNumber;
  readonly accepted: boolean;
  readonly duplicate?: boolean;
}

export interface HeartbeatMessage {
  readonly type: typeof MESSAGE_TYPES.HEARTBEAT;
  readonly schema_version: ProtocolVersion;
  readonly sent_at?: WireTimestamp;
  readonly occurred_at?: WireTimestamp;
  readonly nonce?: string;
  readonly role?: "collector" | "phone" | "relay";
  readonly installation_id?: string;
  readonly last_sequence?: SequenceNumber;
}

export interface SubscribeMessage {
  readonly type: typeof MESSAGE_TYPES.SUBSCRIBE;
  readonly schema_version: ProtocolVersion;
  readonly installation_id?: string;
  readonly installation_ids?: readonly string[];
  readonly session_id?: string;
  readonly last_sequence?: SequenceNumber;
  readonly all?: boolean;
}

export interface ResumeMessage {
  readonly type: typeof MESSAGE_TYPES.RESUME;
  readonly schema_version: ProtocolVersion;
  readonly installation_id: string;
  readonly session_id?: string;
  readonly last_sequence: SequenceNumber;
}

export interface ProbeMessage {
  readonly type: typeof MESSAGE_TYPES.PROBE;
  readonly schema_version: ProtocolVersion;
  readonly nonce?: string;
  readonly probe_id?: string;
  readonly timeout_ms?: number;
}

export interface ChallengeMessage {
  readonly type: typeof MESSAGE_TYPES.CHALLENGE;
  readonly schema_version: ProtocolVersion;
  readonly challenge?: string;
  readonly challenge_id?: string;
  readonly probe_id?: string;
  readonly nonce?: string;
  readonly expires_at?: WireTimestamp;
}

export interface ChallengeAckMessage {
  readonly type: typeof MESSAGE_TYPES.CHALLENGE_ACK;
  readonly schema_version: ProtocolVersion;
  readonly challenge?: string;
  readonly challenge_id?: string;
  readonly probe_id?: string;
  readonly nonce?: string;
  readonly proof?: string;
  readonly signature?: string;
}

export interface ErrorMessage {
  readonly type: typeof MESSAGE_TYPES.ERROR;
  readonly schema_version: ProtocolVersion;
  readonly code: string;
  /** Generic protocol diagnostic; do not put Claude content here. */
  readonly message: string;
  readonly retryable?: boolean;
}

export interface ApprovalDecisionMessage {
  readonly type: typeof MESSAGE_TYPES.APPROVAL_DECISION;
  readonly schema_version: ProtocolVersion;
  readonly installation_id: string;
  readonly request_id: string;
  readonly decision_id: string;
  readonly decision: ApprovalDecision;
}

/** Transport acknowledgement only. It never proves the Hook returned a decision. */
export interface ApprovalDecisionAckMessage {
  readonly type: typeof MESSAGE_TYPES.APPROVAL_DECISION_ACK;
  readonly schema_version: ProtocolVersion;
  readonly request_id: string;
  readonly decision_id: string;
  readonly accepted: boolean;
  readonly reason?: "forwarded" | "unavailable" | "already_decided" | "invalid_request" | "forbidden";
}

/** Live bridge ownership; replayed events never establish decision availability. */
export interface ApprovalPresenceMessage {
  readonly type: typeof MESSAGE_TYPES.APPROVAL_PRESENCE;
  readonly schema_version: ProtocolVersion;
  readonly installation_id: string;
  readonly request_ids: readonly string[];
  readonly source?: ApprovalSource;
}

export type ProtocolMessage =
  | HelloMessage
  | HelloAckMessage
  | EventMessage
  | EventAckMessage
  | HeartbeatMessage
  | SubscribeMessage
  | Snapshot
  | UsageSnapshotMessage
  | ResumeMessage
  | ProbeMessage
  | ChallengeMessage
  | ChallengeAckMessage
  | ApprovalDecisionMessage
  | ApprovalDecisionAckMessage
  | ApprovalPresenceMessage
  | ErrorMessage;

export type ClientMessage =
  | HelloMessage
  | EventMessage
  | UsageSnapshotMessage
  | SubscribeMessage
  | ResumeMessage
  | ProbeMessage
  | ChallengeAckMessage
  | ApprovalDecisionMessage
  | ApprovalPresenceMessage
  | HeartbeatMessage;
export type ServerMessage =
  | HelloAckMessage
  | EventAckMessage
  | EventMessage
  | HeartbeatMessage
  | Snapshot
  | ProbeMessage
  | ChallengeMessage
  | ApprovalDecisionAckMessage
  | ApprovalDecisionMessage
  | ErrorMessage;

export interface TransientOverlay {
  readonly status: TransientMonitorStatus;
  readonly started_at: Timestamp;
  readonly expires_at: Timestamp;
  readonly message?: string;
}

/**
 * Reducer state deliberately keeps a durable base and a time-bounded overlay
 * separate. `effectiveMonitorStatus` is the only value the UI should render.
 */
export interface MonitorState {
  readonly base_status: BaseMonitorStatus;
  readonly overlay: TransientOverlay | null;
  readonly last_sequence: SequenceNumber;
  readonly updated_at: Timestamp;
}

export type MonitorAction =
  | { readonly type: "event"; readonly event: EventEnvelope }
  | { readonly type: "snapshot"; readonly snapshot: Snapshot }
  | { readonly type: "tick"; readonly at: Timestamp }
  | {
      readonly type: "base";
      readonly status: BaseMonitorStatus;
      readonly at: Timestamp;
      readonly sequence?: SequenceNumber;
    }
  | {
      readonly type: "overlay";
      readonly status: TransientMonitorStatus;
      readonly at: Timestamp;
      readonly message?: string;
      readonly sequence?: SequenceNumber;
    }
  | { readonly type: "reset"; readonly at: Timestamp; readonly sequence?: SequenceNumber };

export type ResumeResetReason =
  | "session_mismatch"
  | "history_expired"
  | "sequence_ahead";

export type ResumeResult =
  | {
      readonly status: "resumed";
      readonly session_id: string;
      /** Inclusive sequence of the first event to replay. */
      readonly replay_from: SequenceNumber;
      readonly latest_sequence: SequenceNumber;
    }
  | {
      readonly status: "reset";
      readonly session_id: string;
      readonly reason: ResumeResetReason;
      /** Snapshot sequence to use as the new resume cursor. */
      readonly snapshot_sequence: SequenceNumber;
    };

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly issues: readonly ValidationIssue[] };

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface JsonSchema {
  readonly $schema?: string;
  readonly $id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  readonly const?: JsonPrimitive;
  readonly enum?: readonly JsonPrimitive[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly maxItems?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
  readonly format?: string;
}

export interface SequenceDecision {
  readonly accepted: boolean;
  readonly disposition: "next" | "duplicate" | "stale" | "gap";
  readonly previous: SequenceNumber;
  readonly incoming: SequenceNumber;
  readonly next: SequenceNumber;
}
