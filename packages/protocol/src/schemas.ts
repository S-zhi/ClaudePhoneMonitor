import {
  CLAUDE_STATES,
  COMPUTER_STATES,
  EVENT_TYPES,
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
} from "./constants.js";
import type { JsonSchema, MonitorEventType } from "./types.js";

const idSchema: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
};

const sequenceSchema: JsonSchema = {
  type: "integer",
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
};

const safeTitlePattern = String.raw`^(?!.*(?:[Hh][Tt][Tt][Pp][Ss]?://|[/\\]|(?:[Aa][Pp][Ii][- _]?[Kk][Ee][Yy]|[Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn])\s*[:=]|[Bb][Ee][Aa][Rr][Ee][Rr]\s+[A-Za-z0-9._~+-]{8,}|(?:[Ss][Kk]-|[Gg][Hh][PpOoUuSsRr]_|[Gg][Ii][Tt][Hh][Uu][Bb]_[Pp][Aa][Tt]_|[Xx][Oo][Xx][BbAaPpRrSs]-)[A-Za-z0-9_-]{8,}|[Aa][Kk][Ii][Aa][0-9A-Za-z]{16}))[^\u0000-\u001F\u007F]+$`;
const safeTitleSchema: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  // No control characters, URLs, absolute paths, or credential assignments.
  pattern: safeTitlePattern,
};
const identifiedSessionIdSchema: JsonSchema = { ...idSchema, pattern: "^(?!unknown$).+" };

const wireTimestampSchema: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  format: "date-time",
};
const utcTimestampSchema: JsonSchema = { ...wireTimestampSchema, pattern: "Z$" };
const approvalIdSchema: JsonSchema = {
  type: "string",
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
};

const protocolHeader = (type: string): JsonSchema => ({
  type: "object",
  properties: {
    type: { const: type },
    schema_version: { const: PROTOCOL_VERSION },
  },
  required: ["type", "schema_version"],
});

const strictObject = (
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = [],
): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const nonNegativeIntegerSchema: JsonSchema = {
  type: "integer",
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
};
const nullableCountSchema: JsonSchema = {
  oneOf: [nonNegativeIntegerSchema, { type: "null" }],
};
const nullablePercentSchema: JsonSchema = {
  oneOf: [{ type: "number", minimum: 0, maximum: 100 }, { type: "null" }],
};
const usageMetricSchema: JsonSchema = strictObject(
  {
    value: nullableCountSchema,
    quality: { enum: ["complete", "partial", "unavailable"] },
  },
  ["value", "quality"],
);
const usageProviderCoverageSchema: JsonSchema = strictObject(
  {
    status: { enum: ["ready", "partial", "unavailable"] },
    observed_responses: nonNegativeIntegerSchema,
    complete_responses: nonNegativeIntegerSchema,
  },
  ["status", "observed_responses", "complete_responses"],
);
export const USAGE_AGGREGATE_SCHEMA: JsonSchema = strictObject(
  {
    epoch_id: idSchema,
    started_at: utcTimestampSchema,
    collector_started_at: utcTimestampSchema,
    revision: sequenceSchema,
    observed_responses: nonNegativeIntegerSchema,
    complete_responses: nonNegativeIntegerSchema,
    provider_coverage: strictObject(
      { claude: usageProviderCoverageSchema, codex: usageProviderCoverageSchema },
      ["claude", "codex"],
    ),
    new_input: usageMetricSchema,
    cached_input: usageMetricSchema,
    output: usageMetricSchema,
    actual: usageMetricSchema,
    total_input: usageMetricSchema,
    cache_hit: strictObject(
      {
        numerator: nullableCountSchema,
        denominator: nullableCountSchema,
        quality: { enum: ["complete", "partial", "unavailable"] },
        providers: { type: "array", items: { enum: ["claude", "codex"] }, minItems: 1, maxItems: 2, uniqueItems: true },
        sample_responses: nonNegativeIntegerSchema,
      },
      ["numerator", "denominator", "quality"],
    ),
    quota: strictObject(
      {
        start_remaining: nullablePercentSchema,
        current_remaining: nullablePercentSchema,
        unit: { enum: ["percent", null] },
        reset_at: { oneOf: [utcTimestampSchema, { type: "null" }] },
        availability: { enum: ["available", "stale", "unavailable"] },
        limit_id: { const: "codex" },
        source: { const: "codex_app_server" },
        window_minutes: { type: "integer", minimum: 1, maximum: 525600 },
        sampled_at: utcTimestampSchema,
        start_sampled_at: utcTimestampSchema,
        start_reset_at: utcTimestampSchema,
        window: { enum: ["primary", "secondary"] },
      },
      ["start_remaining", "current_remaining", "unit", "reset_at", "availability"],
    ),
  },
  ["epoch_id", "started_at", "revision", "observed_responses", "complete_responses", "provider_coverage", "new_input", "cached_input", "output", "actual", "total_input", "cache_hit", "quota"],
);

