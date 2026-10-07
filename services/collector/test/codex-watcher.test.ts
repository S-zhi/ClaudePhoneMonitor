import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexSessionWatcher, startCodexWatcher, type CodexWatcherOptions } from "../src/codex-watcher.ts";
import { codexEvent, parseCodexLifecycleLine } from "../src/codex-normalizer.ts";

const SESSION = "018f1f5e-7b2c-7abc-8def-0123456789ab";
const SESSION_2 = "018f1f5e-7b2c-7abc-8def-0123456789b1";
const PARENT_SESSION = "018f1f5e-7b2c-7abc-8def-0123456789b2";
const TURN_1 = "018f1f5e-7b2c-7abc-8def-0123456789ac";
const TURN_2 = "018f1f5e-7b2c-7abc-8def-0123456789ad";

test("Codex titles distinguish sessions using only a short identity hash", () => {
  const events = [SESSION, SESSION_2].map((id) => {
    const parsed = parseCodexLifecycleLine(JSON.stringify({ type: "session_meta", payload: {
      id, title: "PRIVATE_PROMPT", cwd: "/private/project", prompt: "PRIVATE_PROMPT",
    } }));
    assert.ok(parsed?.kind === "session_meta");
    return codexEvent("session_started", parsed.sessionHash, undefined, "2026-10-07T00:00:00.000Z", true);
  });
  assert.notEqual(events[0]?.session_title, events[1]?.session_title);
  for (const event of events) assert.match(event.session_title!, /^Codex [0-9a-f]{6}$/);
  const wire = JSON.stringify(events);
  for (const privateValue of [SESSION, SESSION_2, "PRIVATE_PROMPT", "/private/project"]) {
    assert.equal(wire.includes(privateValue), false);
  }
});

function row(type: string, payload?: Record<string, unknown>, ordinal?: number): string {
  return JSON.stringify({
    type,
    timestamp: "2026-10-07T00:00:00.000Z",
    ...(ordinal === undefined ? {} : { ordinal }),
    ...(payload ? { payload } : {}),
  });
}

function meta(session = SESSION): string { return row("session_meta", { id: session, session_id: session }); }
function start(turn = TURN_1, ordinal = 2): string {
  return row("event_msg", { type: "task_started", turn_id: turn, started_at: 1791331200, prompt: "PRIVATE_PROMPT" }, ordinal);
}
function complete(turn = TURN_1, error?: unknown, ordinal = 3): string {
  const payload: Record<string, unknown> = { type: "task_complete", turn_id: turn, completed_at: 1791331201, last_agent_message: "PRIVATE_MESSAGE" };
  if (arguments.length > 1) payload.error = error;
  return row("event_msg", payload, ordinal);
}
function logFile(directory: string, name = "rollout-test.jsonl"): string { return path.join(directory, name); }

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-watcher-test-"));
  const sessionsRoot = path.join(root, "sessions");
  await fs.mkdir(sessionsRoot);
  const checkpointFile = path.join(root, "state", "checkpoint.json");
  const events: Array<Record<string, unknown>> = [];
  const options: CodexWatcherOptions = { sessionsRoot, checkpointFile, emit: async (event) => { events.push(event as unknown as Record<string, unknown>); } };
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  return { root, sessionsRoot, checkpointFile, events, options };
}

test("Codex lifecycle parser is strict and maps only exact server_overloaded", () => {
  assert.equal(parseCodexLifecycleLine(row("event_msg", { type: "task_started", turn_id: TURN_1 }), Date.now(), "a".repeat(64))?.kind, "task_started");
  const recognized = parseCodexLifecycleLine(row("event_msg", {
    type: "task_complete", turn_id: TURN_1,
    error: { codex_error_info: "server_overloaded", message: "DO_NOT_READ_THIS" },
  }), Date.now(), "a".repeat(64));
  assert.equal(recognized?.kind, "task_complete");
  assert.equal(recognized && recognized.kind === "task_complete" ? recognized.errorKind : undefined, "server_overloaded");
  const unknown = parseCodexLifecycleLine(row("event_msg", {
    type: "task_complete", turn_id: TURN_1, error: { codex_error_info: "other", message: "PRIVATE" },
  }), Date.now(), "a".repeat(64));
  assert.equal(unknown && unknown.kind === "task_complete" ? unknown.errorKind : undefined, "unknown");
  assert.equal(parseCodexLifecycleLine(row("event_msg", { type: "task_complete", turn_id: "not-an-id" }), Date.now(), "a".repeat(64))?.kind, "ignored");
});

