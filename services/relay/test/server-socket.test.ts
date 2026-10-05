import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";

import { createRelayServer } from "../src/server.js";

test("an aborted invalid WebSocket upgrade leaves the relay healthy", async () => {
  const { app } = createRelayServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      bookkeepingIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    },
    relayOptions: { autoStart: false },
  });

  let markInvalidRequestStarted!: () => void;
  const invalidRequestStarted = new Promise<void>((resolve) => {
    markInvalidRequestStarted = resolve;
  });
  let releaseInvalidRequest!: () => void;
  const invalidRequestGate = new Promise<void>((resolve) => {
    releaseInvalidRequest = resolve;
  });
  app.addHook("onRequest", async (request) => {
    if (request.raw.url !== "/" || request.headers.upgrade !== "websocket") return;
    markInvalidRequestStarted();
    await invalidRequestGate;
  });

  let client: net.Socket | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === "object");

    const serverSocketClosed = new Promise<boolean>((resolve) => {
      app.server.once("connection", (socket) => {
        socket.once("close", resolve);
      });
    });
    client = net.createConnection({ host: "127.0.0.1", port: address.port });
    client.on("error", () => undefined);
    client.once("connect", () => {
      client?.write(
        [
          "GET / HTTP/1.1",
          `Host: 127.0.0.1:${address.port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "",
          "",
        ].join("\r\n"),
      );
    });

    await invalidRequestStarted;
    client.resetAndDestroy();
    releaseInvalidRequest();

    assert.equal(await serverSocketClosed, true, "the server observed the peer reset");
    const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");
  } finally {
    releaseInvalidRequest();
    client?.destroy();
    await app.close();
  }
});
