import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { safeSessionTitle, sha256 } from './identity.mjs';

const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_INDEX_LINE_BYTES = 4096;
const MAX_INDEX_ROWS = 10_000;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_INDEX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_DATABASE_BYTES = 64 * 1024 * 1024;

async function readRegularFile(file, maxBytes, allowTail = false) {
  let handle;
  try {
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > (allowTail ? MAX_INDEX_FILE_BYTES : maxBytes)) return undefined;
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size > (allowTail ? MAX_INDEX_FILE_BYTES : maxBytes)) return undefined;
    if (allowTail && after.size > maxBytes) {
      const bytes = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, after.size - maxBytes);
      const tail = bytes.subarray(0, bytesRead);
      const newline = tail.indexOf(0x0a);
      return newline < 0 ? Buffer.alloc(0) : tail.subarray(newline + 1);
    }
    return await handle.readFile();
  } catch { return undefined; }
  finally { await handle?.close().catch(() => {}); }
}

function latestIndexTitles(content) {
  const result = new Map();
  const rows = content.toString('utf8').split('\n').slice(-MAX_INDEX_ROWS);
  for (let order = 0; order < rows.length; order += 1) {
    const line = rows[order];
    if (!line || Buffer.byteLength(line) > MAX_INDEX_LINE_BYTES) continue;
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string') continue;
    const id = item.id.toLowerCase();
    const date = typeof item.updated_at === 'string' ? Date.parse(item.updated_at) : NaN;
    const timestamp = Number.isFinite(date) ? date : 0;
    const previous = result.get(id);
    if (!Object.hasOwn(item, 'thread_name')) continue;
    if (!previous || timestamp > previous.timestamp || (timestamp === previous.timestamp && order > previous.order)) {
      result.set(id, { title: safeSessionTitle(item.thread_name) ?? null, timestamp, order });
    }
  }
  return result;
}

async function readCodexDatabaseTitles(root, rawIds) {
  const result = new Map();
  const candidates = [];
  for (const dir of [root, path.join(root, 'sqlite')]) {
    try {
      const dirInfo = await fs.lstat(dir);
      if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) continue;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const match = /^state_([0-9]{1,6})\.sqlite$/.exec(entry.name);
        if (match && entry.isFile() && !entry.isSymbolicLink()) candidates.push({ file: path.join(dir, entry.name), version: Number(match[1]), nested: dir !== root });
      }
    } catch { /* Native metadata is optional. */ }
  }
  const files = candidates.sort((a, b) => Number(a.nested) - Number(b.nested) || b.version - a.version).slice(0, 8);
  const ids = [...new Set(rawIds)].filter((id) => typeof id === 'string' && id.length === 36);
  for (const candidate of files) {
    const file = candidate.file;
    let db;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DATABASE_BYTES) continue;
      const wal = await fs.lstat(`${file}-wal`).catch(() => undefined);
      const shm = await fs.lstat(`${file}-shm`).catch(() => undefined);
      if (wal?.isSymbolicLink() || shm?.isSymbolicLink() || (wal && !shm)) continue;
      const sqlite = process.versions.bun ? await import('bun:sqlite') : await import('node:sqlite');
      const Db = process.versions.bun ? sqlite.Database : sqlite.DatabaseSync;
      db = new Db(file, process.versions.bun ? { readonly: true, create: false } : { readOnly: true, timeout: 0 });
      db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON');
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map((column) => column.name));
      if (!columns.has('id') || !columns.has('name')) continue;
      for (let offset = 0; offset < ids.length; offset += 64) {
        const batch = ids.slice(offset, offset + 64).filter((id) => !result.has(id));
        if (!batch.length) continue;
        const rows = db.prepare(`SELECT id,name FROM threads WHERE id IN (${batch.map(() => '?').join(',')}) LIMIT 64`).all(...batch);
        for (const row of rows) {
          if (typeof row.id !== 'string') continue;
          const hasCanonicalName = typeof row.name === 'string' && row.name.trim() !== '';
          if (hasCanonicalName) result.set(row.id, { title: safeSessionTitle(row.name) ?? null, title_source: 'codex_sqlite' });
        }
      }
    } catch { /* Optional native title stores never interrupt monitoring. */ }
    finally { try { db?.close(); } catch { /* Ignore driver errors. */ } }
  }
  return result;
}

export async function readNativeTitles(codexRoot, sessions) {
  const indexBytes = await readRegularFile(path.join(codexRoot, 'session_index.jsonl'), MAX_INDEX_BYTES, true);
  const index = indexBytes ? latestIndexTitles(indexBytes) : new Map();
  const result = new Map();
  const ids = sessions.filter((session) => session.agent_id === 'codex').map((session) => session._raw_id);
  const database = await readCodexDatabaseTitles(codexRoot, ids);
  for (const session of sessions) {
    if (session.agent_id !== 'codex' || !session._raw_id) continue;
    const dbTitle = database.get(session._raw_id);
    if (dbTitle) {
      result.set(session.session_id, dbTitle);
      continue;
    }
    const indexed = index.get(session._raw_id.toLowerCase());
    if (indexed) result.set(session.session_id, { title: indexed.title, title_source: 'codex_session_index' });
  }
  return result;
}

function expandHome(value, home) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

export async function readMagpieCache(cachePath, sessions, home) {
  const bytes = await readRegularFile(cachePath, MAX_CACHE_BYTES);
  if (!bytes) return new Map();
  let cache;
  try { cache = JSON.parse(bytes.toString('utf8')); } catch { return new Map(); }
  if (!cache || cache.version !== 19 || !cache.files || typeof cache.files !== 'object' || Array.isArray(cache.files)) return new Map();
  const indexedFiles = new Map();
  for (const [rawPath, value] of Object.entries(cache.files)) {
    if (typeof rawPath !== 'string' || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    indexedFiles.set(path.normalize(path.resolve(expandHome(rawPath, home))), value);
  }
  const result = new Map();
  for (const session of sessions) {
    if (typeof session._source_path !== 'string') continue;
    const key = path.normalize(path.resolve(expandHome(session._source_path, home)));
    const item = indexedFiles.get(key);
    if (!item || (typeof item.id === 'string' && item.id !== session._raw_id)) continue;
    let title;
    let titleSource;
    if (Object.hasOwn(item, 'custom')) {
      title = safeSessionTitle(item.custom) ?? null;
      titleSource = 'magpie_cache_custom';
    } else if (Object.hasOwn(item, 'named')) {
      title = safeSessionTitle(item.named) ?? null;
      titleSource = 'magpie_cache_named';
    }
    let history = 0;
    let hasHistory = false;
    if (item.days && typeof item.days === 'object' && !Array.isArray(item.days)) {
      for (const day of Object.values(item.days)) {
        if (!day || typeof day !== 'object' || !Number.isSafeInteger(day.a) || day.a < 0) continue;
        history = Math.min(Number.MAX_SAFE_INTEGER, history + day.a);
        hasHistory = true;
      }
    }
    result.set(session.session_id, {
      ...(titleSource ? { title, title_source: titleSource } : {}),
      ...(hasHistory ? { historical_active_ms: history, historical_activity_basis: 'magpie_estimated_line_gaps_lt_5m' } : {}),
    });
  }
  return result;
}

export function sourcePathFingerprint(sourcePath) { return sha256(sourcePath); }