test("rollout id isolates threads that share a parent session_id", () => {
  const first = parseCodexLifecycleLine(row("session_meta", { id: SESSION, session_id: PARENT_SESSION }));
  const second = parseCodexLifecycleLine(row("session_meta", { id: SESSION_2, session_id: PARENT_SESSION }));
  assert.equal(first?.kind, "session_meta");
  assert.equal(second?.kind, "session_meta");
  if (first?.kind !== "session_meta" || second?.kind !== "session_meta") return;
  assert.notEqual(first.sessionHash, second.sessionHash);
  const lifecycle = parseCodexLifecycleLine(
    row("event_msg", { type: "task_started", turn_id: TURN_1, session_id: PARENT_SESSION }),
    Date.now(), first.sessionHash,
  );
  assert.equal(lifecycle?.kind, "task_started");
  if (lifecycle?.kind === "task_started") assert.equal(lifecycle.sessionHash, first.sessionHash);
  assert.equal(parseCodexLifecycleLine(row("session_meta", { id: "bad-id", session_id: PARENT_SESSION }))?.kind, "ignored");
  assert.equal(parseCodexLifecycleLine(row("session_meta", { session_id: PARENT_SESSION, parent_thread_id: SESSION }))?.kind, "ignored");
  assert.equal(parseCodexLifecycleLine(row("session_meta", {
    session_id: PARENT_SESSION,
    source: { subagent: { thread_spawn: { parent_thread_id: SESSION } } },
  }))?.kind, "ignored");
  assert.equal(parseCodexLifecycleLine(row("event_msg", {
    type: "task_started", turn_id: TURN_1, session_id: PARENT_SESSION,
  }))?.kind, "ignored");
});

test("separate rollout thread ids sharing a parent are independently baselined", async (t) => {
  const f = await fixture(t);
  const first = logFile(f.sessionsRoot, "rollout-first.jsonl");
  const second = logFile(f.sessionsRoot, "rollout-second.jsonl");
  await fs.writeFile(first, `${row("session_meta", { id: SESSION, session_id: PARENT_SESSION })}\n${start()}\n`);
  await fs.writeFile(second, `${row("session_meta", { id: SESSION_2, session_id: PARENT_SESSION })}\n${start(TURN_2)}\n`);
  const watcher = new CodexSessionWatcher(f.options);
  await watcher.start();
  assert.equal(f.events.filter((event) => event.event_type === "task_started").length, 2);
  const sessions = new Set(f.events.filter((event) => event.event_type === "session_started").map((event) => event.session_id));
  assert.equal(sessions.size, 2);
  await watcher.stop();
});

test("a terminal event in one child thread does not end another thread sharing its parent", async (t) => {
  const f = await fixture(t);
  const first = logFile(f.sessionsRoot, "rollout-first.jsonl");
  const second = logFile(f.sessionsRoot, "rollout-second.jsonl");
  const firstThreadMeta = row("session_meta", { id: SESSION, session_id: PARENT_SESSION });
  const secondThreadMeta = row("session_meta", { id: SESSION_2, session_id: PARENT_SESSION });
  const watcher = new CodexSessionWatcher(f.options);
  await watcher.start();
  await fs.writeFile(first, `${firstThreadMeta}\n${start()}\n`);
  await fs.writeFile(second, `${secondThreadMeta}\n${start(TURN_2)}\n`);
  await watcher.pollOnce();
  const firstSession = `codex:sess:${createHash("sha256").update(SESSION).digest("hex")}`;
  const secondSession = `codex:sess:${createHash("sha256").update(SESSION_2).digest("hex")}`;
  assert.notEqual(firstSession, secondSession);

  await fs.appendFile(first, `${complete()}\n`);
  await watcher.pollOnce();
  const finishes = f.events.filter((event) => event.event_type === "task_finished");
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0]?.session_id, firstSession);
  assert.equal(f.events.some((event) => event.event_type === "session_ended" && event.session_id === secondSession), false);
  await watcher.stop();
});

test("same-thread copied active rollouts restore only the freshest active turn", async (t) => {
  const f = await fixture(t);
  const first = logFile(f.sessionsRoot, "rollout-first.jsonl");
  const second = logFile(f.sessionsRoot, "rollout-second.jsonl");
  await fs.writeFile(first, `${meta()}\n${start()}\n`);
  await fs.writeFile(second, `${meta()}\n${start(TURN_2)}\n`);
  const older = new Date(Date.now() - 60_000);
  const newer = new Date(Date.now() - 10_000);
  await fs.utimes(first, older, older);
  await fs.utimes(second, newer, newer);
  const watcher = new CodexSessionWatcher(f.options);
  await watcher.start();
  const starts = f.events.filter((event) => event.event_type === "task_started");
  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.task_id, `codex:turn:${createHash("sha256").update(TURN_2).digest("hex")}`);
  await watcher.stop();
});

