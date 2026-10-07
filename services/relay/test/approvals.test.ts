import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Relay } from "../src/relay.js";
import { InMemoryRelayRepository, SqliteRelayRepository, type RelayRepository } from "../src/repository.js";
import { JsonLogger } from "../src/logger.js";
import type { ApprovalDecisionAckMessage, EventEnvelope, ServerMessage, SnapshotMessage } from "../src/types.js";

function setup(repository: RelayRepository = new InMemoryRelayRepository()) {
  let now = new Date("2026-10-07T12:00:00.000Z");
  let sequence = 0;
  const installationId = "installation-a";
  const collectorToken = "collector-token-for-fixture-only";
  const phoneToken = "phone-token-for-fixture-only";
  repository.createDeviceToken({ token: collectorToken, role: "collector", installation_id: installationId, issued_at: now.toISOString() });
  const phoneTokenRecord = repository.createDeviceToken({ token: phoneToken, role: "android", installation_id: installationId, issued_at: now.toISOString() });
  const relay = new Relay({ repository, config: { authMode: "development", staleAfterMs: 10_000, offlineAfterMs: 30_000 },
    autoStart: false, now: () => now, logger: new JsonLogger({ sink: () => undefined }) });
  const connect = (gateway: "collector" | "android", token?: string, installation_id = installationId) => {
    const messages: ServerMessage[] = [];
    const { connection_id: id } = relay.connect({ gateway, token, installation_id, transport: { send: (message) => messages.push(message) } });
    return { id, messages };
  };
  const collector = connect("collector", collectorToken);
  const phone = connect("android", phoneToken);
  const event = (requestId: string, eventType: "approval_requested" | "approval_resolved" = "approval_requested",
    status: "pending" | "approved" | "denied" | "unknown" = "pending", sessionId = "session-a", taskId?: string): EventEnvelope => {
    sequence += 1;
    return { type: "event", schema_version: 1, event_id: `${installationId}:${sequence}`, installation_id: installationId,
      session_id: sessionId, ...(taskId ? { task_id: taskId } : {}), sequence, occurred_at: now.toISOString(), event_type: eventType,
      payload: { request_id: requestId, source: "claude_code", status, can_respond: eventType === "approval_requested",
        expires_at: new Date(now.getTime() + 60_000).toISOString(), tool_name: "Bash" } };
  };
  const requested = (id = randomUUID(), activate = true, sessionId?: string) => {
    relay.receiveMessage(collector.id, event(id, "approval_requested", "pending", sessionId));
    if (activate) relay.receiveMessage(collector.id, { type: "approval_presence", schema_version: 1, installation_id: installationId,
      request_ids: repository.listApprovals(installationId).filter((item) => item.status === "pending").map((item) => item.request_id) });
    return id;
  };
  const decision = (requestId: string, value: "allow" | "deny" | "computer" = "allow", id = randomUUID(), target = phone,
    installation = installationId) => {
    relay.receiveMessage(target.id, { type: "approval_decision", schema_version: 1, installation_id: installation,
      request_id: requestId, decision_id: id, decision: value });
    return target.messages.filter((message) => message.type === "approval_decision_ack").at(-1) as ApprovalDecisionAckMessage;
  };
  return { relay, repository, collector, phone, connect, event, requested, decision, installationId, phoneTokenRecord,
    advance(ms: number) { now = new Date(now.getTime() + ms); }, now: () => now };
}

test("approval authority requires paired tokens even when telemetry development authentication is disabled", () => {
  const f = setup();
  try {
    const devCollector = f.connect("collector");
    const devPhone = f.connect("android");
    const requestId = randomUUID();
    f.relay.receiveMessage(devCollector.id, f.event(requestId));
    assert.equal(f.relay.snapshot(f.installationId).approvals!.length, 0);
    assert.equal(devCollector.messages.filter((message) => message.type === "event_ack").at(-1)?.status, "rejected");
    const validId = f.requested();
    assert.equal(f.decision(validId, "allow", randomUUID(), devPhone).reason, "forbidden");
    const otherToken = "other-installation-phone-token";
    f.repository.createDeviceToken({ token: otherToken, role: "android", installation_id: "installation-b", issued_at: f.now().toISOString() });
    const otherPhone = f.connect("android", otherToken, "installation-b");
    assert.equal(f.decision(validId, "allow", randomUUID(), otherPhone).reason, "forbidden");
    f.repository.revokeToken(f.phoneTokenRecord.token_id, f.now().toISOString());
    assert.equal(f.decision(validId).reason, "forbidden", "already-connected revoked tokens cannot decide");
    assert.equal(f.relay.snapshot(f.installationId).approvals![0]!.status, "pending");
  } finally { f.relay.stop(); }
});

