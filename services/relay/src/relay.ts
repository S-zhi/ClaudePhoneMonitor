import { randomUUID } from "node:crypto";

import { loadConfig, type RelayConfig } from "./config.js";
import { JsonLogger } from "./logger.js";
import {
  createOpaqueToken,
  createRelayRepository,
  hashOpaqueToken,
  type RelayRepository,
} from "./repository.js";
import {
  RELAY_SCHEMA_VERSION,
  type ChallengeAckMessage,
  type ChallengeMessage,
  type ConnectionRecord,
  type EventAckMessage,
  type EventEnvelope,
  type ErrorMessage,
  type Gateway,
  type HeartbeatMessage,
  type ProbeMessage,
  type ServerMessage,
  type SnapshotMessage,
  type UsageAggregate,
  type UsageSnapshotMessage,
  type SubscribeMessage,
  type TokenValidation,
} from "./types.js";
import { isEventType, isGateway } from "./types.js";

export interface RelayTransport {
  send(message: ServerMessage): void;
}

export interface ConnectOptions {
  gateway: Gateway;
  transport: RelayTransport;
  client_id?: string;
  installation_id?: string;
  pairing_id?: string;
  pairing_code?: string;
  token?: string;
  android_token?: string;
}

interface ActiveConnection {
  id: string;
  gateway: Gateway;
  transport: RelayTransport;
  subscriptions: Set<string> | null;
  lastHeartbeatSentMs: number;
  authenticated: boolean;
  token_id?: string;
  token_installation_id?: string;
}

interface PendingChallenge {
  sourceConnectionId: string;
  createdAtMs: number;
}

interface PendingProbe {
  sourceConnectionId: string;
  sourceInstallationId?: string;
  probeId: string;
  nonce: string;
  createdAtMs: number;
  timer: NodeJS.Timeout;
}

export interface PairingCreateRequest {
  installation_id: string;
  relay_url?: string;
  public_url?: string;
  collector_token?: string;
}

export class InvalidCollectorTokenError extends Error {
  constructor() {
    super("invalid collector token");
    this.name = "InvalidCollectorTokenError";
  }
}

export interface PairingCreated {
  pairing_id: string;
  code: string;
  expires_at: string;
  qr_payload: string;
  collector_token: string;
  installation_id: string;
  ws_url: string;
  mode: "development" | "paired";
}

export interface PairingClaimed {
  installation_id: string;
  android_token: string;
  ws_url: string;
  expires_at: string;
}

export interface PairingStatus {
  pairing_id: string;
  expires_at: string;
  status: "pending" | "claimed" | "expired";
  installation_id: string;
  ws_url: string;
  mode: "development" | "paired";
}

export interface RelayOptions {
  config?: Partial<RelayConfig>;
  repository?: RelayRepository;
  logger?: JsonLogger;
  now?: () => Date;
  autoStart?: boolean;
}

export interface RelayStats {
  active_connections: number;
  collector_connections: number;
  android_connections: number;
  installations: number;
  stored_events: number;
}

const MAX_ID_LENGTH = 256;
const MAX_EVENT_TYPE_LENGTH = 64;
const MAX_PENDING_CHALLENGE_MS = 5 * 60_000;
const SENSITIVE_PAYLOAD_KEYS = new Set([
  "prompt",
  "toolinput",
  "toolresult",
  "stdout",
  "stderr",
  "result",
  "apikey",
  "authorization",
  "password",
  "secret",
  "token",
]);
const REDACTED_VALUE = "[REDACTED]";
const REDACTED_PATH = "<redacted-path>";

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_.-]/g, "");
}

function redactPayload(value: unknown, key?: string): unknown {
  if (key !== undefined && SENSITIVE_PAYLOAD_KEYS.has(normalizeKey(key))) {
    return REDACTED_VALUE;
  }
  if (typeof value === "string") {
    return value
      .replace(/\b(?:sk-ant|sk-proj|ghp|github_pat)_[A-Za-z0-9_-]+\b/gi, "<redacted-secret>")
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer <redacted-secret>")
      .replace(
        /(?:\/Users|\/home|\/private|\/tmp|\/var|\/opt|\/etc)\/[^\s"'`,;)}\]]+/g,
        REDACTED_PATH,
      )
      .replace(/\b[A-Za-z]:\\[^\s"'`,;)}\]]+/g, REDACTED_PATH);
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactPayload(item));
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactPayload(childValue, childKey),
    ]),
  );
}

function sanitizeEvent(event: EventEnvelope): EventEnvelope {
  return { ...event, payload: redactPayload(event.payload) };
}

function safeSessionTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value.trim().replace(/\s+/g, " ");
  if (!title || title.length > 64 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  if (
    /[\\/]/.test(title) ||
    /https?:\/\//i.test(title) ||
    /(?:api[_ -]?key|token|secret|password|authorization)\s*[:=]|\bbearer\s+[A-Za-z0-9._~+/-]{8,}|\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16})/i.test(
      title,
    )
  ) {
    return undefined;
  }
  return title;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, maxLength = MAX_ID_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return undefined;
  return trimmed;
}

function optionalString(value: unknown, maxLength = MAX_ID_LENGTH): string | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(value, maxLength);
}