test("an unterminated historical tail cannot block active restore or replay when later completed", async (t) => {
  const f = await fixture(t);
  const active = logFile(f.sessionsRoot, "rollout-active.jsonl");
  const partial = logFile(f.sessionsRoot, "rollout-partial.jsonl");
  const terminal = complete(TURN_2, null, 3);
  await fs.writeFile(active, `${meta()}\n${start()}\n`);
  await fs.writeFile(partial, `${row("session_meta", { id: SESSION_2, session_id: PARENT_SESSION })}\n${start(TURN_2)}\n${terminal.slice(0, -1)}`);
  const watcher = new CodexSessionWatcher(f.options);
  await watcher.start();
  assert.equal(f.events.filter((event) => event.event_type === "task_started").length, 2);
  for (let i = 0; i < 3; i += 1) await watcher.pollOnce();
  assert.equal(f.events.some((event) => event.event_type === "session_ended"), false);

  await fs.appendFile(partial, `${terminal.slice(-1)}\n`);
  await watcher.pollOnce();
  assert.equal(f.events.some((event) => event.event_type === "task_finished" && event.session_id === `codex:sess:${createHash("sha256").update(SESSION_2).digest("hex")}`), false);
  assert.equal(f.events.some((event) => event.event_type === "session_ended"), false);
  await watcher.stop();
});

test("a historical tail completed before its delayed baseline read stays historical", async (t) => {
  const f = await fixture(t);
  const active = logFile(f.sessionsRoot, "rollout-active.jsonl");
  const delayed = logFile(f.sessionsRoot, "rollout-delayed.jsonl");
  const noise = Array.from({ length: 300 }, () => row("event_msg", { type: "token_count", info: { total_tokens: 1 } })).join("\n");
  const oldTerminal = complete(TURN_2, null, 3);
  await fs.writeFile(active, `${meta()}\n${start()}\n${noise}\n`);
  await fs.writeFile(delayed, `${row("session_meta", { id: SESSION_2, session_id: PARENT_SESSION })}\n${start(TURN_2)}\n${oldTerminal.slice(0, -1)}`);
  const newer = new Date(Date.now() - 5_000);
  const older = new Date(Date.now() - 60_000);
  await fs.utimes(active, newer, newer);
  await fs.utimes(delayed, older, older);
  const watcher = new CodexSessionWatcher({ ...f.options, maxBytesPerPoll: 4 * 1024, maxBytesPerFile: 4 * 1024 });
  await watcher.start();
  assert.deepEqual(f.events, []);

  await fs.appendFile(delayed, `${oldTerminal.slice(-1)}\n`);
  for (let i = 0; i < 20 && !f.events.some((event) => event.event_type === "task_started"); i += 1) await watcher.pollOnce();
  const activeSession = `codex:sess:${createHash("sha256").update(SESSION).digest("hex")}`;
  const delayedSession = `codex:sess:${createHash("sha256").update(SESSION_2).digest("hex")}`;
  assert.equal(f.events.some((event) => event.event_type === "task_started" && event.session_id === activeSession), true);
  assert.equal(f.events.some((event) => event.event_type === "task_finished" && event.session_id === delayedSession), false);
  await watcher.stop();
});

test("failed baseline enqueue resumes without duplicating a successful session_started prefix", async (t) => {
  const f = await fixture(t);
  const active = logFile(f.sessionsRoot);
  await fs.writeFile(active, `${meta()}\n${start()}\n`);
  let failTaskStart = true;
  const events: Array<Record<string, unknown>> = [];
  const watcher = new CodexSessionWatcher({
    ...f.options,
    emit: async (event) => {
      if (event.event_type === "task_started" && failTaskStart) { failTaskStart = false; throw new Error("private sink error"); }
      events.push(event as unknown as Record<string, unknown>);
    },
  });
  await watcher.start();
  assert.deepEqual(events.map((event) => event.event_type), ["session_started"]);
  await watcher.pollOnce();
  assert.deepEqual(events.map((event) => event.event_type), ["session_started", "task_started"]);
  assert.equal(watcher.getDiagnostics().codes.includes("codex_event_emit_failed"), true);
  await watcher.stop();
});

