import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
  throw new Error("issue32_startup_recovery_timeout");
}

for (const storageKind of ["memory", "sqlite"]) {
  test(`Claude lifecycle already accepted by Relay is restored in a late phone snapshot through ${storageKind} storage`, async () => {
    const root = await mkdtemp(join(tmpdir(), `issue32-claude-${storageKind}-`));
    const dataDir = join(root, "collector-data");
    const socketPath = join(root, "collector.sock");
    const installationId = `claude-startup-${randomUUID()}`;
    const sessionId = `claude-session-${randomUUID()}`;
    const taskId = `claude-task-${randomUUID()}`;
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
    let runtime;
    let phone;
    try {
      await server.app.listen({ host: config.host, port: config.port });
      const port = server.app.server.address().port;
      runtime = await createCollectorRuntime({
        dataDir,
        socketPath,
        relayUrl: `ws://127.0.0.1:${port}/ws/collector`,
        installationId,
      });

      await sendUnixSocketPayload(socketPath, {
        hook_event_name: "SessionStart",
        session_id: sessionId,
        session_title: "Synthetic Claude session",
      });
      await sendUnixSocketPayload(socketPath, {
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId,
        task_id: taskId,
      });
      await waitFor(() => relay.repository.listEventsAfter(installationId, -1).some((row) =>
        row.event.event_type === "task_started" && row.event.session_id === sessionId && row.event.task_id === taskId));

      const snapshots = [];
      phone = new WebSocket(`ws://127.0.0.1:${port}/ws/android?installation_id=${encodeURIComponent(installationId)}&client_id=issue32-claude-phone`);
      phone.addEventListener("message", (message) => {
        const value = JSON.parse(String(message.data));
        const snapshot = value.type === "hello_ack" ? value.snapshot : value;
        if (snapshot?.type === "snapshot") snapshots.push(snapshot);
      });
      await waitFor(() => phone.readyState === WebSocket.OPEN);
      await waitFor(() => snapshots.some((snapshot) => snapshot.claude_state === "working" &&
        snapshot.sessions?.some((session) => session.session_id === sessionId && session.claude_state === "working")));

      await sendUnixSocketPayload(socketPath, {
        hook_event_name: "Stop",
        session_id: sessionId,
        task_id: taskId,
      });
      await waitFor(() => relay.repository.listEventsAfter(installationId, -1).some((row) =>
        row.event.event_type === "task_finished" && row.event.session_id === sessionId && row.event.task_id === taskId));
      const events = relay.repository.listEventsAfter(installationId, -1).map((row) => row.event);
      assert.equal(events.filter((event) => event.event_type === "task_finished" && event.session_id === sessionId).length, 1);
      assert.equal(relay.snapshot(installationId).recent_completion?.task_id, taskId);
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
}