function safeSequence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function messageType(value: unknown): string | undefined {
  return isRecord(value) && typeof value.type === "string" ? value.type : undefined;
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validUsageAggregate(value: unknown): value is UsageAggregate {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "epoch_id", "started_at", "revision", "observed_responses", "complete_responses",
    "provider_coverage", "new_input", "cached_input", "output", "actual", "total_input", "cache_hit", "quota",
  ])) return false;
  if (
    typeof value.epoch_id !== "string" || value.epoch_id.trim() === "" || value.epoch_id.length > 256 ||
    typeof value.started_at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.started_at) ||
      !Number.isFinite(Date.parse(value.started_at)) ||
    !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
    !isSafeCount(value.observed_responses) || !isSafeCount(value.complete_responses) || value.complete_responses > value.observed_responses ||
    !isRecord(value.provider_coverage) || !hasOnlyKeys(value.provider_coverage, ["claude", "codex"]) ||
    !isRecord(value.cache_hit) || !hasOnlyKeys(value.cache_hit, ["numerator", "denominator", "quality"]) ||
    !isRecord(value.quota) || !hasOnlyKeys(value.quota, ["start_remaining", "current_remaining", "unit", "reset_at", "availability"])
  ) return false;
  const validMetric = (metric: unknown): metric is UsageAggregate["new_input"] => {
    if (!isRecord(metric) || !hasOnlyKeys(metric, ["value", "quality"])) return false;
    if (!["complete", "partial", "unavailable"].includes(String(metric.quality))) return false;
    if (metric.quality === "unavailable") return metric.value === null;
    if (!isSafeCount(metric.value)) return false;
    return true;
  };
  const validCoverage = (coverage: unknown): coverage is UsageAggregate["provider_coverage"]["claude"] => {
    if (!isRecord(coverage) || !hasOnlyKeys(coverage, ["status", "observed_responses", "complete_responses"])) return false;
    return ["ready", "partial", "unavailable"].includes(String(coverage.status)) &&
      isSafeCount(coverage.observed_responses) && isSafeCount(coverage.complete_responses) &&
      coverage.complete_responses <= coverage.observed_responses;
  };
  const providerCoverage = value.provider_coverage;
  if (!validCoverage(providerCoverage.claude) || !validCoverage(providerCoverage.codex)) return false;
  const claude = providerCoverage.claude;
  const codex = providerCoverage.codex;
  const combinedObserved = claude.observed_responses + codex.observed_responses;
  const combinedComplete = claude.complete_responses + codex.complete_responses;
  if (
    !Number.isSafeInteger(combinedObserved) || !Number.isSafeInteger(combinedComplete) ||
    combinedObserved !== value.observed_responses || combinedComplete !== value.complete_responses
  ) return false;
  const metricKeys = ["new_input", "cached_input", "output", "actual", "total_input"] as const;
  if (!metricKeys.every((key) => validMetric(value[key]))) return false;
  const aggregate = value as unknown as UsageAggregate;
  const cacheHit = value.cache_hit;
  if (
    !["complete", "partial", "unavailable"].includes(String(cacheHit.quality)) ||
    !(cacheHit.numerator === null || isSafeCount(cacheHit.numerator)) ||
    !(cacheHit.denominator === null || isSafeCount(cacheHit.denominator)) ||
    (cacheHit.quality === "unavailable" && (cacheHit.numerator !== null || cacheHit.denominator !== null)) ||
    (cacheHit.quality === "partial" && cacheHit.numerator === null && cacheHit.denominator === null) ||
    (cacheHit.quality === "complete" && (!isSafeCount(cacheHit.numerator) || !isSafeCount(cacheHit.denominator) || cacheHit.denominator <= 0)) ||
    (cacheHit.numerator !== null && cacheHit.denominator !== null && cacheHit.numerator > cacheHit.denominator)
  ) return false;
  const quota = value.quota;
  if (
    quota.start_remaining !== null || quota.current_remaining !== null || quota.unit !== null ||
    quota.reset_at !== null || quota.availability !== "unavailable"
  ) return false;
  const metrics = metricKeys.map((key) => aggregate[key]);
  const providersComplete = claude.status === "ready" && codex.status === "ready" &&
    claude.complete_responses === claude.observed_responses && codex.complete_responses === codex.observed_responses;
  if (metrics.some((metric) => metric.quality === "complete") && !providersComplete) return false;
  const allMetricsComplete = metrics.every((metric) => metric.quality === "complete");
  if (allMetricsComplete) {
    const newInput = aggregate.new_input.value;
    const cached = aggregate.cached_input.value;
    const output = aggregate.output.value;
    const actual = aggregate.actual.value;
    const total = aggregate.total_input.value;
    if ([newInput, cached, output, actual, total].some((n) => n === null)) return false;
    const actualSum = (newInput as number) + (output as number);
    const totalSum = (newInput as number) + (cached as number);
    if (!Number.isSafeInteger(actualSum) || !Number.isSafeInteger(totalSum) || actual !== actualSum || total !== totalSum) return false;
  }
  if (cacheHit.quality === "complete") {
    if (cacheHit.denominator === null || cacheHit.denominator <= 0 ||
      cacheHit.numerator !== aggregate.cached_input.value || cacheHit.denominator !== aggregate.total_input.value ||
      aggregate.cached_input.quality !== "complete" || aggregate.total_input.quality !== "complete" ||
      !providersComplete) return false;
  }
  return true;
}

export class Relay {
  readonly config: RelayConfig;
  readonly repository: RelayRepository;

  private readonly logger: JsonLogger;
  private readonly now: () => Date;
  private readonly connections = new Map<string, ActiveConnection>();
  private readonly pendingChallenges = new Map<string, PendingChallenge>();
  private readonly pendingProbes = new Map<string, PendingProbe>();
  private readonly probeStaleInstallations = new Set<string>();
  private readonly sessionSnapshotFingerprints = new Map<string, string>();
  private timer?: NodeJS.Timeout;

