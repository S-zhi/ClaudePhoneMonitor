import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { sendUnixSocketPayload, UnixSocketIngestor } from "../src/socket.ts";

test("Unix socket ingestor accepts one local NDJSON message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collector-socket-"));
  const socketPath = join(directory, "collector.sock");
  try {
    let received: unknown;
    let resolveReceived: (() => void) | undefined;
    const receivedPromise = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });
    const server = new UnixSocketIngestor({
      socketPath,
      onMessage: (message) => {
        received = message;
        resolveReceived?.();
      },
    });
    await server.start();
    await sendUnixSocketPayload(socketPath, { event_type: "waiting", session_id: "s1" });
    await Promise.race([
      receivedPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("receive_timeout")), 500)),
    ]);
    assert.deepEqual(received, { event_type: "waiting", session_id: "s1" });
    await server.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
