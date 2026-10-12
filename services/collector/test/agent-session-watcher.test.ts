import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSessionWatcher } from "../src/agent-session-watcher.ts";

const row = (event_type: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  event_type, session_id: "private-session-id", task_id: "private-task-id", occurred_at: "2026-10-12T10:00:00.000Z", ...extra,
});

test("generic agent watcher establishes a high-water baseline and maps appended lifecycle rows", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-watcher-"));
  const sessions = path.join(root, "sessions"); await fs.mkdir(sessions);
  const file = path.join(sessions, "session.jsonl");
  await fs.writeFile(file, `${row("session_started", { session_title: "Initial title" })}\n`);
  const events: Array<Record<string, unknown>> = [];
  let now = Date.parse("2026-10-12T10:01:00.000Z");
  const watcher = new AgentSessionWatcher({ sessionsRoot: sessions, agentId: "open-code", checkpointFile: path.join(root, "checkpoint.json"), now: () => now, emit: async (event) => events.push(event as unknown as Record<string, unknown>) });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await watcher.start();
  assert.equal(events.length, 0);
  await fs.appendFile(file, `${row("session_title_updated", { session_title: "Renamed title" })}\n${row("task_started")}\n${row("task_finished")}\n`);
  await watcher.pollOnce();
  assert.deepEqual(events.map((event) => event.event_type), ["session_title_updated", "session_started", "task_started", "task_finished"]);
  assert.equal(events.every((event) => String(event.session_id).startsWith("agent_")), true);
  assert.equal(JSON.stringify(events).includes("private-session-id"), false);
  assert.equal(JSON.stringify(events).includes("private-task-id"), false);
  await watcher.stop();
});

test("agent watcher emits stale session closure and ignores malformed rows", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-stale-"));
  const sessions = path.join(root, "sessions"); await fs.mkdir(sessions);
  const file = path.join(sessions, "active.jsonl"); await fs.writeFile(file, "");
  let now = Date.parse("2026-10-12T10:00:00.000Z"); const events: Array<Record<string, unknown>> = [];
  const watcher = new AgentSessionWatcher({ sessionsRoot: sessions, agentId: "pi", checkpointFile: path.join(root, "checkpoint.json"), staleAfterMs: 100, now: () => now, emit: async (event) => events.push(event as unknown as Record<string, unknown>) });
  t.after(() => fs.rm(root, { recursive: true, force: true })); await watcher.start();
  await fs.appendFile(file, `not json\n${row("task_started")}\n`); await watcher.pollOnce();
  now += 101; await watcher.pollOnce();
  assert.deepEqual(events.map((event) => event.event_type), ["session_started", "task_started", "session_ended"]);
  assert.equal(watcher.getDiagnostics().counters.malformed_rows, 1);
  await watcher.stop();
});