export const USAGE_SNAPSHOT_SCHEMA: JsonSchema = strictObject(
  {
    type: { const: MESSAGE_TYPES.USAGE_SNAPSHOT },
    schema_version: { const: PROTOCOL_VERSION },
    event_id: idSchema,
    installation_id: idSchema,
    sequence: sequenceSchema,
    occurred_at: wireTimestampSchema,
    usage: USAGE_AGGREGATE_SCHEMA,
  },
  ["type", "schema_version", "event_id", "installation_id", "sequence", "occurred_at", "usage"],
);



function approvalPayloadSchema(source: "claude_code" | "codex", requested: boolean): JsonSchema {
  return strictObject({
    request_id: approvalIdSchema,
    source: { const: source },
    status: requested ? { const: "pending" } : { enum: source === "codex" ? ["resolved", "unknown"] : ["approved", "denied", "unknown"] },
    can_respond: source === "codex" || !requested ? { const: false } : { type: "boolean" },
    ...(source === "claude_code" ? { expires_at: wireTimestampSchema } : {}),
    tool_name: { ...idSchema, maxLength: 128 },
  }, ["request_id", "source", "status", "can_respond"]);
}

const payloadSchemas: Record<MonitorEventType, JsonSchema> = {
  [EVENT_TYPES.SESSION_STARTED]: strictObject({}),
  [EVENT_TYPES.SESSION_TITLE_UPDATED]: strictObject({}),
  [EVENT_TYPES.SESSION_CLASSIFICATION_UPDATED]: strictObject({}),
  [EVENT_TYPES.TASK_STARTED]: strictObject({}),
  [EVENT_TYPES.TOOL_STARTED]: strictObject({
    tool_name: { ...idSchema, maxLength: 128 },
  }),
  [EVENT_TYPES.TOOL_FINISHED]: strictObject({
    tool_name: { ...idSchema, maxLength: 128 },
    duration_ms: { ...sequenceSchema, maximum: 86_400_000 },
    exit_code: { type: "integer", minimum: -255, maximum: 255 },
  }),
  [EVENT_TYPES.TOOL_FAILED]: strictObject({
    tool_name: { ...idSchema, maxLength: 128 },
    error_code: { ...idSchema, maxLength: 128 },
    duration_ms: { ...sequenceSchema, maximum: 86_400_000 },
    exit_code: { type: "integer", minimum: -255, maximum: 255 },
  }),
  [EVENT_TYPES.WAITING]: strictObject({
    tool_name: { ...idSchema, maxLength: 128 },
    reason: {
      enum: ["permission", "question", "approval", "input", "unknown"],
    },
  }),
  [EVENT_TYPES.APPROVAL_REQUESTED]: { oneOf: [approvalPayloadSchema("claude_code", true), approvalPayloadSchema("codex", true)] },
  [EVENT_TYPES.APPROVAL_RESOLVED]: { oneOf: [approvalPayloadSchema("claude_code", false), approvalPayloadSchema("codex", false)] },
  [EVENT_TYPES.TASK_FINISHED]: strictObject({
    duration_ms: { ...sequenceSchema, maximum: 86_400_000 },
    exit_code: { type: "integer", minimum: -255, maximum: 255 },
  }),
  [EVENT_TYPES.TASK_FAILED]: strictObject({
    error_code: { ...idSchema, maxLength: 128 },
    duration_ms: { ...sequenceSchema, maximum: 86_400_000 },
    exit_code: { type: "integer", minimum: -255, maximum: 255 },
  }),
  [EVENT_TYPES.SESSION_ENDED]: strictObject({
    reason: { enum: ["closed", "crashed", "shutdown", "unknown"] },
  }),
};