test("live start and terminal enqueue failures retry source rows without losing or duplicating finish", async (t) => {
  const f = await fixture(t);
  const watcherEvents: Array<Record<string, unknown>> = [];
  let failTaskStart = false;
  let failTaskFinish = false;
  const watcher = new CodexSessionWatcher({
    ...f.options,
    emit: async (event) => {
      if (event.event_type === "task_started" && failTaskStart) { failTaskStart = false; throw new Error("private start sink error"); }
      if (event.event_type === "task_finished" && failTaskFinish) { failTaskFinish = false; throw new Error("private finish sink error"); }
      watcherEvents.push(event as unknown as Record<string, unknown>);
    },
  });
  await watcher.start();
  const active = logFile(f.sessionsRoot);
  failTaskStart = true;
  await fs.writeFile(active, `${meta()}\n${start()}\n`);
  await watcher.pollOnce();
  assert.deepEqual(watcherEvents.map((event) => event.event_type), ["session_started"]);
  const savedAfterStartFailure = JSON.parse(await fs.readFile(f.checkpointFile, "utf8")) as { files: Array<{ offset: number; lastOrdinal?: number }> };
  assert.ok(savedAfterStartFailure.files[0]!.offset < (await fs.stat(active)).size);
  assert.equal(savedAfterStartFailure.files[0]!.lastOrdinal, undefined);
  await watcher.pollOnce();
  assert.deepEqual(watcherEvents.map((event) => event.event_type), ["session_started", "task_started"]);

  failTaskFinish = true;
  await fs.appendFile(active, `${complete()}\n`);
  await watcher.pollOnce();
  assert.equal(watcherEvents.filter((event) => event.event_type === "task_finished").length, 0);
  await watcher.pollOnce();
  assert.equal(watcherEvents.filter((event) => event.event_type === "task_finished").length, 1);
  for (let i = 0; i < 2; i += 1) await watcher.pollOnce();
  assert.equal(watcherEvents.filter((event) => event.event_type === "task_finished").length, 1);
  assert.equal(watcher.getDiagnostics().codes.includes("codex_event_emit_failed"), true);
  await watcher.stop();
});

test("newest completed rollout prevents an older active copy from being restored", async (t) => {
  const f = await fixture(t);
  const older = logFile(f.sessionsRoot, "rollout-older.jsonl");
  const newest = logFile(f.sessionsRoot, "rollout-newest.jsonl");
  await fs.writeFile(older, `${meta()}\n${start()}\n`);
  await fs.writeFile(newest, `${meta()}\n${start(TURN_2)}\n${complete(TURN_2, null, 4)}\n`);
  const oldTime = new Date(Date.now() - 60_000);
  const newTime = new Date(Date.now() - 5_000);
  await fs.utimes(older, oldTime, oldTime);
  await fs.utimes(newest, newTime, newTime);
  const watcher = new CodexSessionWatcher(f.options);
  await watcher.start();
  assert.deepEqual(f.events, []);
  await watcher.stop();
});

test("newest completed rollout neutral-closes checkpointed WORKING without historical finish", async (t) => {
  const f = await fixture(t);
  const active = logFile(f.sessionsRoot, "rollout-active.jsonl");
  await fs.writeFile(active, `${meta()}\n${start()}\n`);
  const first = new CodexSessionWatcher(f.options);
  await first.start();
  await first.stop();

  const completed = logFile(f.sessionsRoot, "rollout-completed.jsonl");
  await fs.writeFile(completed, `${meta()}\n${start(TURN_2)}\n${complete(TURN_2, null, 4)}\n`);
  const oldTime = new Date(Date.now() - 60_000);
  const newTime = new Date(Date.now() - 5_000);
  await fs.utimes(active, oldTime, oldTime);
  await fs.utimes(completed, newTime, newTime);
  f.events.length = 0;
  const restarted = new CodexSessionWatcher(f.options);
  await restarted.start();
  assert.deepEqual(f.events.map((event) => event.event_type), ["session_ended"]);
  await restarted.stop();
});

test("unsupported rows, malformed identities, and source content never reach the normalized projection", async (t) => {
  const f = await fixture(t);
  const active = logFile(f.sessionsRoot);
  const foreign = "018f1f5e-7b2c-7abc-8def-0123456789b0";
  await fs.writeFile(active, `${meta()}\n${start()}\n`);
  const watcher = new CodexSessionWatcher(f.options);
  await watcher.start();

  await fs.appendFile(active, [
    row("event_msg", { type: "task_complete", turn_id: TURN_1, session_id: foreign, error: { message: "PRIVATE_ERROR" } }, 3),
    JSON.stringify({ type: "future_record", secret: "PRIVATE_SECRET", cwd: "/private/user/project" }),
    "{malformed private row",
  ].join("\n") + "\n");
  await watcher.pollOnce();
  assert.equal(f.events.some((event) => event.event_type === "task_finished"), false);
  assert.equal(watcher.getDiagnostics().codes.includes("codex_jsonl_unsupported_shape"), true);
  assert.equal(watcher.getDiagnostics().codes.includes("codex_jsonl_malformed_row"), true);
  const projection = JSON.stringify(f.events);
  assert.equal(projection.includes("PRIVATE_SECRET"), false);
  assert.equal(projection.includes("PRIVATE_ERROR"), false);
  assert.equal(projection.includes("/private/user/project"), false);
  await watcher.stop();
});

