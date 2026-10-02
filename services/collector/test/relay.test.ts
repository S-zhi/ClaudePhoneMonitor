import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { FileOutbox } from "../src/outbox.ts";
import { RelayClient, type RelayTimerApi, type WebSocketLike } from "../src/relay.ts";
import type { EventEnvelope } from "../src/types.ts";

class FakeSocket implements WebSocketLike {
  public readyState = 0;
  public readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  public send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  public close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  public addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  public open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }
}

function fakeTimers(): RelayTimerApi {
  return {
    setTimeout: (callback) => ({ callback }),
    clearTimeout: () => undefined,
    setInterval: (callback) => ({ callback }),
    clearInterval: () => undefined,
  };
}

test("relay sends canonical hello/event and removes only acknowledged events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collector-relay-"));
  try {
    const outbox = new FileOutbox<EventEnvelope>(join(directory, "outbox.json"));
    const envelope: EventEnvelope = {
      type: "event",
      schema_version: 1,
      event_id: "install-1:1",
      installation_id: "install-1",
      session_id: "session-1",
      sequence: 1,
      occurred_at: "2026-10-02T10:00:00.000Z",
      event_type: "session_started",
      payload: {},
    };
    await outbox.enqueue({ id: envelope.event_id, sequence: 1, payload: envelope });
    const socket = new FakeSocket();
    const relay = new RelayClient({
      url: "wss://relay.invalid",
      installationId: "install-1",
      token: "collector-secret-for-test",
      outbox,
      websocketFactory: () => socket,
      timers: fakeTimers(),
      jitterMs: 0,
    });
    relay.start();
    socket.open();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(socket.sent[0], {
      type: "hello",
      schema_version: 1,
      role: "collector",
      installation_id: "install-1",
      last_sequence: 0,
      token: "collector-secret-for-test",
    });
    assert.deepEqual(socket.sent[1], envelope);
    assert.equal(await outbox.size(), 1);

    socket.emit("message", {
      data: JSON.stringify({ type: "event_ack", event_id: envelope.event_id, sequence: 1 }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await outbox.size(), 0);
    assert.equal(relay.state().last_sequence, 1);
    relay.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("flushes an event enqueued after the relay connection opens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collector-relay-"));
  try {
    const outbox = new FileOutbox<EventEnvelope>(join(directory, "outbox.json"));
    const socket = new FakeSocket();
    const relay = new RelayClient({
      url: "wss://relay.invalid",
      installationId: "install-1",
      outbox,
      websocketFactory: () => socket,
      timers: fakeTimers(),
      jitterMs: 0,
    });
    relay.start();
    socket.open();

    const envelope: EventEnvelope = {
      type: "event",
      schema_version: 1,
      event_id: "install-1:2",
      installation_id: "install-1",
      session_id: "session-1",
      sequence: 2,
      occurred_at: "2026-10-02T10:00:01.000Z",
      event_type: "task_started",
      payload: {},
    };
    await outbox.enqueue({ id: envelope.event_id, sequence: 2, payload: envelope });
    await relay.flushPending();

    assert.deepEqual(socket.sent.at(-1), envelope);
    relay.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("relay acknowledges a server heartbeat once without creating an ack loop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collector-relay-"));
  try {
    const outbox = new FileOutbox<EventEnvelope>(join(directory, "outbox.json"));
    const socket = new FakeSocket();
    const relay = new RelayClient({
      url: "wss://relay.invalid",
      installationId: "install-1",
      outbox,
      websocketFactory: () => socket,
      timers: fakeTimers(),
      jitterMs: 0,
      now: () => Date.parse("2026-10-02T00:00:00.000Z"),
    });
    relay.start();
    socket.open();
    const before = socket.sent.length;
    await relay.handleServerMessage({
      data: JSON.stringify({ type: "heartbeat", heartbeat_id: "hb-1", acknowledged: false }),
    });
    assert.equal(socket.sent.length, before + 1);
    assert.deepEqual(socket.sent.at(-1), {
      type: "heartbeat",
      schema_version: 1,
      role: "collector",
      installation_id: "install-1",
      last_sequence: 0,
      heartbeat_id: "hb-1",
      sent_at: "2026-10-02T00:00:00.000Z",
      occurred_at: "2026-10-02T00:00:00.000Z",
      acknowledged: true,
    });
    await relay.handleServerMessage({
      data: JSON.stringify({ type: "heartbeat", heartbeat_id: "hb-1", acknowledged: true }),
    });
    assert.equal(socket.sent.length, before + 1);
    relay.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("relay challenge responder echoes probe id and nonce", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collector-relay-"));
  try {
    const outbox = new FileOutbox<EventEnvelope>(join(directory, "outbox.json"));
    const socket = new FakeSocket();
    const relay = new RelayClient({
      url: "wss://relay.invalid",
      installationId: "install-1",
      outbox,
      websocketFactory: () => socket,
      timers: fakeTimers(),
      jitterMs: 0,
    });
    relay.start();
    socket.open();
    await relay.handleServerMessage({
      data: JSON.stringify({ type: "challenge", probe_id: "probe-1", nonce: "nonce-1" }),
    });
    assert.deepEqual(socket.sent.at(-1), {
      type: "challenge_ack",
      probe_id: "probe-1",
      nonce: "nonce-1",
    });
    relay.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
