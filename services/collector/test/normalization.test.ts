import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { normalizeHookEvent, safeSessionTitle } from "../src/normalize.ts";
import { Collector } from "../src/collector.ts";
import { isSafeEventPayload } from "../src/types.ts";

const now = new Date("2026-10-02T11:00:00.000Z");

test("normalization maps hook lifecycle names to canonical v1 event types", () => {
  const cases: Array<[string, string]> = [
    ["SessionStart", "session_started"],
    ["SessionTitleUpdated", "session_title_updated"],
    ["PreToolUse", "tool_started"],
    ["PostToolUse", "tool_finished"],
    ["PostToolUseFailure", "tool_failed"],
    ["UserPromptSubmit", "task_started"],
    ["Stop", "task_finished"],
    ["StopFailure", "task_failed"],
    ["Notification", "waiting"],
    ["PermissionRequest", "waiting"],
    ["SessionEnd", "session_ended"],
  ];

  for (const [hook_event_name, event_type] of cases) {
    const normalized = normalizeHookEvent({ hook_event_name, session_id: "s1", ...(hook_event_name === "SessionTitleUpdated" ? { session_title: "Native task title" } : {}) }, { now });
    assert.equal(normalized?.event_type, event_type, hook_event_name);
  }
});

test("canonical event_type and allowlisted payload survive local socket normalization", () => {
  const normalized = normalizeHookEvent(
    {
      event_type: "tool_finished",
      session_id: "s1",
      task_id: "t1",
      correlation_id: "c1",
      occurred_at: "2026-10-02T10:59:00Z",
      payload: {
        tool_name: "Read",
        duration_ms: 7,
        exit_code: 0,
        prompt: "must be ignored",
        stdout: "must be ignored",
      },
    },
    { now },
  );

  assert.deepEqual(normalized, {
    event_type: "tool_finished",
    session_id: "s1",
    task_id: "t1",
    correlation_id: "c1",
    occurred_at: "2026-10-02T10:59:00.000Z",
    payload: { tool_name: "Read", duration_ms: 7, exit_code: 0 },
  });
});

test("explicit permission and input notifications retain only a verified waiting reason", () => {
  for (const [hook, notificationType, expected] of [
    ["PermissionRequest", undefined, "permission"],
    ["Notification", "permission_prompt", "permission"],
    ["Notification", "elicitation_dialog", "input"],
    ["Notification", "elicitation_url_dialog", "input"],
    ["Notification", "agent_needs_input", "input"],
  ] as const) {
    const first = normalizeHookEvent({ hook_event_name: hook, notification_type: notificationType,
      session_id: "s1", message: "private notification text", title: "private title" }, { now });
    assert.ok(first);
    assert.deepEqual(first.payload, { reason: expected });
    assert.equal(isSafeEventPayload(first.payload), true);
    assert.deepEqual(normalizeHookEvent(first, { now })?.payload, { reason: expected }, "local socket normalization preserves the reason");
    assert.equal(JSON.stringify(first).includes("private"), false);
  }
  for (const notificationType of [undefined, "idle_prompt", "auth_success", "agent_completed", "elicitation_complete", "unknown-kind"]) {
    const normalized = normalizeHookEvent({ hook_event_name: "Notification", notification_type: notificationType,
      session_id: "s1", message: "permission approval input needed", payload: { reason: "unverified-private-reason" } }, { now });
    assert.equal(normalized?.event_type, "waiting");
    assert.deepEqual(normalized.payload, {}, "ordinary notification content never proves an explicit wait");
  }
  for (const reason of ["permission", "question", "approval", "input", "unknown"] as const) {
    assert.deepEqual(normalizeHookEvent({ event_type: "waiting", session_id: "s1", payload: { reason } }, { now })?.payload, { reason });
  }
  assert.equal(isSafeEventPayload({ reason: "unverified" }), false);
  assert.equal(isSafeEventPayload({ reason: { permission: true } }), false);
  assert.deepEqual(normalizeHookEvent({ event_type: "tool_started", session_id: "s1", payload: { reason: "permission" } }, { now })?.payload, {});
});

test("unknown hook names are dropped rather than forwarded", () => {
  assert.equal(normalizeHookEvent({ hook_event_name: "UnknownHook", session_id: "s1" }, { now }), null);
  assert.equal(normalizeHookEvent({ prompt: "only user data" }, { now }), null);
});

