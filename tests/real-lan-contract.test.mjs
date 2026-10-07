import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";

const TEST_TIMEOUT_MS = Number.parseInt(process.env.RELAY_TEST_TIMEOUT_MS ?? "5000", 10);
const TESTS_DIR = new URL("./", import.meta.url);
const FIXTURE_URL = new URL("./fixtures/real-lan-event.json", TESTS_DIR);
const LIVE_BASE_URL = process.env.RELAY_BASE_URL?.replace(/\/+$/, "");
const BOOTSTRAP_SECRET = process.env.RELAY_BOOTSTRAP_SECRET;
const LIVE_TEST_CONFIGURED = Boolean(LIVE_BASE_URL && BOOTSTRAP_SECRET);
if (process.env.RELAY_REQUIRE_LIVE === "1" && !LIVE_TEST_CONFIGURED) throw new Error("required live contract needs relay URL and bootstrap secret");

const PRIVATE_MARKERS = [
  "REAL_LAN_PRIVATE_PROMPT_MUST_NOT_CROSS_PHONE_BOUNDARY",
  "REAL_LAN_PRIVATE_TOOL_INPUT_MUST_NOT_CROSS_PHONE_BOUNDARY",
  "REAL_LAN_PRIVATE_TOOL_RESULT_MUST_NOT_CROSS_PHONE_BOUNDARY",
  "REAL_LAN_PRIVATE_STDOUT_MUST_NOT_CROSS_PHONE_BOUNDARY",
  "REAL_LAN_PRIVATE_STDERR_MUST_NOT_CROSS_PHONE_BOUNDARY",
  "REAL_LAN_PRIVATE_BEARER",
  "/Users/example/private-project/source.ts",
];

let webSocketConstructorPromise;

/**
 * Prefer the Node runtime WebSocket. The relay package's ws dependency is a
 * fallback for Node 20, where WebSocket may not be available globally yet.
 * The live test is opt-in, so a checkout without either implementation still
 * keeps the dependency-free fixture test runnable.
 */
async function loadWebSocketConstructor() {
  if (typeof globalThis.WebSocket === "function") return globalThis.WebSocket;
  if (!webSocketConstructorPromise) {
    webSocketConstructorPromise = (async () => {
      for (const specifier of [
        "ws",
        "../services/relay/node_modules/ws/index.js",
      ]) {
        try {
          const module = await import(specifier);
          const constructor = module.WebSocket ?? module.default;
          if (typeof constructor === "function") return constructor;
        } catch {
          // Try the next optional implementation.
        }
      }
      return undefined;
    })();
  }
  return webSocketConstructorPromise;
}

function addSocketListener(socket, event, listener) {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(event, listener);
  } else if (typeof socket.on === "function") {
    socket.on(event, listener);
  } else {
    throw new Error("WebSocket implementation has no event listener API");
  }
}

function rawMessageText(raw) {
  const value = raw && typeof raw === "object" && "data" in raw ? raw.data : raw;
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
  }
  return typeof value?.toString === "function" ? value.toString() : "";
}

function parseMessage(raw) {
  try {
    const parsed = JSON.parse(rawMessageText(raw));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function timeoutError(description) {
  return new Error(`timed out waiting for ${description}`);
}

/** Small JSON WebSocket adapter supporting Node's WebSocket and ws. */
async function openJsonSocket(url, WebSocketConstructor) {
  const socket = new WebSocketConstructor(url);
  const messages = [];
  const receivedFrames = [];
  const waiters = [];
  let closed = false;
  let closeDetail;
  let resolveClosed;
  const closedPromise = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const deliver = (message) => {
    if (!message) return;
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const waiter = waiters.splice(waiterIndex, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    messages.push(message);
  };

  addSocketListener(socket, "message", (raw) => {
    receivedFrames.push(rawMessageText(raw));
    deliver(parseMessage(raw));
  });
  addSocketListener(socket, "close", (eventOrCode, reason) => {
    closed = true;
    closeDetail = { eventOrCode, reason };
    resolveClosed(closeDetail);
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("WebSocket closed while waiting for a message"));
    }
  });

  const opened = new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(timeoutError(`WebSocket open (${url})`));
      try {
        socket.terminate?.();
        socket.close?.();
      } catch {
        // The open timeout is already the useful failure.
      }
    }, TEST_TIMEOUT_MS);
    timer.unref?.();

    addSocketListener(socket, "open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
    addSocketListener(socket, "error", (error) => {
      if (settled) {
        for (const waiter of waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("WebSocket error while waiting for a message"));
        }
        try { socket.terminate?.(); socket.close?.(); } catch {}
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(`WebSocket error (${url})`));
    });
  });
  try {
    await opened;
  } catch (error) {
    try { socket.terminate?.(); socket.close?.(); } catch {}
    throw error;
  }

  return {
    socket,
    messages,
    receivedFrames,
    get closed() {
      return closed;
    },
    closeDetail() {
      return closeDetail;
    },
    async waitFor(predicate, description = "a WebSocket message") {
      const backlogIndex = messages.findIndex(predicate);
      if (backlogIndex >= 0) return messages.splice(backlogIndex, 1)[0];
      if (closed) throw new Error("WebSocket is already closed");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(timeoutError(description));
        }, TEST_TIMEOUT_MS);
        timer.unref?.();
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
    waitForClose(timeoutMs = TEST_TIMEOUT_MS) {
      if (closed) return Promise.resolve(closeDetail);
      return Promise.race([
        closedPromise,
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(undefined), timeoutMs);
          timer.unref?.();
        }),
      ]);
    },
    send(message) {
      socket.send(JSON.stringify(message));
    },
    async close() {
      if (closed || socket.readyState === 3) return;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        timer.unref?.();
        void this.waitForClose(1_000).then(() => {
          clearTimeout(timer);
          resolve();
        });
        try {
          socket.close(1000, "integration_test_done");
        } catch {
          socket.terminate?.();
        }
      });
      if (!closed) socket.terminate?.();
    },
  };
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    body = undefined;
  }
  return { response, body, raw };
}

