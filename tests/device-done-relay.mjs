// Isolated Issue #27 device fixture: production Collector + paired SQLite Relay.
// All events, source timestamps, credentials and database files are synthetic.
// Build services first, then DEVICE_TEST_PORT=18887 node tests/device-done-relay.mjs.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCollectorRuntime } from "../services/collector/dist/cli.js";
import { createRelayServer } from "../services/relay/dist/src/server.js";
import { JsonLogger } from "../services/relay/dist/src/logger.js";

const requestedPort = Number(process.env.DEVICE_TEST_PORT ?? 18887);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error("invalid_fixture_port");
const installationId = "issue27-device-fixture";
const root = await mkdtemp(join(tmpdir(), "issue27-device-"));
const logger = new JsonLogger({ sink: () => undefined });
const { app, relay } = createRelayServer({ logger, config: {
  host: "127.0.0.1", port: requestedPort, authMode: "paired", databasePath: join(root, "relay.sqlite"),
  heartbeatIntervalMs: 1000, staleAfterMs: 120_000, offlineAfterMs: 240_000, bookkeepingIntervalMs: 1000,
} });
const phoneSockets = new Set();
const completed = new Set();
let runtime;
let token;
let port;
let busy = false;
let closing;
const names = {
  alpha: "Completed Alpha", beta: "Completed Beta", running: "Parallel Running",
  waiting: "Parallel Waiting", unused: "Never Started",
};
const sessionId = (key) => `issue27-${key}`;
const state = () => ({ installation_id: installationId, snapshot: relay.snapshot(installationId) });

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("device_fixture_timeout");
}

async function event(key, eventType, taskId, occurredAt = Date.now(), payload = {}) {
  const envelope = await runtime.collector.ingestNormalized({
    event_type: eventType, session_id: sessionId(key), session_kind: "main",
    ...(taskId ? { task_id: taskId } : {}),
    ...(["session_started", "task_started", "task_finished"].includes(eventType)
      ? { session_title: names[key] } : {}),
    occurred_at: new Date(occurredAt).toISOString(), payload,
  });
  await runtime.relay.flushPending();
  await waitFor(() => (relay.snapshot(installationId).last_sequence ?? 0) >= envelope.sequence);
}

app.get("/device-test/config", async (_request, reply) => token ? {
  installation_id: installationId, android_token: token, ws_url: `ws://127.0.0.1:${port}/ws/android`,
  source: "synthetic_normalized_events", synthetic_long_task_ms: 300_001,
} : reply.code(503).send({ error: "fixture_starting" }));
app.get("/device-test/state", async () => state());
app.post("/device-test/control", async (request, reply) => {
  if (!runtime || !token) return reply.code(503).send({ error: "fixture_starting" });
  if (busy) return reply.code(409).send({ error: "fixture_busy" });
  const operation = request.body?.operation;
  if (completed.has(operation)) return state();
  busy = true;
  try {
    switch (operation) {
      case "start": {
        await event("unused", "session_started");
        await event("waiting", "task_started", "waiting-turn");
        await event("waiting", "waiting", "waiting-turn", Date.now(), { reason: "unknown" });
        await event("running", "task_started", "running-turn");
        await event("beta", "task_started", "beta-turn");
        // This synthesizes source duration evidence, not elapsed device display time.
        await event("alpha", "task_started", "alpha-turn", Date.now() - 300_001);
        break;
      }
      case "finish_alpha": await event("alpha", "task_finished", "alpha-turn"); break;
      case "finish_beta": await event("beta", "task_finished", "beta-turn"); break;
      case "settle":
        await event("running", "task_failed", "running-turn");
        await event("waiting", "task_finished", "waiting-turn");
        break;
      case "restart_alpha": await event("alpha", "task_started", "alpha-next-turn"); break;
      case "wait_alpha": await event("alpha", "waiting", "alpha-next-turn", Date.now(), { reason: "unknown" }); break;
      case "finish_alpha_again": await event("alpha", "task_finished", "alpha-next-turn"); break;
      case "refresh": relay.broadcastSnapshotsForInstallation(installationId); return state();
      case "disconnect_phone":
        for (const socket of phoneSockets) socket.destroy();
        return state();
      default: return reply.code(400).send({ error: "unknown_fixture_operation" });
    }
    completed.add(operation);
    return state();
  } catch {
    return reply.code(500).send({ error: "fixture_operation_failed" });
  } finally { busy = false; }
});

async function close() {
  if (closing) return closing;
  closing = (async () => {
    await runtime?.stop();
    for (const socket of phoneSockets) socket.destroy();
    await waitFor(() => relay.stats().active_connections === 0).catch(() => undefined);
    for (const connection of relay.repository.listConnections()) relay.disconnect(connection.connection_id);
    await app.close();
    await rm(root, { recursive: true, force: true });
  })();
  return closing;
}
try {
  await app.ready();
  app.server.on("upgrade", (request, socket) => {
    if (!request.url?.startsWith("/ws/android")) return;
    phoneSockets.add(socket);
    socket.once("close", () => phoneSockets.delete(socket));
  });
  await app.listen({ host: "127.0.0.1", port: requestedPort });
  port = app.server.address().port;
  const pairing = relay.createPairing({ installation_id: installationId, public_url: `http://127.0.0.1:${port}` });
  token = relay.claimPairingResult(pairing.pairing_id, pairing.code, "issue27 isolated fixture").android_token;
  runtime = await createCollectorRuntime({ dataDir: join(root, "collector"), socketPath: join(root, "c.sock"),
    installationId, relayUrl: `ws://127.0.0.1:${port}/ws/collector`, relayToken: pairing.collector_token,
    watchCodex: false, watchUsage: false });
  await waitFor(() => relay.stats().collector_connections === 1);
  console.log(JSON.stringify({ status: "ready", port, installation_id: installationId,
    source: "synthetic_normalized_events", synthetic_long_task_ms: 300_001, reminder_clock: "real_device_monotonic" }));
} catch {
  await close().catch(() => undefined);
  console.error("device_done_fixture_start_failed");
  process.exit(1);
}
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  void close().then(() => process.exit(0), () => process.exit(1));
});