const eventProperties = (
  eventType: MonitorEventType,
): Readonly<Record<string, JsonSchema>> => ({
  type: { const: MESSAGE_TYPES.EVENT },
  schema_version: { const: PROTOCOL_VERSION },
  event_id: idSchema,
  installation_id: idSchema,
  session_id: [EVENT_TYPES.SESSION_CLASSIFICATION_UPDATED, EVENT_TYPES.APPROVAL_REQUESTED, EVENT_TYPES.APPROVAL_RESOLVED].some((type) => type === eventType) ? identifiedSessionIdSchema : idSchema,
  session_kind: { enum: ["main", "subagent"] },
  task_id: idSchema,
  ...([EVENT_TYPES.SESSION_STARTED, EVENT_TYPES.TASK_STARTED, EVENT_TYPES.TASK_FINISHED, EVENT_TYPES.SESSION_TITLE_UPDATED].some((type) => type === eventType)
    ? { session_title: safeTitleSchema } : {}),
  sequence: sequenceSchema,
  occurred_at: wireTimestampSchema,
  event_type: { const: eventType },
  payload: payloadSchemas[eventType],
  correlation_id: idSchema,
});

const eventSchemas = Object.fromEntries(
  (Object.values(EVENT_TYPES) as MonitorEventType[]).map((eventType) => [
    eventType,
    strictObject(
      eventProperties(eventType),
      [
        "type",
        "schema_version",
        "event_id",
        "installation_id",
        "session_id",
        "sequence",
        "occurred_at",
        "event_type",
        "payload",
        ...(eventType === EVENT_TYPES.SESSION_TITLE_UPDATED ? ["session_title"] : []),
        ...(eventType === EVENT_TYPES.SESSION_CLASSIFICATION_UPDATED ? ["session_kind"] : []),
      ],
    ),
  ]),
) as Record<MonitorEventType, JsonSchema>;

export const EVENT_PAYLOAD_SCHEMAS = payloadSchemas;
export const EVENT_SCHEMAS = eventSchemas;

export const EVENT_ENVELOPE_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://claude-phone-monitor.dev/protocol/v1/event",
  title: "Claude Phone Monitor event envelope",
  oneOf: Object.values(eventSchemas),
};
export const EVENT_SCHEMA = EVENT_ENVELOPE_SCHEMA;

export const SNAPSHOT_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://claude-phone-monitor.dev/protocol/v1/snapshot",
  title: "Claude Phone Monitor snapshot",
  ...strictObject(
    {
      type: { const: MESSAGE_TYPES.SNAPSHOT },
      schema_version: { const: PROTOCOL_VERSION },
      installation_id: idSchema,
      computer_state: { enum: Object.values(COMPUTER_STATES) },
      claude_state: { enum: Object.values(CLAUDE_STATES) },
      activity: {
        oneOf: [
          { type: "string", minLength: 1, maxLength: 256 },
          strictObject(
            {
              event_type: { enum: Object.values(EVENT_TYPES) },
              session_id: idSchema,
              task_id: idSchema,
              occurred_at: wireTimestampSchema,
            },
            ["event_type", "session_id", "occurred_at"],
          ),
        ],
      },
      sessions: {
        type: "array",
        maxItems: 5,
        items: strictObject(
          {
            session_id: identifiedSessionIdSchema,
            title: safeTitleSchema,
            session_kind: { enum: ["main", "subagent"] },
            claude_state: { enum: ["idle", "working", "waiting"] },
            task_completed: { type: "boolean" },
            waiting_reason: { enum: ["permission", "question", "approval", "input"] },
            last_activity_sequence: sequenceSchema,
          },
          ["session_id", "title", "claude_state", "last_activity_sequence"],
        ),
      },
      main_running_count: sequenceSchema,
      main_session_count: sequenceSchema,
      total_running_count: sequenceSchema,
      running_count: sequenceSchema,
      session_count: sequenceSchema,
      recent_completion: strictObject(
        {
          session_id: identifiedSessionIdSchema,
          task_id: idSchema,
          sequence: sequenceSchema,
          occurred_at: wireTimestampSchema,
          display_name: safeTitleSchema,
          duration_ms: { ...sequenceSchema, maximum: 86_400_000 },
        },
        ["session_id", "sequence", "occurred_at", "display_name"],
      ),
      active_tasks: {
        type: "array",
        items: strictObject(
          {
            session_id: identifiedSessionIdSchema,
            task_id: idSchema,
            started_at: wireTimestampSchema,
            elapsed_ms: { ...sequenceSchema, maximum: 86_400_000 },
          },
          ["session_id", "started_at", "elapsed_ms"],
        ),
      },
      approvals: {
        type: "array",
        items: strictObject({
          request_id: approvalIdSchema,
          session_id: identifiedSessionIdSchema,
          task_id: idSchema,
          display_name: safeTitleSchema,
          sequence: sequenceSchema,
          requested_at: wireTimestampSchema,
          resolved_at: wireTimestampSchema,
          expires_at: wireTimestampSchema,
          source: { enum: ["claude_code", "codex"] },
          status: { enum: ["pending", "approved", "denied", "resolved", "unknown"] },
          tool_name: { ...idSchema, maxLength: 128 },
          can_respond: { type: "boolean" },
        }, ["request_id", "session_id", "display_name", "sequence", "requested_at", "source", "status", "can_respond"]),
      },
      usage: USAGE_AGGREGATE_SCHEMA,
      last_sequence: { oneOf: [sequenceSchema, { type: "null" }] },
      updated_at: wireTimestampSchema,
    },
    [
      "type",
      "schema_version",
      "installation_id",
      "computer_state",
      "claude_state",
      "last_sequence",
      "updated_at",
    ],
  ),
};

