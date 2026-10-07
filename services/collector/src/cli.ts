#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env, stderr, stdin } from "node:process";
import { Collector } from "./collector.js";
import { isSafeIdentifier } from "./normalize.js";
import { InstallationIdentity, LocalSequence } from "./sequence.js";
import { FileOutbox, outboxFilePath } from "./outbox.js";
import { RelayClient } from "./relay.js";
import { UnixSocketIngestor } from "./socket.js";
import { runHookAdapter } from "./hook-adapter.js";
import { ApprovalBridge } from "./approval.js";
import { CodexApprovalObserver } from "./codex-approvals.js";
import {
  CodexWatcherStartError,
  startCodexWatcher,
  type CodexWatcherHandle,
} from "./codex-watcher.js";
import type { EventEnvelope, RelayOutboundMessage } from "./types.js";
import { startUsageWatcher, UsageWatcherStartError, type UsageWatcherHandle } from "./usage-watcher.js";

const DEFAULT_DATA_DIR = join(homedir(), ".claude-phone-monitor");
const DEFAULT_SOCKET_PATH = join(DEFAULT_DATA_DIR, "collector.sock");

interface ParsedArgs {
  mode?: "event" | "collector";
  socketPath?: string;
  watchCodex?: boolean;
  watchUsage?: boolean;
  codexMetadataRoot?: string;
  codexIpcSocket?: string;
  help?: boolean;
  approvalBridge?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--event") parsed.mode = "event";
    else if (arg === "--collector" || arg === "--daemon") parsed.mode = "collector";
    else if (arg === "--socket" || arg === "--socket-path") parsed.socketPath = argv[++index];
    else if (arg === "--codex-metadata-root") parsed.codexMetadataRoot = argv[++index];
    else if (arg === "--codex-ipc-socket") parsed.codexIpcSocket = argv[++index];
    else if (arg === "--watch-codex") parsed.watchCodex = true;
    else if (arg === "--no-watch-codex") parsed.watchCodex = false;
    else if (arg === "--watch-usage") parsed.watchUsage = true;
    else if (arg === "--no-watch-usage") parsed.watchUsage = false;
    else if (arg === "--approval-bridge") parsed.approvalBridge = true;
    else if (arg === "--no-approval-bridge") parsed.approvalBridge = false;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
  }
  return parsed;
}

export interface CollectorRuntime {
  collector: Collector;
  outbox: FileOutbox<RelayOutboundMessage>;
  socket: UnixSocketIngestor;
  relay?: RelayClient;
  codexWatcher?: CodexWatcherHandle;
  codexApprovals?: CodexApprovalObserver;
  usageWatcher?: UsageWatcherHandle;
  approvalBridge: ApprovalBridge;
  stop(): Promise<void>;
}

export interface CollectorRuntimeOptions {
  dataDir?: string;
  socketPath?: string;
  relayUrl?: string;
  relaySecret?: string;
  relayToken?: string;
  installationId?: string;
  watchCodex?: boolean;
  sessionsRoot?: string;
  codexMetadataRoot?: string;
  codexIpcSocket?: string;
  checkpointFile?: string;
  watchUsage?: boolean;
  claudeProjectsRoot?: string;
  usageDatabaseFile?: string;
  approvalBridge?: boolean;
  approvalHoldMs?: number;
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
  const outbox = new FileOutbox<RelayOutboundMessage>(outboxFilePath(dataDir));
  const collector = new Collector({ installationId, sequence, outbox });
  let bridge: ApprovalBridge;
  let codexApprovals: CodexApprovalObserver | undefined;