test("presence race does not kill a request; duplicate and opposite decisions only forward once", () => {
  const f = setup();
  try {
    const requestId = f.requested(undefined, false);
    assert.equal(f.decision(requestId).reason, "unavailable");
    f.relay.receiveMessage(f.collector.id, { type: "approval_presence", schema_version: 1,
      installation_id: f.installationId, request_ids: [] });
    assert.equal(f.relay.snapshot(f.installationId).approvals![0]!.status, "pending");
    f.relay.receiveMessage(f.collector.id, { type: "approval_presence", schema_version: 1,
      installation_id: f.installationId, request_ids: [requestId] });
    const decisionId = randomUUID();
    assert.equal(f.decision(requestId, "deny", decisionId).accepted, true);
    assert.equal(f.decision(requestId, "deny", decisionId).accepted, true);
    assert.equal(f.decision(requestId, "allow", decisionId).reason, "already_decided");
    assert.equal(f.decision(requestId, "allow").reason, "already_decided");
    assert.equal(f.collector.messages.filter((message) => message.type === "approval_decision").length, 1);
    assert.equal(f.relay.snapshot(f.installationId).approvals![0]!.status, "pending");
    assert.equal(f.relay.snapshot(f.installationId).approvals![0]!.can_respond, false);
    f.relay.receiveMessage(f.collector.id, f.event(requestId, "approval_resolved", "approved"));
    assert.equal(f.relay.snapshot(f.installationId).approvals![0]!.status, "unknown", "a deny cannot produce an approved result");
  } finally { f.relay.stop(); }
});

test("only the exact owning collector and task can resolve a claimed request", () => {
  const f = setup();
  try {
    const requestId = randomUUID();
    f.relay.receiveMessage(f.collector.id, f.event(requestId, "approval_requested", "pending", "session-a", "task-a"));
    f.relay.receiveMessage(f.collector.id, { type: "approval_presence", schema_version: 1, installation_id: f.installationId, request_ids: [requestId] });
    f.decision(requestId);
    const secondCollector = f.connect("collector", "collector-token-for-fixture-only");
    f.relay.receiveMessage(secondCollector.id, f.event(requestId, "approval_resolved", "approved", "session-a", "task-a"));
    f.relay.receiveMessage(f.collector.id, f.event(requestId, "approval_resolved", "approved", "session-a", "task-b"));
    assert.equal(f.relay.snapshot(f.installationId).approvals![0]!.status, "pending");
    assert.equal(f.phone.messages.filter((message) => message.type === "event" && message.event_type === "approval_resolved").length, 0);
    f.relay.receiveMessage(f.collector.id, f.event(requestId, "approval_resolved", "approved", "session-a", "task-a"));
    assert.equal(f.relay.snapshot(f.installationId).approvals![0]!.status, "approved");
  } finally { f.relay.stop(); }
});