test("native questions and plan reviews are explicit waiting signals without question/answer content", () => {
  for (const [tool_name, reason] of [["AskUserQuestion", "question"], ["ExitPlanMode", "approval"]] as const) {
    for (const hook_event_name of ["PreToolUse", "PermissionRequest"] as const) {
      const normalized = normalizeHookEvent({ hook_event_name, session_id: "s1", task_id: "task-1", tool_name,
        tool_use_id: "tool-call-1", tool_input: { questions: [{ question: "private question" }], answers: { question: "private answer" },
          plan: "private plan", planFilePath: "/Users/private/plan.md" }, tool_response: "private answer" }, { now });
      assert.ok(normalized);
      assert.equal(normalized.event_type, "waiting");
      assert.equal(normalized.correlation_id, "tool-call-1");
      assert.deepEqual(normalized.payload, { tool_name, reason });
      assert.deepEqual(normalizeHookEvent(normalized, { now }), normalized, "daemon normalization must preserve exact metadata");
      assert.equal(JSON.stringify(normalized).includes("private"), false);
    }
    for (const [hook_event_name, expected] of [["PostToolUse", "tool_finished"], ["PostToolUseFailure", "tool_failed"]] as const) {
      const normalized = normalizeHookEvent({ hook_event_name, session_id: "s1", tool_name, tool_use_id: "tool-call-1",
        tool_response: { answers: "private answer", plan: "private plan" } }, { now });
      assert.equal(normalized?.event_type, expected);
      assert.equal(normalized?.correlation_id, "tool-call-1");
      assert.deepEqual(normalized?.payload, { tool_name });
    }
  }
  const unrelated = normalizeHookEvent({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash",
    tool_input: { command: "echo AskUserQuestion permission needed" }, message: "question asks for answer" }, { now });
  assert.equal(unrelated?.event_type, "tool_started", "content never infers a blocking question");
  assert.deepEqual(unrelated?.payload, { tool_name: "Bash" });
});

test("Claude identifiers only change when they collide with the reserved Codex namespace", () => {
  const unchanged = normalizeHookEvent({
    hook_event_name: "UserPromptSubmit",
    session_id: "claude-session-1",
    task_id: "claude-task-1",
  }, { now });
  assert.equal(unchanged?.session_id, "claude-session-1");
  assert.equal(unchanged?.task_id, "claude-task-1");

  const collidingSession = "codex:sess:source-value";
  const collidingTask = "codex:turn:task-value";
  const escaped = normalizeHookEvent({
    hook_event_name: "UserPromptSubmit",
    session_id: collidingSession,
    task_id: collidingTask,
  }, { now });
  const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  assert.equal(escaped?.session_id, `claude:session:${hash(collidingSession)}`);
  assert.equal(escaped?.task_id, `claude:task:${hash(collidingTask)}`);
  assert.equal(escaped?.session_id.startsWith("codex:"), false);
  assert.equal(escaped?.task_id?.startsWith("codex:"), false);
});

test("SessionStart carries only a safe explicit title and prompt_id fills task_id", () => {
  const normalized = normalizeHookEvent({
    hook_event_name: "SessionStart",
    session_id: "s1",
    session_title: "  Release   review  ",
    prompt_id: "round-2",
    prompt: "private prompt",
    last_assistant_message: "private response",
  }, { now });
  assert.deepEqual(normalized, {
    event_type: "session_started",
    session_id: "s1",
    task_id: "round-2",
    session_title: "Release review",
    occurred_at: now.toISOString(),
    payload: {},
  });

  const explicitTask = normalizeHookEvent({
    hook_event_name: "UserPromptSubmit",
    session_id: "s1",
    task_id: "explicit-task",
    prompt_id: "round-2",
  }, { now });
  assert.equal(explicitTask?.task_id, "explicit-task");
  assert.equal(explicitTask?.session_title, undefined);
});

