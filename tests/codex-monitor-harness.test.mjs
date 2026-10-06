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
    const completeA = rolloutRow("event_msg", {
      type: "task_complete", turn_id: codexTurnA, error: null, result: sentinel,
    }, 2);
    await writeFile(rolloutA, `${sourcePreambleA}\n${startA}\n`, { mode: 0o600 });
    await waitFor(() => {
      const events = relay.repository.listEventsAfter(installationId, -1).map((row) => row.event);
      return events.some((event) => event.event_type === "task_started" && event.session_id === `codex:sess:${sha(codexSessionA)}`)
        ? events
        : undefined;
    });

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
    assert.equal(completedSnapshot.recent_completion.display_name, "Codex");

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
    assert.equal(finalSnapshot.recent_completion.display_name, "Codex");
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
