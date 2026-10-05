import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

import { createRelayServer } from "../src/server.js";

interface TestClient {
  socket: WebSocket;
  waitFor(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
}

function open(url: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const backlog: Record<string, unknown>[] = [];
    const waiters: Array<{
      predicate: (message: Record<string, unknown>) => boolean;
      resolve: (message: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }> = [];

    socket.on("message", (data: WebSocket.RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null) return;
      const message = parsed as Record<string, unknown>;
      const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
      if (waiterIndex >= 0) {
        const waiter = waiters.splice(waiterIndex, 1)[0];
        waiter?.resolve(message);
      } else {
        backlog.push(message);
      }
    });
    socket.once("error", reject);
    socket.once("open", () => {
      socket.removeListener("error", reject);
      resolve({
        socket,
        waitFor(predicate) {
          const backlogIndex = backlog.findIndex(predicate);
          if (backlogIndex >= 0) {
            const message = backlog.splice(backlogIndex, 1)[0];
            return Promise.resolve(message as Record<string, unknown>);
          }
          return new Promise((waitResolve, waitReject) => {
            const timeout = setTimeout(() => {
              const index = waiters.findIndex((waiter) => waiter.reject === waitReject);
              if (index >= 0) waiters.splice(index, 1);
              waitReject(new Error("timed out waiting for WebSocket message"));
            }, 2_000);
            timeout.unref();
            waiters.push({
              predicate,
              resolve: (message) => {
                clearTimeout(timeout);
                waitResolve(message);
              },
              reject: (error) => {
                clearTimeout(timeout);
                waitReject(error);
              },
            });
          });
        },
      });
    });
  });
}

async function closeClient(client: TestClient | undefined): Promise<void> {
  if (!client || client.socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    client.socket.once("close", settle);
    client.socket.once("error", settle);
    client.socket.close();
    const timeout = setTimeout(() => {
      client.socket.terminate();
      settle();
    }, 1_000);
    timeout.unref();
  });
}

test("Fastify health, pairing, and WebSocket gateways are runnable", async () => {
  const { app } = createRelayServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      bookkeepingIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    },
    relayOptions: { autoStart: false },
  });
  let collector: TestClient | undefined;
  let android: TestClient | undefined;
  try {
    await app.ready();

    const health = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().status, "ok");

    const pairing = await app.inject({ method: "POST", url: "/v1/pairing" });
    assert.equal(pairing.statusCode, 201);
    assert.equal(pairing.json().mode, "development");
    assert.equal(typeof pairing.json().code, "string");

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    const base = `ws://127.0.0.1:${address.port}`;
    collector = await open(`${base}/ws/collector?installation_id=install-1`);
    const collectorHello = await collector.waitFor((message) => message.type === "hello_ack");
    assert.equal(collectorHello.accepted, true);
    android = await open(`${base}/ws/android?installation_id=install-1`);
    const androidHello = await android.waitFor((message) => message.type === "hello_ack");
    assert.equal(androidHello.accepted, true);

    collector.socket.send(
      JSON.stringify({
        type: "event",
        schema_version: 1,
        event_id: "event-1",
        installation_id: "install-1",
        session_id: "session-1",
        sequence: 1,
        occurred_at: "2026-10-02T00:00:00.000Z",
        event_type: "session_started",
        payload: { text: "not part of logs" },
      }),
    );
    const ack = await collector.waitFor((message) => message.type === "event_ack");
    assert.equal(ack.status, "accepted");
    assert.equal(ack.sequence, 1);
    const snapshot = await android.waitFor(
      (message) => message.type === "snapshot" && message.last_sequence === 1,
    );
    assert.equal(snapshot.installation_id, "install-1");
    assert.equal(snapshot.computer_state, "online");
    assert.equal(snapshot.claude_state, "idle");
  } finally {
    await closeClient(collector);
    await closeClient(android);
    await app.close();
  }
});

test("paired mode requires bootstrap and role-scoped device tokens", async () => {
  const { app } = createRelayServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      authMode: "paired",
      bootstrapSecret: "bootstrap-secret-for-relay-tests-123456",
      publicUrl: "http://192.168.1.3:8787",
      bookkeepingIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    },
    relayOptions: { autoStart: false },
  });
  let collector: TestClient | undefined;
  let android: TestClient | undefined;
  try {
    await app.ready();
    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/pairing",
      payload: { installation_id: "paired-install", relay_url: "http://192.168.1.3:8787" },
    });
    assert.equal(unauthorized.statusCode, 401);

    const created = await app.inject({
      method: "POST",
      url: "/v1/pairing",
      headers: { authorization: "Bearer bootstrap-secret-for-relay-tests-123456" },
      payload: { installation_id: "paired-install", relay_url: "http://192.168.1.3:8787" },
    });
    assert.equal(created.statusCode, 201);
    const pairing = created.json();
    assert.equal(pairing.installation_id, "paired-install");
    const qr = JSON.parse(pairing.qr_payload);
    assert.deepEqual(
      Object.keys(qr).sort(),
      ["installation_id", "pairing_code", "pairing_id", "relay_http_url", "relay_ws_url", "version"].sort(),
    );
    assert.equal(qr.version, 1);
    assert.equal(qr.relay_http_url, "http://192.168.1.3:8787");
    assert.equal(qr.relay_ws_url, "ws://192.168.1.3:8787/ws/android");

    const claimed = await app.inject({
      method: "POST",
      url: `/v1/pairing/${pairing.pairing_id}/claim`,
      payload: { code: pairing.code, device_name: "test-phone" },
    });
    assert.equal(claimed.statusCode, 200);
    const phone = claimed.json();
    assert.equal(phone.installation_id, "paired-install");
    assert.notEqual(phone.android_token, pairing.collector_token);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    const base = `ws://127.0.0.1:${address.port}`;
    collector = await open(`${base}/ws/collector`);
    collector.socket.send(JSON.stringify({
      type: "hello",
      schema_version: 1,
      role: "collector",
      installation_id: "paired-install",
      token: pairing.collector_token,
    }));
    assert.equal((await collector.waitFor((message) => message.type === "hello_ack" && message.accepted === true)).accepted, true);

    android = await open(`${base}/ws/android`);
    android.socket.send(JSON.stringify({
      type: "hello",
      schema_version: 1,
      role: "phone",
      installation_id: "paired-install",
    }));
    const preAuth = await android.waitFor((message) => message.type === "error" || message.type === "hello_ack");
    assert.ok(preAuth.type === "error" || preAuth.accepted === false);
    android.socket.send(JSON.stringify({
      type: "subscribe",
      schema_version: 1,
      installation_id: "paired-install",
      token: phone.android_token,
      last_sequence: 0,
    }));
    const subscription = await android.waitFor((message) => message.type === "subscribe");
    assert.equal(subscription.type, "subscribe");
  } finally {
    await closeClient(collector);
    await closeClient(android);
    await app.close();
  }
});
