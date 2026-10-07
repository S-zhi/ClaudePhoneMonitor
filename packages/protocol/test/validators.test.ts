import assert from "node:assert/strict";
import test from "node:test";
import {
  EVENT_TYPES,
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  SNAPSHOT_SCHEMA,
  validateEventEnvelope,
  validateEventPayload,
  validateProtocolMessage,
  validateSnapshot,
  validateUsageAggregate,
  parseProtocolMessage,
  type EventEnvelope,
  type EventPayload,
  type MonitorEventType,
  type ProtocolMessage,
  type Snapshot,
} from "../src/index.js";

function makeEvent<T extends MonitorEventType>(
  event_type: T,
  payload: EventPayload<T>,
  sequence = 1,
): EventEnvelope<T> {
  return {
    type: MESSAGE_TYPES.EVENT,
    schema_version: PROTOCOL_VERSION,
    event_id: `event-${sequence}`,
    installation_id: "installation-1",
    session_id: "session-1",
    sequence,
    occurred_at: new Date(sequence * 100).toISOString(),
    event_type,
    payload,
  };
}

const snapshot: Snapshot = {
  type: MESSAGE_TYPES.SNAPSHOT,
  schema_version: PROTOCOL_VERSION,
  installation_id: "installation-1",
  computer_state: "online",
  claude_state: "working",
  activity: "tool running",
  last_sequence: 4,
  updated_at: new Date(400).toISOString(),
};

const usage = {
  epoch_id: "epoch-1",
  started_at: "2026-10-07T00:00:00.000Z",
  revision: 3,
  observed_responses: 3,
  complete_responses: 2,
  provider_coverage: {
    claude: { status: "partial" as const, observed_responses: 1, complete_responses: 0 },
    codex: { status: "ready" as const, observed_responses: 2, complete_responses: 2 },
  },
  new_input: { value: 120, quality: "partial" as const },
  cached_input: { value: 35, quality: "partial" as const },
  output: { value: 65, quality: "partial" as const },
  actual: { value: 185, quality: "partial" as const },
  total_input: { value: 155, quality: "partial" as const },
  cache_hit: { numerator: 35, denominator: 155, quality: "partial" as const },
  quota: { start_remaining: null, current_remaining: null, unit: null, reset_at: null, availability: "unavailable" as const },
};

test("validates canonical event envelopes and snapshots", () => {
  const event = makeEvent(EVENT_TYPES.TOOL_STARTED, { tool_name: "bash" });
  const eventResult = validateEventEnvelope(event);
  const snapshotResult = validateSnapshot(snapshot);

  assert.equal(eventResult.success, true);
  assert.equal(snapshotResult.success, true);
  assert.equal(SNAPSHOT_SCHEMA.type, "object");
});

test("validates optional Usage snapshot and collector-only absolute message", () => {
  const extended = { ...snapshot, usage };
  assert.equal(validateSnapshot(extended).success, true);
  assert.equal(validateSnapshot({ ...extended, usage: { ...usage, observed_responses: Number.MAX_SAFE_INTEGER + 1 } }).success, false);
  assert.equal(validateSnapshot({ ...extended, usage: { ...usage, quota: { ...usage.quota, current_remaining: 10 } } }).success, false);
  assert.equal(validateSnapshot({ ...extended, usage: { ...usage, raw_prompt: "private" } }).success, false);

  const inbound = {
    type: MESSAGE_TYPES.USAGE_SNAPSHOT,
    schema_version: PROTOCOL_VERSION,
    event_id: "installation-1:43",
    installation_id: "installation-1",
    sequence: 43,
    occurred_at: "2026-10-07T00:01:00.000Z",
    usage,
  };
  assert.equal(validateProtocolMessage(inbound).success, true);
  assert.equal(validateProtocolMessage({ ...inbound, usage: { ...usage, complete_responses: 4 } }).success, false);
  assert.equal(validateUsageAggregate({ ...usage, actual: { value: 184, quality: "partial" } }).success, true, "partial metrics can describe different observed subsets");
  const completeUsage = {
    ...usage,
    observed_responses: 1,
    complete_responses: 1,
    provider_coverage: {
      claude: { status: "ready" as const, observed_responses: 1, complete_responses: 1 },
      codex: { status: "ready" as const, observed_responses: 0, complete_responses: 0 },
    },
    new_input: { value: 7, quality: "complete" as const },
    cached_input: { value: 3, quality: "complete" as const },
    output: { value: 4, quality: "complete" as const },
    actual: { value: 11, quality: "complete" as const },
    total_input: { value: 10, quality: "complete" as const },
    cache_hit: { numerator: 3, denominator: 10, quality: "complete" as const },
  };
  assert.equal(validateUsageAggregate(completeUsage).success, true);
  assert.equal(validateUsageAggregate({ ...completeUsage, actual: { value: 10, quality: "complete" } }).success, false);
  assert.equal(validateUsageAggregate({ ...completeUsage, complete_responses: 0, provider_coverage: { ...completeUsage.provider_coverage, claude: { status: "partial", observed_responses: 1, complete_responses: 0 } } }).success, false);
  assert.equal(validateUsageAggregate({ ...completeUsage, output: { value: null, quality: "unavailable" } }).success, false, "cache ratio cannot be complete when another observed response field is unavailable");
});

