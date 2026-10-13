import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { agentSessionId, safeAgentId } from "./agent-identity.js";
import { CodexTitleReader } from "./codex-titles.js";
import { normalizeHookEvent } from "./normalize.js";
import type { NormalizedHookEvent } from "./types.js";

const execFile = promisify(execFileCallback);
const CODEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LIMIT = 10_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Magpie's title can be a first-prompt fallback and is deliberately ignored. */
export interface MagpieSessionRecord {
  agent?: unknown;
  id?: unknown;
  title?: unknown;
  start?: unknown;
  last?: unknown;
  [key: string]: unknown;
}
export interface MagpieSession {
  agent: string;
  id: string;
  title?: string;
  start?: string;
  last?: string;
}
export type MagpieCommandRunner = (args: readonly string[], signal?: AbortSignal) => Promise<string>;
export interface MagpieSessionsReaderOptions {
  command?: MagpieCommandRunner;
  commandName?: string;
  cwd?: string;
  defaultLimit?: number;
  commandTimeoutMs?: number;
}
export interface MagpieSessionsWatcherOptions extends MagpieSessionsReaderOptions {
  emit: (event: NormalizedHookEvent) => Promise<void>;
  pollIntervalMs?: number;
  sessionLimit?: number;
  checkpointFile?: string;
  codexMetadataRoot?: string;
  excludedAgentIds?: readonly string[];
  now?: () => Date;
}
export interface MagpieSessionsWatcherHandle {
  stop(): Promise<void>;
  pollOnce(): Promise<void>;
  getDiagnostics(): Readonly<{ codes: string[]; polls: number; sessions: number }>;
}
export interface MagpieSessionDiff {
  added: MagpieSession[];
  removed: MagpieSession[];
  renamed: Array<{ before: MagpieSession; after: MagpieSession }>;
  current: MagpieSession[];
}
export interface MagpieSessionEventOptions { now?: () => Date }

