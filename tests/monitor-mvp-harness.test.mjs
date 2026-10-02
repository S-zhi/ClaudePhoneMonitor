import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const THIS_FILE = fileURLToPath(import.meta.url);
const TESTS_DIR = resolve(THIS_FILE, "..");

const EVENT_TYPES = new Set([
  "session_started",
  "task_started",
  "tool_started",
  "tool_finished",
  "tool_failed",
  "waiting",
  "task_finished",
  "task_failed",
  "session_ended",
  "heartbeat",
]);

const MESSAGE_TYPES = new Set([
  "hello",
  "hello_ack",
  "event",
  "event_ack",
  "heartbeat",
  "subscribe",
  "snapshot",
  "resume",
  "probe",
  "challenge",
  "challenge_ack",
  "error",
]);

const REDACTED = "[REDACTED]";
const REDACTED_PATH = "<redacted-path>";
const SENSITIVE_KEYS = new Set([
  "prompt",
  "toolinput",
  "toolresult",
  "stdout",
  "stderr",
  "result",
  "apikey",
  "authorization",
  "password",
  "secret",
  "token",
]);

const clone = (value) => JSON.parse(JSON.stringify(value));

const normalizeKey = (key) => key.toLowerCase().replaceAll(/[_.-]/g, "");

/**
 * Apply the phone boundary's privacy policy to arbitrary JSON. Event payloads
 * are intentionally opaque: this helper does not infer a Claude Hook schema.
 */
