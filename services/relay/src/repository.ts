import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ClaudeState,
  ConnectionRecord,
  ConnectionStatus,
  DeviceTokenRecord,
  EventEnvelope,
  InstallationState,
  PairingCreateInput,
  PairingRecord,
  SequenceStatus,
  StoredEvent,
  TokenRole,
  TokenValidation,
} from "./types.js";
import { isConnectionStatus } from "./types.js";

export interface RecordEventResult {
  stored: StoredEvent;
  duplicate: boolean;
  sequence_status: SequenceStatus;
  last_sequence: number | null;
  next_sequence: number | null;
}

export interface CreateDeviceTokenInput {
  token_id?: string;
  role: TokenRole;
  installation_id: string;
  token: string;
  issued_at: string;
  expires_at?: string;
  device_name?: string;
}

export interface RelayRepository {
  registerConnection(input: {
    connection_id: string;
    gateway: ConnectionRecord["gateway"];
    client_id: string;
    installation_id?: string;
    connected_at: string;
  }): ConnectionRecord;
  updateConnectionIdentity(
    connectionId: string,
    identity: { client_id?: string; installation_id?: string },
  ): ConnectionRecord | undefined;
  touchConnection(connectionId: string, seenAt: string): ConnectionRecord | undefined;
  disconnectConnection(connectionId: string, disconnectedAt: string): ConnectionRecord | undefined;
  getConnection(connectionId: string): ConnectionRecord | undefined;
  listConnections(): ConnectionRecord[];
  refreshConnectionStatuses(
    now: string,
    staleAfterMs: number,
    offlineAfterMs: number,
  ): boolean;
  connectionStatusForInstallation(installationId: string): ConnectionStatus;

  findEvent(eventId: string): StoredEvent | undefined;
  recordEvent(event: EventEnvelope, receivedAt: string): RecordEventResult;
  listEventsAfter(installationId: string, sequence: number): StoredEvent[];
  listInstallationIds(): string[];
  getInstallationState(installationId: string): InstallationState | undefined;

  createPairing(
    now: string,
    ttlMs: number,
    input?: PairingCreateInput,
  ): PairingRecord;
  getPairing(pairingId: string, now: string): PairingRecord | undefined;
  claimPairing(pairingId: string, code: string, now: string, deviceName?: string): boolean;
  attachAndroidToken(
    pairingId: string,
    tokenHash: string,
    deviceName?: string,
    claimedAt?: string,
  ): PairingRecord | undefined;

  createDeviceToken(input: CreateDeviceTokenInput): DeviceTokenRecord;
  validateToken(token: string, role: TokenRole, now: string): TokenValidation | undefined;
  revokeToken(tokenId: string, revokedAt: string): boolean;