test("expiry, stale connections and reconnect never revive old authority; resume uses snapshots", () => {
  const f = setup();
  try {
    const expiredId = f.requested();
    f.advance(60_001);
    assert.equal(f.decision(expiredId).accepted, false);
    assert.equal(f.relay.snapshot(f.installationId).approvals![0]!.status, "unknown");
    const disconnectedId = f.requested();
    f.relay.disconnect(f.collector.id);
    const replacement = f.connect("collector", "collector-token-for-fixture-only");
    f.relay.receiveMessage(replacement.id, { type: "approval_presence", schema_version: 1, installation_id: f.installationId, request_ids: [disconnectedId] });
    f.phone.messages.length = 0;
    f.relay.receiveMessage(replacement.id, f.event(disconnectedId));
    assert.equal(f.phone.messages.filter((message) => message.type === "event" && message.event_type === "approval_requested").length, 0);
    assert.equal(f.decision(disconnectedId).accepted, false);
    f.relay.receiveMessage(f.phone.id, { type: "resume", schema_version: 1, installation_id: f.installationId, last_sequence: 0 });
    assert.equal(f.phone.messages.filter((message) => message.type === "event" && message.event_type.startsWith("approval_")).length, 0);
    assert.equal((f.phone.messages.filter((message) => message.type === "snapshot").at(-1) as SnapshotMessage).approvals!.find((item) => item.request_id === disconnectedId)!.status, "unknown");
    const staleId = randomUUID();
    f.relay.receiveMessage(replacement.id, f.event(staleId));
    f.relay.receiveMessage(replacement.id, { type: "approval_presence", schema_version: 1, installation_id: f.installationId, request_ids: [staleId] });
    f.advance(10_001);
    f.relay.tick();
    assert.equal(f.relay.snapshot(f.installationId).approvals!.find((item) => item.request_id === staleId)!.status, "unknown");
  } finally { f.relay.stop(); }
});

test("pending approval snapshots are independent of the top five activity sessions and preserve safe fallback names", () => {
  const f = setup();
  try {
    const requests = Array.from({ length: 8 }, (_, i) => f.requested(undefined, true, `session-${i}`));
    const approvals = f.relay.snapshot(f.installationId).approvals!;
    assert.equal(approvals.length, 8);
    assert.equal(new Set(approvals.map((item) => item.request_id)).size, 8);
    assert.ok(approvals.every((item) => item.can_respond && /^会话 [0-9a-f]{6}$/.test(item.display_name)));
    assert.ok(requests.every((id) => approvals.some((item) => item.request_id === id)));
  } finally { f.relay.stop(); }
});

test("SQLite restart marks pending unknown; terminal visibility expires on tick but UUID tombstones remain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-approvals-"));
  const dbPath = join(directory, "relay.sqlite");
  let relay: Relay | undefined;
  try {
    const f = setup(new SqliteRelayRepository(dbPath));
    const requestId = f.requested();
    f.relay.stop();
    let now = f.now();
    const repository = new SqliteRelayRepository(dbPath);
    relay = new Relay({ repository, now: () => now, autoStart: false,
      config: { authMode: "development" }, logger: new JsonLogger({ sink: () => undefined }) });
    const messages: ServerMessage[] = [];
    const phone = relay.connect({ gateway: "android", token: "phone-token-for-fixture-only", installation_id: f.installationId,
      transport: { send: (message) => messages.push(message) } });
    assert.equal(relay.snapshot(f.installationId).approvals![0]!.status, "unknown");
    now = new Date(now.getTime() + 15 * 60_000 + 1);
    messages.length = 0;
    relay.tick();
    assert.deepEqual((messages.filter((message) => message.type === "snapshot").at(-1) as SnapshotMessage).approvals, []);
    assert.equal(repository.listApprovals(f.installationId)[0]!.request_id, requestId);
    const collector = relay.connect({ gateway: "collector", token: "collector-token-for-fixture-only",
      installation_id: f.installationId, transport: { send: () => undefined } });
    messages.length = 0;
    relay.receiveMessage(collector.connection_id, { ...f.event(requestId), occurred_at: now.toISOString(),
      payload: { request_id: requestId, source: "claude_code", status: "pending", can_respond: true, expires_at: new Date(now.getTime() + 60_000).toISOString() } });
    relay.receiveMessage(collector.connection_id, { type: "approval_presence", schema_version: 1, installation_id: f.installationId, request_ids: [requestId] });
    relay.receiveMessage(phone.connection_id, { type: "resume", schema_version: 1, installation_id: f.installationId, last_sequence: 0 });
    assert.equal(messages.filter((message) => message.type === "event" && message.event_type.startsWith("approval_")).length, 0);
    assert.deepEqual(relay.snapshot(f.installationId).approvals, []);
    assert.equal(repository.listApprovals(f.installationId)[0]!.status, "unknown");
  } finally { relay?.stop(); await rm(directory, { recursive: true, force: true }); }
});
