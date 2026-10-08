import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createCollectorRuntime } from "../services/collector/src/cli.ts";
import { createRelayServer } from "../services/relay/src/server.ts";
import { JsonLogger } from "../services/relay/src/logger.ts";
import { UsageWatcher } from "../services/collector/src/usage-watcher.ts";
import { validateSnapshot, validateUsageAggregate } from "../packages/protocol/src/index.ts";

const home = os.homedir();
const sourceDatabase = path.join(home, ".claude-phone-monitor", "usage.sqlite");
const args = process.argv.slice(2);
let outputFile = "/private/tmp/issue28-live-snapshot.json";
let durationMs;
let relayPort;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--duration-ms") {
    const value = args[++i];
    if (!value || !/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
      throw new Error("--duration-ms requires a positive integer");
    }
    durationMs = Number(value);
  } else if (arg === "--relay-port") {
    const value = args[++i];
    if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65_535) {
      throw new Error("--relay-port requires a valid TCP port");
    }
    relayPort = Number(value);
  } else if (/^\d+$/.test(arg)) {
    if (durationMs !== undefined || Number(arg) <= 0 || !Number.isSafeInteger(Number(arg))) throw new Error("invalid duration");
    durationMs = Number(arg);
  } else if (arg.startsWith("--")) {
    throw new Error(`unknown option: ${arg}`);
  } else if (outputFile === "/private/tmp/issue28-live-snapshot.json") {
    outputFile = arg;
  } else {
    throw new Error("only one output path is supported");
  }
}
const scratch = await mkdtemp(path.join(tmpdir(), "issue28-live-readonly-"));
const copiedDatabase = path.join(scratch, "usage.sqlite");
let watcher;
let handle;
let relayServer;
let runtime;
const quotaSamples = new Set();
const installationId = "issue28-readonly-probe";

function sqlQuote(value) { return `'${value.replaceAll("'", "''")}'`; }

function usageFromSnapshot(snapshot) {
  const usage = snapshot?.usage ?? snapshot;
  const validation = relayPort ? validateSnapshot(snapshot) : validateUsageAggregate(usage);
  if (!validation.success || !usage || (relayPort && !snapshot.usage)) throw new Error("live usage snapshot failed protocol validation");
  return usage;
}

async function writeSnapshot(snapshot) {
  const usage = usageFromSnapshot(snapshot);
  const directory = path.dirname(outputFile);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(outputFile)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, outputFile);
  } finally {
    await rm(temporary, { force: true });
  }
  if (usage.quota.sampled_at) quotaSamples.add(usage.quota.sampled_at);
}

function summary(phase, snapshot) {
  const usage = usageFromSnapshot(snapshot);
  return {
    phase,
    observed_responses: usage.observed_responses,
    new_input: usage.new_input.value,
    actual: usage.actual.value,
    cache_numerator: usage.cache_hit.numerator,
    cache_denominator: usage.cache_hit.denominator,
    quota_samples: quotaSamples.size,
  };
}

async function waitForRelayDisconnect(relay, timeoutMs = 3_000) {
  const deadline = performance.now() + timeoutMs;
  while (relay.stats().active_connections > 0 && performance.now() < deadline) await delay(25);
}

async function waitForRelayUsage(relay, timeoutMs = 15_000) {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    const snapshot = relay.snapshot(installationId);
    if (snapshot.usage) return snapshot;
    await delay(100);
  }
  throw new Error("temporary relay did not receive the collector usage snapshot");
}

