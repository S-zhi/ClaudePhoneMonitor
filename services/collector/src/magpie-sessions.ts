import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { normalizeHookEvent, safeSessionTitle } from "./normalize.js";
import type { NormalizedHookEvent } from "./types.js";

const execFile = promisify(execFileCallback);

/** The JSON shape emitted by `magpie sessions --json` (0.1.1207). */
export interface MagpieSessionRecord {
  agent?: unknown;
  id?: unknown;
  cwd?: unknown;
  title?: unknown;
  start?: unknown;
  last?: unknown;
  models?: unknown;
  tokens?: unknown;
  input?: unknown;
  output?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
  cost?: unknown;
  resume?: unknown;
  path?: unknown;
  transcript?: unknown;
  gateway?: unknown;
}

export interface MagpieSession {
  agent: string;
  id: string;
  cwd?: string;
  title?: string;
  start?: string;
  last?: string;
  models: string[];
  tokens?: number;
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  cost?: number;
  resume?: string;
  path?: string;
  transcript?: boolean;
  gateway?: string | boolean;
}

export type MagpieCommandRunner = (args: readonly string[]) => Promise<string>;

export interface MagpieSessionsReaderOptions {
  command?: MagpieCommandRunner;
  commandName?: string;
  cwd?: string;
  defaultLimit?: number;
}

export interface MagpieSessionsWatcherOptions extends MagpieSessionsReaderOptions {
  emit: (event: NormalizedHookEvent) => Promise<void>;
  pollIntervalMs?: number;
  sessionLimit?: number;
}

export interface MagpieSessionsWatcherHandle {
  stop(): Promise<void>;
  pollOnce(): Promise<void>;
  getDiagnostics(): Readonly<{ codes: string[]; polls: number; sessions: number }>;
}

export interface MagpieSessionEventOptions {
  now?: () => Date;
}

const defaultCommand = (commandName: string, cwd?: string): MagpieCommandRunner => async (args) => {
  const result = await execFile(commandName, [...args], { cwd, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  const result = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function hash(value: string, label: string): string {
  return `${label}_${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32)}`;
}

function privatePath(value: unknown, label: string): string | undefined {
  const raw = text(value);
  return raw ? hash(raw, label) : undefined;
}

function privateId(value: unknown, agent: string): string | undefined {
  const raw = text(value);
  return raw ? hash(`${agent}:${raw}`, "magpie_session") : undefined;
}

function safeAgent(value: unknown): string {
  const raw = text(value)?.toLowerCase().replace(/[^a-z0-9._:-]+/g, "_").slice(0, 64);
  return raw || "unknown";
}

function safeModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object" && !Array.isArray(item)) return (item as Record<string, unknown>).model;
    return undefined;
  }).filter((item): item is string => typeof item === "string" && /^[A-Za-z0-9._:/-]{1,128}$/.test(item));
}

