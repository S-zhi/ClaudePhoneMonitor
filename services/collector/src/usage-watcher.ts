import { constants, mkdirSync, lstatSync, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LocalSequence } from "./sequence.js";
import { eventId } from "./sequence.js";
import type { Outbox, RelayOutboundMessage, UsageAggregate, UsageSnapshotMessage } from "./types.js";

const MAX_FILES = 2_048;
const MAX_BYTES_PER_POLL = 16 * 1024 * 1024;
const MAX_BYTES_PER_FILE = 512 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const POLL_MS = 1_000;
const PROVIDERS = ["claude", "codex"] as const;
type Provider = (typeof PROVIDERS)[number];
type UsageNumbers = { input: number | null; cached: number | null; cacheCreation: number | null; output: number | null };
type FileInfo = { provider: Provider; filePath: string; pathHash: string; dev: number; ino: number; size: number; mtimeMs: number; discardBaselineLine?: boolean; tailHash?: string };
type FileCursor = { offset: number; discardBaselineLine: boolean; discardingOversize: boolean; tailHash: string };
type FileUpdate = FileInfo & FileCursor;
type ParsedResponse = { provider: Provider; identityHash: string; values: UsageNumbers; complete: boolean; timestamp: string; sourceOffset: number; sourcePathHash: string };

export interface UsageWatcherDiagnostics {
  files_seen: number;
  rows_seen: number;
  responses_seen: number;
  malformed_rows: number;
  oversized_rows: number;
  stale_rows: number;
  unsafe_identity_rows: number;
  source_errors: number;
  emit_errors: number;
  conflicts: number;
  numeric_overflows: number;
  codes: string[];
}

export interface UsageWatcherOptions {
  claudeProjectsRoot: string;
  codexSessionsRoot: string;
  databaseFile: string;
  installationId: string;
  sequence: Pick<LocalSequence, "next">;
  outbox: Pick<Outbox<RelayOutboundMessage>, "enqueue">;
  emit?: (message: UsageSnapshotMessage) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  maxFiles?: number;
  maxBytesPerPoll?: number;
  maxBytesPerFile?: number;
  maxLineBytes?: number;
}

export interface UsageWatcherHandle {
  stop(): Promise<void>;
  getSnapshot(): UsageAggregate;
  getDiagnostics(): Readonly<UsageWatcherDiagnostics>;
}

export class UsageWatcherStartError extends Error {
  public readonly code = "usage_watch_start_failed";
  public constructor() { super("Usage watcher could not initialize private local storage."); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function sha(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function safeIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(value);
}
function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64 || !/^\d{4}-\d\d-\d\dT/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}
function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function emptyNumbers(): UsageNumbers { return { input: null, cached: null, cacheCreation: null, output: null }; }
function rowString(row: Record<string, unknown>, key: string): string | undefined { return typeof row[key] === "string" ? row[key] as string : undefined; }
function changedNumber(oldValue: number | null, nextValue: number | null): boolean {
  return oldValue !== null && nextValue !== null && nextValue < oldValue;
}

interface StoredResponse {
  provider: Provider;
  values_json: string;
  complete: number;
  conflicted: number;
  source_timestamp: string;
  source_path_hash: string;
  source_offset: number;
}

/** Private SQLite response ledger and source cursor store. Raw source rows are never persisted. */
class UsageStore {
  readonly db: DatabaseSync;
  private startedAt = "";
  private epochId = "";
  lastNumericOverflows = 0;

