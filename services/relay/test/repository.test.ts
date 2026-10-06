import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { InMemoryRelayRepository, SqliteRelayRepository } from "../src/repository.js";
import type { EventEnvelope } from "../src/types.js";

function event(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    type: "event",
    schema_version: 1,
    event_id: "event-1",
    installation_id: "install-1",
    session_id: "session-1",
    sequence: 1,
    occurred_at: "2026-10-02T00:00:00.000Z",
    event_type: "session_started",
    payload: { text: "do not log this" },
    ...overrides,
  };
}

test("in-memory repository tracks sequence status and deduplicates event_id", () => {
  const repository = new InMemoryRelayRepository();

  const first = repository.recordEvent(event(), "2026-10-02T00:00:01.000Z");
  assert.equal(first.duplicate, false);
  assert.equal(first.sequence_status, "initial");
  assert.equal(first.last_sequence, 1);
  assert.equal(first.next_sequence, 2);

  const second = repository.recordEvent(
    event({ event_id: "event-2", sequence: 2, event_type: "task_started" }),
    "2026-10-02T00:00:02.000Z",
  );
  assert.equal(second.sequence_status, "in_order");
  assert.equal(second.last_sequence, 2);

  const gap = repository.recordEvent(
    event({ event_id: "event-4", sequence: 4, event_type: "waiting" }),
    "2026-10-02T00:00:04.000Z",
  );
  assert.equal(gap.sequence_status, "gap");
  assert.equal(gap.last_sequence, 4);

  const late = repository.recordEvent(
    event({ event_id: "event-3", sequence: 3, event_type: "tool_finished" }),
    "2026-10-02T00:00:05.000Z",
  );
  assert.equal(late.sequence_status, "out_of_order");
  assert.equal(late.last_sequence, 4);
  assert.equal(repository.getInstallationState("install-1", "2026-10-02T00:00:05.000Z")?.claude_state, "waiting");

  const duplicate = repository.recordEvent(event(), "2026-10-02T00:00:06.000Z");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.stored.received_at, "2026-10-02T00:00:01.000Z");
  assert.equal(repository.listEventsAfter("install-1", 2).map((item) => item.event.sequence).join(","), "3,4");
});

test("connection status transitions from online to stale to offline", () => {
  const repository = new InMemoryRelayRepository();
  repository.registerConnection({
    connection_id: "conn-1",
    gateway: "collector",
    client_id: "collector-1",
    installation_id: "install-1",
    connected_at: "2026-10-02T00:00:00.000Z",
  });

  assert.equal(repository.connectionStatusForInstallation("install-1"), "online");
  assert.equal(
    repository.refreshConnectionStatuses("2026-10-02T00:00:10.000Z", 5_000, 20_000),
    true,
  );
  assert.equal(repository.connectionStatusForInstallation("install-1"), "stale");
  assert.equal(
    repository.refreshConnectionStatuses("2026-10-02T00:00:21.000Z", 5_000, 20_000),
    true,
  );
  assert.equal(repository.connectionStatusForInstallation("install-1"), "offline");

  repository.touchConnection("conn-1", "2026-10-02T00:00:22.000Z");
  assert.equal(repository.connectionStatusForInstallation("install-1"), "online");
  repository.disconnectConnection("conn-1", "2026-10-02T00:00:23.000Z");
  assert.equal(repository.connectionStatusForInstallation("install-1"), "offline");
});

test("pairing records are claimable once and expire", () => {
  const repository = new InMemoryRelayRepository();
  const pairing = repository.createPairing("2026-10-02T00:00:00.000Z", 1_000);
  assert.equal(repository.claimPairing(pairing.pairing_id, "wrong", "2026-10-02T00:00:00.100Z"), false);
  assert.equal(repository.claimPairing(pairing.pairing_id, pairing.code, "2026-10-02T00:00:00.200Z"), true);
  assert.equal(repository.claimPairing(pairing.pairing_id, pairing.code, "2026-10-02T00:00:00.300Z"), false);

  const expiring = repository.createPairing("2026-10-02T00:00:00.000Z", 1_000);
  assert.equal(repository.getPairing(expiring.pairing_id, "2026-10-02T00:00:01.001Z")?.status, "expired");
});

