import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonLogger } from "../src/logger.js";
import { Relay } from "../src/relay.js";
import { InMemoryRelayRepository, SqliteRelayRepository } from "../src/repository.js";
import type { EventEnvelope, ServerMessage, UsageAggregate, UsageSnapshotMessage } from "../src/types.js";

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
    payload: { prompt: "this must never appear in logs or relay storage" },
    ...overrides,
  };
}

function messages(): ServerMessage[] {
  return [];
}

function usageSnapshot(overrides: Partial<UsageSnapshotMessage> = {}): UsageSnapshotMessage {
  const usage: UsageAggregate = {
    epoch_id: "synthetic-epoch",
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
    type: "usage_snapshot", schema_version: 1, event_id: "usage-2", installation_id: "install-1",
    sequence: 2, occurred_at: "2026-10-07T00:00:01.000Z", usage, ...overrides,
  };
}

test("usage snapshot only changes ordinary snapshot data and resume falls back across shared sequence", () => {
  const relay = new Relay({ autoStart: false, now: () => new Date("2026-10-07T00:00:02.000Z") });
  const collectorMessages = messages();
  const phoneMessages = messages();
  const collector = relay.connect({ gateway: "collector", installation_id: "install-1", transport: { send: (message) => collectorMessages.push(message) } });
  const phone = relay.connect({ gateway: "android", installation_id: "install-1", transport: { send: (message) => phoneMessages.push(message) } });
  relay.receive(collector.connection_id, JSON.stringify(event()));
  const stateBefore = relay.snapshot("install-1");
  phoneMessages.length = 0;
  relay.receive(collector.connection_id, JSON.stringify(usageSnapshot()));

  const ack = collectorMessages.filter((message) => message.type === "event_ack").at(-1);
  assert.ok(ack && ack.type === "event_ack");
  assert.equal(ack.accepted, true);
  assert.equal(ack.sequence_status, "in_order");
  assert.equal(phoneMessages.some((message) => (message as { type?: string }).type === "usage_snapshot"), false);
  const snapshot = phoneMessages.filter((message) => message.type === "snapshot").at(-1);
  assert.ok(snapshot && snapshot.type === "snapshot");
  assert.equal(snapshot.usage?.revision, 1);
  assert.equal(snapshot.last_sequence, 2);
  assert.equal(snapshot.claude_state, stateBefore.claude_state);
  assert.deepEqual(snapshot.activity, stateBefore.activity);
  assert.equal(relay.repository.findEvent("usage-2"), undefined);
  const serializedUsage = JSON.stringify(snapshot.usage);
  for (const privateKey of ["session_id", "response_id", "request_id", "model", "file_path", "prompt", "api_key"]) {
    assert.equal(serializedUsage.includes(privateKey), false);
  }

  relay.receive(collector.connection_id, JSON.stringify(usageSnapshot({ event_id: "usage-sequence-collision", sequence: 1 })));
  const rejectedUsageAck = collectorMessages.filter((message) => message.type === "event_ack").at(-1);
  assert.ok(rejectedUsageAck && rejectedUsageAck.type === "event_ack");
  assert.equal(rejectedUsageAck.status, "rejected");
  assert.equal(rejectedUsageAck.duplicate, false);
  relay.receive(collector.connection_id, JSON.stringify(event({ event_id: "event-sequence-collision", sequence: 2, event_type: "task_finished" })));
  const rejectedEventAck = collectorMessages.filter((message) => message.type === "event_ack").at(-1);
  assert.ok(rejectedEventAck && rejectedEventAck.type === "event_ack");
  assert.equal(rejectedEventAck.status, "rejected");
  assert.equal(rejectedEventAck.duplicate, false);
  assert.equal(relay.snapshot("install-1").usage?.revision, 1);

  relay.receive(collector.connection_id, JSON.stringify(usageSnapshot({
    event_id: "usage-wrong-installation",
    installation_id: "install-elsewhere",
    sequence: 3,
  })));
  assert.equal(relay.snapshot("install-elsewhere").usage, undefined);
  assert.ok(collectorMessages.some((message) => message.type === "error" && message.code === "invalid_usage_snapshot"));

  phoneMessages.length = 0;
  relay.receive(phone.connection_id, JSON.stringify({ type: "resume", schema_version: 1, installation_id: "install-1", last_sequence: 1 }));
  assert.equal(phoneMessages.some((message) => message.type === "event"), false);
  assert.equal(phoneMessages.at(-1)?.type, "snapshot");
  const wire = phoneMessages.at(-1);
  assert.ok(wire && wire.type === "snapshot");
  relay.stop();
});

