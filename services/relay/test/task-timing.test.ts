import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { InMemoryRelayRepository, SqliteRelayRepository, type RelayRepository } from "../src/repository.js";
import { Relay } from "../src/relay.js";
import type { EventEnvelope, ServerMessage } from "../src/types.js";

const originMs = Date.parse("2026-10-07T00:00:00.000Z");
const at = (milliseconds: number) => new Date(originMs + milliseconds).toISOString();

function event(eventType: EventEnvelope["event_type"], sequence: number, milliseconds: number,
  overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  const installationId = overrides.installation_id ?? "install-1";
  return {
    type: "event", schema_version: 1, event_id: `${installationId}:${sequence}`, installation_id: installationId,
    session_id: "session-a", task_id: "task-a", sequence, occurred_at: at(milliseconds), event_type: eventType, payload: {},
    ...overrides,
  };
}

function repositoryCases(name: string, check: (repository: RelayRepository) => void): void {
  for (const storage of ["memory", "sqlite"] as const) {
    test(`${name} (${storage})`, (context) => {
      const directory = storage === "sqlite" ? mkdtempSync(join(tmpdir(), "relay-task-timing-")) : undefined;
      const repository: RelayRepository = directory ? new SqliteRelayRepository(join(directory, "relay.sqlite")) : new InMemoryRelayRepository();
      context.after(() => {
        repository.close?.();
        if (directory) rmSync(directory, { recursive: true, force: true });
      });
      check(repository);
    });
  }
}

repositoryCases("interleaved tasks retain their own start through waiting and tool failure", (repository) => {
  const record = (value: EventEnvelope) => repository.recordEvent(value, value.occurred_at);
  record(event("task_started", 1, 0));
  record(event("task_started", 2, 120_000, { session_id: "session-b", task_id: "task-b" }));
  record(event("waiting", 3, 180_000, { payload: { reason: "permission" } }));
  record(event("tool_failed", 4, 210_000, { payload: { duration_ms: 10 } }));
  const during = repository.getInstallationState("install-1", at(240_000));
  assert.deepEqual(during?.active_tasks?.map((task) => [task.session_id, task.elapsed_ms]), [["session-a", 240_000], ["session-b", 120_000]]);
  const finishB = record(event("task_finished", 5, 300_000, { session_id: "session-b", task_id: "task-b", payload: { duration_ms: 999_999 } }));
  assert.deepEqual(finishB.stored.event.payload, { duration_ms: 180_000 });
  const finishA = record(event("task_finished", 6, 300_001, { task_id: undefined }));
  assert.deepEqual(finishA.stored.event.payload, { duration_ms: 300_001 });
  const final = repository.getInstallationState("install-1", at(300_001));
  assert.equal(final?.recent_completion?.duration_ms, 300_001);
  assert.equal(final?.recent_completion?.task_id, "task-a");
  assert.deepEqual(final?.active_tasks, []);
});

repositoryCases("timing preserves the five-minute boundary exactly", (repository) => {
  for (const duration of [299_999, 300_000, 300_001]) {
    const installationId = `duration-${duration}`;
    repository.recordEvent(event("task_started", 1, 0, { installation_id: installationId }), at(0));
    const outcome = repository.recordEvent(event("task_finished", 2, duration, { installation_id: installationId }), at(duration));
    assert.deepEqual(outcome.stored.event.payload, { duration_ms: duration });
    assert.equal(repository.getInstallationState(installationId, at(duration))?.recent_completion?.duration_ms, duration);
  }
});

repositoryCases("active timing includes every main task and never invents starts from tools", (repository) => {
  for (let index = 0; index < 6; index += 1) {
    repository.recordEvent(event("task_started", index + 1, index * 1000, {
      session_id: `main-${index}`, task_id: `task-${index}`, session_kind: "main",
    }), at(index * 1000));
  }
  repository.recordEvent(event("task_started", 7, 0, { session_id: "child", task_id: "child-task", session_kind: "subagent" }), at(0));
  repository.recordEvent(event("tool_started", 8, 0, { session_id: "start-not-observed", task_id: undefined }), at(0));
  const state = repository.getInstallationState("install-1", at(300_001));
  assert.equal(state?.sessions?.length, 5);
  assert.equal(state?.active_tasks?.length, 6);
  assert.equal(state?.active_tasks?.some((task) => task.session_id === "main-0"), true, "oldest active task is outside the top five rows");
  assert.equal(state?.active_tasks?.some((task) => task.session_id === "child"), false);
  assert.equal(state?.active_tasks?.some((task) => task.session_id === "start-not-observed"), false);
  for (const task of state?.active_tasks ?? []) assert.equal(Number.isSafeInteger(task.elapsed_ms) && task.elapsed_ms >= 0, true);
});