function assertUnauthorized(response, label) {
  assert.ok(
    response.status === 401 || response.status === 403,
    `${label} must return 401/403, received ${response.status}`,
  );
}

function assertClaimRejected(response, label) {
  assert.ok(
    response.status === 400 || response.status === 401 || response.status === 403 || response.status === 409,
    `${label} must be rejected, received ${response.status}`,
  );
}

function relayWsEndpoint(wsUrl, gateway) {
  const url = new URL(wsUrl);
  assert.ok(url.protocol === "ws:" || url.protocol === "wss:", "ws_url must use ws:// or wss://");
  assert.equal(url.searchParams.has("token"), false, "tokens must not be placed in query strings");
  const path = url.pathname.replace(/\/$/, "");
  if (path.endsWith(`/ws/${gateway}`)) return url.toString();
  if (/\/ws\/(?:collector|android)$/.test(path)) {
    url.pathname = path.replace(/\/(?:collector|android)$/, `/${gateway}`);
  } else {
    url.pathname = path === "/ws" ? `/ws/${gateway}` : `${path || ""}/ws/${gateway}`;
  }
  return url.toString();
}

function installationEvent(fixture, installationId, sequence, eventType = fixture.event_type) {
  return {
    ...fixture,
    event_id: `${fixture.event_id}-${installationId}-${sequence}-${randomUUID()}`,
    installation_id: installationId,
    session_id: `${fixture.session_id}-${installationId}`,
    sequence,
    event_type: eventType,
    // Live sessions must use current time so the relay session TTL does not expire the fixture.
    occurred_at: new Date().toISOString(),
  };
}