  /** A stable label used by health/readiness reporting. */
  readonly storageKind?: "memory" | "sqlite";
  close?(): void;
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function opaqueTokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOpaqueToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createOpaqueToken(prefix: "col" | "and" = "col"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stateForEvent(eventType: EventEnvelope["event_type"], previous: ClaudeState): ClaudeState {
  switch (eventType) {
    case "task_started":
    case "tool_started":
      return "working";
    case "waiting":
      return "waiting";
    case "task_finished":
    case "task_failed":
    case "session_ended":
      return "idle";
    case "tool_finished":
      return "working";
    case "tool_failed":
      return "idle";
    default:
      return previous;
  }
}

function defaultPairingInput(): PairingCreateInput {
  return {
    installation_id: "",
    ws_url: "",
    collector_token_hash: "",
  };
}

function normalizePairingInput(input?: PairingCreateInput): PairingCreateInput {
  return {
    ...defaultPairingInput(),
    ...(input ?? {}),
  };
}

function pairingStatus(record: PairingRecord, now: string): PairingRecord {
  if (record.status === "pending" && Date.parse(record.expires_at) <= Date.parse(now)) {
    record.status = "expired";
  }
  return record;
}

function tokenValidation(
  record: DeviceTokenRecord,
  token: string,
  role: TokenRole,
  now: string,
): TokenValidation | undefined {
  if (record.role !== role || record.revoked_at) return undefined;
  if (record.expires_at && Date.parse(record.expires_at) <= Date.parse(now)) return undefined;
  if (!opaqueTokenMatches(token, record.token_hash)) return undefined;
  return {
    token_id: record.token_id,
    role: record.role,
    installation_id: record.installation_id,
    ...(record.device_name ? { device_name: record.device_name } : {}),
  };
}

export class InMemoryRelayRepository implements RelayRepository {
  readonly storageKind = "memory" as const;
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly eventsById = new Map<string, StoredEvent>();
  private readonly eventOrder: string[] = [];
  private readonly eventsByInstallation = new Map<string, StoredEvent[]>();
  private readonly installations = new Map<string, InstallationState>();
  private readonly pairings = new Map<string, PairingRecord>();
  private readonly deviceTokens = new Map<string, DeviceTokenRecord>();
  private readonly maxStoredEvents: number;

  constructor(options: { maxStoredEvents?: number } = {}) {
    this.maxStoredEvents = Math.max(1, options.maxStoredEvents ?? 10_000);
  }

  registerConnection(input: {
    connection_id: string;
    gateway: ConnectionRecord["gateway"];
    client_id: string;
    installation_id?: string;
    connected_at: string;
  }): ConnectionRecord {
    const record: ConnectionRecord = {
      ...input,
      status: "online",
      last_seen_at: input.connected_at,
    };
    this.connections.set(input.connection_id, record);
    return clone(record);
  }

  updateConnectionIdentity(
    connectionId: string,
    identity: { client_id?: string; installation_id?: string },
  ): ConnectionRecord | undefined {
    const record = this.connections.get(connectionId);
    if (!record || record.disconnected_at) return undefined;
    if (identity.client_id !== undefined && identity.client_id.trim() !== "") {
      record.client_id = identity.client_id.trim();
    }
    if (identity.installation_id !== undefined && identity.installation_id.trim() !== "") {
      record.installation_id = identity.installation_id.trim();
    }
    return clone(record);
  }

  touchConnection(connectionId: string, seenAt: string): ConnectionRecord | undefined {
    const record = this.connections.get(connectionId);
    if (!record || record.disconnected_at) return undefined;
    record.last_seen_at = seenAt;
    record.status = "online";
    return clone(record);
  }

  disconnectConnection(connectionId: string, disconnectedAt: string): ConnectionRecord | undefined {
    const record = this.connections.get(connectionId);
    if (!record) return undefined;
    record.status = "offline";
    record.disconnected_at = disconnectedAt;
    return clone(record);
  }

  getConnection(connectionId: string): ConnectionRecord | undefined {
    const record = this.connections.get(connectionId);
    return record ? clone(record) : undefined;
  }

  listConnections(): ConnectionRecord[] {
    return [...this.connections.values()].map((record) => clone(record));
  }

  refreshConnectionStatuses(
    now: string,
    staleAfterMs: number,
    offlineAfterMs: number,
  ): boolean {
    const nowMs = Date.parse(now);
    let changed = false;
    for (const record of this.connections.values()) {
      if (record.disconnected_at) continue;
      const elapsedMs = Math.max(0, nowMs - Date.parse(record.last_seen_at));
      const nextStatus: ConnectionStatus =
        elapsedMs >= offlineAfterMs
          ? "offline"
          : elapsedMs >= staleAfterMs
            ? "stale"
            : "online";
      if (!isConnectionStatus(nextStatus)) continue;
      if (record.status !== nextStatus) {
        record.status = nextStatus;
        changed = true;
      }
    }
    return changed;
  }

  connectionStatusForInstallation(installationId: string): ConnectionStatus {
    const statuses = [...this.connections.values()]
      .filter(
        (record) =>
          record.gateway === "collector" && record.installation_id === installationId,
      )
      .map((record) => record.status);
    if (statuses.includes("online")) return "online";
    if (statuses.includes("stale")) return "stale";
    return "offline";
  }

  findEvent(eventId: string): StoredEvent | undefined {
    const stored = this.eventsById.get(eventId);
    return stored ? clone(stored) : undefined;
  }

  recordEvent(event: EventEnvelope, receivedAt: string): RecordEventResult {
    const existing =
      this.eventsById.get(event.event_id) ??
      this.eventsByInstallation
        .get(event.installation_id)
        ?.find((stored) => stored.event.sequence === event.sequence);
    const current = this.installations.get(event.installation_id);
    if (existing) {
      return {
        stored: clone(existing),
        duplicate: true,
        sequence_status: this.sequenceStatusForDuplicate(existing.event, current),
        last_sequence: current?.last_sequence ?? existing.event.sequence,
        next_sequence: current ? this.nextSequence(current.last_sequence) : existing.event.sequence + 1,
      };
    }

    const previousSequence = current?.last_sequence ?? null;
    const sequence_status = this.sequenceStatus(event.sequence, previousSequence);
    const stored: StoredEvent = { event: clone(event), received_at: receivedAt };
    this.eventsById.set(event.event_id, stored);
    this.eventOrder.push(event.event_id);
    const installationEvents = this.eventsByInstallation.get(event.installation_id) ?? [];
    installationEvents.push(stored);
    this.eventsByInstallation.set(event.installation_id, installationEvents);

    const nextState: InstallationState =
      current && previousSequence !== null && event.sequence < previousSequence
        ? current
        : {
            installation_id: event.installation_id,
            last_sequence:
              previousSequence === null
                ? event.sequence
                : Math.max(previousSequence, event.sequence),
            claude_state: stateForEvent(event.event_type, current?.claude_state ?? "idle"),
            activity: {
              event_type: event.event_type,
              session_id: event.session_id,
              ...(event.task_id ? { task_id: event.task_id } : {}),
              occurred_at: event.occurred_at,
            },
            updated_at: event.occurred_at,
          };
    this.installations.set(event.installation_id, nextState);
    this.pruneEvents();

    return {
      stored: clone(stored),
      duplicate: false,
      sequence_status,
      last_sequence: nextState.last_sequence,
      next_sequence: this.nextSequence(nextState.last_sequence),
    };
  }

  listEventsAfter(installationId: string, sequence: number): StoredEvent[] {
    return (this.eventsByInstallation.get(installationId) ?? [])
      .filter((stored) => stored.event.sequence > sequence)
      .sort((left, right) => left.event.sequence - right.event.sequence)
      .map((stored) => clone(stored));
  }

  listInstallationIds(): string[] {
    const ids = new Set<string>(this.installations.keys());
    for (const record of this.connections.values()) {
      if (record.installation_id) ids.add(record.installation_id);
    }
    for (const pairing of this.pairings.values()) {
      if (pairing.installation_id) ids.add(pairing.installation_id);
    }
    return [...ids].sort();
  }

  getInstallationState(installationId: string): InstallationState | undefined {
    const state = this.installations.get(installationId);
    return state ? clone(state) : undefined;
  }

  createPairing(now: string, ttlMs: number, input?: PairingCreateInput): PairingRecord {
    const createdAt = Date.parse(now);
    const pairingInput = normalizePairingInput(input);
    const record: PairingRecord = {
      pairing_id: randomUUID(),
      code: randomBytes(4).toString("hex").toUpperCase(),
      created_at: now,
      expires_at: new Date(createdAt + ttlMs).toISOString(),
      status: "pending",
      installation_id: pairingInput.installation_id,
      ws_url: pairingInput.ws_url,
      ...(pairingInput.relay_url ? { relay_url: pairingInput.relay_url } : {}),
      ...(pairingInput.public_url ? { public_url: pairingInput.public_url } : {}),
      collector_token_hash: pairingInput.collector_token_hash,
    };
    this.pairings.set(record.pairing_id, record);
    return clone(record);
  }

  getPairing(pairingId: string, now: string): PairingRecord | undefined {
    const record = this.pairings.get(pairingId);
    if (!record) return undefined;
    pairingStatus(record, now);
    return clone(record);
  }

  claimPairing(pairingId: string, code: string, now: string, deviceName?: string): boolean {
    const record = this.pairings.get(pairingId);
    if (!record) return false;
    pairingStatus(record, now);
    if (record.status !== "pending" || record.code !== code.trim().toUpperCase()) return false;
    record.status = "claimed";
    record.claimed_at = now;
    if (deviceName?.trim()) record.device_name = deviceName.trim();
    return true;
  }

  attachAndroidToken(
    pairingId: string,
    tokenHash: string,
    deviceName?: string,
    claimedAt?: string,
  ): PairingRecord | undefined {
    const record = this.pairings.get(pairingId);
    if (!record || record.status !== "claimed") return undefined;
    record.android_token_hash = tokenHash;
    if (deviceName?.trim()) record.device_name = deviceName.trim();
    if (claimedAt && !record.claimed_at) record.claimed_at = claimedAt;
    return clone(record);
  }

  createDeviceToken(input: CreateDeviceTokenInput): DeviceTokenRecord {
    const record: DeviceTokenRecord = {
      token_id: input.token_id ?? `tok_${randomUUID()}`,
      role: input.role,
      installation_id: input.installation_id,
      token_hash: hashOpaqueToken(input.token),
      issued_at: input.issued_at,
      ...(input.expires_at ? { expires_at: input.expires_at } : {}),
      ...(input.device_name?.trim() ? { device_name: input.device_name.trim() } : {}),
    };
    this.deviceTokens.set(record.token_id, record);
    return clone(record);
  }

  validateToken(token: string, role: TokenRole, now: string): TokenValidation | undefined {
    if (!token.trim()) return undefined;
    for (const record of this.deviceTokens.values()) {
      const result = tokenValidation(record, token, role, now);
      if (result) return result;
    }
    return undefined;
  }

  revokeToken(tokenId: string, revokedAt: string): boolean {
    const record = this.deviceTokens.get(tokenId);
    if (!record || record.revoked_at) return false;
    record.revoked_at = revokedAt;
    return true;
  }

  private sequenceStatus(sequence: number, previous: number | null): SequenceStatus {
    if (previous === null) return "initial";
    if (sequence === previous + 1) return "in_order";
    if (sequence > previous + 1) return "gap";
    return "out_of_order";
  }

  private sequenceStatusForDuplicate(
    event: EventEnvelope,
    current: InstallationState | undefined,
  ): SequenceStatus {
    return this.sequenceStatus(event.sequence, current?.last_sequence ?? null);
  }

  private nextSequence(lastSequence: number | null): number | null {
    return lastSequence === null ? null : lastSequence + 1;
  }

  private pruneEvents(): void {
    while (this.eventsById.size > this.maxStoredEvents) {
      const eventId = this.eventOrder.shift();
      if (!eventId) return;
      const stored = this.eventsById.get(eventId);
      if (!stored) continue;
      this.eventsById.delete(eventId);
      const installationEvents = this.eventsByInstallation.get(stored.event.installation_id);
      if (!installationEvents) continue;
      const index = installationEvents.findIndex(
        (candidate) => candidate.event.event_id === eventId,
      );
      if (index >= 0) installationEvents.splice(index, 1);
    }
  }
}

type SqlRow = Record<string, unknown>;

function stringValue(row: SqlRow, key: string): string | undefined {
  return typeof row[key] === "string" ? row[key] : undefined;
}

function numberValue(row: SqlRow, key: string): number | undefined {
  return typeof row[key] === "number" ? row[key] : undefined;
}

function optionalJson<T>(value: unknown): T | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/**
 * Synchronous SQLite repository using Node's built-in `node:sqlite` API. The
 * relay already serializes message handling, so synchronous statements keep
 * persistence atomic without adding an ORM or a native npm dependency.
 */
export class SqliteRelayRepository implements RelayRepository {
  readonly storageKind = "sqlite" as const;
  private readonly db: DatabaseSync;
  private readonly maxStoredEvents: number;
  private readonly connections = new Map<string, ConnectionRecord>();

  constructor(path: string, options: { maxStoredEvents?: number } = {}) {
    if (!path.trim()) throw new Error("SQLite database path must not be empty");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5_000 });
    this.maxStoredEvents = Math.max(1, options.maxStoredEvents ?? 10_000);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_connections (
        connection_id TEXT PRIMARY KEY,
        gateway TEXT NOT NULL,
        client_id TEXT NOT NULL,
        installation_id TEXT,
        status TEXT NOT NULL,
        connected_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        disconnected_at TEXT
      );
      CREATE TABLE IF NOT EXISTS relay_events (
        event_id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        UNIQUE (installation_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS relay_events_installation_sequence
        ON relay_events (installation_id, sequence);
      CREATE TABLE IF NOT EXISTS relay_installations (
        installation_id TEXT PRIMARY KEY,
        last_sequence INTEGER,
        claude_state TEXT NOT NULL,
        activity_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relay_pairings (
        pairing_id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        ws_url TEXT NOT NULL,
        relay_url TEXT,
        public_url TEXT,
        collector_token_hash TEXT NOT NULL,
        claimed_at TEXT,
        android_token_hash TEXT,
        device_name TEXT
      );
      CREATE INDEX IF NOT EXISTS relay_pairings_installation
        ON relay_pairings (installation_id);
      CREATE TABLE IF NOT EXISTS relay_device_tokens (
        token_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        issued_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        device_name TEXT
      );
      CREATE INDEX IF NOT EXISTS relay_device_tokens_lookup
        ON relay_device_tokens (role, token_hash);
    `);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  registerConnection(input: {
    connection_id: string;
    gateway: ConnectionRecord["gateway"];
    client_id: string;
    installation_id?: string;
    connected_at: string;
  }): ConnectionRecord {
    const record: ConnectionRecord = {
      ...input,
      status: "online",
      last_seen_at: input.connected_at,
    };
    this.connections.set(input.connection_id, record);
    return clone(record);
  }

  updateConnectionIdentity(
    connectionId: string,
    identity: { client_id?: string; installation_id?: string },
  ): ConnectionRecord | undefined {
    const record = this.connections.get(connectionId);
    if (!record || record.disconnected_at) return undefined;
    if (identity.client_id !== undefined && identity.client_id.trim() !== "") {
      record.client_id = identity.client_id.trim();
    }
    if (identity.installation_id !== undefined && identity.installation_id.trim() !== "") {
      record.installation_id = identity.installation_id.trim();
    }
    return clone(record);
  }

  touchConnection(connectionId: string, seenAt: string): ConnectionRecord | undefined {
    const record = this.connections.get(connectionId);
    if (!record || record.disconnected_at) return undefined;
    record.last_seen_at = seenAt;
    record.status = "online";
    return clone(record);
  }

  disconnectConnection(connectionId: string, disconnectedAt: string): ConnectionRecord | undefined {
    const record = this.connections.get(connectionId);
    if (!record) return undefined;
    record.status = "offline";
    record.disconnected_at = disconnectedAt;
    return clone(record);
  }

  getConnection(connectionId: string): ConnectionRecord | undefined {
    const record = this.connections.get(connectionId);
    return record ? clone(record) : undefined;
  }

  listConnections(): ConnectionRecord[] {
    return [...this.connections.values()].map((record) => clone(record));
  }

  refreshConnectionStatuses(
    now: string,
    staleAfterMs: number,
    offlineAfterMs: number,
  ): boolean {
    const nowMs = Date.parse(now);
    let changed = false;
    for (const record of this.connections.values()) {
      if (record.disconnected_at) continue;
      const elapsedMs = Math.max(0, nowMs - Date.parse(record.last_seen_at));
      const nextStatus: ConnectionStatus =
        elapsedMs >= offlineAfterMs
          ? "offline"
          : elapsedMs >= staleAfterMs
            ? "stale"
            : "online";
      if (!isConnectionStatus(nextStatus) || record.status === nextStatus) continue;
      record.status = nextStatus;
      changed = true;
    }
    return changed;
  }

  connectionStatusForInstallation(installationId: string): ConnectionStatus {
    const statuses = [...this.connections.values()]
      .filter(
        (record) =>
          record.gateway === "collector" && record.installation_id === installationId,
      )
      .map((record) => record.status);
    if (statuses.includes("online")) return "online";
    if (statuses.includes("stale")) return "stale";
    return "offline";
  }

  findEvent(eventId: string): StoredEvent | undefined {
    const row = this.db
      .prepare("SELECT event_json, received_at FROM relay_events WHERE event_id = ?")
      .get(eventId) as SqlRow | undefined;
    if (!row) return undefined;
    const event = optionalJson<EventEnvelope>(row.event_json);
    const receivedAt = stringValue(row, "received_at");
    return event && receivedAt ? { event: clone(event), received_at: receivedAt } : undefined;
  }

  recordEvent(event: EventEnvelope, receivedAt: string): RecordEventResult {
    const byId = this.findEvent(event.event_id);
    const bySequence = this.db
      .prepare(
        "SELECT event_json, received_at FROM relay_events WHERE installation_id = ? AND sequence = ?",
      )
      .get(event.installation_id, event.sequence) as SqlRow | undefined;
    const existing = byId ?? this.rowToStoredEvent(bySequence);
    const current = this.getInstallationState(event.installation_id);
    if (existing) {
      return {
        stored: clone(existing),
        duplicate: true,
        sequence_status: this.sequenceStatusForDuplicate(existing.event, current),
        last_sequence: current?.last_sequence ?? existing.event.sequence,
        next_sequence: current ? this.nextSequence(current.last_sequence) : existing.event.sequence + 1,
      };
    }

    const previousSequence = current?.last_sequence ?? null;
    const sequence_status = this.sequenceStatus(event.sequence, previousSequence);
    const stored: StoredEvent = { event: clone(event), received_at: receivedAt };
    const nextState: InstallationState =
      current && previousSequence !== null && event.sequence < previousSequence
        ? current
        : {
            installation_id: event.installation_id,
            last_sequence:
              previousSequence === null
                ? event.sequence
                : Math.max(previousSequence, event.sequence),
            claude_state: stateForEvent(event.event_type, current?.claude_state ?? "idle"),
            activity: {
              event_type: event.event_type,
              session_id: event.session_id,
              ...(event.task_id ? { task_id: event.task_id } : {}),
              occurred_at: event.occurred_at,
            },
            updated_at: event.occurred_at,
          };

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO relay_events (event_id, installation_id, sequence, event_json, received_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          event.event_id,
          event.installation_id,
          event.sequence,
          JSON.stringify(event),
          receivedAt,
        );
      this.db
        .prepare(
          `INSERT INTO relay_installations (installation_id, last_sequence, claude_state, activity_json, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(installation_id) DO UPDATE SET
             last_sequence = excluded.last_sequence,
             claude_state = excluded.claude_state,
             activity_json = excluded.activity_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          nextState.installation_id,
          nextState.last_sequence,
          nextState.claude_state,
          nextState.activity ? JSON.stringify(nextState.activity) : null,
          nextState.updated_at,
        );
      this.pruneEvents();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      stored: clone(stored),
      duplicate: false,
      sequence_status,
      last_sequence: nextState.last_sequence,
      next_sequence: this.nextSequence(nextState.last_sequence),
    };
  }

  listEventsAfter(installationId: string, sequence: number): StoredEvent[] {
    const rows = this.db
      .prepare(
        "SELECT event_json, received_at FROM relay_events WHERE installation_id = ? AND sequence > ? ORDER BY sequence ASC",
      )
      .all(installationId, sequence) as SqlRow[];
    return rows
      .map((row) => this.rowToStoredEvent(row))
      .filter((stored): stored is StoredEvent => stored !== undefined)
      .map((stored) => clone(stored));
  }

  listInstallationIds(): string[] {
    const ids = new Set<string>();
    const rows = this.db
      .prepare(
        `SELECT installation_id FROM relay_installations
         UNION SELECT installation_id FROM relay_pairings
         UNION SELECT installation_id FROM relay_device_tokens`,
      )
      .all() as SqlRow[];
    for (const row of rows) {
      const id = stringValue(row, "installation_id");
      if (id) ids.add(id);
    }
    for (const record of this.connections.values()) {
      if (record.installation_id) ids.add(record.installation_id);
    }
    return [...ids].sort();
  }

  getInstallationState(installationId: string): InstallationState | undefined {
    const row = this.db
      .prepare("SELECT * FROM relay_installations WHERE installation_id = ?")
      .get(installationId) as SqlRow | undefined;
    if (!row) return undefined;
    const lastSequence = row.last_sequence === null ? null : numberValue(row, "last_sequence");
    const claudeState = stringValue(row, "claude_state");
    const updatedAt = stringValue(row, "updated_at");
    if (
      lastSequence === undefined ||
      !claudeState ||
      !updatedAt ||
      !["idle", "working", "waiting"].includes(claudeState)
    ) {
      return undefined;
    }
    return {
      installation_id: installationId,
      last_sequence: lastSequence,
      claude_state: claudeState as ClaudeState,
      ...(optionalJson<InstallationState["activity"]>(row.activity_json)
        ? { activity: optionalJson<InstallationState["activity"]>(row.activity_json) }
        : {}),
      updated_at: updatedAt,
    };
  }

  createPairing(now: string, ttlMs: number, input?: PairingCreateInput): PairingRecord {
    const createdAt = Date.parse(now);
    const pairingInput = normalizePairingInput(input);
    const record: PairingRecord = {
      pairing_id: randomUUID(),
      code: randomBytes(4).toString("hex").toUpperCase(),
      created_at: now,
      expires_at: new Date(createdAt + ttlMs).toISOString(),
      status: "pending",
      installation_id: pairingInput.installation_id,
      ws_url: pairingInput.ws_url,
      ...(pairingInput.relay_url ? { relay_url: pairingInput.relay_url } : {}),
      ...(pairingInput.public_url ? { public_url: pairingInput.public_url } : {}),
      collector_token_hash: pairingInput.collector_token_hash,
    };
    this.db
      .prepare(
        `INSERT INTO relay_pairings
          (pairing_id, code, created_at, expires_at, status, installation_id, ws_url, relay_url, public_url, collector_token_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.pairing_id,
        record.code,
        record.created_at,
        record.expires_at,
        record.status,
        record.installation_id,
        record.ws_url,
        record.relay_url ?? null,
        record.public_url ?? null,
        record.collector_token_hash,
      );
    return clone(record);
  }

  getPairing(pairingId: string, now: string): PairingRecord | undefined {
    const row = this.db.prepare("SELECT * FROM relay_pairings WHERE pairing_id = ?").get(pairingId) as
      | SqlRow
      | undefined;
    const record = this.rowToPairing(row);
    if (!record) return undefined;
    const updated = pairingStatus(record, now);
    if (updated.status !== (stringValue(row ?? {}, "status") ?? "")) {
      this.db
        .prepare("UPDATE relay_pairings SET status = ? WHERE pairing_id = ?")
        .run(updated.status, pairingId);
    }
    return clone(updated);
  }

  claimPairing(pairingId: string, code: string, now: string, deviceName?: string): boolean {
    const record = this.getPairing(pairingId, now);
    if (!record || record.status !== "pending" || record.code !== code.trim().toUpperCase()) {
      return false;
    }
    const result = this.db
      .prepare(
        `UPDATE relay_pairings SET status = 'claimed', claimed_at = ?, device_name = ?
         WHERE pairing_id = ? AND status = 'pending' AND code = ? AND expires_at > ?`,
      )
      .run(now, deviceName?.trim() || null, pairingId, code.trim().toUpperCase(), now);
    return result.changes === 1;
  }

  attachAndroidToken(
    pairingId: string,
    tokenHash: string,
    deviceName?: string,
    claimedAt?: string,
  ): PairingRecord | undefined {
    const result = this.db
      .prepare(
        `UPDATE relay_pairings SET android_token_hash = ?, device_name = COALESCE(?, device_name),
         claimed_at = COALESCE(claimed_at, ?)
         WHERE pairing_id = ? AND status = 'claimed'`,
      )
      .run(tokenHash, deviceName?.trim() || null, claimedAt ?? null, pairingId);
    if (result.changes !== 1) return undefined;
    return this.getPairing(pairingId, claimedAt ?? new Date().toISOString());
  }

  createDeviceToken(input: CreateDeviceTokenInput): DeviceTokenRecord {
    const record: DeviceTokenRecord = {
      token_id: input.token_id ?? `tok_${randomUUID()}`,
      role: input.role,
      installation_id: input.installation_id,
      token_hash: hashOpaqueToken(input.token),
      issued_at: input.issued_at,
      ...(input.expires_at ? { expires_at: input.expires_at } : {}),
      ...(input.device_name?.trim() ? { device_name: input.device_name.trim() } : {}),
    };
    this.db
      .prepare(
        `INSERT INTO relay_device_tokens
          (token_id, role, installation_id, token_hash, issued_at, expires_at, device_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.token_id,
        record.role,
        record.installation_id,
        record.token_hash,
        record.issued_at,
        record.expires_at ?? null,
        record.device_name ?? null,
      );
    return clone(record);
  }

  validateToken(token: string, role: TokenRole, now: string): TokenValidation | undefined {
    if (!token.trim()) return undefined;
    const tokenHash = hashOpaqueToken(token);
    const row = this.db
      .prepare(
        `SELECT token_id, role, installation_id, token_hash, expires_at, revoked_at, device_name
         FROM relay_device_tokens WHERE role = ? AND token_hash = ?`,
      )
      .get(role, tokenHash) as SqlRow | undefined;
    if (!row) return undefined;
    const tokenId = stringValue(row, "token_id");
    const installationId = stringValue(row, "installation_id");
    const storedHash = stringValue(row, "token_hash");
    const revokedAt = stringValue(row, "revoked_at");
    const expiresAt = stringValue(row, "expires_at");
    if (!tokenId || !installationId || !storedHash || revokedAt) return undefined;
    if (expiresAt && Date.parse(expiresAt) <= Date.parse(now)) return undefined;
    if (!opaqueTokenMatches(token, storedHash)) return undefined;
    const deviceName = stringValue(row, "device_name");
    return {
      token_id: tokenId,
      role,
      installation_id: installationId,
      ...(deviceName ? { device_name: deviceName } : {}),
    };
  }

  revokeToken(tokenId: string, revokedAt: string): boolean {
    const result = this.db
      .prepare("UPDATE relay_device_tokens SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL")
      .run(revokedAt, tokenId);
    return result.changes === 1;
  }

  private rowToStoredEvent(row: SqlRow | undefined): StoredEvent | undefined {
    if (!row) return undefined;
    const event = optionalJson<EventEnvelope>(row.event_json);
    const receivedAt = stringValue(row, "received_at");
    return event && receivedAt ? { event, received_at: receivedAt } : undefined;
  }

  private rowToPairing(row: SqlRow | undefined): PairingRecord | undefined {
    if (!row) return undefined;
    const pairingId = stringValue(row, "pairing_id");
    const code = stringValue(row, "code");
    const createdAt = stringValue(row, "created_at");
    const expiresAt = stringValue(row, "expires_at");
    const status = stringValue(row, "status");
    const installationId = stringValue(row, "installation_id");
    const wsUrl = stringValue(row, "ws_url");
    const collectorTokenHash = stringValue(row, "collector_token_hash");
    if (
      !pairingId ||
      !code ||
      !createdAt ||
      !expiresAt ||
      !installationId ||
      !wsUrl ||
      !collectorTokenHash ||
      !["pending", "claimed", "expired"].includes(status ?? "")
    ) {
      return undefined;
    }
    const relayUrl = stringValue(row, "relay_url");
    const publicUrl = stringValue(row, "public_url");
    const claimedAt = stringValue(row, "claimed_at");
    const androidTokenHash = stringValue(row, "android_token_hash");
    const deviceName = stringValue(row, "device_name");
    return {
      pairing_id: pairingId,
      code,
      created_at: createdAt,
      expires_at: expiresAt,
      status: status as PairingRecord["status"],
      installation_id: installationId,
      ws_url: wsUrl,
      ...(relayUrl ? { relay_url: relayUrl } : {}),
      ...(publicUrl ? { public_url: publicUrl } : {}),
      collector_token_hash: collectorTokenHash,
      ...(claimedAt ? { claimed_at: claimedAt } : {}),
      ...(androidTokenHash ? { android_token_hash: androidTokenHash } : {}),
      ...(deviceName ? { device_name: deviceName } : {}),
    };
  }

  private sequenceStatus(sequence: number, previous: number | null): SequenceStatus {
    if (previous === null) return "initial";
    if (sequence === previous + 1) return "in_order";
    if (sequence > previous + 1) return "gap";
    return "out_of_order";
  }

  private sequenceStatusForDuplicate(
    event: EventEnvelope,
    current: InstallationState | undefined,
  ): SequenceStatus {
    return this.sequenceStatus(event.sequence, current?.last_sequence ?? null);
  }

  private nextSequence(lastSequence: number | null): number | null {
    return lastSequence === null ? null : lastSequence + 1;
  }

  private pruneEvents(): void {
    const countRow = this.db.prepare("SELECT COUNT(*) AS count FROM relay_events").get() as SqlRow;
    const count = numberValue(countRow, "count") ?? 0;
    if (count <= this.maxStoredEvents) return;
    this.db
      .prepare(
        `DELETE FROM relay_events WHERE event_id IN (
          SELECT event_id FROM relay_events ORDER BY rowid ASC LIMIT ?
        )`,
      )
      .run(count - this.maxStoredEvents);
  }
}

export function createRelayRepository(
  databasePath: string | undefined,
  options: { maxStoredEvents?: number } = {},
): RelayRepository {
  return databasePath
    ? new SqliteRelayRepository(databasePath, options)
    : new InMemoryRelayRepository(options);
}