test("identified sessions aggregate across interleaved events with all-session counts and Top 5", () => {
  const repository = new InMemoryRelayRepository();
  const base = Date.parse("2026-10-02T00:00:00.000Z");
  let globalSequence = 0;
  const put = (session: string, _sequence: number, event_type: EventEnvelope["event_type"], offset: number, task_id?: string) => {
    globalSequence += 1;
    repository.recordEvent(event({
      event_id: `${session}-${globalSequence}`,
      session_id: session,
      sequence: globalSequence,
      event_type,
      occurred_at: new Date(base + offset).toISOString(),
      ...(task_id ? { task_id } : {}),
      ...(event_type === "session_started" ? { session_title: `Title ${session}` } : {}),
    }), new Date(base + offset).toISOString());
  };

  for (let index = 1; index <= 6; index += 1) {
    put(`session-${index}`, 1, "session_started", index * 10);
  }
  put("session-1", 7, "task_started", 100, "task-current");
  const aggregate = repository.getInstallationState("install-1", new Date(base + 200).toISOString());
  assert.equal(aggregate?.claude_state, "working");
  assert.equal(aggregate?.session_count, 6);
  assert.equal(aggregate?.running_count, 1);
  assert.deepEqual(aggregate?.sessions?.map((row) => row.session_id), ["session-1", "session-6", "session-5", "session-4", "session-3"]);

  put("session-1", 8, "task_finished", 150, "task-old");
  assert.equal(repository.getInstallationState("install-1", new Date(base + 200).toISOString())?.claude_state, "working");
  put("session-1", 9, "task_started", 160, "task-current");
  assert.equal(repository.getInstallationState("install-1", new Date(base + 200).toISOString())?.sessions?.[0]?.last_activity_sequence, 9);

  put("session-1", 10, "task_finished", 200, "task-current");
  put("session-6", 11, "session_ended", 210);
  const afterEnd = repository.getInstallationState("install-1", new Date(base + 250).toISOString());
  assert.equal(afterEnd?.session_count, 5);
  assert.equal(afterEnd?.running_count, 0);
  assert.equal(afterEnd?.recent_completion?.display_name, "Title session-1");
  assert.equal(repository.getInstallationState("install-1", new Date(base + 5_300).toISOString())?.recent_completion, undefined);

  const expired = repository.getInstallationState("install-1", new Date(base + 2 * 60 * 60 * 1000 + 500).toISOString());
  assert.equal(expired?.session_count, 0);
  assert.deepEqual(expired?.sessions, []);
});

test("unknown session ids retain legacy snapshots without entering identified aggregates", () => {
  const repository = new InMemoryRelayRepository();
  repository.recordEvent(event({ session_id: "identified", sequence: 1 }), "2026-10-02T00:00:00.000Z");
  repository.recordEvent(event({
    event_id: "unknown-event",
    session_id: "unknown",
    sequence: 2,
    event_type: "task_started",
  }), "2026-10-02T00:00:01.000Z");
  const state = repository.getInstallationState("install-1", "2026-10-02T00:00:02.000Z");
  assert.equal(state?.claude_state, "idle");
  assert.equal(state?.session_count, 1);
  assert.equal(state?.running_count, 0);
  assert.deepEqual(state?.sessions?.map((session) => session.session_id), ["identified"]);

  const legacyOnly = new InMemoryRelayRepository();
  legacyOnly.recordEvent(event({ session_id: "unknown", event_type: "task_started" }), "2026-10-02T00:00:00.000Z");
  const legacyState = legacyOnly.getInstallationState("install-1", "2026-10-02T00:00:01.000Z");
  assert.equal(legacyState?.claude_state, "working");
  assert.equal(legacyState?.sessions, undefined);
});