test("invalid complete usage algebra and unauthorized gateway are rejected before mutation", () => {
  const logs: string[] = [];
  const relay = new Relay({ autoStart: false, logger: new JsonLogger({ sink: (line) => logs.push(line) }) });
  const collectorMessages = messages();
  const androidMessages = messages();
  const collector = relay.connect({ gateway: "collector", installation_id: "install-1", transport: { send: (message) => collectorMessages.push(message) } });
  const android = relay.connect({ gateway: "android", installation_id: "install-1", transport: { send: (message) => androidMessages.push(message) } });
  const invalid = usageSnapshot({ usage: {
    ...usageSnapshot().usage,
    actual: { value: 109, quality: "complete" },
    cache_hit: { numerator: null, denominator: null, quality: "unavailable" },
  } });
  relay.receive(collector.connection_id, JSON.stringify(invalid));
  assert.equal(relay.snapshot("install-1").usage, undefined);
  assert.ok(collectorMessages.some((message) => message.type === "error" && message.code === "invalid_usage_snapshot"));
  const privateField = usageSnapshot({
    event_id: "usage-private-field",
    sequence: 2,
    usage: { ...usageSnapshot().usage, request_id: "must-not-be-stored" } as UsageAggregate,
  });
  relay.receive(collector.connection_id, JSON.stringify(privateField));
  assert.equal(relay.snapshot("install-1").usage, undefined);
  assert.equal(logs.some((line) => line.includes("must-not-be-stored")), false);
  const unsupportedCompleteHit = usageSnapshot({
    event_id: "usage-false-complete-hit",
    sequence: 3,
    usage: {
      ...usageSnapshot().usage,
      complete_responses: 1,
      provider_coverage: {
        claude: { status: "partial", observed_responses: 1, complete_responses: 0 },
        codex: { status: "ready", observed_responses: 1, complete_responses: 1 },
      },
    },
  });
  relay.receive(collector.connection_id, JSON.stringify(unsupportedCompleteHit));
  assert.equal(relay.snapshot("install-1").usage, undefined);
  const partial = usageSnapshot({
    sequence: 4,
    event_id: "usage-partial",
    usage: {
      ...usageSnapshot().usage,
      observed_responses: 2,
      complete_responses: 0,
      provider_coverage: {
        claude: { status: "partial", observed_responses: 1, complete_responses: 0 },
        codex: { status: "unavailable", observed_responses: 1, complete_responses: 0 },
      },
      new_input: { value: 30, quality: "partial" },
      cached_input: { value: 20, quality: "partial" },
      output: { value: 5, quality: "partial" },
      actual: { value: 99, quality: "partial" },
      total_input: { value: 800, quality: "partial" },
      cache_hit: { numerator: 20, denominator: 800, quality: "partial" },
    },
  });
  relay.receive(collector.connection_id, JSON.stringify(partial));
  assert.equal(relay.snapshot("install-1").usage?.actual.value, 99);
  relay.receive(android.connection_id, JSON.stringify(usageSnapshot({ sequence: 5, event_id: "phone-usage" })));
  assert.equal(relay.snapshot("install-1").usage?.epoch_id, "synthetic-epoch");
  assert.ok(androidMessages.some((message) => message.type === "error" && message.code === "forbidden_gateway"));
  relay.stop();
});

test("event ingest returns event_ack and broadcasts the canonical snapshot", () => {
  let nowMs = Date.parse("2026-10-02T00:00:00.000Z");
  const logs: string[] = [];
  const relay = new Relay({
    autoStart: false,
    now: () => new Date(nowMs),
    logger: new JsonLogger({ sink: (line) => logs.push(line), clock: () => new Date(nowMs) }),
    config: {
      staleAfterMs: 100,
      offlineAfterMs: 200,
      heartbeatIntervalMs: 10_000,
      bookkeepingIntervalMs: 10,
    },
  });
  const collectorMessages = messages();
  const androidMessages = messages();
  const collector = relay.connect({
    gateway: "collector",
    installation_id: "install-1",
    transport: { send: (message) => collectorMessages.push(message) },
  });
  const android = relay.connect({
    gateway: "android",
    installation_id: "install-1",
    transport: { send: (message) => androidMessages.push(message) },
  });

  relay.receive(collector.connection_id, JSON.stringify(event()));
  const ack = collectorMessages.find((message) => message.type === "event_ack");
  assert.ok(ack && ack.type === "event_ack");
  assert.equal(ack.event_id, "event-1");
  assert.equal(ack.status, "accepted");
  assert.equal(ack.sequence_status, "initial");
  assert.equal(ack.last_sequence, 1);

  const snapshot = androidMessages
    .filter((message) => message.type === "snapshot" && message.installation_id === "install-1")
    .at(-1);
  assert.ok(snapshot && snapshot.type === "snapshot");
  assert.equal(snapshot.computer_state, "online");
  assert.equal(snapshot.claude_state, "idle");
  assert.equal(snapshot.last_sequence, 1);
  assert.ok(snapshot.activity && typeof snapshot.activity !== "string");
  assert.equal(snapshot.activity?.event_type, "session_started");
  assert.deepEqual(relay.repository.findEvent("event-1")?.event.payload, {
    prompt: "[REDACTED]",
  });

  const snapshotCount = androidMessages.filter((message) => message.type === "snapshot").length;
  relay.receive(collector.connection_id, JSON.stringify(event()));
  const duplicateAck = collectorMessages.filter((message) => message.type === "event_ack").at(-1);
  assert.ok(duplicateAck && duplicateAck.type === "event_ack");
  assert.equal(duplicateAck.status, "duplicate");
  assert.equal(duplicateAck.duplicate, true);
  assert.equal(androidMessages.filter((message) => message.type === "snapshot").length, snapshotCount);

  relay.receive(
    collector.connection_id,
    JSON.stringify(event({ event_id: "event-3", sequence: 3, event_type: "waiting" })),
  );
  const gapAck = collectorMessages.filter((message) => message.type === "event_ack").at(-1);
  assert.ok(gapAck && gapAck.type === "event_ack");
  assert.equal(gapAck.sequence_status, "gap");
  assert.equal(gapAck.last_sequence, 3);
  assert.equal(
    androidMessages.filter(
      (message) => message.type === "snapshot" && message.claude_state === "waiting",
    ).length,
    1,
  );

  assert.equal(logs.some((line) => line.includes("this must never appear in logs")), false);
  assert.equal(logs.every((line) => !line.includes('"payload"')), true);

  nowMs += 150;
  relay.tick();
  const staleSnapshot = androidMessages.at(-1);
  assert.ok(staleSnapshot && staleSnapshot.type === "snapshot");
  assert.equal(staleSnapshot.computer_state, "stale");
  nowMs += 100;
  relay.tick();
  const offlineSnapshot = androidMessages.at(-1);
  assert.ok(offlineSnapshot && offlineSnapshot.type === "snapshot");
  assert.equal(offlineSnapshot.computer_state, "offline");

  relay.disconnect(android.connection_id);
});

