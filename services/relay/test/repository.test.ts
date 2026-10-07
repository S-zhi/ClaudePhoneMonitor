import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { InMemoryRelayRepository, SqliteRelayRepository } from "../src/repository.js";
import type { EventEnvelope, UsageAggregate, UsageSnapshotMessage } from "../src/types.js";

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

function usageMessage(overrides: Partial<UsageSnapshotMessage> = {}): UsageSnapshotMessage {
  const usage: UsageAggregate = {
    epoch_id: "epoch-a",
    started_at: "2026-10-07T00:00:00.000Z",
    revision: 1,
    observed_responses: 2,
    complete_responses: 2,
    provider_coverage: {
      claude: { status: "ready", observed_responses: 1, complete_responses: 1 },
      codex: { status: "ready", observed_responses: 1, complete_responses: 1 },
    },
    new_input: { value: 90, quality: "complete" },
    cached_input: { value: 10, quality: "complete" },
    output: { value: 20, quality: "complete" },
    actual: { value: 110, quality: "complete" },
    total_input: { value: 100, quality: "complete" },
    cache_hit: { numerator: 10, denominator: 100, quality: "complete" },
    quota: { start_remaining: null, current_remaining: null, unit: null, reset_at: null, availability: "unavailable" },
  };
  return {
    type: "usage_snapshot", schema_version: 1, event_id: "usage-1", installation_id: "install-1",
    sequence: 1, occurred_at: "2026-10-07T00:00:01.000Z", usage, ...overrides,
  };
}