test("newer SessionStart reactivates an ended id while stale or other events cannot", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-session-resume-"));
  const memory = new InMemoryRelayRepository();
  const sqlite = new SqliteRelayRepository(join(directory, "relay.sqlite"));
  try {
    for (const repository of [memory, sqlite]) {
      const record = (
        event_id: string,
        sequence: number,
        event_type: EventEnvelope["event_type"],
        session_title?: string,
      ) => repository.recordEvent(event({
        event_id,
        session_id: "resumed-session",
        sequence,
        event_type,
        ...(session_title ? { session_title } : {}),
      }), "2026-10-02T00:00:00.000Z");

      record("resume-1", 1, "session_started", "Original");
      record("resume-2", 2, "session_ended");
      record("resume-3", 3, "task_started", undefined);
      let state = repository.getInstallationState("install-1", "2026-10-02T00:00:01.000Z");
      assert.equal(state?.session_count, 0);
      assert.deepEqual(state?.sessions, []);

      record("resume-4", 4, "session_started", "Restarted");
      state = repository.getInstallationState("install-1", "2026-10-02T00:00:01.000Z");
      assert.equal(state?.session_count, 1);
      assert.equal(state?.sessions?.[0]?.title, "Restarted");
      assert.equal(state?.sessions?.[0]?.claude_state, "idle");
    }
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("task-scoped tool events cannot replace or finish newer tasks and failures are not completions", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-task-events-"));
  const memory = new InMemoryRelayRepository();
  const sqlite = new SqliteRelayRepository(join(directory, "relay.sqlite"));
  try {
    for (const repository of [memory, sqlite]) {
      let sequence = 0;
      const record = (event_type: EventEnvelope["event_type"], task_id?: string) => {
        sequence += 1;
        repository.recordEvent(event({
          event_id: `task-event-${sequence}`,
          session_id: "task-session",
          sequence,
          event_type,
          ...(task_id ? { task_id } : {}),
          ...(event_type === "session_started" ? { session_title: "Task Session" } : {}),
        }), "2026-10-02T00:00:00.000Z");
        return repository.getInstallationState("install-1", "2026-10-02T00:00:01.000Z");
      };

      record("session_started");
      record("task_started", "task-old");
      record("task_started", "task-new");
      record("waiting", "task-new");
      assert.equal(record("tool_started", "task-old")?.claude_state, "waiting");
      assert.equal(record("tool_finished", "task-old")?.claude_state, "waiting");
      assert.equal(record("tool_started", "task-new")?.claude_state, "working");
      assert.equal(record("tool_finished", "task-new")?.claude_state, "working");

      const finished = record("task_finished", "task-new");
      assert.equal(finished?.claude_state, "idle");
      assert.equal(finished?.recent_completion?.task_id, "task-new");
      assert.equal(finished?.recent_completion?.display_name, "Task Session");

      record("task_started", "task-fails");
      const failed = record("task_failed", "task-fails");
      assert.equal(failed?.claude_state, "idle");
      assert.equal(failed?.recent_completion, undefined);
    }
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("completed tasks stay idle through tool tails after recent_completion TTL in memory and SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-terminal-task-"));
  const memory = new InMemoryRelayRepository();
  const sqlite = new SqliteRelayRepository(join(directory, "relay.sqlite"));
  const base = Date.parse("2026-10-02T00:00:00.000Z");
  try {
    for (const repository of [memory, sqlite]) {
      let globalSequence = 0;
      const record = (
        session_id: string,
        event_type: EventEnvelope["event_type"],
        task_id?: string,
      ) => {
        globalSequence += 1;
        const occurred_at = new Date(base + globalSequence * 100).toISOString();
        repository.recordEvent(event({
          event_id: `terminal-${globalSequence}`,
          session_id,
          sequence: globalSequence,
          event_type,
          occurred_at,
          ...(task_id ? { task_id } : {}),
          ...(event_type === "session_started" ? { session_title: session_id } : {}),
        }), occurred_at);
        return repository.getInstallationState("install-1", occurred_at);
      };

      record("finished-session", "session_started");
      record("finished-session", "task_started", "task-done");
      const finished = record("finished-session", "task_finished", "task-done");
      assert.equal(finished?.claude_state, "idle");
      assert.equal(finished?.running_count, 0);
      assert.equal(finished?.recent_completion?.task_id, "task-done");

      record("other-session", "session_started");
      let otherWork = record("other-session", "task_started", "task-other");
      assert.equal(otherWork?.claude_state, "working");
      assert.equal(otherWork?.running_count, 1);

      // Stop may deliver tool_finished with a newer sequence and without task_id.
      let afterToolTail = record("finished-session", "tool_finished");
      assert.equal(afterToolTail?.sessions?.find((item) => item.session_id === "finished-session")?.claude_state, "idle");
      assert.equal(afterToolTail?.running_count, 1);
      assert.equal(afterToolTail?.claude_state, "working");
      const afterTtl = repository.getInstallationState("install-1", new Date(base + 6_000).toISOString());
      assert.equal(afterTtl?.recent_completion, undefined);
      assert.equal(afterTtl?.sessions?.find((item) => item.session_id === "finished-session")?.claude_state, "idle");
      assert.equal(afterTtl?.running_count, 1);
      assert.equal(afterTtl?.claude_state, "working");

      record("finished-session", "task_started", "task-next");
      afterToolTail = record("finished-session", "tool_started", "task-next");
      assert.equal(afterToolTail?.sessions?.find((item) => item.session_id === "finished-session")?.claude_state, "working");
      assert.equal(afterToolTail?.running_count, 2);

      record("failed-session", "session_started");
      record("failed-session", "task_started", "task-failed");
      record("failed-session", "task_failed", "task-failed");
      record("failed-session", "tool_started");
      const failedTail = record("failed-session", "tool_finished");
      assert.equal(failedTail?.sessions?.find((item) => item.session_id === "failed-session")?.claude_state, "idle");
      assert.notEqual(failedTail?.recent_completion?.session_id, "failed-session");

      // A finished session remains idle while another session keeps the aggregate working.
      otherWork = record("other-session", "tool_started", "task-other");
      assert.equal(otherWork?.claude_state, "working");
      assert.equal(otherWork?.running_count, 2); // The restarted task and task-other are active.
    }
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("successful completion remains visible for five seconds after session end and SQLite restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-ended-completion-"));
  const dbPath = join(directory, "relay.sqlite");
  const base = Date.parse("2026-10-02T00:00:00.000Z");
  const recordLifecycle = (repository: InMemoryRelayRepository | SqliteRelayRepository) => {
    const events: Array<{ event_type: EventEnvelope["event_type"]; sequence: number; task_id?: string }> = [
      { event_type: "session_started", sequence: 1 },
      { event_type: "task_started", sequence: 2, task_id: "task-done" },
      { event_type: "task_finished", sequence: 3, task_id: "task-done" },
      { event_type: "session_ended", sequence: 4 },
    ];
    events.forEach((item, index) => {
      const occurredAt = new Date(base + index * 100).toISOString();
      repository.recordEvent(event({
        event_id: `completion-${item.sequence}`,
        session_id: "ended-session",
        sequence: item.sequence,
        event_type: item.event_type,
        occurred_at: occurredAt,
        ...(item.task_id ? { task_id: item.task_id } : {}),
        ...(item.event_type === "session_started" ? { session_title: "Finished Work" } : {}),
      }), occurredAt);
    });
  };

  const memory = new InMemoryRelayRepository();
  let sqlite: SqliteRelayRepository | undefined;
  try {
    sqlite = new SqliteRelayRepository(dbPath);
    for (const repository of [memory, sqlite]) {
      recordLifecycle(repository);
      const recent = repository.getInstallationState("install-1", new Date(base + 2_000).toISOString());
      assert.equal(recent?.session_count, 0);
      assert.deepEqual(recent?.sessions, []);
      assert.equal(recent?.recent_completion?.task_id, "task-done");
      assert.equal(recent?.recent_completion?.display_name, "Finished Work");
    }

    sqlite.close();
    sqlite = new SqliteRelayRepository(dbPath);
    const restartedRecent = sqlite.getInstallationState("install-1", new Date(base + 2_000).toISOString());
    assert.equal(restartedRecent?.recent_completion?.task_id, "task-done");
    assert.equal(restartedRecent?.recent_completion?.display_name, "Finished Work");

    for (const repository of [memory, sqlite]) {
      const expired = repository.getInstallationState("install-1", new Date(base + 5_201).toISOString());
      assert.equal(expired?.recent_completion, undefined);
      assert.equal(expired?.session_count, 0);
    }
  } finally {
    sqlite?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite session state survives restart and old databases migrate additively", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-sessions-"));
  const dbPath = join(directory, "relay.sqlite");
  try {
    const first = new SqliteRelayRepository(dbPath);
    first.recordEvent(event({ session_id: "session-A", session_title: "A safe title", sequence: 1 }), "2026-10-02T00:00:00.000Z");
    first.recordEvent(event({ event_id: "event-2", session_id: "session-B", sequence: 2, event_type: "task_started", task_id: "task-B" }), "2026-10-02T00:00:01.000Z");
    first.close();

    const restarted = new SqliteRelayRepository(dbPath);
    const state = restarted.getInstallationState("install-1", "2026-10-02T00:00:02.000Z");
    assert.equal(state?.session_count, 2);
    assert.equal(state?.running_count, 1);
    assert.equal(state?.sessions?.[0]?.session_id, "session-B");
    assert.equal(state?.sessions?.[1]?.title, "A safe title");
    restarted.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite migration rebuilds per-session state from legacy event storage", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-old-db-"));
  const dbPath = join(directory, "relay.sqlite");
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE relay_events (
        event_id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        event_json TEXT NOT NULL, received_at TEXT NOT NULL, UNIQUE (installation_id, sequence)
      );
      CREATE TABLE relay_installations (
        installation_id TEXT PRIMARY KEY, last_sequence INTEGER, claude_state TEXT NOT NULL,
        activity_json TEXT, updated_at TEXT NOT NULL
      );
    `);
    const start = event({ session_id: "legacy-session", session_title: "Legacy", sequence: 1 });
    const work = event({ event_id: "event-2", session_id: "legacy-session", sequence: 2, event_type: "task_started", task_id: "legacy-task" });
    for (const item of [start, work]) {
      legacy.prepare("INSERT INTO relay_events VALUES (?, ?, ?, ?, ?)").run(item.event_id, item.installation_id, item.sequence, JSON.stringify(item), item.occurred_at);
    }
    legacy.prepare("INSERT INTO relay_installations VALUES (?, ?, ?, ?, ?)").run(
      "install-1", 2, "working", JSON.stringify({ event_type: "task_started", session_id: "legacy-session", task_id: "legacy-task", occurred_at: work.occurred_at }), work.occurred_at,
    );
    legacy.close();

    const migrated = new SqliteRelayRepository(dbPath);
    const state = migrated.getInstallationState("install-1", "2026-10-02T00:00:02.000Z");
    assert.equal(state?.session_count, 1);
    assert.equal(state?.running_count, 1);
    assert.equal(state?.sessions?.[0]?.session_id, "legacy-session");
    assert.equal(state?.sessions?.[0]?.title, "Legacy");
    migrated.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