test("subscribers receive complete session snapshots and expiry broadcasts", () => {
  let nowMs = Date.parse("2026-10-02T00:00:00.000Z");
  const relay = new Relay({ autoStart: false, now: () => new Date(nowMs) });
  const phoneMessages = messages();
  const collector = relay.connect({
    gateway: "collector",
    installation_id: "install-1",
    transport: { send: () => undefined },
  });
  const phone = relay.connect({
    gateway: "android",
    installation_id: "install-1",
    transport: { send: (message) => phoneMessages.push(message) },
  });
  relay.receive(phone.connection_id, JSON.stringify({ type: "subscribe", installation_id: "install-1" }));
  relay.receive(collector.connection_id, JSON.stringify(event({
    session_id: "session-A",
    session_title: "Project Alpha",
  })));
  relay.receive(collector.connection_id, JSON.stringify(event({
    event_id: "event-2",
    sequence: 2,
    session_id: "session-B",
    event_type: "task_started",
    task_id: "task-B",
  })));

  let snapshot = phoneMessages.filter((message) => message.type === "snapshot").at(-1);
  assert.ok(snapshot && snapshot.type === "snapshot");
  assert.equal(snapshot.claude_state, "working");
  assert.equal(snapshot.running_count, 1);
  assert.equal(snapshot.session_count, 2);
  assert.deepEqual(snapshot.sessions?.map((row) => row.session_id), ["session-B", "session-A"]);

  relay.receive(collector.connection_id, JSON.stringify(event({
    event_id: "event-3",
    sequence: 3,
    session_id: "session-A",
    event_type: "task_finished",
    task_id: "task-A",
  })));
  snapshot = phoneMessages.filter((message) => message.type === "snapshot").at(-1);
  assert.ok(snapshot && snapshot.type === "snapshot");
  assert.equal(snapshot.recent_completion?.display_name, "Project Alpha");
  assert.equal(snapshot.claude_state, "working");

  nowMs += 5_001;
  relay.tick();
  snapshot = phoneMessages.filter((message) => message.type === "snapshot").at(-1);
  assert.ok(snapshot && snapshot.type === "snapshot");
  assert.equal(snapshot.recent_completion, undefined);

  nowMs += 2 * 60 * 60 * 1000;
  relay.tick();
  snapshot = phoneMessages.filter((message) => message.type === "snapshot").at(-1);
  assert.ok(snapshot && snapshot.type === "snapshot");
  assert.equal(snapshot.session_count, 0);
  assert.deepEqual(snapshot.sessions, []);
  relay.stop();
});