repositoryCases("duplicates, old sequences and task mismatches cannot reset or finish current timing", (repository) => {
  const record = (value: EventEnvelope) => repository.recordEvent(value, value.occurred_at);
  const start = event("task_started", 1, 0);
  record(start);
  assert.equal(record(start).duplicate, true);
  record(event("task_started", 3, 100_000, { task_id: "next-task" }));
  assert.equal(record(event("task_started", 1, 200_000, { event_id: "late-old-start" })).conflict, true);
  record(event("task_started", 6, 400_000, { task_id: "next-task" }));
  const delayedStart = record(event("task_started", 4, 450_000, { task_id: "older-task" }));
  assert.equal(delayedStart.sequence_status, "out_of_order");
  assert.equal(delayedStart.activity_applied, false);
  assert.equal(record(event("task_finished", 7, 500_000, { task_id: "task-a", payload: { duration_ms: 500_000 } })).activity_applied, false);
  assert.equal(repository.getInstallationState("install-1", at(600_000))?.active_tasks?.[0]?.elapsed_ms, 500_000);
  const result = record(event("task_failed", 8, 600_000, { task_id: "next-task" }));
  assert.deepEqual(result.stored.event.payload, { duration_ms: 500_000 });
  assert.deepEqual(repository.getInstallationState("install-1", at(600_000))?.active_tasks, []);
  assert.equal(record(event("tool_started", 9, 610_000, { task_id: "next-task" })).activity_applied, false);
  assert.equal(record(event("task_finished", 10, 620_000, { task_id: "next-task" })).activity_applied, false);
  record(event("task_started", 11, 630_000, { task_id: "third-task" }));
  record(event("session_ended", 12, 640_000, { task_id: undefined }));
  assert.deepEqual(repository.getInstallationState("install-1", at(640_000))?.active_tasks, []);
});

repositoryCases("missing starts allow only safe supplied durations and invalid time differences are unknown", (repository) => {
  for (const duration of [300_001, 0, -1, "300001", 0.5, 86_400_001, null]) {
    const installationId = `provided-${typeof duration}-${String(duration)}`;
    const result = repository.recordEvent(event("task_finished", 1, 300_001, {
      installation_id: installationId, payload: { duration_ms: duration },
    }), at(300_001));
    const expected = duration === 300_001 || duration === 0 ? duration : undefined;
    assert.equal((result.stored.event.payload as { duration_ms?: number }).duration_ms, expected);
    assert.equal(repository.getInstallationState(installationId, at(300_001))?.recent_completion?.duration_ms, expected);
  }
  for (const occurredAt of [at(-1), "not-a-date", "2026-10-07", "2027-02-30T00:00:00.000Z"]) {
    const installationId = `invalid-end-${occurredAt}`;
    repository.recordEvent(event("task_started", 1, 0, { installation_id: installationId }), at(0));
    const result = repository.recordEvent(event("task_finished", 2, 300_001, {
      installation_id: installationId, occurred_at: occurredAt, payload: { duration_ms: 300_001 },
    }), at(300_001));
    assert.equal((result.stored.event.payload as { duration_ms?: number }).duration_ms, undefined);
  }
  repository.recordEvent(event("task_started", 1, 0, { installation_id: "invalid-start", occurred_at: "not-a-date" }), at(0));
  assert.deepEqual(repository.getInstallationState("invalid-start", at(100))?.active_tasks, []);
});

repositoryCases("clock skew and tasks longer than a day keep bounded nonnegative timing", (repository) => {
  repository.recordEvent(event("task_started", 1, 20_000), at(20_000));
  assert.equal(repository.getInstallationState("install-1", at(0))?.active_tasks?.[0]?.elapsed_ms, 0);
  const day = 86_400_000;
  repository.recordEvent(event("waiting", 2, day + 10_000), at(day + 10_000));
  assert.equal(repository.getInstallationState("install-1", at(day + 30_000))?.active_tasks?.[0]?.elapsed_ms, day);
  const finished = repository.recordEvent(event("task_finished", 3, day + 30_000), at(day + 30_000));
  assert.deepEqual(finished.stored.event.payload, { duration_ms: day });
  assert.equal(repository.getInstallationState("install-1", at(day + 30_000))?.recent_completion?.duration_ms, day);
});

