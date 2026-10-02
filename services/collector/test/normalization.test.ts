import assert from "node:assert/strict";
import test from "node:test";
import { normalizeHookEvent } from "../src/normalize.ts";

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