export function redactForPhone(value) {
  if (Array.isArray(value)) return value.map(redactForPhone);
  if (value === null || typeof value !== "object") {
    if (typeof value !== "string") return value;

    return value
      .replaceAll(
        /\b(?:sk-ant|sk-proj|ghp|github_pat)_[A-Za-z0-9_-]+\b/gi,
        "<redacted-secret>",
      )
      .replaceAll(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer <redacted-secret>")
      .replaceAll(
        /(?:\/Users|\/home|\/private|\/tmp|\/var|\/opt|\/etc)\/[^\s"'`,;)}\]]+/g,
        REDACTED_PATH,
      )
      .replaceAll(/\b[A-Za-z]:\\[^\s"'`,;)}\]]+/g, REDACTED_PATH);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEYS.has(normalizeKey(key)) ? REDACTED : redactForPhone(entry),
    ]),
  );
}

function redactEvent(event) {
  return redactForPhone(event);
}

function assertEventEnvelope(event) {
  assert.equal(event.type, "event");
  assert.equal(event.schema_version, 1);
  for (const field of [
    "event_id",
    "installation_id",
    "session_id",
    "sequence",
    "occurred_at",
    "event_type",
    "payload",
  ]) {
    assert.ok(field in event, `event envelope is missing ${field}`);
  }
  assert.equal(typeof event.event_id, "string");
  assert.equal(typeof event.installation_id, "string");
  assert.equal(typeof event.session_id, "string");
  assert.equal(typeof event.sequence, "number");
  assert.equal(typeof event.occurred_at, "string");
  assert.ok(EVENT_TYPES.has(event.event_type), `unknown event type ${event.event_type}`);
}

function initialSnapshot(installationId) {
  return {
    installation_id: installationId,
    computer_state: "offline",
    claude_state: "idle",
    last_sequence: 0,
    updated_at: "1970-01-01T00:00:00.000Z",
  };
}

function applyEvent(snapshot, event) {
  const next = { ...snapshot };
  next.last_sequence = event.sequence;
  next.updated_at = event.occurred_at;

  switch (event.event_type) {
    case "session_started":
      next.computer_state = "online";
      next.claude_state = "idle";
      next.activity = "session_started";
      break;
    case "session_ended":
      next.computer_state = "offline";
      next.claude_state = "idle";
      next.activity = "session_ended";
      break;
    case "task_started":
    case "tool_started":
      next.computer_state = "online";
      next.claude_state = "working";
      next.activity = event.event_type;
      break;
    case "waiting":
      next.computer_state = "online";
      next.claude_state = "waiting";
      next.activity = "waiting";
      break;
    case "task_finished":
    case "task_failed":
    case "tool_finished":
    case "tool_failed":
      next.computer_state = "online";
      next.claude_state = "idle";
      next.activity = event.event_type;
      break;
    case "heartbeat":
      next.computer_state = "online";
      next.activity = "heartbeat";
      break;
    default:
      throw new Error(`unhandled event type ${event.event_type}`);
  }

  return next;
}

class FakeConnection {
  constructor(relay, { clientId, installationId, onMessage }) {
    this.relay = relay;
    this.clientId = clientId;
    this.installationId = installationId;
    this.onMessage = onMessage;
    this.connectionId = `${clientId}-connection`;
    this.closed = false;
    this.handshaken = false;
    this.subscribed = false;
    this.inbox = [];
  }

  send(message) {
    if (this.closed) throw new Error("cannot send on a closed fake connection");
    this.relay.receive(this, message);
  }

  deliver(message) {
    if (this.closed) return;
    const copy = clone(message);
    this.inbox.push(copy);
    this.onMessage?.(copy);
  }

  close() {
    this.relay.disconnect(this);
  }
}

/**
 * Small deterministic in-memory stand-in for the relay. It deliberately lives
 * under tests/ so it cannot be mistaken for production transport code.
 */
export class FakeRelay {
  constructor({ probeTimeoutMs = 10 } = {}) {
    this.probeTimeoutMs = probeTimeoutMs;
    this.connections = new Set();
    this.history = [];
    this.snapshots = new Map();
    this.pendingProbes = new Map();
    this.receivedTypes = [];
  }

  connect(options) {
    const connection = new FakeConnection(this, options);
    this.connections.add(connection);
    return connection;
  }

  disconnect(connection) {
    connection.closed = true;
    connection.subscribed = false;
    this.connections.delete(connection);
    for (const key of [...this.pendingProbes.keys()]) {
      if (key.startsWith(`${connection.connectionId}:`)) {
        clearTimeout(this.pendingProbes.get(key).timer);
        this.pendingProbes.delete(key);
      }
    }
  }

  receive(connection, message) {
    assert.ok(MESSAGE_TYPES.has(message.type), `unknown relay message ${message.type}`);
    this.receivedTypes.push(message.type);

    switch (message.type) {
      case "hello":
        connection.handshaken = true;
        connection.installationId = message.installation_id;
        this.markOnline(connection.installationId);
        connection.deliver({
          type: "hello_ack",
          protocol_version: 1,
          connection_id: connection.connectionId,
          installation_id: connection.installationId,
        });
        break;
      case "subscribe":
        this.requireHandshake(connection);
        connection.subscribed = true;
        this.sendSnapshot(connection);
        break;
      case "resume":
        this.requireHandshake(connection);
        this.resume(connection, message.last_sequence ?? 0);
        break;
      case "event":
        this.requireHandshake(connection);
        this.acceptEvent(connection, message.event);
        break;
      case "heartbeat":
        this.requireHandshake(connection);
        connection.deliver({ type: "heartbeat", acknowledged: true, nonce: message.nonce });
        break;
      case "probe":
        this.requireHandshake(connection);
        this.issueProbe(connection, message);
        break;
      case "challenge_ack":
        this.requireHandshake(connection);
        this.resolveProbe(connection, message);
        break;
      default:
        connection.deliver({
          type: "error",
          code: "UNSUPPORTED_MESSAGE",
          message: `unsupported fake message ${message.type}`,
          retryable: false,
        });
    }
  }

  publish(connection, event) {
    connection.send({ type: "event", event });
  }

  getHistory(installationId) {
    return this.history
      .filter((event) => event.installation_id === installationId)
      .map(clone)
      .sort((a, b) => a.sequence - b.sequence);
  }

  getSnapshot(installationId) {
    return clone(this.snapshots.get(installationId) ?? initialSnapshot(installationId));
  }

  requireHandshake(connection) {
    if (!connection.handshaken) throw new Error("fake relay requires hello first");
  }

  markOnline(installationId) {
    const current = this.snapshots.get(installationId) ?? initialSnapshot(installationId);
    this.snapshots.set(installationId, {
      ...current,
      computer_state: "online",
    });
  }

  sendSnapshot(connection) {
    connection.deliver({
      type: "snapshot",
      snapshot: this.getSnapshot(connection.installationId),
    });
  }

  resume(connection, lastSequence) {
    const history = this.getHistory(connection.installationId);
    connection.deliver({
      type: "resume",
      installation_id: connection.installationId,
      accepted: true,
      from_sequence: lastSequence + 1,
      latest_sequence: history.at(-1)?.sequence ?? lastSequence,
    });
    for (const event of history) {
      if (event.sequence > lastSequence) {
        connection.deliver({ type: "event", sequence: event.sequence, event });
      }
    }
  }

  acceptEvent(connection, event) {
    assertEventEnvelope(event);
    if (event.installation_id !== connection.installationId) {
      connection.deliver({
        type: "error",
        code: "INSTALLATION_MISMATCH",
        message: "event installation does not match the connection",
        retryable: false,
      });
      return;
    }

    const duplicate = this.history.find(
      (known) =>
        known.event_id === event.event_id ||
        (known.installation_id === event.installation_id && known.sequence === event.sequence),
    );
    if (duplicate) {
      connection.deliver({
        type: "event_ack",
        event_id: event.event_id,
        sequence: event.sequence,
        accepted: false,
        duplicate: true,
      });
      return;
    }

    const safeEvent = redactEvent(event);
    this.history.push(safeEvent);
    const current = this.snapshots.get(event.installation_id) ?? initialSnapshot(event.installation_id);
    const next = applyEvent(current, safeEvent);
    this.snapshots.set(event.installation_id, next);

    connection.deliver({
      type: "event_ack",
      event_id: event.event_id,
      sequence: event.sequence,
      accepted: true,
      duplicate: false,
    });

    for (const subscriber of this.connections) {
      if (
        subscriber !== connection &&
        !subscriber.closed &&
        subscriber.subscribed &&
        subscriber.installationId === event.installation_id
      ) {
        subscriber.deliver({ type: "event", sequence: safeEvent.sequence, event: clone(safeEvent) });
        this.sendSnapshot(subscriber);
      }
    }
  }

  issueProbe(connection, message) {
    const nonce = message.nonce;
    const key = `${connection.connectionId}:${nonce}`;
    const timer = setTimeout(() => {
      const pending = this.pendingProbes.get(key);
      if (!pending) return;
      this.pendingProbes.delete(key);
      const current = this.snapshots.get(connection.installationId) ?? initialSnapshot(connection.installationId);
      const stale = {
        ...current,
        computer_state: "stale",
        activity: "probe_timeout",
      };
      this.snapshots.set(connection.installationId, stale);
      connection.deliver({ type: "snapshot", snapshot: stale });
      connection.deliver({
        type: "error",
        code: "PROBE_TIMEOUT",
        message: "probe challenge was not acknowledged before the deadline",
        retryable: true,
      });
    }, message.timeout_ms ?? this.probeTimeoutMs);

    this.pendingProbes.set(key, { connection, timer });
    connection.deliver({ type: "challenge", nonce });
  }

  resolveProbe(connection, message) {
    const key = `${connection.connectionId}:${message.nonce}`;
    const pending = this.pendingProbes.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingProbes.delete(key);
    const current = this.snapshots.get(connection.installationId) ?? initialSnapshot(connection.installationId);
    this.snapshots.set(connection.installationId, {
      ...current,
      computer_state: "online",
      activity: "probe_acknowledged",
    });
    this.sendSnapshot(connection);
  }
}

export class FakeSubscriber {
  constructor(relay, { clientId, installationId, autoAckProbe = true }) {
    this.relay = relay;
    this.clientId = clientId;
    this.installationId = installationId;
    this.autoAckProbe = autoAckProbe;
    this.connection = null;
    this.lastSequence = 0;
    this.events = [];
    this.snapshots = [];
    this.messages = [];
    this.errors = [];
    this.resumeMessages = [];
  }

  connect() {
    this.connection = this.relay.connect({
      clientId: this.clientId,
      installationId: this.installationId,
      onMessage: (message) => this.receive(message),
    });
    this.connection.send({
      type: "hello",
      protocol_version: 1,
      client_id: this.clientId,
      installation_id: this.installationId,
    });
    this.connection.send({
      type: "resume",
      installation_id: this.installationId,
      last_sequence: this.lastSequence,
    });
    this.connection.send({
      type: "subscribe",
      installation_id: this.installationId,
    });
  }

  disconnect() {
    this.connection?.close();
    this.connection = null;
  }

  requestProbe(nonce, timeoutMs = this.relay.probeTimeoutMs) {
    this.connection.send({ type: "probe", nonce, timeout_ms: timeoutMs });
  }

  heartbeat(nonce) {
    this.connection.send({ type: "heartbeat", nonce });
  }

  receive(message) {
    this.messages.push(message);
    switch (message.type) {
      case "event":
        if (message.sequence > this.lastSequence) {
          this.lastSequence = message.sequence;
          this.events.push(message.event);
        }
        break;
      case "snapshot":
        this.snapshots.push(message.snapshot);
        this.lastSequence = Math.max(this.lastSequence, message.snapshot.last_sequence);
        break;
      case "resume":
        this.resumeMessages.push(message);
        break;
      case "challenge":
        if (this.autoAckProbe) {
          this.connection.send({ type: "challenge_ack", nonce: message.nonce });
        }
        break;
      case "error":
        this.errors.push(message);
        break;
      default:
        break;
    }
  }

  latestSnapshot() {
    assert.ok(this.snapshots.length > 0, "subscriber has not received a snapshot");
    return this.snapshots.at(-1);
  }
}

async function loadFixture(name) {
  const fixturePath = resolve(TESTS_DIR, "fixtures", name);
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

const events = await loadFixture("simulated-events.json");
const privacyFixture = await loadFixture("privacy-payload.json");

function createPublisher(relay, installationId) {
  const publisher = relay.connect({
    clientId: "fake-hook-adapter",
    installationId,
  });
  publisher.send({
    type: "hello",
    protocol_version: 1,
    client_id: "fake-hook-adapter",
    installation_id: installationId,
  });
  return publisher;
}

test("synthetic fixture covers the event envelope without asserting Hook payload fields", () => {
  assert.equal(events.length, 10);
  assert.deepEqual(
    events.map((event) => event.sequence),
    Array.from({ length: 10 }, (_, index) => index + 1),
  );
  assert.deepEqual(
    new Set(events.map((event) => event.event_type)),
    EVENT_TYPES,
  );
  for (const event of events) {
    assertEventEnvelope(event);
    assert.deepEqual(Object.keys(event.payload), ["fixture_label"]);
  }
});

test("privacy redaction removes sensitive keys, secrets, and absolute paths", () => {
  const redacted = redactForPhone(privacyFixture.payload);
  const serialized = JSON.stringify(redacted);

  for (const secret of [
    "FAKE_PRIVATE_PROMPT_NOT_FROM_A_HOOK",
    "FAKE_PRIVATE_TOOL_INPUT_NOT_FROM_A_HOOK",
    "FAKE_PRIVATE_STDOUT_NOT_FROM_A_HOOK",
    "FAKE_PRIVATE_STDERR_NOT_FROM_A_HOOK",
    "FAKE_PRIVATE_RESULT_NOT_FROM_A_HOOK",
    "sk-ant-SIMULATED_SECRET_123456789",
    "/Users/fake-user/private-project",
    "/private/tmp/fake-private-source.ts",
    "SIMULATED_BEARER_TOKEN_NOT_REAL",
  ]) {
    assert.equal(serialized.includes(secret), false, `secret leaked: ${secret}`);
  }
  assert.equal(redacted.prompt, REDACTED);
  assert.equal(redacted.tool_input, REDACTED);
  assert.equal(redacted.tool_result, REDACTED);
  assert.match(redacted.diagnostic, /<redacted-path>/);
  assert.match(redacted.diagnostic, /Bearer <redacted-secret>/);
});

test("end-to-end event -> relay -> subscriber drives snapshot state transitions", () => {
  const relay = new FakeRelay();
  const installationId = events[0].installation_id;
  const publisher = createPublisher(relay, installationId);
  const subscriber = new FakeSubscriber(relay, {
    clientId: "fake-phone",
    installationId,
  });
  subscriber.connect();

  for (const event of events) relay.publish(publisher, event);

  for (const snapshot of subscriber.snapshots) {
    for (const field of [
      "installation_id",
      "computer_state",
      "claude_state",
      "last_sequence",
      "updated_at",
    ]) {
      assert.ok(field in snapshot, `snapshot is missing ${field}`);
    }
    assert.ok(["online", "stale", "offline"].includes(snapshot.computer_state));
    assert.ok(["idle", "working", "waiting"].includes(snapshot.claude_state));
  }

  assert.deepEqual(
    subscriber.events.map((event) => event.event_id),
    events.map((event) => event.event_id),
  );
  assert.equal(subscriber.lastSequence, 10);

  const snapshotAt = (sequence) =>
    subscriber.snapshots.find((snapshot) => snapshot.last_sequence === sequence);
  assert.deepEqual(
    {
      computer_state: snapshotAt(1).computer_state,
      claude_state: snapshotAt(1).claude_state,
    },
    { computer_state: "online", claude_state: "idle" },
  );
  assert.equal(snapshotAt(2).claude_state, "working");
  assert.equal(snapshotAt(3).claude_state, "working");
  assert.equal(snapshotAt(4).claude_state, "idle");
  assert.equal(snapshotAt(5).claude_state, "waiting");
  assert.equal(snapshotAt(6).claude_state, "idle");
  assert.equal(snapshotAt(10).computer_state, "offline");
  assert.equal(snapshotAt(10).claude_state, "idle");

  relay.publish(publisher, events[5]);
  const duplicateAck = publisher.inbox.at(-1);
  assert.deepEqual(
    {
      type: duplicateAck.type,
      event_id: duplicateAck.event_id,
      accepted: duplicateAck.accepted,
      duplicate: duplicateAck.duplicate,
    },
    {
      type: "event_ack",
      event_id: events[5].event_id,
      accepted: false,
      duplicate: true,
    },
  );
  assert.equal(subscriber.events.length, events.length);
});

test("disconnect and reconnect resume strictly after the subscriber cursor", () => {
  const relay = new FakeRelay();
  const installationId = events[0].installation_id;
  const publisher = createPublisher(relay, installationId);
  const subscriber = new FakeSubscriber(relay, {
    clientId: "fake-phone-resume",
    installationId,
  });
  subscriber.connect();

  relay.publish(publisher, events[0]);
  relay.publish(publisher, events[1]);
  assert.equal(subscriber.lastSequence, 2);

  subscriber.disconnect();
  relay.publish(publisher, events[2]);
  relay.publish(publisher, events[3]);
  assert.equal(subscriber.events.length, 2, "disconnected subscriber must not receive events");

  subscriber.connect();
  assert.equal(subscriber.lastSequence, 4);
  assert.deepEqual(
    subscriber.events.map((event) => event.sequence),
    [1, 2, 3, 4],
  );
  assert.equal(subscriber.resumeMessages.at(-1).from_sequence, 3);
  assert.equal(subscriber.resumeMessages.at(-1).latest_sequence, 4);
});

test("heartbeat, probe challenge acknowledgement, and probe timeout use the WS vocabulary", async () => {
  const relay = new FakeRelay({ probeTimeoutMs: 5 });
  const installationId = events[0].installation_id;
  const publisher = createPublisher(relay, installationId);
  const subscriber = new FakeSubscriber(relay, {
    clientId: "fake-phone-probe",
    installationId,
    autoAckProbe: true,
  });
  subscriber.connect();
  subscriber.heartbeat("heartbeat-1");
  subscriber.requestProbe("probe-ack", 5);
  assert.equal(subscriber.latestSnapshot().computer_state, "online");

  subscriber.autoAckProbe = false;
  subscriber.requestProbe("probe-timeout", 5);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));

  assert.equal(subscriber.latestSnapshot().computer_state, "stale");
  assert.equal(subscriber.errors.at(-1).code, "PROBE_TIMEOUT");
  relay.publish(publisher, events[0]);
  assert.equal(relay.getSnapshot(installationId).last_sequence, 1);
  for (const type of [
    "hello",
    "hello_ack",
    "event",
    "event_ack",
    "heartbeat",
    "subscribe",
    "snapshot",
    "resume",
    "probe",
    "challenge",
    "challenge_ack",
    "error",
  ]) {
    assert.ok(
      relay.receivedTypes.includes(type) ||
        subscriber.messages.some((message) => message.type === type) ||
        publisher.inbox.some((message) => message.type === type),
      `message vocabulary is missing ${type}`,
    );
  }
});

test("relay stores and broadcasts only redacted event payloads", () => {
  const relay = new FakeRelay();
  const installationId = "fake-installation-privacy";
  const publisher = createPublisher(relay, installationId);
  const subscriber = new FakeSubscriber(relay, {
    clientId: "fake-phone-privacy",
    installationId,
  });
  subscriber.connect();

  const privateEvent = {
    type: "event",
    schema_version: 1,
    event_id: "fake-private-event",
    installation_id: installationId,
    session_id: "fake-session-privacy",
    sequence: 1,
    occurred_at: "2026-10-02T10:00:00Z",
    event_type: "tool_started",
    payload: privacyFixture.payload,
  };
  relay.publish(publisher, privateEvent);

  const stored = relay.getHistory(installationId)[0];
  const delivered = subscriber.events.at(-1);
  for (const value of [stored, delivered]) {
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes("FAKE_PRIVATE_"), false);
    assert.equal(serialized.includes("sk-ant-SIMULATED_SECRET_123456789"), false);
    assert.equal(serialized.includes("/Users/fake-user/private-project"), false);
    assert.equal(serialized.includes("/private/tmp/fake-private-source.ts"), false);
  }
  assert.equal(delivered.payload.prompt, REDACTED);
  assert.equal(delivered.payload.tool_input, REDACTED);
  assert.equal(delivered.payload.tool_result, REDACTED);
});

// Keep the harness useful as a focused smoke test as well as a node:test file.
export const harnessContract = Object.freeze({
  eventTypes: [...EVENT_TYPES],
  messageTypes: [...MESSAGE_TYPES],
  snapshotRequiredFields: [
    "installation_id",
    "computer_state",
    "claude_state",
    "last_sequence",
    "updated_at",
  ],
});
