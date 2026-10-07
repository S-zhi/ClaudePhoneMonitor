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

test("native Codex approval observations use stable UUIDs and cannot claim remote decisions or execution outcomes", () => {
  const requestId = "3fb68435-06fa-5c5e-8b01-aa17da927634";
  const nativePayload = { request_id: requestId, source: "codex", status: "pending", can_respond: false, tool_name: "Bash" } as const;
  const pending = { ...makeEvent(EVENT_TYPES.APPROVAL_REQUESTED, nativePayload), session_id: `codex:sess:${"a".repeat(64)}`,
    task_id: `codex:turn:${"b".repeat(64)}` };
  assert.equal(validateEventEnvelope(pending).success, true);
  assert.equal(validateProtocolMessage(pending).success, true);
  for (const status of ["resolved", "unknown"] as const) {
    assert.equal(validateEventEnvelope({ ...pending, event_type: EVENT_TYPES.APPROVAL_RESOLVED, payload: { ...nativePayload, status } }).success, true);
  }
  for (const invalid of [{ can_respond: true }, { status: "approved" }, { status: "denied" }, { expires_at: "2026-10-08T01:00:00Z" }, { command: "private" }]) {
    assert.equal(validateProtocolMessage({ ...pending, payload: { ...nativePayload, ...invalid } }).success, false);
  }
  const summary = { ...nativePayload, session_id: pending.session_id, task_id: pending.task_id, display_name: "Codex fixture",
    sequence: 1, requested_at: pending.occurred_at };
  assert.equal(validateSnapshot({ ...snapshot, approvals: [summary] }).success, true);
  assert.equal(validateSnapshot({ ...snapshot, approvals: [{ ...summary, status: "resolved" }] }).success, true);
  for (const invalid of [{ can_respond: true }, { status: "approved" }, { status: "denied" }]) {
    assert.equal(validateProtocolMessage({ ...snapshot, approvals: [{ ...summary, ...invalid }] }).success, false);
  }
  assert.equal(validateProtocolMessage({ type: "approval_presence", schema_version: 1, installation_id: "installation-1",
    source: "codex", request_ids: [requestId] }).success, true);
});

test("validates canonical event envelopes and snapshots", () => {
  const event = makeEvent(EVENT_TYPES.TOOL_STARTED, { tool_name: "bash" });
  const eventResult = validateEventEnvelope(event);
  const snapshotResult = validateSnapshot(snapshot);

  assert.equal(eventResult.success, true);
  assert.equal(snapshotResult.success, true);
  assert.equal(SNAPSHOT_SCHEMA.type, "object");
});

test("approval lifecycle has explicit identity and metadata-only request/decision contracts", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const decisionId = "22222222-2222-4222-8222-222222222222";
  const payload = { request_id: requestId, source: "claude_code" as const, status: "pending" as const,
    can_respond: true, tool_name: "Bash", expires_at: "2026-10-07T01:10:00Z" };
  assert.equal(validateEventEnvelope(makeEvent(EVENT_TYPES.APPROVAL_REQUESTED, payload)).success, true);
  for (const status of ["approved", "denied", "unknown"] as const) {
    assert.equal(validateEventEnvelope(makeEvent(EVENT_TYPES.APPROVAL_RESOLVED,
      { ...payload, status, can_respond: false })).success, true);
    assert.equal(validateEventEnvelope(makeEvent(EVENT_TYPES.APPROVAL_RESOLVED,
      { ...payload, status, can_respond: true } as never)).success, false);
  }
  for (const invalid of [{ request_id: "session-a" }, { source: "codex" }, { status: "approved" },
    { expires_at: "invalid" }, { can_respond: "true" }, { tool_input: { command: "private" } },
    { command: "private" }]) {
    assert.equal(validateEventPayload(EVENT_TYPES.APPROVAL_REQUESTED, { ...payload, ...invalid }).success, false);
  }
  for (const decision of ["allow", "deny", "computer"]) {
    assert.equal(validateProtocolMessage({ type: MESSAGE_TYPES.APPROVAL_DECISION, schema_version: 1,
      installation_id: "installation-a", request_id: requestId, decision_id: decisionId, decision }).success, true);
  }
  assert.equal(validateProtocolMessage({ type: MESSAGE_TYPES.APPROVAL_DECISION, schema_version: 1,
    installation_id: "installation-a", request_id: requestId, decision_id: decisionId, decision: "approve" }).success, false);
  assert.equal(validateProtocolMessage({ type: MESSAGE_TYPES.APPROVAL_DECISION_ACK, schema_version: 1,
    request_id: requestId, decision_id: decisionId, accepted: true, reason: "forwarded" }).success, true);
  assert.equal(validateProtocolMessage({ type: MESSAGE_TYPES.APPROVAL_PRESENCE, schema_version: 1,
    installation_id: "installation-a", request_ids: [requestId] }).success, true);
});

