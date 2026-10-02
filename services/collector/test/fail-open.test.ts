import { Readable } from "node:stream";
import assert from "node:assert/strict";
import test from "node:test";
import { runHookAdapter } from "../src/hook-adapter.ts";

function input(value: string): AsyncIterable<string> {
  return Readable.from([value]) as unknown as AsyncIterable<string>;
}

test("hook adapter fails open on malformed JSON", async () => {
  await assert.doesNotReject(
    runHookAdapter({
      socketPath: "/tmp/claude-phone-monitor-test-missing.sock",
      input: input("{not-json"),
    }),
  );
});

test("hook adapter fails open when the local socket is unavailable", async () => {
  const result = await runHookAdapter({
    socketPath: "/tmp/claude-phone-monitor-test-missing.sock",
    input: input(JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1" })),
    socketTimeoutMs: 10,
  });
  assert.equal(result, true);
});

test("hook adapter fails open on oversized stdin", async () => {
  const result = await runHookAdapter({
    socketPath: "/tmp/claude-phone-monitor-test-missing.sock",
    input: input(JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1" }) + "x".repeat(1_000)),
    maxInputBytes: 256,
  });
  assert.equal(result, true);
});