  constructor(options: RelayOptions = {}) {
    this.config = loadConfig(undefined, options.config);
    this.repository =
      options.repository ??
      createRelayRepository(this.config.databasePath, {
        maxStoredEvents: this.config.maxStoredEvents,
      });
    this.logger = options.logger ?? new JsonLogger();
    this.now = options.now ?? (() => new Date());
    if (options.autoStart !== false) this.start();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.config.bookkeepingIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const probeId of this.pendingProbes.keys()) this.clearPendingProbe(probeId);
    this.pendingChallenges.clear();
    this.repository.close?.();
  }

  private authenticationRequired(): boolean {
    return this.config.authMode !== "development" || Boolean(this.config.bootstrapSecret);
  }

  private validateGatewayToken(
    gateway: Gateway,
    token: string,
  ): TokenValidation | undefined {
    return this.repository.validateToken(token, gateway, this.now().toISOString());
  }

  private authenticateConnection(
    connectionId: string,
    token: string | undefined,
    requestedInstallationId?: string,
  ): TokenValidation | undefined {
    const connection = this.connections.get(connectionId);
    if (!connection || !token) return undefined;
    const validation = this.validateGatewayToken(connection.gateway, token);
    if (!validation) return undefined;
    if (
      requestedInstallationId &&
      requestedInstallationId !== validation.installation_id
    ) {
      return undefined;
    }
    const record = this.repository.updateConnectionIdentity(connectionId, {
      installation_id: validation.installation_id,
    });
    if (!record) return undefined;
    connection.authenticated = true;
    connection.token_id = validation.token_id;
    connection.token_installation_id = validation.installation_id;
    return validation;
  }

  private requireAuthenticated(connectionId: string): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection) return false;
    if (connection.authenticated || !this.authenticationRequired()) return true;
    this.sendError(connectionId, "unauthorized", "authentication required");
    return false;
  }
  connect(options: ConnectOptions): { connection_id: string; record: ConnectionRecord } {
    const now = this.now().toISOString();
    const connectionId = `conn_${randomUUID()}`;
    const clientId =
      nonEmptyString(options.client_id) ?? `${options.gateway}-${connectionId.slice(-12)}`;
    const requestedInstallationId = nonEmptyString(options.installation_id);
    const suppliedToken =
      options.gateway === "android"
        ? nonEmptyString(options.android_token ?? options.token)
        : nonEmptyString(options.token);
    const tokenValidation = suppliedToken
      ? this.validateGatewayToken(options.gateway, suppliedToken)
      : undefined;
    const authenticated = !this.authenticationRequired() || tokenValidation !== undefined;
    const installationId = tokenValidation?.installation_id ?? requestedInstallationId;
    const record = this.repository.registerConnection({
      connection_id: connectionId,
      gateway: options.gateway,
      client_id: clientId,
      ...(installationId ? { installation_id: installationId } : {}),
      connected_at: now,
    });
    if (options.gateway === "collector" && installationId && authenticated) {
      this.probeStaleInstallations.delete(installationId);
    }
    this.connections.set(connectionId, {
      id: connectionId,
      gateway: options.gateway,
      transport: options.transport,
      subscriptions: null,
      lastHeartbeatSentMs: Date.parse(now),
      authenticated,
      ...(tokenValidation?.token_id ? { token_id: tokenValidation.token_id } : {}),
      ...(tokenValidation?.installation_id
        ? { token_installation_id: tokenValidation.installation_id }
        : {}),
    });

    this.send(connectionId, {
      type: "hello_ack",
      schema_version: RELAY_SCHEMA_VERSION,
      connection_id: connectionId,
      accepted: authenticated,
      server_time: now,
      ...(installationId ? { installation_id: installationId } : {}),
      ...(options.gateway === "android" && installationId && authenticated
        ? { snapshot: this.snapshot(installationId) }
        : {}),
    });
    this.logger.info("client_connected", { gateway: options.gateway });
    if (options.gateway === "collector" && installationId && authenticated) {
      this.broadcastSnapshotsForInstallation(installationId);
    }
    return { connection_id: connectionId, record };
  }

  disconnect(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    const before = this.repository.getConnection(connectionId);
    const disconnected = this.repository.disconnectConnection(
      connectionId,
      this.now().toISOString(),
    );
    this.connections.delete(connectionId);
    for (const [probeId, pending] of this.pendingProbes) {
      if (pending.sourceConnectionId === connectionId) this.clearPendingProbe(probeId);
    }
    for (const [challengeId, pending] of this.pendingChallenges) {
      if (pending.sourceConnectionId === connectionId) this.pendingChallenges.delete(challengeId);
    }
    this.logger.info("client_disconnected", { gateway: connection.gateway });
    if (before?.installation_id || disconnected?.installation_id) {
      this.broadcastSnapshotsForInstallation(
        before?.installation_id ?? disconnected?.installation_id,
      );
    }
  }

  receive(connectionId: string, raw: string | Uint8Array): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
    if (Buffer.byteLength(text, "utf8") > this.config.maxMessageBytes) {
      this.sendError(connectionId, "message_too_large", "message is too large");
      return;
    }

    this.repository.touchConnection(connectionId, this.now().toISOString());
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.sendError(connectionId, "invalid_message", "message must be valid JSON");
      return;
    }
    this.receiveMessage(connectionId, parsed);
  }

  receiveMessage(connectionId: string, parsed: unknown): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    this.repository.touchConnection(connectionId, this.now().toISOString());
    const touchedRecord = this.repository.getConnection(connectionId);
    if (touchedRecord?.gateway === "collector" && touchedRecord.installation_id) {
      const wasProbeStale = this.probeStaleInstallations.delete(touchedRecord.installation_id);
      if (wasProbeStale) {
        this.broadcastSnapshotsForInstallation(touchedRecord.installation_id);
      }
    }
    if (!isRecord(parsed)) {
      this.sendError(connectionId, "invalid_message", "message must be a JSON object");
      return;
    }

    const schemaVersion = parsed.schema_version;
    if (schemaVersion !== undefined && schemaVersion !== RELAY_SCHEMA_VERSION) {
      this.sendError(connectionId, "unsupported_schema_version", "unsupported schema version");
      return;
    }

    switch (messageType(parsed)) {
      case "hello":
        this.handleHello(connectionId, parsed);
        return;
      case "event":
        this.handleEvent(connectionId, parsed);
        return;
      case "usage_snapshot":
        this.handleUsageSnapshot(connectionId, parsed);
        return;
      case "heartbeat":
        this.handleHeartbeat(connectionId, parsed);
        return;
      case "subscribe":
        this.handleSubscribe(connectionId, parsed);
        return;
      case "resume":
        this.handleResume(connectionId, parsed);
        return;
      case "probe":
        this.handleProbe(connectionId, parsed);
        return;
      case "challenge":
        this.handleChallenge(connectionId, parsed);
        return;
      case "challenge_ack":
        this.handleChallengeAck(connectionId, parsed);
        return;
      default:
        this.sendError(connectionId, "invalid_message", "unsupported message type");
    }
  }

  tick(): void {
    const now = this.now();
    const nowIso = now.toISOString();
    const changed = this.repository.refreshConnectionStatuses(
      nowIso,
      this.config.staleAfterMs,
      this.config.offlineAfterMs,
    );
    this.prunePendingChallenges(now.getTime());

    let sessionChanged = false;
    for (const installationId of this.repository.listInstallationIds()) {
      const fingerprint = this.sessionFingerprint(installationId, nowIso);
      const previous = this.sessionSnapshotFingerprints.get(installationId);
      if (previous !== undefined && previous !== fingerprint) sessionChanged = true;
      this.sessionSnapshotFingerprints.set(installationId, fingerprint);
    }

    for (const connection of this.connections.values()) {
      if (now.getTime() - connection.lastHeartbeatSentMs < this.config.heartbeatIntervalMs) {
        continue;
      }
      const heartbeatId = `hb_${randomUUID()}`;
      connection.lastHeartbeatSentMs = now.getTime();
      this.send(connection.id, {
        type: "heartbeat",
        schema_version: RELAY_SCHEMA_VERSION,
        heartbeat_id: heartbeatId,
        sent_at: nowIso,
      });
    }

    if (changed || sessionChanged) this.broadcastAllSnapshots();
  }

  snapshot(installationId: string): SnapshotMessage {
    const now = this.now().toISOString();
    const state = this.repository.getInstallationState(installationId, now);
    const connectionStatus = this.repository.connectionStatusForInstallation(installationId);
    const computerState =
      connectionStatus === "offline"
        ? "offline"
        : this.probeStaleInstallations.has(installationId)
          ? "stale"
          : connectionStatus;
    return {
      type: "snapshot",
      schema_version: RELAY_SCHEMA_VERSION,
      installation_id: installationId,
      computer_state: computerState,
      claude_state: state?.claude_state ?? "idle",
      ...(state?.activity ? { activity: state.activity } : {}),
      last_sequence: state?.last_sequence ?? null,
      updated_at: state?.updated_at ?? now,
      ...(state?.sessions ? { sessions: state.sessions } : {}),
      main_running_count: state?.main_running_count ?? 0,
      main_session_count: state?.main_session_count ?? 0,
      total_running_count: state?.total_running_count ?? 0,
      running_count: state?.running_count ?? 0,
      session_count: state?.session_count ?? 0,
      ...(state?.recent_completion ? { recent_completion: state.recent_completion } : {}),
      ...(state?.usage ? { usage: state.usage } : {}),
    };
  }

  snapshots(installationId?: string): SnapshotMessage[] {
    const ids = installationId
      ? [installationId]
      : this.repository.listInstallationIds();
    return ids.map((id) => this.snapshot(id));
  }

  stats(): RelayStats {
    const records = this.repository.listConnections();
    return {
      active_connections: this.connections.size,
      collector_connections: records.filter((record) => record.gateway === "collector").length,
      android_connections: records.filter((record) => record.gateway === "android").length,
      installations: this.repository.listInstallationIds().length,
      stored_events: this.repository.listInstallationIds().reduce(
        (count, installationId) => count + this.repository.listEventsAfter(installationId, -1).length,
        0,
      ),
    };
  }

  createPairing(request: PairingCreateRequest = {} as PairingCreateRequest): PairingCreated {
    const installationId =
      nonEmptyString(request.installation_id) ?? `install_${randomUUID()}`;
    const wsUrl = this.resolveWsUrl(request.public_url ?? request.relay_url);
    const now = this.now().toISOString();
    const reusingCollectorToken = request.collector_token !== undefined;
    const collectorToken = reusingCollectorToken ? request.collector_token as string : createOpaqueToken("col");
    if (reusingCollectorToken && !this.isCollectorTokenValid(installationId, collectorToken)) {
      throw new InvalidCollectorTokenError();
    }
    const record = this.repository.createPairing(now, this.config.pairingTtlMs, {
      installation_id: installationId,
      ws_url: wsUrl,
      ...(request.relay_url ? { relay_url: request.relay_url } : {}),
      ...(request.public_url ? { public_url: request.public_url } : {}),
      collector_token_hash: hashOpaqueToken(collectorToken),
    });
    if (!reusingCollectorToken) {
      this.repository.createDeviceToken({
        role: "collector",
        installation_id: installationId,
        token: collectorToken,
        issued_at: now,
      });
    }
    const qrPayload = JSON.stringify({
      version: RELAY_SCHEMA_VERSION,
      relay_http_url: this.resolveHttpUrl(request.public_url ?? request.relay_url),
      relay_ws_url: this.resolveAndroidWsUrl(request.public_url ?? request.relay_url, wsUrl),
      pairing_id: record.pairing_id,
      pairing_code: record.code,
      installation_id: installationId,
    });
    return {
      pairing_id: record.pairing_id,
      code: record.code,
      expires_at: record.expires_at,
      qr_payload: qrPayload,
      collector_token: collectorToken,
      installation_id: installationId,
      ws_url: wsUrl,
      mode: this.config.authMode,
    };
  }

  isCollectorTokenValid(installationId: string, token: string): boolean {
    const validation = this.repository.validateToken(token, "collector", this.now().toISOString());
    return validation?.role === "collector" && validation.installation_id === installationId;
  }

  getPairing(pairingId: string): PairingStatus | undefined {
    const record = this.repository.getPairing(pairingId, this.now().toISOString());
    if (!record) return undefined;
    return {
      pairing_id: record.pairing_id,
      expires_at: record.expires_at,
      status: record.status,
      installation_id: record.installation_id,
      ws_url: record.ws_url,
      mode: this.config.authMode,
    };
  }

  claimPairing(
    pairingId: string,
    code: string,
    deviceName?: string,
  ): boolean {
    return this.claimPairingResult(pairingId, code, deviceName) !== undefined;
  }

  claimPairingResult(
    pairingId: string,
    code: string,
    deviceName?: string,
  ): PairingClaimed | undefined {
    const now = this.now().toISOString();
    const pairing = this.repository.getPairing(pairingId, now);
    if (!pairing || pairing.status !== "pending") return undefined;
    if (!this.repository.claimPairing(pairingId, code, now, deviceName)) return undefined;
    const androidToken = createOpaqueToken("and");
    this.repository.createDeviceToken({
      role: "android",
      installation_id: pairing.installation_id,
      token: androidToken,
      issued_at: now,
      device_name: deviceName,
    });
    this.repository.attachAndroidToken(
      pairingId,
      hashOpaqueToken(androidToken),
      deviceName,
      now,
    );
    return {
      installation_id: pairing.installation_id,
      android_token: androidToken,
      ws_url: pairing.ws_url,
      expires_at: pairing.expires_at,
    };
  }

  revokeToken(tokenId: string): boolean {
    return this.repository.revokeToken(tokenId, this.now().toISOString());
  }

  private resolveHttpUrl(requestedUrl?: string): string {
    const candidate = requestedUrl ?? this.config.publicUrl;
    if (!candidate) return `http://${this.config.host}:${this.config.port}`;
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid relay HTTP URL");
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  }

  private resolveAndroidWsUrl(requestedUrl: string | undefined, wsUrl: string): string {
    const candidate = requestedUrl ?? wsUrl;
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:") parsed.protocol = "ws:";
    if (parsed.protocol === "https:") parsed.protocol = "wss:";
    parsed.pathname = "/ws/android";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  }

  private resolveWsUrl(requestedUrl?: string): string {
    const candidate = requestedUrl ?? this.config.publicUrl;
    if (!candidate) return `ws://${this.config.host}:${this.config.port}`;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error("invalid relay URL");
    }
    if (!["ws:", "wss:", "http:", "https:"].includes(parsed.protocol)) {
      throw new Error("invalid relay URL");
    }
    if (parsed.protocol === "http:") parsed.protocol = "ws:";
    if (parsed.protocol === "https:") parsed.protocol = "wss:";
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  }

  private handleHello(connectionId: string, message: Record<string, unknown>): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    const requestedInstallationId = optionalString(message.installation_id);
    const clientId = optionalString(message.client_id);
    const suppliedToken = optionalString(message.token, 512);
    const before = this.repository.getConnection(connectionId);

    if (connection.gateway === "collector" && this.authenticationRequired()) {
      if (!this.authenticateConnection(connectionId, suppliedToken, requestedInstallationId)) {
        this.sendError(connectionId, "unauthorized", "invalid credentials");
        return;
      }
    } else if (suppliedToken) {
      // Development mode may still validate an explicitly supplied token. A
      // bad token is never treated as an implicit bypass when one is present.
      const validation = this.authenticateConnection(
        connectionId,
        suppliedToken,
        requestedInstallationId,
      );
      if (!validation && this.authenticationRequired()) {
        this.sendError(connectionId, "unauthorized", "invalid credentials");
        return;
      }
    }

    const current = this.repository.getConnection(connectionId);
    if (!current) {
      this.sendError(connectionId, "unauthorized", "connection is no longer active");
      return;
    }
    if (this.authenticationRequired() && !connection.authenticated) {
      this.sendError(connectionId, "unauthorized", "authentication required");
      return;
    }
    const identityInstallation = connection.token_installation_id
      ? connection.token_installation_id
      : requestedInstallationId;
    const record = this.repository.updateConnectionIdentity(connectionId, {
      ...(identityInstallation ? { installation_id: identityInstallation } : {}),
      ...(clientId ? { client_id: clientId } : {}),
    });
    if (!record) {
      this.sendError(connectionId, "unauthorized", "connection is no longer active");
      return;
    }

    this.send(connectionId, {
      type: "hello_ack",
      schema_version: RELAY_SCHEMA_VERSION,
      connection_id: connectionId,
      accepted: connection.authenticated || !this.authenticationRequired(),
      server_time: this.now().toISOString(),
      ...(record.installation_id ? { installation_id: record.installation_id } : {}),
      ...(connection.gateway === "android" && record.installation_id && connection.authenticated
        ? { snapshot: this.snapshot(record.installation_id) }
        : {}),
    });
    if (before?.installation_id !== record.installation_id) {
      this.broadcastSnapshotsForInstallation(before?.installation_id);
      if (connection.authenticated) this.broadcastSnapshotsForInstallation(record.installation_id);
    }
  }

  private handleEvent(connectionId: string, message: Record<string, unknown>): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    if (!this.requireAuthenticated(connectionId)) return;
    if (connection.gateway !== "collector") {
      this.sendError(connectionId, "forbidden_gateway", "only collectors may ingest events");
      return;
    }

    const event = this.parseEvent(message);
    if (!event) {
      const eventId = optionalString(message.event_id);
      if (eventId) {
        this.sendRejectedEventAck(
          connectionId,
          eventId,
          "invalid event",
          safeSequence(message.sequence) ?? 0,
        );
      }
      this.sendError(connectionId, "invalid_event", "invalid event envelope");
      return;
    }

    const connectionRecord = this.repository.getConnection(connectionId);
    if (
      connectionRecord?.installation_id &&
      connectionRecord.installation_id !== event.installation_id
    ) {
      this.sendRejectedEventAck(
        connectionId,
        event.event_id,
        "installation mismatch",
        event.sequence,
      );
      this.sendError(connectionId, "invalid_event", "installation does not match hello");
      return;
    }
    if (!connectionRecord?.installation_id) {
      this.repository.updateConnectionIdentity(connectionId, {
        installation_id: event.installation_id,
      });
    }

    const safeEvent = sanitizeEvent(event);
    this.probeStaleInstallations.delete(safeEvent.installation_id);
    const result = this.repository.recordEvent(safeEvent, this.now().toISOString());
    const ack: EventAckMessage = {
      type: "event_ack",
      schema_version: RELAY_SCHEMA_VERSION,
      event_id: safeEvent.event_id,
      sequence: safeEvent.sequence,
      accepted: !result.duplicate && !result.conflict,
      duplicate: result.duplicate,
      status: result.conflict ? "rejected" : result.duplicate ? "duplicate" : "accepted",
      sequence_status: result.sequence_status,
      last_sequence: result.last_sequence,
      next_sequence: result.next_sequence,
      received_at: result.stored.received_at,
      ...(result.conflict ? { error: "event identity or sequence conflict" } : {}),
    };
    this.send(connectionId, ack);
    this.logger.info("event_received", {
      gateway: connection.gateway,
      event_type: safeEvent.event_type,
      sequence: safeEvent.sequence,
      sequence_status: result.sequence_status,
      duplicate: result.duplicate,
    });
    if (!result.duplicate && !result.conflict) {
      if (result.activity_applied) this.broadcastEventForInstallation(result.stored.event);
      this.broadcastSnapshotsForInstallation(safeEvent.installation_id);
    }
  }

  private handleUsageSnapshot(connectionId: string, message: Record<string, unknown>): void {
    const connection = this.connections.get(connectionId);
    if (!connection || !this.requireAuthenticated(connectionId)) return;
    if (connection.gateway !== "collector") {
      this.sendError(connectionId, "forbidden_gateway", "only collectors may ingest usage snapshots");
      return;
    }
    const usageMessage = this.parseUsageSnapshot(message);
    if (!usageMessage) {
      const eventId = optionalString(message.event_id, 256);
      if (eventId) this.sendRejectedEventAck(connectionId, eventId, "invalid usage snapshot", safeSequence(message.sequence) ?? 0);
      this.sendError(connectionId, "invalid_usage_snapshot", "invalid usage snapshot envelope");
      return;
    }
    const connectionRecord = this.repository.getConnection(connectionId);
    if (connectionRecord?.installation_id && connectionRecord.installation_id !== usageMessage.installation_id) {
      this.sendRejectedEventAck(connectionId, usageMessage.event_id, "installation mismatch", usageMessage.sequence);
      this.sendError(connectionId, "invalid_usage_snapshot", "installation does not match hello");
      return;
    }
    if (!connectionRecord?.installation_id) {
      this.repository.updateConnectionIdentity(connectionId, { installation_id: usageMessage.installation_id });
    }

    this.probeStaleInstallations.delete(usageMessage.installation_id);
    const result = this.repository.recordUsageSnapshot(usageMessage, this.now().toISOString());
    this.send(connectionId, {
      type: "event_ack",
      schema_version: RELAY_SCHEMA_VERSION,
      event_id: usageMessage.event_id,
      sequence: usageMessage.sequence,
      accepted: !result.duplicate && !result.conflict,
      duplicate: result.duplicate,
      status: result.conflict ? "rejected" : result.duplicate ? "duplicate" : "accepted",
      sequence_status: result.sequence_status,
      last_sequence: result.last_sequence,
      next_sequence: result.next_sequence,
      received_at: this.now().toISOString(),
      ...(result.conflict ? { error: "event identity or sequence conflict" } : {}),
    });
    this.logger.info("usage_snapshot_received", {
      gateway: connection.gateway,
      sequence: usageMessage.sequence,
      sequence_status: result.sequence_status,
      duplicate: result.duplicate,
      changed: result.changed,
    });
    if (!result.conflict && !result.duplicate && result.changed) this.broadcastSnapshotsForInstallation(usageMessage.installation_id);
  }

  private handleHeartbeat(connectionId: string, message: Record<string, unknown>): void {
    if (!this.requireAuthenticated(connectionId)) return;
    const heartbeatId =
      optionalString(message.heartbeat_id, 128) ?? optionalString(message.nonce, 128);
    const acknowledged = message.acknowledged === true;
    const seenAt = this.now().toISOString();
    this.repository.touchConnection(connectionId, seenAt);
    if (acknowledged) return;
    const record = this.repository.getConnection(connectionId);
    const state = record?.installation_id
      ? this.repository.getInstallationState(record.installation_id)
      : undefined;
    const response: HeartbeatMessage = {
      type: "heartbeat",
      schema_version: RELAY_SCHEMA_VERSION,
      role: "relay",
      ...(record?.installation_id ? { installation_id: record.installation_id } : {}),
      ...(state?.last_sequence !== null && state?.last_sequence !== undefined
        ? { last_sequence: state.last_sequence }
        : {}),
      ...(heartbeatId ? { heartbeat_id: heartbeatId, nonce: heartbeatId } : {}),
      sent_at: seenAt,
      occurred_at: seenAt,
      acknowledged: true,
    };
    this.send(connectionId, response);
  }

  private handleSubscribe(connectionId: string, message: Record<string, unknown>): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    const suppliedToken = optionalString(message.token, 512);
    if (connection.gateway === "android" && this.authenticationRequired()) {
      if (!this.authenticateConnection(connectionId, suppliedToken, optionalString(message.installation_id))) {
        this.sendError(connectionId, "unauthorized", "invalid credentials");
        return;
      }
    } else if (suppliedToken) {
      const validation = this.authenticateConnection(connectionId, suppliedToken, optionalString(message.installation_id));
      if (!validation && this.authenticationRequired()) {
        this.sendError(connectionId, "unauthorized", "invalid credentials");
        return;
      }
    }
    if (!this.requireAuthenticated(connectionId)) return;
    const requestsAll =
      message.all === true ||
      message.installation_ids === undefined && message.installation_id === undefined;
    const tokenInstallationId = this.authenticationRequired()
      ? connection.token_installation_id
      : undefined;
    const all = requestsAll && tokenInstallationId === undefined;
    const ids = new Set<string>();
    if (tokenInstallationId) {
      ids.add(tokenInstallationId);
    } else if (!all) {
      if (Array.isArray(message.installation_ids)) {
        for (const value of message.installation_ids) {
          const id = nonEmptyString(value);
          if (id) ids.add(id);
        }
      }
      const singular = nonEmptyString(message.installation_id);
      if (singular) ids.add(singular);
    }
    connection.subscriptions = all ? null : ids;
    const identityInstallation =
      tokenInstallationId ??
      nonEmptyString(message.installation_id) ??
      (ids.size === 1 ? [...ids][0] : undefined);
    const currentRecord = this.repository.getConnection(connectionId);
    if (!currentRecord?.installation_id && identityInstallation) {
      this.repository.updateConnectionIdentity(connectionId, {
        installation_id: identityInstallation,
      });
    }
    const subscribedIds = all ? this.repository.listInstallationIds() : [...ids].sort();
    const response: SubscribeMessage = {
      type: "subscribe",
      schema_version: RELAY_SCHEMA_VERSION,
      installation_ids: subscribedIds,
      all,
    };
    this.send(connectionId, response);
    this.sendSnapshots(connectionId);
  }

  private handleResume(connectionId: string, message: Record<string, unknown>): void {
    if (!this.requireAuthenticated(connectionId)) return;
    const connection = this.connections.get(connectionId);
    const installationId = nonEmptyString(message.installation_id);
    const lastSequence =
      message.last_sequence === undefined ? -1 : safeSequence(message.last_sequence);
    if (!installationId || lastSequence === undefined) {
      this.sendError(connectionId, "invalid_message", "resume requires installation_id and last_sequence");
      return;
    }
    if (
      connection &&
      this.authenticationRequired() &&
      connection.token_installation_id !== installationId
    ) {
      this.sendError(connectionId, "unauthorized", "installation does not match phone token");
      return;
    }

    for (const stored of this.repository.listEventsAfter(installationId, lastSequence)) {
      // Older databases default presentation eligibility to true, but unknown
      // completions still cannot identify a session or task to present.
      if (stored.activity_applied !== false &&
          !(stored.event.session_id === "unknown" && stored.event.event_type === "task_finished")) {
        this.send(connectionId, stored.event);
      }
    }
    this.sendSnapshotIfSubscribed(connectionId, installationId);
  }

  private handleProbe(connectionId: string, message: Record<string, unknown>): void {
    if (!this.requireAuthenticated(connectionId)) return;
    const probeId = nonEmptyString(message.probe_id, 128) ?? `probe_${randomUUID()}`;
    const nonce = nonEmptyString(message.nonce, 512) ?? `nonce_${randomUUID()}`;
    const timeoutMs =
      typeof message.timeout_ms === "number" &&
      Number.isSafeInteger(message.timeout_ms) &&
      message.timeout_ms >= 0 &&
      message.timeout_ms <= 300_000
        ? Math.max(1, message.timeout_ms)
        : this.config.probeTimeoutMs;
    this.clearPendingProbe(probeId);
    const sourceRecord = this.repository.getConnection(connectionId);
    const challenge: ChallengeMessage = {
      type: "challenge",
      schema_version: RELAY_SCHEMA_VERSION,
      probe_id: probeId,
      nonce,
      expires_at: new Date(this.now().getTime() + timeoutMs).toISOString(),
      ...(optionalString(message.challenge_id, 128)
        ? { challenge_id: optionalString(message.challenge_id, 128) }
        : {}),
      ...(optionalString(message.target_installation_id)
        ? { target_installation_id: optionalString(message.target_installation_id) }
        : {}),
      ...(isGateway(message.target_gateway) ? { target_gateway: message.target_gateway } : {}),
      ...(optionalString(message.target_connection_id)
        ? { target_connection_id: optionalString(message.target_connection_id) }
        : {}),
    };
    const timer = setTimeout(() => this.handleProbeTimeout(probeId), timeoutMs);
    timer.unref();
    this.pendingProbes.set(probeId, {
      sourceConnectionId: connectionId,
      ...(sourceRecord?.installation_id
        ? { sourceInstallationId: sourceRecord.installation_id }
        : {}),
      probeId,
      nonce,
      createdAtMs: this.now().getTime(),
      timer,
    });
    if (!this.route(connectionId, challenge, challenge.target_gateway)) {
      this.clearPendingProbe(probeId);
    }
  }

  private handleChallenge(connectionId: string, message: Record<string, unknown>): void {
    if (!this.requireAuthenticated(connectionId)) return;
    const challengeId =
      nonEmptyString(message.challenge_id, 128) ??
      nonEmptyString(message.probe_id, 128) ??
      nonEmptyString(message.nonce, 512);
    if (!challengeId) {
      this.sendError(connectionId, "invalid_message", "challenge requires an identifier");
      return;
    }
    const parsed: ChallengeMessage = {
      type: "challenge",
      schema_version: RELAY_SCHEMA_VERSION,
      ...(optionalString(message.challenge, 512)
        ? { challenge: optionalString(message.challenge, 512) }
        : {}),
      ...(optionalString(message.challenge_id, 128)
        ? { challenge_id: optionalString(message.challenge_id, 128) }
        : {}),
      ...(optionalString(message.probe_id, 128)
        ? { probe_id: optionalString(message.probe_id, 128) }
        : {}),
      ...(optionalString(message.nonce, 512) ? { nonce: optionalString(message.nonce, 512) } : {}),
      ...(optionalString(message.expires_at, 128)
        ? { expires_at: optionalString(message.expires_at, 128) }
        : {}),
      ...(optionalString(message.target_installation_id)
        ? { target_installation_id: optionalString(message.target_installation_id) }
        : {}),
      ...(isGateway(message.target_gateway) ? { target_gateway: message.target_gateway } : {}),
      ...(optionalString(message.target_connection_id)
        ? { target_connection_id: optionalString(message.target_connection_id) }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(message, "payload")
        ? { payload: redactPayload(message.payload) }
        : {}),
    };
    this.pendingChallenges.set(challengeId, {
      sourceConnectionId: connectionId,
      createdAtMs: this.now().getTime(),
    });
    if (!this.route(connectionId, parsed, parsed.target_gateway)) {
      this.pendingChallenges.delete(challengeId);
    }
  }

  private handleChallengeAck(connectionId: string, message: Record<string, unknown>): void {
    if (!this.requireAuthenticated(connectionId)) return;
    const probeId = optionalString(message.probe_id, 128);
    const nonce = optionalString(message.nonce, 512);
    const pendingProbe = probeId
      ? this.pendingProbes.get(probeId)
      : nonce
        ? [...this.pendingProbes.values()].find((pending) => pending.nonce === nonce)
        : undefined;
    if (pendingProbe) {
      this.clearPendingProbe(pendingProbe.probeId);
      const ack: ChallengeAckMessage = {
        type: "challenge_ack",
        schema_version: RELAY_SCHEMA_VERSION,
        ...(optionalString(message.challenge, 512)
          ? { challenge: optionalString(message.challenge, 512) }
          : {}),
        ...(optionalString(message.challenge_id, 128)
          ? { challenge_id: optionalString(message.challenge_id, 128) }
          : {}),
        ...(probeId ? { probe_id: probeId } : { probe_id: pendingProbe.probeId }),
        ...(nonce ? { nonce } : { nonce: pendingProbe.nonce }),
        ...(optionalString(message.proof, 512) ? { proof: optionalString(message.proof, 512) } : {}),
        ...(optionalString(message.signature, 512)
          ? { signature: optionalString(message.signature, 512) }
          : {}),
        ...(typeof message.ok === "boolean" ? { ok: message.ok } : {}),
        ...(Object.prototype.hasOwnProperty.call(message, "payload")
          ? { payload: redactPayload(message.payload) }
          : {}),
      };
      if (pendingProbe.sourceInstallationId) {
        this.probeStaleInstallations.delete(pendingProbe.sourceInstallationId);
        this.broadcastSnapshotsForInstallation(pendingProbe.sourceInstallationId);
      }
      if (!this.send(pendingProbe.sourceConnectionId, ack)) {
        this.sendError(connectionId, "route_not_found", "probe requester is offline");
      }
      return;
    }

    const challengeId = nonEmptyString(message.challenge_id, 128);
    if (!challengeId || typeof message.ok !== "boolean") {
      this.sendError(connectionId, "invalid_message", "challenge_ack requires a known challenge");
      return;
    }
    const pending = this.pendingChallenges.get(challengeId);
    if (!pending) {
      this.sendError(connectionId, "route_not_found", "challenge route is no longer available");
      return;
    }
    this.pendingChallenges.delete(challengeId);
    const ack: ChallengeAckMessage = {
      type: "challenge_ack",
      schema_version: RELAY_SCHEMA_VERSION,
      challenge_id: challengeId,
      ok: message.ok,
      ...(probeId ? { probe_id: probeId } : {}),
      ...(nonce ? { nonce } : {}),
      ...(optionalString(message.proof, 512) ? { proof: optionalString(message.proof, 512) } : {}),
      ...(optionalString(message.signature, 512)
        ? { signature: optionalString(message.signature, 512) }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(message, "payload")
        ? { payload: redactPayload(message.payload) }
        : {}),
    };
    if (!this.send(pending.sourceConnectionId, ack)) {
      this.sendError(connectionId, "route_not_found", "challenge requester is offline");
    }
  }

  private route(
    sourceConnectionId: string,
    message: ProbeMessage | ChallengeMessage,
    requestedGateway?: Gateway,
  ): boolean {
    const source = this.connections.get(sourceConnectionId);
    if (!source) return false;
    const sourceRecord = this.repository.getConnection(sourceConnectionId);
    const targetConnectionId = optionalString(message.target_connection_id);
    const targetInstallationId = optionalString(message.target_installation_id);
    const defaultGateway: Gateway = source.gateway === "collector" ? "android" : "collector";
    const targetGateway = requestedGateway ?? defaultGateway;

    const targets = [...this.connections.values()].filter((candidate) => {
      if (candidate.id === sourceConnectionId) return false;
      if (targetConnectionId && candidate.id !== targetConnectionId) return false;
      if (candidate.gateway !== targetGateway) return false;
      const candidateRecord = this.repository.getConnection(candidate.id);
      if (candidateRecord?.status !== "online") return false;
      if (targetInstallationId && candidateRecord.installation_id !== targetInstallationId) {
        return false;
      }
      return true;
    });

    if (targets.length === 0) {
      this.sendError(sourceConnectionId, "target_not_found", "no matching gateway is connected");
      return false;
    }
    for (const target of targets) this.send(target.id, message);
    this.logger.info("message_routed", {
      message_type: message.type,
      gateway: source.gateway,
      target_gateway: targetGateway,
      target_count: targets.length,
      ...(sourceRecord?.installation_id ? { source_has_installation: true } : {}),
    });
    return true;
  }

  private parseEvent(message: Record<string, unknown>): EventEnvelope | undefined {
    if (message.schema_version !== RELAY_SCHEMA_VERSION) return undefined;
    const eventId = nonEmptyString(message.event_id);
    const installationId = nonEmptyString(message.installation_id);
    const sessionId = nonEmptyString(message.session_id);
    const sequence = safeSequence(message.sequence);
    const occurredAt = nonEmptyString(message.occurred_at, 128);
    const eventType = message.event_type;
    if (
      !eventId ||
      !installationId ||
      !sessionId ||
      sequence === undefined ||
      !occurredAt ||
      !isEventType(eventType) ||
      eventType.length > MAX_EVENT_TYPE_LENGTH ||
      !Object.prototype.hasOwnProperty.call(message, "payload")
    ) {
      return undefined;
    }
    if (Number.isNaN(Date.parse(occurredAt))) return undefined;

    if (message.session_kind !== undefined && !["main", "subagent"].includes(String(message.session_kind))) return undefined;
    if (eventType === "session_classification_updated" && (!message.session_kind || sessionId === "unknown" ||
      !isRecord(message.payload) || Object.keys(message.payload).length !== 0)) return undefined;
    const sessionKind = message.session_kind as "main" | "subagent" | undefined;
    const taskId = optionalString(message.task_id);
    const correlationId = optionalString(message.correlation_id);
    const sessionTitle =
      ["session_started", "task_started", "task_finished", "session_title_updated"].includes(eventType)
        ? safeSessionTitle(message.session_title) : undefined;
    if (eventType === "session_title_updated" && (
      !sessionTitle || !isRecord(message.payload) || Object.keys(message.payload).length !== 0
    )) return undefined;
    return {
      type: "event",
      schema_version: RELAY_SCHEMA_VERSION,
      event_id: eventId,
      installation_id: installationId,
      session_id: sessionId,
      ...(sessionTitle ? { session_title: sessionTitle } : {}),
      ...(sessionKind ? { session_kind: sessionKind } : {}),
      ...(taskId ? { task_id: taskId } : {}),
      sequence,
      occurred_at: occurredAt,
      event_type: eventType,
      payload: message.payload,
      ...(correlationId ? { correlation_id: correlationId } : {}),
    };
  }

  private parseUsageSnapshot(message: Record<string, unknown>): UsageSnapshotMessage | undefined {
    const sequence = safeSequence(message.sequence);
    const eventId = nonEmptyString(message.event_id, 256);
    const installationId = nonEmptyString(message.installation_id, 256);
    const occurredAt = nonEmptyString(message.occurred_at, 64);
    if (
      message.type !== "usage_snapshot" ||
      !hasOnlyKeys(message, ["type", "schema_version", "event_id", "installation_id", "sequence", "occurred_at", "usage"]) ||
      message.schema_version !== RELAY_SCHEMA_VERSION ||
      sequence === undefined ||
      !eventId ||
      !installationId ||
      !occurredAt ||
      Number.isNaN(Date.parse(occurredAt)) ||
      !validUsageAggregate(message.usage)
    ) return undefined;
    return {
      type: "usage_snapshot",
      schema_version: RELAY_SCHEMA_VERSION,
      event_id: eventId,
      installation_id: installationId,
      sequence,
      occurred_at: occurredAt,
      usage: message.usage,
    };
  }

  private sendRejectedEventAck(
    connectionId: string,
    eventId: string,
    error: string,
    sequence: number,
  ): void {
    const installationId = this.repository.getConnection(connectionId)?.installation_id;
    const state = installationId
      ? this.repository.getInstallationState(installationId)
      : undefined;
    this.send(connectionId, {
      type: "event_ack",
      schema_version: RELAY_SCHEMA_VERSION,
      event_id: eventId,
      sequence,
      status: "rejected",
      accepted: false,
      duplicate: false,
      last_sequence: state?.last_sequence ?? null,
      next_sequence: state?.last_sequence === null || state?.last_sequence === undefined
        ? null
        : state.last_sequence + 1,
      received_at: this.now().toISOString(),
      error,
    });
  }

  private sendError(
    connectionId: string,
    code: ErrorMessage["code"],
    message: string,
    retryable = false,
  ): void {
    this.send(connectionId, {
      type: "error",
      schema_version: RELAY_SCHEMA_VERSION,
      code,
      message,
      retryable,
    });
    this.logger.warn("relay_error", { code });
  }

  private send(connectionId: string, message: ServerMessage): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection) return false;
    try {
      connection.transport.send(message);
      return true;
    } catch {
      this.logger.warn("transport_send_failed", { gateway: connection.gateway });
      return false;
    }
  }

  private sendSnapshots(connectionId: string, installationId?: string): void {
    if (installationId) {
      this.sendSnapshotIfSubscribed(connectionId, installationId);
      return;
    }
    for (const snapshot of this.snapshots()) {
      this.sendSnapshotIfSubscribed(connectionId, snapshot.installation_id);
    }
  }

  private isSubscribedToInstallation(
    connection: ActiveConnection,
    installationId: string,
  ): boolean {
    if (connection.gateway !== "android" || !connection.authenticated) return false;
    if (
      this.authenticationRequired() &&
      connection.token_installation_id !== installationId
    ) {
      return false;
    }
    return connection.subscriptions === null || connection.subscriptions.has(installationId);
  }

  private sendSnapshotIfSubscribed(connectionId: string, installationId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection || !this.isSubscribedToInstallation(connection, installationId)) return;
    this.send(connectionId, this.snapshot(installationId));
    this.sessionSnapshotFingerprints.set(
      installationId,
      this.sessionFingerprint(installationId, this.now().toISOString()),
    );
  }

  private broadcastEventForInstallation(event: EventEnvelope): void {
    for (const connection of this.connections.values()) {
      if (this.isSubscribedToInstallation(connection, event.installation_id)) {
        this.send(connection.id, event);
      }
    }
  }

  private broadcastSnapshotsForInstallation(installationId?: string): void {
    if (!installationId) return;
    for (const connection of this.connections.values()) {
      this.sendSnapshotIfSubscribed(connection.id, installationId);
    }
    this.sessionSnapshotFingerprints.set(
      installationId,
      this.sessionFingerprint(installationId, this.now().toISOString()),
    );
  }

  private sessionFingerprint(installationId: string, now: string): string {
    const state = this.repository.getInstallationState(installationId, now);
    return JSON.stringify({
      claude_state: state?.claude_state,
      sessions: state?.sessions,
      running_count: state?.running_count,
      main_running_count: state?.main_running_count,
      main_session_count: state?.main_session_count,
      total_running_count: state?.total_running_count,
      session_count: state?.session_count,
      recent_completion: state?.recent_completion,
    });
  }

  private broadcastAllSnapshots(): void {
    for (const installationId of this.repository.listInstallationIds()) {
      this.broadcastSnapshotsForInstallation(installationId);
    }
  }

  private clearPendingProbe(probeId: string): void {
    const pending = this.pendingProbes.get(probeId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingProbes.delete(probeId);
  }

  private handleProbeTimeout(probeId: string): void {
    const pending = this.pendingProbes.get(probeId);
    if (!pending) return;
    this.pendingProbes.delete(probeId);
    if (pending.sourceInstallationId) {
      this.probeStaleInstallations.add(pending.sourceInstallationId);
    }
    this.sendError(
      pending.sourceConnectionId,
      "PROBE_TIMEOUT",
      "probe challenge was not acknowledged before the deadline",
      true,
    );
    if (pending.sourceInstallationId) {
      this.broadcastSnapshotsForInstallation(pending.sourceInstallationId);
    }
    this.logger.warn("probe_timeout", { target: "collector" });
  }

  private prunePendingChallenges(nowMs: number): void {
    for (const [challengeId, pending] of this.pendingChallenges) {
      if (nowMs - pending.createdAtMs > MAX_PENDING_CHALLENGE_MS) {
        this.pendingChallenges.delete(challengeId);
      }
    }
    for (const [probeId, pending] of this.pendingProbes) {
      if (nowMs - pending.createdAtMs > MAX_PENDING_CHALLENGE_MS) {
        this.clearPendingProbe(probeId);
      }
    }
  }
}
