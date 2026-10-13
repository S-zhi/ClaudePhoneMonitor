import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentSessionId } from "../src/agent-identity.ts";
import { MagpieSessionsReader, parseMagpieSession, startMagpieSessionsWatcher } from "../src/magpie-sessions.ts";
import type { NormalizedHookEvent } from "../src/types.ts";

const UUID = "018f1f5e-7b2c-7abc-8def-0123456789ab";
const stamp = "2026-10-12T16:00:00Z";
const row = (agent = "pi", id = "session", last = stamp) =>
  ({ agent, id, title: "FIRST PROMPT with password=secret", start: stamp, last, cwd: "/private/path", resume: "codex resume secret" });
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magpie-monitor-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, checkpoint: path.join(root, "checkpoint.json") };
}

test("reader strips ambiguous prompt titles and private CLI fields", async () => {
  const raw = JSON.parse(await fs.readFile(path.join(import.meta.dirname, "fixtures", "magpie-sessions.json"), "utf8")) as object[];
  const session = parseMagpieSession(raw[0]!);
  assert.ok(session);
  assert.deepEqual(Object.keys(session).sort(), ["agent", "id", "last", "start"]);
  assert.equal(session.id, agentSessionId("codex", "private-session-123"));
  assert.doesNotMatch(JSON.stringify(session), /FIRST PROMPT|Magpie session|private-session|private\/project|resume/);
});

test("strict source dates omit impossible calendar days and retain identity-only history", async (t) => {
  const f = await fixture(t);
  const events: NormalizedHookEvent[] = [];
  const watcher = await startMagpieSessionsWatcher({
    command: async () => JSON.stringify([{ agent: "pi", id: "unknown-times", title: "PRIVATE FIRST PROMPT",
      start: "2026-02-30T10:00:00Z", last: "2026-10-12T25:00:00Z" }]),
    checkpointFile: f.checkpoint,
    now: () => new Date("2026-10-12T16:00:00Z"),
    pollIntervalMs: 60_000,
    emit: async (event) => { events.push(event); },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event_type, "session_metadata_updated");
  assert.deepEqual(events[0]?.payload, {});
  assert.equal(events[0]?.occurred_at, "2026-10-12T16:00:00.000Z");
  assert.equal(events[0]?.session_title, undefined);
  await watcher.stop();
});

test("reader validates limits before command invocation", async () => {
  let called = false;
  const reader = new MagpieSessionsReader({ command: async () => { called = true; return "[]"; } });
  await assert.rejects(reader.readSnapshot(NaN), /magpie_invalid_limit/);
  await assert.rejects(reader.readSnapshot(10_001), /magpie_invalid_limit/);
  assert.equal(called, false);
  assert.throws(() => new MagpieSessionsReader({ defaultLimit: Infinity }), /magpie_invalid_limit/);
});

test("default command keeps exact arguments and enforces its execution timeout", async (t) => {
  const f = await fixture(t);
  const binary = path.join(f.root, "magpie-test");
  await fs.writeFile(binary, "#!/bin/sh\nsleep 1\nprintf '[]'\n", { mode: 0o700 });
  const reader = new MagpieSessionsReader({ commandName: binary, commandTimeoutMs: 100 });
  assert.deepEqual(reader.commandArgs(7), [binary, "sessions", "--json", "--limit", "7"]);
  await assert.rejects(reader.readSnapshot(7));
});

test("first snapshot emits metadata, dedupes restarts and limit eviction, retries failed emits", async (t) => {
  const f = await fixture(t);
  let output = JSON.stringify([row()]);
  const events: NormalizedHookEvent[] = [];
  let fail = false;
  const options = {
    command: async () => output,
    checkpointFile: f.checkpoint,
    pollIntervalMs: 60_000,
    emit: async (event: NormalizedHookEvent) => { if (fail) throw new Error("queue full"); events.push(event); },
  };
  const watcher = await startMagpieSessionsWatcher(options);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event_type, "session_metadata_updated");
  assert.deepEqual(events[0]?.payload, { source_started_at: "2026-10-12T16:00:00.000Z", source_last_activity_at: "2026-10-12T16:00:00.000Z" });
  assert.equal(events[0]?.session_title, undefined);
  assert.equal(events[0]?.agent_id, "pi");
  await watcher.stop();
  assert.doesNotMatch(await fs.readFile(f.checkpoint, "utf8"), /FIRST PROMPT|session"|private|2026/);

  const restarted = await startMagpieSessionsWatcher(options);
  assert.equal(events.length, 1);
  output = "[]";
  await restarted.pollOnce();
  output = JSON.stringify([row()]);
  await restarted.pollOnce();
  assert.equal(events.length, 1, "limit eviction and reentry must not create activity");
  fail = true;
  output = JSON.stringify([row("pi", "session", "2026-10-12T16:05:00Z")]);
  await restarted.pollOnce();
  assert.equal(events.length, 1);
  assert.ok(restarted.getDiagnostics().codes.includes("magpie_sessions_emit_failed"));
  fail = false;
  await restarted.pollOnce();
  assert.equal(events.length, 2);
  assert.equal(events[1]?.event_type, "session_metadata_updated");
  await restarted.stop();
});

test("Codex uses the native identity and native title; Claude aliases are excluded", async (t) => {
  const f = await fixture(t);
  const indexRow = (title: string) => JSON.stringify({ id: UUID, thread_name: title, updated_at: stamp, first_user_message: "PRIVATE PROMPT" });
  await fs.writeFile(path.join(f.root, "session_index.jsonl"), indexRow("Native title") + "\n");
  let output = JSON.stringify([row("codex", UUID), row("claude", "claude-id")]);
  const events: NormalizedHookEvent[] = [];
  const watcher = await startMagpieSessionsWatcher({
    command: async () => output,
    codexMetadataRoot: f.root,
    excludedAgentIds: ["claude_code"],
    pollIntervalMs: 60_000,
    emit: async (event) => { events.push(event); },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.session_id, `codex:sess:${createHash("sha256").update(UUID).digest("hex")}`);
  assert.equal(events[0]?.session_title, "Native title");
  assert.equal(events[0]?.agent_id, "codex");
  assert.ok(watcher.getDiagnostics().codes.includes("magpie_sessions_agent_excluded"));
  await fs.writeFile(path.join(f.root, "session_index.jsonl"), indexRow("Native rename") + "\n");
  output = JSON.stringify([row("codex", UUID), row("claude_code", "claude-id")]);
  await watcher.pollOnce();
  assert.equal(events.length, 2);
  assert.equal(events[1]?.session_title, "Native rename");
  await watcher.stop();
});

test("command timeout and stop stay bounded when an injected runner ignores abort", async () => {
  let calls = 0;
  const watcher = await startMagpieSessionsWatcher({
    command: async () => { calls++; return "[]"; },
    commandTimeoutMs: 100,
    pollIntervalMs: 60_000,
    emit: async () => {},
  });
  const original = calls;
  await watcher.stop();
  await watcher.pollOnce();
  assert.equal(calls, original);

  const started = Date.now();
  const hung = await startMagpieSessionsWatcher({
    command: async () => new Promise<string>(() => {}),
    commandTimeoutMs: 100,
    pollIntervalMs: 60_000,
    emit: async () => {},
  });
  assert.ok(Date.now() - started < 1000);
  assert.ok(hung.getDiagnostics().codes.includes("magpie_sessions_command_timeout"));
  await hung.stop();
});