  const relayUrl = options.relayUrl ?? env.COLLECTOR_RELAY_URL;
  const relay = relayUrl
    ? new RelayClient({
        url: relayUrl,
        installationId,
        outbox,
        challengeSecret: options.relaySecret ?? env.COLLECTOR_RELAY_SECRET,
        token: options.relayToken ?? env.COLLECTOR_RELAY_TOKEN,
        onApprovalDecision: (message) => bridge.decide(message),
        onApprovalReady: () => { bridge.publishPresence(); codexApprovals?.onRelayReady(); },
        onApprovalDisconnected: () => { codexApprovals?.onRelayDisconnected(); return bridge.expireAll(); },
        onEventAck: (message) => { bridge.handleEventAck(message); codexApprovals?.handleEventAck(message); },
      })
    : undefined;
  bridge = new ApprovalBridge({
    enabled: options.approvalBridge ?? env.COLLECTOR_APPROVAL_BRIDGE === "1",
    installationId,
    holdMs: options.approvalHoldMs,
    emit: (event) => collector.ingestNormalized(event),
    flush: async () => { await relay?.flushPending(); },
    isConnected: () => relay?.approvalAvailable() ?? false,
    publishPresence: (requestIds) => relay?.publishApprovalPresence(requestIds),
  });
  relay?.start();

  const socket = new UnixSocketIngestor({
    socketPath,
    onMessage: async (message, localSocket) => {
      if (await bridge.handleLocalMessage(message, localSocket)) return;
      // Re-normalize at the daemon boundary. The socket is local, but another
      // local process must not be able to smuggle prompt/tool output into the
      // durable queue by pretending to be the hook adapter.
      await collector.ingestHook(message);
      await relay?.flushPending();
    },
  });
  await socket.start();