test("existing history is silently baselined; a later new turn emits session and task start", async (t) => {
  const f = await fixture(t);
  const existing = logFile(f.sessionsRoot);
  await fs.writeFile(existing, `${meta()}\n${start()}\n${complete()}\n`);
  const watcher = new CodexSessionWatcher(f.options);
  await watcher.start();
  assert.deepEqual(f.events, []);

  await fs.appendFile(existing, `${start(TURN_2, 4)}\n`);
  await watcher.pollOnce();
  assert.deepEqual(f.events.map((event) => event.event_type), ["session_started", "task_started"]);
  assert.match(String(f.events[0]?.session_id), /^codex:sess:[0-9a-f]{64}$/);
  assert.equal(f.events[0]?.session_title, `Codex ${createHash("sha256").update(SESSION).digest("hex").slice(-6)}`);
  assert.match(String(f.events[1]?.task_id), /^codex:turn:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(f.events).includes("PRIVATE_PROMPT"), false);
  await watcher.stop();
});

test("new rollout is live; successful finish, neutral unknown errors, known error, and abort map safely", async (t) => {
  const f = await fixture(t);
  const watcher = new CodexSessionWatcher(f.options);
  await watcher.start();
  const active = logFile(f.sessionsRoot);
  await fs.writeFile(active, `${meta()}\n${start()}\n`);
  await watcher.pollOnce();
  assert.deepEqual(f.events.map((event) => event.event_type), ["session_started", "task_started"]);

  await fs.appendFile(active, `${complete(TURN_1, null, 4)}\n`);
  await watcher.pollOnce();
  assert.equal(f.events.at(-1)?.event_type, "task_finished");

  await fs.appendFile(active, `${start(TURN_2, 5)}\n${complete(TURN_2, { codex_error_info: "other", message: "PRIVATE_ERROR" }, 6)}\n`);
  await watcher.pollOnce();
  assert.deepEqual(f.events.slice(-2).map((event) => event.event_type), ["task_started", "session_ended"]);

  const turn3 = "018f1f5e-7b2c-7abc-8def-0123456789ae";
  await fs.appendFile(active, `${start(turn3, 7)}\n${complete(turn3, { codex_error_info: "server_overloaded", message: "PRIVATE_ERROR" }, 8)}\n`);
  await watcher.pollOnce();
  assert.deepEqual(f.events.slice(-3).map((event) => event.event_type), ["session_started", "task_started", "task_failed"]);

  const turn4 = "018f1f5e-7b2c-7abc-8def-0123456789af";
  await fs.appendFile(active, `${start(turn4, 9)}\n${row("event_msg", { type: "turn_aborted", turn_id: turn4 }, 10)}\n`);
  await watcher.pollOnce();
  assert.deepEqual(f.events.slice(-3).map((event) => event.event_type), ["session_started", "task_started", "session_ended"]);
  assert.equal(JSON.stringify(f.events).includes("PRIVATE_ERROR"), false);
  assert.equal(JSON.stringify(f.events).includes("PRIVATE_MESSAGE"), false);
  await watcher.stop();
});

test("partial rows, duplicate ordinals, and copied same-session files do not replay", async (t) => {
  const f = await fixture(t);
  const source = logFile(f.sessionsRoot);
  await fs.writeFile(source, `${meta()}\n`);
  const watcher = new CodexSessionWatcher(f.options);
  await watcher.start();
  const taskRow = start(TURN_1, 2);
  await fs.appendFile(source, taskRow.slice(0, 30));
  await watcher.pollOnce();
  assert.deepEqual(f.events, []);
  await fs.appendFile(source, `${taskRow.slice(30)}\n`);
  await watcher.pollOnce();
  assert.deepEqual(f.events.map((event) => event.event_type), ["session_started", "task_started"]);
  await fs.appendFile(source, `${taskRow}\n`);
  await watcher.pollOnce();
  assert.equal(f.events.length, 2);

  const copy = logFile(f.sessionsRoot, "rollout-copy.jsonl");
  await fs.copyFile(source, copy);
  await watcher.pollOnce();
  assert.equal(f.events.length, 2);
  await watcher.stop();
});

test("multi-poll initial baseline does not swallow a terminal row appended after its high-water mark", async (t) => {
  const f = await fixture(t);
  const active = logFile(f.sessionsRoot);
  const noise = Array.from({ length: 1_200 }, () => row("event_msg", { type: "token_count", info: { total_tokens: 1 } })).join("\n");
  await fs.writeFile(active, `${meta()}\n${start()}\n${noise}\n`);
  const watcher = new CodexSessionWatcher({ ...f.options, maxBytesPerPoll: 32 * 1024, maxBytesPerFile: 32 * 1024 });
  await watcher.start();
  assert.deepEqual(f.events, []);
  await fs.appendFile(active, `${complete()}\n`);
  for (let attempt = 0; attempt < 20 && f.events.every((event) => event.event_type !== "task_finished"); attempt += 1) {
    await watcher.pollOnce();
  }
  assert.deepEqual(f.events.map((event) => event.event_type), ["session_started", "task_started", "task_finished"]);
  await watcher.stop();
});

