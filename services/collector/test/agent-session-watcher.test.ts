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
  assert.deepEqual(events.map((event) => event.event_type), ["session_metadata_updated", "session_started", "task_started", "task_finished"]);
  assert.equal(events.every((event) => String(event.session_id).startsWith("agent_")), true);
  assert.equal(events.every((event) => event.agent_id === "open-code"), true);
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
  assert.equal(events.every((event) => event.agent_id === "pi"), true);
  assert.equal(watcher.getDiagnostics().counters.malformed_rows, 1);
  await watcher.stop();
});

test("agent watcher waits for complete UTF-8 rows and retries failed enqueue without losing later rows", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-partial-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions"); await fs.mkdir(sessions);
  const file = path.join(sessions, "session.jsonl"); await fs.writeFile(file, "");
  const events: Array<Record<string, unknown>> = [];
  let rejectOnce = true;
  const checkpointFile = path.join(root, "checkpoint.json");
  const makeWatcher = () => new AgentSessionWatcher({ sessionsRoot: sessions, agentId: "pi", checkpointFile,
    emit: async (event) => {
      if (event.event_type === "task_started" && rejectOnce) { rejectOnce = false; throw new Error("outbox down"); }
      events.push(event as unknown as Record<string, unknown>);
    } });
  let watcher = makeWatcher(); await watcher.start();
  const first = row("task_started", { session_title: "编码任务" });
  const bytes = Buffer.from(`${first}\n`);
  const split = bytes.indexOf(Buffer.from("编")) + 1;
  await fs.appendFile(file, bytes.subarray(0, split));
  await watcher.pollOnce();
  assert.equal(events.length, 0);
  await watcher.stop();
  watcher = makeWatcher(); await watcher.start();
  await fs.appendFile(file, Buffer.concat([bytes.subarray(split), Buffer.from(`${row("task_finished")}\n`)]));
  await watcher.pollOnce();
  assert.deepEqual(events.map((event) => event.event_type), ["session_started"]);
  await watcher.pollOnce();
  assert.deepEqual(events.map((event) => event.event_type), ["session_started", "task_started", "task_finished"]);
  await watcher.stop();
  const checkpoint = await fs.readFile(checkpointFile, "utf8");
  assert.equal(checkpoint.includes("private-session-id"), false);
  assert.equal(checkpoint.includes("private-task-id"), false);
});

test("startup baselines every source even when polling budget is smaller than old files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-baseline-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions"); await fs.mkdir(sessions);
  const files = ["a.jsonl", "b.jsonl"].map((name) => path.join(sessions, name));
  for (const file of files) await fs.writeFile(file, `${row("task_started")}\n`);
  const events: string[] = [];
  const watcher = new AgentSessionWatcher({ sessionsRoot: sessions, agentId: "pi", checkpointFile: path.join(root, "checkpoint.json"), maxBytesPerPoll: 12,
    emit: async (event) => { events.push(event.event_type); } });
  await watcher.start(); await watcher.pollOnce();
  assert.deepEqual(events, []);
  await watcher.stop();
});

test("aborted bridge turns close neutrally and title changes do not extend activity", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-abort-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions"); await fs.mkdir(sessions);
  const file = path.join(sessions, "session.jsonl"); await fs.writeFile(file, "");
  let now = Date.parse("2026-10-12T10:00:00.000Z");
  const events: string[] = [];
  const watcher = new AgentSessionWatcher({ sessionsRoot: sessions, agentId: "pi", checkpointFile: path.join(root, "checkpoint.json"),
    staleAfterMs: 100, now: () => now, emit: async (event) => { events.push(event.event_type); } });
  await watcher.start();
  await fs.appendFile(file, `${row("task_started")}\n`); await watcher.pollOnce();
  now += 90;
  await fs.appendFile(file, `${row("session_title_updated", { session_title: "New title" })}\n`); await watcher.pollOnce();
  now += 11; await watcher.pollOnce();
  assert.deepEqual(events, ["session_started", "task_started", "session_title_updated", "session_ended"]);
  await fs.appendFile(file, `${row("task_started", { task_id: "second-task" })}\n${row("task_aborted", { task_id: "second-task" })}\n`);
  await watcher.pollOnce();
  assert.deepEqual(events.slice(-3), ["session_started", "task_started", "session_ended"]);
  await watcher.stop();
});

