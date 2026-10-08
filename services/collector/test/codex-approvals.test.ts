import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { createCollectorRuntime } from "../src/cli.ts";
import { nativeApprovalRequestId, patchNativeApprovalSlots } from "../src/codex-approvals.ts";
import { codexIdentityHash, codexSessionId, codexTaskId } from "../src/codex-normalizer.ts";
import { CodexSessionWatcher } from "../src/codex-watcher.ts";
import { createRelayServer } from "../../relay/src/server.ts";
import { InMemoryRelayRepository } from "../../relay/src/repository.ts";
import { JsonLogger } from "../../relay/src/logger.ts";

const THREAD = "01a1162d-f310-73c1-82fa-ca8a35f11209";
const TURN = "04a1162d-f310-43c1-82fa-ca8a35f11209";
const PRIVATE = "PRIVATE_COMMAND /Users/private/project token=PRIVATE_FIXTURE_ONLY";

async function until(condition: () => unknown): Promise<void> {
  const deadline = Date.now() + 7_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("codex_fixture_condition_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function writeFrame(socket: Socket, message: unknown): void {
  const data = Buffer.from(JSON.stringify(message));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(data.length);
  // Exercise a partial length header as well as a frame larger than a TCP chunk.
  socket.write(prefix.subarray(0, 2));
  socket.write(Buffer.concat([prefix.subarray(2), data]));
}

async function fixture() {
  const directory = await mkdtemp("/tmp/cni-");
  const ipcDir = join(directory, "ipc");
  const sessionsRoot = join(directory, "sessions");
  await mkdir(ipcDir, { mode: 0o700 });
  await mkdir(sessionsRoot);
  const row = (type: string, payload: unknown) => JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
  await writeFile(join(sessionsRoot, "rollout-active.jsonl"), `${row("session_meta", { id: THREAD })}\n${row("event_msg", { type: "task_started", turn_id: TURN })}\n`);
  await writeFile(join(directory, "session_index.jsonl"), `${JSON.stringify({ id: THREAD, thread_name: "Codex approval fixture" })}\n`);
  const clients = new Map<Socket, string>();
  const nativeMethods: string[] = [];
  const followingChanges: boolean[] = [];
  let owner = "fixture-desktop-owner";
  let revision = 0;
  let requests: unknown[] = [];
  let paused = false;
  let version = 11;
  const broadcast = (change: unknown) => {
    for (const [socket, client] of clients) writeFrame(socket, { type: "broadcast", method: "thread-stream-state-changed", version,
      sourceClientId: owner, targetClientIds: [client], params: { conversationId: THREAD, hostId: "local", change } });
  };
  const snapshot = (advanceRevision = true) => {
    if (!paused) broadcast({ type: "snapshot", revision: advanceRevision ? ++revision : revision,
      conversationState: { id: THREAD, requests, messages: [{ content: PRIVATE.repeat(10_000) }], cwd: "/Users/private/project" } });
  };
  const ipc = createServer((socket) => {
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("error", () => undefined);
    socket.on("close", () => clients.delete(socket));
    socket.on("data", (bytes: Buffer) => {
      buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const size = buffer.readUInt32LE(0);
        const message = JSON.parse(buffer.subarray(4, 4 + size).toString());
        buffer = buffer.subarray(4 + size);
        nativeMethods.push(message.method ?? message.type);
        if (message.type === "request" && message.method === "initialize") {
          assert.equal(message.version, 0);
          assert.equal(message.sourceClientId, "initializing-client");
          assert.deepEqual(message.params, { clientType: "desktop" });
          const client = randomUUID();
          clients.set(socket, client);
          writeFrame(socket, { type: "response", requestId: message.requestId, resultType: "success", result: { clientId: client } });
        } else if (message.type === "request" && message.method === "thread-owner-discovery") {
          assert.equal(message.version, 1);
          assert.deepEqual(message.params, { hostId: "local", conversationId: THREAD });
          writeFrame(socket, { type: "response", requestId: message.requestId, resultType: "success", handledByClientId: owner, result: { supportsUntrustedAppInput: true } });
        } else if (message.method === "thread-stream-following-changed") {
          followingChanges.push(message.params.following);
          assert.deepEqual(message.targetClientIds, [owner]);
          if (message.params.following) snapshot(false);
        } else if (message.type === "client-discovery-response") {
          assert.deepEqual(message.response, { canHandle: false });
        }
      }
    });
  });
  const socketPath = join(ipcDir, "ipc.sock");
  await new Promise<void>((resolve) => ipc.listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
  const repository = new InMemoryRelayRepository();
  const logs: string[] = [];
  const server = createRelayServer({ config: { authMode: "paired", heartbeatIntervalMs: 60_000, bookkeepingIntervalMs: 60_000 },
    relayOptions: { repository, autoStart: false }, logger: new JsonLogger({ sink: (line) => logs.push(line) }) });
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const address = server.app.server.address();
  assert.ok(address && typeof address === "object");
  const origin = `ws://127.0.0.1:${address.port}`;
  const installationId = "codex-native-fixture";
  const pairing = server.relay.createPairing({ installation_id: installationId, public_url: `http://127.0.0.1:${address.port}` });
  const claim = server.relay.claimPairingResult(pairing.pairing_id, pairing.code, "fixture phone");
  assert.ok(claim);
  const messages: Record<string, any>[] = [];
  const phone = new WebSocket(`${origin}/ws/android`);
  phone.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  await until(() => phone.readyState === WebSocket.OPEN);
  phone.send(JSON.stringify({ type: "hello", schema_version: 1, installation_id: installationId, token: claim.android_token }));
  await until(() => messages.some((message) => message.type === "hello_ack" && message.accepted));
  const runtime = await createCollectorRuntime({ dataDir: join(directory, "collector"), socketPath: join(directory, "collector.sock"),
    installationId, relayUrl: `${origin}/ws/collector`, relayToken: pairing.collector_token, watchCodex: true,
    sessionsRoot, codexMetadataRoot: directory, codexIpcSocket: socketPath, watchUsage: false, approvalBridge: false });
  await until(() => nativeMethods.includes("thread-stream-following-changed"));
  await until(() => runtime.relay?.approvalAvailable());
  return { directory, runtime, server, repository, messages, logs, phone, installationId, nativeMethods, followingChanges,
    snapshot: () => server.relay.snapshot(installationId),
    setRequests(value: unknown[]) { requests = value; snapshot(); },
    refresh: snapshot,
    gap() { paused = true; const baseRevision = revision + 10; revision += 11; broadcast({ type: "patches", baseRevision, revision, patches: [] }); return revision; },
    staleSnapshot() { broadcast({ type: "snapshot", revision: 1, conversationState: { id: THREAD, requests } }); },
    restore() { paused = false; snapshot(false); return revision; },
    wrongVersion() { paused = true; version = 12; broadcast({ type: "patches", baseRevision: revision, revision: revision + 1, patches: [] }); version = 11; },
    continuousWrongVersion() { paused = false; version = 12; snapshot(); },
    disconnect() { paused = true; for (const socket of clients.keys()) socket.destroy(); },
    unrelated() { broadcast({ type: "patches", baseRevision: revision, revision: ++revision, patches: [{ op: "replace", path: ["messages"], value: [{ content: PRIVATE }] }] }); },
    discoverClient() { for (const socket of clients.keys()) writeFrame(socket, { type: "client-discovery-request", requestId: randomUUID(), request: { method: "thread-owner-discovery" } }); },
    async close() {
      phone.close();
      await runtime.stop();
      for (const socket of clients.keys()) socket.destroy();
      await new Promise<void>((resolve) => ipc.close(() => resolve()));
      await until(() => phone.readyState === WebSocket.CLOSED);
      await server.app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function request(id: string | number = "call_code_mode_approval-7") {
  return { id, method: "item/commandExecution/requestApproval", params: { threadId: THREAD, turnId: TURN, itemId: "fixture-item", command: PRIVATE, cwd: "/Users/private/project", reason: PRIVATE } };
}

test("native IPC observer reaches paired Relay/phone without decisions, keeps identity through gaps and clears only a real request removal", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.snapshot().approvals, [], "empty authoritative desktop state is not inferred approval");
    f.discoverClient();
    await until(() => f.nativeMethods.includes("client-discovery-response"));
    f.setRequests([request()]);
    await until(() => f.snapshot().approvals?.[0]?.status === "pending");
    const first = f.snapshot().approvals![0]!;
    assert.match(first.request_id, /^[0-9a-f-]{14}5/);
    assert.equal(first.source, "codex");
    assert.equal(first.can_respond, false);
    assert.equal(first.session_id, codexSessionId(codexIdentityHash(THREAD)!));
    assert.equal(first.task_id, codexTaskId(codexIdentityHash(TURN)!));
    assert.equal(first.display_name, "Codex approval fixture");
    f.refresh(); f.unrelated();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(f.snapshot().approvals![0]!.sequence, first.sequence);
    const decisionId = randomUUID();
    f.phone.send(JSON.stringify({ type: "approval_decision", schema_version: 1, installation_id: f.installationId,
      request_id: first.request_id, decision_id: decisionId, decision: "allow" }));
    await until(() => f.messages.some((item) => item.type === "approval_decision_ack" && item.decision_id === decisionId));
    assert.equal(f.messages.find((item) => item.decision_id === decisionId)?.reason, "forbidden");
    const gapRevision = f.gap();
    await until(() => f.snapshot().approvals?.[0]?.status === "unknown");
    f.staleSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.snapshot().approvals![0]!.status, "unknown", "a stale snapshot cannot restore authority after a revision gap");
    assert.equal(f.restore(), gapRevision, "resync is the exact current revision, not an artificial increment");
    await until(() => f.snapshot().approvals?.[0]?.status === "pending");
    // Native repeated following returns the current full snapshot at the exact
    // gap revision; it does not invent another state change or increment it.
    assert.equal(f.snapshot().approvals![0]!.request_id, first.request_id);
    assert.equal(f.snapshot().approvals![0]!.sequence, first.sequence);
    assert.equal(f.snapshot().approvals![0]!.requested_at, first.requested_at);
    f.setRequests([]);
    await until(() => f.snapshot().approvals?.[0]?.status === "resolved");
    f.setRequests([request()]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(f.snapshot().approvals![0]!.status, "resolved", "terminal native IDs cannot be reused");
    const newTurn = { ...request(), params: { ...request().params, turnId: randomUUID() } };
    f.setRequests([newTurn]);
    await until(() => f.snapshot().approvals!.some((item) => item.status === "pending" && item.request_id !== first.request_id));
    const secondId = f.snapshot().approvals!.find((item) => item.status === "pending")!.request_id;
    f.setRequests([]);
    await until(() => f.snapshot().approvals?.find((item) => item.request_id === secondId)?.status === "resolved");
    f.setRequests([{ ...request(), params: { ...request().params, itemId: "new-item-same-turn" } }]);
    await until(() => f.snapshot().approvals!.some((item) => item.status === "pending" && item.request_id !== first.request_id && item.request_id !== secondId));
    assert.equal(f.nativeMethods.some((method) => /follower.*turn|response.*request|resume|start/.test(method)), false);
    const publicData = JSON.stringify([f.messages, f.logs, f.repository.listEventsAfter(f.installationId, 0)]);
    assert.equal(publicData.includes(PRIVATE), false);
    assert.equal(publicData.includes("call_code_mode_approval"), false);
    assert.equal(publicData.includes("/Users/private"), false);
    assert.equal(publicData.includes('"status":"approved"'), false);
  } finally { await f.close(); }
});

test("parallel event ACKs retain native finishing presence until the delayed terminal event is durably delivered", async () => {
  const f = await fixture();
  let release: (() => void) | undefined;
  try {
    f.setRequests([request("call_A"), request("call_B")]);
    await until(() => f.snapshot().approvals?.filter((item) => item.status === "pending").length === 2);
    const first = f.snapshot().approvals![0]!;
    const ingest = f.runtime.collector.ingestNormalized.bind(f.runtime.collector);
    let finishing = false;
    const delay = new Promise<void>((resolve) => { release = resolve; });
    f.runtime.collector.ingestNormalized = async (event) => {
      if (event.payload.request_id === first.request_id && event.payload.status === "resolved") {
        finishing = true;
        await delay;
      }
      return ingest(event);
    };
    f.setRequests([request("call_B")]);
    await until(() => finishing);
    const progress = await ingest({ event_type: "tool_finished", session_id: "parallel-progress-session", occurred_at: new Date().toISOString(), payload: { tool_name: "Bash" } });
    await f.runtime.relay!.flushPending();
    await until(() => f.repository.findEvent(progress.event_id));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.snapshot().approvals!.find((item) => item.request_id === first.request_id)!.status, "pending",
      "another real WebSocket ACK must not omit the completing native identity");
    release!();
    await until(() => f.snapshot().approvals?.find((item) => item.request_id === first.request_id)?.status === "resolved");
    assert.equal(f.snapshot().approvals!.find((item) => item.request_id !== first.request_id)!.status, "pending");
  } finally { release?.(); await f.close(); }
});

