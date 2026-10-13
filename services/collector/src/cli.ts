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
import { startAgentSessionWatcher, type AgentSessionWatcherHandle } from "./agent-session-watcher.js";
import { startMagpieSessionsWatcher, type MagpieSessionsWatcherHandle } from "./magpie-sessions.js";

const DEFAULT_DATA_DIR = join(homedir(), ".claude-phone-monitor");
const DEFAULT_SOCKET_PATH = join(DEFAULT_DATA_DIR, "collector.sock");

interface ParsedArgs {
  mode?: "event" | "collector";
  socketPath?: string;
  watchCodex?: boolean;
  watchUsage?: boolean;
  watchAgentSessions?: boolean;
  watchMagpieSessions?: boolean;
  magpieBin?: string;
  magpieSessionLimit?: number;
  magpiePollIntervalMs?: number;
  magpieCommandTimeoutMs?: number;
  magpieCheckpointFile?: string;
  agentSessionsRoot?: string;
  agentId?: string;
  agentCheckpointFile?: string;
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
    else if (arg === "--watch-agent-sessions") parsed.watchAgentSessions = true;
    else if (arg === "--no-watch-agent-sessions") parsed.watchAgentSessions = false;
    else if (arg === "--watch-magpie-sessions") parsed.watchMagpieSessions = true;
    else if (arg === "--no-watch-magpie-sessions") parsed.watchMagpieSessions = false;
    else if (arg === "--magpie-bin") parsed.magpieBin = argv[++index];
    else if (arg === "--magpie-session-limit") parsed.magpieSessionLimit = Number(argv[++index]);
    else if (arg === "--magpie-poll-interval-ms") parsed.magpiePollIntervalMs = Number(argv[++index]);
    else if (arg === "--magpie-command-timeout-ms") parsed.magpieCommandTimeoutMs = Number(argv[++index]);
    else if (arg === "--magpie-checkpoint-file") parsed.magpieCheckpointFile = argv[++index];
    else if (arg === "--agent-sessions-root") parsed.agentSessionsRoot = argv[++index];
    else if (arg === "--agent-id") parsed.agentId = argv[++index];
    else if (arg === "--agent-checkpoint-file") parsed.agentCheckpointFile = argv[++index];
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
  agentSessionWatcher?: AgentSessionWatcherHandle;
  magpieWatcher?: MagpieSessionsWatcherHandle;
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
  watchAgentSessions?: boolean;
  watchMagpieSessions?: boolean;
  magpieBin?: string;
  magpieSessionLimit?: number;
  magpiePollIntervalMs?: number;
  magpieCommandTimeoutMs?: number;
  magpieCheckpointFile?: string;
  agentSessionsRoot?: string;
  agentId?: string;
  agentCheckpointFile?: string;
  claudeProjectsRoot?: string;
  usageDatabaseFile?: string;
  codexBinary?: string;
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
        codexBinary: options.codexBinary ?? env.COLLECTOR_CODEX_BIN ?? "codex",
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

  let agentSessionWatcher: AgentSessionWatcherHandle | undefined;
  const watchAgentSessions = options.watchAgentSessions ?? env.COLLECTOR_WATCH_AGENT_SESSIONS === "1";
  if (watchAgentSessions) {
    const agentSessionsRoot = options.agentSessionsRoot ?? env.COLLECTOR_AGENT_SESSIONS_DIR;
    const agentId = options.agentId ?? env.COLLECTOR_AGENT_ID ?? "agent";
    if (agentSessionsRoot) {
      try {
        agentSessionWatcher = await startAgentSessionWatcher({
          sessionsRoot: agentSessionsRoot,
          agentId,
          checkpointFile: options.agentCheckpointFile ?? env.COLLECTOR_AGENT_CHECKPOINT_FILE ?? join(dataDir, "agent-session-checkpoint.json"),
          emit: async (event) => { await collector.ingestNormalized(event); try { await relay?.flushPending(); } catch { /* Outbox retries on reconnect. */ } },
        });
      } catch { stderr.write("agent_session_watch_start_failed\n"); }
    } else stderr.write("agent_session_watch_root_missing\n");
  }

