import { constants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeHookEvent } from "./normalize.js";
import type { EventType, NormalizedHookEvent } from "./types.js";

const CHECKPOINT_VERSION = 1;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_FILES = 2_048;
const DEFAULT_MAX_BYTES_PER_FILE = 512 * 1024;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024;
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;

export interface AgentSessionWatcherOptions {
  sessionsRoot: string;
  agentId: string;
  checkpointFile: string;
  emit: (event: NormalizedHookEvent) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  staleAfterMs?: number;
  maxFiles?: number;
  maxBytesPerFile?: number;
  maxLineBytes?: number;
  maxBytesPerPoll?: number;
}

export interface AgentSessionWatcherCounters {
  files_seen: number; records_parsed: number; malformed_rows: number; oversized_rows: number;
  unknown_rows: number; unsafe_ids: number; duplicate_or_out_of_order: number;
  source_errors: number; emit_errors: number; stale_sessions_ended: number;
}
export interface AgentSessionWatcherHandle {
  stop(): Promise<void>;
  getDiagnostics(): Readonly<{ codes: string[]; counters: Readonly<AgentSessionWatcherCounters> }>;
}

interface FileCheckpoint { pathHash: string; dev: number; ino: number; offset: number; baselineUntil: number; mtime: number; discarding: boolean; }
interface Checkpoint { version: 1; sourceHash: string; files: FileCheckpoint[]; sessions: Array<[string, SessionState]>; seenRows: string[]; }
interface FileState extends FileCheckpoint { filePath: string; pending: Buffer; }
interface SessionState { active: boolean; reported: boolean; taskId?: string; titleDigest?: string; lastActivity: number; }

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function hashId(agentId: string, value: string): string { return `agent_${digest(`${agentId}:${value}`).slice(0, 32)}`; }
function pathHash(value: string): string { return digest(value); }
function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function stringValue(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof record[key] === "string" && record[key].trim()) return record[key] as string;
  return undefined;
}
function eventType(value: unknown): EventType | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase().replace(/[ .-]/g, "_");
  const aliases: Record<string, EventType> = {
    session_start: "session_started", session_started: "session_started",
    title_updated: "session_title_updated", session_title_updated: "session_title_updated",
    task_start: "task_started", task_started: "task_started",
    task_finish: "task_finished", task_finished: "task_finished",
    task_failed: "task_failed", session_end: "session_ended", session_ended: "session_ended",
    task_aborted: "task_failed", turn_aborted: "task_failed", tool_started: "tool_started", tool_finished: "tool_finished", tool_failed: "tool_failed", waiting: "waiting",
  };
  return aliases[key];
}

