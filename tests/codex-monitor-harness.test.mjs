import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCollectorRuntime } from "../services/collector/src/cli.ts";
import { sendUnixSocketPayload } from "../services/collector/src/socket.ts";
import { createRelayServer } from "../services/relay/src/server.ts";
import { loadConfig } from "../services/relay/src/config.ts";
import { JsonLogger } from "../services/relay/src/logger.ts";
import { Relay } from "../services/relay/src/relay.ts";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (value) => createHash("sha256").update(value.toLowerCase(), "utf8").digest("hex");

async function waitFor(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
  throw new Error("codex_monitor_harness_timeout");
}

function rolloutRow(type, payload, ordinal) {
  return JSON.stringify({ type, timestamp: new Date().toISOString(), ordinal, payload });
}

async function runSharedDaemonRelayCase(t, storageKind) {
  const root = await mkdtemp(join(tmpdir(), `codex-monitor-${storageKind}-`));
  const sessionsRoot = join(root, "sessions");
  const dataDir = join(root, "collector-data");
  const socketPath = join(root, "collector.sock");
  const codexSessionA = randomUUID();
  const codexTurnA = randomUUID();
  const codexSessionB = randomUUID();
  const codexTurnB = randomUUID();
  const sentinel = "never-export-this-private-fixture";
  await mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
  const metadataIndex = join(root, "session_index.jsonl");
  await writeFile(metadataIndex, `${JSON.stringify({ id: codexSessionA, thread_name: "修复 Codex 真实任务名称", updated_at: "2026-10-07T00:00:00Z" })}\n`);

  const config = loadConfig({}, {
    host: "127.0.0.1",
    port: 0,
    authMode: "development",
    ...(storageKind === "sqlite" ? { databasePath: join(root, "relay.sqlite") } : {}),
    staleAfterMs: 60_000,
    offlineAfterMs: 120_000,
    bookkeepingIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
  });
  const relayLogger = new JsonLogger({ sink: () => undefined });
  const relay = new Relay({ config, logger: relayLogger });
  const server = createRelayServer({ relay, logger: relayLogger });
  await server.app.listen({ host: config.host, port: config.port });
  const address = server.app.server.address();
  assert.ok(address && typeof address === "object");
  const installationId = `codex-smoke-${randomUUID()}`;

  let phone;
  let runtime;
  const snapshots = [];
  try {
    phone = new WebSocket(`ws://127.0.0.1:${address.port}/ws/android?installation_id=${encodeURIComponent(installationId)}&client_id=codex-smoke-phone`);
    phone.addEventListener("message", (message) => {
      try {
        const value = JSON.parse(String(message.data));
        const snapshot = value.type === "hello_ack" ? value.snapshot : value;
        if (snapshot?.type === "snapshot") snapshots.push(snapshot);
      } catch {
        // Invalid messages are ignored by the test observer.
      }
    });
    await waitFor(() => phone.readyState === WebSocket.OPEN);

    runtime = await createCollectorRuntime({
      dataDir,
      socketPath,
      relayUrl: `ws://127.0.0.1:${address.port}/ws/collector`,
      installationId,
      watchCodex: true,
      sessionsRoot,
      checkpointFile: join(dataDir, "codex-checkpoint.json"),
    });
    assert.ok(runtime.codexWatcher, "the read-only watcher must finish startup before runtime returns");
    assert.equal(relay.repository.storageKind, storageKind);

    const rolloutA = join(sessionsRoot, "rollout-complete.jsonl");
    const sourcePreambleA = JSON.stringify({
      type: "session_meta",
      payload: { id: codexSessionA, cwd: `/private/path/${sentinel}`, prompt: sentinel },
    });
    const startA = rolloutRow("event_msg", {
      type: "task_started", turn_id: codexTurnA, command: sentinel, prompt: sentinel,
    }, 1);
    await writeFile(rolloutA, `${sourcePreambleA}\n${startA}\n`, { mode: 0o600 });
    await waitFor(() => {
      const events = relay.repository.listEventsAfter(installationId, -1).map((row) => row.event);
      return events.some((event) => event.event_type === "task_started" && event.session_id === `codex:sess:${sha(codexSessionA)}`)
        ? events
        : undefined;
    });

    const codexSessionIdForRename = `codex:sess:${sha(codexSessionA)}`;
    const lifecycleCountBeforeRename = relay.repository.listEventsAfter(installationId, -1)
      .filter((row) => ["session_started", "task_started", "task_finished"].includes(row.event.event_type)).length;
    await appendFile(metadataIndex, `${JSON.stringify({ id: codexSessionA, thread_name: "Codex 原生名称已更新", updated_at: "2026-10-08T00:00:00Z" })}\n`);
    await waitFor(() => relay.repository.listEventsAfter(installationId, -1).some((row) =>
      row.event.event_type === "session_title_updated" && row.event.session_id === codexSessionIdForRename));
    const renamedSnapshot = relay.snapshot(installationId);
    assert.equal(renamedSnapshot.sessions.find((session) => session.session_id === codexSessionIdForRename)?.title, "Codex 原生名称已更新");
    assert.equal(renamedSnapshot.sessions.find((session) => session.session_id === codexSessionIdForRename)?.claude_state, "working");
    assert.equal(relay.repository.listEventsAfter(installationId, -1)
      .filter((row) => ["session_started", "task_started", "task_finished"].includes(row.event.event_type)).length,
    lifecycleCountBeforeRename, "rename emits metadata without replaying lifecycle");

    // Deliberately make valid Claude identities equal the canonical Codex IDs.
    // The shared Collector must namespace-escape them before Relay sees them.
    const codexSessionIdA = `codex:sess:${sha(codexSessionA)}`;
    const codexTaskIdA = `codex:turn:${sha(codexTurnA)}`;
    const claudeSessionRaw = codexSessionIdA;
    const claudeTaskRaw = codexTaskIdA;
    const claudeSessionId = `claude:session:${sha(claudeSessionRaw)}`;
    const claudeTaskId = `claude:task:${sha(claudeTaskRaw)}`;
    await sendUnixSocketPayload(socketPath, {
      hook_event_name: "SessionStart",
      session_id: claudeSessionRaw,
      session_title: "Claude worker",
      cwd: `/private/path/${sentinel}`,
      prompt: sentinel,
      timestamp: new Date().toISOString(),
    });
    await waitFor(() => relay.repository.listEventsAfter(installationId, -1).some((row) =>
      row.event.event_type === "session_started" && row.event.session_id === claudeSessionId));
    await sendUnixSocketPayload(socketPath, {
      hook_event_name: "UserPromptSubmit",
      session_id: claudeSessionRaw,
      task_id: claudeTaskRaw,
      prompt_id: claudeTaskRaw,
      prompt: sentinel,
      command: sentinel,
      timestamp: new Date().toISOString(),
    });
    await waitFor(() => relay.repository.listEventsAfter(installationId, -1).some((row) =>
      row.event.event_type === "task_started" && row.event.session_id === claudeSessionId));

    const completeA = rolloutRow("event_msg", {
      type: "task_complete", turn_id: codexTurnA, error: null, result: sentinel,
    }, 2);
    await appendFile(rolloutA, `${completeA}\n`);
    const codexCompleted = await waitFor(() => {
      const events = relay.repository.listEventsAfter(installationId, -1).map((row) => row.event);
      return events.some((event) => event.event_type === "task_finished" && event.session_id === codexSessionIdA)
        ? events
        : undefined;
    });
    const completedSnapshot = relay.snapshot(installationId);
    assert.equal(completedSnapshot.claude_state, "working", "Claude remains working after Codex completes");
    assert.equal(completedSnapshot.running_count, 1);
    assert.equal(completedSnapshot.sessions.find((session) => session.session_id === claudeSessionId)?.claude_state, "working");
    assert.equal(completedSnapshot.sessions.find((session) => session.session_id === codexSessionIdA)?.claude_state, "idle");
    assert.equal(completedSnapshot.recent_completion.session_id, codexSessionIdA);
    assert.equal(completedSnapshot.recent_completion.task_id, codexTaskIdA);
    assert.equal(completedSnapshot.recent_completion.display_name, "Codex 原生名称已更新");
    assert.equal(completedSnapshot.recent_completion.display_name, completedSnapshot.sessions.find((session) => session.session_id === codexSessionIdA)?.title);

    const rolloutB = join(sessionsRoot, "rollout-aborted.jsonl");
    const startB = rolloutRow("event_msg", {
      type: "task_started", turn_id: codexTurnB, command: sentinel, prompt: sentinel,
    }, 1);
    const abortB = rolloutRow("event_msg", {
      type: "turn_aborted", turn_id: codexTurnB, reason: sentinel,
    }, 2);
    await writeFile(rolloutB, `${JSON.stringify({ type: "session_meta", payload: { id: codexSessionB } })}\n${startB}\n`, { mode: 0o600 });
    const codexSessionIdB = `codex:sess:${sha(codexSessionB)}`;
    await waitFor(() => relay.repository.listEventsAfter(installationId, -1).some((row) =>
      row.event.event_type === "task_started" && row.event.session_id === codexSessionIdB));
    await appendFile(rolloutB, `${abortB}\n`);
    const finalEvents = await waitFor(() => {
      const events = relay.repository.listEventsAfter(installationId, -1).map((row) => row.event);
      return events.some((event) => event.event_type === "session_ended" && event.session_id === codexSessionIdB)
        ? events
        : undefined;
    });

    const finalSnapshot = relay.snapshot(installationId);
    assert.equal(finalSnapshot.claude_state, "working", "Claude remains working after Codex interruption");
    assert.equal(finalSnapshot.running_count, 1);
    assert.equal(finalSnapshot.sessions.find((session) => session.session_id === claudeSessionId)?.claude_state, "working");
    assert.equal(finalSnapshot.recent_completion.session_id, codexSessionIdA, "the completed Codex turn remains visible after an unrelated interruption");
    assert.equal(finalSnapshot.recent_completion.task_id, codexTaskIdA);
    assert.equal(finalSnapshot.recent_completion.display_name, completedSnapshot.recent_completion.display_name);
    await waitFor(() => snapshots.some((snapshot) =>
      snapshot?.claude_state === "working" &&
      snapshot.sessions?.some((session) => session.session_id === claudeSessionId && session.claude_state === "working")));

    const sequence = finalEvents.map((event) => event.sequence);
    assert.deepEqual(sequence, [...sequence].sort((a, b) => a - b), "Claude socket and Codex watcher share one monotonic sequence");
    assert.deepEqual(sequence, Array.from({ length: sequence.length }, (_, index) => index + 1));
    assert.equal(await readFile(join(dataDir, "sequence.txt"), "utf8"), `${sequence.at(-1)}\n`);

    const codexCompletion = finalEvents.find((event) => event.event_type === "task_finished" && event.session_id === codexSessionIdA);
    const claudeStart = finalEvents.find((event) => event.event_type === "task_started" && event.session_id === claudeSessionId);
    const codexInterrupted = finalEvents.find((event) => event.event_type === "session_ended" && event.session_id === codexSessionIdB);
    assert.equal(codexCompletion?.task_id, codexTaskIdA);
    assert.equal(claudeStart?.task_id, claudeTaskId);
    assert.notEqual(claudeStart?.session_id, codexSessionIdA);
    assert.notEqual(claudeStart?.task_id, codexTaskIdA);
    assert.ok(codexInterrupted);
    assert.ok(finalEvents.every((event) => !JSON.stringify(event).includes(sentinel)));
    assert.ok(snapshots.every((snapshot) => !JSON.stringify(snapshot).includes(sentinel)));
    const checkpoint = await readFile(join(dataDir, "codex-checkpoint.json"), "utf8");
    const outbox = await readFile(join(dataDir, "outbox.json"), "utf8");
    assert.equal(checkpoint.includes(sentinel), false);
    assert.equal(checkpoint.includes(sessionsRoot), false);
    assert.equal(checkpoint.includes("修复 Codex 真实任务名称"), false);
    assert.equal(checkpoint.includes("Codex 原生名称已更新"), false);
    assert.equal(checkpoint.includes(codexSessionA), false);
    assert.equal(checkpoint.includes(codexSessionB), false);
    assert.equal(outbox.includes(sentinel), false);
    assert.equal(relay.snapshot(installationId).schema_version, 1);
    t.diagnostic(JSON.stringify({
      relay_storage: relay.repository.storageKind,
      event_types: finalEvents.map((event) => event.event_type),
      latest_sequence: sequence.at(-1),
      claude_state_after_codex_completion_and_abort: finalSnapshot.claude_state,
      codex_completion_retained: finalSnapshot.recent_completion.display_name,
      id_collision: "escaped",
      privacy_checks: "passed",
    }));
  } finally {
    await runtime?.stop();
    if (phone && phone.readyState < WebSocket.CLOSING) {
      const closed = new Promise((resolve) => phone.addEventListener("close", resolve, { once: true }));
      phone.close();
      await closed;
    }
    await waitFor(() => relay.stats().active_connections === 0);
    await server.app.close();
    await rm(root, { recursive: true, force: true });
  }
}