test("restart restores a fresh active turn, then accepts its appended completion exactly once", async (t) => {
  const f = await fixture(t);
  const active = logFile(f.sessionsRoot);
  await fs.writeFile(active, `${meta()}\n${start()}\n`);
  const first = new CodexSessionWatcher(f.options);
  await first.start();
  assert.deepEqual(f.events.map((event) => event.event_type), ["session_started", "task_started"]);
  await first.stop();
  const mode = (await fs.stat(f.checkpointFile)).mode & 0o777;
  assert.equal(mode, 0o600);
  const saved = await fs.readFile(f.checkpointFile, "utf8");
  assert.equal(saved.includes(SESSION), false);
  assert.equal(saved.includes("PRIVATE_PROMPT"), false);

  f.events.length = 0;
  const second = new CodexSessionWatcher(f.options);
  await second.start();
  assert.deepEqual(f.events.map((event) => event.event_type), ["session_started", "task_started"]);
  await fs.appendFile(active, `${complete()}\n`);
  await second.pollOnce();
  assert.equal(f.events.at(-1)?.event_type, "task_finished");
  await second.pollOnce();
  assert.equal(f.events.filter((event) => event.event_type === "task_finished").length, 1);
  await second.stop();
});

test("restored live turn survives idle polls and a later terminal is emitted exactly once", async (t) => {
  const f = await fixture(t);
  const active = logFile(f.sessionsRoot);
  await fs.writeFile(active, `${meta()}\n${start()}\n`);
  const watcher = new CodexSessionWatcher(f.options);
  await watcher.start();
  assert.deepEqual(f.events.map((event) => event.event_type), ["session_started", "task_started"]);

  for (let i = 0; i < 3; i += 1) await watcher.pollOnce();
  assert.deepEqual(f.events.map((event) => event.event_type), ["session_started", "task_started"]);

  await fs.appendFile(active, `${complete()}\n`);
  await watcher.pollOnce();
  assert.deepEqual(f.events.map((event) => event.event_type), ["session_started", "task_started", "task_finished"]);
  for (let i = 0; i < 3; i += 1) await watcher.pollOnce();
  assert.deepEqual(f.events.map((event) => event.event_type), ["session_started", "task_started", "task_finished"]);
  await watcher.stop();
});

test("restart silently reconciles a terminal row written while stopped and neutral-closes old WORKING", async (t) => {
  const f = await fixture(t);
  const active = logFile(f.sessionsRoot);
  await fs.writeFile(active, `${meta()}\n${start()}\n`);
  const first = new CodexSessionWatcher(f.options);
  await first.start();
  await first.stop();
  await fs.appendFile(active, `${complete()}\n`);

  f.events.length = 0;
  const restarted = new CodexSessionWatcher(f.options);
  await restarted.start();
  assert.deepEqual(f.events.map((event) => event.event_type), ["session_ended"]);

  await fs.appendFile(active, `${start(TURN_2, 4)}\n`);
  await restarted.pollOnce();
  assert.deepEqual(f.events.slice(-2).map((event) => event.event_type), ["session_started", "task_started"]);
  assert.equal(f.events.some((event) => event.event_type === "task_finished"), false);
  await restarted.stop();
});

test("truncation establishes a silent baseline and stale activity closes neutrally", async (t) => {
  const f = await fixture(t);
  let now = Date.now();
  const options = { ...f.options, now: () => now, staleAfterMs: 100 };
  const active = logFile(f.sessionsRoot);
  await fs.writeFile(active, `${meta()}\n${start()}\n`);
  const watcher = new CodexSessionWatcher(options);
  await watcher.start();
  assert.deepEqual(f.events.map((event) => event.event_type), ["session_started", "task_started"]);
  await fs.writeFile(active, `${meta()}\n${row("event_msg", { type: "task_complete", turn_id: TURN_1 }, 3)}\n`);
  await watcher.pollOnce();
  assert.equal(f.events.some((event) => event.event_type === "task_finished"), false);

  await fs.appendFile(active, `${start(TURN_2, 4)}\n`);
  await watcher.pollOnce();
  assert.equal(f.events.at(-1)?.event_type, "task_started");
  now += 101;
  await watcher.pollOnce();
  assert.equal(f.events.at(-1)?.event_type, "session_ended");
  assert.equal(watcher.countersSnapshot().stale_sessions_ended, 1);
  await watcher.stop();
});