  constructor(private readonly databaseFile: string) {
    mkdirSync(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
    try {
      if (lstatSync(databaseFile).isSymbolicLink()) throw new Error("unsafe_usage_database");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.db = new DatabaseSync(databaseFile);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_files (
        provider TEXT NOT NULL, path_hash TEXT NOT NULL, dev INTEGER NOT NULL, ino INTEGER NOT NULL,
        offset INTEGER NOT NULL, discard_baseline_line INTEGER NOT NULL DEFAULT 0,
        discarding_oversize INTEGER NOT NULL DEFAULT 0, tail_hash TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(provider, path_hash, dev, ino)
      );
      CREATE TABLE IF NOT EXISTS usage_responses (
        identity_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, values_json TEXT NOT NULL,
        complete INTEGER NOT NULL, conflicted INTEGER NOT NULL,
        source_timestamp TEXT NOT NULL, source_path_hash TEXT NOT NULL, source_offset INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_provider_health (
        provider TEXT PRIMARY KEY, status TEXT NOT NULL
      );
    `);
  }

  get epoch(): { epochId: string; startedAt: string } {
    return { epochId: this.epochId, startedAt: this.startedAt };
  }

  initialize(nowMs: number, inventory: readonly FileInfo[], providerStatus: Readonly<Record<Provider, "ready" | "partial" | "unavailable">>): void {
    const epoch = this.db.prepare("SELECT value FROM usage_meta WHERE key='epoch_id'").get() as { value: string } | undefined;
    if (epoch) {
      this.epochId = epoch.value;
      this.startedAt = (this.db.prepare("SELECT value FROM usage_meta WHERE key='started_at'").get() as { value: string }).value;
      this.db.prepare("INSERT OR IGNORE INTO usage_meta(key,value) VALUES('dirty','1')").run();
      this.db.prepare("UPDATE usage_meta SET value='1' WHERE key='dirty'").run();
      return;
    }
    const epochId = randomUUID();
    const startedAt = new Date(nowMs).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const putMeta = this.db.prepare("INSERT INTO usage_meta(key,value) VALUES(?,?)");
      putMeta.run("epoch_id", epochId);
      putMeta.run("started_at", startedAt);
      putMeta.run("revision", "0");
      putMeta.run("dirty", "1");
      const insertFile = this.db.prepare(`INSERT OR IGNORE INTO usage_files
        (provider,path_hash,dev,ino,offset,discard_baseline_line,discarding_oversize,tail_hash) VALUES(?,?,?,?,?,?,0,?)`);
      for (const file of inventory) {
        insertFile.run(file.provider, file.pathHash, file.dev, file.ino, file.size, file.discardBaselineLine ? 1 : 0, file.tailHash ?? "");
      }
      for (const provider of PROVIDERS) {
        this.db.prepare("INSERT INTO usage_provider_health(provider,status) VALUES(?,?)")
          .run(provider, providerStatus[provider]);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.epochId = epochId;
    this.startedAt = startedAt;
  }

  cursor(file: FileInfo): FileCursor | undefined {
    const row = this.db.prepare(`SELECT offset,discard_baseline_line,discarding_oversize,tail_hash FROM usage_files
      WHERE provider=? AND path_hash=? AND dev=? AND ino=?`).get(file.provider, file.pathHash, file.dev, file.ino) as { offset: number; discard_baseline_line: number; discarding_oversize: number; tail_hash: string } | undefined;
    return row ? { offset: row.offset, discardBaselineLine: row.discard_baseline_line === 1, discardingOversize: row.discarding_oversize === 1, tailHash: row.tail_hash } : undefined;
  }

  beginPoll(): void { this.db.exec("BEGIN IMMEDIATE"); }
  rollbackPoll(): void { this.db.exec("ROLLBACK"); }

  enrollFile(file: FileInfo): FileCursor {
    this.db.prepare(`INSERT OR IGNORE INTO usage_files
      (provider,path_hash,dev,ino,offset,discard_baseline_line,discarding_oversize,tail_hash) VALUES(?,?,?, ?,0,0,0,?)`)
      .run(file.provider, file.pathHash, file.dev, file.ino, sha(""));
    return this.cursor(file) ?? { offset: 0, discardBaselineLine: false, discardingOversize: false, tailHash: sha("") };
  }

  saveCursor(file: FileUpdate): void {
    this.db.prepare(`UPDATE usage_files SET offset=?,discard_baseline_line=?,discarding_oversize=?,tail_hash=?
      WHERE provider=? AND path_hash=? AND dev=? AND ino=?`).run(
      file.offset, file.discardBaselineLine ? 1 : 0, file.discardingOversize ? 1 : 0, file.tailHash ?? sha(""),
      file.provider, file.pathHash, file.dev, file.ino,
    );
  }

  markProvider(provider: Provider, status: "ready" | "partial" | "unavailable"): void {
    const current = this.db.prepare("SELECT status FROM usage_provider_health WHERE provider=?").get(provider) as { status: string } | undefined;
    let next = status;
    // Once a provider is observed unavailable/partial, retain the coverage gap for this epoch.
    if (current?.status === "partial" || current?.status === "unavailable" && status === "ready") next = current.status === "unavailable" ? "partial" : "partial";
    this.db.prepare(`INSERT INTO usage_provider_health(provider,status) VALUES(?,?)
      ON CONFLICT(provider) DO UPDATE SET status=excluded.status`).run(provider, next);
  }

  providerStatus(provider: Provider): "ready" | "partial" | "unavailable" {
    const row = this.db.prepare("SELECT status FROM usage_provider_health WHERE provider=?").get(provider) as { status: string } | undefined;
    if (row?.status === "ready" || row?.status === "partial") return row.status;
    return "unavailable";
  }

  upsertResponse(response: ParsedResponse): "inserted" | "updated" | "duplicate" | "conflict" | "stale" {
    const existing = this.db.prepare(`SELECT provider,values_json,complete,conflicted,source_timestamp,source_path_hash,source_offset
      FROM usage_responses WHERE identity_hash=?`).get(response.identityHash) as StoredResponse | undefined;
    if (!existing) {
      this.db.prepare(`INSERT INTO usage_responses(identity_hash,provider,values_json,complete,conflicted,source_timestamp,source_path_hash,source_offset)
        VALUES(?,?,?,?,0,?,?,?)`).run(response.identityHash, response.provider, JSON.stringify(response.values), response.complete ? 1 : 0, response.timestamp, response.sourcePathHash, response.sourceOffset);
      return "inserted";
    }
    const previous = JSON.parse(existing.values_json) as UsageNumbers;
    const tsOrder = Date.parse(response.timestamp) - Date.parse(existing.source_timestamp);
    const sameValues = JSON.stringify(previous) === JSON.stringify(response.values);
    const sameSource = existing.source_path_hash === response.sourcePathHash;
    if (tsOrder < 0 || sameSource && response.sourceOffset < existing.source_offset) return "stale";
    if (sameValues && existing.conflicted === 0) {
      if (tsOrder > 0 || sameSource && response.sourceOffset > existing.source_offset) {
        this.db.prepare("UPDATE usage_responses SET source_timestamp=?,source_path_hash=?,source_offset=? WHERE identity_hash=?")
          .run(response.timestamp, response.sourcePathHash, response.sourceOffset, response.identityHash);
        return "updated";
      }
      return "duplicate";
    }
    if (!sameSource && tsOrder === 0) {
      this.db.prepare("UPDATE usage_responses SET conflicted=1 WHERE identity_hash=?").run(response.identityHash);
      return "conflict";
    }
    const hasRegression = (Object.keys(previous) as (keyof UsageNumbers)[]).some((key) => changedNumber(previous[key], response.values[key]));
    if (hasRegression) {
      this.db.prepare("UPDATE usage_responses SET conflicted=1 WHERE identity_hash=?").run(response.identityHash);
      return "conflict";
    }
    // Missing fields in a later partial update do not erase known components.
    const merged: UsageNumbers = { ...previous };
    for (const key of Object.keys(merged) as (keyof UsageNumbers)[]) {
      if (response.values[key] !== null) merged[key] = response.values[key];
    }
    const complete = existing.complete === 1 || response.complete;
    this.db.prepare(`UPDATE usage_responses SET values_json=?,complete=?,conflicted=0,source_timestamp=?,source_path_hash=?,source_offset=?
      WHERE identity_hash=?`).run(JSON.stringify(merged), complete ? 1 : 0, response.timestamp, response.sourcePathHash, response.sourceOffset, response.identityHash);
    return "updated";
  }

  commitPoll(): UsageAggregate {
    const responses = this.db.prepare("SELECT provider,values_json,complete,conflicted FROM usage_responses").all() as Array<{ provider: Provider; values_json: string; complete: number; conflicted: number }>;
    const counts = Object.fromEntries(PROVIDERS.map((provider) => {
      const rows = responses.filter((row) => row.provider === provider);
      return [provider, { observed_responses: rows.length, complete_responses: rows.filter((row) => row.complete === 1 && row.conflicted === 0).length }];
    })) as Record<Provider, { observed_responses: number; complete_responses: number }>;
    const baseStatus = Object.fromEntries(PROVIDERS.map((provider) => {
      const hasIncomplete = responses.some((row) => row.provider === provider && (row.complete !== 1 || row.conflicted === 1));
      const stored = this.providerStatus(provider);
      return [provider, hasIncomplete && stored === "ready" ? "partial" : stored];
    })) as Record<Provider, "ready" | "partial" | "unavailable">;
    const parsed = responses.map((row) => ({ ...row, values: JSON.parse(row.values_json) as UsageNumbers }));
    const overflowProviders = new Set<Provider>();
    const overflowedMetrics = new Set<string>();
    this.lastNumericOverflows = 0;
    const metric = (which: "new_input" | "cached_input" | "output" | "total_input" | "actual"): UsageAggregate["new_input"] => {
      let sum = 0; let anyKnown = false; let partial = false;
      for (const row of parsed) {
        if (row.conflicted === 1) { partial = true; continue; }
        const v = row.values;
        let components: Array<number | null>;
        switch (which) {
          case "new_input": components = row.provider === "claude" ? [v.input, v.cacheCreation] : [v.input !== null && v.cached !== null ? v.input - v.cached : null]; break;
          case "cached_input": components = [v.cached]; break;
          case "output": components = [v.output]; break;
          case "total_input": components = row.provider === "claude" ? [v.input, v.cacheCreation, v.cached] : [v.input]; break;
          case "actual": components = row.provider === "claude" ? [v.input, v.cacheCreation, v.output] : [v.input !== null && v.cached !== null ? v.input - v.cached : null, v.output]; break;
        }
        const known = components.filter((x): x is number => x !== null);
        if (known.length !== components.length || row.complete !== 1) partial = true;
        const contribution = known.reduce((a, b) => a + b, 0);
        if (known.length > 0 && !Number.isSafeInteger(contribution)) {
          partial = true; overflowProviders.add(row.provider); overflowedMetrics.add(which); this.lastNumericOverflows += 1; continue;
        }
        if (known.length) anyKnown = true;
        if (!Number.isSafeInteger(sum + contribution)) { partial = true; overflowProviders.add(row.provider); overflowedMetrics.add(which); this.lastNumericOverflows += 1; continue; }
        sum += contribution;
      }
      const allReady = baseStatus.claude === "ready" && baseStatus.codex === "ready";
      const quality = allReady && !partial ? "complete" : anyKnown ? "partial" : "unavailable";
      return { value: quality === "unavailable" ? null : sum, quality };
    };
    const new_input = metric("new_input");
    const cached_input = metric("cached_input");
    const output = metric("output");
    const actual = metric("actual");
    const total_input = metric("total_input");
    for (const provider of overflowProviders) baseStatus[provider] = "partial";
    const provider_coverage = Object.fromEntries(PROVIDERS.map((provider) => [provider, { status: baseStatus[provider], ...counts[provider] }])) as UsageAggregate["provider_coverage"];
    const adjustQuality = (metricValue: UsageAggregate["new_input"]): UsageAggregate["new_input"] =>
      metricValue.quality === "complete" && overflowProviders.size > 0
        ? { value: metricValue.value, quality: "partial" }
        : metricValue;
    const adjustedNew = adjustQuality(new_input);
    const adjustedCached = adjustQuality(cached_input);
    const adjustedOutput = adjustQuality(output);
    const adjustedActual = adjustQuality(actual);
    const adjustedTotal = adjustQuality(total_input);
    const cacheComplete = provider_coverage.claude.status === "ready" && provider_coverage.codex.status === "ready" && adjustedNew.quality === "complete" && adjustedCached.quality === "complete" && adjustedTotal.quality === "complete" && adjustedTotal.value !== null && adjustedTotal.value > 0;
    const zeroDenominator = adjustedTotal.value === 0;
    const cacheOverflow = overflowedMetrics.has("cached_input") || overflowedMetrics.has("total_input");
    const knownNumerator = zeroDenominator || cacheOverflow ? null : adjustedCached.value;
    const knownDenominator = zeroDenominator || cacheOverflow ? null : adjustedTotal.value;
    const cache_hit = {
      numerator: knownNumerator,
      denominator: knownDenominator,
      quality: cacheComplete ? "complete" as const : knownNumerator === null && knownDenominator === null ? "unavailable" as const : "partial" as const,
    };
    const observed_responses = counts.claude.observed_responses + counts.codex.observed_responses;
    const complete_responses = counts.claude.complete_responses + counts.codex.complete_responses;
    const currentRevision = Number((this.db.prepare("SELECT value FROM usage_meta WHERE key='revision'").get() as { value: string } | undefined)?.value ?? 0);
    const aggregateBase = {
      epoch_id: this.epochId,
      started_at: this.startedAt,
      observed_responses,
      complete_responses,
      provider_coverage,
      new_input: adjustedNew,
      cached_input: adjustedCached,
      output: adjustedOutput,
      actual: adjustedActual,
      total_input: adjustedTotal,
      cache_hit,
      quota: { start_remaining: null, current_remaining: null, unit: null, reset_at: null, availability: "unavailable" as const },
    };
    const priorFingerprint = (this.db.prepare("SELECT value FROM usage_meta WHERE key='aggregate_fingerprint'").get() as { value: string } | undefined)?.value;
    const fingerprint = JSON.stringify(aggregateBase);
    const revision = priorFingerprint === fingerprint ? currentRevision : currentRevision + 1;
    if (revision !== currentRevision) {
      this.db.prepare("INSERT INTO usage_meta(key,value) VALUES('revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(revision));
      this.db.prepare("INSERT INTO usage_meta(key,value) VALUES('aggregate_fingerprint',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(fingerprint);
      this.db.prepare("UPDATE usage_meta SET value='1' WHERE key='dirty'").run();
    }
    this.db.exec("COMMIT");
    return { ...aggregateBase, revision };
  }

  isDirty(): boolean { return (this.db.prepare("SELECT value FROM usage_meta WHERE key='dirty'").get() as { value: string } | undefined)?.value === "1"; }
  pendingMessage(): UsageSnapshotMessage | undefined {
    const row = this.db.prepare("SELECT value FROM usage_meta WHERE key='pending_message'").get() as { value: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.value) as UsageSnapshotMessage; } catch { return undefined; }
  }
  savePendingMessage(message: UsageSnapshotMessage): void {
    this.db.prepare("INSERT INTO usage_meta(key,value) VALUES('pending_message',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify(message));
  }
  markPublished(publishedRevision: number): void {
    const currentRevision = Number((this.db.prepare("SELECT value FROM usage_meta WHERE key='revision'").get() as { value: string } | undefined)?.value ?? 0);
    this.db.prepare("DELETE FROM usage_meta WHERE key='pending_message'").run();
    this.db.prepare("UPDATE usage_meta SET value=? WHERE key='dirty'").run(publishedRevision === currentRevision ? "0" : "1");
  }
  dirtyOnStartup(): void { this.db.prepare("UPDATE usage_meta SET value='1' WHERE key='dirty'").run(); }
  close(): void { this.db.close(); }
}

/** Bounded, read-only incremental scanner for local Claude and Codex usage transcripts. */
export class UsageWatcher {
  private readonly store: UsageStore;
  private readonly now: () => number;
  private readonly diagnostics: UsageWatcherDiagnostics = {
    files_seen: 0, rows_seen: 0, responses_seen: 0, malformed_rows: 0, oversized_rows: 0,
    stale_rows: 0, unsafe_identity_rows: 0, source_errors: 0, emit_errors: 0, conflicts: 0, numeric_overflows: 0, codes: [],
  };
  private readonly codeSet = new Set<string>();
  private snapshot: UsageAggregate | undefined;
  private running = false;
  private timer?: NodeJS.Timeout;
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly options: UsageWatcherOptions) {
    this.now = options.now ?? Date.now;
    this.store = new UsageStore(options.databaseFile);
  }

  async start(): Promise<UsageWatcherHandle> {
    if (this.running) return this.handle();
    try {
      const inventories: FileInfo[] = [];
      const initialStatus = {} as Record<Provider, "ready" | "partial" | "unavailable">;
      for (const provider of PROVIDERS) {
        const root = this.rootFor(provider);
        const result = await this.listFiles(provider, root);
        initialStatus[provider] = !result.accessible ? "unavailable" : result.limited ? "partial" : "ready";
        inventories.push(...await Promise.all(result.files.map((f) => this.markInitialBoundary(f))));
      }
      this.store.initialize(this.now(), inventories, initialStatus);
      await fs.chmod(this.options.databaseFile, 0o600).catch(() => undefined);
      this.store.dirtyOnStartup();
      this.running = true;
      await this.pollOnce();
      this.schedule();
      return this.handle();
    } catch {
      this.store.close();
      throw new UsageWatcherStartError();
    }
  }

  private handle(): UsageWatcherHandle {
    return { stop: () => this.stop(), getSnapshot: () => this.getSnapshot(), getDiagnostics: () => this.getDiagnostics() };
  }

  getSnapshot(): UsageAggregate {
    if (!this.snapshot) throw new Error("usage_snapshot_not_ready");
    return structuredClone(this.snapshot);
  }

  getDiagnostics(): Readonly<UsageWatcherDiagnostics> {
    return { ...this.diagnostics, codes: [...this.codeSet] };
  }

  pollOnce(): Promise<void> {
    const next = this.operation.then(() => this.pollUnlocked());
    this.operation = next.catch(() => undefined);
    return next;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.operation;
    this.store.close();
  }

  private rootFor(provider: Provider): string {
    return provider === "claude" ? this.options.claudeProjectsRoot : this.options.codexSessionsRoot;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.pollOnce().catch(() => undefined).finally(() => this.schedule());
    }, Math.max(100, this.options.pollIntervalMs ?? POLL_MS));
    this.timer.unref?.();
  }

  private addCode(code: string): void { this.codeSet.add(code); this.diagnostics.codes = [...this.codeSet]; }

  private async markInitialBoundary(file: FileInfo): Promise<FileInfo> {
    if (file.size <= 0) return { ...file, discardBaselineLine: false, tailHash: sha("") };
    try {
      const h = await fs.open(file.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const length = Math.min(256, file.size);
        const b = Buffer.alloc(length);
        await h.read(b, 0, length, file.size - length);
        const last = b[b.length - 1];
        return { ...file, discardBaselineLine: last !== 0x0a, tailHash: sha(b) };
      } finally { await h.close(); }
    } catch { this.diagnostics.source_errors += 1; this.addCode("usage_source_boundary_unavailable"); return { ...file, discardBaselineLine: false, tailHash: "" }; }
  }

  private async listFiles(provider: Provider, root: string): Promise<{ files: FileInfo[]; accessible: boolean; limited: boolean }> {
    const files: FileInfo[] = [];
    let accessible = true;
    let limited = false;
    try {
      const stat = await fs.lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        this.addCode(`usage_${provider}_source_unavailable`);
        return { files, accessible: false, limited: false };
      }
    } catch (error) {
      this.addCode(`usage_${provider}_source_unavailable`);
      return { files, accessible: false, limited: false };
    }
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 8 || files.length >= (this.options.maxFiles ?? MAX_FILES)) {
        limited = true;
        this.addCode(`usage_${provider}_file_scan_limited`);
        return;
      }
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch { limited = true; this.diagnostics.source_errors += 1; this.addCode(`usage_${provider}_source_read_failed`); return; }
      for (const entry of entries) {
        if (files.length >= (this.options.maxFiles ?? MAX_FILES)) {
          limited = true;
          this.addCode(`usage_${provider}_file_scan_limited`);
          break;
        }
        if (entry.isSymbolicLink()) {
          limited = true;
          this.addCode(`usage_${provider}_symlink_skipped`);
          continue;
        }
        const p = path.join(directory, entry.name);
        if (entry.isDirectory()) { await visit(p, depth + 1); continue; }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        if (provider === "codex" && !entry.name.startsWith("rollout-")) continue;
        try {
          const st = await fs.lstat(p);
          if (!st.isFile() || st.isSymbolicLink()) continue;
          const relative = path.relative(root, p).split(path.sep).join("/");
          files.push({ provider, filePath: p, pathHash: sha(`${provider}\0${relative}`), dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs });
        } catch { limited = true; this.diagnostics.source_errors += 1; this.addCode(`usage_${provider}_source_read_failed`); }
      }
    };
    await visit(root, 0);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { files, accessible, limited };
  }

  private async readChunk(file: FileInfo, cursor: FileCursor, budget: number): Promise<{ bytes: Buffer; size: number } | undefined> {
    try {
      const stat = await fs.lstat(file.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== file.dev || stat.ino !== file.ino) return undefined;
      const h = await fs.open(file.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const nowStat = await h.stat();
        if (nowStat.dev !== file.dev || nowStat.ino !== file.ino) return undefined;
        if (nowStat.size < cursor.offset) return { bytes: Buffer.alloc(0), size: nowStat.size };
        const length = Math.min(nowStat.size - cursor.offset, budget, this.options.maxBytesPerFile ?? MAX_BYTES_PER_FILE);
        const b = Buffer.alloc(length);
        const { bytesRead } = await h.read(b, 0, length, cursor.offset);
        return { bytes: b.subarray(0, bytesRead), size: nowStat.size };
      } finally { await h.close(); }
    } catch { this.diagnostics.source_errors += 1; this.addCode(`usage_${file.provider}_source_read_failed`); return undefined; }
  }

  private async cursorAnchorMatches(file: FileInfo, cursor: FileCursor): Promise<boolean> {
    if (cursor.offset <= 0 || !cursor.tailHash) return true;
    try {
      const h = await fs.open(file.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const length = Math.min(256, cursor.offset);
        const bytes = Buffer.alloc(length);
        const { bytesRead } = await h.read(bytes, 0, length, cursor.offset - length);
        return bytesRead === length && sha(bytes) === cursor.tailHash;
      } finally { await h.close(); }
    } catch { return false; }
  }

  private async tailHashAt(file: FileInfo, offset: number): Promise<string> {
    if (offset <= 0) return sha("");
    try {
      const h = await fs.open(file.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const length = Math.min(256, offset);
        const bytes = Buffer.alloc(length);
        const { bytesRead } = await h.read(bytes, 0, length, offset - length);
        return sha(bytes.subarray(0, bytesRead));
      } finally { await h.close(); }
    } catch { return ""; }
  }

  private parseResponse(provider: Provider, line: string, timestampBoundary: number, sourceOffset: number, sourcePathHash: string): ParsedResponse | "irrelevant" | "stale" | "invalid" | "unsafe" {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return "invalid"; }
    if (!isRecord(parsed)) return "invalid";
    let sessionId: unknown; let responseId: unknown; let usage: unknown; let values = emptyNumbers(); let complete = false;
    if (provider === "claude") {
      if (parsed.type !== "assistant") return "irrelevant";
      const message = isRecord(parsed.message) ? parsed.message : undefined;
      if (!message || !isRecord(message.usage)) return "irrelevant";
      if (message.model === "<synthetic>") return "irrelevant";
      sessionId = parsed.sessionId;
      responseId = message.id;
      usage = message.usage;
      const u = usage as Record<string, unknown>;
      for (const [key, target] of [["input_tokens", "input"], ["cache_read_input_tokens", "cached"], ["cache_creation_input_tokens", "cacheCreation"], ["output_tokens", "output"]] as const) {
        const n = safeCount(u[key]);
        if (n !== undefined) values[target] = n;
        else if (Object.hasOwn(u, key)) return "invalid";
      }
      complete = values.input !== null && values.cached !== null && values.cacheCreation !== null && values.output !== null;
    } else {
      if (parsed.type !== "token_usage_record") return "irrelevant";
      const payload = isRecord(parsed.payload) ? parsed.payload : undefined;
      const u = payload && isRecord(payload.usage) ? payload.usage : undefined;
      if (!payload || !u) return "invalid";
      sessionId = payload.thread_id;
      responseId = payload.response_id;
      const input = safeCount(u.input_tokens); const cached = safeCount(u.cached_input_tokens); const output = safeCount(u.output_tokens);
      if (input === undefined || cached === undefined || output === undefined || cached > input) return "invalid";
      values = { input, cached, cacheCreation: 0, output };
      complete = true;
    }
    const timestamp = safeTimestamp(parsed.timestamp);
    if (!timestamp) return "invalid";
    if (Date.parse(timestamp) < timestampBoundary) return "stale";
    if (!safeIdentity(sessionId) || !safeIdentity(responseId)) return "unsafe";
    const identityHash = sha(`${provider}\0${sessionId}\0${responseId}`);
    return { provider, identityHash, values, complete, timestamp, sourceOffset, sourcePathHash };
  }

  private async pollUnlocked(): Promise<void> {
    const lists = {} as Record<Provider, { files: FileInfo[]; accessible: boolean; limited: boolean }>;
    for (const provider of PROVIDERS) lists[provider] = await this.listFiles(provider, this.rootFor(provider));
    this.diagnostics.files_seen += lists.claude.files.length + lists.codex.files.length;
    let remainingPollBudget = this.options.maxBytesPerPoll ?? MAX_BYTES_PER_POLL;
    this.store.beginPoll();
    try {
      const changedStatuses: Array<[Provider, "ready" | "partial" | "unavailable"]> = [];
      for (const provider of PROVIDERS) {
        changedStatuses.push([provider, !lists[provider].accessible ? "unavailable" : lists[provider].limited ? "partial" : "ready"]);
      }
      for (const [provider, status] of changedStatuses) this.store.markProvider(provider, status);
      for (const provider of PROVIDERS) {
        // Keep one provider's growing backlog from starving the other source.
        let providerBudget = Math.min(remainingPollBudget, Math.ceil((this.options.maxBytesPerPoll ?? MAX_BYTES_PER_POLL) / PROVIDERS.length));
        for (const file of lists[provider].files) {
          if (providerBudget <= 0 || remainingPollBudget <= 0) break;
          let cursor = this.store.enrollFile(file);
          if (file.size < cursor.offset || !await this.cursorAnchorMatches(file, cursor)) {
            cursor = { offset: 0, discardBaselineLine: false, discardingOversize: false, tailHash: sha("") };
            this.addCode(`usage_${provider}_source_truncated`);
            this.store.markProvider(provider, "partial");
          }
          const chunk = await this.readChunk(file, cursor, providerBudget);
          if (!chunk) continue;
          const bytes = chunk.bytes;
          providerBudget -= bytes.length;
          remainingPollBudget -= bytes.length;
          let lineStart = 0;
          let offset = cursor.offset;
          let discardBaselineLine = cursor.discardBaselineLine;
          let discardingOversize = cursor.discardingOversize;
          for (let i = 0; i < bytes.length; i += 1) {
            if (bytes[i] !== 0x0a) {
              if (!discardBaselineLine && !discardingOversize && i - lineStart + 1 > (this.options.maxLineBytes ?? MAX_LINE_BYTES)) {
                discardingOversize = true;
                this.diagnostics.oversized_rows += 1;
                this.addCode(`usage_${provider}_oversized_row`);
                this.store.markProvider(provider, "partial");
              }
              continue;
            }
            const endOffset = cursor.offset + i + 1;
            if (discardBaselineLine) {
              discardBaselineLine = false;
              discardingOversize = false;
              offset = endOffset;
              lineStart = i + 1;
              continue;
            }
            if (discardingOversize) {
              discardingOversize = false;
              offset = endOffset;
              lineStart = i + 1;
              continue;
            }
            const lineBytes = bytes.subarray(lineStart, i);
            if (lineBytes.length > (this.options.maxLineBytes ?? MAX_LINE_BYTES)) {
              this.diagnostics.oversized_rows += 1;
              this.addCode(`usage_${provider}_oversized_row`);
              this.store.markProvider(provider, "partial");
            } else if (lineBytes.length > 0) {
              this.diagnostics.rows_seen += 1;
              const parsed = this.parseResponse(provider, lineBytes.toString("utf8"), Date.parse(this.store.epoch.startedAt), offset, sha(`${file.pathHash}\0${file.dev}\0${file.ino}`));
              if (parsed === "invalid") {
                this.diagnostics.malformed_rows += 1;
                this.addCode(`usage_${provider}_unknown_shape`);
                this.store.markProvider(provider, "partial");
              } else if (parsed === "unsafe") {
                this.diagnostics.unsafe_identity_rows += 1;
                this.addCode(`usage_${provider}_unsafe_identity`);
                this.store.markProvider(provider, "partial");
              } else if (parsed === "stale") this.diagnostics.stale_rows += 1;
              else if (parsed !== "irrelevant") {
                this.diagnostics.responses_seen += 1;
                const result = this.store.upsertResponse({ ...parsed, sourceOffset: offset });
                if (result === "conflict") { this.diagnostics.conflicts += 1; this.addCode("usage_response_conflict"); this.store.markProvider(provider, "partial"); }
              }
            }
            offset = endOffset;
            lineStart = i + 1;
          }
          // Preserve normal partial rows by keeping the durable cursor at their start.
          if (discardBaselineLine || discardingOversize) offset = cursor.offset + bytes.length;
          const tailHash = await this.tailHashAt(file, offset);
          const update: FileUpdate = { ...file, offset, discardBaselineLine, discardingOversize, tailHash };
          this.store.saveCursor(update);
        }
      }
      this.snapshot = this.store.commitPoll();
      if (this.store.lastNumericOverflows > 0) {
        this.diagnostics.numeric_overflows += this.store.lastNumericOverflows;
        this.addCode("usage_numeric_overflow");
      }
    } catch (error) {
      this.store.rollbackPoll();
      this.diagnostics.source_errors += 1;
      this.addCode("usage_storage_or_scan_error");
      return;
    }
    await this.publishIfDirty();
  }

  private async publishIfDirty(): Promise<void> {
    if (!this.snapshot || !this.store.isDirty()) return;
    let message = this.store.pendingMessage();
    if (!message) {
      const sequence = await this.options.sequence.next();
      message = {
        type: "usage_snapshot",
        schema_version: 1,
        event_id: eventId(this.options.installationId, sequence),
        installation_id: this.options.installationId,
        sequence,
        occurred_at: new Date(this.now()).toISOString(),
        usage: this.snapshot,
      };
      this.store.savePendingMessage(message);
    }
    try {
      if (this.options.emit) await this.options.emit(message);
      else await this.options.outbox.enqueue({ id: message.event_id, sequence: message.sequence, payload: message, created_at: message.occurred_at });
      this.store.markPublished(message.usage.revision);
    } catch {
      this.diagnostics.emit_errors += 1;
      this.addCode("usage_outbox_enqueue_failed");
    }
  }
}

export async function startUsageWatcher(options: UsageWatcherOptions): Promise<UsageWatcherHandle> {
  return new UsageWatcher(options).start();
}