test("SQLite restart retains task origins and enriched outcome wire events", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-task-timing-restart-"));
  const path = join(directory, "relay.sqlite");
  let repository = new SqliteRelayRepository(path);
  try {
    repository.recordEvent(event("task_started", 1, 0), at(0));
    repository.recordEvent(event("waiting", 2, 100_000, { payload: { reason: "question" } }), at(100_000));
    repository.close();
    repository = new SqliteRelayRepository(path);
    assert.equal(repository.getInstallationState("install-1", at(300_001))?.active_tasks?.[0]?.elapsed_ms, 300_001);
    repository.recordEvent(event("task_finished", 3, 300_001), at(300_001));
    repository.close();
    repository = new SqliteRelayRepository(path);
    assert.equal(repository.getInstallationState("install-1", at(300_001))?.recent_completion?.duration_ms, 300_001);
    assert.deepEqual(repository.findEvent("install-1:3")?.event.payload, { duration_ms: 300_001 });
    assert.deepEqual(repository.getInstallationState("install-1", at(300_001))?.active_tasks, []);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Relay sends trusted duration before its same-sequence snapshot and resumes it unchanged", () => {
  let nowMs = originMs;
  const relay = new Relay({ autoStart: false, now: () => new Date(nowMs) });
  const phoneMessages: ServerMessage[] = [];
  const collector = relay.connect({ gateway: "collector", installation_id: "install-1", transport: { send: () => {} } });
  const phone = relay.connect({ gateway: "android", installation_id: "install-1", transport: { send: (message) => phoneMessages.push(message) } });
  try {
    relay.receive(collector.connection_id, JSON.stringify(event("task_started", 1, 0)));
    nowMs += 300_001;
    assert.equal(relay.snapshot("install-1").active_tasks?.[0]?.elapsed_ms, 300_001);
    phoneMessages.length = 0;
    relay.receive(collector.connection_id, JSON.stringify(event("task_finished", 2, 300_001)));
    const outcome = phoneMessages.find((message) => message.type === "event");
    assert.ok(outcome && outcome.type === "event");
    assert.deepEqual(outcome.payload, { duration_ms: 300_001 });
    const snapshot = phoneMessages.find((message) => message.type === "snapshot");
    assert.ok(snapshot && snapshot.type === "snapshot");
    assert.equal(snapshot.recent_completion?.duration_ms, 300_001);
    assert.deepEqual(snapshot.active_tasks, []);
    phoneMessages.length = 0;
    relay.receive(phone.connection_id, JSON.stringify({ type: "resume", schema_version: 1, installation_id: "install-1", last_sequence: 1 }));
    const replay = phoneMessages.find((message) => message.type === "event");
    assert.ok(replay && replay.type === "event");
    assert.deepEqual(replay.payload, { duration_ms: 300_001 });
  } finally {
    relay.stop();
  }
});


repositoryCases("successful results stay complete after reminder expiry and reset only on new task lifecycle", (repository) => {
  const record = (value: EventEnvelope) => repository.recordEvent(value, value.occurred_at);
  record(event("session_started", 1, 0, { session_id: "unused", task_id: undefined }));
  record(event("task_started", 2, 0));
  record(event("task_finished", 3, 100));
  record(event("task_finished", 4, 200, { session_id: "session-b", task_id: "task-b" }));
  record(event("task_failed", 5, 300, { session_id: "failed", task_id: "failed-task" }));
  const expired = repository.getInstallationState("install-1", at(6_000));
  assert.equal(expired?.recent_completion, undefined);
  assert.deepEqual(Object.fromEntries(expired?.sessions?.map((row) => [row.session_id, row.task_completed]) ?? []), {
    failed: false, "session-b": true, "session-a": true, unused: false,
  });
  record(event("session_title_updated", 6, 6_001, { session_title: "Renamed release" }));
  record(event("tool_finished", 7, 6_002));
  assert.equal(repository.getInstallationState("install-1", at(6_003))?.sessions?.find((row) => row.session_id === "session-a")?.task_completed, true);
  record(event("task_started", 8, 6_010, { task_id: "next-task" }));
  const restarted = repository.getInstallationState("install-1", at(6_010))?.sessions?.find((row) => row.session_id === "session-a");
  assert.equal(restarted?.task_completed, false);
  assert.equal(restarted?.claude_state, "working");
  record(event("waiting", 9, 6_020, { task_id: "next-task", payload: { reason: "question" } }));
  assert.equal(repository.getInstallationState("install-1", at(6_020))?.sessions?.find((row) => row.session_id === "session-a")?.task_completed, false);
  record(event("task_failed", 10, 6_030, { task_id: "next-task" }));
  assert.equal(repository.getInstallationState("install-1", at(6_030))?.sessions?.find((row) => row.session_id === "session-a")?.task_completed, false);
  record(event("task_started", 11, 6_040, { task_id: "final-task" }));
  record(event("task_finished", 12, 6_050, { task_id: "final-task" }));
  assert.equal(repository.getInstallationState("install-1", at(12_000))?.sessions?.find((row) => row.session_id === "session-a")?.task_completed, true);
});

test("SQLite reopening keeps completed rows after the transient result expires", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-durable-done-"));
  const path = join(directory, "relay.sqlite");
  let repository = new SqliteRelayRepository(path);
  try {
    repository.recordEvent(event("task_finished", 1, 100), at(100));
    repository.recordEvent(event("task_finished", 2, 200, { session_id: "session-b", task_id: "task-b" }), at(200));
    repository.close();
    repository = new SqliteRelayRepository(path);
    const restored = repository.getInstallationState("install-1", at(10_000));
    assert.equal(restored?.recent_completion, undefined);
    assert.deepEqual(restored?.sessions?.map((row) => [row.session_id, row.task_completed]), [["session-b", true], ["session-a", true]]);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