function boundedInteger(value: number, min: number, max: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(code);
  return value;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function date(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw || raw.length > 64) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(raw);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[7]!;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]!
    || hour > 23 || minute > 59 || second > 59) return undefined;
  if (zone !== "Z") {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 23 || zoneMinute > 59) return undefined;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseMagpieSession(raw: MagpieSessionRecord): MagpieSession | null {
  const agent = safeAgentId(raw.agent);
  const rawId = text(raw.id);
  if (!agent || !rawId || rawId.length > 512) return null;
  const session: MagpieSession = { agent, id: agentSessionId(agent, rawId) };
  const start = date(raw.start);
  const last = date(raw.last);
  if (start) session.start = start;
  if (last) session.last = last;
  return session;
}
function jsonRecords(value: unknown): MagpieSessionRecord[] {
  if (!Array.isArray(value)) throw new Error("magpie_sessions_json_not_array");
  return value.filter((item): item is MagpieSessionRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

export class MagpieSessionsReader {
  private readonly command: MagpieCommandRunner;
  private readonly commandName: string;
  private readonly defaultLimit: number;
  public constructor(options: MagpieSessionsReaderOptions = {}) {
    this.commandName = options.commandName ?? "magpie";
    this.defaultLimit = boundedInteger(options.defaultLimit ?? 100, 1, MAX_LIMIT, "magpie_invalid_limit");
    const timeoutMs = boundedInteger(options.commandTimeoutMs ?? 10_000, 100, 60_000, "magpie_invalid_timeout");
    this.command = options.command ?? (async (args, signal) => {
      const result = await execFile(this.commandName, [...args], {
        cwd: options.cwd, maxBuffer: MAX_OUTPUT_BYTES, timeout: timeoutMs, signal,
      });
      return result.stdout;
    });
  }
  public async readSnapshot(limit = this.defaultLimit, signal?: AbortSignal): Promise<MagpieSession[]> {
    const rows = await this.readRaw(limit, signal);
    return rows.map(parseMagpieSession).filter((item): item is MagpieSession => item !== null);
  }
  public async readRaw(limit = this.defaultLimit, signal?: AbortSignal): Promise<MagpieSessionRecord[]> {
    boundedInteger(limit, 1, MAX_LIMIT, "magpie_invalid_limit");
    const output = await this.command(["sessions", "--json", "--limit", String(limit)], signal);
    if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) throw new Error("magpie_output_too_large");
    return jsonRecords(JSON.parse(output));
  }
  public async read(limit = this.defaultLimit): Promise<MagpieSession[]> { return this.readSnapshot(limit); }
  public commandArgs(limit = this.defaultLimit): string[] {
    boundedInteger(limit, 1, MAX_LIMIT, "magpie_invalid_limit");
    return [this.commandName, "sessions", "--json", "--limit", String(limit)];
  }
}

export function compareMagpieSessions(before: readonly MagpieSession[], after: readonly MagpieSession[]): MagpieSessionDiff {
  const oldById = new Map(before.map((session) => [session.id, session]));
  const newById = new Map(after.map((session) => [session.id, session]));
  return {
    added: after.filter((session) => !oldById.has(session.id)),
    removed: before.filter((session) => !newById.has(session.id)),
    renamed: after.flatMap((session) => {
      const prior = oldById.get(session.id);
      return prior && prior.title !== session.title ? [{ before: prior, after: session }] : [];
    }),
    current: [...after],
  };
}
function metadataEvent(session: MagpieSession, now: () => Date): NormalizedHookEvent | null {
  return normalizeHookEvent({
    event_type: "session_metadata_updated",
    session_id: session.id,
    agent_id: session.agent,
    ...(session.title ? { session_title: session.title } : {}),
    occurred_at: now().toISOString(),
    payload: {
      ...(session.start ? { source_started_at: session.start } : {}),
      ...(session.last ? { source_last_activity_at: session.last } : {}),
    },
  }, { trustedAgentId: session.agent, now });
}
/** Snapshot additions and verified renames are metadata; absence is never lifecycle evidence. */
export function magpieSessionEvents(diff: MagpieSessionDiff, options: MagpieSessionEventOptions = {}): NormalizedHookEvent[] {
  const now = options.now ?? (() => new Date());
  return [...diff.added, ...diff.renamed.map(({ after }) => after)]
    .map((session) => metadataEvent(session, now))
    .filter((event): event is NormalizedHookEvent => event !== null);
}
function fingerprint(session: MagpieSession): string {
  return digest(JSON.stringify([session.agent, session.title ?? null, session.start ?? null, session.last ?? null]));
}
async function readCheckpoint(file: string | undefined): Promise<Map<string, string>> {
  if (!file) return new Map();
  let handle: fs.FileHandle | undefined;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) return new Map();
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > 4 * 1024 * 1024) return new Map();
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return new Map();
    const rows = value as { version?: unknown; fingerprints?: unknown };
    if (rows.version !== 1 || !Array.isArray(rows.fingerprints)) return new Map();
    return new Map(rows.fingerprints.filter((row): row is [string, string] =>
      Array.isArray(row) && row.length === 2 && typeof row[0] === "string"
      && /^(?:codex:sess:[a-f0-9]{64}|agent_[a-f0-9]{32})$/.test(row[0])
      && typeof row[1] === "string" && /^[a-f0-9]{64}$/.test(row[1])).slice(-MAX_LIMIT));
  } catch { return new Map(); }
  finally { await handle?.close(); }
}
async function writeCheckpoint(file: string | undefined, fingerprints: Map<string, string>): Promise<void> {
  if (!file) return;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ version: 1, fingerprints: [...fingerprints] }), { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}

