#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env, stdin } from "node:process";
import { Collector } from "./collector.js";
import { isSafeIdentifier } from "./normalize.js";
import { InstallationIdentity, LocalSequence } from "./sequence.js";
import { FileOutbox, outboxFilePath } from "./outbox.js";
import { RelayClient } from "./relay.js";
import { UnixSocketIngestor } from "./socket.js";
import { runHookAdapter } from "./hook-adapter.js";
import type { EventEnvelope } from "./types.js";

const DEFAULT_DATA_DIR = join(homedir(), ".claude-phone-monitor");
const DEFAULT_SOCKET_PATH = join(DEFAULT_DATA_DIR, "collector.sock");

interface ParsedArgs {
  mode?: "event" | "collector";
  socketPath?: string;
  help?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--event") parsed.mode = "event";
    else if (arg === "--collector" || arg === "--daemon") parsed.mode = "collector";
    else if (arg === "--socket" || arg === "--socket-path") parsed.socketPath = argv[++index];
    else if (arg === "--help" || arg === "-h") parsed.help = true;
  }
  return parsed;
}

export interface CollectorRuntime {
  collector: Collector;
  outbox: FileOutbox<EventEnvelope>;
  socket: UnixSocketIngestor;
  relay?: RelayClient;
  stop(): Promise<void>;
}

export interface CollectorRuntimeOptions {
  dataDir?: string;
  socketPath?: string;
  relayUrl?: string;
  relaySecret?: string;
  relayToken?: string;
  installationId?: string;
}

function validInstallationId(value: string | undefined): string | undefined {
  return isSafeIdentifier(value) ? value : undefined;
}

export async function createCollectorRuntime(
  options: CollectorRuntimeOptions = {},
): Promise<CollectorRuntime> {
  const dataDir = options.dataDir ?? env.COLLECTOR_DATA_DIR ?? DEFAULT_DATA_DIR;
  const socketPath = options.socketPath ?? env.COLLECTOR_SOCKET_PATH ?? join(dataDir, "collector.sock");
  const sequence = new LocalSequence(join(dataDir, "sequence.txt"));
  const identity = new InstallationIdentity(join(dataDir, "installation_id"));
  const installationId =
    validInstallationId(options.installationId ?? env.COLLECTOR_INSTALLATION_ID) ?? (await identity.get());
  const outbox = new FileOutbox<EventEnvelope>(outboxFilePath(dataDir));
  const collector = new Collector({ installationId, sequence, outbox });

  const relayUrl = options.relayUrl ?? env.COLLECTOR_RELAY_URL;
  const relay = relayUrl
    ? new RelayClient({
        url: relayUrl,
        installationId,
        outbox,
        challengeSecret: options.relaySecret ?? env.COLLECTOR_RELAY_SECRET,
        token: options.relayToken ?? env.COLLECTOR_RELAY_TOKEN,
      })
    : undefined;
  relay?.start();

  const socket = new UnixSocketIngestor({
    socketPath,
    onMessage: async (message) => {
      // Re-normalize at the daemon boundary. The socket is local, but another
      // local process must not be able to smuggle prompt/tool output into the
      // durable queue by pretending to be the hook adapter.
      await collector.ingestHook(message);
      await relay?.flushPending();
    },
  });
  await socket.start();

  return {
    collector,
    outbox,
    socket,
    relay,
    async stop() {
      relay?.stop();
      await socket.stop();
      await outbox.close();
    },
  };
}

export async function runCollector(options: CollectorRuntimeOptions = {}): Promise<void> {
  const runtime = await createCollectorRuntime(options);
  let stopping = false;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolvePromise) => {
    resolveStopped = resolvePromise;
  });
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.stop();
    resolveStopped?.();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  await stopped;
}

export function helpText(): string {
  return [
    "claude-phone-monitor-collector",
    "  --event       Read one Claude hook JSON event from stdin and send it to the local Unix socket.",
    "  --collector   Run the local socket collector and optional WebSocket relay daemon.",
    "  --socket PATH Override COLLECTOR_SOCKET_PATH for --event mode.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (args.mode === "event") {
    // runHookAdapter is fail-open by contract and never calls the relay.
    await runHookAdapter({
      socketPath: args.socketPath ?? env.COLLECTOR_SOCKET_PATH ?? DEFAULT_SOCKET_PATH,
      input: stdin as unknown as AsyncIterable<Uint8Array | string>,
    });
    return 0;
  }
  if (args.mode === "collector") {
    await runCollector();
    return 0;
  }
  process.stdout.write(`${helpText()}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      // CLI failures are deliberately fail-open as well; telemetry must never
      // change the exit status of a user's command.
      process.exitCode = 0;
    },
  );
}