/** Read-only bridge JSONL adapter. Native Agent stores require a separate source-specific translator. */
export class AgentSessionWatcher {
  private readonly states = new Map<string, FileState>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly seenRows = new Set<string>();
  private readonly counters: AgentSessionWatcherCounters = {
    files_seen: 0, records_parsed: 0, malformed_rows: 0, oversized_rows: 0, unknown_rows: 0,
    unsafe_ids: 0, duplicate_or_out_of_order: 0, source_errors: 0, emit_errors: 0, stale_sessions_ended: 0,
  };
  private readonly codes = new Set<string>();
  private readonly now: () => number;
  private running = false; private timer?: NodeJS.Timeout; private operation = Promise.resolve(); private initialized = false;
  public constructor(private readonly options: AgentSessionWatcherOptions) { this.now = options.now ?? Date.now; }
  public countersSnapshot(): Readonly<AgentSessionWatcherCounters> { return { ...this.counters }; }
  public getDiagnostics() { return { codes: [...this.codes], counters: this.countersSnapshot() }; }
  public async start(): Promise<AgentSessionWatcherHandle> {
    try { const stat = await fs.lstat(this.options.sessionsRoot); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(); }
    catch { throw new Error("agent_session_watch_start_failed"); }
    if (this.running) return this.handle();
    await this.loadCheckpoint(); await this.pollOnce(); this.running = true; this.schedule(); return this.handle();
  }
  private handle(): AgentSessionWatcherHandle { return { stop: () => this.stop(), getDiagnostics: () => this.getDiagnostics() }; }
  public pollOnce(): Promise<void> { const next = this.operation.then(() => this.pollUnlocked()); this.operation = next.catch(() => undefined); return next; }
  public async stop(): Promise<void> { this.running = false; if (this.timer) clearTimeout(this.timer); await this.operation; await this.saveCheckpoint(); }
  private schedule(): void { if (!this.running) return; this.timer = setTimeout(() => void this.pollOnce().catch(() => undefined).finally(() => this.schedule()), Math.max(50, this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)); this.timer.unref?.(); }
  private async loadCheckpoint(): Promise<void> {
    try {
      const stat = await fs.lstat(this.options.checkpointFile); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CHECKPOINT_BYTES) return;
      const parsed: unknown = JSON.parse(await fs.readFile(this.options.checkpointFile, { encoding: "utf8", flag: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) }));
      if (!isObject(parsed) || parsed.version !== CHECKPOINT_VERSION || parsed.sourceHash !== this.sourceHash() || !Array.isArray(parsed.files)) throw new Error();
      for (const item of parsed.files.slice(-DEFAULT_MAX_FILES)) if (isObject(item) && typeof item.pathHash === "string" && /^[a-f0-9]{64}$/.test(item.pathHash) && Number.isSafeInteger(item.offset) && Number(item.offset) >= 0) {
        this.states.set(item.pathHash, { pathHash: item.pathHash, dev: Number(item.dev) || 0, ino: Number(item.ino) || 0, offset: Number(item.offset), baselineUntil: Number(item.baselineUntil) || 0, discarding: item.discarding === true, mtime: Number(item.mtime) || 0, filePath: "", pending: Buffer.alloc(0) });
      }
      if (Array.isArray(parsed.seenRows)) for (const hash of parsed.seenRows.slice(-16_384)) if (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) this.seenRows.add(hash);
      if (Array.isArray(parsed.sessions)) for (const pair of parsed.sessions.slice(-DEFAULT_MAX_FILES)) {
        if (!Array.isArray(pair) || typeof pair[0] !== "string" || !/^agent_[a-f0-9]{32}$/.test(pair[0]) || !isObject(pair[1])) continue;
        const value = pair[1]; if (typeof value.active !== "boolean" || typeof value.reported !== "boolean" || !Number.isFinite(value.lastActivity)) continue;
        this.sessions.set(pair[0], { active: value.active, reported: value.reported, lastActivity: Number(value.lastActivity), taskId: typeof value.taskId === "string" && /^agent_[a-f0-9]{32}$/.test(value.taskId) ? value.taskId : undefined, titleDigest: typeof value.titleDigest === "string" && /^[a-f0-9]{64}$/.test(value.titleDigest) ? value.titleDigest : undefined });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.codes.add("agent_session_checkpoint_invalid");
    }
  }
  private async saveCheckpoint(): Promise<void> {
    const dir = path.dirname(this.options.checkpointFile); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const payload: Checkpoint = { version: 1, sourceHash: this.sourceHash(), files: [...this.states.values()].slice(-DEFAULT_MAX_FILES).map(({ filePath, pending, ...state }) => state), sessions: [...this.sessions].slice(-DEFAULT_MAX_FILES), seenRows: [...this.seenRows].slice(-16_384) };
    const temp = `${this.options.checkpointFile}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(payload), { mode: 0o600, flag: "wx" });
    try { await fs.rename(temp, this.options.checkpointFile); } finally { await fs.unlink(temp).catch(() => undefined); }
  }
  private sourceHash(): string { return digest(`${path.resolve(this.options.sessionsRoot)}:${this.options.agentId}`); }
  private async files(root: string): Promise<string[]> {
    const result: string[] = []; let visited = 0; const cap = this.options.maxFiles ?? DEFAULT_MAX_FILES;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 16 || result.length >= cap || visited >= cap * 4) return;
      const stat = await fs.lstat(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (result.length >= cap || visited++ >= cap * 4) break;
        const current = path.join(dir, entry.name); if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(current, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(current);
      }
    };
    await walk(root, 0); return result;
  }
  private async pollUnlocked(): Promise<void> {
    let names: string[]; try { names = await this.files(this.options.sessionsRoot); } catch { this.counters.source_errors += 1; this.codes.add("agent_session_source_unavailable"); return; }
    this.counters.files_seen = names.length;
    let budget = this.options.maxBytesPerPoll ?? 16 * 1024 * 1024;
    for (const filePath of names) {
      if (budget <= 0) break;
      try { budget -= await this.readFile(filePath, budget); } catch { this.counters.source_errors += 1; this.codes.add("agent_session_read_failed"); }
    }
    await this.expireStale(); this.initialized = true;
    await this.saveCheckpoint().catch(() => { this.counters.source_errors += 1; this.codes.add("agent_session_checkpoint_write_failed"); });
  }
  private async readFile(filePath: string, budget: number): Promise<number> {
    const stat = await fs.lstat(filePath); if (!stat.isFile() || stat.isSymbolicLink()) return 0;
    const key = pathHash(filePath); let state = this.states.get(key);
    const isNew = !state || state.dev !== stat.dev || state.ino !== stat.ino || stat.size < (state.offset ?? 0);
    if (!state || isNew) state = { pathHash: key, dev: stat.dev, ino: stat.ino, offset: 0, baselineUntil: !this.initialized ? stat.size : 0, mtime: stat.mtimeMs, filePath, discarding: false, pending: Buffer.alloc(0) };
    else state.filePath = filePath;
    this.states.set(key, state); const start = state.offset; const length = Math.min(budget, Math.max(0, stat.size - start), this.options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE);
    if (!length) { state.mtime = stat.mtimeMs; return 0; }
    const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); try {
      const opened = await handle.stat(); if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) return 0;
      const buffer = Buffer.alloc(length); const read = await handle.read(buffer, 0, length, start); const previousPending = state.pending.length; const combined = Buffer.concat([state.pending, buffer.subarray(0, read.bytesRead)]); let cursor = 0;
      for (let end = combined.indexOf(0x0a); end >= 0; end = combined.indexOf(0x0a, cursor)) {
        const rowStart = cursor; const lineBytes = combined.subarray(cursor, end); cursor = end + 1;
        if (state.discarding) state.discarding = false;
        else if (lineBytes.length > (this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES)) this.counters.oversized_rows += 1;
        else await this.processLine(lineBytes.toString("utf8").replace(/\r$/, ""), start - previousPending + rowStart >= state.baselineUntil);
        // Advance only after durable enqueue, so a failed row remains retryable.
        state.offset = start - previousPending + cursor;
      }
      if (state.discarding || combined.length - cursor > (this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES)) {
        if (!state.discarding) this.counters.oversized_rows += 1;
        state.discarding = true; state.offset = start - previousPending + combined.length;
      }
      state.pending = state.discarding ? Buffer.alloc(0) : Buffer.from(combined.subarray(cursor));
      state.mtime = stat.mtimeMs;
      return read.bytesRead;
    } finally { await handle.close(); }
  }
  private async processLine(line: string, live: boolean): Promise<void> {
    if (!line.trim()) return; let raw: unknown; try { raw = JSON.parse(line); } catch { this.counters.malformed_rows += 1; this.codes.add("agent_session_jsonl_malformed_row"); return; }
    if (!isObject(raw)) { this.counters.unknown_rows += 1; return; }
    const nested = isObject(raw.payload) ? raw.payload : {}; const sourceId = stringValue(raw, "session_id", "sessionId") ?? stringValue(nested, "session_id", "sessionId"); const type = eventType(stringValue(raw, "event_type", "eventType", "type") ?? stringValue(nested, "event_type", "eventType", "type"));
    if (!sourceId || !type) { this.counters.unknown_rows += 1; return; }
    const sessionId = hashId(this.options.agentId, sourceId); const taskSource = stringValue(raw, "task_id", "taskId") ?? stringValue(nested, "task_id", "taskId");
    const title = stringValue(raw, "session_title", "sessionTitle");
    const sanitized = { event_type: type, session_id: sessionId,
      ...(taskSource ? { task_id: hashId(`${this.options.agentId}:task:${sourceId}`, taskSource) } : {}),
      ...(title ? { session_title: title } : {}), occurred_at: stringValue(raw, "occurred_at", "timestamp"),
      payload: { tool_name: nested.tool_name ?? raw.tool_name, duration_ms: nested.duration_ms ?? raw.duration_ms, exit_code: nested.exit_code ?? raw.exit_code, reason: nested.reason ?? raw.reason },
    };
    const normalized = normalizeHookEvent(sanitized, { now: () => new Date(this.now()) }); if (!normalized) { this.counters.unsafe_ids += 1; return; }
    if (raw.session_kind === "main" || raw.session_kind === "subagent") normalized.session_kind = raw.session_kind;
    this.counters.records_parsed += 1;
    const rowHash = digest(JSON.stringify(sanitized));
    if (this.seenRows.has(rowHash)) { this.counters.duplicate_or_out_of_order += 1; return; }
    if (!live) { this.remember(rowHash); return; }
    const current: SessionState = { ...(this.sessions.get(sessionId) ?? { active: false, reported: false, lastActivity: this.now() }) };
    if (type === "session_title_updated" && current.titleDigest === digest(normalized.session_title ?? "")) { this.remember(rowHash); return; }
    if (type === "task_started" && current.active && current.taskId && current.taskId === normalized.task_id) { this.counters.duplicate_or_out_of_order += 1; this.remember(rowHash); return; }
    if (type === "task_started" && !current.reported) {
      await this.emit({ ...normalized, event_type: "session_started", task_id: undefined });
      current.reported = true; this.sessions.set(sessionId, { ...current });
    }
    await this.emit(normalized);
    if (type === "session_started") current.reported = true;
    if (type === "task_started" || type.startsWith("tool_") || type === "waiting") { current.active = true; current.taskId = normalized.task_id ?? current.taskId; }
    if (type === "task_finished" || type === "task_failed" || type === "session_ended") { current.active = false; current.taskId = undefined; }
    if (type === "session_ended") current.reported = false;
    if (type !== "session_title_updated") current.lastActivity = this.now();
    if (normalized.session_title) current.titleDigest = digest(normalized.session_title);
    this.sessions.set(sessionId, current); this.remember(rowHash);
  }
  private remember(hash: string): void { this.seenRows.add(hash); if (this.seenRows.size > 16_384) this.seenRows.delete(this.seenRows.values().next().value!); }
  private async emit(event: NormalizedHookEvent): Promise<void> { try { await this.options.emit(event); } catch { this.counters.emit_errors += 1; this.codes.add("agent_session_event_emit_failed"); throw new Error("agent_session_emit_failed"); } }
  private async expireStale(): Promise<void> { const cutoff = this.now() - (this.options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS); for (const [sessionId, state] of this.sessions) if (state.active && state.reported && state.lastActivity < cutoff) { await this.emit({ event_type: "session_ended", session_id: sessionId, task_id: state.taskId, occurred_at: new Date(this.now()).toISOString(), payload: {} }); state.active = false; this.counters.stale_sessions_ended += 1; this.codes.add("agent_session_stale"); } }
}

export async function startAgentSessionWatcher(options: AgentSessionWatcherOptions): Promise<AgentSessionWatcherHandle> { return new AgentSessionWatcher(options).start(); }
