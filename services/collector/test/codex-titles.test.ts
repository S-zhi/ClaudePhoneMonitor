import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CodexTitleReader } from "../src/codex-titles.ts";
import { CodexSessionWatcher } from "../src/codex-watcher.ts";
import { createCollectorRuntime, helpText } from "../src/cli.ts";

const CHILD = "018f1f5e-7b2c-7abc-8def-0123456789ab";
const PARENT = "018f1f5e-7b2c-7abc-8def-0123456789b1";
const TURN = "018f1f5e-7b2c-7abc-8def-0123456789ac";
const hash = (value: string) => createHash("sha256").update(value.toLowerCase()).digest("hex");
const privateValue = "NEVER_EXPORT_PRIVATE_BODY";
const indexRow = (id: string, thread_name: unknown, updated_at = "2026-10-07T00:00:00Z") =>
  JSON.stringify({ id, thread_name, updated_at, first_user_message: privateValue, preview: privateValue });

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-native-titles-"));
  const sessionsRoot = path.join(root, "sessions");
  await fs.mkdir(sessionsRoot);
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  return { root, sessionsRoot, index: path.join(root, "session_index.jsonl"), dbFile: path.join(root, "state_5.sqlite") };
}
function database(file: string, withName = true) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY, ${withName ? "name TEXT," : ""} title TEXT, first_user_message TEXT, preview TEXT, cwd TEXT)`);
  return db;
}
function insert(db: DatabaseSync, id: string, name: string | null, title = "Old derived title") {
  db.prepare("INSERT INTO threads(id,name,title,first_user_message,preview,cwd) VALUES (?,?,?,?,?,?)")
    .run(id, name, title, privateValue, privateValue, `/private/${privateValue}`);
}

function rollout(session = CHILD, parent = PARENT): string {
  return `${JSON.stringify({ type: "session_meta", payload: { id: session, session_id: parent } })}\n` +
    `${JSON.stringify({ type: "event_msg", timestamp: new Date().toISOString(), ordinal: 1,
      payload: { type: "task_started", turn_id: TURN, prompt: privateValue } })}\n`;
}

test("index chooses latest timestamp then latest row, normalizes UUID case and never borrows parent title", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.index, [
    indexRow(PARENT, "Parent window"),
    indexRow(CHILD.toUpperCase(), "Latest native name", "2026-10-08T00:00:00Z"),
    indexRow(CHILD, "Older appended record"),
    indexRow(CHILD, "Same-time rename", "2026-10-08T00:00:00Z"),
    indexRow(` ${CHILD}`, "Malformed UUID"),
  ].join("\n") + "\n");
  const reader = new CodexTitleReader({ metadataRoot: f.root });
  await reader.refresh([hash(CHILD), hash(PARENT)]);
  assert.equal(await reader.lookup(hash(CHILD)), "Same-time rename");
  assert.equal(await reader.lookup(hash(PARENT)), "Parent window");
  assert.equal(await reader.lookup(hash(TURN)), undefined);
});

test("canonical SQLite name wins over a stale index; index wins over SQLite derived title", async (t) => {
  const f = await fixture(t);
  const db = database(f.dbFile);
  insert(db, CHILD.toUpperCase(), "Desktop renamed title");
  insert(db, PARENT, null, "Search derived title");
  db.close();
  await fs.writeFile(f.index, `${indexRow(CHILD, "Stale index title")}\n${indexRow(PARENT, "Index title")}\n`);
  const before = await fs.readFile(f.dbFile);
  const filesBefore = (await fs.readdir(f.root)).sort();
  const reader = new CodexTitleReader({ metadataRoot: f.root });
  await reader.refresh([hash(CHILD), hash(PARENT)]);
  assert.equal(await reader.lookup(hash(CHILD)), "Desktop renamed title");
  assert.equal(await reader.lookup(hash(PARENT)), "Index title");
  assert.deepEqual(await fs.readFile(f.dbFile), before, "reader must not modify database bytes");
  assert.deepEqual((await fs.readdir(f.root)).sort(), filesBefore, "reader must not create metadata sidecars");
});

test("old title-only schema and nested sqlite root remain supported without crossing configured homes", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "sqlite"));
  const db = database(path.join(f.root, "sqlite", "state_5.sqlite"), false);
  db.prepare("INSERT INTO threads VALUES(?,?,?,?,?)").run(CHILD, "Safe older native title", privateValue, privateValue, "/private/path");
  db.close();
  const reader = new CodexTitleReader({ metadataRoot: f.root });
  await reader.refresh([hash(CHILD)]);
  assert.equal(await reader.lookup(hash(CHILD)), "Safe older native title");
  const unrelatedRoot = path.join(f.root, "another-home");
  await fs.mkdir(unrelatedRoot);
  const isolated = new CodexTitleReader({ metadataRoot: unrelatedRoot });
  await isolated.refresh([hash(CHILD)]);
  assert.equal(await isolated.lookup(hash(CHILD)), undefined);
  assert.deepEqual(await fs.readdir(unrelatedRoot), []);
});

test("authoritative root database row cannot be replaced by a newer-version nested stale copy", async (t) => {
  const f = await fixture(t);
  const rootDb = database(f.dbFile);
  insert(rootDb, CHILD, "Current root name");
  rootDb.close();
  await fs.mkdir(path.join(f.root, "sqlite"));
  const copiedDb = database(path.join(f.root, "sqlite", "state_9.sqlite"));
  insert(copiedDb, CHILD, "Stale copied name");
  copiedDb.close();
  const reader = new CodexTitleReader({ metadataRoot: f.root });
  await reader.refresh([hash(CHILD)]);
  assert.equal(await reader.lookup(hash(CHILD)), "Current root name");
});

test("invalid latest native names retract earlier names and suppress stale derived title fallback", async (t) => {
  const f = await fixture(t);
  const db = database(f.dbFile);
  insert(db, CHILD, null, "Stale safe search title");
  db.close();
  const reader = new CodexTitleReader({ metadataRoot: f.root });
  await fs.writeFile(f.index, `${indexRow(CHILD, "Previous valid native title")}\n`);
  await reader.refresh([hash(CHILD)]);
  assert.equal(await reader.lookup(hash(CHILD)), "Previous valid native title");
  for (const unsafe of ["x".repeat(65), "/private/source", "https://example.test/private", "Bearer sk-secret-test", "bad\u0000name", ""]) {
    await fs.appendFile(f.index, `${indexRow(CHILD, unsafe, "2026-10-08T00:00:00Z")}\n`);
    await reader.refresh([hash(CHILD)]);
    assert.equal(await reader.lookup(hash(CHILD)), undefined);
  }
});

test("bounded metadata rejects oversized rows and ignores sensitive prompt-only records", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.index, `${indexRow(CHILD, "x".repeat(2_000))}\n` +
    `${JSON.stringify({ id: CHILD, first_user_message: privateValue, preview: privateValue, cwd: "/private/path" })}\n`);
  const reader = new CodexTitleReader({ metadataRoot: f.root, maxLineBytes: 256, maxBytes: 1_024, maxEntries: 4 });
  await reader.refresh([hash(CHILD)]);
  assert.equal(await reader.lookup(hash(CHILD)), undefined);
  await fs.writeFile(f.index, `${indexRow(CHILD, "Bounded latest title")}\n`);
  await reader.refresh([hash(CHILD)]);
  assert.equal(await reader.lookup(hash(CHILD)), "Bounded latest title");
});

test("locked, missing and unsupported databases fail open without erasing the last safe native name", async (t) => {
  const f = await fixture(t);
  const writer = database(f.dbFile);
  insert(writer, CHILD, "Last safe title");
  const reader = new CodexTitleReader({ metadataRoot: f.root });
  await reader.refresh([hash(CHILD)]);
  writer.exec("BEGIN EXCLUSIVE");
  writer.prepare("UPDATE threads SET name=? WHERE id=?").run("After unlock", CHILD);
  await reader.refresh([hash(CHILD)]);
  assert.equal(await reader.lookup(hash(CHILD)), "Last safe title");
  writer.exec("COMMIT");
  writer.close();
  await reader.refresh([hash(CHILD)]);
  assert.equal(await reader.lookup(hash(CHILD)), "After unlock");
  await fs.unlink(f.dbFile);
  await reader.refresh([hash(CHILD)]);
  assert.equal(await reader.lookup(hash(CHILD)), "After unlock");
  await fs.writeFile(f.dbFile, "not a SQLite database");
  const unavailable = new CodexTitleReader({ metadataRoot: f.root, openDatabase: () => { throw new Error(privateValue); } });
  await unavailable.refresh([hash(CHILD)]);
  assert.equal(await unavailable.lookup(hash(CHILD)), undefined);
});

test("metadata symlinks and absent metadata never create or read alternate sources", async (t) => {
  const f = await fixture(t);
  const external = path.join(f.root, "external.jsonl");
  await fs.writeFile(external, `${indexRow(CHILD, "External title")}\n`);
  await fs.symlink(external, f.index);
  const reader = new CodexTitleReader({ metadataRoot: f.root });
  await reader.refresh([hash(CHILD)]);
  assert.equal(await reader.lookup(hash(CHILD)), undefined);
  const absent = path.join(f.root, "not-created");
  await new CodexTitleReader({ metadataRoot: absent }).refresh([hash(CHILD)]);
  assert.equal(await fs.stat(absent).catch(() => undefined), undefined);
});

test("live rename without rollout growth emits only metadata; finish and restart carry native title", async (t) => {
  const f = await fixture(t);
  const events: Array<Record<string, unknown>> = [];
  const checkpointFile = path.join(f.root, "collector", "checkpoint.json");
  const file = path.join(f.sessionsRoot, "rollout-active.jsonl");
  await fs.writeFile(f.index, `${indexRow(CHILD, "真实任务名称")}\n${indexRow(PARENT, "Parent title")}\n`);
  await fs.writeFile(file, rollout());
  const options = { sessionsRoot: f.sessionsRoot, checkpointFile, emit: async (event: unknown) => { events.push(event as Record<string, unknown>); } };
  let watcher = new CodexSessionWatcher(options);
  await watcher.start();
  assert.deepEqual(events.map((event) => event.event_type), ["session_started", "task_started"]);
  assert.ok(events.every((event) => event.session_title === "真实任务名称"));
  const offset = (await fs.stat(file)).size;
  await fs.appendFile(f.index, `${indexRow(CHILD, "改名后的真实任务", "2026-10-08T00:00:00Z")}\n`);
  await watcher.pollOnce();
  await watcher.pollOnce();
  assert.equal((await fs.stat(file)).size, offset);
  assert.deepEqual(events.map((event) => event.event_type), ["session_started", "task_started", "session_title_updated"]);
  assert.equal(events.at(-1)?.session_title, "改名后的真实任务");
  assert.equal(events.at(-1)?.task_id, `codex:turn:${hash(TURN)}`);
  assert.deepEqual(events.at(-1)?.payload, {});
  await watcher.stop();
  const checkpoint = await fs.readFile(checkpointFile, "utf8");
  for (const forbidden of [CHILD, PARENT, TURN, privateValue, "真实任务名称", "改名后的真实任务", "titleDigest", "session_title"]) {
    assert.equal(checkpoint.includes(forbidden), false, `checkpoint cannot contain ${forbidden}`);
  }
  events.length = 0;
  watcher = new CodexSessionWatcher(options);
  await watcher.start();
  assert.deepEqual(events.map((event) => event.event_type), ["session_started", "task_started"]);
  assert.ok(events.every((event) => event.session_title === "改名后的真实任务"));
  await fs.appendFile(file, `${JSON.stringify({ type: "event_msg", timestamp: new Date().toISOString(), ordinal: 2,
    payload: { type: "task_complete", turn_id: TURN, error: null, last_agent_message: privateValue } })}\n`);
  await watcher.pollOnce();
  assert.equal(events.at(-1)?.event_type, "task_finished");
  assert.equal(events.at(-1)?.session_title, "改名后的真实任务");
  await fs.appendFile(f.index, `${indexRow(CHILD, "/private/unsafe", "2026-10-09T00:00:00Z")}\n`);
  await watcher.pollOnce();
  assert.equal(events.at(-1)?.event_type, "session_title_updated");
  assert.equal(events.at(-1)?.session_title, `Codex ${hash(CHILD).slice(-6)}`);
  assert.equal(events.at(-1)?.task_id, `codex:turn:${hash(TURN)}`);
  assert.equal(JSON.stringify(events).includes(privateValue), false);
  await watcher.stop();
});

test("SQLite native rename propagates once without starting tasks and metadata enqueue failures retry", async (t) => {
  const f = await fixture(t);
  const db = database(f.dbFile);
  insert(db, CHILD, "Initial desktop title");
  await fs.writeFile(f.index, `${indexRow(CHILD, "Stale index title")}\n`);
  await fs.writeFile(path.join(f.sessionsRoot, "rollout-native.jsonl"), rollout());
  const events: Array<Record<string, unknown>> = [];
  let failRename = false;
  const watcher = new CodexSessionWatcher({
    sessionsRoot: f.sessionsRoot, checkpointFile: path.join(f.root, "checkpoint.json"),
    emit: async (event) => {
      if (event.event_type === "session_title_updated" && failRename) throw new Error(privateValue);
      events.push(event as unknown as Record<string, unknown>);
    },
  });
  await watcher.start();
  assert.ok(events.every((event) => event.session_title === "Initial desktop title"));
  db.prepare("UPDATE threads SET name=? WHERE id=?").run("Current desktop rename", CHILD);
  failRename = true;
  await watcher.pollOnce();
  assert.equal(events.length, 2);
  failRename = false;
  await watcher.pollOnce();
  await watcher.pollOnce();
  assert.deepEqual(events.map((event) => event.event_type), ["session_started", "task_started", "session_title_updated"]);
  assert.equal(events.at(-1)?.session_title, "Current desktop rename");
  assert.equal(JSON.stringify(watcher.getDiagnostics()).includes(privateValue), false);
  db.close();
  await watcher.stop();
});

test("SQLite bindings return only requested sessions and bound the source candidate count", async (t) => {
  const f = await fixture(t);
  const db = database(f.dbFile);
  insert(db, CHILD, "Requested native name");
  insert(db, PARENT, "Unrequested parent name");
  db.close();
  const reader = new CodexTitleReader({ metadataRoot: f.root, maxEntries: 1 });
  await reader.refresh([hash(CHILD)]);
  // UUID sorting puts the newer parent row first; the configured candidate bound deliberately
  // leaves an older unrelated row unread, rather than scanning an unbounded native database.
  assert.equal(await reader.lookup(hash(CHILD)), undefined);
  assert.equal(await reader.lookup(hash(PARENT)), "Unrequested parent name");
});

test("checkpoint serialization rejects extra private state even from an older checkpoint", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.sessionsRoot, "rollout-checkpoint.jsonl");
  const checkpointFile = path.join(f.root, "checkpoint.json");
  await fs.writeFile(file, rollout());
  const options = { sessionsRoot: f.sessionsRoot, checkpointFile, emit: async () => {} };
  let watcher = new CodexSessionWatcher(options);
  await watcher.start();
  await watcher.stop();
  const saved = JSON.parse(await fs.readFile(checkpointFile, "utf8"));
  saved.files[0].rawTitle = privateValue;
  saved.files[0].rawUuid = CHILD;
  saved.files[0].titleDigest = hash(privateValue);
  await fs.writeFile(checkpointFile, JSON.stringify(saved));
  watcher = new CodexSessionWatcher(options);
  await watcher.start();
  await watcher.stop();
  const checkpoint = await fs.readFile(checkpointFile, "utf8");
  for (const forbidden of [privateValue, CHILD, "rawTitle", "rawUuid", "titleDigest"]) assert.equal(checkpoint.includes(forbidden), false);
});

test("explicit invalid canonical SQLite name cannot resurrect a stale index or derived prompt title", async (t) => {
  const f = await fixture(t);
  const db = database(f.dbFile);
  insert(db, CHILD, "Initial canonical name", "Old derived title");
  await fs.writeFile(f.index, `${indexRow(CHILD, "Old index title")}\n`);
  const reader = new CodexTitleReader({ metadataRoot: f.root });
  await reader.refresh([hash(CHILD)]);
  assert.equal(await reader.lookup(hash(CHILD)), "Initial canonical name");
  for (const name of ["x".repeat(65), "/private/real-project", "https://example.test/private", "Bearer sk-secret-test", "bad\u0000name", "\u0000hidden"]) {
    db.prepare("UPDATE threads SET name=? WHERE id=?").run(name, CHILD);
    await reader.refresh([hash(CHILD)]);
    assert.equal(await reader.lookup(hash(CHILD)), undefined);
  }
  db.exec("BEGIN EXCLUSIVE");
  await reader.refresh([hash(CHILD)]);
  assert.equal(await reader.lookup(hash(CHILD)), undefined, "a prior explicit tombstone survives a transient lock");
  db.exec("COMMIT");
  for (const blank of [null, "", "   ", "\t\r\n", "\u3000"]) {
    db.prepare("UPDATE threads SET name=? WHERE id=?").run(blank, CHILD);
    await reader.refresh([hash(CHILD)]);
    assert.equal(await reader.lookup(hash(CHILD)), "Old index title");
  }
  db.close();
});

test("runtime title root follows configured sessions, environment override and explicit option precedence", async (t) => {
  const f = await fixture(t);
  const envRoot = path.join(f.root, "env-metadata");
  const optionRoot = path.join(f.root, "option-metadata");
  await fs.mkdir(envRoot);
  await fs.mkdir(optionRoot);
  await fs.writeFile(f.index, `${indexRow(CHILD, "Configured sessions native name")}\n`);
  await fs.writeFile(path.join(envRoot, "session_index.jsonl"), `${indexRow(CHILD, "Environment native name")}\n`);
  await fs.writeFile(path.join(optionRoot, "session_index.jsonl"), `${indexRow(CHILD, "Explicit native name")}\n`);
  await fs.writeFile(path.join(f.sessionsRoot, "rollout-runtime.jsonl"), rollout());
  const savedMetadataDir = process.env.COLLECTOR_CODEX_METADATA_DIR;
  try {
    for (const [index, scenario] of [
      { environment: undefined, option: undefined, expected: "Configured sessions native name" },
      { environment: envRoot, option: undefined, expected: "Environment native name" },
      { environment: envRoot, option: optionRoot, expected: "Explicit native name" },
    ].entries()) {
      if (scenario.environment === undefined) delete process.env.COLLECTOR_CODEX_METADATA_DIR;
      else process.env.COLLECTOR_CODEX_METADATA_DIR = scenario.environment;
      const runtime = await createCollectorRuntime({
        dataDir: path.join(f.root, `collector-${index}`), socketPath: path.join(f.root, `collector-${index}.sock`),
        installationId: "native-title-runtime-fixture", relayUrl: "", watchCodex: true, watchUsage: false,
        sessionsRoot: f.sessionsRoot, codexMetadataRoot: scenario.option,
      });
      try {
        const events = (await runtime.outbox.snapshot()).map((record) => record.payload);
        assert.equal(events.length, 2);
        assert.ok(events.every((event) => event.type === "event" && event.session_title === scenario.expected));
      } finally { await runtime.stop(); }
    }
    assert.match(helpText(), /--codex-metadata-root PATH/);
  } finally {
    if (savedMetadataDir === undefined) delete process.env.COLLECTOR_CODEX_METADATA_DIR;
    else process.env.COLLECTOR_CODEX_METADATA_DIR = savedMetadataDir;
  }
});

test("native-name caches remain bounded across many poll generations", async (t) => {
  const f = await fixture(t);
  const db = database(f.dbFile);
  const reader = new CodexTitleReader({ metadataRoot: f.root, maxEntries: 2 });
  const cache = reader as unknown as {
    cached: Map<string, string | undefined>; canonicalNames: Map<string, string | undefined>; canonicalTombstones: Set<string>; titleSources: Map<string, string>;
  };
  for (let generation = 0; generation < 8; generation += 1) {
    const id = `018f1f5e-7b2c-7abc-8def-${generation.toString(16).padStart(12, "0")}`;
    db.exec("DELETE FROM threads");
    insert(db, id, `Generation ${generation}`);
    await reader.refresh([hash(id)]);
    assert.equal(await reader.lookup(hash(id)), `Generation ${generation}`);
    assert.ok(cache.cached.size <= 2);
    assert.ok(cache.canonicalNames.size <= 2);
    assert.ok(cache.canonicalTombstones.size <= 2);
    assert.ok(cache.titleSources.size <= 2);
  }
  db.close();
});

test("read-only native metadata reads existing WAL records without creating or changing source files", async (t) => {
  const f = await fixture(t);
  const writer = database(f.dbFile);
  writer.exec("PRAGMA journal_mode=WAL");
  insert(writer, CHILD, "Native name currently in WAL");
  const before = await fs.readFile(f.dbFile);
  const files = (await fs.readdir(f.root)).sort();
  const reader = new CodexTitleReader({ metadataRoot: f.root });
  await reader.refresh([hash(CHILD)]);
  assert.equal(await reader.lookup(hash(CHILD)), "Native name currently in WAL");
  assert.deepEqual(await fs.readFile(f.dbFile), before);
  assert.deepEqual((await fs.readdir(f.root)).sort(), files);
  writer.close();
});

test("busy canonical authority retains its safe name and tombstone instead of accepting a nested stale copy", async (t) => {
  const f = await fixture(t);
  const writer = database(f.dbFile);
  insert(writer, CHILD, "Current canonical name");
  await fs.mkdir(path.join(f.root, "sqlite"));
  const nested = database(path.join(f.root, "sqlite", "state_9.sqlite"));
  insert(nested, CHILD, "Stale copied name");
  nested.close();
  let rootBusy = false;
  const reader = new CodexTitleReader({
    metadataRoot: `${f.root}${path.sep}`,
    openDatabase: (file) => {
      if (file === f.dbFile && rootBusy) throw Object.assign(new Error("SQLITE_BUSY"), { code: "SQLITE_BUSY" });
      return new DatabaseSync(file, { readOnly: true });
    },
  });
  await reader.refresh([hash(CHILD)]);
  assert.equal(await reader.lookup(hash(CHILD)), "Current canonical name");
  rootBusy = true;
  await reader.refresh([hash(CHILD)]);
  assert.equal(await reader.lookup(hash(CHILD)), "Current canonical name");
  writer.prepare("UPDATE threads SET name=? WHERE id=?").run("Recovered new canonical name", CHILD);
  rootBusy = false;
  await reader.refresh([hash(CHILD)]);
  assert.equal(await reader.lookup(hash(CHILD)), "Recovered new canonical name");
  writer.prepare("UPDATE threads SET name=? WHERE id=?").run("/private/invalid-name", CHILD);
  await reader.refresh([hash(CHILD)]);
  assert.equal(await reader.lookup(hash(CHILD)), undefined);
  rootBusy = true;
  await reader.refresh([hash(CHILD)]);
  assert.equal(await reader.lookup(hash(CHILD)), undefined, "a busy rejected canonical name cannot recover a stale copied label");
  const firstRead = new CodexTitleReader({
    metadataRoot: f.root,
    openDatabase: (file) => {
      if (file === f.dbFile) throw new Error("SQLITE_BUSY");
      return new DatabaseSync(file, { readOnly: true });
    },
  });
  await firstRead.refresh([hash(CHILD)]);
  assert.equal(await firstRead.lookup(hash(CHILD)), "Stale copied name", "first read without authority remains fail-open");
  writer.close();
});
