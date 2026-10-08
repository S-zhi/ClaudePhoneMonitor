import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, appendFile, rm, writeFile, utimes } from "node:fs/promises";
import { appendFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UsageWatcher, type UsageWatcherOptions } from "../src/usage-watcher.js";
import type { UsageSnapshotMessage } from "../src/types.js";
import { validateUsageAggregate } from "../../../packages/protocol/src/index.js";

const epoch = Date.parse("2030-01-01T00:00:00.000Z");
const stamp = "2030-01-01T00:00:01.000Z";

async function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-watcher-"));
  const claude = path.join(root, "claude");
  const codex = path.join(root, "codex");
  await mkdir(claude);
  await mkdir(codex);
  const databaseFile = path.join(root, "private", "usage.sqlite");
  const messages: UsageSnapshotMessage[] = [];
  let sequence = 0;
  const makeWatcher = (overrides: Partial<UsageWatcherOptions> = {}) => new UsageWatcher({
    claudeProjectsRoot: claude,
    codexSessionsRoot: codex,
    databaseFile,
    installationId: "install-test",
    sequence: { next: async () => ++sequence },
    outbox: { enqueue: async () => { throw new Error("emit callback expected"); } } as never,
    emit: async (message) => { messages.push(message); },
    now: () => epoch,
    codexBinary: "",
    pollIntervalMs: 60_000,
    ...overrides,
  });
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { root, claude, codex, databaseFile, messages, makeWatcher };
}

function claudeRow(overrides: {
  sessionId?: string; id?: string; timestamp?: string; model?: string;
  input?: number; cached?: number; creation?: number; output?: number;
  omitCached?: boolean;
} = {}) {
  const usage: Record<string, number> = {
    input_tokens: overrides.input ?? 10,
    cache_creation_input_tokens: overrides.creation ?? 2,
    output_tokens: overrides.output ?? 3,
  };
  if (!overrides.omitCached) usage.cache_read_input_tokens = overrides.cached ?? 4;
  return JSON.stringify({
    type: "assistant",
    timestamp: overrides.timestamp ?? stamp,
    sessionId: overrides.sessionId ?? "session-a",
    message: { id: overrides.id ?? "msg-a", model: overrides.model ?? "claude-test", usage },
  }) + "\n";
}

async function poll(watcher: UsageWatcher) {
  await watcher.pollOnce();
  return watcher.getSnapshot();
}

test("first enable skips high-water history, then counts a cache-only response", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.claude, "session.jsonl");
  await writeFile(file, claudeRow({ timestamp: "2029-12-31T23:59:59.000Z", input: 900 }));
  const watcher = f.makeWatcher();
  const handle = await watcher.start();
  t.after(() => handle.stop());
  assert.equal(handle.getSnapshot().observed_responses, 0, "pre-enable history is not backfilled");

  await appendFile(file, claudeRow({ id: "cache-only", input: 0, cached: 11, creation: 0, output: 0 }));
  const usage = await poll(watcher);
  assert.equal(usage.observed_responses, 1);
  assert.equal(usage.complete_responses, 1);
  assert.deepEqual(usage.new_input, { value: 0, quality: "complete" });
  assert.deepEqual(usage.actual, { value: 0, quality: "complete" });
  assert.deepEqual(usage.cache_hit, { numerator: 11, denominator: 11, quality: "complete" });
});

test("same Claude response updates absolute values and incomplete usage can recover", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.claude, "session.jsonl");
  await writeFile(file, "");
  const watcher = f.makeWatcher();
  const handle = await watcher.start();
  t.after(() => handle.stop());

  await appendFile(file, claudeRow({ id: "same", input: 10, cached: 2, creation: 3, output: 4 }));
  let usage = await poll(watcher);
  assert.equal(usage.observed_responses, 1);
  assert.equal(usage.actual.value, 17);

  await appendFile(file, claudeRow({ id: "same", input: 12, cached: 2, creation: 3, output: 5 }));
  usage = await poll(watcher);
  assert.equal(usage.observed_responses, 1, "duplicate message identity is not counted twice");
  assert.equal(usage.new_input.value, 15, "latest absolute response replaces prior values");
  assert.equal(usage.actual.value, 20);

  await appendFile(file, claudeRow({ id: "incomplete", input: 8, creation: 0, output: 2, omitCached: true }));
  usage = await poll(watcher);
  assert.equal(usage.observed_responses, 2);
  assert.equal(usage.provider_coverage.claude.status, "partial");

  await appendFile(file, claudeRow({ id: "incomplete", input: 8, cached: 0, creation: 0, output: 2 }));
  usage = await poll(watcher);
  assert.equal(usage.complete_responses, 2);
  assert.equal(usage.provider_coverage.claude.status, "ready", "completing the same response clears transient incompleteness");
});