async function authenticateCollector(wsUrl, installationId, token, WebSocketConstructor) {
  const client = await openJsonSocket(relayWsEndpoint(wsUrl, "collector"), WebSocketConstructor);
  try {
    client.send({
      type: "hello",
      schema_version: 1,
      role: "collector",
      client_id: "real-lan-integration-collector",
      installation_id: installationId,
      token,
    });
    const hello = await client.waitFor(
      (message) => message.type === "error" || (message.type === "hello_ack" && message.installation_id === installationId),
      "authenticated collector hello_ack",
    );
    assert.equal(hello.accepted, true);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function authenticateAndroid(
  wsUrl,
  installationId,
  token,
  lastSequence,
  WebSocketConstructor,
) {
  const client = await openJsonSocket(relayWsEndpoint(wsUrl, "android"), WebSocketConstructor);
  try {
    client.send({
      type: "hello",
      schema_version: 1,
      role: "phone",
      client_id: "real-lan-integration-android",
      installation_id: installationId,
      last_sequence: lastSequence,
      token,
    });
    const hello = await client.waitFor(
      (message) => message.type === "error" || (message.type === "hello_ack" && message.installation_id === installationId),
      "Android hello_ack",
    );
    assert.equal(hello.accepted, true);
    client.send({
      type: "subscribe",
      schema_version: 1,
      installation_id: installationId,
      token,
      last_sequence: lastSequence,
    });
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function assertWebSocketRejects(url, messages, WebSocketConstructor, label) {
  const client = await openJsonSocket(url, WebSocketConstructor);
  try {
    for (const message of messages) client.send(message);
    const rejection = await client
      .waitFor(
        (message) =>
          message.type === "error" ||
          (message.type === "hello_ack" && message.accepted === false),
        `${label} rejection`,
      )
      .catch(() => undefined);
    assert.ok(
      rejection || client.closed,
      `${label} must reject the token with an error or close the WebSocket`,
    );
    if (rejection) {
      assert.ok(
        rejection.type === "error" || rejection.accepted === false,
        `${label} must not acknowledge an unauthorized client`,
      );
    }
  } finally {
    await client.close();
  }
}

test("real-LAN event fixture is synthetic and contains explicit redaction probes", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8"));
  assert.equal(fixture.type, "event");
  assert.equal(fixture.schema_version, 1);
  assert.equal(fixture.sequence, 1);
  assert.equal(fixture.event_type, "tool_started");
  for (const marker of PRIVATE_MARKERS) {
    assert.ok(JSON.stringify(fixture).includes(marker), `fixture marker missing: ${marker}`);
  }
  assert.equal(
    JSON.stringify(fixture).includes("not-a-real-secret"),
    false,
    "fixture must not imply that its credentials are real",
  );
});

test(
  "approved real-LAN pairing, role tokens, event snapshots, redaction, and resume",
  { timeout: TEST_TIMEOUT_MS * 20, skip: LIVE_TEST_CONFIGURED ? false : "Set RELAY_BASE_URL and RELAY_BOOTSTRAP_SECRET to run against a relay" },
  async (t) => {
    const WebSocketConstructor = await loadWebSocketConstructor();
    if (!WebSocketConstructor) {
      assert.notEqual(process.env.RELAY_REQUIRE_LIVE, "1", "required live contract needs a WebSocket implementation");
      t.skip("Node WebSocket is unavailable; install relay dependencies for the ws fallback");
      return;
    }

    const relayHttpUrl = LIVE_BASE_URL;
    const installationId = `real-lan-test-${randomUUID()}`;
    const pairingRequest = {
      installation_id: installationId,
      relay_url: relayHttpUrl,
    };

    const wrongBootstrap = await requestJson(`${relayHttpUrl}/v1/pairing`, {
      method: "POST",
      headers: {
        authorization: "Bearer deliberately-wrong-bootstrap-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify(pairingRequest),
    });
    assertUnauthorized(wrongBootstrap.response, "wrong bootstrap bearer");

    const created = await requestJson(`${relayHttpUrl}/v1/pairing`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${BOOTSTRAP_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(pairingRequest),
    });
    assert.equal(created.response.status, 201, created.raw);
    assert.ok(created.body && typeof created.body === "object", "pairing response must be JSON");

    const pairing = created.body;
    for (const field of [
      "pairing_id",
      "code",
      "expires_at",
      "qr_payload",
      "collector_token",
      "installation_id",
      "ws_url",
    ]) {
      assert.ok(pairing[field], `pairing response is missing ${field}`);
    }
    assert.equal(pairing.installation_id, installationId);
    assert.notEqual(pairing.collector_token, BOOTSTRAP_SECRET);
    assert.notEqual(pairing.collector_token, pairing.code);

    const qrPayload =
      typeof pairing.qr_payload === "string" ? JSON.parse(pairing.qr_payload) : pairing.qr_payload;
    assert.equal(qrPayload.version, 1);
    assert.equal(qrPayload.relay_http_url.replace(/\/+$/, ""), relayHttpUrl);
    assert.equal(qrPayload.pairing_id, pairing.pairing_id);
    assert.equal(qrPayload.pairing_code, pairing.code);
    assert.equal(qrPayload.installation_id, installationId);
    assert.equal(typeof qrPayload.relay_ws_url, "string");
    assert.equal(new URL(qrPayload.relay_ws_url).searchParams.has("token"), false);

    const wrongCode = await requestJson(
      `${relayHttpUrl}/v1/pairing/${encodeURIComponent(pairing.pairing_id)}/claim`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "wrong-one-time-code", device_name: "wrong-device" }),
      },
    );
    assertClaimRejected(wrongCode.response, "wrong pairing code");

    const claimed = await requestJson(
      `${relayHttpUrl}/v1/pairing/${encodeURIComponent(pairing.pairing_id)}/claim`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: pairing.code, device_name: "real-lan-test-phone" }),
      },
    );
    assert.ok(
      claimed.response.status === 200 || claimed.response.status === 201,
      `claim must succeed with 200/201, received ${claimed.response.status}: ${claimed.raw}`,
    );
    assert.ok(claimed.body && typeof claimed.body === "object", "claim response must be JSON");
    const claim = claimed.body;
    for (const field of ["installation_id", "android_token", "ws_url", "expires_at"]) {
      assert.ok(claim[field], `claim response is missing ${field}`);
    }
    assert.equal(claim.installation_id, installationId);
    assert.notEqual(claim.android_token, pairing.collector_token);
    assert.notEqual(claim.android_token, pairing.code);
    assert.equal(new URL(claim.ws_url).searchParams.has("token"), false);

    const reused = await requestJson(
      `${relayHttpUrl}/v1/pairing/${encodeURIComponent(pairing.pairing_id)}/claim`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: pairing.code, device_name: "second-phone" }),
      },
    );
    assertClaimRejected(reused.response, "reused one-time pairing code");

    const wsUrl = claim.ws_url || pairing.ws_url;
    const handshakeFailureStarted = Date.now();
    await assert.rejects(authenticateAndroid(wsUrl, installationId, pairing.collector_token, 0, WebSocketConstructor));
    await assert.rejects(authenticateCollector(wsUrl, installationId, claim.android_token, WebSocketConstructor));
    assert.ok(Date.now() - handshakeFailureStarted < TEST_TIMEOUT_MS * 2 + 2500, "failed authentication helpers must close within deadline");
    let collector;
    let android;
    let resumedAndroid;
    try {
      collector = await authenticateCollector(
        wsUrl,
        installationId,
        pairing.collector_token,
        WebSocketConstructor,
      );
      android = await authenticateAndroid(
        wsUrl,
        installationId,
        claim.android_token,
        0,
        WebSocketConstructor,
      );

      const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8"));
      const firstEvent = installationEvent(fixture, installationId, 1);
      collector.send(firstEvent);
      const firstAck = await collector.waitFor(
        (message) => message.type === "event_ack" && message.event_id === firstEvent.event_id,
        "collector event_ack",
      );
      assert.equal(firstAck.accepted, true);
      const firstSnapshot = await android.waitFor(
        (message) => message.type === "snapshot" && message.installation_id === installationId && message.last_sequence === 1,
        "Android snapshot after collector event",
      );
      assert.equal(firstSnapshot.computer_state, "online");
      assert.equal(firstSnapshot.claude_state, "working");

      const androidWire = JSON.stringify(android.receivedFrames);
      for (const marker of PRIVATE_MARKERS) {
        assert.equal(
          androidWire.includes(marker),
          false,
          `private event data crossed the Android boundary: ${marker}`,
        );
      }

      await android.close();
      const closedWaitStarted = Date.now();
      await assert.rejects(android.waitFor(() => false), /already closed/);
      assert.ok(Date.now() - closedWaitStarted < 500, "closed socket wait must fail immediately");
      const secondEvent = installationEvent(fixture, installationId, 2, "task_finished");
      collector.send(secondEvent);
      const secondAck = await collector.waitFor(
        (message) => message.type === "event_ack" && message.event_id === secondEvent.event_id,
        "second collector event_ack",
      );
      assert.equal(secondAck.accepted, true);

      resumedAndroid = await authenticateAndroid(
        wsUrl,
        installationId,
        claim.android_token,
        1,
        WebSocketConstructor,
      );
      resumedAndroid.send({
        type: "resume",
        schema_version: 1,
        installation_id: installationId,
        last_sequence: 1,
      });
      const replayedEvent = await resumedAndroid.waitFor(
        (message) => message.type === "event" && message.event_id === secondEvent.event_id && message.sequence === 2,
        "replayed second event after resume",
      );
      assert.equal(replayedEvent.event_type, "task_finished");
      const resumedSnapshot = await resumedAndroid.waitFor(
        (message) => message.type === "snapshot" && message.installation_id === installationId && message.last_sequence >= 2,
        "Android snapshot after reconnect/resume",
      );
      assert.equal(resumedSnapshot.last_sequence, 2);
      assert.equal(resumedSnapshot.claude_state, "idle");
      for (const frame of [...android.receivedFrames, ...resumedAndroid.receivedFrames]) {
        for (const marker of PRIVATE_MARKERS) assert.equal(frame.includes(marker), false, `private data in received frame: ${marker}`);
      }

      await assertWebSocketRejects(
        relayWsEndpoint(wsUrl, "collector"),
        [
          {
            type: "hello",
            schema_version: 1,
            role: "collector",
            client_id: "real-lan-wrong-collector-token",
            installation_id: installationId,
            token: claim.android_token,
          },
        ],
        WebSocketConstructor,
        "collector with Android token",
      );
      await assertWebSocketRejects(
        relayWsEndpoint(wsUrl, "android"),
        [
          {
            type: "hello",
            schema_version: 1,
            role: "phone",
            client_id: "real-lan-wrong-android-token",
            installation_id: installationId,
            last_sequence: 2,
            token: pairing.collector_token,
          },
          {
            type: "subscribe",
            schema_version: 1,
            installation_id: installationId,
            token: pairing.collector_token,
            last_sequence: 2,
          },
        ],
        WebSocketConstructor,
        "Android with collector token",
      );
    } finally {
      await resumedAndroid?.close();
      await android?.close();
      await collector?.close();
    }
  },
);
