import { test } from "node:test";
import assert from "node:assert/strict";

import { JsonLogger } from "../src/logger.js";
import { Relay } from "../src/relay.js";
import type { EventEnvelope, ServerMessage } from "../src/types.js";

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