test("snapshot approvals remain independent of Working and reject ambiguous or invalid actions", () => {
  const approval = { request_id: "11111111-1111-4111-8111-111111111111", session_id: "outside-top-five",
    display_name: "Permission task", sequence: 3, requested_at: "2026-10-07T01:00:00Z",
    source: "claude_code", status: "pending", can_respond: true };
  assert.equal(validateSnapshot({ ...snapshot, approvals: [approval] }).success, true);
  assert.equal(validateSnapshot({ ...snapshot, approvals: [approval, approval] }).success, false);
  assert.equal(validateProtocolMessage({ ...snapshot, approvals: [approval, approval] }).success, false);
  for (const invalid of [{ request_id: "not-an-approval-uuid" }, { display_name: "/private/path" },
    { source: "codex" }, { session_id: "unknown" }, { requested_at: "invalid" }, { raw_prompt: "private" },
    { status: "approved", can_respond: true }]) {
    assert.equal(validateSnapshot({ ...snapshot, approvals: [{ ...approval, ...invalid }] }).success, false);
  }
  assert.equal(validateSnapshot({ ...snapshot, approvals: [{ ...approval, status: "denied", can_respond: false,
    resolved_at: "2026-10-07T01:02:00Z" }] }).success, true);
});

test("task timing remains optional and covers active tasks outside the five session rows", () => {
  const activeTasks = Array.from({ length: 6 }, (_, index) => ({
    session_id: `session-${index}`,
    ...(index === 0 ? {} : { task_id: `task-${index}` }),
    started_at: "2026-10-07T00:00:00.000Z",
    elapsed_ms: index === 0 ? 0 : 300_001,
  }));
  const recentCompletion = {
    session_id: "finished-session", task_id: "finished-task", sequence: 4,
    occurred_at: "2026-10-07T00:05:00.001Z", display_name: "Finished task", duration_ms: 300_001,
  };
  const timed = { ...snapshot, active_tasks: activeTasks, recent_completion: recentCompletion };
  assert.equal(validateSnapshot(snapshot).success, true);
  assert.equal(validateSnapshot(timed).success, true);
  assert.equal(validateProtocolMessage(timed).success, true);
  for (const invalid of [
    { elapsed_ms: -1 }, { elapsed_ms: 0.5 }, { elapsed_ms: Number.MAX_SAFE_INTEGER + 1 },
    { elapsed_ms: 86_400_001 }, { started_at: "not-a-date" }, { session_id: "unknown" },
    { raw_prompt: "private" },
  ]) {
    assert.equal(validateSnapshot({ ...timed, active_tasks: [{ ...activeTasks[0], ...invalid }] }).success, false);
  }
  for (const duration of [-1, 0.5, 86_400_001, "300001", null]) {
    assert.equal(validateSnapshot({ ...timed, recent_completion: { ...recentCompletion, duration_ms: duration } }).success, false);
  }
  assert.equal(validateSnapshot({ ...timed, active_tasks: [{ ...activeTasks[0], elapsed_ms: 86_400_000 }],
    recent_completion: { ...recentCompletion, duration_ms: 86_400_000 } }).success, true);
});

test("validates optional Usage snapshot and collector-only absolute message", () => {
  const extended = { ...snapshot, usage };
  assert.equal(validateSnapshot(extended).success, true);
  const recoveredQuota = {
    start_remaining: null,
    current_remaining: 60,
    unit: "percent" as const,
    reset_at: "2026-10-08T00:00:00.000Z",
    availability: "available" as const,
    limit_id: "codex" as const,
    source: "codex_app_server" as const,
    window_minutes: 10_080,
    sampled_at: "2026-10-07T00:00:00.000Z",
    window: "primary" as const,
  };
  assert.equal(validateUsageAggregate({ ...usage, quota: recoveredQuota }).success, true, "recovery after a failed startup read has no fabricated start metadata");
  assert.equal(validateUsageAggregate({ ...usage, quota: { ...recoveredQuota, start_remaining: 80 } }).success, false, "a start value requires startup sample metadata");
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

test("explicit blocking reasons survive snapshots only for waiting sessions, without questions or answers", () => {
  const row = { session_id: "s1", title: "Task", claude_state: "waiting", last_activity_sequence: 4 };
  for (const waiting_reason of ["permission", "question", "approval", "input"] as const) {
    assert.equal(validateSnapshot({ ...snapshot, sessions: [{ ...row, waiting_reason }] }).success, true);
    for (const claude_state of ["working", "idle"] as const) {
      assert.equal(validateSnapshot({ ...snapshot, sessions: [{ ...row, claude_state, waiting_reason }] }).success, false);
    }
  }
  assert.equal(validateSnapshot({ ...snapshot, sessions: [{ ...row, waiting_reason: "unknown" }] }).success, false);
  assert.equal(validateSnapshot({ ...snapshot, sessions: [{ ...row, waiting_reason: "question", question: "private" }] }).success, false);
  const question = { ...makeEvent(EVENT_TYPES.WAITING, { reason: "question", tool_name: "AskUserQuestion" }), correlation_id: "call-1" };
  assert.equal(validateEventEnvelope(question).success, true);
  assert.equal(validateEventEnvelope({ ...question, payload: { ...question.payload, answers: "private" } }).success, false);
  assert.equal(validateEventEnvelope({ ...question, payload: { ...question.payload, questions: [{ question: "private" }] } }).success, false);
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


test("durable task completion is an optional boolean session field", () => {
  const row = { session_id: "done", title: "Release", claude_state: "idle", last_activity_sequence: 4 };
  for (const task_completed of [true, false]) {
    assert.equal(validateSnapshot({ ...snapshot, sessions: [{ ...row, task_completed }] }).success, true);
  }
  assert.equal(validateSnapshot({ ...snapshot, sessions: [row] }).success, true);
  for (const task_completed of ["true", 1, null]) {
    assert.equal(validateSnapshot({ ...snapshot, sessions: [{ ...row, task_completed }] }).success, false);
  }
});