test("accepts the optional session contract while keeping its boundaries strict", () => {
  const started = { ...makeEvent(EVENT_TYPES.SESSION_STARTED, {}), session_title: "Release review" };
  assert.equal(validateEventEnvelope(started).success, true);
  assert.equal(validateEventEnvelope({ ...started, event_type: EVENT_TYPES.TASK_STARTED }).success, true);
  assert.equal(validateEventEnvelope({ ...started, event_type: EVENT_TYPES.TOOL_STARTED }).success, false);
  assert.equal(validateEventEnvelope({ ...started, session_title: "/private/path" }).success, false);

  const extended: Snapshot = {
    ...snapshot,
    sessions: [{
      session_id: "s1",
      title: "Release review",
      claude_state: "working",
      last_activity_sequence: 4,
    }],
    running_count: 1,
    session_count: 1,
    recent_completion: {
      session_id: "s1",
      task_id: "round-1",
      sequence: 3,
      occurred_at: new Date(300).toISOString(),
      display_name: "Release review",
    },
  };
  assert.equal(validateSnapshot(extended).success, true);
  assert.equal(validateSnapshot({ ...extended, sessions: Array.from({ length: 6 }, (_, i) => ({
    session_id: `s${i}`, title: "title", claude_state: "idle", last_activity_sequence: i,
  })) }).success, false);
  assert.equal(validateSnapshot({ ...extended, sessions: [{
    session_id: "unknown", title: "title", claude_state: "idle", last_activity_sequence: 0,
  }] }).success, false);
});

test("native lifecycle titles and metadata-only updates keep strict payload and privacy boundaries", () => {
  for (const event_type of [EVENT_TYPES.SESSION_STARTED, EVENT_TYPES.TASK_STARTED, EVENT_TYPES.TASK_FINISHED, EVENT_TYPES.SESSION_TITLE_UPDATED]) {
    const nativeTitle = { ...makeEvent(event_type, {}), session_title: "优化多 Session 标题" };
    assert.equal(validateEventEnvelope(nativeTitle).success, true, event_type);
    for (const session_title of ["/private/project", "https://example.test", "line\nbreak", "x".repeat(65), "Bearer abc.def12", "AKIA0123456789ABCDEF", "ghs_1234567890abcdef", "password=private"]) {
      assert.equal(validateEventEnvelope({ ...nativeTitle, session_title }).success, false, `${event_type}: ${session_title}`);
    }
  }
  const titleUpdate = { ...makeEvent(EVENT_TYPES.SESSION_TITLE_UPDATED, {}), session_title: "Native task title" };
  assert.equal(validateEventEnvelope({ ...titleUpdate, session_title: undefined }).success, false);
  assert.equal(validateEventEnvelope({ ...titleUpdate, payload: { title: "PRIVATE_PROMPT" } }).success, false);
  assert.equal(validateEventPayload(EVENT_TYPES.SESSION_TITLE_UPDATED, {}).success, true);
  assert.equal(validateEventPayload(EVENT_TYPES.SESSION_TITLE_UPDATED, { tool_name: "Read" }).success, false);
});