test("unsafe, overlong, and unsupported lifecycle titles are omitted", () => {
  for (const title of [
    "/Users/alice/project", "C:\\private\\project", "\\\\server\\share",
    "https://example.test", "HTTPS://example.test", "token=sk-secret", "TOKEN=abc123",
    "ghp_1234567890abcdef", "github_pat_1234567890abcdef",
    "GHp_1234567890abcdef", "Bearer abcdef0123456789", "gho_1234567890abcdef",
    "xoxb-1234567890abcdef", "sk-1234567890abcdef", "line\nbreak", "x".repeat(65),
    "review(/Users/alice/private)", "review=/Users/alice/private",
    "review:C:\\private\\project", "review=C:/private/project",
    "review(\\\\server\\share)", "review=/home/alice/private",
    "review|/Users/alice/private", "review-/Users/alice/private",
    "review\"/Users/alice/private\"", "review,/Users/alice/private",
    "review./Users/alice/private", "中文\\标题", "中文/标题",
  ]) {
    assert.equal(
      normalizeHookEvent({ hook_event_name: "SessionStart", session_id: "s1", session_title: title }, { now })?.session_title,
      undefined,
      title,
    );
  }
  assert.equal(
    normalizeHookEvent({ hook_event_name: "PreToolUse", session_id: "s1", session_title: "must be ignored" }, { now })?.session_title,
    undefined,
  );
});

test("native titles stay allowlisted on task lifecycle and title-only events", () => {
  assert.equal(safeSessionTitle("  Native   task name  "), "Native task name");
  assert.equal(safeSessionTitle("/private/source"), undefined);
  for (const event_type of ["session_started", "task_started", "task_finished", "session_title_updated"]) {
    const result = normalizeHookEvent({ event_type, session_id: "s1", task_id: "t1", session_title: "  Native   task name  ", prompt: "PRIVATE_PROMPT", command: "PRIVATE_COMMAND", cwd: "/private/source", tool_name: "Read" }, { now });
    assert.equal(result?.session_title, "Native task name", event_type);
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
    assert.equal(JSON.stringify(result).includes("/private"), false);
    if (event_type === "session_title_updated") assert.deepEqual(result?.payload, {});
  }
  for (const session_title of [undefined, "/private/source", "line\nbreak", "Bearer abc.def12", "AKIA0123456789ABCDEF", "ghs_1234567890abcdef", "x".repeat(65)]) {
    assert.equal(normalizeHookEvent({ event_type: "session_title_updated", session_id: "s1", session_title }, { now }), null);
  }
});

test("collector preserves the sanitized title and normalized prompt_id on the wire", async () => {
  let sequence = 0;
  const queued: unknown[] = [];
  const collector = new Collector({
    installationId: "installation-1",
    sequence: { next: async () => ++sequence, current: () => sequence },
    outbox: {
      enqueue: async (input) => { queued.push(input.payload); return input as never; },
      peek: async () => [], ack: async () => true, retry: async () => true,
      size: async () => 0, clear: async () => undefined,
    },
    now: () => now,
  });
  const envelope = await collector.ingestHook({
    hook_event_name: "SessionStart",
    session_id: "s1",
    session_title: "Build check",
    prompt_id: "round-2",
  });
  assert.equal(envelope?.session_title, "Build check");
  assert.equal(envelope?.task_id, "round-2");
  assert.deepEqual(queued[0], envelope);

  const unicodeEnvelope = await collector.ingestHook({
    hook_event_name: "SessionStart",
    session_id: "s1",
    session_title: "交付 计划 Review",
  });
  assert.equal(unicodeEnvelope?.session_title, "交付 计划 Review");
  assert.deepEqual(queued[1], unicodeEnvelope);

  const pathTitles = [
    "review(/Users/alice/private)",
    "review=/Users/alice/private",
    "review:C:\\private\\project",
    "review=C:/private/project",
    "review(\\\\server\\share)",
    "review|/Users/alice/private",
    "review-/Users/alice/private",
    "review\"/Users/alice/private\"",
    "review,/Users/alice/private",
    "review./Users/alice/private",
    "中文\\标题",
    "中文/标题",
  ];
  for (const session_title of pathTitles) {
    const pathEnvelope = await collector.ingestHook({
      hook_event_name: "SessionStart",
      session_id: "s1",
      session_title,
    });
    assert.equal(pathEnvelope?.session_title, undefined, session_title);
  }
  const outboxText = JSON.stringify(queued.slice(2));
  assert.equal((queued.slice(2) as Array<{ session_title?: string }>).every((entry) => entry.session_title === undefined), true);
  assert.equal(outboxText.includes("/Users/alice/private"), false);
  assert.equal(outboxText.includes("C:\\private\\project"), false);
  assert.equal(outboxText.includes("\\\\server\\share"), false);
});
