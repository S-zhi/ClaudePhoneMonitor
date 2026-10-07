import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCollectorRuntime } from "../services/collector/src/cli.ts";
import { sendUnixSocketPayload } from "../services/collector/src/socket.ts";
import { createRelayServer } from "../services/relay/src/server.ts";
import { loadConfig } from "../services/relay/src/config.ts";
import { JsonLogger } from "../services/relay/src/logger.ts";
import { Relay } from "../services/relay/src/relay.ts";
import { FileOutbox } from "../services/collector/src/outbox.ts";
import { RelayClient } from "../services/collector/src/relay.ts";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
  throw new Error("usage_monitor_harness_timeout");
}

function timersWithManualReconnect() {
  const reconnects = [];
  return {
    reconnects,
    timers: {
      setTimeout(callback) { reconnects.push(callback); return callback; },
      clearTimeout(callback) { const i = reconnects.indexOf(callback); if (i >= 0) reconnects.splice(i, 1); },
      setInterval(callback) { return callback; },
      clearInterval() {},
    },
  };
}

class DropFirstAckSocket {
  constructor(url, firstAckSeen, duplicates) {
    this.socket = new WebSocket(url);
    this.firstAckSeen = firstAckSeen;
    this.duplicates = duplicates;
  }
  get readyState() { return this.socket.readyState; }
  send(value) { this.socket.send(value); }
  close(code, reason) { this.socket.close(code, reason); }
  addEventListener(type, listener) {
    if (type !== "message") { this.socket.addEventListener(type, listener); return; }
    this.socket.addEventListener(type, (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { listener(event); return; }
      if (message.type === "event_ack") {
        if (!this.firstAckSeen.has(message.event_id)) {
          this.firstAckSeen.add(message.event_id);
          this.socket.close(4000, "test_dropped_ack");
          return;
        }
        if (message.status === "duplicate") this.duplicates.push(message.event_id);
      }
      listener(event);
    });
  }
}