test("native approval IPC disconnect and unsupported stream versions become unknown instead of implying completion", async () => {
  const f = await fixture();
  try {
    f.setRequests([request(17)]);
    await until(() => f.snapshot().approvals?.[0]?.status === "pending");
    const first = f.snapshot().approvals![0]!;
    const id = first.request_id;
    f.wrongVersion();
    await until(() => f.snapshot().approvals?.[0]?.status === "unknown");
    f.restore();
    await until(() => f.snapshot().approvals?.[0]?.status === "pending");
    const discoveriesBeforeReconnect = f.nativeMethods.filter((method) => method === "thread-owner-discovery").length;
    const followsBeforeReconnect = f.followingChanges.filter(Boolean).length;
    f.disconnect();
    await until(() => f.snapshot().approvals?.[0]?.status === "unknown");
    assert.equal(f.snapshot().approvals![0]!.request_id, id);
    assert.equal(f.snapshot().approvals![0]!.can_respond, false);
    f.restore();
    await until(() => f.snapshot().approvals?.[0]?.status === "pending");
    assert.ok(f.nativeMethods.filter((method) => method === "thread-owner-discovery").length > discoveriesBeforeReconnect,
      "reconnect must repeat owner discovery over IPC");
    assert.ok(f.followingChanges.filter(Boolean).length > followsBeforeReconnect,
      "pending state returns only after a fresh authoritative snapshot is requested over IPC");
    assert.equal(f.snapshot().approvals![0]!.request_id, id);
    assert.equal(f.snapshot().approvals![0]!.sequence, first.sequence);
    assert.equal(f.snapshot().approvals![0]!.requested_at, first.requested_at,
      "rejoining a still-owned desktop stream at the same revision keeps the original display deadline");
  } finally { await f.close(); }
});

