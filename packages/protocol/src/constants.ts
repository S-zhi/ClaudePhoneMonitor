export const PROTOCOL_VERSION = 1 as const;
export const SCHEMA_VERSION = PROTOCOL_VERSION;
export const RELAY_SCHEMA_VERSION = PROTOCOL_VERSION;

export const MESSAGE_TYPES = {
  HELLO: "hello",
  HELLO_ACK: "hello_ack",
  EVENT: "event",
  EVENT_ACK: "event_ack",
  HEARTBEAT: "heartbeat",
  SUBSCRIBE: "subscribe",
  SNAPSHOT: "snapshot",
  RESUME: "resume",
  PROBE: "probe",
  CHALLENGE: "challenge",
  CHALLENGE_ACK: "challenge_ack",
  USAGE_SNAPSHOT: "usage_snapshot",
  APPROVAL_DECISION: "approval_decision",
  APPROVAL_DECISION_ACK: "approval_decision_ack",
  APPROVAL_PRESENCE: "approval_presence",
  ERROR: "error",
} as const;

/** Alias that makes the wire-level vocabulary explicit at call sites. */
export const WS_MESSAGE_TYPES = MESSAGE_TYPES;
export const MESSAGE_TYPE = MESSAGE_TYPES;
export const MESSAGE_TYPE_VALUES = Object.values(MESSAGE_TYPES) as readonly string[];
export const ALL_MESSAGE_TYPES = MESSAGE_TYPE_VALUES;

export const EVENT_TYPES = {
  SESSION_STARTED: "session_started",
  SESSION_CLASSIFICATION_UPDATED: "session_classification_updated",
  SESSION_TITLE_UPDATED: "session_title_updated",
  TASK_STARTED: "task_started",
  TOOL_STARTED: "tool_started",
  TOOL_FINISHED: "tool_finished",
  TOOL_FAILED: "tool_failed",
  WAITING: "waiting",
  APPROVAL_REQUESTED: "approval_requested",
  APPROVAL_RESOLVED: "approval_resolved",
  TASK_FINISHED: "task_finished",
  TASK_FAILED: "task_failed",
  SESSION_ENDED: "session_ended",
} as const;

export const EVENT_TYPE = EVENT_TYPES;
export const EVENT_TYPE_VALUES = Object.values(EVENT_TYPES) as readonly string[];
export const ALL_EVENT_TYPES = EVENT_TYPE_VALUES;

export const MONITOR_STATUS = {
  IDLE: "IDLE",
  WORKING: "WORKING",
  WAITING: "WAITING",
  FINISH: "FINISH",
  ERROR: "ERROR",
  OFFLINE: "OFFLINE",
} as const;

export const STATUS = MONITOR_STATUS;

export const COMPUTER_STATES = {
  ONLINE: "online",
  STALE: "stale",
  OFFLINE: "offline",
} as const;

export const CLAUDE_STATES = {
  IDLE: "idle",
  WORKING: "working",
  WAITING: "waiting",
} as const;

export const TRANSIENT_DURATIONS_MS = {
  [MONITOR_STATUS.FINISH]: 5_000,
  [MONITOR_STATUS.ERROR]: 10_000,
} as const;

export const FINISH_DURATION_MS = TRANSIENT_DURATIONS_MS[MONITOR_STATUS.FINISH];
export const ERROR_DURATION_MS = TRANSIENT_DURATIONS_MS[MONITOR_STATUS.ERROR];

/** Higher entries win when multiple base/activity signals are present. */
export const STATUS_PRECEDENCE = [
  MONITOR_STATUS.OFFLINE,
  MONITOR_STATUS.ERROR,
  MONITOR_STATUS.WORKING,
  MONITOR_STATUS.WAITING,
  MONITOR_STATUS.IDLE,
] as const;

/** Keys that must never cross the monitor protocol boundary. */
export const FORBIDDEN_FORWARD_KEYS = [
  "prompt",
  "prompt_text",
  "prompt_input",
  "user_prompt",
  "input",
  "tool_input",
  "toolinput",
  "tool_result",
  "toolresult",
  "tool_response",
  "result",
  "output",
  "stdout",
  "stderr",
  "error",
  "stack",
  "transcript_path",
  "command",
  "args",
  "arguments",
] as const;
