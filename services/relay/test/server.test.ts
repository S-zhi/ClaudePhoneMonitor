import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

import { createRelayServer } from "../src/server.js";

interface TestClient {
  socket: WebSocket;
  messages: Record<string, unknown>[];
  waitFor(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
}

function open(url: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const backlog: Record<string, unknown>[] = [];
    const messages: Record<string, unknown>[] = [];
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
      messages.push(message);
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
        messages,
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
    assert.deepEqual(health.json().capabilities, ["usage_snapshot_v1", "usage_scoped_cache_v1", "codex_quota_v1", "pairing_collector_reuse_v1"]);

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

test("WebSocket clients receive snapshots but no presentation for stale or terminal task tails", async () => {
  const now = new Date("2026-10-02T00:00:01.000Z");
  const { app } = createRelayServer({
    config: { host: "127.0.0.1", port: 0, bookkeepingIntervalMs: 60_000, heartbeatIntervalMs: 60_000 },
    relayOptions: { autoStart: false, now: () => now },
  });
  let collector: TestClient | undefined;
  let phone: TestClient | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    const base = `ws://127.0.0.1:${address.port}`;
    collector = await open(`${base}/ws/collector?installation_id=install-1`);
    phone = await open(`${base}/ws/android?installation_id=install-1`);
    await collector.waitFor((message) => message.type === "hello_ack");
    await phone.waitFor((message) => message.type === "hello_ack");
    const records = [
      { event_type: "task_started", task_id: "old" },
      { event_type: "task_started", task_id: "current" },
      { event_type: "task_finished", task_id: "old" },
      { event_type: "waiting", task_id: "old" },
      { event_type: "task_finished", task_id: "current" },
      { event_type: "task_finished", task_id: "current" },
      { event_type: "waiting" },
    ];
    for (const [index, record] of records.entries()) {
      const sequence = index + 1;
      collector.socket.send(JSON.stringify({ type: "event", schema_version: 1, installation_id: "install-1", session_id: "session-1", event_id: `socket-${sequence}`, sequence, occurred_at: now.toISOString(), payload: {}, ...record }));
      const ack: Record<string, unknown> = await collector.waitFor((message) => message.type === "event_ack" && message.sequence === sequence);
      assert.equal(ack.accepted, true);
      const snapshot = await phone.waitFor((message) => message.type === "snapshot" && message.last_sequence === sequence);
      assert.equal(snapshot.claude_state, sequence < 5 ? "working" : "idle");
      if (sequence >= 5) assert.equal((snapshot.recent_completion as { sequence: number }).sequence, 5);
    }
    assert.deepEqual(phone.messages.filter((message) => message.type === "event").map((message) => message.sequence), [1, 2, 5]);
    const offset = phone.messages.length;
    phone.socket.send(JSON.stringify({ type: "resume", schema_version: 1, installation_id: "install-1", last_sequence: 2 }));
    await phone.waitFor((message) => message.type === "snapshot" && message.last_sequence === 7);
    assert.deepEqual(phone.messages.slice(offset).filter((message) => message.type === "event").map((message) => message.sequence), [5]);
  } finally {
    await closeClient(collector);
    await closeClient(phone);
    await app.close();
  }
});

test("paired bootstrap validates and reuses the existing installation collector token", async () => {
  const { app, relay } = createRelayServer({
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
    const health = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(health.json().storage, "memory");
    assert.deepEqual(health.json().capabilities, ["usage_snapshot_v1", "usage_scoped_cache_v1", "codex_quota_v1", "pairing_collector_reuse_v1"]);
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

    const validateHeaders = { authorization: "Bearer bootstrap-secret-for-relay-tests-123456" };
    const tokenCheck = await app.inject({
      method: "POST",
      url: "/v1/collector-token/validate",
      headers: validateHeaders,
      payload: { installation_id: "paired-install", collector_token: pairing.collector_token },
    });
    assert.equal(tokenCheck.statusCode, 200);
    assert.deepEqual(tokenCheck.json(), { valid: true, installation_id: "paired-install" });
    const wrongRoleToken = "synthetic-android-token-for-relay-test";
    relay.repository.createDeviceToken({
      role: "android",
      installation_id: "paired-install",
      token: wrongRoleToken,
      issued_at: new Date().toISOString(),
    });
    for (const invalidPayload of [
      { installation_id: "paired-install", collector_token: "synthetic-invalid-token" },
      { installation_id: "other-install", collector_token: pairing.collector_token },
      { installation_id: "paired-install", collector_token: wrongRoleToken },
    ]) {
      const rejected = await app.inject({
        method: "POST",
        url: "/v1/collector-token/validate",
        headers: validateHeaders,
        payload: invalidPayload,
      });
      assert.equal(rejected.statusCode, 401);
      assert.deepEqual(rejected.json(), { error: "invalid_collector_token" });
    }
    const unauthenticatedCheck = await app.inject({
      method: "POST",
      url: "/v1/collector-token/validate",
      payload: { installation_id: "paired-install", collector_token: pairing.collector_token },
    });
    assert.equal(unauthenticatedCheck.statusCode, 401);
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

    const reused = await app.inject({
      method: "POST",
      url: "/v1/pairing",
      headers: validateHeaders,
      payload: {
        installation_id: "paired-install",
        relay_url: "http://192.168.1.3:8787",
        collector_token: pairing.collector_token,
      },
    });
    assert.equal(reused.statusCode, 201);
    assert.equal(reused.json().installation_id, "paired-install");
    assert.equal(reused.json().collector_token, pairing.collector_token);
    assert.equal(relay.repository.validateToken(phone.android_token, "android", new Date().toISOString())?.installation_id, "paired-install");
    const wrongInstallationReuse = await app.inject({
      method: "POST",
      url: "/v1/pairing",
      headers: validateHeaders,
      payload: {
        installation_id: "other-install",
        relay_url: "http://192.168.1.3:8787",
        collector_token: pairing.collector_token,
      },
    });
    assert.equal(wrongInstallationReuse.statusCode, 401);
    assert.deepEqual(wrongInstallationReuse.json(), { error: "invalid_collector_token" });

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
