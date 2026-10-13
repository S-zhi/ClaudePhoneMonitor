import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_FIXTURE_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 1024;
const DEFAULT_INTERVAL_MS = 1000;

async function atomicJson(pathname, value) {
  const tempPath = `${pathname}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
  try { await rename(tempPath, pathname); } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function openReservation(databasePath) {
  const sqlite = process.versions.bun
    ? await import('bun:sqlite')
    : await import('node:sqlite');
  const Db = process.versions.bun ? sqlite.Database : sqlite.DatabaseSync;
  const db = new Db(databasePath, process.versions.bun
    ? { create: true, readwrite: true }
    : { timeout: 0 });
  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('BEGIN IMMEDIATE');
    return () => {
      try { db.exec('ROLLBACK'); } catch { /* The reservation may already be released. */ }
      db.close();
    };
  } catch (error) {
    db.close();
    if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED'
      || error.errcode === 5 || error.errcode === 6) return null;
    throw error;
  }
}

function validState(state) {
  return state && state.schemaVersion === 1
    && typeof state.runId === 'string'
    && Number.isSafeInteger(state.tick) && state.tick >= 0
    && Number.isSafeInteger(state.cursor) && state.cursor >= 0
    && Number.isSafeInteger(state.processedCount) && state.processedCount >= 0;
}

async function readFixture(fixturePath, cursor) {
  let info;
  try { info = await stat(fixturePath); } catch (error) {
    if (error.code === 'ENOENT') return cursor;
    throw error;
  }
  if (!info.isFile() || info.size > MAX_FIXTURE_BYTES) return cursor;
  const contents = await readFile(fixturePath);
  let nextCursor = 0;
  for (const rawLine of contents.toString('utf8').split('\n')) {
    if (!rawLine) continue;
    if (Buffer.byteLength(rawLine) > MAX_LINE_BYTES) return cursor;
    let row;
    try { row = JSON.parse(rawLine); } catch { return cursor; }
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).length !== 2 || row.probe !== true
      || !Number.isSafeInteger(row.sequence) || row.sequence !== nextCursor + 1) return cursor;
    nextCursor = row.sequence;
  }
  return nextCursor < cursor ? cursor : nextCursor;
}

export async function startProbe({ directory, intervalMs = DEFAULT_INTERVAL_MS }) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('directory is required');
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) throw new RangeError('invalid intervalMs');
  const root = path.join(directory, 'monitor-plugin-probe');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const statePath = path.join(root, 'state.json');
  const fixturePath = path.join(root, 'fixture.jsonl');
  const reservationPath = path.join(root, 'lock.db');
  const runId = randomUUID();
  let releaseReservation = await openReservation(reservationPath);
  let state = null;
  let stopped = false;
  let timer;
  let chain = Promise.resolve();
  let lastError = null;
  let role = releaseReservation ? 'writer' : 'standby';

  const loadState = async () => {
    let loaded;
    let checkpointMissing = false;
    try { loaded = JSON.parse(await readFile(statePath, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') checkpointMissing = true;
      else throw new Error('Probe checkpoint is unreadable; refusing to reset cursor', { cause: error });
    }
    if (!checkpointMissing && !validState(loaded)) {
      throw new Error('Probe checkpoint is invalid; refusing to reset cursor');
    }
    if (checkpointMissing) loaded = null;
    const startedAt = new Date().toISOString();
    state = {
      schemaVersion: 1, ownerPid: process.pid, runId, tick: loaded?.tick ?? 0,
      cursor: loaded?.cursor ?? 0, processedCount: loaded?.processedCount ?? 0,
      startedAt, lastTickAt: loaded?.lastTickAt ?? null,
      resumedFrom: loaded ? { runId: loaded.runId, cursor: loaded.cursor } : null,
    };
  };

  const tick = async () => {
    if (stopped || role !== 'writer') return;
    const nextCursor = await readFixture(fixturePath, state.cursor);
    const consumed = nextCursor - state.cursor;
    const nextState = {
      ...state,
      tick: state.tick + 1,
      cursor: nextCursor,
      processedCount: state.processedCount + consumed,
      lastTickAt: new Date().toISOString(),
    };
    await atomicJson(statePath, nextState);
    state = nextState;
  };

  const cycle = async () => {
    if (stopped || role === 'failed') return;
    if (role === 'standby') {
      releaseReservation = await openReservation(reservationPath);
      if (!releaseReservation) return;
      role = 'writer';
      try {
        await loadState();
      } catch (error) {
        releaseReservation();
        releaseReservation = null;
        role = 'failed';
        lastError = error;
        clearInterval(timer);
        return;
      }
    }
    try {
      await tick();
    } catch (error) {
      role = 'failed';
      lastError = error;
      clearInterval(timer);
      releaseReservation?.();
      releaseReservation = null;
    }
  };

  const schedule = () => {
    timer = setInterval(() => {
      chain = chain.then(cycle).catch((error) => {
        lastError = error;
        role = 'failed';
        clearInterval(timer);
      });
    }, intervalMs);
    timer.unref?.();
  };

  let ready;
  if (releaseReservation) ready = (async () => {
    try {
      await loadState();
      await tick();
      if (!stopped) schedule();
    } catch (error) {
      releaseReservation();
      releaseReservation = null;
      role = 'failed';
      lastError = error;
      throw error;
    }
  })();
  else {
    ready = Promise.resolve();
    schedule();
  }
  await ready;

  return {
    get role() { return role; },
    getError() { return lastError; },
    ready,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await ready;
      await chain;
      releaseReservation?.();
      releaseReservation = null;
    },
    getState: async () => {
      await chain;
      return state;
    },
  };
}