test("symlinked rollout and symlinked sessions root are rejected", async (t) => {
  const f = await fixture(t);
  const target = logFile(f.sessionsRoot, "rollout-target.jsonl");
  await fs.writeFile(target, `${meta()}\n${start()}\n`);
  await fs.symlink(target, logFile(f.sessionsRoot, "rollout-link.jsonl"));
  const watcher = new CodexSessionWatcher(f.options);
  await watcher.start();
  assert.deepEqual(f.events.map((event) => event.event_type), ["session_started", "task_started"]);
  await watcher.stop();

  const linkRoot = path.join(f.root, "linked-sessions");
  await fs.symlink(f.sessionsRoot, linkRoot);
  await assert.rejects(startCodexWatcher({ ...f.options, sessionsRoot: linkRoot }), { code: "codex_watch_start_failed" });
});

test("Codex classification uses explicit source and never parent, title or IDs", () => {
  for (const extra of [
    { thread_source: "subagent" },
    { source: { subagent: { thread_spawn: { parent_thread_id: PARENT_SESSION } } } },
    { source: { subagent: "review" } },
    { source: { subagent: { other: "guardian_review" } } },
  ]) {
    const parsed = parseCodexLifecycleLine(row("session_meta", { id: SESSION, ...extra }));
    assert.ok(parsed?.kind === "session_meta");
    assert.equal(parsed.sessionKind, "subagent");
  }
  for (const extra of [
    { parent_thread_id: PARENT_SESSION }, { thread_source: "unknown" },
    { title: "subagent" }, { source: { subagent: null } },
    { source: { subagent: 123 } }, { source: { subagent: { future: true } } },
    { source: { subagent: "future" } }, {},
    { source: { subagent: { other: 123 } } },
    { source: { subagent: { other: "" } } },
  ]) {
    const parsed = parseCodexLifecycleLine(row("session_meta", { id: SESSION, ...extra }));
    assert.ok(parsed?.kind === "session_meta");
    assert.equal(parsed.sessionKind, "main");
  }
});

test("guardian other variant corrects a cached main classification without replaying completion", async (t) => {
  const f = await fixture(t);
  const file = logFile(f.sessionsRoot);
  await fs.writeFile(file, `${row("session_meta", { id: SESSION, source: { subagent: { other: "guardian_review" } } })}\n${start()}\n`);
  const first = new CodexSessionWatcher(f.options);
  await first.start();
  await first.stop();
  const saved = JSON.parse(await fs.readFile(f.checkpointFile, "utf8"));
  // Emulate the previous parser's incorrect persisted classification.
  for (const state of saved.files) state.sessionKind = "main";
  await fs.writeFile(f.checkpointFile, JSON.stringify(saved));
  await fs.appendFile(file, `${complete(TURN_1, null)}\n`);
  f.events.length = 0;
  const restarted = new CodexSessionWatcher(f.options);
  await restarted.start();
  assert.equal(f.events.filter((event) => event.event_type === "session_classification_updated").length, 1);
  assert.equal(f.events.find((event) => event.event_type === "session_classification_updated")?.session_kind, "subagent");
  assert.equal(f.events.some((event) => event.event_type === "task_finished"), false);
  assert.equal(f.events.some((event) => event.event_type === "task_started"), false);
  await restarted.stop();
  assert.equal(JSON.parse(await fs.readFile(f.checkpointFile, "utf8")).files[0].sessionKind, "subagent");
});

test("old checkpoint reclassifies from bounded header without replaying completion", async (t) => {
  const f = await fixture(t);
  const file = logFile(f.sessionsRoot);
  await fs.writeFile(file, `${row("session_meta", { id: SESSION, thread_source: "subagent", parent_thread_id: PARENT_SESSION })}\n${start()}\n`);
  const first = new CodexSessionWatcher(f.options);
  await first.start();
  await first.stop();
  assert.ok(f.events.length > 0);
  assert.ok(f.events.every((event) => event.session_kind === "subagent"));
  const saved = JSON.parse(await fs.readFile(f.checkpointFile, "utf8"));
  for (const state of saved.files) delete state.sessionKind;
  await fs.writeFile(f.checkpointFile, JSON.stringify(saved));
  // A completion that occurred while the collector was stopped remains historical.
  await fs.appendFile(file, `${complete(TURN_1, null)}\n`);
  f.events.length = 0;
  const restarted = new CodexSessionWatcher(f.options);
  await restarted.start();
  assert.equal(f.events.filter((event) => event.event_type === "session_classification_updated").length, 1);
  assert.equal(f.events.some((event) => event.event_type === "task_finished"), false);
  assert.equal(f.events.some((event) => event.event_type === "task_started"), false);
  assert.ok(f.events.every((event) => event.session_kind === "subagent"));
  await restarted.stop();
  const migrated = JSON.parse(await fs.readFile(f.checkpointFile, "utf8"));
  assert.equal(migrated.files[0].sessionKind, "subagent");
  assert.equal(JSON.stringify(migrated).includes(PARENT_SESSION), false);
});