  let codexWatcher: CodexWatcherHandle | undefined;
  const watchCodex = options.watchCodex ?? env.COLLECTOR_WATCH_CODEX === "1";
  const sessionsRoot = options.sessionsRoot ?? env.COLLECTOR_CODEX_SESSIONS_DIR ??
    join(env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  if (watchCodex) {
    try {
      codexWatcher = await startCodexWatcher({
        sessionsRoot,
        codexMetadataRoot: options.codexMetadataRoot ?? env.COLLECTOR_CODEX_METADATA_DIR,
        checkpointFile:
          options.checkpointFile ?? join(dataDir, "codex-checkpoint.json"),
        emit: async (event) => {
          await collector.ingestNormalized(event);
          // A ready relay socket needs an explicit flush after enqueue. Keep
          // network/send failures outside the watcher's durable retry boundary:
          // the outbox owns retry and the source row is already committed.
          try { await relay?.flushPending(); } catch { /* Durable outbox will retry on reconnect. */ }
        },
      });
    } catch (error) {
      // Codex monitoring is optional and must never prevent Claude monitoring.
      codexWatcher = undefined;
      const code = error instanceof CodexWatcherStartError ? error.code : "codex_watch_start_failed";
      stderr.write(`${code}\n`);
    }
  }

  if (watchCodex && codexWatcher) {
    codexApprovals = new CodexApprovalObserver({
      socketPath: options.codexIpcSocket ?? env.COLLECTOR_CODEX_IPC_SOCKET ?? join(options.codexMetadataRoot ?? env.COLLECTOR_CODEX_METADATA_DIR ?? dirname(sessionsRoot), "ipc", "ipc.sock"),
      getThreadIds: () => codexWatcher!.getApprovalThreadIds(),
      emit: (event) => collector.ingestNormalized(event),
      flush: async () => { await relay?.flushPending(); },
      isRelayConnected: () => relay?.approvalAvailable() ?? false,
      publishPresence: (requestIds) => relay?.publishApprovalPresence(requestIds, "codex"),
    });
    codexApprovals.start();
  }

  let usageWatcher: UsageWatcherHandle | undefined;
  const watchUsage = options.watchUsage ?? env.COLLECTOR_WATCH_USAGE === "1";
  if (watchUsage) {
    try {
      usageWatcher = await startUsageWatcher({
        claudeProjectsRoot: options.claudeProjectsRoot ?? env.COLLECTOR_CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects"),
        codexSessionsRoot: options.sessionsRoot ?? env.COLLECTOR_CODEX_SESSIONS_DIR ?? (env.CODEX_HOME ? join(env.CODEX_HOME, "sessions") : join(homedir(), ".codex", "sessions")),
        databaseFile: options.usageDatabaseFile ?? join(dataDir, "usage.sqlite"),
        installationId,
        sequence,
        outbox,
        emit: async (message) => {
          await outbox.enqueue({ id: message.event_id, sequence: message.sequence, payload: message, created_at: message.occurred_at });
          try { await relay?.flushPending(); } catch { /* The outbox retries network failures on reconnect. */ }
        },
      });
    } catch (error) {
      usageWatcher = undefined;
      const code = error instanceof UsageWatcherStartError ? error.code : "usage_watch_start_failed";
      stderr.write(`${code}\n`);
    }
  }

  return {
    collector,
    outbox,
    socket,
    relay,
    codexWatcher,
    codexApprovals,
    usageWatcher,
    approvalBridge: bridge,
    async stop() {
      await codexApprovals?.stop();
      await codexWatcher?.stop();
      await usageWatcher?.stop();
      await bridge.stop();
      relay?.stop();
      await socket.stop();
      await relay?.drain();
      await outbox.close();
    },
  };
}

export async function runCollector(options: CollectorRuntimeOptions = {}): Promise<void> {
  const runtime = await createCollectorRuntime(options);
  let diagnosticSignature = "";
  const diagnosticsTimer = runtime.codexWatcher || runtime.usageWatcher
    ? setInterval(() => {
        const codexDiagnostics = runtime.codexWatcher?.getDiagnostics();
        const usageDiagnostics = runtime.usageWatcher?.getDiagnostics();
        const summary = {
          codes: [
            ...(codexDiagnostics?.codes.filter((code) => /^codex_[a-z_]+$/.test(code)) ?? []),
            ...(usageDiagnostics?.codes ?? []),
            ...(runtime.codexApprovals?.getDiagnostics().codes ?? []),
          ],
        };
        const signature = JSON.stringify(summary);
        if (signature === diagnosticSignature || summary.codes.length === 0) return;
        diagnosticSignature = signature;
        stderr.write(`codex_watch_diagnostics ${signature}\n`);
      }, 30_000)
    : undefined;
  diagnosticsTimer?.unref();
  let stopping = false;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolvePromise) => {
    resolveStopped = resolvePromise;
  });
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (diagnosticsTimer) clearInterval(diagnosticsTimer);
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
    "  --watch-codex Watch Codex JSONL lifecycle and existing desktop IPC pending approvals (read-only; no Codex config or hooks are changed).",
    "  --codex-ipc-socket PATH Override the existing desktop IPC socket (COLLECTOR_CODEX_IPC_SOCKET).",
    "  --codex-metadata-root PATH Read native Codex titles from this root (default: parent of the configured sessions directory; COLLECTOR_CODEX_METADATA_DIR).",
    "  --no-watch-codex Disable Codex watching even when COLLECTOR_WATCH_CODEX=1.",
    "  --watch-usage  Read local Claude/Codex usage transcripts (read-only; opt-in).",
    "  --no-watch-usage Disable Usage watching even when COLLECTOR_WATCH_USAGE=1.",
    "  --socket PATH Override COLLECTOR_SOCKET_PATH for hook and collector modes.",
    "  --approval-bridge Opt in to paired-phone PermissionRequest decisions (10 minute local hold).",
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
      approvalBridge: args.approvalBridge === true,
    });
    return 0;
  }
  if (args.mode === "collector") {
    await runCollector({ socketPath: args.socketPath, watchCodex: args.watchCodex, watchUsage: args.watchUsage, codexMetadataRoot: args.codexMetadataRoot, codexIpcSocket: args.codexIpcSocket, approvalBridge: args.approvalBridge });
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