test("Relay accepts only safe SessionStart titles and falls back for sensitive values", () => {
  const relay = new Relay({ autoStart: false, now: () => new Date("2026-10-02T00:00:00.000Z") });
  const phoneMessages = messages();
  const collector = relay.connect({
    gateway: "collector",
    installation_id: "install-1",
    transport: { send: () => undefined },
  });
  const phone = relay.connect({
    gateway: "android",
    installation_id: "install-1",
    transport: { send: (message) => phoneMessages.push(message) },
  });
  relay.receive(phone.connection_id, JSON.stringify({ type: "subscribe", installation_id: "install-1" }));

  const rejectedTitles = [
    "Note /Users/example/private.txt",
    "Visit HTTPS://example.test/docs",
    "review|/Users/alice/private",
    "review-/Users/alice/private",
    "prefix C:\\Users\\example\\secret.txt",
    "review \\\\fileserver\\share\\private",
    "token: hidden-value",
    "A Bearer abcdefghijklmnop",
    "ghp_abcdefghijklmnopQRST1234",
    "github_pat_abcdefghijklmnopQRST1234",
    "sk-abcdefgh12345678",
    "a title\nwith line break",
  ];
  rejectedTitles.forEach((title, index) => {
    const id = `bad-${index + 1}`;
    relay.receive(collector.connection_id, JSON.stringify(event({
      event_id: `title-${index + 1}`,
      installation_id: "install-1",
      session_id: id,
      sequence: index + 1,
      event_type: "session_started",
      session_title: title,
    })));
    const current = phoneMessages.filter((message) => message.type === "snapshot").at(-1);
    assert.ok(current && current.type === "snapshot");
    assert.equal(current.sessions?.find((session) => session.session_id === id)?.title, `会话 ${createHash("sha256").update(id).digest("hex").slice(-6)}`);
    assert.equal(relay.repository.findEvent(`title-${index + 1}`)?.event.session_title, undefined);
  });
  relay.receive(collector.connection_id, JSON.stringify(event({
    event_id: "title-safe",
    installation_id: "install-1",
    session_id: "safe-title",
    sequence: rejectedTitles.length + 1,
    event_type: "session_started",
    session_title: "  项目   追踪  ",
  })));

  const snapshot = phoneMessages.filter((message) => message.type === "snapshot").at(-1);
  assert.ok(snapshot && snapshot.type === "snapshot");
  assert.equal(snapshot.sessions?.find((session) => session.session_id === "safe-title")?.title, "项目 追踪");
  relay.stop();
});

test("probe and challenge messages route between gateways", () => {
  const relay = new Relay({ autoStart: false });
  const collectorMessages = messages();
  const androidMessages = messages();
  const collector = relay.connect({
    gateway: "collector",
    installation_id: "install-1",
    transport: { send: (message) => collectorMessages.push(message) },
  });
  const android = relay.connect({
    gateway: "android",
    installation_id: "install-1",
    transport: { send: (message) => androidMessages.push(message) },
  });

  relay.receive(
    collector.connection_id,
    JSON.stringify({
      type: "probe",
      schema_version: 1,
      probe_id: "probe-1",
      nonce: "probe-nonce",
      target_installation_id: "install-1",
    }),
  );
  const routedChallenge = androidMessages.find(
    (message) => message.type === "challenge" && message.probe_id === "probe-1",
  );
  assert.ok(routedChallenge && routedChallenge.type === "challenge");
  assert.equal(routedChallenge.nonce, "probe-nonce");
  relay.receive(
    android.connection_id,
    JSON.stringify({
      type: "challenge_ack",
      schema_version: 1,
      probe_id: "probe-1",
      nonce: "probe-nonce",
      signature: "echo-signature",
    }),
  );
  const probeAck = collectorMessages.find(
    (message) => message.type === "challenge_ack" && message.probe_id === "probe-1",
  );
  assert.ok(probeAck && probeAck.type === "challenge_ack");
  assert.equal(probeAck.nonce, "probe-nonce");

  relay.receive(
    collector.connection_id,
    JSON.stringify({
      type: "challenge",
      schema_version: 1,
      challenge_id: "challenge-1",
      target_installation_id: "install-1",
      payload: { challenge: "value" },
    }),
  );
  assert.ok(
    androidMessages.some(
      (message) => message.type === "challenge" && message.challenge_id === "challenge-1",
    ),
  );
  relay.receive(
    android.connection_id,
    JSON.stringify({
      type: "challenge_ack",
      schema_version: 1,
      challenge_id: "challenge-1",
      ok: true,
      payload: { accepted: true },
    }),
  );
  const ack = collectorMessages.find(
    (message) => message.type === "challenge_ack" && message.challenge_id === "challenge-1",
  );
  assert.ok(ack && ack.type === "challenge_ack");
  assert.equal(ack.ok, true);
});

