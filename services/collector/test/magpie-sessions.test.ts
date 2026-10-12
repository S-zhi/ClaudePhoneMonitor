import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MagpieSessionsReader, compareMagpieSessions, magpieSessionEvents, parseMagpieSession, startMagpieSessionsWatcher } from "../src/magpie-sessions.ts";

const fixture = path.join(import.meta.dirname, "fixtures", "magpie-sessions.json");

test("parses the real magpie sessions JSON shape and removes private values", async () => {
  const raw = JSON.parse(await fs.readFile(fixture, "utf8")) as unknown[];
  const session = parseMagpieSession(raw[0] as Record<string, unknown>);
  assert.ok(session);
  assert.equal(session.agent, "codex");
  assert.equal(session.tokens, 20531);
  assert.equal(session.title, "Magpie session");
  assert.match(session.id, /^magpie_session_[a-f0-9]{32}$/);
  assert.match(session.cwd ?? "", /^magpie_cwd_[a-f0-9]{32}$/);
  assert.doesNotMatch(JSON.stringify(session), /private-session|Users\/private|codex resume/);
  assert.equal(session.gateway, true);
});

test("default execFile honors the configured binary, cwd, and session limit", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magpie-cli-"));
  const cwd = path.join(root, "working");
  const binary = path.join(root, "magpie-test");
  await fs.mkdir(cwd);
  await fs.writeFile(binary, "#!/bin/sh\nprintf '%s\\n' '[{\"agent\":\"test\",\"id\":\"id\",\"cwd\":\"'\"$(pwd)\"'\"}]'\n");
  await fs.chmod(binary, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = await new MagpieSessionsReader({ commandName: binary, cwd }).readSnapshot(3);
  assert.equal(sessions.length, 1);
  const physicalCwd = await fs.realpath(cwd);
  assert.equal(sessions[0]?.cwd, `magpie_cwd_${createHash("sha256").update(physicalCwd).digest("hex").slice(0, 32)}`);
});

test("reader uses an injectable command runner and exact CLI arguments", async () => {
  let args: readonly string[] = [];
  const reader = new MagpieSessionsReader({ command: async (received) => { args = received; return await fs.readFile(fixture, "utf8"); } });
  const sessions = await reader.readSnapshot(7);
  assert.deepEqual(args, ["sessions", "--json", "--limit", "7"]);
  assert.equal(sessions.length, 1);
});

test("compares snapshots and emits only supported start/title events", () => {
  const first = parseMagpieSession({ agent: "codex", id: "same", title: "Old", last: "2026-10-12T16:00:00Z" })!;
  const renamed = { ...first, title: "New" };
  const second = parseMagpieSession({ agent: "codex", id: "new", title: "Added" })!;
  const diff = compareMagpieSessions([first], [renamed, second]);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.renamed.length, 1);
  assert.deepEqual(magpieSessionEvents(diff).map((event) => event.event_type), ["session_started", "session_title_updated"]);
});

test("watcher baselines history, then emits through the injected sink", async () => {
  let output = JSON.stringify([{ agent: "codex", id: "old", title: "Old" }]);
  const events: string[] = [];
  const watcher = await startMagpieSessionsWatcher({
    command: async () => output,
    sessionLimit: 4,
    pollIntervalMs: 60_000,
    emit: async (event) => { events.push(event.event_type); },
  });
  assert.deepEqual(events, []);
  output = JSON.stringify([{ agent: "codex", id: "old", title: "Renamed" }, { agent: "codex", id: "new" }]);
  await watcher.pollOnce();
  assert.deepEqual(events, ["session_started", "session_title_updated"]);
  await watcher.stop();
});

test("namespaces equal upstream ids by Agent", () => {
  const codex = parseMagpieSession({ agent: "codex", id: "same" });
  const pi = parseMagpieSession({ agent: "pi", id: "same" });
  assert.ok(codex && pi);
  assert.notEqual(codex.id, pi.id);
});
