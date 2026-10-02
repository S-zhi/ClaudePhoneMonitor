import { test } from "node:test";
import assert from "node:assert/strict";

import { InMemoryRelayRepository } from "../src/repository.js";
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
  assert.equal(repository.getInstallationState("install-1")?.claude_state, "waiting");

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