test("unacknowledged probes mark the installation stale and emit a retryable timeout", async () => {
  const relay = new Relay({
    autoStart: false,
    config: { probeTimeoutMs: 5, staleAfterMs: 100, offlineAfterMs: 200 },
  });
  const collectorMessages = messages();
  const androidMessages = messages();
  const collector = relay.connect({
    gateway: "collector",
    installation_id: "install-1",
    transport: { send: (message) => collectorMessages.push(message) },
  });
  const android = relay.connect({
    gateway: "android",
    installation_id: "install-1",
    transport: { send: (message) => androidMessages.push(message) },
  });

  relay.receive(
    android.connection_id,
    JSON.stringify({
      type: "probe",
      schema_version: 1,
      probe_id: "probe-timeout",
      nonce: "nonce-timeout",
      target_installation_id: "install-1",
      timeout_ms: 5,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stale = androidMessages.filter((message) => message.type === "snapshot").at(-1);
  assert.ok(stale && stale.type === "snapshot");
  assert.equal(stale.computer_state, "stale");
  const timeout = androidMessages.find(
    (message) => message.type === "error" && message.code === "PROBE_TIMEOUT",
  );
  assert.ok(timeout && timeout.type === "error");
  assert.equal(timeout.retryable, true);
  relay.disconnect(collector.connection_id);
  relay.disconnect(android.connection_id);
  relay.stop();
});

test("safe native title events broadcast metadata snapshots while unsafe payloads are rejected", () => {
  const base = Date.parse("2026-10-02T00:00:00.000Z");
  const relay = new Relay({ autoStart: false, now: () => new Date(base + 2_000) });
  const collectorMessages = messages();
  const phoneMessages = messages();
  const collector = relay.connect({ gateway: "collector", installation_id: "install-1", transport: { send: (message) => collectorMessages.push(message) } });
  relay.connect({ gateway: "android", installation_id: "install-1", transport: { send: (message) => phoneMessages.push(message) } });
  relay.receive(collector.connection_id, JSON.stringify(event({ sequence: 1, event_type: "task_started", task_id: "native-task", session_title: "Native original task", payload: {} })));
  relay.receive(collector.connection_id, JSON.stringify(event({ event_id: "native-finished", sequence: 2, event_type: "task_finished", task_id: "native-task", session_title: "Native completion title", payload: {} })));
  const completion = relay.snapshot("install-1").recent_completion!;
  phoneMessages.length = 0;
  relay.receive(collector.connection_id, JSON.stringify(event({ event_id: "native-renamed", sequence: 3, event_type: "session_title_updated", task_id: "native-task", session_title: "Updated native name", payload: {} })));
  assert.deepEqual(phoneMessages.map((message) => message.type), ["event", "snapshot"]);
  assert.equal(phoneMessages[0]?.type === "event" && phoneMessages[0].event_type, "session_title_updated");
  const updated = relay.snapshot("install-1");
  assert.equal(updated.claude_state, "idle");
  assert.equal(updated.running_count, 0);
  assert.ok(updated.activity && typeof updated.activity !== "string");
  assert.equal(updated.activity.event_type, "task_finished");
  assert.equal(updated.sessions?.[0]?.last_activity_sequence, 2);
  assert.deepEqual(updated.recent_completion, { ...completion, display_name: "Updated native name" });

  for (const bad of [
    { session_title: "/private/path", payload: {} },
    { session_title: "token=PRIVATE_CREDENTIAL", payload: {} },
    { session_title: "Native name", payload: { title: "PRIVATE_PROMPT" } },
    { session_title: undefined, payload: {} },
  ]) {
    relay.receive(collector.connection_id, JSON.stringify(event({ event_id: "invalid-native-title", sequence: 4, event_type: "session_title_updated", ...bad })));
    const ack = collectorMessages.filter((message) => message.type === "event_ack").at(-1);
    assert.ok(ack?.type === "event_ack" && !ack.accepted);
    assert.equal(relay.snapshot("install-1").last_sequence, 3);
    assert.equal(relay.snapshot("install-1").sessions?.[0]?.title, "Updated native name");
  }
  relay.receive(collector.connection_id, JSON.stringify(event({ event_id: "native-unsafe-finish", sequence: 4, session_id: "other", event_type: "task_finished", session_title: "/private/path", payload: {} })));
  assert.equal(relay.repository.findEvent("native-unsafe-finish")?.event.session_title, undefined, "unsafe lifecycle labels are omitted");
  assert.equal(JSON.stringify(phoneMessages).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(phoneMessages).includes("/private"), false);
  relay.stop();
});

test("unknown finishes update legacy state and ACKs without presenting an attributed completion in memory and SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-unknown-finish-"));
  const now = () => new Date("2026-10-02T00:00:01.000Z");
  try {
    for (const repository of [new InMemoryRelayRepository(), new SqliteRelayRepository(join(directory, "relay.sqlite"))]) {
      const relay = new Relay({ autoStart: false, repository, now });
      try {
        const collectorMessages = messages();
        const phoneMessages = messages();
        const collector = relay.connect({ gateway: "collector", installation_id: "install-1", transport: { send: (message) => collectorMessages.push(message) } });
        const phone = relay.connect({ gateway: "android", installation_id: "install-1", transport: { send: (message) => phoneMessages.push(message) } });
        const records = [
          event({ event_id: "anonymous-start", sequence: 1, session_id: "unknown", event_type: "task_started" }),
          event({ event_id: "anonymous-finish", sequence: 2, session_id: "unknown", event_type: "task_finished" }),
          event({ event_id: "known-start", sequence: 3, event_type: "task_started", task_id: "known-task" }),
          event({ event_id: "anonymous-background-finish", sequence: 4, session_id: "unknown", event_type: "task_finished" }),
          event({ event_id: "known-finish", sequence: 5, event_type: "task_finished", task_id: "known-task" }),
        ];
        for (const record of records) {
          relay.receive(collector.connection_id, JSON.stringify(record));
          const ack = collectorMessages.filter((message) => message.type === "event_ack").at(-1);
          assert.ok(ack?.type === "event_ack" && ack.accepted);
          assert.equal(ack.last_sequence, record.sequence);
          const snapshot = phoneMessages.at(-1);
          assert.ok(snapshot?.type === "snapshot");
          assert.equal(snapshot.last_sequence, record.sequence);
          if (record.sequence === 2) {
            assert.equal(snapshot.claude_state, "idle", "the anonymous Stop still updates the legacy base");
            assert.equal(snapshot.sessions, undefined);
            assert.equal(snapshot.recent_completion, undefined);
          }
          if (record.sequence === 4) {
            assert.equal(snapshot.claude_state, "working", "anonymous completion cannot end the known task");
            assert.equal(snapshot.running_count, 1);
            assert.equal(snapshot.recent_completion, undefined);
          }
        }
        assert.deepEqual(phoneMessages.filter((message) => message.type === "event").map((message) => message.type === "event" && message.sequence), [1, 3, 5]);
        assert.equal(repository.findEvent("anonymous-finish")?.activity_applied, false);
        assert.equal(repository.findEvent("anonymous-background-finish")?.activity_applied, false);
        assert.equal(relay.snapshot("install-1").recent_completion?.task_id, "known-task");
        // Pre-upgrade SQLite records default activity_applied to true.
        const listEventsAfter = repository.listEventsAfter.bind(repository);
        repository.listEventsAfter = (installationId, sequence) => listEventsAfter(installationId, sequence)
          .map((stored) => ({ ...stored, activity_applied: true }));
        phoneMessages.length = 0;
        relay.receive(phone.connection_id, JSON.stringify({ type: "resume", schema_version: 1, installation_id: "install-1", last_sequence: 0 }));
        assert.deepEqual(phoneMessages.filter((message) => message.type === "event").map((message) => message.type === "event" && message.sequence), [1, 3, 5]);
        assert.equal(phoneMessages.at(-1)?.type, "snapshot");
      } finally {
        relay.stop();
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ignored task tails never present live or on resume, including SQLite restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-presentation-"));
  const dbPath = join(directory, "relay.sqlite");
  const now = () => new Date("2026-10-02T00:00:01.000Z");
  let restarted: Relay | undefined;
  try {
    for (const repository of [new InMemoryRelayRepository(), new SqliteRelayRepository(dbPath)]) {
      const relay = new Relay({ autoStart: false, repository, now });
      try {
        const collectorMessages = messages();
        const phoneMessages = messages();
        const collector = relay.connect({ gateway: "collector", installation_id: "install-1", transport: { send: (message) => collectorMessages.push(message) } });
        const phone = relay.connect({ gateway: "android", installation_id: "install-1", transport: { send: (message) => phoneMessages.push(message) } });
        const records = [
          event({ event_id: "start-old", sequence: 1, event_type: "task_started", task_id: "old" }),
          event({ event_id: "start-current", sequence: 2, event_type: "task_started", task_id: "current" }),
          event({ event_id: "stale-finish", sequence: 3, event_type: "task_finished", task_id: "old" }),
          event({ event_id: "stale-wait", sequence: 4, event_type: "waiting", task_id: "old" }),
          event({ event_id: "real-finish", sequence: 5, event_type: "task_finished", task_id: "current" }),
          event({ event_id: "terminal-finish", sequence: 6, event_type: "task_finished", task_id: "current" }),
          event({ event_id: "terminal-wait", sequence: 7, event_type: "waiting" }),
        ];
        for (const record of records) relay.receive(collector.connection_id, JSON.stringify(record));
        assert.deepEqual(phoneMessages.filter((message) => message.type === "event").map((message) => message.type === "event" && message.sequence), [1, 2, 5]);
        assert.equal(collectorMessages.filter((message) => message.type === "event_ack").length, 7);
        const snapshots = phoneMessages.filter((message) => message.type === "snapshot");
        assert.equal(snapshots.filter((message) => message.type === "snapshot" && message.last_sequence !== null).length, 7);
        assert.equal(snapshots.find((message) => message.type === "snapshot" && message.last_sequence === 4)?.claude_state, "working");
        const final = relay.snapshot("install-1");
        assert.equal(final.last_sequence, 7);
        assert.equal(final.claude_state, "idle");
        assert.equal(final.recent_completion?.sequence, 5);
        assert.equal(repository.findEvent("stale-finish")?.activity_applied, false);
        assert.equal(repository.findEvent("real-finish")?.activity_applied, true);
        assert.equal(repository.recordEvent(records[4]!, now().toISOString()).activity_applied, false, "a duplicate cannot be presented twice");
        phoneMessages.length = 0;
        relay.receive(phone.connection_id, JSON.stringify({ type: "resume", schema_version: 1, installation_id: "install-1", last_sequence: 2 }));
        assert.deepEqual(phoneMessages.filter((message) => message.type === "event").map((message) => message.type === "event" && message.sequence), [5]);
        assert.equal(phoneMessages.at(-1)?.type, "snapshot");
      } finally {
        relay.stop();
      }
    }
    restarted = new Relay({ autoStart: false, now, repository: new SqliteRelayRepository(dbPath) });
    const replay = messages();
    const phone = restarted.connect({ gateway: "android", installation_id: "install-1", transport: { send: (message) => replay.push(message) } });
    replay.length = 0;
    restarted.receive(phone.connection_id, JSON.stringify({ type: "resume", schema_version: 1, installation_id: "install-1", last_sequence: 2 }));
    assert.deepEqual(replay.filter((message) => message.type === "event").map((message) => message.type === "event" && message.sequence), [5]);
    assert.equal(restarted.snapshot("install-1").last_sequence, 7);
  } finally {
    restarted?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resume replays stored events after a sequence and then sends a snapshot", () => {
  const relay = new Relay({ autoStart: false });
  const collectorMessages = messages();
  const androidMessages = messages();
  const collector = relay.connect({
    gateway: "collector",
    installation_id: "install-1",
    transport: { send: (message) => collectorMessages.push(message) },
  });
  const android = relay.connect({
    gateway: "android",
    installation_id: "install-1",
    transport: { send: (message) => androidMessages.push(message) },
  });
  relay.receive(collector.connection_id, JSON.stringify(event()));
  relay.receive(
    collector.connection_id,
    JSON.stringify(event({ event_id: "event-2", sequence: 2, event_type: "task_started" })),
  );
  androidMessages.length = 0;

  relay.receive(
    android.connection_id,
    JSON.stringify({
      type: "resume",
      schema_version: 1,
      installation_id: "install-1",
      last_sequence: 0,
    }),
  );
  const replayed = androidMessages.filter((message) => message.type === "event");
  assert.deepEqual(replayed.map((message) => message.type === "event" && message.sequence), [1, 2]);
  assert.equal(androidMessages.at(-1)?.type, "snapshot");
});

test("resume replays state events after a Usage sequence and finishes with the authoritative snapshot", () => {
  const base = Date.parse("2026-10-07T00:00:00.000Z");
  const relay = new Relay({ autoStart: false, now: () => new Date(base + 4_000) });
  const collectorMessages = messages();
  const phoneMessages = messages();
  const collector = relay.connect({ gateway: "collector", installation_id: "install-1", transport: { send: (message) => collectorMessages.push(message) } });
  const phone = relay.connect({ gateway: "android", installation_id: "install-1", transport: { send: (message) => phoneMessages.push(message) } });

  relay.receive(collector.connection_id, JSON.stringify(event({
    event_id: "resume-task-start",
    sequence: 1,
    event_type: "task_started",
    task_id: "task-resume",
    occurred_at: new Date(base + 1_000).toISOString(),
  })));
  relay.receive(collector.connection_id, JSON.stringify(usageSnapshot({
    event_id: "resume-usage",
    sequence: 2,
    occurred_at: new Date(base + 2_000).toISOString(),
  })));
  relay.receive(collector.connection_id, JSON.stringify(event({
    event_id: "resume-task-finish",
    sequence: 3,
    event_type: "task_finished",
    task_id: "task-resume",
    occurred_at: new Date(base + 3_000).toISOString(),
  })));

  phoneMessages.length = 0;
  relay.receive(phone.connection_id, JSON.stringify({
    type: "resume",
    schema_version: 1,
    installation_id: "install-1",
    last_sequence: 1,
  }));

  const replayed = phoneMessages.filter((message) => message.type === "event");
  assert.deepEqual(replayed.map((message) => message.type === "event" ? message.sequence : -1), [3]);
  assert.equal((replayed[0] as EventEnvelope).event_type, "task_finished");
  assert.equal(phoneMessages.some((message) => (message as { type?: string }).type === "usage_snapshot"), false);
  const finalSnapshot = phoneMessages.filter((message) => message.type === "snapshot").at(-1);
  assert.ok(finalSnapshot && finalSnapshot.type === "snapshot");
  assert.equal(finalSnapshot.usage?.revision, 1);
  assert.equal(finalSnapshot.last_sequence, 3);
  assert.equal(finalSnapshot.recent_completion?.sequence, 3);
  relay.stop();
});

test("paired phones receive sanitized live events before snapshots only for their installation", () => {
  const relay = new Relay({
    autoStart: false,
    config: {
      authMode: "paired",
      bootstrapSecret: "test-bootstrap-secret-long-enough",
    },
  });
  const firstPairing = relay.createPairing({ installation_id: "install-1" });
  const firstPhone = relay.claimPairingResult(firstPairing.pairing_id, firstPairing.code);
  const secondPairing = relay.createPairing({ installation_id: "install-2" });
  const secondPhone = relay.claimPairingResult(secondPairing.pairing_id, secondPairing.code);
  assert.ok(firstPhone);
  assert.ok(secondPhone);

  const firstCollectorMessages = messages();
  const secondCollectorMessages = messages();
  const firstPhoneMessages = messages();
  const secondPhoneMessages = messages();
  const preAuthPhoneMessages = messages();
  const badTokenPhoneMessages = messages();
  const firstCollector = relay.connect({
    gateway: "collector",
    token: firstPairing.collector_token,
    transport: { send: (message) => firstCollectorMessages.push(message) },
  });
  const secondCollector = relay.connect({
    gateway: "collector",
    token: secondPairing.collector_token,
    transport: { send: (message) => secondCollectorMessages.push(message) },
  });
  const firstAndroid = relay.connect({
    gateway: "android",
    token: firstPhone.android_token,
    transport: { send: (message) => firstPhoneMessages.push(message) },
  });
  const secondAndroid = relay.connect({
    gateway: "android",
    token: secondPhone.android_token,
    transport: { send: (message) => secondPhoneMessages.push(message) },
  });
  const preAuthAndroid = relay.connect({
    gateway: "android",
    installation_id: "install-1",
    transport: { send: (message) => preAuthPhoneMessages.push(message) },
  });
  const badTokenAndroid = relay.connect({
    gateway: "android",
    installation_id: "install-1",
    token: "and_invalid_test_token",
    transport: { send: (message) => badTokenPhoneMessages.push(message) },
  });

  relay.receive(preAuthAndroid.connection_id, JSON.stringify({
    type: "subscribe",
    schema_version: 1,
    installation_id: "install-1",
  }));
  relay.receive(badTokenAndroid.connection_id, JSON.stringify({
    type: "subscribe",
    schema_version: 1,
    installation_id: "install-1",
    token: "and_invalid_test_token",
  }));
  assert.ok(badTokenPhoneMessages.some((message) => message.type === "error"));

  relay.receive(firstAndroid.connection_id, JSON.stringify({
    type: "subscribe",
    schema_version: 1,
    installation_id: "install-1",
    installation_ids: ["install-1", "install-2"],
    all: true,
    token: firstPhone.android_token,
  }));
  const firstSubscription = firstPhoneMessages.find((message) => message.type === "subscribe");
  assert.ok(firstSubscription && firstSubscription.type === "subscribe");
  assert.deepEqual(firstSubscription.installation_ids, ["install-1"]);
  assert.equal(firstSubscription.all, false);
  relay.receive(secondAndroid.connection_id, JSON.stringify({
    type: "subscribe",
    schema_version: 1,
    installation_id: "install-2",
    token: secondPhone.android_token,
  }));

  firstPhoneMessages.length = 0;
  secondPhoneMessages.length = 0;
  preAuthPhoneMessages.length = 0;
  badTokenPhoneMessages.length = 0;

  const firstEvent = event({
    payload: { prompt: "private prompt", visible: "safe status" },
  });
  relay.receive(firstCollector.connection_id, JSON.stringify(firstEvent));
  const firstDelivery = firstPhoneMessages.filter(
    (message) => message.type === "event" || message.type === "snapshot",
  );
  assert.deepEqual(firstDelivery.map((message) => message.type), ["event", "snapshot"]);
  const liveEvent = firstDelivery[0];
  assert.ok(liveEvent && liveEvent.type === "event");
  assert.equal(liveEvent.event_id, "event-1");
  assert.deepEqual(liveEvent.payload, { prompt: "[REDACTED]", visible: "safe status" });
  const firstSnapshot = firstDelivery[1];
  assert.ok(firstSnapshot && firstSnapshot.type === "snapshot");
  assert.equal(firstSnapshot.last_sequence, 1);
  assert.equal(
    secondPhoneMessages.some((message) => message.type === "event" || message.type === "snapshot"),
    false,
  );
  assert.equal(
    preAuthPhoneMessages.some((message) => message.type === "event" || message.type === "snapshot"),
    false,
  );
  assert.equal(
    badTokenPhoneMessages.some((message) => message.type === "event" || message.type === "snapshot"),
    false,
  );

  const deliveredCount = firstPhoneMessages.length;
  relay.receive(firstCollector.connection_id, JSON.stringify(firstEvent));
  assert.equal(firstPhoneMessages.length, deliveredCount);

  firstPhoneMessages.length = 0;
  const secondEvent = event({
    event_id: "event-2",
    installation_id: "install-2",
    sequence: 1,
    event_type: "task_started",
    payload: { task_id: "task-2" },
  });
  relay.receive(secondCollector.connection_id, JSON.stringify(secondEvent));
  const secondDelivery = secondPhoneMessages.filter(
    (message) => message.type === "event" || message.type === "snapshot",
  );
  assert.deepEqual(secondDelivery.map((message) => message.type), ["event", "snapshot"]);
  assert.equal(secondDelivery[0]?.type === "event" ? secondDelivery[0].installation_id : undefined, "install-2");
  assert.equal(
    firstPhoneMessages.some((message) => message.type === "event" || message.type === "snapshot"),
    false,
  );

  firstPhoneMessages.length = 0;
  relay.receive(firstAndroid.connection_id, JSON.stringify({
    type: "resume",
    schema_version: 1,
    installation_id: "install-2",
    last_sequence: 0,
  }));
  assert.ok(firstPhoneMessages.some((message) => message.type === "error"));
  assert.equal(
    firstPhoneMessages.some((message) => message.type === "event" || message.type === "snapshot"),
    false,
  );

  relay.stop();
});
