import { createHash } from "node:crypto";
import { constants, promises as fs, type Dir } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { safeSessionTitle } from "./normalize.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 4 * 1024;
const DEFAULT_MAX_ENTRIES = 10_000;
const MAX_DATABASE_BYTES = 64 * 1024 * 1024;
const SQL_BATCH_SIZE = 64;
const MAX_DATABASE_FILES = 8;

interface IndexTitle { title?: string; timestamp: number; order: number }

export interface CodexTitleReaderOptions {
  metadataRoot: string;
  maxBytes?: number;
  maxLineBytes?: number;
  maxEntries?: number;
  /** Injectable only to test a runtime without node:sqlite; production always opens read-only. */
  openDatabase?: (file: string) => DatabaseSync | Promise<DatabaseSync>;
}

function sessionHash(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value)
    ? createHash("sha256").update(value.toLowerCase()).digest("hex") : undefined;
}

function timestamp(value: unknown): number {
  if (typeof value !== "string" || value.length > 64) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Native names only: no rollout prompts, previews, cwd or first_user_message are title sources. */
export class CodexTitleReader {
  private index = new Map<string, IndexTitle>();
  private readonly cached = new Map<string, string | undefined>();
  private readonly canonicalNames = new Map<string, string | undefined>();
  private readonly canonicalTombstones = new Set<string>();
  /** RAM-only authority for a validated native row; evicted alongside the bounded title cache. */
  private readonly titleSources = new Map<string, string>();
  private queried = new Set<string>();
  private databaseFiles: string[] = [];
  private sourceAvailable = false;

  public constructor(private readonly options: CodexTitleReaderOptions) {}

  public async refresh(sessionHashes: Iterable<string>): Promise<void> {
    this.queried = new Set();
    this.databaseFiles = [];
    this.sourceAvailable = false;
    try {
      const stat = await fs.lstat(this.options.metadataRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      this.sourceAvailable = true;
    } catch { return; }
    const nextIndex = await this.readIndex();
    if (nextIndex !== undefined) this.index = nextIndex;
    for (const [hash, item] of this.index) this.remember(hash,
      this.canonicalTombstones.has(hash) ? undefined : this.canonicalNames.get(hash) ?? item.title);
    this.databaseFiles = await this.findDatabases();
    const hashes = [...new Set(sessionHashes)].filter((hash) => HASH.test(hash))
      .slice(0, this.options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    for (let offset = 0; offset < hashes.length; offset += SQL_BATCH_SIZE) {
      await this.readDatabaseTitles(hashes.slice(offset, offset + SQL_BATCH_SIZE));
    }
  }

  public async lookup(hash: string): Promise<string | undefined> {
    if (!HASH.test(hash)) return undefined;
    // Desktop threads.name is canonical; index wins over the derived SQLite title. An invalid
    // latest index entry is a tombstone unless SQLite supplies a valid canonical native name.
    if (!this.queried.has(hash) && this.sourceAvailable) await this.readDatabaseTitles([hash]);
    return this.cached.get(hash);
  }

  private remember(hash: string, title: string | undefined): void {
    this.cached.delete(hash);
    this.cached.set(hash, title);
    while (this.cached.size > (this.options.maxEntries ?? DEFAULT_MAX_ENTRIES)) {
      const oldest = this.cached.keys().next().value;
      if (oldest === undefined) break;
      this.cached.delete(oldest);
      this.canonicalNames.delete(oldest);
      this.canonicalTombstones.delete(oldest);
      this.titleSources.delete(oldest);
    }
  }

  private async readIndex(): Promise<Map<string, IndexTitle> | undefined> {
    let handle: fs.FileHandle | undefined;
    try {
      const file = path.join(this.options.metadataRoot, "session_index.jsonl");
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
      handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) return undefined;
      const byteLimit = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
      const offset = Math.max(0, opened.size - byteLimit);
      const bytes = Buffer.alloc(Math.min(byteLimit, opened.size));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
      let content = bytes.subarray(0, bytesRead);
      if (offset > 0) {
        const newline = content.indexOf(0x0a);
        content = newline < 0 ? Buffer.alloc(0) : content.subarray(newline + 1);
      }
      const result = new Map<string, IndexTitle>();
      // Traverse the bounded tail from newest physical row. Timestamp decides recency; equal
      // timestamps use the later line. Oversized or malformed rows are ignored, never logged.
      let end = content.length;
      let entries = 0;
      while (end > 0 && entries < (this.options.maxEntries ?? DEFAULT_MAX_ENTRIES)) {
        const newline = content.lastIndexOf(0x0a, end - 1);
        const begin = newline + 1;
        const row = content.subarray(begin, end);
        const order = begin;
        end = newline < 0 ? 0 : newline;
        if (row.length === 0) continue;
        entries += 1;
        if (row.length > (this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES)) continue;
        let value: unknown;
        try { value = JSON.parse(row.toString("utf8")); } catch { continue; }
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const item = value as Record<string, unknown>;
        const hash = sessionHash(item.id);
        if (!hash || !Object.hasOwn(item, "thread_name")) continue;
        const candidate: IndexTitle = {
          title: safeSessionTitle(item.thread_name),
          timestamp: timestamp(item.updated_at ?? item.updatedAt),
          order,
        };
        const existing = result.get(hash);
        if (!existing || candidate.timestamp > existing.timestamp ||
          (candidate.timestamp === existing.timestamp && candidate.order > existing.order)) result.set(hash, candidate);
      }
      return result;
    } catch { return undefined; }
    finally { await handle?.close().catch(() => undefined); }
  }

  private async findDatabases(): Promise<string[]> {
    const candidates: Array<{ file: string; version: number; nesting: number }> = [];
    for (const [nesting, directory] of [this.options.metadataRoot, path.join(this.options.metadataRoot, "sqlite")].entries()) {
      let listing: Dir | undefined;
      try {
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        listing = await fs.opendir(directory);
        let count = 0;
        for await (const entry of listing) {
          if (++count > 256) break;
          const match = /^state_([0-9]{1,6})\.sqlite$/.exec(entry.name);
          if (!match || !entry.isFile() || entry.isSymbolicLink()) continue;
          candidates.push({ file: path.join(directory, entry.name), version: Number(match[1]), nesting });
        }
      } catch { /* Optional native metadata cannot interrupt lifecycle collection. */ }
      finally { await listing?.close().catch(() => undefined); }
    }
    return candidates.sort((a, b) => a.nesting - b.nesting || b.version - a.version)
      .slice(0, MAX_DATABASE_FILES).map((candidate) => candidate.file);
  }

  private sourcePriority(left: string, right: string): number {
    const nesting = (file: string) => path.resolve(path.dirname(file)) === path.resolve(this.options.metadataRoot) ? 0 : 1;
    const version = (file: string) => Number(/^state_([0-9]+)\.sqlite$/.exec(path.basename(file))?.[1] ?? 0);
    return nesting(left) - nesting(right) || version(right) - version(left);
  }

  private async readDatabaseTitles(hashes: string[]): Promise<void> {
    const requested = hashes.filter((hash) => HASH.test(hash) && !this.queried.has(hash));
    if (requested.length === 0) return;
    requested.forEach((hash) => this.queried.add(hash));
    let successful = false;
    let byteBudget = MAX_DATABASE_BYTES;
    const resolved = new Map<string, { name?: string; title?: string; canonicalRejected: boolean; source: string }>();
    const unavailableSources = new Set([...this.titleSources.values()].filter((file) => !this.databaseFiles.includes(file)));
    for (const file of this.databaseFiles) {
      const eligible = requested.filter((hash) => {
        if (resolved.has(hash)) return false;
        const authority = this.titleSources.get(hash);
        return !authority || !unavailableSources.has(authority) || this.sourcePriority(file, authority) < 0;
      });
      if (eligible.length === 0) continue;
      let db: DatabaseSync | undefined;
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > byteBudget) {
          unavailableSources.add(file);
          continue;
        }
        byteBudget -= stat.size;
        // A read-only WAL reader may otherwise create a missing shared-memory sidecar. If a
        // writer has not supplied it, fail open instead of creating native metadata files.
        const wal = await fs.lstat(`${file}-wal`).catch(() => undefined);
        const shm = await fs.lstat(`${file}-shm`).catch(() => undefined);
        if (wal?.isSymbolicLink() || shm?.isSymbolicLink() || (wal && !shm)) {
          unavailableSources.add(file);
          continue;
        }
        db = this.options.openDatabase ? await this.options.openDatabase(file)
          : new (await import("node:sqlite")).DatabaseSync(file, { readOnly: true });
        db.exec("PRAGMA busy_timeout = 0; PRAGMA query_only = ON;");
        const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map((column) => column.name));
        if (!columns.has("id") || (!columns.has("name") && !columns.has("title"))) {
          unavailableSources.add(file);
          continue;
        }
        const field = (name: "name" | "title") => columns.has(name)
          ? `CASE WHEN typeof(${name}) = 'text' AND instr(${name}, char(0)) = 0 AND length(${name}) <= 64 THEN ${name} ELSE NULL END AS ${name}`
          : `NULL AS ${name}`;
        const namePresent = columns.has("name")
          ? "name IS NOT NULL AND (instr(name, char(0)) > 0 OR length(trim(name, char(9) || char(10) || char(13) || ' ')) > 0) AS has_name"
          : "0 AS has_name";
        db.function("monitor_session_hash", { deterministic: true }, (id) => sessionHash(id) ?? null);
        const rows = db.prepare(`SELECT id, name, title, has_name FROM (
          SELECT id, ${field("name")}, ${field("title")}, ${namePresent} FROM threads
          WHERE typeof(id) = 'text' AND length(id) = 36 ORDER BY id DESC LIMIT ?
        ) WHERE monitor_session_hash(id) IN (${eligible.map(() => "?").join(",")}) LIMIT ?`)
          .all(this.options.maxEntries ?? DEFAULT_MAX_ENTRIES, ...eligible, SQL_BATCH_SIZE);
        successful = true;
        for (const row of rows) {
          const hash = sessionHash(row.id);
          if (!hash || !eligible.includes(hash) || resolved.has(hash)) continue;
          const name = safeSessionTitle(row.name);
          const canonicalPresent = row.has_name === 1 && !(typeof row.name === "string" && row.name.trim() === "");
          resolved.set(hash, { name, title: safeSessionTitle(row.title), canonicalRejected: canonicalPresent && name === undefined, source: file });
        }
      } catch { unavailableSources.add(file); /* Retain validated authority across a transient source failure. */ }
      finally { try { db?.close(); } catch { /* Never retain driver error text. */ } }
      if (resolved.size === requested.length) break;
    }
    if (successful) requested.forEach((hash) => {
      const native = resolved.get(hash);
      const authority = this.titleSources.get(hash);
      // A lower-priority stale copy cannot replace a previously validated authority while that
      // source is busy or absent. Hashes without prior authority can still use available fallbacks.
      if (!native && authority && unavailableSources.has(authority)) return;
      if (native) this.titleSources.set(hash, native.source);
      else this.titleSources.delete(hash);
      this.canonicalNames.set(hash, native?.name);
      if (native?.canonicalRejected) this.canonicalTombstones.add(hash);
      else this.canonicalTombstones.delete(hash);
      this.remember(hash, native?.canonicalRejected ? undefined :
        native?.name ?? (this.index.has(hash) ? this.index.get(hash)?.title : native?.title));
    });
  }
}
