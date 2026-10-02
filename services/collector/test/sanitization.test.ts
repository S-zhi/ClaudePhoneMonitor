import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeHookEvent } from "../src/normalize.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/hook-event.json", import.meta.url));
const forbidden = [
  "do not transmit this prompt",
  "cat /Users/alice/private.txt",
  "sk-test-secret",
  "private output",
  "private error",
  "private result",
  "/Users/alice/.claude/projects/private.jsonl",
  "/Users/alice/private-project",
  "top-secret",
];

test("sanitization is an allowlist and excludes private hook material", async () => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
  const normalized = normalizeHookEvent(fixture, {
    now: new Date("2026-10-02T11:00:00.000Z"),
  });

  assert.deepEqual(normalized, {
    event_type: "tool_finished",
    session_id: "session-123",
    task_id: "task-456",
    occurred_at: "2026-10-02T10:00:00.000Z",
    payload: {
      tool_name: "Bash",
      duration_ms: 42,
      exit_code: 0,
    },
  });

  const serialized = JSON.stringify(normalized);
  for (const value of forbidden) assert.equal(serialized.includes(value), false, value);
  for (const key of ["prompt", "tool_input", "tool_response", "stdout", "stderr", "cwd", "transcript_path", "env"]) {
    assert.equal(serialized.includes(key), false, key);
  }
});

test("malformed identifiers and timestamps do not become paths or arbitrary data", () => {
  const normalized = normalizeHookEvent(
    {
      hook_event_name: "PostToolUse",
      session_id: "/Users/alice/private-project",
      timestamp: "not-a-date",
      tool_name: "mcp__server__tool-with-secret-looking-name",
      duration_ms: "not-a-number",
      prompt: "sensitive",
    },
    { now: new Date("2026-10-02T11:00:00.000Z") },
  );

  assert.ok(normalized);
  assert.equal(normalized.session_id, "unknown");
  assert.equal(normalized.occurred_at, "2026-10-02T11:00:00.000Z");
  assert.deepEqual(normalized.payload, { tool_name: "mcp" });
  assert.equal(JSON.stringify(normalized).includes("/Users"), false);
});
