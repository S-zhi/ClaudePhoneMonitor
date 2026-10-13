import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stderr } from "node:process";
import test from "node:test";
import { Collector } from "../services/collector/src/collector.ts";
import { createCollectorRuntime } from "../services/collector/src/cli.ts";
import { startMagpieSessionsWatcher } from "../services/collector/src/magpie-sessions.ts";
import { InMemoryRelayRepository, SqliteRelayRepository } from "../services/relay/src/repository.ts";
import { createRelayServer } from "../services/relay/src/server.ts";
import { loadConfig } from "../services/relay/src/config.ts";
import { JsonLogger } from "../services/relay/src/logger.ts";
import { Relay } from "../services/relay/src/relay.ts";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const started = "2026-10-01T00:00:00Z";
const changed = "2026-10-02T00:00:00Z";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(25);
  }
  throw new Error("magpie_harness_timeout");
}

for (const storage of ["memory", "sqlite"]) {
  test(`Magpie Collector envelopes preserve native activity and history in ${storage}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "magpie-integration-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = storage === "sqlite"
      ? new SqliteRelayRepository(join(root, "relay.sqlite"))
      : new InMemoryRelayRepository();
    t.after(() => repository.close?.());
    const uuid = randomUUID();
    const sessionId = `codex:sess:${hash(uuid)}`;
    const metadataIndex = join(root, "session_index.jsonl");
    const nativeTitle = (name, time) => JSON.stringify({ id: uuid, thread_name: name, updated_at: time, first_user_message: "PRIVATE FIRST PROMPT" }) + "\n";
    await writeFile(metadataIndex, nativeTitle("Native name", started));
    let sequence = 0;
    const envelopes = [];
    const collector = new Collector({
      installationId: "magpie-harness",
      sequence: { next: async () => ++sequence, current: async () => sequence },
      outbox: {
        enqueue: async (item) => {
          envelopes.push(item.payload);
          repository.recordEvent(item.payload, "2026-10-03T00:00:00Z");
        },
        size: async () => 0,
      },
      now: () => new Date("2026-10-03T00:00:00Z"),
    });
    const native = {
      event_type: "task_started", session_id: sessionId, task_id: "codex:turn:fixture",
      agent_id: "codex", occurred_at: "2026-10-03T00:00:00Z", payload: {},
    };
    await collector.ingestNormalized(native);
    const before = repository.getInstallationState("magpie-harness", "2026-10-03T00:00:01Z");
    assert.equal(before.main_running_count, 1);

    let output = JSON.stringify([
      { agent: "codex", id: uuid, title: "PRIVATE FIRST PROMPT", start: started, last: changed, cwd: "/private/path" },
      { agent: "pi", id: "pi-history", title: "PRIVATE FIRST PROMPT", start: started, last: changed },
      { agent: "claude-code", id: "existing-hook-id", title: "PRIVATE FIRST PROMPT", last: changed },
    ]);
    const watcher = await startMagpieSessionsWatcher({
      command: async () => output,
      checkpointFile: join(root, "checkpoint.json"),
      codexMetadataRoot: root,
      excludedAgentIds: ["claude_code"],
      pollIntervalMs: 60_000,
      emit: async (event) => { await collector.ingestNormalized(event); },
    });
    t.after(() => watcher.stop());
    assert.equal(envelopes.length, 3);
    assert.equal(envelopes[1].session_id, sessionId);
    assert.equal(envelopes[1].session_title, "Native name");
    assert.equal(envelopes[1].event_type, "session_metadata_updated");
    assert.ok(!JSON.stringify(envelopes).includes("PRIVATE FIRST PROMPT"));
    assert.ok(!JSON.stringify(envelopes).includes("/private/path"));
    const snapshot = repository.getInstallationState("magpie-harness", "2026-10-03T00:00:01Z");
    assert.equal(snapshot.main_running_count, 1);
    assert.equal(snapshot.activity?.event_type, "task_started");
    assert.equal(snapshot.history_sessions?.find((item) => item.session_id === sessionId)?.activity_status, "working");
    assert.equal(snapshot.history_sessions?.find((item) => item.agent_id === "pi")?.activity_status, "unknown");
    assert.equal(snapshot.history_sessions?.some((item) => item.agent_id === "claude_code"), false);

    await writeFile(metadataIndex, nativeTitle("Verified rename", changed));
    output = JSON.stringify([{ agent: "codex", id: uuid, title: "PRIVATE FIRST PROMPT", start: started, last: changed }]);
    await watcher.pollOnce();
    assert.equal(envelopes.at(-1)?.session_title, "Verified rename");
    assert.equal(repository.getInstallationState("magpie-harness", "2026-10-03T00:00:01Z").main_running_count, 1);
    assert.equal(repository.getInstallationState("magpie-harness", "2026-10-03T00:00:01Z").history_sessions
      ?.find((item) => item.session_id === sessionId)?.title, "Verified rename");
    assert.ok(!JSON.stringify(await readFile(join(root, "checkpoint.json"), "utf8")).includes("Verified rename"));
    await watcher.stop();
  });
}

test("fake Magpie CLI traverses runtime, Relay parsing and Android snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "magpie-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureFile = join(root, "magpie.json");
  const binary = join(root, "magpie-fixture");
  const uuid = randomUUID();
  const sessionId = `codex:sess:${hash(uuid)}`;
  const installationId = `magpie-runtime-${randomUUID()}`;
  await writeFile(fixtureFile, JSON.stringify([
    { agent: "codex", id: uuid, title: "PRIVATE PROMPT",
      start: started, last: changed, cwd: "/private/project" },
    { agent: "pi", id: "identity-only", title: "PRIVATE PROMPT" },
  ]));
  await writeFile(binary, `#!/bin/sh\ncat '${fixtureFile}'\n`);
  await chmod(binary, 0o700);
  await writeFile(join(root, "session_index.jsonl"),
    JSON.stringify({ id: uuid, thread_name: "Verified native name", updated_at: changed }) + "\n");

  const config = loadConfig({}, {
    host: "127.0.0.1", port: 0, authMode: "development",
    databasePath: join(root, "relay.sqlite"),
    staleAfterMs: 60_000, offlineAfterMs: 120_000,
    bookkeepingIntervalMs: 60_000, heartbeatIntervalMs: 60_000,
  });
  const logger = new JsonLogger({ sink: () => undefined });
  const relay = new Relay({ config, logger });
  const server = createRelayServer({ relay, logger });
  await server.app.listen({ host: config.host, port: config.port });
  const address = server.app.server.address();
  assert.ok(address && typeof address === "object");
  let phone;
  let runtime;
  const snapshots = [];
  try {
    phone = new WebSocket(`ws://127.0.0.1:${address.port}/ws/android?installation_id=${encodeURIComponent(installationId)}&client_id=magpie-test-phone`);
    phone.addEventListener("message", (message) => {
      try {
        const value = JSON.parse(String(message.data));
        const snapshot = value.type === "hello_ack" ? value.snapshot : value;
        if (snapshot?.type === "snapshot") snapshots.push(snapshot);
      } catch { /* Only valid snapshots matter here. */ }
    });
    await waitFor(() => phone.readyState === WebSocket.OPEN);
    runtime = await createCollectorRuntime({
      dataDir: join(root, "collector-data"),
      socketPath: join(root, "collector.sock"),
      relayUrl: `ws://127.0.0.1:${address.port}/ws/collector`,
      installationId,
      watchMagpieSessions: true,
      magpieBin: binary,
      magpieSessionLimit: 7,
      magpiePollIntervalMs: 250,
      magpieCommandTimeoutMs: 1_000,
      codexMetadataRoot: root,
    });
    assert.ok(runtime.magpieWatcher);
    const events = await waitFor(() => {
      const rows = relay.repository.listEventsAfter(installationId, -1).map((item) => item.event);
      return rows.length >= 2 && rows.some((item) => item.session_id === sessionId && item.event_type === "session_metadata_updated") ? rows : undefined;
    });
    assert.equal(events.length, 2);
    assert.equal(events[0].session_title, "Verified native name");
    assert.equal(events[0].task_id, undefined);
    assert.deepEqual(events[1].payload, {});
    assert.equal(events[1].agent_id, "pi");
    assert.ok(!JSON.stringify(events).includes("PRIVATE PROMPT"));
    assert.ok(!JSON.stringify(events).includes("/private/project"));
    const phoneSnapshot = await waitFor(() => snapshots.find((item) =>
      item.history_sessions?.some((row) => row.session_id === sessionId && row.title === "Verified native name")
      && item.history_sessions?.some((row) => row.agent_id === "pi" && row.activity_status === "unknown")));
    assert.equal(phoneSnapshot.history_sessions.find((row) => row.session_id === sessionId).activity_status, "unknown");
    assert.equal(phoneSnapshot.history_sessions.find((row) => row.agent_id === "pi").activity_status, "unknown");
    assert.equal(phoneSnapshot.main_running_count, 0);
  } finally {
    await runtime?.stop();
    if (phone && phone.readyState < WebSocket.CLOSING) {
      const closed = new Promise((resolve) => phone.addEventListener("close", resolve, { once: true }));
      phone.close();
      await closed;
    }
    await waitFor(() => relay.stats().active_connections === 0);
    await server.app.close();
  }
});

test("invalid Magpie runtime limit reports fixed startup code", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "magpie-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalWrite = stderr.write;
  const diagnostics = [];
  stderr.write = function (chunk, ...args) { diagnostics.push(String(chunk)); return true; };
  let runtime;
  try {
    runtime = await createCollectorRuntime({
      dataDir: join(root, "data"), socketPath: join(root, "collector.sock"),
      watchMagpieSessions: true, magpieSessionLimit: NaN,
    });
    assert.equal(runtime.magpieWatcher, undefined);
    assert.deepEqual(diagnostics, ["magpie_sessions_watch_start_failed\n"]);
  } finally {
    stderr.write = originalWrite;
    await runtime?.stop();
  }
});