test("rejects case-insensitive URL and credential-like titles at both wire boundaries", () => {
  const unsafeTitles = [
    "HTTPS://example.test",
    "TOKEN=abc123",
    "ghp_1234567890abcdef",
    "github_pat_1234567890abcdef",
    "GHp_1234567890abcdef",
    "Bearer abcdef0123456789",
    "gho_1234567890abcdef",
    "xoxb-1234567890abcdef",
    "sk-1234567890abcdef",
    "review(/Users/alice/private)",
    "review=/Users/alice/private",
    "review:C:\\private\\project",
    "review=C:/private/project",
    "review(\\\\server\\share)",
    "review=/home/alice/private",
    "review|/Users/alice/private",
    "review-/Users/alice/private",
    "review\"/Users/alice/private\"",
    "review,/Users/alice/private",
    "review./Users/alice/private",
    "中文\\标题",
    "中文/标题",
  ];
  const started = makeEvent(EVENT_TYPES.SESSION_STARTED, {});
  const withSession = (title: string): Snapshot => ({
    ...snapshot,
    sessions: [{
      session_id: "s1",
      title,
      claude_state: "idle",
      last_activity_sequence: 1,
    }],
  });

  for (const title of unsafeTitles) {
    assert.equal(validateEventEnvelope({ ...started, session_title: title }).success, false, title);
    assert.equal(validateSnapshot(withSession(title)).success, false, title);
  }
  assert.equal(validateEventEnvelope({ ...started, session_title: "Release review" }).success, true);
  assert.equal(validateEventEnvelope({ ...started, session_title: "交付 计划 Review" }).success, true);
  assert.equal(validateSnapshot(withSession("交付 计划 Review")).success, true);
  assert.equal(validateSnapshot(snapshot).success, true, "legacy snapshot remains valid");
});

test("validates event payloads without allowing arbitrary fields", () => {
  const valid = validateEventPayload(EVENT_TYPES.WAITING, { reason: "permission" });
  const unknown = validateEventPayload(EVENT_TYPES.WAITING, {
    reason: "permission",
    prompt: "do the thing",
  });
  const toolResult = validateEventPayload(EVENT_TYPES.TOOL_FINISHED, {
    tool_name: "bash",
    result: "secret output",
  });

  assert.equal(valid.success, true);
  assert.equal(unknown.success, false);
  assert.equal(toolResult.success, false);
});

test("rejects prompt and tool content even when nested", () => {
  const event = makeEvent(EVENT_TYPES.TASK_STARTED, {
    prompt: "never forward this",
  } as never);
  const result = validateEventEnvelope(event);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.issues.some((issue) => issue.path.endsWith(".prompt")));
  }
});

test("recognizes every wire message discriminator", () => {
  const messages: ProtocolMessage[] = [
    {
      type: MESSAGE_TYPES.HELLO,
      schema_version: PROTOCOL_VERSION,
      installation_id: "installation-1",
      client_id: "phone-1",
    },
    {
      type: MESSAGE_TYPES.HEARTBEAT,
      schema_version: PROTOCOL_VERSION,
      sent_at: new Date(100).toISOString(),
    },
    snapshot,
    {
      type: MESSAGE_TYPES.RESUME,
      schema_version: PROTOCOL_VERSION,
      installation_id: "installation-1",
      session_id: "session-1",
      last_sequence: 4,
    },
    {
      type: MESSAGE_TYPES.PROBE,
      schema_version: PROTOCOL_VERSION,
      nonce: "nonce-1",
    },
    {
      type: MESSAGE_TYPES.ERROR,
      schema_version: PROTOCOL_VERSION,
      code: "BAD_REQUEST",
      message: "invalid message",
    },
  ];

  for (const message of messages) {
    assert.equal(validateProtocolMessage(message).success, true, message.type);
  }

  assert.deepEqual(
    parseProtocolMessage(JSON.stringify(messages[0])),
    messages[0],
  );
});

test("classification metadata requires a known identity, valid kind and empty payload", () => {
  const metadata = { ...makeEvent(EVENT_TYPES.SESSION_CLASSIFICATION_UPDATED, {}), session_kind: "subagent" };
  assert.equal(validateEventEnvelope(metadata).success, true);
  assert.equal(validateEventEnvelope({ ...metadata, session_kind: undefined }).success, false);
  assert.equal(validateEventEnvelope({ ...metadata, session_kind: "worker" }).success, false);
  assert.equal(validateEventEnvelope({ ...metadata, session_id: "unknown" }).success, false);
  assert.equal(validateEventEnvelope({ ...metadata, payload: { reason: "input" } }).success, false);
  assert.equal(validateEventEnvelope({ ...makeEvent(EVENT_TYPES.TASK_STARTED, {}), session_kind: "main" }).success, true);
  assert.equal(validateSnapshot({ ...snapshot, main_running_count: 0, main_session_count: 0, total_running_count: 3 }).success, true);
  assert.equal(validateSnapshot({ ...snapshot, total_running_count: -1 }).success, false);
});