export const MESSAGE_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  [MESSAGE_TYPES.HELLO]: {
    ...protocolHeader(MESSAGE_TYPES.HELLO),
    ...strictObject(
      {
        type: { const: MESSAGE_TYPES.HELLO },
        schema_version: { const: PROTOCOL_VERSION },
        installation_id: idSchema,
        client_id: idSchema,
        role: { enum: ["collector", "phone", "relay"] },
        last_sequence: sequenceSchema,
      },
      ["type", "schema_version", "installation_id"],
    ),
  },
  [MESSAGE_TYPES.HELLO_ACK]: {
    ...strictObject(
      {
        type: { const: MESSAGE_TYPES.HELLO_ACK },
        schema_version: { const: PROTOCOL_VERSION },
        connection_id: idSchema,
        accepted: { type: "boolean" },
        approval_bridge_available: { type: "boolean" },
        server_time: wireTimestampSchema,
        snapshot: SNAPSHOT_SCHEMA,
        resume: {
          oneOf: [
            strictObject(
              {
                status: { const: "resumed" },
                session_id: idSchema,
                replay_from: sequenceSchema,
                latest_sequence: sequenceSchema,
              },
              ["status", "session_id", "replay_from", "latest_sequence"],
            ),
            strictObject(
              {
                status: { const: "reset" },
                session_id: idSchema,
                reason: {
                  enum: ["session_mismatch", "history_expired", "sequence_ahead"],
                },
                snapshot_sequence: sequenceSchema,
              },
              ["status", "session_id", "reason", "snapshot_sequence"],
            ),
          ],
        },
      },
      ["type", "schema_version", "connection_id", "accepted", "server_time"],
    ),
  },
  [MESSAGE_TYPES.EVENT]: EVENT_ENVELOPE_SCHEMA,
  [MESSAGE_TYPES.USAGE_SNAPSHOT]: USAGE_SNAPSHOT_SCHEMA,
  [MESSAGE_TYPES.APPROVAL_DECISION]: strictObject({
    type: { const: MESSAGE_TYPES.APPROVAL_DECISION },
    schema_version: { const: PROTOCOL_VERSION },
    installation_id: idSchema,
    request_id: approvalIdSchema,
    decision_id: approvalIdSchema,
    decision: { enum: ["allow", "deny", "computer"] },
  }, ["type", "schema_version", "installation_id", "request_id", "decision_id", "decision"]),
  [MESSAGE_TYPES.APPROVAL_DECISION_ACK]: strictObject({
    type: { const: MESSAGE_TYPES.APPROVAL_DECISION_ACK },
    schema_version: { const: PROTOCOL_VERSION },
    request_id: approvalIdSchema,
    decision_id: approvalIdSchema,
    accepted: { type: "boolean" },
    reason: { enum: ["forwarded", "unavailable", "already_decided", "invalid_request", "forbidden"] },
  }, ["type", "schema_version", "request_id", "decision_id", "accepted"]),
  [MESSAGE_TYPES.APPROVAL_PRESENCE]: strictObject({
    type: { const: MESSAGE_TYPES.APPROVAL_PRESENCE },
    schema_version: { const: PROTOCOL_VERSION },
    installation_id: idSchema,
    request_ids: { type: "array", maxItems: 128, items: approvalIdSchema },
    source: { enum: ["claude_code", "codex"] },
  }, ["type", "schema_version", "installation_id", "request_ids"]),
  [MESSAGE_TYPES.EVENT_ACK]: strictObject(
    {
      type: { const: MESSAGE_TYPES.EVENT_ACK },
      schema_version: { const: PROTOCOL_VERSION },
      event_id: idSchema,
      sequence: sequenceSchema,
      accepted: { type: "boolean" },
      duplicate: { type: "boolean" },
    },
    ["type", "schema_version", "event_id", "sequence", "accepted"],
  ),
  [MESSAGE_TYPES.HEARTBEAT]: strictObject(
    {
      type: { const: MESSAGE_TYPES.HEARTBEAT },
      schema_version: { const: PROTOCOL_VERSION },
      sent_at: wireTimestampSchema,
      occurred_at: wireTimestampSchema,
      nonce: idSchema,
      role: { enum: ["collector", "phone", "relay"] },
      installation_id: idSchema,
      last_sequence: sequenceSchema,
    },
    ["type", "schema_version"],
  ),
  [MESSAGE_TYPES.SUBSCRIBE]: strictObject(
    {
      type: { const: MESSAGE_TYPES.SUBSCRIBE },
      schema_version: { const: PROTOCOL_VERSION },
      installation_id: idSchema,
      installation_ids: { type: "array", items: idSchema },
      session_id: idSchema,
      last_sequence: sequenceSchema,
      all: { type: "boolean" },
    },
    ["type", "schema_version"],
  ),
  [MESSAGE_TYPES.SNAPSHOT]: SNAPSHOT_SCHEMA,
  [MESSAGE_TYPES.RESUME]: strictObject(
    {
      type: { const: MESSAGE_TYPES.RESUME },
      schema_version: { const: PROTOCOL_VERSION },
      installation_id: idSchema,
      session_id: idSchema,
      last_sequence: sequenceSchema,
    },
    ["type", "schema_version", "installation_id", "last_sequence"],
  ),
  [MESSAGE_TYPES.PROBE]: strictObject(
    {
      type: { const: MESSAGE_TYPES.PROBE },
      schema_version: { const: PROTOCOL_VERSION },
      nonce: idSchema,
      probe_id: idSchema,
      timeout_ms: { type: "integer", minimum: 0, maximum: 300_000 },
    },
    ["type", "schema_version"],
  ),
  [MESSAGE_TYPES.CHALLENGE]: {
    oneOf: [
      strictObject(
        {
          type: { const: MESSAGE_TYPES.CHALLENGE },
          schema_version: { const: PROTOCOL_VERSION },
          challenge: idSchema,
          expires_at: wireTimestampSchema,
        },
        ["type", "schema_version", "challenge"],
      ),
      strictObject(
        {
          type: { const: MESSAGE_TYPES.CHALLENGE },
          schema_version: { const: PROTOCOL_VERSION },
          challenge_id: idSchema,
          probe_id: idSchema,
          nonce: idSchema,
        },
        ["type", "schema_version", "nonce"],
      ),
    ],
  },
  [MESSAGE_TYPES.CHALLENGE_ACK]: {
    oneOf: [
      strictObject(
        {
          type: { const: MESSAGE_TYPES.CHALLENGE_ACK },
          schema_version: { const: PROTOCOL_VERSION },
          challenge: idSchema,
          proof: idSchema,
        },
        ["type", "schema_version", "challenge", "proof"],
      ),
      strictObject(
        {
          type: { const: MESSAGE_TYPES.CHALLENGE_ACK },
          schema_version: { const: PROTOCOL_VERSION },
          challenge_id: idSchema,
          probe_id: idSchema,
          nonce: idSchema,
          signature: idSchema,
        },
        ["type", "schema_version", "nonce"],
      ),
    ],
  },
  [MESSAGE_TYPES.ERROR]: strictObject(
    {
      type: { const: MESSAGE_TYPES.ERROR },
      schema_version: { const: PROTOCOL_VERSION },
      code: { ...idSchema, maxLength: 128 },
      message: { type: "string", minLength: 1, maxLength: 512 },
      retryable: { type: "boolean" },
    },
    ["type", "schema_version", "code", "message"],
  ),
};

export const PROTOCOL_MESSAGE_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://claude-phone-monitor.dev/protocol/v1/message",
  title: "Claude Phone Monitor protocol message",
  oneOf: Object.values(MESSAGE_SCHEMAS),
};
export const MESSAGE_SCHEMA = PROTOCOL_MESSAGE_SCHEMA;

export const JSON_SCHEMAS = {
  event: EVENT_ENVELOPE_SCHEMA,
  snapshot: SNAPSHOT_SCHEMA,
  message: PROTOCOL_MESSAGE_SCHEMA,
  messages: MESSAGE_SCHEMAS,
  eventPayloads: EVENT_PAYLOAD_SCHEMAS,
} as const;