test("usage aggregate is installation scoped, revisioned, and durable without session reduction", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-usage-revisions-"));
  const dbPath = join(directory, "relay.sqlite");
  const memory = new InMemoryRelayRepository();
  let sqlite: SqliteRelayRepository | undefined;
  const record = (repository: InMemoryRelayRepository | SqliteRelayRepository, message: UsageSnapshotMessage) =>
    repository.recordUsageSnapshot(message, "2026-10-07T00:00:01.100Z");
  try {
    sqlite = new SqliteRelayRepository(dbPath);
    for (const repository of [memory, sqlite]) {
      const first = usageMessage();
      assert.equal(record(repository, first).changed, true);
      assert.equal(repository.findEvent("usage-1"), undefined);
      const state = repository.getInstallationState("install-1");
      assert.equal(state?.last_sequence, 1);
      assert.equal(state?.claude_state, "idle");
      assert.equal(state?.activity, undefined);
      assert.equal(state?.sessions, undefined);

      assert.equal(record(repository, first).duplicate, true);
      const oldRevision = usageMessage({ event_id: "usage-older", sequence: 2, usage: { ...first.usage, revision: 0 } });
      assert.equal(record(repository, oldRevision).changed, false);
      const sameRevision = usageMessage({ event_id: "usage-same", sequence: 3, usage: { ...first.usage } });
      assert.equal(record(repository, sameRevision).changed, false);
      const newEpoch = usageMessage({ event_id: "usage-new-epoch", sequence: 4, usage: { ...first.usage, epoch_id: "epoch-b", revision: 99 } });
      assert.equal(record(repository, newEpoch).changed, false);
      const replacement = usageMessage({ event_id: "usage-2", sequence: 5, usage: { ...first.usage, revision: 2, actual: { value: 130, quality: "complete" }, output: { value: 40, quality: "complete" } } });
      assert.equal(record(repository, replacement).changed, true);
      assert.equal(repository.getInstallationState("install-1")?.usage?.actual.value, 130);
      repository.recordEvent(event({ event_id: "state-after-usage", sequence: 6 }), "2026-10-07T00:00:02.000Z");
      assert.equal(repository.getInstallationState("install-1")?.usage?.revision, 2);
      assert.equal(repository.getInstallationState("other-install")?.usage, undefined);
    }
    sqlite.close();
    sqlite = new SqliteRelayRepository(dbPath);
    assert.equal(sqlite.getInstallationState("install-1")?.usage?.revision, 2);
    assert.equal(sqlite.getInstallationState("install-1")?.claude_state, "idle");
  } finally {
    sqlite?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("usage event ID collisions are rejected while sequences and aggregates stay installation scoped", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-usage-installations-"));
  const sqlite = new SqliteRelayRepository(join(directory, "relay.sqlite"));
  try {
    const repositories = [new InMemoryRelayRepository(), sqlite];
    for (const repository of repositories) {
      const first = usageMessage({ installation_id: "install-a", event_id: "shared-usage-event", sequence: 1 });
      const collision = usageMessage({
        installation_id: "install-b",
        event_id: "shared-usage-event",
        sequence: 1,
        usage: { ...usageMessage().usage, epoch_id: "epoch-b", new_input: { value: 91, quality: "complete" }, actual: { value: 111, quality: "complete" }, total_input: { value: 101, quality: "complete" }, cache_hit: { numerator: 10, denominator: 101, quality: "complete" } },
      });
      assert.equal(repository.recordUsageSnapshot(first, "2026-10-07T00:00:01.100Z").changed, true);
      const collisionResult = repository.recordUsageSnapshot(collision, "2026-10-07T00:00:01.200Z");
      assert.equal(collisionResult.duplicate, false);
      assert.equal(collisionResult.conflict, true);
      assert.equal(repository.getInstallationState("install-a")?.usage?.epoch_id, "epoch-a");
      assert.equal(repository.getInstallationState("install-b")?.usage, undefined);

      const independent = usageMessage({
        installation_id: "install-b",
        event_id: "install-b:1",
        sequence: 1,
        usage: { ...collision.usage, epoch_id: "epoch-b" },
      });
      assert.equal(repository.recordUsageSnapshot(independent, "2026-10-07T00:00:01.300Z").changed, true);
      assert.equal(repository.getInstallationState("install-a")?.last_sequence, 1);
      assert.equal(repository.getInstallationState("install-b")?.last_sequence, 1);
      assert.equal(repository.getInstallationState("install-a")?.usage?.new_input.value, 90);
      assert.equal(repository.getInstallationState("install-b")?.usage?.new_input.value, 91);
    }
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("late Usage outbox revisions follow epoch revision while shared state cursor never moves backward", () => {
  const memory = new InMemoryRelayRepository();
  const sqlite = new SqliteRelayRepository(":memory:");
  try {
    for (const repository of [memory, sqlite]) {
      const status = repository.recordEvent(event({
        event_id: "status-ahead",
        sequence: 11,
        event_type: "task_started",
        task_id: "task-live",
      }), "2026-10-07T00:00:11.000Z");
      assert.equal(status.conflict, false);
      const activityBefore = repository.getInstallationState("install-1");

      const lateFirst = usageMessage({ event_id: "usage-late-first", sequence: 10 });
      const firstResult = repository.recordUsageSnapshot(lateFirst, "2026-10-07T00:00:12.000Z");
      assert.equal(firstResult.duplicate, false);
      assert.equal(firstResult.conflict, false);
      assert.equal(firstResult.changed, true);
      assert.equal(firstResult.sequence_status, "out_of_order");
      assert.equal(repository.getInstallationState("install-1")?.usage?.revision, 1);
      assert.equal(repository.getInstallationState("install-1")?.last_sequence, 11);

      const newerLate = usageMessage({
        event_id: "usage-late-newer",
        sequence: 9,
        usage: { ...lateFirst.usage, revision: 2, actual: { value: 120, quality: "complete" }, output: { value: 30, quality: "complete" } },
      });
      assert.equal(repository.recordUsageSnapshot(newerLate, "2026-10-07T00:00:13.000Z").changed, true);
      const staleHighSequence = usageMessage({
        event_id: "usage-stale-high-sequence",
        sequence: 12,
        usage: { ...lateFirst.usage, revision: 1 },
      });
      assert.equal(repository.recordUsageSnapshot(staleHighSequence, "2026-10-07T00:00:14.000Z").changed, false);

      const after = repository.getInstallationState("install-1");
      assert.equal(after?.usage?.revision, 2);
      assert.equal(after?.usage?.actual.value, 120);
      assert.equal(after?.last_sequence, 12);
      assert.equal(after?.claude_state, activityBefore?.claude_state);
      assert.deepEqual(after?.activity, activityBefore?.activity);
      assert.equal(after?.recent_completion, activityBefore?.recent_completion);
    }
  } finally {
    sqlite.close();
  }
});

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

test("only exact persisted event identities are duplicate; sequence collisions are rejected", () => {
  const memory = new InMemoryRelayRepository();
  const sqlite = new SqliteRelayRepository(":memory:");
  try {
    for (const repository of [memory, sqlite]) {
      const first = event({ installation_id: "install-a", event_id: "event-a-1", sequence: 1 });
      const accepted = repository.recordEvent(first, "2026-10-07T00:00:01.000Z");
      assert.equal(accepted.duplicate, false);
      assert.equal(accepted.conflict, false);

      const retry = repository.recordEvent(first, "2026-10-07T00:00:02.000Z");
      assert.equal(retry.duplicate, true);
      assert.equal(retry.conflict, false);

      const collision = repository.recordEvent(
        event({ installation_id: "install-a", event_id: "event-a-other", sequence: 1, event_type: "task_started" }),
        "2026-10-07T00:00:03.000Z",
      );
      assert.equal(collision.duplicate, false);
      assert.equal(collision.conflict, true);
      assert.equal(repository.getInstallationState("install-a")?.activity?.event_type, "session_started");

      const sameSequenceOtherInstall = repository.recordEvent(
        event({ installation_id: "install-b", event_id: "event-b-1", sequence: 1 }),
        "2026-10-07T00:00:04.000Z",
      );
      assert.equal(sameSequenceOtherInstall.conflict, false);
      assert.equal(repository.getInstallationState("install-b")?.last_sequence, 1);
    }
  } finally {
    sqlite.close();
  }
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

test("native title metadata preserves task ownership, activity ordering and TTL in memory and SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-native-titles-"));
  const sqlite = new SqliteRelayRepository(join(directory, "relay.sqlite"));
  try {
    for (const repository of [new InMemoryRelayRepository(), sqlite]) {
      let sequence = 0;
      const base = Date.parse("2026-10-02T00:00:00.000Z");
      const record = (session_id: string, event_type: EventEnvelope["event_type"], task_id?: string, session_title?: string, offset = sequence * 100) => {
        sequence += 1;
        const now = new Date(base + offset).toISOString();
        const result = repository.recordEvent(event({ event_id: `native-${sequence}`, session_id, sequence, event_type, occurred_at: now,
          ...(task_id ? { task_id } : {}), ...(session_title ? { session_title } : {}), payload: {},
        }), now);
        return { result, state: repository.getInstallationState("install-1", now)! };
      };
      const metadataOnly = record("unseen", "session_title_updated", undefined, "Unseen native title");
      assert.equal(metadataOnly.state.activity, undefined);
      assert.equal(metadataOnly.state.sessions, undefined);
      assert.equal(metadataOnly.result.activity_applied, false);

      record("target", "task_started", "old-task", "Original native task");
      record("target", "task_started", "current-task", "Current native task");
      const before = record("other", "session_started", undefined, "Other session").state;
      const activitySequence = before.sessions?.find((row) => row.session_id === "target")?.last_activity_sequence;
      const renamed = record("target", "session_title_updated", "current-task", "Renamed native task");
      assert.equal(renamed.result.activity_applied, true, "metadata can reach clients without becoming an outcome");
      assert.equal(renamed.state.running_count, 1);
      assert.equal(renamed.state.claude_state, "working");
      assert.equal(renamed.state.sessions?.[0]?.session_id, "other");
      assert.equal(renamed.state.sessions?.find((row) => row.session_id === "target")?.title, "Renamed native task");
      assert.equal(renamed.state.sessions?.find((row) => row.session_id === "target")?.last_activity_sequence, activitySequence);
      assert.deepEqual(renamed.state.activity, before.activity);
      assert.equal(renamed.state.updated_at, before.updated_at);
      const unscoped = record("target", "session_title_updated", undefined, "Unscoped native title").state;
      assert.equal(unscoped.sessions?.find((row) => row.session_id === "target")?.title, "Unscoped native title");
      assert.equal(unscoped.sessions?.find((row) => row.session_id === "target")?.last_activity_sequence, activitySequence);
      assert.equal(unscoped.running_count, 1);

      for (const event_type of ["task_finished", "session_title_updated"] as const) {
        const stale = record("target", event_type, "old-task", "Wrong old task name");
        assert.equal(stale.result.activity_applied, false);
        assert.equal(stale.state.sessions?.find((row) => row.session_id === "target")?.title, "Unscoped native title");
        assert.equal(stale.state.running_count, 1);
        assert.equal(stale.state.recent_completion, undefined);
      }
      const finished = record("target", "task_finished", undefined, "Final native task", 1_000).state;
      assert.equal(finished.recent_completion?.task_id, "current-task");
      assert.equal(finished.recent_completion?.display_name, "Final native task");
      const completion = finished.recent_completion!;
      record("target", "session_ended", undefined, undefined, 1_100);
      const supplemented = record("target", "session_title_updated", "current-task", "Late native title", 2_000).state;
      assert.deepEqual(supplemented.recent_completion, { ...completion, display_name: "Late native title" });
      assert.equal(supplemented.running_count, 0);
      assert.equal(supplemented.session_count, 1, "renaming an ended session must not reactivate it");
      assert.equal(record("target", "session_title_updated", "other-task", "Incorrect terminal title", 2_100).state.recent_completion?.display_name, "Late native title");
      const unscopedCompletion = record("target", "session_title_updated", undefined, "Unscoped completion title", 2_200).state;
      assert.deepEqual(unscopedCompletion.recent_completion, { ...completion, display_name: "Unscoped completion title" });
      assert.equal(record("target", "session_title_updated", undefined, "Expired native title", 6_001).state.recent_completion, undefined);

      record("target", "session_started", undefined, "Restarted native session", 7_000);
      record("target", "task_started", "next-task", "Next native task", 7_100);
      const rejectedOldTitle = record("target", "session_title_updated", "current-task", "Previous completion title", 7_200);
      assert.equal(rejectedOldTitle.result.activity_applied, false);
      assert.equal(rejectedOldTitle.state.recent_completion, undefined);
      assert.equal(rejectedOldTitle.state.sessions?.find((row) => row.session_id === "target")?.title, "Next native task");
      const lateRename = record("target", "session_title_updated", undefined, "Still native title", 2 * 60 * 60 * 1_000 + 60_000).state;
      assert.equal(lateRename.session_count, 0, "title updates must not extend activity TTL");
      assert.equal(lateRename.running_count, 0);
    }
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Top 5 presentation preserves all-session Working priority and most-active fallback in memory and SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-top-five-"));
  const sqlite = new SqliteRelayRepository(join(directory, "relay.sqlite"));
  try {
    for (const repository of [new InMemoryRelayRepository(), sqlite]) {
      let sequence = 0;
      const now = "2026-10-02T00:00:00.000Z";
      const record = (session_id: string, event_type: EventEnvelope["event_type"]) => {
        sequence += 1;
        repository.recordEvent(event({ event_id: `top-${sequence}`, session_id, event_type, sequence }), now);
        return repository.getInstallationState("install-1", now)!;
      };
      for (let index = 0; index < 6; index += 1) record(`worker-${index}`, "task_started");
      for (let index = 0; index < 5; index += 1) record(`idle-${index}`, "session_started");
      let state = repository.getInstallationState("install-1", now)!;
      assert.equal(state.claude_state, "working");
      assert.equal(state.running_count, 6);
      assert.equal(state.session_count, 11);
      assert.deepEqual(state.sessions?.map((row) => row.session_id), ["idle-4", "idle-3", "idle-2", "idle-1", "idle-0"]);
      for (let index = 0; index < 6; index += 1) state = record(`worker-${index}`, "task_finished");
      assert.equal(state.running_count, 0);
      assert.equal(record("idle-0", "waiting").claude_state, "waiting");
      assert.equal(record("newest-idle", "session_started").claude_state, "idle");
    }
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stale task tails preserve status, activity order and TTL while advancing the watermark in memory and SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-task-tail-order-"));
  const sqlite = new SqliteRelayRepository(join(directory, "relay.sqlite"));
  try {
    for (const repository of [new InMemoryRelayRepository(), sqlite]) {
      let sequence = 0;
      const base = Date.parse("2026-10-02T00:00:00.000Z");
      const record = (session_id: string, event_type: EventEnvelope["event_type"], task_id?: string, offset = sequence * 100) => {
        sequence += 1;
        const occurred_at = new Date(base + offset).toISOString();
        repository.recordEvent(event({ event_id: `tail-${sequence}`, session_id, event_type, sequence, occurred_at, ...(task_id ? { task_id } : {}) }), occurred_at);
        return repository.getInstallationState("install-1", occurred_at)!;
      };
      record("target", "task_started", "old");
      record("target", "task_started", "current");
      assert.equal(record("target", "waiting").claude_state, "waiting", "legacy Waiting without task_id remains valid");
      assert.equal(record("target", "tool_started").claude_state, "working", "unscoped live tool resumes the current task");
      const expectedActivitySequence = sequence;
      const before = record("other", "session_started");
      for (const event_type of ["waiting", "tool_started", "tool_finished", "tool_failed", "task_finished", "task_failed"] as const) {
        const state = record("target", event_type, "old");
        assert.equal(state.claude_state, "working", event_type);
        assert.equal(state.last_sequence, sequence, event_type);
        assert.deepEqual(state.activity, before.activity, event_type);
        assert.equal(state.updated_at, before.updated_at, event_type);
        assert.equal(state.sessions?.[0]?.session_id, "other", event_type);
        assert.equal(state.sessions?.find((row) => row.session_id === "target")?.last_activity_sequence, expectedActivitySequence, event_type);
        assert.equal(state.recent_completion, undefined, event_type);
      }
      const finished = record("target", "task_finished");
      assert.equal(finished.recent_completion?.task_id, "current");
      assert.equal(finished.recent_completion?.display_name, finished.sessions?.find((row) => row.session_id === "target")?.title);
      const terminalSequence = sequence;
      const newer = record("other", "waiting");
      for (const event_type of ["waiting", "tool_started", "tool_finished", "tool_failed", "task_finished", "task_failed"] as const) {
        const state = record("target", event_type);
        assert.equal(state.claude_state, "waiting", event_type);
        assert.deepEqual(state.activity, newer.activity, event_type);
        assert.equal(state.recent_completion?.sequence, terminalSequence, event_type);
        assert.equal(state.sessions?.find((row) => row.session_id === "target")?.claude_state, "idle", event_type);
      }
      // A late ignored tail must not extend session liveness.
      const expired = record("target", "waiting", "current", 2 * 60 * 60 * 1000 + 60_000);
      assert.equal(expired.session_count, 0);
      assert.equal(expired.last_sequence, sequence);
      assert.equal(expired.recent_completion, undefined);
      assert.equal(record("target", "task_started", "next", 2 * 60 * 60 * 1000 + 60_001).claude_state, "working");
    }
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Codex session names distinguish safe identities and stay consistent on completion in memory and SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-codex-names-"));
  const sqlite = new SqliteRelayRepository(join(directory, "relay.sqlite"));
  try {
    for (const repository of [new InMemoryRelayRepository(), sqlite]) {
      let sequence = 0;
      const now = "2026-10-02T00:00:00.000Z";
      for (const hash of ["a".repeat(64), "b".repeat(64)]) {
        const session_id = `codex:sess:${hash}`;
        for (const event_type of ["session_started", "task_started", "task_finished"] as const) {
          sequence += 1;
          repository.recordEvent(event({ event_id: `name-${sequence}`, sequence, session_id, event_type, ...(event_type === "session_started" ? { session_title: "Codex" } : {}), ...(event_type === "task_started" ? { task_id: `codex:turn:${hash}` } : {}) }), now);
        }
        const state = repository.getInstallationState("install-1", now)!;
        assert.equal(state.sessions?.[0]?.title, `Codex ${hash.slice(-6)}`);
        assert.equal(state.recent_completion?.display_name, state.sessions?.[0]?.title);
        assert.equal(state.recent_completion?.task_id, `codex:turn:${hash}`);
      }
      const titles = repository.getInstallationState("install-1", now)?.sessions?.map((row) => row.title);
      assert.equal(new Set(titles).size, 2);
    }
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
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

    // Persisted session JSON from earlier versions has only the event watermark.
    const legacyJson = new DatabaseSync(dbPath);
    legacyJson.exec("UPDATE relay_sessions SET session_json = json_remove(session_json, '$.last_activity_sequence')");
    legacyJson.close();
    const restarted = new SqliteRelayRepository(dbPath);
    const state = restarted.getInstallationState("install-1", "2026-10-02T00:00:02.000Z");
    assert.equal(state?.session_count, 2);
    assert.equal(state?.running_count, 1);
    assert.equal(state?.sessions?.[0]?.session_id, "session-B");
    assert.equal(state?.sessions?.[1]?.title, "A safe title");
    restarted.recordEvent(event({ event_id: "legacy-tail", session_id: "session-B", sequence: 3, event_type: "waiting", task_id: "old-task" }), "2026-10-02T00:00:03.000Z");
    const afterTail = restarted.getInstallationState("install-1", "2026-10-02T00:00:03.000Z");
    assert.equal(afterTail?.last_sequence, 3);
    assert.equal(afterTail?.sessions?.[0]?.last_activity_sequence, 2);
    assert.equal(afterTail?.sessions?.[0]?.claude_state, "working");
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
    assert.equal(migrated.findEvent("event-1")?.activity_applied, true, "preexisting events retain presentation compatibility");
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

test("subagent classification separates main presentation from independent total thread counts", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-subagent-counts-"));
  const path = join(directory, "relay.sqlite");
  const now = "2026-10-02T00:00:00.000Z";
  let sqlite = new SqliteRelayRepository(path);
  const memory = new InMemoryRelayRepository();
  try {
    for (const repository of [memory, sqlite]) {
      let sequence = 0;
      const record = (overrides: Partial<EventEnvelope>) => {
        sequence++;
        return repository.recordEvent(event({ event_id: `classification-${sequence}`, sequence,
          event_type: "task_started", payload: {}, ...overrides }), now);
      };
      record({ session_id: "parent-a" });
      record({ session_id: "parent-b" });
      const mainActivity = repository.getInstallationState("install-1", now)?.activity;
      for (let i = 0; i < 3; i++) record({ session_id: `child-${i}`, session_kind: "subagent", task_id: "shared-parent-task" });
      let state = repository.getInstallationState("install-1", now)!;
      assert.equal(state.main_running_count, 2);
      assert.equal(state.total_running_count, 5);
      assert.equal(state.running_count, 2);
      assert.equal(state.main_session_count, 2);
      assert.deepEqual(state.sessions?.map((item) => item.session_id), ["parent-b", "parent-a"]);
      assert.deepEqual(state.activity, mainActivity);
      const finish = record({ session_id: "child-0", event_type: "task_finished", task_id: "shared-parent-task" });
      assert.equal(finish.stored.event.session_kind, "subagent");
      state = repository.getInstallationState("install-1", now)!;
      assert.equal(state.total_running_count, 4);
      assert.equal(state.main_running_count, 2);
      assert.equal(state.recent_completion, undefined);
      assert.deepEqual(state.activity, mainActivity);
      assert.equal(repository.recordEvent(finish.stored.event, now).duplicate, true);
      record({ session_id: "child-1", event_type: "waiting" });
      record({ session_id: "child-2", event_type: "task_failed" });
      state = repository.getInstallationState("install-1", now)!;
      assert.equal(state.claude_state, "working");
      assert.deepEqual(state.activity, mainActivity);
      for (let i = 0; i < 6; i++) record({ session_id: `main-${i}` });
      state = repository.getInstallationState("install-1", now)!;
      assert.equal(state.sessions?.length, 5);
      assert.equal(state.main_running_count, 8);
      assert.equal(state.total_running_count, 8);
      assert.equal(state.main_session_count, 8);
      assert.equal(repository.getInstallationState("install-1", "2026-10-02T02:00:00.000Z")?.total_running_count, 0);
    }
    sqlite.close();
    sqlite = new SqliteRelayRepository(path);
    assert.equal(sqlite.getInstallationState("install-1", now)?.main_running_count, 8);
    assert.equal(sqlite.listEventsAfter("install-1", 0).find((item) => item.event.session_id === "child-0")?.event.session_kind, "subagent");
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("late classification hides prior completion and replay without changing activity times or TTL", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-classification-metadata-"));
  const now = "2026-10-02T00:00:00.000Z";
  const sqlite = new SqliteRelayRepository(join(directory, "relay.sqlite"));
  try {
    for (const repository of [new InMemoryRelayRepository(), sqlite]) {
      repository.recordEvent(event({ event_id: "pre-kind", event_type: "task_started", payload: {} }), now);
      repository.recordEvent(event({ event_id: "pre-kind-finish", event_type: "task_finished", sequence: 2, payload: {} }), now);
      const before = repository.getInstallationState("install-1", now)!;
      assert.ok(before.recent_completion);
      repository.recordEvent(event({ event_id: "kind", event_type: "session_classification_updated", sequence: 3,
        session_kind: "subagent", occurred_at: "2026-10-02T01:59:59.000Z", payload: {} }), now);
      const after = repository.getInstallationState("install-1", now)!;
      assert.equal(after.main_session_count, 0);
      assert.equal(after.recent_completion, undefined);
      assert.equal(after.activity, undefined);
      assert.equal(after.updated_at, before.updated_at);
      assert.equal(after.last_sequence, 3);
      assert.ok(repository.listEventsAfter("install-1", 0).every((item) => item.event.session_kind === "subagent"));
      // Metadata must not keep a working thread alive past its original activity TTL.
      repository.recordEvent(event({ event_id: "other-start", session_id: "other", event_type: "task_started", sequence: 4, payload: {} }), now);
      repository.recordEvent(event({ event_id: "other-kind", session_id: "other", event_type: "session_classification_updated", sequence: 5,
        session_kind: "subagent", occurred_at: "2026-10-02T01:59:59.000Z", payload: {} }), now);
      assert.equal(repository.getInstallationState("install-1", now)?.total_running_count, 1);
      assert.equal(repository.getInstallationState("install-1", now)?.main_running_count, 0);
      assert.equal(repository.getInstallationState("install-1", "2026-10-02T02:00:00.000Z")?.total_running_count, 0);
      repository.recordEvent(event({ event_id: "kind-before-lifecycle", session_id: "future", event_type: "session_classification_updated", sequence: 6,
        session_kind: "subagent", payload: {} }), now);
      assert.equal(repository.getInstallationState("install-1", now)?.total_running_count, 1);
      repository.recordEvent(event({ event_id: "future-start", session_id: "future", event_type: "task_started", sequence: 7, payload: {} }), now);
      assert.equal(repository.getInstallationState("install-1", now)?.total_running_count, 2);
      assert.equal(repository.getInstallationState("install-1", now)?.main_running_count, 0);
    }
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