  let magpieWatcher: MagpieSessionsWatcherHandle | undefined;
  const watchMagpieSessions = options.watchMagpieSessions ?? env.COLLECTOR_WATCH_MAGPIE_SESSIONS === "1";
  if (watchMagpieSessions) {
    try {
      const sessionLimit = options.magpieSessionLimit ?? Number(env.COLLECTOR_MAGPIE_SESSION_LIMIT ?? "100");
      const pollIntervalMs = options.magpiePollIntervalMs ?? Number(env.COLLECTOR_MAGPIE_POLL_INTERVAL_MS ?? "2000");
      const commandTimeoutMs = options.magpieCommandTimeoutMs ?? Number(env.COLLECTOR_MAGPIE_COMMAND_TIMEOUT_MS ?? "10000");
      magpieWatcher = await startMagpieSessionsWatcher({
        commandName: options.magpieBin ?? env.COLLECTOR_MAGPIE_BIN ?? "magpie",
        sessionLimit,
        pollIntervalMs,
        commandTimeoutMs,
        checkpointFile: options.magpieCheckpointFile ?? env.COLLECTOR_MAGPIE_CHECKPOINT_FILE ?? join(dataDir, "magpie-session-checkpoint.json"),
        codexMetadataRoot: options.codexMetadataRoot ?? env.COLLECTOR_CODEX_METADATA_DIR ?? dirname(sessionsRoot),
        excludedAgentIds: ["claude_code"],
        emit: async (event) => { await collector.ingestNormalized(event); try { await relay?.flushPending(); } catch { /* Durable outbox retries on reconnect. */ } },
      });
    } catch { stderr.write("magpie_sessions_watch_start_failed\n"); }
  }

  return {
    collector,
    outbox,
    socket,
    relay,
    codexWatcher,
    codexApprovals,
    usageWatcher,
    agentSessionWatcher,
    magpieWatcher,
    approvalBridge: bridge,
    async stop() {
      await codexApprovals?.stop();
      await codexWatcher?.stop();
      await usageWatcher?.stop();
      await agentSessionWatcher?.stop();
      await magpieWatcher?.stop();
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
  const diagnosticsTimer = runtime.codexWatcher || runtime.usageWatcher || runtime.agentSessionWatcher || runtime.magpieWatcher
    ? setInterval(() => {
        const codexDiagnostics = runtime.codexWatcher?.getDiagnostics();
        const usageDiagnostics = runtime.usageWatcher?.getDiagnostics();
        const agentDiagnostics = runtime.agentSessionWatcher?.getDiagnostics();
        const magpieDiagnostics = runtime.magpieWatcher?.getDiagnostics();
        const summary = {
          codes: [
            ...(codexDiagnostics?.codes.filter((code) => /^codex_[a-z_]+$/.test(code)) ?? []),
            ...(usageDiagnostics?.codes ?? []),
            ...(agentDiagnostics?.codes ?? []),
            ...(magpieDiagnostics?.codes ?? []),
            ...(runtime.codexApprovals?.getDiagnostics().codes ?? []),
          ],
        };
        const signature = JSON.stringify(summary);
        if (signature === diagnosticSignature || summary.codes.length === 0) return;
        diagnosticSignature = signature;
        stderr.write(`collector_watch_diagnostics ${signature}\n`);
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
    "  --watch-agent-sessions Watch an explicitly configured generic Agent JSONL session root (read-only; opt-in).",
    "  --agent-sessions-root PATH Override COLLECTOR_AGENT_SESSIONS_DIR.",
    "  --agent-id ID Namespace hashed session identifiers (COLLECTOR_AGENT_ID).",
    "  --agent-checkpoint-file PATH Override the agent session checkpoint file.",
    "  --watch-magpie-sessions Poll Magpie for history metadata (read-only; opt-in).",
    "  --magpie-bin PATH Override the Magpie executable (COLLECTOR_MAGPIE_BIN).",
    "  --magpie-session-limit N Limit sessions returned per poll (COLLECTOR_MAGPIE_SESSION_LIMIT).",
    "  --magpie-poll-interval-ms N Poll interval, 250..300000 ms (COLLECTOR_MAGPIE_POLL_INTERVAL_MS).",
    "  --magpie-command-timeout-ms N Command timeout, 100..60000 ms (COLLECTOR_MAGPIE_COMMAND_TIMEOUT_MS).",
    "  --magpie-checkpoint-file PATH Override COLLECTOR_MAGPIE_CHECKPOINT_FILE.",
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
    await runCollector({ socketPath: args.socketPath, watchCodex: args.watchCodex, watchUsage: args.watchUsage, watchAgentSessions: args.watchAgentSessions, watchMagpieSessions: args.watchMagpieSessions, magpieBin: args.magpieBin, magpieSessionLimit: args.magpieSessionLimit, magpiePollIntervalMs: args.magpiePollIntervalMs, magpieCommandTimeoutMs: args.magpieCommandTimeoutMs, magpieCheckpointFile: args.magpieCheckpointFile, agentSessionsRoot: args.agentSessionsRoot, agentId: args.agentId, agentCheckpointFile: args.agentCheckpointFile, codexMetadataRoot: args.codexMetadataRoot, codexIpcSocket: args.codexIpcSocket, approvalBridge: args.approvalBridge });
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