function jsonRecords(value: unknown): MagpieSessionRecord[] {
  if (!Array.isArray(value)) throw new Error("magpie_sessions_json_not_array");
  return value.filter((item): item is MagpieSessionRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

/** Convert a raw Magpie row into a privacy-preserving session summary. */
export function parseMagpieSession(raw: MagpieSessionRecord): MagpieSession | null {
  const agent = safeAgent(raw.agent);
  const id = privateId(raw.id, agent);
  if (!id) return null;
  const result: MagpieSession = {
    agent,
    id,
    models: safeModels(raw.models),
  };
  const title = safeSessionTitle(raw.title);
  const cwd = privatePath(raw.cwd, "magpie_cwd");
  const resume = privatePath(raw.resume, "magpie_resume");
  const transcriptPath = privatePath(raw.path, "magpie_path");
  if (title) result.title = title;
  if (cwd) result.cwd = cwd;
  if (resume) result.resume = resume;
  if (transcriptPath) result.path = transcriptPath;
  for (const key of ["start", "last"] as const) {
    const value = text(raw[key]);
    if (value && !Number.isNaN(Date.parse(value))) result[key] = new Date(value).toISOString();
  }
  for (const key of ["tokens", "input", "output", "cache_read", "cache_write", "cost"] as const) {
    const value = number(raw[key]);
    if (value !== undefined) result[key] = value;
  }
  if (typeof raw.transcript === "boolean") result.transcript = raw.transcript;
  if (typeof raw.gateway === "boolean") result.gateway = raw.gateway;
  else {
    const gateway = text(raw.gateway);
    if (gateway && /^[A-Za-z0-9._:/-]{1,128}$/.test(gateway)) result.gateway = gateway;
  }
  if (result.tokens === undefined && result.input !== undefined && result.output !== undefined) result.tokens = result.input + result.output;
  return result;
}

export class MagpieSessionsReader {
  private readonly command: MagpieCommandRunner;
  private readonly commandName: string;
  private readonly defaultLimit: number;
  public constructor(options: MagpieSessionsReaderOptions = {}) {
    this.commandName = options.commandName ?? "magpie";
    this.defaultLimit = Math.max(1, Math.min(10_000, Math.floor(options.defaultLimit ?? 100)));
    this.cwd = options.cwd;
    this.command = options.command ?? defaultCommand(this.commandName, this.cwd);
  }
  private readonly cwd?: string;
  public async readSnapshot(limit = this.defaultLimit): Promise<MagpieSession[]> {
    const output = await this.command.call(this, ["sessions", "--json", "--limit", String(Math.max(1, Math.floor(limit)))]);
    const parsed: unknown = JSON.parse(output);
    return jsonRecords(parsed).map(parseMagpieSession).filter((item): item is MagpieSession => item !== null);
  }
  public async read(limit = this.defaultLimit): Promise<MagpieSession[]> { return this.readSnapshot(limit); }
  public commandArgs(limit = this.defaultLimit): string[] { return [this.commandName, "sessions", "--json", "--limit", String(limit)]; }
}

export interface MagpieSessionDiff { added: MagpieSession[]; removed: MagpieSession[]; renamed: Array<{ before: MagpieSession; after: MagpieSession }>; current: MagpieSession[]; }

export function compareMagpieSessions(before: readonly MagpieSession[], after: readonly MagpieSession[]): MagpieSessionDiff {
  const oldById = new Map(before.map((session) => [session.id, session]));
  const newById = new Map(after.map((session) => [session.id, session]));
  const added = after.filter((session) => !oldById.has(session.id));
  const removed = before.filter((session) => !newById.has(session.id));
  const renamed = after.flatMap((session) => {
    const prior = oldById.get(session.id);
    return prior && prior.title !== session.title ? [{ before: prior, after: session }] : [];
  });
  return { added, removed, renamed, current: [...after] };
}

/** Emit only the lifecycle facts already supported by the collector protocol. */
export function magpieSessionEvents(diff: MagpieSessionDiff, options: MagpieSessionEventOptions = {}): NormalizedHookEvent[] {
  const occurredAt = (options.now ?? (() => new Date()))().toISOString();
  const events: NormalizedHookEvent[] = [];
  for (const session of diff.added) {
    const event = normalizeHookEvent({ event_type: "session_started", session_id: session.id, session_title: session.title, occurred_at: session.last ?? occurredAt, payload: {} });
    if (event) events.push(event);
  }
  for (const rename of diff.renamed) {
    const event = normalizeHookEvent({ event_type: "session_title_updated", session_id: rename.after.id, session_title: rename.after.title, occurred_at: rename.after.last ?? occurredAt, payload: {} });
    if (event) events.push(event);
  }
  return events;
}

export async function startMagpieSessionsWatcher(options: MagpieSessionsWatcherOptions): Promise<MagpieSessionsWatcherHandle> {
  const reader = new MagpieSessionsReader(options);
  let previous: MagpieSession[] | undefined;
  let running = true;
  let timer: NodeJS.Timeout | undefined;
  let operation = Promise.resolve();
  let polls = 0;
  let sessions = 0;
  const codes = new Set<string>();
  const poll = async () => {
    try {
      const current = await reader.readSnapshot(options.sessionLimit ?? options.defaultLimit);
      polls += 1;
      sessions = current.length;
      if (previous) {
        const events = magpieSessionEvents(compareMagpieSessions(previous, current));
        for (const event of events) await options.emit(event);
      }
      previous = current;
    } catch {
      codes.add("magpie_sessions_read_failed");
    }
  };
  const pollOnce = () => {
    const next = operation.then(poll);
    operation = next.catch(() => undefined);
    return next;
  };
  await pollOnce();
  const interval = Math.max(250, options.pollIntervalMs ?? 2_000);
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
      await operation;
    },
  };
}