test("out-of-order task terminal does not close the current task", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-order-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions"); await fs.mkdir(sessions);
  const file = path.join(sessions, "session.jsonl"); await fs.writeFile(file, "");
  const events: string[] = [];
  let now = Date.parse("2026-10-12T10:00:00.000Z");
  const watcher = new AgentSessionWatcher({ sessionsRoot: sessions, agentId: "pi", checkpointFile: path.join(root, "checkpoint.json"),
    now: () => now, staleAfterMs: 100, emit: async (event) => { events.push(event.event_type); } });
  await watcher.start();
  await fs.appendFile(file, `${row("task_started", { task_id: "new-task" })}\n${row("task_finished", { task_id: "old-task" })}\n`);
  await watcher.pollOnce();
  now += 90;
  await fs.appendFile(file, `${row("tool_finished", { task_id: "old-task" })}\n`);
  await watcher.pollOnce();
  now += 11; await watcher.pollOnce();
  assert.deepEqual(events, ["session_started", "task_started", "session_ended"]);
  assert.equal(watcher.getDiagnostics().counters.duplicate_or_out_of_order, 2);
  await watcher.stop();
});

test("newly copied old file does not become live activity while a fresh file does", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-copy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions"); await fs.mkdir(sessions);
  const events: string[] = [];
  const now = Date.parse("2026-10-12T10:01:00.000Z");
  const watcher = new AgentSessionWatcher({ sessionsRoot: sessions, agentId: "pi", checkpointFile: path.join(root, "checkpoint.json"),
    now: () => now, staleAfterMs: 30_000, emit: async (event) => { events.push(event.event_type); } });
  await watcher.start();
  await fs.writeFile(path.join(sessions, "old.jsonl"), `${row("task_started", { occurred_at: "2026-10-12T09:00:00.000Z" })}\n`);
  await fs.writeFile(path.join(sessions, "missing.jsonl"), `${row("task_started", { session_id: "missing", occurred_at: undefined })}\n`);
  await fs.writeFile(path.join(sessions, "invalid.jsonl"), `${row("task_started", { session_id: "invalid", occurred_at: "2026-02-30T10:00:59Z" })}\n`);
  await fs.writeFile(path.join(sessions, "fresh.jsonl"), `${row("task_started", { session_id: "fresh", occurred_at: "2026-10-12T10:00:59.000Z" })}\n`);
  await watcher.pollOnce();
  assert.deepEqual(events, ["session_started", "task_started"]);
  await watcher.stop();
});

test("fresh rotated lifecycle rows emit once while old rotated rows stay historical", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-rotate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions"); await fs.mkdir(sessions);
  const file = path.join(sessions, "session.jsonl"); await fs.writeFile(file, "");
  const now = Date.parse("2026-10-12T10:01:00.000Z");
  const events: string[] = [];
  const watcher = new AgentSessionWatcher({ sessionsRoot: sessions, agentId: "pi", checkpointFile: path.join(root, "checkpoint.json"),
    now: () => now, staleAfterMs: 30_000, emit: async (event) => { events.push(event.event_type); } });
  await watcher.start();
  await fs.rename(file, path.join(sessions, "old-1"));
  await fs.writeFile(file, `${row("task_started", { session_id: "old", occurred_at: "2026-10-12T09:00:00.000Z" })}\n`);
  await watcher.pollOnce();
  assert.deepEqual(events, []);
  await fs.rename(file, path.join(sessions, "old-2"));
  await fs.writeFile(file, `${row("task_started", { session_id: "fresh", occurred_at: "2026-10-12T10:00:59.000Z" })}\n${row("task_finished", { session_id: "fresh", occurred_at: "2026-10-12T10:01:00.000Z" })}\n`);
  await watcher.pollOnce(); await watcher.pollOnce();
  assert.deepEqual(events, ["session_started", "task_started", "task_finished"]);
  await watcher.stop();
});

