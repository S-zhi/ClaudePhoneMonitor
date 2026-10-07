import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Relay } from "../src/relay.js";
import { InMemoryRelayRepository } from "../src/repository.js";
import { JsonLogger } from "../src/logger.js";
import type { ApprovalDecisionAckMessage, EventEnvelope, ServerMessage } from "../src/types.js";

function fixture() {
  const repository = new InMemoryRelayRepository();
  const installationId = "codex-observer-fixture";
  const collectorToken = "collector-fixture-token";
  const androidToken = "android-fixture-token";
  let now = new Date("2026-10-08T00:00:00.000Z");
  for (const [role, token] of [["collector", collectorToken], ["android", androidToken]] as const) {
    repository.createDeviceToken({ role, token, installation_id: installationId, issued_at: now.toISOString() });
  }
  const relay = new Relay({ repository, autoStart: false, now: () => now, config: { authMode: "paired" }, logger: new JsonLogger({ sink: () => undefined }) });
  const connect = (gateway: "collector" | "android", token?: string) => {
    const messages: ServerMessage[] = [];
    const { connection_id: id } = relay.connect({ gateway, token, installation_id: installationId, transport: { send: (value) => messages.push(value) } });
    return { id, messages };
  };
  const collector = connect("collector", collectorToken);
  const phone = connect("android", androidToken);
  const requestId = "3fb68435-06fa-5c5e-8b01-aa17da927634";
  let sequence = 0;
  const event = (status: "pending" | "resolved" | "unknown", source = "codex", canRespond = false): EventEnvelope => ({
    type: "event", schema_version: 1, event_id: `codex-fixture:${++sequence}`, installation_id: installationId,
    session_id: `codex:sess:${"a".repeat(64)}`, task_id: `codex:turn:${"b".repeat(64)}`, sequence,
    occurred_at: now.toISOString(), event_type: status === "pending" ? "approval_requested" : "approval_resolved",
    payload: { request_id: requestId, source, status, can_respond: canRespond, tool_name: "Bash" },
  });
  const presence = (ids: string[], source?: string, target = collector) => relay.receiveMessage(target.id, {
    type: "approval_presence", schema_version: 1, installation_id: installationId, request_ids: ids, ...(source ? { source } : {}),
  });
  return { relay, repository, installationId, collector, phone, event, presence, requestId, connect,
    advance(ms: number) { now = new Date(now.getTime() + ms); } };
}

test("Codex pending needs paired source-scoped liveness, survives observation restoration without renewing identity, and never accepts decisions", () => {
  const f = fixture();
  try {
    f.relay.receiveMessage(f.collector.id, f.event("pending"));
    assert.deepEqual(f.relay.snapshot(f.installationId).approvals, [], "durable requested replay has no current native proof");
    f.presence([f.requestId]);
    assert.deepEqual(f.relay.snapshot(f.installationId).approvals, [], "Claude presence cannot claim a native observation");
    f.presence([f.requestId], "codex");
    const first = f.relay.snapshot(f.installationId).approvals![0]!;
    assert.equal(first.status, "pending");
    assert.equal(first.can_respond, false);
    f.presence([]);
    assert.equal(f.relay.snapshot(f.installationId).approvals![0]!.status, "pending", "Claude empty presence cannot clear Codex");
    f.relay.receiveMessage(f.phone.id, { type: "approval_decision", schema_version: 1, installation_id: f.installationId,
      request_id: f.requestId, decision_id: randomUUID(), decision: "allow" });
    assert.equal((f.phone.messages.filter((item) => item.type === "approval_decision_ack").at(-1) as ApprovalDecisionAckMessage).reason, "forbidden");
    assert.equal(f.collector.messages.some((item) => item.type === "approval_decision"), false);
    f.presence([], "codex");
    assert.equal(f.relay.snapshot(f.installationId).approvals![0]!.status, "unknown");
    f.advance(11 * 60_000);
    f.relay.receiveMessage(f.collector.id, f.event("pending"));
    f.presence([f.requestId], "codex");
    const restored = f.relay.snapshot(f.installationId).approvals![0]!;
    assert.equal(restored.status, "pending", "native observation has no invented ten-minute hook deadline");
    assert.equal(restored.sequence, first.sequence);
    assert.equal(restored.requested_at, first.requested_at);
    f.relay.receiveMessage(f.collector.id, f.event("resolved"));
    assert.equal(f.relay.snapshot(f.installationId).approvals![0]!.status, "resolved");
    f.relay.receiveMessage(f.collector.id, f.event("pending"));
    f.presence([f.requestId], "codex");
    assert.equal(f.relay.snapshot(f.installationId).approvals![0]!.status, "resolved", "native terminal tombstones are final");
  } finally { f.relay.stop(); }
});

test("Codex source validation rejects actions, claimed outcomes, identity crossover and foreign collector liveness", () => {
  const f = fixture();
  try {
    f.relay.receiveMessage(f.collector.id, f.event("pending", "codex", true));
    f.relay.receiveMessage(f.collector.id, f.event("pending", "claude_code"));
    assert.deepEqual(f.repository.listApprovals(f.installationId), []);
    f.relay.receiveMessage(f.collector.id, f.event("pending"));
    const foreign = f.connect("collector", "collector-fixture-token");
    f.presence([f.requestId], "codex", foreign);
    assert.deepEqual(f.relay.snapshot(f.installationId).approvals, []);
    f.presence([f.requestId], "codex");
    const malicious = f.event("resolved");
    malicious.payload = { ...(malicious.payload as object), status: "approved" };
    f.relay.receiveMessage(f.collector.id, malicious);
    assert.equal(f.relay.snapshot(f.installationId).approvals![0]!.status, "pending");
    f.relay.disconnect(f.collector.id);
    assert.equal(f.relay.snapshot(f.installationId).approvals![0]!.status, "unknown");
  } finally { f.relay.stop(); }
});
