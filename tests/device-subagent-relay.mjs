// Isolated real-device fixture: production Collector, Codex watcher and SQLite Relay.
// Synthetic rollout metadata never enters the user's monitor or Codex directories.
// Run after building the services: node tests/device-subagent-relay.mjs
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCollectorRuntime } from "../services/collector/dist/cli.js";
import { createRelayServer } from "../services/relay/dist/src/server.js";
import { Relay } from "../services/relay/dist/src/relay.js";
import { loadConfig } from "../services/relay/dist/src/config.js";
import { JsonLogger } from "../services/relay/dist/src/logger.js";

const port = Number(process.env.DEVICE_TEST_PORT ?? 18879);
const installationId = "issue19-device-fixture";
const root = await mkdtemp(join(tmpdir(), "issue19-device-"));
const sessionsRoot = join(root, "sessions");
const dataDir = join(root, "collector");
await mkdir(sessionsRoot);
const mains = [randomUUID(), randomUUID()];
const children = [randomUUID(), randomUUID(), randomUUID()];
const turns = new Map();
const hash = (value) => createHash("sha256").update(value.toLowerCase()).digest("hex");
const sessionId = (id) => `codex:sess:${hash(id)}`;
const row = (type, payload, ordinal) => JSON.stringify({ type, payload, ordinal, timestamp: new Date().toISOString() }) + "\n";
await writeFile(join(root, "session_index.jsonl"), mains.map((id, index) =>
  JSON.stringify({ id, thread_name: index === 0 ? "Main Alpha" : "Main Beta" })).join("\n") + "\n");
const config = loadConfig({}, {
  host: "127.0.0.1", port, authMode: "development", databasePath: join(root, "relay.sqlite"),
  staleAfterMs: 120_000, offlineAfterMs: 240_000, bookkeepingIntervalMs: 1000,
});
const logger = new JsonLogger({ sink: () => undefined });
const relay = new Relay({ config, logger });
const { app } = createRelayServer({ relay, logger });
let runtime;
let busy = false;
const completedOperations = new Set();

async function waitFor(predicate) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("device_fixture_timeout");
}
async function startThread(id, child) {
  const turn = randomUUID();
  turns.set(id, turn);
  await writeFile(join(sessionsRoot, `rollout-${id}.jsonl`),
    row("session_meta", { id, session_id: mains[0], ...(child
      ? { source: { subagent: id === children[2] ? { other: "guardian_review" }
        : { thread_spawn: { parent_thread_id: mains[0] } } } }
      : { source: "cli" }) }, 0) + row("event_msg", { type: "task_started", turn_id: turn }, 1));
}
async function finishThread(id, failed = false) {
  await appendFile(join(sessionsRoot, `rollout-${id}.jsonl`), row("event_msg", {
    type: "task_complete", turn_id: turns.get(id),
    error: failed ? { codex_error_info: "server_overloaded" } : null,
  }, 2));
  await waitFor(() => relay.repository.listEventsAfter(installationId, -1).some(({ event }) =>
    event.session_id === sessionId(id) && event.event_type === (failed ? "task_failed" : "task_finished")));
}
app.post("/device-test/control", async (request, reply) => {
  const operation = request.body?.operation;
  if (busy) return reply.code(409).send({ error: "fixture_busy" });
  if (completedOperations.has(operation)) return relay.snapshot(installationId);
  busy = true;
  try {
    switch (operation) {
      case "start":
        for (const id of mains) await startThread(id, false);
        for (const id of children) await startThread(id, true);
        await waitFor(() => relay.snapshot(installationId).total_running_count === 5);
        break;
      case "child_finish": await finishThread(children[0]); break;
      case "main_finish": await finishThread(mains[0]); break;
      case "child_fail": await finishThread(children[1], true); break;
      case "child_wait":
        // Codex rollout currently exposes no verified wait event. Exercise the real
        // wire boundary with an explicitly synthetic allowlisted waiting event.
        await runtime.collector.ingestNormalized({ event_type: "waiting", session_id: sessionId(children[2]),
          session_kind: "subagent", occurred_at: new Date().toISOString(), payload: {} });
        await runtime.relay.flushPending();
        await waitFor(() => relay.snapshot(installationId).total_running_count === 1);
        break;
      case "last_main_finish": await finishThread(mains[1]); break;
      case "children_only":
        for (let index = 0; index < 8; index++) await startThread(randomUUID(), true);
        await waitFor(() => relay.snapshot(installationId).total_running_count === 8);
        break;
      default: return reply.code(400).send({ error: "unknown_fixture_operation" });
    }
    completedOperations.add(operation);
    return relay.snapshot(installationId);
  } finally { busy = false; }
});
await app.listen({ host: config.host, port });
runtime = await createCollectorRuntime({ dataDir, socketPath: join(root, "collector.sock"),
  installationId, relayUrl: `ws://127.0.0.1:${port}/ws/collector`, watchCodex: true,
  watchUsage: false, sessionsRoot, codexMetadataRoot: root });
await waitFor(() => relay.stats().collector_connections === 1);
console.log(JSON.stringify({ status: "ready", port, installation_id: installationId, source: "synthetic_rollouts" }));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await runtime.stop();
  await waitFor(() => relay.stats().active_connections === 0).catch(() => undefined);
  await app.close();
  await rm(root, { recursive: true, force: true });
}
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  void close().then(() => process.exit(0), () => process.exit(1));
});