test("bridge metadata drops impossible source dates instead of normalizing them", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-bad-date-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions"); await fs.mkdir(sessions);
  const file = path.join(sessions, "session.jsonl"); await fs.writeFile(file, "");
  const events: Array<Record<string, unknown>> = [];
  const watcher = new AgentSessionWatcher({ sessionsRoot: sessions, agentId: "pi", checkpointFile: path.join(root, "checkpoint.json"),
    emit: async (event) => { events.push(event as unknown as Record<string, unknown>); } });
  await watcher.start();
  await fs.appendFile(file, `${row("session_metadata_updated", { session_title: "Known title", source_started_at: "2026-02-30T10:00:00Z" })}\n`);
  await watcher.pollOnce();
  assert.deepEqual(events.map((event) => event.event_type), ["session_metadata_updated"]);
  assert.deepEqual(events[0]!.payload, {});
  await watcher.stop();
});

test("first title for a baseline session is a metadata upsert", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-title-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions"); await fs.mkdir(sessions);
  const file = path.join(sessions, "session.jsonl"); await fs.writeFile(file, `${row("session_started")}\n`);
  const events: Array<Record<string, unknown>> = [];
  const watcher = new AgentSessionWatcher({ sessionsRoot: sessions, agentId: "pi", checkpointFile: path.join(root, "checkpoint.json"),
    emit: async (event) => { events.push(event as unknown as Record<string, unknown>); } });
  await watcher.start();
  await fs.appendFile(file, `${row("session_title_updated", { session_title: "Known title", correlation_id: "private-call", payload: { tool_name: "Bash" } })}\n`);
  await watcher.pollOnce();
  assert.deepEqual(events.map((event) => event.event_type), ["session_metadata_updated"]);
  assert.equal(Object.hasOwn(events[0]!, "task_id"), false);
  assert.equal(Object.hasOwn(events[0]!, "correlation_id"), false);
  assert.deepEqual(events[0]!.payload, {});
  await watcher.stop();
});

test("Codex bridge session state survives checkpoint restart", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-codex-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions"); await fs.mkdir(sessions);
  const file = path.join(sessions, "session.jsonl"); await fs.writeFile(file, "");
  const checkpointFile = path.join(root, "checkpoint.json");
  const uuid = "019c7714-3b77-74d1-9866-e1f484aae2ab";
  let now = Date.parse("2026-10-12T10:00:00.000Z");
  const events: Array<Record<string, unknown>> = [];
  const createWatcher = () => new AgentSessionWatcher({ sessionsRoot: sessions, agentId: "codex", checkpointFile,
    now: () => now, staleAfterMs: 100, emit: async (event) => { events.push(event as unknown as Record<string, unknown>); } });
  let watcher = createWatcher(); await watcher.start();
  await fs.appendFile(file, `${row("task_started", { session_id: uuid })}\n`); await watcher.pollOnce(); await watcher.stop();
  now += 101;
  watcher = createWatcher(); await watcher.start();
  assert.deepEqual(events.map((event) => event.event_type), ["session_started", "task_started", "session_ended"]);
  assert.equal(events.every((event) => String(event.session_id).startsWith("codex:sess:")), true);
  await watcher.stop();
});

test("source loss still expires active sessions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-missing-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions"); await fs.mkdir(sessions);
  const file = path.join(sessions, "session.jsonl"); await fs.writeFile(file, "");
  let now = Date.parse("2026-10-12T10:00:00.000Z");
  const events: string[] = [];
  const watcher = new AgentSessionWatcher({ sessionsRoot: sessions, agentId: "pi", checkpointFile: path.join(root, "checkpoint.json"),
    now: () => now, staleAfterMs: 100, emit: async (event) => { events.push(event.event_type); } });
  await watcher.start();
  await fs.appendFile(file, `${row("task_started")}\n`); await watcher.pollOnce();
  await fs.rm(sessions, { recursive: true });
  now += 101; await watcher.pollOnce();
  assert.deepEqual(events, ["session_started", "task_started", "session_ended"]);
  assert.equal(watcher.getDiagnostics().codes.includes("agent_session_source_unavailable"), true);
  await watcher.stop();
});