test("known subagent classification survives restart when source metadata becomes unknown", async (t) => {
  const f = await fixture(t);
  const file = logFile(f.sessionsRoot);
  const childMeta = row("session_meta", { id: SESSION, thread_source: "subagent" });
  await fs.writeFile(file, `${childMeta}\n${start()}\n`);
  const first = new CodexSessionWatcher(f.options);
  await first.start();
  await first.stop();
  // Keep inode, size and cursor identical while simulating an older metadata shape.
  const mainMeta = row("session_meta", { id: SESSION, thread_source: "unknown " });
  assert.equal(mainMeta.length, childMeta.length);
  const handle = await fs.open(file, "r+");
  await handle.write(mainMeta, 0, "utf8");
  await handle.close();
  f.events.length = 0;
  const restarted = new CodexSessionWatcher(f.options);
  await restarted.start();
  assert.ok(f.events.every((event) => event.session_kind === "subagent"));
  assert.equal(f.events.some((event) => event.event_type === "session_classification_updated"), false);
  await fs.appendFile(file, `${complete(TURN_1, null)}\n`);
  await restarted.pollOnce();
  assert.equal(f.events.find((event) => event.event_type === "task_finished")?.session_kind, "subagent");
  await restarted.stop();
});

test("old idle checkpoint corrects retained classification without lifecycle replay", async (t) => {
  const f = await fixture(t);
  const file = logFile(f.sessionsRoot);
  await fs.writeFile(file, `${row("session_meta", { id: SESSION, source: { subagent: "review" } })}\n${start()}\n${complete(TURN_1, null)}\n`);
  const first = new CodexSessionWatcher(f.options);
  await first.start();
  await first.stop();
  assert.deepEqual(f.events, []);
  const saved = JSON.parse(await fs.readFile(f.checkpointFile, "utf8"));
  for (const state of saved.files) delete state.sessionKind;
  await fs.writeFile(f.checkpointFile, JSON.stringify(saved));
  const restarted = new CodexSessionWatcher(f.options);
  await restarted.start();
  assert.deepEqual(f.events.map((event) => event.event_type), ["session_classification_updated"]);
  assert.equal(f.events[0]?.session_kind, "subagent");
  await restarted.stop();
  f.events.length = 0;
  const restored = new CodexSessionWatcher(f.options);
  await restored.start();
  assert.deepEqual(f.events, []);
  await restored.stop();
});

test("explicit child metadata in a silent copy corrects the reported peer once and retries safely", async (t) => {
  const f = await fixture(t);
  const active = logFile(f.sessionsRoot, "rollout-active.jsonl");
  await fs.writeFile(active, `${meta()}\n${start()}\n`);
  let rejectCorrection = false;
  const watcher = new CodexSessionWatcher({ ...f.options, emit: async (event) => {
    if (rejectCorrection && event.event_type === "session_classification_updated") {
      rejectCorrection = false;
      throw new Error("temporary sink unavailable");
    }
    f.events.push(event as unknown as Record<string, unknown>);
  } });
  await watcher.start();
  await fs.appendFile(active, `${start(TURN_2, 4)}\n`);
  await watcher.pollOnce();
  assert.ok(f.events.every((event) => event.session_kind === "main"));
  f.events.length = 0;
  const copy = logFile(f.sessionsRoot, "rollout-child-copy.jsonl");
  await fs.writeFile(copy, `${row("session_meta", { id: SESSION, thread_source: "subagent" })}\n${start()}\n${complete(TURN_1, null)}\n`);
  const historicalTime = new Date(Date.now() - 60_000);
  await fs.utimes(copy, historicalTime, historicalTime);
  rejectCorrection = true;
  await watcher.pollOnce();
  assert.deepEqual(f.events, []);
  await watcher.pollOnce();
  assert.deepEqual(f.events.map((event) => event.event_type), ["session_classification_updated"]);
  assert.equal(f.events[0]?.session_kind, "subagent");
  await watcher.pollOnce();
  assert.equal(f.events.length, 1);
  // Completion on the live stream still arrives, carrying the corrected classification.
  await fs.appendFile(active, `${complete(TURN_2, null, 5)}\n`);
  await watcher.pollOnce();
  assert.equal(f.events.filter((event) => event.event_type === "session_classification_updated").length, 1);
  assert.equal(f.events.filter((event) => event.event_type === "task_finished").length, 1);
  assert.equal(f.events.find((event) => event.event_type === "task_finished")?.session_kind, "subagent");
  await watcher.stop();
});