try {
  const db = new DatabaseSync(sourceDatabase, { readOnly: true });
  try {
    db.exec(`VACUUM INTO ${sqlQuote(copiedDatabase)}`);
  } finally {
    db.close();
  }

  // A copied pending message may carry the original installation ID. Clear
  // only that row in the temporary backup; the user's ledger stays untouched.
  const copiedDb = new DatabaseSync(copiedDatabase);
  try {
    const pending = copiedDb.prepare("SELECT value FROM usage_meta WHERE key='pending_message'").get();
    if (pending && typeof pending.value === "string") {
      try {
        const message = JSON.parse(pending.value);
        if (message?.installation_id !== installationId) {
          copiedDb.exec("BEGIN IMMEDIATE");
          copiedDb.prepare("DELETE FROM usage_meta WHERE key='pending_message'").run();
          copiedDb.prepare("UPDATE usage_meta SET value='1' WHERE key='dirty'").run();
          copiedDb.exec("COMMIT");
        }
      } catch {
        // Preserve unrecognized temporary metadata rather than guessing its scope.
      }
    }
  } finally {
    copiedDb.close();
  }

  if (relayPort !== undefined) {
    if (process.env.RELAY_BOOTSTRAP_SECRET || process.env.RELAY_AUTH_MODE === "paired") {
      throw new Error("temporary relay requires an isolated development-auth environment");
    }
    const relayDb = path.join(scratch, "relay.sqlite");
    relayServer = createRelayServer({
      config: { host: "127.0.0.1", port: relayPort, authMode: "development", databasePath: relayDb },
      logger: new JsonLogger({ sink: () => undefined }),
    });
    await relayServer.app.listen({ host: "127.0.0.1", port: relayPort });
    const collectorDir = path.join(scratch, "c");
    await mkdir(collectorDir, { recursive: true, mode: 0o700 });
    runtime = await createCollectorRuntime({
      dataDir: collectorDir,
      socketPath: path.join(collectorDir, "c.sock"),
      relayUrl: `ws://127.0.0.1:${relayPort}/ws/collector`,
      installationId,
      watchUsage: true,
      watchCodex: false,
      approvalBridge: false,
      codexBinary: "codex",
      claudeProjectsRoot: path.join(home, ".claude", "projects"),
      sessionsRoot: path.join(home, ".codex", "sessions"),
      usageDatabaseFile: copiedDatabase,
    });
    if (!runtime.usageWatcher) throw new Error("temporary collector could not start usage watcher");
  } else {
    watcher = new UsageWatcher({
      claudeProjectsRoot: path.join(home, ".claude", "projects"),
      codexSessionsRoot: path.join(home, ".codex", "sessions"),
      databaseFile: copiedDatabase,
      installationId,
      sequence: { next: async () => 1 },
      outbox: { enqueue: async () => { throw new Error("probe must not enqueue"); } },
      codexBinary: "codex",
      pollIntervalMs: 60_000,
    });
    handle = await watcher.start();
  }

  let snapshot = relayPort !== undefined
    ? await waitForRelayUsage(relayServer.relay)
    : handle.getSnapshot();
  await writeSnapshot(snapshot);
  process.stdout.write(`${JSON.stringify({ relay_link: relayPort !== undefined, ...summary("start", snapshot) })}\n`);

  if (durationMs !== undefined) {
    const started = performance.now();
    let nextPoll = started + 5_000;
    while (performance.now() - started < durationMs) {
      const elapsed = performance.now() - started;
      await delay(Math.max(0, Math.min(5_000, nextPoll - performance.now(), durationMs - elapsed)));
      if (performance.now() - started >= durationMs) break;
      if (relayPort === undefined) await watcher.pollOnce();
      snapshot = relayPort !== undefined
        ? relayServer.relay.snapshot(installationId)
        : handle.getSnapshot();
      await writeSnapshot(snapshot);
      nextPoll = performance.now() + 5_000;
    }
    if (relayPort === undefined) await watcher.pollOnce();
    snapshot = relayPort !== undefined
      ? relayServer.relay.snapshot(installationId)
      : handle.getSnapshot();
    await writeSnapshot(snapshot);
    process.stdout.write(`${JSON.stringify({ relay_link: relayPort !== undefined, ...summary("end", snapshot) })}\n`);
  }
} finally {
  try {
    await runtime?.stop();
    await handle?.stop();
    if (!handle) await watcher?.stop().catch(() => undefined);
  } finally {
    try {
      if (relayServer) {
        // runtime.stop() closes its RelayClient; let the server process the
        // WebSocket close before stopping Relay or closing its SQLite store.
        await waitForRelayDisconnect(relayServer.relay);
        const connectionsRemain = relayServer.relay.stats().active_connections > 0;
        if (!connectionsRemain) relayServer.relay.stop();
        await relayServer.app.close();
        if (connectionsRemain) {
          await waitForRelayDisconnect(relayServer.relay);
          relayServer.relay.stop();
        }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
