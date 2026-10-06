import assert from "node:assert/strict";
import test from "node:test";
import { normalizeHookEvent } from "../src/normalize.ts";
import { Collector } from "../src/collector.ts";

const now = new Date("2026-10-02T11:00:00.000Z");

test("normalization maps hook lifecycle names to canonical v1 event types", () => {
  const cases: Array<[string, string]> = [
    ["SessionStart", "session_started"],
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
    const normalized = normalizeHookEvent({ hook_event_name, session_id: "s1" }, { now });
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

test("unknown hook names are dropped rather than forwarded", () => {
  assert.equal(normalizeHookEvent({ hook_event_name: "UnknownHook", session_id: "s1" }, { now }), null);
  assert.equal(normalizeHookEvent({ prompt: "only user data" }, { now }), null);
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

test("unsafe, overlong, and non-SessionStart titles are omitted", () => {
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
    normalizeHookEvent({ hook_event_name: "Stop", session_id: "s1", session_title: "must be ignored" }, { now })?.session_title,
    undefined,
  );
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