test("late tool and waiting rows cannot reactivate a completed task", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-late-tail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions"); await fs.mkdir(sessions);
  const file = path.join(sessions, "session.jsonl"); await fs.writeFile(file, "");
  let now = Date.parse("2026-10-12T10:00:00.000Z");
  const events: string[] = [];
  const watcher = new AgentSessionWatcher({ sessionsRoot: sessions, agentId: "pi", checkpointFile: path.join(root, "checkpoint.json"),
    now: () => now, staleAfterMs: 100, emit: async (event) => { events.push(event.event_type); } });
  await watcher.start();
  await fs.appendFile(file, `${row("task_started", { task_id: "done", occurred_at: "2026-10-12T09:59:59.000Z" })}\n${row("task_finished", { task_id: "done", occurred_at: "2026-10-12T10:00:00.000Z" })}\n`);
  await watcher.pollOnce();
  await fs.appendFile(file, `${row("tool_finished", { task_id: "done", occurred_at: "2026-10-12T10:00:00.000Z" })}\n${row("waiting", { task_id: "done", occurred_at: "2026-10-12T10:00:00.000Z" })}\n`);
  await watcher.pollOnce();
  now += 101; await watcher.pollOnce();
  assert.deepEqual(events, ["session_started", "task_started", "task_finished"]);
  assert.equal(watcher.getDiagnostics().counters.duplicate_or_out_of_order, 2);
  await watcher.stop();
});

test("older task starts cannot replace a newer active task", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-older-start-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions"); await fs.mkdir(sessions);
  const file = path.join(sessions, "session.jsonl"); await fs.writeFile(file, "");
  const events: Array<Record<string, unknown>> = [];
  const watcher = new AgentSessionWatcher({ sessionsRoot: sessions, agentId: "pi", checkpointFile: path.join(root, "checkpoint.json"),
    emit: async (event) => { events.push(event as unknown as Record<string, unknown>); } });
  await watcher.start();
  await fs.appendFile(file, `${row("task_started", { task_id: "newer", occurred_at: "2026-10-12T10:00:00.000Z" })}\n${row("task_started", { task_id: "older", occurred_at: "2026-10-12T09:59:00.000Z" })}\n${row("task_finished", { task_id: "newer", occurred_at: "2026-10-12T10:01:00.000Z" })}\n`);
  await watcher.pollOnce();
  assert.deepEqual(events.map((event) => event.event_type), ["session_started", "task_started", "task_finished"]);
  assert.equal(events[1]!.task_id, events[2]!.task_id);
  await watcher.stop();
});

test("active bridge session state stays bounded and eviction closes remote activity", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-bound-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions"); await fs.mkdir(sessions);
  const file = path.join(sessions, "session.jsonl"); await fs.writeFile(file, "");
  const checkpointFile = path.join(root, "checkpoint.json");
  let closures = 0;
  const watcher = new AgentSessionWatcher({ sessionsRoot: sessions, agentId: "pi", checkpointFile,
    maxBytesPerFile: 4 * 1024 * 1024, maxBytesPerPoll: 4 * 1024 * 1024,
    emit: async (event) => { if (event.event_type === "session_ended") closures += 1; } });
  await watcher.start();
  await fs.appendFile(file, Array.from({ length: 8_193 }, (_, i) => row("task_started", { session_id: `session-${i}` })).join("\n") + "\n");
  await watcher.pollOnce();
  const checkpoint = JSON.parse(await fs.readFile(checkpointFile, "utf8")) as { sessions: unknown[] };
  assert.equal(checkpoint.sessions.length, 8_192);
  assert.equal(closures, 1);
  assert.equal(watcher.getDiagnostics().codes.includes("agent_session_state_evicted"), true);
  await watcher.stop();
});