test("ignores explicit synthetic Claude rows and accepts response-level Codex records", async (t) => {
  const f = await fixture(t);
  const claude = path.join(f.claude, "session.jsonl");
  const codex = path.join(f.codex, "rollout-test.jsonl");
  await writeFile(claude, "");
  await writeFile(codex, "");
  const watcher = f.makeWatcher();
  const handle = await watcher.start();
  t.after(() => handle.stop());

  await appendFile(claude, claudeRow({ id: "synthetic", model: "<synthetic>", input: 0, cached: 0, creation: 0, output: 0 }));
  await appendFile(codex, JSON.stringify({
    type: "token_usage_record",
    timestamp: stamp,
    payload: { thread_id: "thread-a", response_id: "response-a", usage: { input_tokens: 9, cached_input_tokens: 4, output_tokens: 6 } },
  }) + "\n");
  const usage = await poll(watcher);
  assert.equal(usage.observed_responses, 1);
  assert.equal(usage.provider_coverage.claude.observed_responses, 0);
  assert.deepEqual(usage.new_input, { value: 5, quality: "complete" });
  assert.deepEqual(usage.actual, { value: 11, quality: "complete" }, "Codex cached input is a subset, not an added token count");
  assert.deepEqual(usage.total_input, { value: 9, quality: "complete" });
});

test("deduplicates copied Claude messages but isolates the same message id across sessions", async (t) => {
  const f = await fixture(t);
  const watcher = f.makeWatcher();
  const handle = await watcher.start();
  t.after(() => handle.stop());
  const first = claudeRow({ sessionId: "session-a", id: "shared-message", input: 10, cached: 1, creation: 2, output: 3 });
  await writeFile(path.join(f.claude, "copy-a.jsonl"), first);
  await writeFile(path.join(f.claude, "copy-a-replay.jsonl"), first);
  await writeFile(path.join(f.claude, "session-b.jsonl"), claudeRow({ sessionId: "session-b", id: "shared-message", input: 20, cached: 1, creation: 2, output: 3 }));
  let usage = await poll(watcher);
  assert.equal(usage.observed_responses, 2);
  assert.equal(usage.complete_responses, 2);
  assert.equal(usage.new_input.value, 34);
  assert.equal(usage.actual.value, 40);

  await writeFile(path.join(f.claude, "conflicting-copy.jsonl"), claudeRow({ sessionId: "session-a", id: "shared-message", input: 11, cached: 1, creation: 2, output: 3 }));
  usage = await poll(watcher);
  assert.equal(usage.observed_responses, 2);
  assert.equal(usage.provider_coverage.claude.status, "partial", "equal-timestamp cross-copy disagreement is not arbitrarily added");
  assert.ok(handle.getDiagnostics().conflicts > 0);
});

test("restart catches up appended lines exactly once while preserving the epoch", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.claude, "session.jsonl");
  await writeFile(file, "");
  const first = f.makeWatcher();
  const firstHandle = await first.start();
  const firstEpoch = firstHandle.getSnapshot().epoch_id;
  await firstHandle.stop();

  await appendFile(file, claudeRow({ id: "during-stop", input: 7, cached: 2, creation: 1, output: 4 }));
  const restarted = f.makeWatcher();
  const secondHandle = await restarted.start();
  t.after(() => secondHandle.stop());
  assert.equal(secondHandle.getSnapshot().epoch_id, firstEpoch);
  assert.equal(secondHandle.getSnapshot().observed_responses, 1);
  await poll(restarted);
  assert.equal(secondHandle.getSnapshot().observed_responses, 1);
});

test("failed durable enqueue retries the identical usage message and does not consume another sequence", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.claude, "session.jsonl");
  await writeFile(file, "");
  const delivered: UsageSnapshotMessage[] = [];
  let attempts = 0;
  let sequence = 0;
  const watcher = new UsageWatcher({
    claudeProjectsRoot: f.claude,
    codexSessionsRoot: f.codex,
    databaseFile: f.databaseFile,
    installationId: "install-test",
    sequence: { next: async () => ++sequence },
    outbox: { enqueue: async () => { throw new Error("unused"); } } as never,
    emit: async (message) => {
      attempts += 1;
      if (attempts === 1) throw new Error("durable queue unavailable");
      delivered.push(message);
    },
    now: () => epoch,
  });
  const handle = await watcher.start();
  t.after(() => handle.stop());
  assert.equal(handle.getDiagnostics().emit_errors, 1);
  await poll(watcher);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.sequence, 1);

  await appendFile(file, claudeRow({ id: "later", input: 3, cached: 0, creation: 0, output: 2 }));
  await poll(watcher);
  assert.equal(delivered.length, 2);
  assert.deepEqual(delivered.map((item) => item.sequence), [1, 2]);
  assert.equal(delivered[1]?.usage.observed_responses, 1);
});