test("a desktop continuously answering with an unsupported large snapshot cannot cause a resubscription feedback loop", async () => {
  const f = await fixture();
  try {
    f.setRequests([request()]);
    await until(() => f.snapshot().approvals?.[0]?.status === "pending");
    const before = f.nativeMethods.filter((method) => method === "thread-stream-following-changed").length;
    f.continuousWrongVersion();
    await until(() => f.snapshot().approvals?.[0]?.status === "unknown");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const after = f.nativeMethods.filter((method) => method === "thread-stream-following-changed").length;
    assert.ok(after - before <= 1, "resync attempts are throttled even if every answer is another unsupported full state");
    assert.equal(f.snapshot().approvals![0]!.can_respond, false);
  } finally { await f.close(); }
});

test("native approval identity accepts bounded opaque strings, keeps JSON-RPC types distinct and rejects ambiguous patches", () => {
  assert.notEqual(nativeApprovalRequestId("owner", THREAD, TURN, "17"), nativeApprovalRequestId("owner", THREAD, TURN, 17));
  assert.equal(nativeApprovalRequestId("owner", THREAD, TURN, "call_7"), nativeApprovalRequestId("owner", THREAD, TURN, "call_7"));
  assert.notEqual(nativeApprovalRequestId("owner", THREAD, TURN, "call_7"), nativeApprovalRequestId("replacement-owner", THREAD, TURN, "call_7"));
  assert.notEqual(nativeApprovalRequestId("owner", THREAD, TURN, "call_7"), nativeApprovalRequestId("owner", THREAD, randomUUID(), "call_7"));
  assert.notEqual(nativeApprovalRequestId("owner", THREAD, TURN, "call_7", "item_a"), nativeApprovalRequestId("owner", THREAD, TURN, "call_7", "item_b"));
  const slots = [{ id: "call_7", method: "item/commandExecution/requestApproval", threadId: THREAD, turnId: TURN }];
  assert.deepEqual(patchNativeApprovalSlots(slots, [{ op: "remove", path: ["requests", 0] }], THREAD), []);
  assert.equal(patchNativeApprovalSlots(slots, [{ op: "remove", path: ["requests", 5] }], THREAD), undefined);
  assert.equal(patchNativeApprovalSlots(slots, [{ op: "replace", path: ["requests", 0, "params", "turnId"], value: randomUUID() }], THREAD), undefined);
  assert.deepEqual(patchNativeApprovalSlots(slots, [{ op: "replace", path: ["messages"], value: PRIVATE }], THREAD), slots);
});

test("Codex active native thread discovery revalidates bounded metadata after resuming a hashed checkpoint", async () => {
  const directory = await mkdtemp("/tmp/cnh-");
  const sessionsRoot = join(directory, "sessions");
  const checkpointFile = join(directory, "checkpoint.json");
  await mkdir(sessionsRoot);
  const now = Date.now();
  await writeFile(join(sessionsRoot, "rollout-active.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: THREAD } })}\n${JSON.stringify({ type: "event_msg", timestamp: new Date(now).toISOString(), payload: { type: "task_started", turn_id: TURN } })}\n`);
  const options = { sessionsRoot, checkpointFile, now: () => now, pollIntervalMs: 60_000, emit: async () => undefined };
  const first = new CodexSessionWatcher(options);
  const second = new CodexSessionWatcher(options);
  try {
    await first.start();
    assert.deepEqual(first.getApprovalThreadIds(), [THREAD]);
    await first.stop();
    assert.equal((await readFile(checkpointFile, "utf8")).includes(THREAD), false);
    await second.start();
    assert.deepEqual(second.getApprovalThreadIds(), [THREAD], "the saved offset at EOF must not hide the current native thread");
  } finally { await first.stop(); await second.stop(); await rm(directory, { recursive: true, force: true }); }
});