for (const storageKind of ["memory", "sqlite"]) {
  test(`Codex and Claude share one Collector, namespace, sequence, and ${storageKind} Relay`, async (t) => {
    await runSharedDaemonRelayCase(t, storageKind);
  });
}

for (const storageKind of ["memory", "sqlite"]) {
  test(`real Codex subagent collection keeps main presentation isolated through ${storageKind} Relay`, { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), `subagent-monitor-${storageKind}-`));
    const sessionsRoot = join(root, "sessions");
    const dataDir = join(root, "collector-data");
    const installationId = `subagent-smoke-${randomUUID()}`;
    await mkdir(sessionsRoot, { recursive: true });
    const config = loadConfig({}, {
      host: "127.0.0.1", port: 0, authMode: "development",
      ...(storageKind === "sqlite" ? { databasePath: join(root, "relay.sqlite") } : {}),
      staleAfterMs: 60_000, offlineAfterMs: 120_000,
      bookkeepingIntervalMs: 60_000, heartbeatIntervalMs: 60_000,
    });
    const logger = new JsonLogger({ sink: () => undefined });
    let relay;
    let server;
    let runtime;
    let phone;
    const deliveredEvents = [];
    const deliveredSnapshots = [];
    const mainIds = [randomUUID(), randomUUID()];
    const childIds = [randomUUID(), randomUUID(), randomUUID()];
    const turns = new Map();
    const wireId = (id) => `codex:sess:${sha(id)}`;
    async function startServices() {
      relay = new Relay({ config, logger });
      server = createRelayServer({ relay, logger });
      await server.app.listen({ host: config.host, port: config.port });
      const port = server.app.server.address().port;
      phone = new WebSocket(`ws://127.0.0.1:${port}/ws/android?installation_id=${installationId}&client_id=subagent-phone`);
      phone.addEventListener("message", (message) => {
        const value = JSON.parse(String(message.data));
        if (value.type === "event") deliveredEvents.push(value);
        const snapshot = value.type === "hello_ack" ? value.snapshot : value;
        if (snapshot?.type === "snapshot") deliveredSnapshots.push(snapshot);
      });
      await waitFor(() => phone.readyState === WebSocket.OPEN);
      runtime = await createCollectorRuntime({
        dataDir, socketPath: join(root, "collector.sock"),
        relayUrl: `ws://127.0.0.1:${port}/ws/collector`, installationId,
        watchCodex: true, sessionsRoot, checkpointFile: join(dataDir, "codex-checkpoint.json"),
      });
    }
    async function stopServices() {
      await runtime?.stop();
      runtime = undefined;
      if (phone && phone.readyState < WebSocket.CLOSING) {
        const closed = new Promise((resolve) => phone.addEventListener("close", resolve, { once: true }));
        phone.close();
        await closed;
      }
      if (server) await waitFor(() => relay.stats().active_connections === 0);
      await server?.app.close();
      server = undefined;
    }
    async function writeThread(id, metadata) {
      const turn = randomUUID();
      turns.set(id, turn);
      await writeFile(join(sessionsRoot, `rollout-${id}.jsonl`), [
        rolloutRow("session_meta", { id, session_id: mainIds[0], ...metadata }, 0),
        rolloutRow("event_msg", { type: "task_started", turn_id: turn }, 1),
      ].join("\n") + "\n");
    }
    async function finishThread(id) {
      await appendFile(join(sessionsRoot, `rollout-${id}.jsonl`), rolloutRow("event_msg", {
        type: "task_complete", turn_id: turns.get(id), error: null,
      }, 2) + "\n");
      await waitFor(() => relay.repository.listEventsAfter(installationId, -1).some((row) =>
        row.event.event_type === "task_finished" && row.event.session_id === wireId(id)));
    }
    try {
      await startServices();
      await writeThread(mainIds[0], { source: "cli" });
      // An ordinary derived session is still main when only a parent is present.
      await writeThread(mainIds[1], { parent_thread_id: mainIds[0], source: "unknown-format" });
      await writeThread(childIds[0], { thread_source: "subagent", parent_thread_id: mainIds[0] });
      await writeThread(childIds[1], { source: { subagent: { thread_spawn: { parent_thread_id: mainIds[0] } } } });
      await writeThread(childIds[2], { source: { subagent: { other: "guardian_review" } } });
      await waitFor(() => relay.snapshot(installationId).total_running_count === 5);
      const first = relay.snapshot(installationId);
      assert.equal(first.main_running_count, 2);
      assert.equal(first.main_session_count, 2);
      assert.deepEqual(new Set(first.sessions.map((session) => session.session_id)), new Set(mainIds.map(wireId)));
      assert.equal(first.claude_state, "working");

      await finishThread(mainIds[0]);
      const mainCompleted = relay.snapshot(installationId);
      assert.equal(mainCompleted.main_running_count, 1);
      assert.equal(mainCompleted.total_running_count, 4);
      assert.equal(mainCompleted.recent_completion.session_id, wireId(mainIds[0]));
      const activity = mainCompleted.activity;
      await finishThread(childIds[0]);
      const childCompleted = relay.snapshot(installationId);
      assert.equal(childCompleted.main_running_count, 1);
      assert.equal(childCompleted.total_running_count, 3);
      assert.deepEqual(childCompleted.recent_completion, mainCompleted.recent_completion);
      assert.deepEqual(childCompleted.activity, activity);

      await finishThread(mainIds[1]);
      const childrenOnly = relay.snapshot(installationId);
      assert.equal(childrenOnly.main_running_count, 0);
      assert.equal(childrenOnly.total_running_count, 2);
      assert.equal(childrenOnly.claude_state, "idle");
      for (let index = 0; index < 6; index++) {
        await writeThread(randomUUID(), { thread_source: "subagent", parent_thread_id: mainIds[0] });
      }
      await waitFor(() => relay.snapshot(installationId).total_running_count === 8);
      assert.equal(relay.snapshot(installationId).sessions.length, 2);
      assert.equal(relay.snapshot(installationId).main_session_count, 2);
      assert.equal(relay.snapshot(installationId).claude_state, "idle");
      await waitFor(() => deliveredEvents.some((event) => event.event_type === "task_finished" && event.session_id === wireId(childIds[0])));
      const childFinish = deliveredEvents.find((event) => event.event_type === "task_finished" && event.session_id === wireId(childIds[0]));
      assert.equal(childFinish.session_kind, "subagent");
      assert.ok(deliveredSnapshots.some((snapshot) => snapshot.main_running_count === 0 && snapshot.total_running_count === 8));
      const beforeRestart = relay.repository.listEventsAfter(installationId, -1);
      assert.deepEqual(beforeRestart.map((row) => row.event.sequence), beforeRestart.map((_, index) => index + 1));
      const finishes = beforeRestart.filter((row) => row.event.event_type === "task_finished").length;
      if (storageKind === "sqlite") {
        await stopServices();
        await startServices();
        await waitFor(() => relay.snapshot(installationId).total_running_count === 8);
        const restored = relay.snapshot(installationId);
        assert.equal(restored.main_running_count, 0);
        // Existing restart reconciliation neutrally closes already-completed sessions.
        assert.equal(restored.main_session_count, 0);
        assert.equal(restored.claude_state, "idle");
        assert.equal(restored.sessions.length, 0);
        assert.equal(relay.repository.listEventsAfter(installationId, -1)
          .filter((row) => row.event.event_type === "task_finished").length, finishes);
      }
    } finally {
      await stopServices();
      await rm(root, { recursive: true, force: true });
    }
  });
}