async function usageThroughRelay(t, storageKind) {
  const root = await mkdtemp(join(tmpdir(), `usage-monitor-${storageKind}-`));
  const claudeRoot = join(root, "claude-projects");
  const codexRoot = join(root, "codex-sessions");
  const dataDir = join(root, "collector-data");
  const socketPath = join(root, "collector.sock");
  await Promise.all([mkdir(claudeRoot, { recursive: true, mode: 0o700 }), mkdir(codexRoot, { recursive: true, mode: 0o700 })]);
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
  const logger = new JsonLogger({ sink: () => undefined });
  const relay = new Relay({ config, logger });
  const server = createRelayServer({ relay, logger });
  await server.app.listen({ host: config.host, port: config.port });
  const address = server.app.server.address();
  assert.ok(address && typeof address === "object");
  const installationId = `usage-${randomUUID()}`;
  const sentinel = "usage-private-source-sentinel";
  let phone;
  let runtime;
  const snapshots = [];
  try {
    phone = new WebSocket(`ws://127.0.0.1:${address.port}/ws/android?installation_id=${encodeURIComponent(installationId)}&client_id=usage-harness-phone`);
    phone.addEventListener("message", (message) => {
      try {
        const value = JSON.parse(String(message.data));
        const snapshot = value.type === "hello_ack" ? value.snapshot : value;
        if (snapshot?.type === "snapshot") snapshots.push(snapshot);
      } catch { /* Test observer intentionally ignores non-JSON. */ }
    });
    await waitFor(() => phone.readyState === WebSocket.OPEN);

    runtime = await createCollectorRuntime({
      dataDir,
      socketPath,
      relayUrl: `ws://127.0.0.1:${address.port}/ws/collector`,
      installationId,
      watchUsage: true,
      codexBinary: "",
      claudeProjectsRoot: claudeRoot,
      sessionsRoot: codexRoot,
      usageDatabaseFile: join(dataDir, "usage.sqlite"),
    });
    assert.ok(runtime.usageWatcher);
    assert.equal(relay.repository.storageKind, storageKind);
    await waitFor(() => relay.snapshot(installationId).usage?.provider_coverage?.claude?.status === "ready");

    await sendUnixSocketPayload(socketPath, {
      hook_event_name: "SessionStart",
      session_id: "usage-state-session",
      timestamp: new Date().toISOString(),
    });
    await sendUnixSocketPayload(socketPath, {
      hook_event_name: "UserPromptSubmit",
      session_id: "usage-state-session",
      task_id: "usage-state-task",
      timestamp: new Date().toISOString(),
    });
    await waitFor(() => relay.snapshot(installationId).claude_state === "working");
    const beforeUsage = relay.snapshot(installationId);

    await writeFile(join(claudeRoot, "usage.jsonl"), `${JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      sessionId: "private-session-id",
      message: {
        id: "private-message-id",
        model: "claude-test",
        usage: { input_tokens: 12, cache_read_input_tokens: 4, cache_creation_input_tokens: 3, output_tokens: 5 },
      },
      prompt: sentinel,
    })}\n`, { mode: 0o600 });
    await writeFile(join(codexRoot, "rollout-usage.jsonl"), `${JSON.stringify({
      type: "token_usage_record",
      timestamp: new Date().toISOString(),
      payload: {
        thread_id: "private-thread-id",
        response_id: "private-response-id",
        usage: { input_tokens: 9, cached_input_tokens: 4, output_tokens: 6 },
      },
      tool_output: sentinel,
    })}\n`, { mode: 0o600 });

    const latest = await waitFor(() => {
      const snapshot = relay.snapshot(installationId);
      return snapshot.usage?.observed_responses === 2 ? snapshot : undefined;
    });
    assert.equal(latest.usage.complete_responses, 2);
    assert.deepEqual(latest.usage.new_input, { value: 20, quality: "complete" });
    assert.deepEqual(latest.usage.cached_input, { value: 8, quality: "complete" });
    assert.deepEqual(latest.usage.output, { value: 11, quality: "complete" });
    assert.deepEqual(latest.usage.actual, { value: 31, quality: "complete" });
    assert.deepEqual(latest.usage.total_input, { value: 28, quality: "complete" });
    assert.equal(latest.claude_state, beforeUsage.claude_state);
    assert.deepEqual(latest.activity, beforeUsage.activity, "Usage-only updates preserve lifecycle activity");
    assert.deepEqual(latest.recent_completion, beforeUsage.recent_completion);
    assert.equal(relay.repository.listEventsAfter(installationId, -1).length, 2, "usage snapshots do not enter lifecycle event history");
    assert.ok(snapshots.some((snapshot) => snapshot.usage?.observed_responses === 2), "phone receives usage via ordinary snapshot");
    assert.ok(!JSON.stringify(latest).includes(sentinel));
    const ledger = await readFile(join(dataDir, "usage.sqlite"));
    assert.equal(ledger.includes(sentinel), false);
    assert.equal(ledger.includes("private-session-id"), false);
    assert.equal(ledger.includes("private-message-id"), false);
    const outbox = await readFile(join(dataDir, "outbox.json"), "utf8");
    assert.equal(outbox.includes(sentinel), false);
    assert.equal(outbox.includes("private-thread-id"), false);
    t.diagnostic(JSON.stringify({ relay_storage: storageKind, observed_responses: latest.usage.observed_responses, lifecycle_state_preserved: true, source_content_exported: false }));
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
  test(`Collector UsageWatcher reaches ${storageKind} Relay without changing lifecycle state`, async (t) => {
    await usageThroughRelay(t, storageKind);
  });

  test(`Relay duplicate ACK after dropped first ACK drains Usage and event outbox in ${storageKind}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `usage-duplicate-ack-${storageKind}-`));
    const config = loadConfig({}, {
      host: "127.0.0.1", port: 0, authMode: "development",
      ...(storageKind === "sqlite" ? { databasePath: join(root, "relay.sqlite") } : {}),
      staleAfterMs: 60_000, offlineAfterMs: 120_000, bookkeepingIntervalMs: 60_000, heartbeatIntervalMs: 60_000,
    });
    const logger = new JsonLogger({ sink: () => undefined });
    const relay = new Relay({ config, logger });
    const server = createRelayServer({ relay, logger });
    await server.app.listen({ host: config.host, port: config.port });
    const address = server.app.server.address();
    assert.ok(address && typeof address === "object");
    const installationId = `usage-ack-${randomUUID()}`;
    const outbox = new FileOutbox(join(root, "collector-outbox.json"));
    const { timers, reconnects } = timersWithManualReconnect();
    const firstAckSeen = new Set();
    const duplicates = [];
    const client = new RelayClient({
      url: `ws://127.0.0.1:${address.port}/ws/collector`,
      installationId,
      outbox,
      timers,
      jitterMs: 0,
      websocketFactory: (url) => new DropFirstAckSocket(url, firstAckSeen, duplicates),
    });
    try {
      const timestamp = new Date().toISOString();
      const aggregate = {
        epoch_id: "epoch-ack-fixture", started_at: timestamp, revision: 1,
        observed_responses: 0, complete_responses: 0,
        provider_coverage: {
          claude: { status: "ready", observed_responses: 0, complete_responses: 0 },
          codex: { status: "ready", observed_responses: 0, complete_responses: 0 },
        },
        new_input: { value: 0, quality: "complete" }, cached_input: { value: 0, quality: "complete" },
        output: { value: 0, quality: "complete" }, actual: { value: 0, quality: "complete" },
        total_input: { value: 0, quality: "complete" },
        cache_hit: { numerator: null, denominator: null, quality: "unavailable" },
        quota: { start_remaining: null, current_remaining: null, unit: null, reset_at: null, availability: "unavailable" },
      };
      const usageMessage = {
        type: "usage_snapshot", schema_version: 1, event_id: `${installationId}:1`, installation_id: installationId,
        sequence: 1, occurred_at: timestamp, usage: aggregate,
      };
      await outbox.enqueue({ id: usageMessage.event_id, sequence: 1, payload: usageMessage, created_at: timestamp });
      client.start();
      await waitFor(() => reconnects.length > 0 && firstAckSeen.has(usageMessage.event_id));
      reconnects.shift()();
      await waitFor(async () => await outbox.size() === 0 && duplicates.includes(usageMessage.event_id));
      assert.equal(relay.snapshot(installationId).usage.observed_responses, 0);

      const event = {
        type: "event", schema_version: 1, event_id: `${installationId}:2`, installation_id: installationId,
        session_id: "ack-session", sequence: 2, occurred_at: timestamp, event_type: "session_started", payload: {},
      };
      await outbox.enqueue({ id: event.event_id, sequence: 2, payload: event, created_at: timestamp });
      await client.flushPending();
      await waitFor(() => reconnects.length > 0 && firstAckSeen.has(event.event_id));
      reconnects.shift()();
      await waitFor(async () => await outbox.size() === 0 && duplicates.includes(event.event_id));
      assert.ok(relay.repository.listEventsAfter(installationId, -1).some((row) => row.event.event_id === event.event_id));
      assert.equal(relay.snapshot(installationId).claude_state, "idle");
    } finally {
      client.stop();
      await waitFor(() => relay.stats().active_connections === 0);
      await server.app.close();
      await outbox.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("transient outbox persistence failure retries the same Usage message through Relay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "usage-outbox-retry-"));
  const claudeRoot = join(root, "claude-projects");
  const codexRoot = join(root, "codex-sessions");
  const dataDir = join(root, "collector-data");
  const socketPath = join(root, "collector.sock");
  await Promise.all([mkdir(claudeRoot, { recursive: true, mode: 0o700 }), mkdir(codexRoot, { recursive: true, mode: 0o700 })]);
  const config = loadConfig({}, {
    host: "127.0.0.1", port: 0, authMode: "development", staleAfterMs: 60_000,
    offlineAfterMs: 120_000, bookkeepingIntervalMs: 60_000, heartbeatIntervalMs: 60_000,
  });
  const logger = new JsonLogger({ sink: () => undefined });
  const relay = new Relay({ config, logger });
  const server = createRelayServer({ relay, logger });
  await server.app.listen({ host: config.host, port: config.port });
  const address = server.app.server.address();
  assert.ok(address && typeof address === "object");
  const installationId = `usage-retry-${randomUUID()}`;
  let phone;
  let runtime;
  try {
    phone = new WebSocket(`ws://127.0.0.1:${address.port}/ws/android?installation_id=${encodeURIComponent(installationId)}&client_id=usage-retry-phone`);
    await waitFor(() => phone.readyState === WebSocket.OPEN);
    runtime = await createCollectorRuntime({
      dataDir, socketPath, relayUrl: `ws://127.0.0.1:${address.port}/ws/collector`, installationId,
      watchUsage: true, codexBinary: "", claudeProjectsRoot: claudeRoot, sessionsRoot: codexRoot,
      usageDatabaseFile: join(dataDir, "usage.sqlite"),
    });
    const initial = await waitFor(async () => {
      const snapshot = relay.snapshot(installationId);
      return snapshot.usage?.provider_coverage?.claude?.status === "ready" && await runtime.outbox.size() === 0
        ? snapshot.usage : undefined;
    });

    // Replace the already-loaded empty outbox file with a directory. Atomic
    // rename then fails once; removing it lets the watcher's stable pending
    // usage_message retry without restarting the collector.
    const outboxPath = join(dataDir, "outbox.json");
    await rm(outboxPath, { force: true });
    await mkdir(outboxPath);
    await writeFile(join(claudeRoot, "retry.jsonl"), `${JSON.stringify({
      type: "assistant", timestamp: new Date().toISOString(), sessionId: "private-session",
      message: { id: "private-message", model: "claude-test", usage: { input_tokens: 2, cache_read_input_tokens: 1, cache_creation_input_tokens: 0, output_tokens: 3 } },
    })}\n`, { mode: 0o600 });
    await waitFor(() => (runtime.usageWatcher?.getDiagnostics().emit_errors ?? 0) > 0);
    assert.equal(await runtime.outbox.size(), 0, "failed enqueue must not remain in memory");

    await rm(outboxPath, { recursive: true, force: true });
    // Let a later lifecycle sequence reach Relay before the pending Usage
    // snapshot retries its earlier stable sequence.
    await sendUnixSocketPayload(socketPath, {
      hook_event_name: "SessionStart", session_id: "usage-retry-state", timestamp: new Date().toISOString(),
    });
    await sendUnixSocketPayload(socketPath, {
      hook_event_name: "UserPromptSubmit", session_id: "usage-retry-state", task_id: "usage-retry-task", timestamp: new Date().toISOString(),
    });
    await waitFor(() => relay.snapshot(installationId).claude_state === "working");
    const acceptedSequence = relay.repository.getInstallationState(installationId).last_sequence;

    const retried = await waitFor(async () => {
      const snapshot = relay.snapshot(installationId).usage;
      return snapshot?.observed_responses === 1 && await runtime.outbox.size() === 0 ? snapshot : undefined;
    }, 12_000);
    assert.equal(retried.revision, initial.revision + 1);
    assert.equal(retried.observed_responses, 1);
    assert.equal(relay.snapshot(installationId).claude_state, "working");
    assert.equal(relay.repository.getInstallationState(installationId).last_sequence, acceptedSequence, "late Usage must not roll back the accepted state sequence");
    t.diagnostic(JSON.stringify({ storage: "memory", retry_after_transient_persist_failure: true, late_usage_after_state: true, observed_responses: retried.observed_responses }));
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
});
