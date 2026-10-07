import { constants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { codexEvent, parseCodexLifecycleLine, type CodexLifecycleRecord } from "./codex-normalizer.js";
import { CodexTitleReader } from "./codex-titles.js";
import type { EventType, NormalizedHookEvent } from "./types.js";

const CHECKPOINT_VERSION = 1;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_FILES = 2_048;
const DEFAULT_MAX_BYTES_PER_POLL = 16 * 1024 * 1024;
const DEFAULT_MAX_BYTES_PER_FILE = 512 * 1024;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024;
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class CodexEmitError extends Error {}

export interface CodexWatcherOptions {
  sessionsRoot: string;
  checkpointFile: string;
  codexMetadataRoot?: string;
  emit: (event: NormalizedHookEvent) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  staleAfterMs?: number;
  maxFiles?: number;
  maxBytesPerPoll?: number;
  maxBytesPerFile?: number;
  maxLineBytes?: number;
}

export interface CodexWatcherHandle {
  stop(): Promise<void>;
  getDiagnostics(): Readonly<{ codes: string[]; counters: Readonly<CodexWatcherCounters> }>;
}

export class CodexWatcherStartError extends Error {
  public readonly code = "codex_watch_start_failed";
  public constructor() { super("Codex watcher could not access its configured sessions root."); }
}

export interface CodexWatcherCounters {
  files_seen: number;
  records_parsed: number;
  malformed_rows: number;
  oversized_rows: number;
  unknown_rows: number;
  unsafe_ids: number;
  duplicate_or_out_of_order: number;
  source_errors: number;
  emit_errors: number;
  stale_sessions_ended: number;
}

interface PersistedFile {
  pathHash: string;
  dev: number;
  ino: number;
  offset: number;
  baseline: boolean;
  baselineUntilOffset: number;
  discardingLongLine: boolean;
  sessionHash?: string;
  currentTurnHash?: string;
  terminalTurnHash?: string;
  active: boolean;
  sessionOpen: boolean;
  reportedSession: boolean;
  identityInvalid?: boolean;
  lastOrdinal?: number;
  lastActivityAt: number;
  observedSize: number;
  observedMtime: number;
}

interface Checkpoint {
  version: typeof CHECKPOINT_VERSION;
  files: PersistedFile[];
  knownSessionHashes: string[];
}

interface FileState extends PersistedFile {
  filePath: string;
  pending: Buffer;
  baseline: boolean;
  seenThisScan: boolean;
  restoreWorking: boolean;
  sessionMetaSeen: boolean;
  needsRestartBaseline: boolean;
  baselineCandidate: boolean;
  sameSessionCopy: boolean;
  liveTouched: boolean;
  identityInvalid: boolean;
  restartReconcile: boolean;
  needsReconcile: boolean;
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function checkpointFileState(value: unknown): value is PersistedFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Partial<PersistedFile>;
  return typeof v.pathHash === "string" && /^[0-9a-f]{64}$/.test(v.pathHash) &&
    Number.isSafeInteger(v.dev) && Number.isSafeInteger(v.ino) && Number.isSafeInteger(v.offset) && (v.offset ?? -1) >= 0 &&
    typeof v.baseline === "boolean" && Number.isSafeInteger(v.baselineUntilOffset) && (v.baselineUntilOffset ?? -1) >= 0 &&
    typeof v.discardingLongLine === "boolean" && typeof v.active === "boolean" && typeof v.sessionOpen === "boolean" &&
    typeof v.reportedSession === "boolean" && Number.isFinite(v.lastActivityAt) && Number.isFinite(v.observedSize) &&
    Number.isFinite(v.observedMtime) && (v.sessionHash === undefined || /^[0-9a-f]{64}$/.test(v.sessionHash)) &&
    (v.currentTurnHash === undefined || /^[0-9a-f]{64}$/.test(v.currentTurnHash)) &&
    (v.terminalTurnHash === undefined || /^[0-9a-f]{64}$/.test(v.terminalTurnHash)) &&
    (v.lastOrdinal === undefined || (Number.isSafeInteger(v.lastOrdinal) && v.lastOrdinal >= 0));
}

function eventOrdinal(record: CodexLifecycleRecord): number | undefined {
  return "ordinal" in record ? record.ordinal : undefined;
}

/**
 * Read-only incremental watcher for Codex rollout JSONL. Its checkpoint contains
 * only hashed identities, offsets, and lifecycle state; raw rows never leave the
 * parser and no error text is retained.
 */
export class CodexSessionWatcher {
  private readonly states = new Map<string, FileState>();
  private readonly knownSessionHashes = new Set<string>();
  private readonly liveAuthoritativeSessions = new Set<string>();
  private readonly now: () => number;
  private readonly titles: CodexTitleReader;
  private readonly titleDigests = new Map<string, string>();
  private readonly counters: CodexWatcherCounters = {
    files_seen: 0, records_parsed: 0, malformed_rows: 0, oversized_rows: 0,
    unknown_rows: 0, unsafe_ids: 0, duplicate_or_out_of_order: 0,
    source_errors: 0, emit_errors: 0, stale_sessions_ended: 0,
  };
  private running = false;
  private pollTimer?: NodeJS.Timeout;
  private operation: Promise<void> = Promise.resolve();
  private initialized = false;
  private watcherStartedAt = 0;
  private readonly diagnosticCodes = new Set<string>();

  public constructor(private readonly options: CodexWatcherOptions) {
    this.now = options.now ?? Date.now;
    this.titles = new CodexTitleReader({ metadataRoot: options.codexMetadataRoot ?? path.dirname(options.sessionsRoot) });
  }

  public countersSnapshot(): Readonly<CodexWatcherCounters> { return { ...this.counters }; }

  public getDiagnostics(): Readonly<{ codes: string[]; counters: Readonly<CodexWatcherCounters> }> {
    return { codes: [...this.diagnosticCodes], counters: this.countersSnapshot() };
  }

  public async start(): Promise<CodexWatcherHandle> {
    if (this.running) return this.handle();
    try {
      const rootStat = await fs.lstat(this.options.sessionsRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error();
    } catch { throw new CodexWatcherStartError(); }
    this.running = true;
    this.watcherStartedAt = this.now();
    await this.loadCheckpoint();
    await this.pollOnce();
    this.schedulePoll();
    return this.handle();
  }

  private handle(): CodexWatcherHandle {
    return { stop: () => this.stop(), getDiagnostics: () => this.getDiagnostics() };
  }

  public pollOnce(): Promise<void> {
    const next = this.operation.then(() => this.pollUnlocked());
    this.operation = next.catch(() => undefined);
    return next;
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    await this.operation;
    await this.saveCheckpoint();
  }

  private schedulePoll(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => {
      void this.pollOnce().catch(() => undefined).finally(() => this.schedulePoll());
    }, Math.max(50, this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
    this.pollTimer.unref?.();
  }

  private async loadCheckpoint(): Promise<void> {
    try {
      const stat = await fs.lstat(this.options.checkpointFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CHECKPOINT_BYTES) return;
      await fs.chmod(this.options.checkpointFile, 0o600).catch(() => undefined);
      const raw = await fs.readFile(this.options.checkpointFile, { encoding: "utf8", flag: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) });
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") { this.diagnosticCodes.add("codex_checkpoint_invalid"); return; }
      const checkpoint = parsed as Partial<Checkpoint>;
      if (checkpoint.version !== CHECKPOINT_VERSION || !Array.isArray(checkpoint.files) || !Array.isArray(checkpoint.knownSessionHashes)) {
        this.diagnosticCodes.add("codex_checkpoint_invalid");
        return;
      }
      for (const item of checkpoint.files.slice(-DEFAULT_MAX_FILES)) {
        if (!checkpointFileState(item)) continue;
        const state: FileState = {
          ...item,
          filePath: "",
          pending: Buffer.alloc(0),
          baseline: item.baseline,
          seenThisScan: false,
          restoreWorking: item.active && !item.baseline,
          sessionMetaSeen: Boolean(item.sessionHash),
          needsRestartBaseline: true,
          baselineCandidate: false,
          sameSessionCopy: false,
          liveTouched: false,
          identityInvalid: Boolean(item.identityInvalid),
          restartReconcile: true,
          needsReconcile: false,
        };
        this.states.set(this.fileKey(item.pathHash, item.dev, item.ino), state);
        if (item.sessionHash) this.knownSessionHashes.add(item.sessionHash);
      }
      for (const hash of checkpoint.knownSessionHashes.slice(-10_000)) {
        if (typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)) this.knownSessionHashes.add(hash);
      }
    } catch (error) {
      // Missing, invalid, or unreadable checkpoint means fail-closed silent baseline.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.diagnosticCodes.add("codex_checkpoint_unavailable");
    }
  }

  private async saveCheckpoint(): Promise<void> {
    const checkpoint: Checkpoint = {
      version: CHECKPOINT_VERSION,
      files: [...this.states.values()].slice(-DEFAULT_MAX_FILES).map((state) => ({
        pathHash: state.pathHash, dev: state.dev, ino: state.ino, offset: state.offset,
        baseline: state.baseline, baselineUntilOffset: state.baselineUntilOffset,
        discardingLongLine: state.discardingLongLine, sessionHash: state.sessionHash,
        currentTurnHash: state.currentTurnHash, terminalTurnHash: state.terminalTurnHash,
        active: state.active, sessionOpen: state.sessionOpen, reportedSession: state.reportedSession,
        identityInvalid: state.identityInvalid, lastOrdinal: state.lastOrdinal,
        lastActivityAt: state.lastActivityAt, observedSize: state.observedSize, observedMtime: state.observedMtime,
      })),
      knownSessionHashes: [...this.knownSessionHashes].slice(-10_000),
    };
    const directory = path.dirname(this.options.checkpointFile);
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const existing = await fs.lstat(this.options.checkpointFile).catch(() => undefined);
      if (existing?.isSymbolicLink()) return;
      const temp = `${this.options.checkpointFile}.tmp-${randomUUID()}`;
      const handle = await fs.open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(checkpoint), { encoding: "utf8" });
        await handle.sync();
      } finally { await handle.close(); }
      await fs.rename(temp, this.options.checkpointFile);
      await fs.chmod(this.options.checkpointFile, 0o600).catch(() => undefined);
    } catch {
      this.counters.source_errors += 1;
    }
  }

  private fileKey(pathHash: string, dev: number, ino: number): string { return `${pathHash}:${dev}:${ino}`; }

  private async listFiles(): Promise<Array<{ filePath: string; pathHash: string; dev: number; ino: number; size: number; mtimeMs: number }> | null> {
    const root = this.options.sessionsRoot;
    try {
      const rootStat = await fs.lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    } catch { this.counters.source_errors += 1; this.diagnosticCodes.add("codex_source_root_unavailable"); return null; }
    const result: Array<{ filePath: string; pathHash: string; dev: number; ino: number; size: number; mtimeMs: number }> = [];
    let failed = false;
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 5 || result.length >= (this.options.maxFiles ?? DEFAULT_MAX_FILES)) return;
      try {
        const directoryStat = await fs.lstat(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return;
      } catch { failed = true; this.counters.source_errors += 1; return; }
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch {
        failed = true;
        this.counters.source_errors += 1;
        this.diagnosticCodes.add("codex_source_read_failed");
        return;
      }
      for (const entry of entries) {
        if (result.length >= (this.options.maxFiles ?? DEFAULT_MAX_FILES)) return;
        const candidate = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { await visit(candidate, depth + 1); continue; }
        if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
        try {
          const stat = await fs.lstat(candidate);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          const relative = path.relative(root, candidate);
          // Only the digest is checkpointed; the relative path never leaves memory.
          result.push({ filePath: candidate, pathHash: digest(relative), dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          failed = true;
          this.counters.source_errors += 1;
          this.diagnosticCodes.add("codex_source_read_failed");
        }
      }
    };
    await visit(root, 0);
    return failed ? null : result;
  }

  private async pollUnlocked(): Promise<void> {
    await this.titles.refresh([...this.states.values()].flatMap((state) => state.sessionHash ? [state.sessionHash] : []));
    await this.publishTitleChanges();
    const files = await this.listFiles();
    if (files === null) {
      await this.expireStaleStates();
      await this.saveCheckpoint();
      return;
    }
    this.counters.files_seen = files.length;
    for (const state of this.states.values()) state.seenThisScan = false;

    // Replaced files and renamed paths are new silent baselines. Close the old
    // in-memory observation rather than replaying its historical terminal rows.
    const oldByPath = new Map<string, FileState>();
    for (const state of this.states.values()) oldByPath.set(state.pathHash, state);

    let byteBudget = this.options.maxBytesPerPoll ?? DEFAULT_MAX_BYTES_PER_POLL;
    files.sort((a, b) => {
      const aNew = !this.states.has(this.fileKey(a.pathHash, a.dev, a.ino));
      const bNew = !this.states.has(this.fileKey(b.pathHash, b.dev, b.ino));
      return Number(bNew) - Number(aNew) || b.mtimeMs - a.mtimeMs;
    });
    for (const file of files) {
      const key = this.fileKey(file.pathHash, file.dev, file.ino);
      let state = this.states.get(key);
      if (!state) {
        const replaced = oldByPath.get(file.pathHash);
        if (replaced && !await this.tryNeutralClose(replaced, new Date(this.now()).toISOString())) continue;
        state = this.newState(file, !this.initialized);
        this.states.set(key, state);
      }
      state.filePath = file.filePath;
      state.seenThisScan = true;

      if (state.needsRestartBaseline) {
        state.needsRestartBaseline = false;
        state.baseline = true;
        state.baselineUntilOffset = file.size;
        state.restoreWorking = false;
      }

      if (file.size < state.offset || (state.observedSize > 0 && file.ino !== state.ino)) {
        await this.neutralClose(state, new Date(this.now()).toISOString());
        const replacement = this.newState(file, true);
        replacement.filePath = file.filePath;
        replacement.seenThisScan = true;
        this.states.set(key, replacement);
        state = replacement;
      }

      if (file.size > state.observedSize || file.mtimeMs > state.observedMtime) {
        state.lastActivityAt = state.baseline ? file.mtimeMs : Math.max(this.now(), file.mtimeMs);
      }
      // Keep the current source mtime for cross-file authority ordering even
      // when a copied/touched file's mtime moves backwards. Activity time above
      // remains monotonic and is used only for stale-session expiry.
      state.observedSize = file.size;
      state.observedMtime = file.mtimeMs;
      if (byteBudget > 0) {
        const consumed = await this.readFileChunk(state, Math.min(byteBudget, this.options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE));
        byteBudget -= consumed;
      }
      if (state.baseline && state.offset + state.pending.length >= state.baselineUntilOffset) {
        if (state.pending.length > 0) {
          // An unterminated row at the startup high-water mark is historical.
          // Discard through its eventual newline so completing it later cannot
          // replay an old lifecycle transition as a live event.
          state.offset += state.pending.length;
          state.pending = Buffer.alloc(0);
          state.discardingLongLine = true;
        }
        await this.finishBaseline(state, file.mtimeMs);
      }
    }

    for (const [key, state] of this.states) {
      if (state.seenThisScan) continue;
      if (!await this.tryNeutralClose(state, new Date(this.now()).toISOString())) continue;
      this.states.delete(key);
    }

    await this.expireStaleStates();
    if (![...this.states.values()].some((state) => state.baseline)) {
      try { await this.reconcileBaselineSessions(); }
      catch (error) { if (!(error instanceof CodexEmitError)) throw error; }
    }
    this.initialized = true;
    const reportedHashes = new Set([...this.states.values()].filter((state) => state.reportedSession).map((state) => state.sessionHash));
    for (const hash of this.titleDigests.keys()) if (!reportedHashes.has(hash)) this.titleDigests.delete(hash);
    await this.saveCheckpoint();
  }

  private newState(file: { pathHash: string; dev: number; ino: number; size: number; mtimeMs: number; filePath: string }, baseline: boolean): FileState {
    const now = baseline ? file.mtimeMs : this.now();
    return {
      pathHash: file.pathHash, dev: file.dev, ino: file.ino, offset: 0, baseline, baselineUntilOffset: baseline ? file.size : 0, discardingLongLine: false,
      active: false, sessionOpen: false, reportedSession: false, lastActivityAt: now,
      observedSize: 0, observedMtime: 0,
      filePath: file.filePath, pending: Buffer.alloc(0), seenThisScan: true, restoreWorking: false,
      sessionMetaSeen: false, needsRestartBaseline: false, baselineCandidate: false, sameSessionCopy: false, liveTouched: false,
      identityInvalid: false, restartReconcile: false, needsReconcile: false,
    };
  }

  private async readFileChunk(state: FileState, maxBytes: number): Promise<number> {
    if (maxBytes <= 0) return 0;
    let handle: fs.FileHandle | undefined;
    try {
      const noFollow = constants.O_NOFOLLOW ?? 0;
      handle = await fs.open(state.filePath, constants.O_RDONLY | noFollow);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== state.dev || stat.ino !== state.ino) return 0;
      const readAt = state.offset + state.pending.length;
      if (stat.size <= readAt) return 0;
      const length = Math.min(maxBytes, stat.size - readAt);
      const bytes = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(bytes, 0, length, readAt);
      if (bytesRead === 0) return 0;
      await this.consumeBytes(state, bytes.subarray(0, bytesRead));
      return bytesRead;
    } catch {
      this.counters.source_errors += 1;
      this.diagnosticCodes.add("codex_source_read_failed");
      return 0;
    } finally { await handle?.close().catch(() => undefined); }
  }

  private async consumeBytes(state: FileState, bytes: Buffer): Promise<void> {
    const baseOffset = state.offset;
    let combined: Buffer;
    if (state.discardingLongLine) {
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) { state.offset += bytes.length; return; }
      state.offset += newline + 1;
      state.discardingLongLine = false;
      bytes = bytes.subarray(newline + 1);
      combined = Buffer.concat([state.pending, bytes]);
      state.pending = Buffer.alloc(0);
    } else {
      combined = Buffer.concat([state.pending, bytes]);
      state.pending = Buffer.alloc(0);
    }

    const startOffset = state.offset;
    let rowStart = 0;
    for (let i = 0; i < combined.length; i += 1) {
      if (combined[i] !== 0x0a) continue;
      const rowBytes = combined.subarray(rowStart, i);
      const lineStartOffset = startOffset + rowStart;
      const beforeLine = { ...state, pending: Buffer.from(state.pending) };
      state.offset = startOffset + i + 1;
      rowStart = i + 1;
      if (rowBytes.length > (this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES)) {
        this.counters.oversized_rows += 1;
        const lineEndOffset = startOffset + i + 1;
        if (state.baseline && lineEndOffset >= state.baselineUntilOffset) {
          await this.finishBaseline(state, state.observedMtime);
        }
        continue;
      }
      const line = rowBytes.toString("utf8").replace(/\r$/, "");
      const lineEndOffset = startOffset + i + 1;
      // A row that began before the startup high-water mark remains historical
      // even if its terminating bytes/newline arrive during a later poll.
      const historical = state.baseline && lineStartOffset < state.baselineUntilOffset;
      try {
        await this.processLine(state, line, historical);
      } catch (error) {
        if (!(error instanceof CodexEmitError)) throw error;
        const sessionStarted = state.reportedSession && !beforeLine.reportedSession;
        Object.assign(state, beforeLine);
        for (const key of ["sessionHash", "currentTurnHash", "terminalTurnHash", "lastOrdinal"] as const) {
          if (beforeLine[key] === undefined) delete state[key];
        }
        // Preserve a successfully enqueued session_started prefix so retry
        // resumes with task_started rather than replaying the prefix.
        if (sessionStarted) state.reportedSession = true;
        if (!beforeLine.liveTouched && beforeLine.sessionHash &&
          ![...this.states.values()].some((candidate) => candidate !== state && candidate.liveTouched && candidate.sessionHash === beforeLine.sessionHash)) {
          this.liveAuthoritativeSessions.delete(beforeLine.sessionHash);
        }
        state.offset = lineStartOffset;
        state.pending = Buffer.alloc(0);
        return;
      }
      if (state.baseline && lineEndOffset >= state.baselineUntilOffset) {
        await this.finishBaseline(state, state.observedMtime);
      }
    }
    const tail = combined.subarray(rowStart);
    const maxLine = this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    if (tail.length > maxLine) {
      this.counters.oversized_rows += 1;
      state.offset = startOffset + combined.length;
      state.discardingLongLine = true;
    } else {
      state.offset = startOffset + rowStart;
      state.pending = Buffer.from(tail);
    }
    // If the entire buffer was consumed after finishing a pre-existing long row,
    // offset was already advanced to include its discarded prefix.
    if (baseOffset > startOffset) state.offset += baseOffset - startOffset;
  }

  private async processLine(state: FileState, line: string, historical: boolean): Promise<void> {
    const parsed = parseCodexLifecycleLine(line, this.now(), state.sessionHash);
    if (!parsed) {
      this.counters.malformed_rows += 1;
      this.diagnosticCodes.add("codex_jsonl_malformed_row");
      return;
    }
    this.counters.records_parsed += 1;
    if (parsed.kind === "ignored") {
      if (parsed.invalidSessionMeta) state.identityInvalid = true;
      if (parsed.reason === "unknown_shape") {
        this.counters.unknown_rows += 1;
        this.diagnosticCodes.add("codex_jsonl_unsupported_shape");
      }
      if (parsed.reason === "unsafe_identity") {
        this.counters.unsafe_ids += 1;
        this.diagnosticCodes.add("codex_jsonl_unsafe_identity");
      }
      this.acceptOrdinal(state, parsed);
      return;
    }
    if (state.identityInvalid) {
      this.counters.unsafe_ids += 1;
      this.diagnosticCodes.add("codex_jsonl_unsafe_identity");
      return;
    }
    if (parsed.kind === "session_meta") {
      const wasKnownSession = this.knownSessionHashes.has(parsed.sessionHash);
      state.sessionHash = parsed.sessionHash;
      this.knownSessionHashes.add(parsed.sessionHash);
      if (!historical && wasKnownSession && !state.sessionMetaSeen) {
        // A copied rollout for a known session is history, never a fresh stream.
        state.sameSessionCopy = true;
        state.baseline = true;
        state.baselineUntilOffset = state.observedSize;
        state.lastActivityAt = state.observedMtime;
      }
      state.sessionMetaSeen = true;
      return;
    }
    if (historical && state.sameSessionCopy &&
      (parsed.kind === "task_started" || parsed.kind === "task_complete") &&
      Date.parse(parsed.occurredAt) >= this.watcherStartedAt - 2_000) {
      // A newly-created rollout for a known session may be a true current turn
      // rather than a copied transcript. Recent, distinct lifecycle evidence is
      // live; duplicate task IDs are still suppressed below.
      historical = false;
    }
    if (state.sessionHash && parsed.sessionHash !== state.sessionHash) {
      this.counters.unsafe_ids += 1;
      return;
    }
    state.sessionHash = parsed.sessionHash;
    this.knownSessionHashes.add(parsed.sessionHash);
    const ordinal = eventOrdinal(parsed);
    if (ordinal !== undefined && state.lastOrdinal !== undefined && ordinal <= state.lastOrdinal) {
      this.counters.duplicate_or_out_of_order += 1;
      return;
    }
    this.acceptOrdinal(state, parsed);
    state.lastActivityAt = historical ? Math.max(state.lastActivityAt, state.observedMtime) : this.now();
    if (!historical) {
      state.liveTouched = true;
      state.needsReconcile = true;
      this.liveAuthoritativeSessions.add(state.sessionHash);
    }

    if (parsed.kind === "task_started") {
      if (state.active && state.currentTurnHash === parsed.turnHash) {
        this.counters.duplicate_or_out_of_order += 1;
        return;
      }
      state.currentTurnHash = parsed.turnHash;
      state.terminalTurnHash = undefined;
      state.active = true;
      state.sessionOpen = true;
      if (!historical) {
        const duplicateActiveTurn = this.hasReportedActiveTurn(state);
        const reportedSessionExists = this.hasReportedSession(state);
        // Check for a copied/replayed turn before retiring older file state.
        // Clearing it first would erase the evidence needed to suppress the
        // duplicate and cause a second task_started emission.
        if (!duplicateActiveTurn) this.supersedeOtherSessionFiles(state);
        if (!state.reportedSession && !reportedSessionExists && !duplicateActiveTurn) {
          await this.sendLifecycle("session_started", state.sessionHash, undefined, parsed.occurredAt, true);
          state.reportedSession = true;
        }
        if (!duplicateActiveTurn) {
          await this.sendLifecycle("task_started", state.sessionHash, parsed.turnHash, parsed.occurredAt);
          state.reportedSession = true;
        } else {
          state.reportedSession = false;
        }
      }
      return;
    }

    if (parsed.kind === "turn_aborted") {
      if (parsed.turnHash && state.currentTurnHash !== parsed.turnHash) {
        this.counters.duplicate_or_out_of_order += 1;
        return;
      }
      state.active = false;
      state.terminalTurnHash = parsed.turnHash ?? state.currentTurnHash;
      state.currentTurnHash = undefined;
      state.sessionOpen = false;
      if (!historical) this.supersedeOtherSessionFiles(state);
      if (!historical) await this.neutralClose(state, parsed.occurredAt);
      return;
    }

    if (parsed.kind === "task_complete") {
      if (!state.active || state.currentTurnHash !== parsed.turnHash) {
        this.counters.duplicate_or_out_of_order += 1;
        return;
      }
      if (!historical && !state.reportedSession) {
        if (this.hasReportedActiveTurn(state)) {
          // This terminal row belongs to a copied file for an already-reported
          // turn. Keep the authoritative copy active and discard this duplicate.
          state.active = false;
          state.currentTurnHash = undefined;
          state.baselineCandidate = false;
          return;
        }
        if (!this.hasReportedSession(state)) {
          await this.sendLifecycle("session_started", state.sessionHash, undefined, parsed.occurredAt, true);
        }
        await this.sendLifecycle("task_started", state.sessionHash, parsed.turnHash, parsed.occurredAt);
        state.reportedSession = true;
      }
      state.active = false;
      state.terminalTurnHash = parsed.turnHash;
      state.currentTurnHash = undefined;
      if (!historical) this.supersedeOtherSessionFiles(state);
      if (parsed.errorKind === "none") {
        if (!historical && state.reportedSession) {
          await this.sendLifecycle("task_finished", state.sessionHash, parsed.turnHash, parsed.occurredAt);
        }
      } else {
        state.sessionOpen = false;
        if (!historical) await this.neutralClose(state, parsed.occurredAt,
          parsed.errorKind === "server_overloaded" ? "task_failed" : "session_ended", parsed.turnHash);
      }
    }
  }

  private acceptOrdinal(state: FileState, record: CodexLifecycleRecord): void {
    const ordinal = eventOrdinal(record);
    if (ordinal !== undefined) state.lastOrdinal = ordinal;
  }

  private async finishBaseline(state: FileState, mtimeMs: number): Promise<void> {
    if (!state.baseline) return;
    state.baseline = false;
    if (state.active && state.sessionHash && state.currentTurnHash && this.isFresh(state, mtimeMs)) {
      state.baselineCandidate = true;
    } else if (state.active) {
      state.active = false;
      state.currentTurnHash = undefined;
      state.sessionOpen = false;
    }
    // Idle and terminal snapshots are candidates too. Choosing only among
    // active copies could resurrect an older window after the newest rollout
    // has already completed.
    if (state.sessionHash && state.sessionMetaSeen) state.baselineCandidate = true;
  }

  private hasReportedSession(current: FileState): boolean {
    return [...this.states.values()].some((candidate) => candidate !== current && candidate.reportedSession &&
      candidate.sessionHash === current.sessionHash);
  }

  private supersedeOtherSessionFiles(current: FileState): void {
    for (const candidate of this.states.values()) {
      if (candidate === current || candidate.sessionHash !== current.sessionHash) continue;
      candidate.baselineCandidate = false;
      if (candidate.liveTouched) continue;
      candidate.active = false;
      candidate.currentTurnHash = undefined;
    }
  }

  private async reconcileBaselineSessions(): Promise<void> {
    const groups = new Map<string, FileState[]>();
    for (const state of this.states.values()) {
      if (!state.sessionHash) continue;
      const list = groups.get(state.sessionHash) ?? [];
      list.push(state);
      groups.set(state.sessionHash, list);
    }
    for (const [sessionHash, states] of groups) {
      if (!states.some((state) => state.baselineCandidate || state.restartReconcile || state.needsReconcile)) continue;
      if (this.liveAuthoritativeSessions.has(sessionHash)) {
        const liveReported = states
          .filter((state) => state.liveTouched && state.reportedSession)
          .sort((a, b) => b.observedMtime - a.observedMtime)[0];
        for (const state of states) {
          state.baselineCandidate = false;
          state.needsReconcile = false;
          if (state === liveReported) continue;
          state.active = false;
          state.currentTurnHash = undefined;
          state.reportedSession = false;
        }
        continue;
      }

      const candidates = states.filter((state) => state.baselineCandidate);
      const selected = candidates.sort((a, b) => b.observedMtime - a.observedMtime || a.pathHash.localeCompare(b.pathHash))[0];
      if (selected?.active && selected.currentTurnHash) {
        const alreadyReported = states.some((state) => state.reportedSession);
        const needsRehydrate = states.some((state) => state.restartReconcile);
        const nowIso = new Date(this.now()).toISOString();
        if (!alreadyReported || needsRehydrate) {
          await this.sendLifecycle("session_started", sessionHash, undefined, nowIso, true);
          selected.reportedSession = true;
          selected.restartReconcile = false;
        }
        await this.sendLifecycle("task_started", sessionHash, selected.currentTurnHash, nowIso);
        for (const state of states) {
          state.baselineCandidate = false;
          state.restartReconcile = false;
          state.needsReconcile = false;
          if (state === selected) continue;
          state.active = false;
          state.currentTurnHash = undefined;
          state.reportedSession = false;
        }
        selected.reportedSession = true;
      } else {
        const reported = states.find((state) => state.reportedSession);
        if (reported) await this.neutralClose(reported, new Date(this.now()).toISOString());
        for (const state of states) {
          state.baselineCandidate = false;
          state.restartReconcile = false;
          state.needsReconcile = false;
          state.active = false;
          state.currentTurnHash = undefined;
          state.reportedSession = false;
          state.sessionOpen = false;
        }
      }
    }
  }

  private async neutralClose(
    state: FileState,
    occurredAt: string,
    type: "task_failed" | "session_ended" = "session_ended",
    turnHash = state.currentTurnHash,
  ): Promise<void> {
    if (!state.reportedSession || !state.sessionHash) return;
    await this.sendLifecycle(type, state.sessionHash, turnHash, occurredAt);
    state.reportedSession = false;
  }

  private async tryNeutralClose(state: FileState, occurredAt: string): Promise<boolean> {
    try {
      await this.neutralClose(state, occurredAt);
      return true;
    } catch (error) {
      if (error instanceof CodexEmitError) return false;
      throw error;
    }
  }

  private async sendLifecycle(
    type: EventType, sessionHash: string, turnHash: string | undefined, occurredAt: string, sessionStarted = false,
  ): Promise<void> {
    const title = ["session_started", "task_started", "task_finished", "session_title_updated"].includes(type)
      ? await this.titles.lookup(sessionHash) : undefined;
    const event = codexEvent(type, sessionHash, turnHash, occurredAt, sessionStarted, title);
    await this.emitEvent(event);
    if (event.session_title !== undefined) this.titleDigests.set(sessionHash, digest(event.session_title));
  }

  private async publishTitleChanges(): Promise<void> {
    const reported = new Map<string, FileState>();
    for (const state of this.states.values()) {
      if (state.reportedSession && state.sessionHash && !state.identityInvalid) reported.set(state.sessionHash, state);
    }
    for (const [hash, state] of reported) {
      const title = await this.titles.lookup(hash) ?? `Codex ${hash.slice(-6)}`;
      const previous = this.titleDigests.get(hash);
      // A restart has no in-memory digest. Rehydration lifecycle events below supply the native
      // title; do not pretend that losing process memory is a user rename.
      if (previous === undefined || previous === digest(title)) continue;
      try {
        await this.sendLifecycle("session_title_updated", hash, state.currentTurnHash ?? state.terminalTurnHash,
          new Date(this.now()).toISOString());
      } catch (error) { if (!(error instanceof CodexEmitError)) throw error; }
    }
  }

  private async emitEvent(event: NormalizedHookEvent): Promise<void> {
    try { await this.options.emit(event); } catch {
      this.counters.emit_errors += 1;
      this.diagnosticCodes.add("codex_event_emit_failed");
      throw new CodexEmitError();
    }
  }

  private hasReportedActiveTurn(current: FileState): boolean {
    return [...this.states.values()].some((candidate) => candidate !== current && candidate.reportedSession && candidate.active &&
      candidate.sessionHash === current.sessionHash && candidate.currentTurnHash === current.currentTurnHash);
  }

  private isFresh(state: FileState, mtimeMs: number): boolean {
    const lastObserved = Math.max(state.lastActivityAt, mtimeMs);
    return this.now() - lastObserved < (this.options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  }

  private async expireStaleStates(): Promise<void> {
    const now = this.now();
    for (const state of this.states.values()) {
      if (!state.active || now - state.lastActivityAt < (this.options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS)) continue;
      // Keep the active source state intact until its neutral close is durably
      // queued. If the sink is unavailable, the next poll retries this close.
      if (!await this.tryNeutralClose(state, new Date(now).toISOString())) continue;
      state.active = false;
      state.currentTurnHash = undefined;
      state.sessionOpen = false;
      this.counters.stale_sessions_ended += 1;
      this.diagnosticCodes.add("codex_active_session_stale");
    }
  }
}

export async function startCodexWatcher(options: CodexWatcherOptions): Promise<CodexWatcherHandle> {
  const watcher = new CodexSessionWatcher(options);
  return watcher.start();
}