test("a historical partial high-water line is discarded through its newline, while later rows work", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.claude, "session.jsonl");
  const partialHistory = claudeRow({ id: "historical-terminal", timestamp: "2029-12-31T23:59:59.000Z" }).trimEnd();
  await writeFile(file, partialHistory);
  const watcher = f.makeWatcher();
  const handle = await watcher.start();
  t.after(() => handle.stop());
  await appendFile(file, `\n${claudeRow({ id: "after-boundary", input: 4, cached: 1, creation: 0, output: 2 })}`);
  let usage = await poll(watcher);
  assert.equal(usage.observed_responses, 1);
  assert.equal(usage.actual.value, 6);
  await poll(watcher);
  assert.equal(handle.getSnapshot().observed_responses, 1);
});

test("non-usage assistant rows without timestamps do not poison coverage", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.claude, "session.jsonl");
  await writeFile(file, "");
  const watcher = f.makeWatcher();
  const handle = await watcher.start();
  t.after(() => handle.stop());
  await appendFile(file, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [] } })}\n`);
  const usage = await poll(watcher);
  assert.equal(usage.provider_coverage.claude.status, "ready");
  assert.equal(usage.observed_responses, 0);
  assert.equal(handle.getDiagnostics().malformed_rows, 0);
});

test("large irrelevant rows with nested or late type fields preserve complete coverage", async (t) => {
  const f = await fixture(t);
  const watcher = f.makeWatcher();
  const handle = await watcher.start();
  t.after(() => handle.stop());
  const text = "private body ".repeat(60_000);
  const claudeFile = path.join(f.claude, "large.jsonl");
  const codexFile = path.join(f.codex, "rollout-large.jsonl");
  await writeFile(claudeFile, JSON.stringify({ message: { type: "assistant", content: text }, type: "user" }) + "\n"
    + JSON.stringify({ message: { content: text }, type: "assistant" }) + "\n" + claudeRow());
  await writeFile(codexFile, JSON.stringify({ payload: { type: "token_usage_record", content: text }, type: "response_item" }) + "\n");
  const usage = await poll(watcher);
  assert.equal(usage.observed_responses, 1);
  assert.equal(usage.provider_coverage.claude.status, "ready");
  assert.equal(usage.provider_coverage.codex.status, "ready");
  assert.equal(usage.cache_hit.quality, "complete");
  assert.equal(handle.getDiagnostics().oversized_rows, 0);
  assert.equal(handle.getDiagnostics().malformed_rows, 0);
  assert.equal((await readFile(f.databaseFile)).includes("private body"), false);
});

test("large valid usage rows fit even when configured read budgets are too small", async (t) => {
  const f = await fixture(t);
  const watcher = f.makeWatcher({ maxBytesPerFile: 1_024, maxBytesPerPoll: 2_048 });
  const handle = await watcher.start();
  t.after(() => handle.stop());
  const row = JSON.parse(claudeRow()) as Record<string, unknown>;
  const message = row.message as Record<string, unknown>;
  message.content = "x".repeat(700_000);
  await writeFile(path.join(f.claude, "large-usage.jsonl"), JSON.stringify(row) + "\n");
  await writeFile(path.join(f.codex, "rollout-usage.jsonl"), JSON.stringify({
    type: "token_usage_record", timestamp: stamp,
    payload: { thread_id: "t", response_id: "r", usage: { input_tokens: 9, cached_input_tokens: 4, output_tokens: 6 } },
  }) + "\n");
  const usage = await poll(watcher);
  assert.equal(usage.observed_responses, 2);
  assert.equal(usage.complete_responses, 2);
  assert.equal(usage.actual.value, 26);
  assert.equal(usage.cache_hit.quality, "complete");
  assert.equal(handle.getDiagnostics().oversized_rows, 0);
  assert.equal((await poll(watcher)).observed_responses, 2);
});

test("hard-limit rows are discarded across polls while later usage and the other provider progress", async (t) => {
  const f = await fixture(t);
  const watcher = f.makeWatcher();
  const handle = await watcher.start();
  const epochId = handle.getSnapshot().epoch_id;
  let stopped = false;
  t.after(() => { if (!stopped) return handle.stop(); });
  await writeFile(path.join(f.claude, "oversized.jsonl"), JSON.stringify({ type: "user", text: "x".repeat(4 * 1024 * 1024 + 100) }) + "\n" + claudeRow({ id: "after-hard-limit" }));
  await writeFile(path.join(f.codex, "rollout-after.jsonl"), JSON.stringify({
    type: "token_usage_record", timestamp: stamp,
    payload: { thread_id: "t", response_id: "r", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
  }) + "\n");
  let usage = await poll(watcher);
  assert.equal(usage.provider_coverage.codex.observed_responses, 1, "Claude backlog cannot starve Codex");
  usage = await poll(watcher);
  assert.equal(usage.observed_responses, 2);
  assert.equal(usage.provider_coverage.claude.status, "partial");
  assert.equal(handle.getDiagnostics().oversized_rows, 1);
  await handle.stop();
  stopped = true;
  const restarted = f.makeWatcher();
  const restartedHandle = await restarted.start();
  t.after(() => restartedHandle.stop());
  assert.equal(restartedHandle.getSnapshot().epoch_id, epochId);
  assert.equal(restartedHandle.getSnapshot().observed_responses, 2);
  assert.equal(restartedHandle.getSnapshot().provider_coverage.claude.status, "partial", "an old permanent gap is not erased");
});

test("an exact hard-limit row with a late type fits and incomplete large rows wait for their newline", async (t) => {
  const f = await fixture(t);
  const watcher = f.makeWatcher();
  const handle = await watcher.start();
  t.after(() => handle.stop());
  const file = path.join(f.claude, "boundary.jsonl");
  const empty = JSON.stringify({ text: "", type: "user" });
  const large = JSON.stringify({ text: "x".repeat(4 * 1024 * 1024 - Buffer.byteLength(empty)), type: "user" });
  assert.equal(Buffer.byteLength(large), 4 * 1024 * 1024);
  await writeFile(file, large);
  assert.equal((await poll(watcher)).provider_coverage.claude.status, "ready");
  await appendFile(file, "\n" + claudeRow({ id: "after-exact-limit" }));
  await poll(watcher);
  assert.equal((await poll(watcher)).observed_responses, 1);
  assert.equal(handle.getDiagnostics().oversized_rows, 0);
});

test("fully read large files and deferred large tails do not block smaller files", async (t) => {
  const f = await fixture(t);
  const first = path.join(f.claude, "first.jsonl");
  const historical = path.join(f.claude, "historical.jsonl");
  const small = path.join(f.claude, "small.jsonl");
  await writeFile(historical, JSON.stringify({ text: "x".repeat(700_000), type: "user" }) + "\n");
  const watcher = f.makeWatcher({ maxLineBytes: 1_024, maxBytesPerFile: 2_048, maxBytesPerPoll: 4_096 });
  const handle = await watcher.start();
  t.after(() => handle.stop());
  const filler = (JSON.stringify({ type: "user", text: "x".repeat(470) }) + "\n").repeat(3);
  await writeFile(first, filler);
  await writeFile(small, claudeRow({ id: "small-first" }));
  const orderFiles = async () => {
    for (const [file, seconds] of [[first, 3], [historical, 2], [small, 1]] as const) {
      await utimes(file, epoch / 1000 + seconds, epoch / 1000 + seconds);
    }
  };
  await orderFiles();
  assert.equal((await poll(watcher)).observed_responses, 1, "an already-read huge file is skipped using its cursor");
  const largeRow = JSON.parse(claudeRow({ id: "deferred-large" })) as Record<string, unknown>;
  (largeRow.message as Record<string, unknown>).content = "x".repeat(600);
  await appendFile(first, filler);
  await appendFile(historical, JSON.stringify(largeRow) + "\n");
  await appendFile(small, claudeRow({ id: "small-later" }));
  await orderFiles();
  assert.equal((await poll(watcher)).observed_responses, 2, "a large deferred tail does not hide a later small file");
  const usage = await poll(watcher);
  assert.equal(usage.observed_responses, 3, "the deferred allowed row progresses with a fresh budget");
  assert.equal(usage.provider_coverage.claude.status, "ready");
});

test("upgrading the old line limit preserves its gap, counters, epoch, and response deduplication", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.claude, "upgrade.jsonl");
  const old = f.makeWatcher({ maxLineBytes: 64 * 1024 });
  const oldHandle = await old.start();
  let stopped = false;
  t.after(() => { if (!stopped) return oldHandle.stop(); });
  const epochId = oldHandle.getSnapshot().epoch_id;
  await writeFile(file, JSON.stringify({ type: "user", text: "x".repeat(100_000) }) + "\n" + claudeRow({ id: "before-upgrade" }));
  assert.equal((await poll(old)).observed_responses, 1);
  assert.equal(oldHandle.getSnapshot().provider_coverage.claude.status, "partial");
  await oldHandle.stop();
  stopped = true;
  const upgraded = f.makeWatcher();
  const upgradedHandle = await upgraded.start();
  t.after(() => upgradedHandle.stop());
  assert.equal(upgradedHandle.getSnapshot().epoch_id, epochId);
  assert.equal(upgradedHandle.getSnapshot().observed_responses, 1);
  const row = JSON.parse(claudeRow({ id: "after-upgrade" })) as Record<string, unknown>;
  (row.message as Record<string, unknown>).content = "x".repeat(100_000);
  await appendFile(file, claudeRow({ id: "before-upgrade" }) + JSON.stringify(row) + "\n");
  const usage = await poll(upgraded);
  assert.equal(usage.observed_responses, 2);
  assert.equal(usage.provider_coverage.claude.status, "partial");
  assert.equal(upgradedHandle.getDiagnostics().oversized_rows, 0);
});

test("missing timestamp on a usage row and inconsistent Codex cache counters mark coverage partial", async (t) => {
  const f = await fixture(t);
  const claude = path.join(f.claude, "session.jsonl");
  const codex = path.join(f.codex, "rollout-invalid.jsonl");
  await writeFile(claude, "");
  await writeFile(codex, "");
  const watcher = f.makeWatcher();
  const handle = await watcher.start();
  t.after(() => handle.stop());
  await appendFile(claude, `${JSON.stringify({ type: "assistant", sessionId: "s", message: { id: "m", usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })}\n`);
  await appendFile(codex, `${JSON.stringify({ type: "token_usage_record", timestamp: stamp, payload: { thread_id: "t", response_id: "r", usage: { input_tokens: 2, cached_input_tokens: 3, output_tokens: 1 } } })}\n`);
  const usage = await poll(watcher);
  assert.equal(usage.observed_responses, 0);
  assert.equal(usage.provider_coverage.claude.status, "partial");
  assert.equal(usage.provider_coverage.codex.status, "partial");
  assert.equal(handle.getDiagnostics().malformed_rows, 2);
});

test("inventory-to-epoch append window includes existing-file and newly-created-file responses", async (t) => {
  const f = await fixture(t);
  const existing = path.join(f.claude, "already-listed.jsonl");
  const createdDuringBoundary = path.join(f.claude, "created-during-boundary.jsonl");
  await writeFile(existing, "");
  let injected = false;
  const watcher = new UsageWatcher({
    claudeProjectsRoot: f.claude,
    codexSessionsRoot: f.codex,
    databaseFile: f.databaseFile,
    installationId: "install-test",
    sequence: { next: async () => 1 },
    outbox: { enqueue: async () => { throw new Error("unused"); } } as never,
    emit: async () => undefined,
    now: () => {
      if (!injected) {
        injected = true;
        appendFileSync(existing, claudeRow({ id: "during-epoch-existing" }));
        writeFileSync(createdDuringBoundary, claudeRow({ id: "during-epoch-new-file" }));
      }
      return epoch;
    },
  });
  const handle = await watcher.start();
  t.after(() => handle.stop());
  assert.equal(handle.getSnapshot().observed_responses, 2);
});

test("copied/replaced files deduplicate identities while truncation is surfaced as a gap", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.claude, "rollout.jsonl");
  const replacement = path.join(f.claude, "rollout-next.jsonl");
  await writeFile(file, "");
  const watcher = f.makeWatcher();
  const handle = await watcher.start();
  t.after(() => handle.stop());
  const first = claudeRow({ id: "same-before-replace", input: 4, cached: 1, creation: 0, output: 2 });
  await appendFile(file, first);
  assert.equal((await poll(watcher)).observed_responses, 1);

  await writeFile(replacement, `${first}${claudeRow({ id: "new-after-replace", input: 3, cached: 0, creation: 1, output: 2 })}`);
  await (await import("node:fs/promises")).rename(replacement, file);
  let usage = await poll(watcher);
  assert.equal(usage.observed_responses, 2, "replacement copy does not count the existing response twice");
  assert.equal(usage.provider_coverage.claude.status, "ready");

  await writeFile(file, `${first}${claudeRow({ id: "new-after-truncate", input: 2, cached: 0, creation: 0, output: 1 })}`);
  usage = await poll(watcher);
  assert.equal(usage.observed_responses, 3);
  assert.equal(usage.provider_coverage.claude.status, "partial", "truncation resets cursor but records a coverage gap");
  assert.ok(handle.getDiagnostics().codes.includes("usage_claude_source_truncated"));
});

test("cursor write failure rolls back the response ledger so the source row can be retried", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.claude, "session.jsonl");
  await writeFile(file, "");
  const emitted: UsageSnapshotMessage[] = [];
  const watcher = new UsageWatcher({
    claudeProjectsRoot: f.claude,
    codexSessionsRoot: f.codex,
    databaseFile: f.databaseFile,
    installationId: "install-test",
    sequence: { next: async () => emitted.length + 1 },
    outbox: { enqueue: async () => { throw new Error("unused"); } } as never,
    emit: async (message) => { emitted.push(message); },
    now: () => epoch,
  });
  const handle = await watcher.start();
  t.after(() => handle.stop());
  const db = new DatabaseSync(f.databaseFile);
  try {
    db.exec("CREATE TRIGGER fail_usage_cursor BEFORE UPDATE ON usage_files BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    await appendFile(file, claudeRow({ id: "retry-after-rollback" }));
    await poll(watcher);
    assert.equal(handle.getSnapshot().observed_responses, 0, "ledger insert was rolled back with its cursor update");
    assert.ok(handle.getDiagnostics().codes.includes("usage_storage_or_scan_error"));
    db.exec("DROP TRIGGER fail_usage_cursor;");
    const usage = await poll(watcher);
    assert.equal(usage.observed_responses, 1);
    assert.equal(usage.complete_responses, 1);
    assert.equal(emitted.at(-1)?.usage.observed_responses, 1);
  } finally { db.close(); }
});

test("file and recursion scan limits report partial coverage rather than ready", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.claude, "a.jsonl"), "");
  await writeFile(path.join(f.claude, "b.jsonl"), "");
  const limited = new UsageWatcher({
    claudeProjectsRoot: f.claude,
    codexSessionsRoot: f.codex,
    databaseFile: f.databaseFile,
    installationId: "install-test",
    sequence: { next: async () => 1 },
    outbox: { enqueue: async () => { throw new Error("unused"); } } as never,
    emit: async () => undefined,
    now: () => epoch,
    maxFiles: 1,
  });
  const handle = await limited.start();
  let limitedStopped = false;
  t.after(() => { if (!limitedStopped) return handle.stop(); });
  assert.equal(handle.getSnapshot().provider_coverage.claude.status, "partial");
  assert.ok(handle.getDiagnostics().codes.includes("usage_claude_file_scan_limited"));
  await handle.stop();
  limitedStopped = true;

  const deepRoot = path.join(f.root, "claude-deep");
  let nested = deepRoot;
  for (let i = 0; i < 10; i += 1) {
    nested = path.join(nested, `d${i}`);
    await mkdir(nested, { recursive: true });
  }
  await writeFile(path.join(nested, "deep.jsonl"), "");
  const deepWatcher = new UsageWatcher({
    claudeProjectsRoot: deepRoot,
    codexSessionsRoot: f.codex,
    databaseFile: path.join(f.root, "deep.sqlite"),
    installationId: "install-test",
    sequence: { next: async () => 1 },
    outbox: { enqueue: async () => { throw new Error("unused"); } } as never,
    emit: async () => undefined,
    now: () => epoch,
  });
  const deepHandle = await deepWatcher.start();
  t.after(() => deepHandle.stop());
  assert.equal(deepHandle.getSnapshot().provider_coverage.claude.status, "partial");
  assert.ok(deepHandle.getDiagnostics().codes.includes("usage_claude_file_scan_limited"));
});

test("derived integer overflow degrades cache quality without blocking later source rows", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.claude, "session.jsonl");
  await writeFile(file, "");
  const emitted: UsageSnapshotMessage[] = [];
  const watcher = new UsageWatcher({
    claudeProjectsRoot: f.claude,
    codexSessionsRoot: f.codex,
    databaseFile: f.databaseFile,
    installationId: "install-test",
    sequence: { next: async () => emitted.length + 1 },
    outbox: { enqueue: async () => { throw new Error("unused"); } } as never,
    emit: async (message) => { emitted.push(message); },
    now: () => epoch,
  });
  const handle = await watcher.start();
  t.after(() => handle.stop());
  await appendFile(file, claudeRow({ id: "overflow", input: Number.MAX_SAFE_INTEGER, cached: 1, creation: 0, output: 0 }));
  await appendFile(file, claudeRow({ id: "later-safe", input: 1, cached: 0, creation: 0, output: 1 }));
  const usage = await poll(watcher);
  assert.equal(usage.observed_responses, 2);
  assert.deepEqual(usage.total_input, { value: 1, quality: "partial" }, "only the safe subtotal is retained");
  assert.deepEqual(usage.cache_hit, { numerator: 0, denominator: 1, quality: "partial", providers: ["claude"], sample_responses: 1 }, "the safe cache subset survives an excluded overflow row");
  assert.ok(usage.provider_coverage.claude.status === "partial");
  assert.equal(validateUsageAggregate(usage).success, true);
  assert.equal(emitted.length, 2, "the overflow aggregate is still delivered after the initial snapshot");
  assert.ok(handle.getDiagnostics().numeric_overflows > 0);
  assert.ok(handle.getDiagnostics().codes.includes("usage_numeric_overflow"));
});

test("cache ratio keeps valid cross-provider samples around unsafe rows", async (t) => {
  const f = await fixture(t);
  const claudeFile = path.join(f.claude, "session.jsonl");
  const codexFile = path.join(f.codex, "rollout-cache.jsonl");
  await writeFile(claudeFile, "");
  await writeFile(codexFile, "");
  const watcher = f.makeWatcher();
  const handle = await watcher.start();
  t.after(() => handle.stop());
  const unsafeClaude = claudeRow({ id: "bad-before", input: Number.MAX_SAFE_INTEGER, cached: 1, creation: 0, output: 0 });
  await appendFile(claudeFile, unsafeClaude);
  await appendFile(codexFile, JSON.stringify({ type: "token_usage_record", timestamp: stamp, payload: {
    thread_id: "thread-cache", response_id: "good-cache", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 1 },
  } }) + "\n");
  await appendFile(claudeFile, claudeRow({ id: "bad-after", input: Number.MAX_SAFE_INTEGER, cached: 1, creation: 0, output: 0 }));

  const usage = await poll(watcher);
  assert.deepEqual(usage.cache_hit, { numerator: 4, denominator: 10, quality: "partial", providers: ["codex"], sample_responses: 1 });
  assert.equal(validateUsageAggregate(usage).success, true);
});

test("cache accumulator overflow excludes only that row and later safe rows remain scoped", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.codex, "rollout-overflow.jsonl");
  await writeFile(file, "");
  const watcher = f.makeWatcher();
  const handle = await watcher.start();
  t.after(() => handle.stop());
  const appendCodex = async (id: string, input: number, cached: number) => appendFile(file, JSON.stringify({
    type: "token_usage_record", timestamp: stamp,
    payload: { thread_id: "thread-overflow", response_id: id, usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: 1 } },
  }) + "\n");
  await appendCodex("safe-before", 8_000_000_000_000_000, 4_000_000_000_000_000);
  await appendCodex("over-aggregate", 2_000_000_000_000_000, 1_000_000_000_000_000);
  await appendCodex("safe-after", 1_000_000_000_000_000, 500_000_000_000_000);

  const usage = await poll(watcher);
  assert.deepEqual(usage.cache_hit, {
    numerator: 4_500_000_000_000_000,
    denominator: 9_000_000_000_000_000,
    quality: "partial",
    providers: ["codex"],
    sample_responses: 2,
  });
  assert.equal(validateUsageAggregate(usage).success, true);
});

test("oversized rows are bounded and diagnostic output is fixed-code only", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.claude, "session.jsonl"), "");
  const watcher = new UsageWatcher({
    claudeProjectsRoot: f.claude,
    codexSessionsRoot: f.codex,
    databaseFile: f.databaseFile,
    installationId: "install-test",
    sequence: { next: async () => 1 },
    outbox: { enqueue: async () => { throw new Error("unused"); } } as never,
    emit: async () => undefined,
    now: () => epoch,
    maxLineBytes: 128,
  });
  const handle = await watcher.start();
  t.after(() => handle.stop());
  await appendFile(path.join(f.claude, "session.jsonl"), `${"x".repeat(1000)}\n`);
  await poll(watcher);
  const diagnostics = handle.getDiagnostics();
  assert.equal(diagnostics.oversized_rows, 1);
  assert.deepEqual(diagnostics.codes, ["usage_claude_oversized_row"]);
  assert.equal((await readFile(f.databaseFile)).includes("session-a"), false, "ledger does not contain raw source identities");
});

test("Codex quota keeps a collector-start baseline only for the same account window", async (t) => {
  const f = await fixture(t);
  let now = epoch;
  let usagePercent = 20;
  let reset = 1_900_000_000;
  let account = "account-a";
  let fail = false;
  const watcher = f.makeWatcher({
    now: () => now,
    codexBinary: "test-codex",
    quotaReader: async (_binary, nowMs) => fail ? undefined : ({
      used_percent: usagePercent, reset_at: new Date(reset * 1000).toISOString(), window_minutes: 10_080,
      window: "primary", sampled_at: new Date(nowMs).toISOString(), account_key: account,
    }),
  });
  const handle = await watcher.start();
  t.after(() => handle.stop());
  assert.equal(handle.getSnapshot().quota.start_remaining, 80);
  assert.equal(handle.getSnapshot().quota.current_remaining, 80);
  usagePercent = 35;
  now += 60_001;
  await poll(watcher);
  assert.equal(handle.getSnapshot().quota.start_remaining, 80);
  assert.equal(handle.getSnapshot().quota.current_remaining, 65);

  account = "account-b";
  reset += 10_000;
  now += 60_001;
  await poll(watcher);
  const changed = handle.getSnapshot().quota;
  assert.equal(changed.start_remaining, null, "account/window changes never establish a replacement start baseline");
  assert.equal(changed.start_sampled_at, new Date(epoch).toISOString());
  assert.equal(changed.availability, "available");

  fail = true;
  now = reset * 1000 + 1;
  await poll(watcher);
  const stale = handle.getSnapshot().quota;
  assert.equal(stale.availability, "stale");
  assert.equal(stale.current_remaining, null, "an expired prior quota is never presented as current");
  assert.equal(validateUsageAggregate(handle.getSnapshot()).success, true);
});

test("same-account reset jitter preserves startup quota only within five seconds while both resets remain future", async (t) => {
  const f = await fixture(t);
  const baseResetMs = epoch + 86_400_000;
  const run = async (name: string, resetJitterMs: number, elapsedMs: number, expectedStart: number | null) => {
    let now = epoch;
    let resetAtMs = baseResetMs;
    let usedPercent = 56;
    const watcher = f.makeWatcher({
      databaseFile: path.join(f.root, "quota-" + name + ".sqlite"),
      now: () => now,
      codexBinary: "test-codex",
      quotaReader: async (_binary, nowMs) => ({
        used_percent: usedPercent,
        reset_at: new Date(resetAtMs).toISOString(),
        window_minutes: 10_080,
        window: "primary",
        sampled_at: new Date(nowMs).toISOString(),
        account_key: "same-account-key",
      }),
    });
    const handle = await watcher.start();
    t.after(() => handle.stop());
    const originalStartReset = new Date(baseResetMs).toISOString();
    assert.equal(handle.getSnapshot().quota.start_remaining, 44);
    now += elapsedMs;
    resetAtMs = baseResetMs + resetJitterMs;
    usedPercent = 57;
    await poll(watcher);
    const quota = handle.getSnapshot().quota;
    assert.equal(quota.start_remaining, expectedStart);
    assert.equal(quota.start_reset_at, originalStartReset);
    assert.equal(quota.reset_at, new Date(resetAtMs).toISOString(), "current reset metadata preserves the source timestamp");
    assert.equal(validateUsageAggregate(handle.getSnapshot()).success, true);
  };

  await run("within-boundary", 5_000, 60_001, 44);
  await run("outside-boundary", 5_001, 60_001, null);
  await run("already-expired", 2_000, 86_401_000, null);
});

test("a failed startup quota read never becomes a later start baseline", async (t) => {
  const f = await fixture(t);
  let now = epoch;
  let failed = true;
  const watcher = f.makeWatcher({
    now: () => now,
    codexBinary: "test-codex",
    quotaReader: async (_binary, nowMs) => failed ? undefined : ({
      used_percent: 40,
      reset_at: new Date(nowMs + 86_400_000).toISOString(),
      window_minutes: 10_080,
      window: "primary",
      sampled_at: new Date(nowMs).toISOString(),
      account_key: "hashed-account-key",
    }),
  });
  const handle = await watcher.start();
  t.after(() => handle.stop());
  const unavailable = handle.getSnapshot().quota;
  assert.equal(unavailable.availability, "unavailable");
  assert.equal(validateUsageAggregate(handle.getSnapshot()).success, true);

  failed = false;
  now += 60_001;
  await poll(watcher);
  const recovered = handle.getSnapshot().quota;
  assert.equal(recovered.availability, "available");
  assert.equal(recovered.start_remaining, null);
  assert.equal(recovered.current_remaining, 60);
  assert.equal(recovered.start_sampled_at, undefined);
  assert.equal(recovered.start_reset_at, undefined);
  assert.equal(validateUsageAggregate(handle.getSnapshot()).success, true);

  failed = true;
  now += 60_001;
  await poll(watcher);
  const stale = handle.getSnapshot().quota;
  assert.equal(stale.availability, "stale");
  assert.equal(stale.start_remaining, null);
  assert.equal(stale.current_remaining, 60);
  assert.equal(stale.start_sampled_at, undefined);
  assert.equal(validateUsageAggregate(handle.getSnapshot()).success, true);
});

test("Codex cache ratio exposes a scope when another provider has incomplete coverage", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.codex, "rollout-partial.jsonl");
  await writeFile(file, "");
  const watcher = f.makeWatcher();
  const handle = await watcher.start();
  t.after(() => handle.stop());
  await appendFile(file, JSON.stringify({ type: "token_usage_record", timestamp: stamp, payload: {
    thread_id: "thread-safe", response_id: "response-safe", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 },
  } }) + "\n");
  await appendFile(path.join(f.claude, "incomplete.jsonl"), claudeRow({ id: "missing-cache", omitCached: true }));
  const usage = await poll(watcher);
  assert.deepEqual(usage.cache_hit, { numerator: 4, denominator: 10, quality: "partial", providers: ["codex"], sample_responses: 1 });
  assert.equal(validateUsageAggregate(usage).success, true);
});