export async function startMagpieSessionsWatcher(options: MagpieSessionsWatcherOptions): Promise<MagpieSessionsWatcherHandle> {
  const limit = boundedInteger(options.sessionLimit ?? options.defaultLimit ?? 100, 1, MAX_LIMIT, "magpie_invalid_limit");
  const interval = boundedInteger(options.pollIntervalMs ?? 2_000, 250, 300_000, "magpie_invalid_interval");
  const timeoutMs = boundedInteger(options.commandTimeoutMs ?? 10_000, 100, 60_000, "magpie_invalid_timeout");
  const reader = new MagpieSessionsReader(options);
  const titles = options.codexMetadataRoot ? new CodexTitleReader({ metadataRoot: options.codexMetadataRoot, maxEntries: limit }) : undefined;
  const excluded = new Set(options.excludedAgentIds?.map(safeAgentId).filter((id): id is string => id !== undefined));
  const fingerprints = await readCheckpoint(options.checkpointFile);
  let checkpointDirty = false;
  const codes = new Set<string>();
  let running = true;
  let timer: NodeJS.Timeout | undefined;
  let controller: AbortController | undefined;
  let operation = Promise.resolve();
  let polls = 0;
  let sessions = 0;
  const poll = async () => {
    if (!running) return;
    if (checkpointDirty) {
      try {
        await writeCheckpoint(options.checkpointFile, fingerprints);
        checkpointDirty = false;
      } catch { codes.add("magpie_sessions_checkpoint_failed"); }
    }
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), timeoutMs);
    try {
      const signal = controller.signal;
      const raw = await Promise.race([
        reader.readRaw(limit, signal),
        new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("magpie_command_aborted")), { once: true })),
      ]);
      if (!running) return;
      polls += 1;
      sessions = raw.length;
      const hashes = raw.filter((row) => row.agent === "codex" && typeof row.id === "string" && CODEX_UUID.test(row.id))
        .map((row) => digest((row.id as string).toLowerCase()));
      if (titles && hashes.length) await titles.refresh(hashes);
      for (const row of raw) {
        if (!running) break;
        const session = parseMagpieSession(row);
        if (!session) continue;
        if (excluded.has(session.agent)) { codes.add("magpie_sessions_agent_excluded"); continue; }
        if (titles && session.agent === "codex" && typeof row.id === "string" && CODEX_UUID.test(row.id)) {
          session.title = await titles.lookup(digest(row.id.toLowerCase()));
        }
        const current = fingerprint(session);
        if (fingerprints.get(session.id) === current) continue;
        const event = metadataEvent(session, options.now ?? (() => new Date()));
        if (!event) continue;
        try {
          await options.emit(event);
          fingerprints.delete(session.id);
          fingerprints.set(session.id, current);
          while (fingerprints.size > MAX_LIMIT) fingerprints.delete(fingerprints.keys().next().value!);
          checkpointDirty = true;
        } catch {
          codes.add("magpie_sessions_emit_failed");
          break;
        }
      }
      if (checkpointDirty) {
        try {
          await writeCheckpoint(options.checkpointFile, fingerprints);
          checkpointDirty = false;
        } catch { codes.add("magpie_sessions_checkpoint_failed"); }
      }
    } catch {
      codes.add(controller.signal.aborted ? "magpie_sessions_command_timeout" : "magpie_sessions_read_failed");
    } finally {
      clearTimeout(timeout);
      controller = undefined;
    }
  };
  const pollOnce = () => {
    const next = operation.then(poll);
    operation = next.catch(() => undefined);
    return next;
  };
  await pollOnce();
  const schedule = () => {
    if (!running) return;
    timer = setTimeout(() => void pollOnce().finally(schedule), interval);
    timer.unref?.();
  };
  schedule();
  return {
    pollOnce,
    getDiagnostics: () => ({ codes: [...codes], polls, sessions }),
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      controller?.abort();
      let deadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([operation, new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, timeoutMs + 100);
          deadline.unref?.();
        })]);
      } finally { if (deadline) clearTimeout(deadline); }
    },
  };
}
