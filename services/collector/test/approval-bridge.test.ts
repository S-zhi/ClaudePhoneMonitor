import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createCollectorRuntime } from "../src/cli.ts";
import { runHookAdapter } from "../src/hook-adapter.ts";
import { ApprovalBridge } from "../src/approval.ts";
import { UnixSocketIngestor } from "../src/socket.ts";
import { createRelayServer } from "../../relay/src/server.ts";
import { InMemoryRelayRepository } from "../../relay/src/repository.ts";
import { JsonLogger } from "../../relay/src/logger.ts";

async function until(condition: () => unknown, message = "condition_timeout"): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(holdMs?: number) {
  const directory = await mkdtemp("/tmp/cpa-");
  const installationId = "approval-test-install";
  const logs: string[] = [];
  const server = createRelayServer({
    config: { authMode: "paired", heartbeatIntervalMs: 60_000, bookkeepingIntervalMs: 60_000 },
    relayOptions: { repository: new InMemoryRelayRepository(), autoStart: false },
    logger: new JsonLogger({ sink: (line) => logs.push(line) }),
  });
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const address = server.app.server.address();
  assert.ok(address && typeof address === "object");
  const origin = `ws://127.0.0.1:${address.port}`;
  const pairing = server.relay.createPairing({ installation_id: installationId, public_url: `http://127.0.0.1:${address.port}` });
  const claimed = server.relay.claimPairingResult(pairing.pairing_id, pairing.code, "fixture phone");
  assert.ok(claimed);
  const messages: Record<string, any>[] = [];
  const phone = new WebSocket(`${origin}/ws/android`);
  phone.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  await until(() => phone.readyState === WebSocket.OPEN);
  phone.send(JSON.stringify({ type: "hello", schema_version: 1, installation_id: installationId, token: claimed.android_token }));
  await until(() => messages.some((message) => message.type === "hello_ack" && message.accepted));
  let runtime = await createCollectorRuntime({
    dataDir: directory, socketPath: join(directory, "c.sock"), installationId,
    relayUrl: `${origin}/ws/collector`, relayToken: pairing.collector_token,
    approvalBridge: true, approvalHoldMs: holdMs, watchCodex: false, watchUsage: false,
  });
  await until(() => runtime.relay?.approvalAvailable());
  const snapshot = () => server.relay.snapshot(installationId);
  const decide = (requestId: string, decision: "allow" | "deny" | "computer", decisionId = randomUUID()) => {
    phone.send(JSON.stringify({ type: "approval_decision", schema_version: 1, installation_id: installationId,
      request_id: requestId, decision_id: decisionId, decision }));
    return decisionId;
  };
  return {
    directory, installationId, server, logs, messages, phone, snapshot, decide,
    get runtime() { return runtime; },
    async restartCollector() {
      await runtime.stop();
      runtime = await createCollectorRuntime({ dataDir: directory, socketPath: join(directory, "c.sock"), installationId,
        relayUrl: `${origin}/ws/collector`, relayToken: pairing.collector_token, approvalBridge: true, watchCodex: false, watchUsage: false });
      await until(() => runtime.relay?.approvalAvailable());
    },
    async close() {
      phone.close();
      await runtime.stop();
      await until(() => phone.readyState === WebSocket.CLOSED);
      await server.app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function rawInput(command = "PRIVATE_COMMAND /Users/private/task secret-local-only") {
  return { hook_event_name: "PermissionRequest", session_id: "session-1", tool_name: "Bash", tool_input: { command } };
}

test("registration crossing a millisecond keeps the exact ten-minute deadline valid at the real Relay", async () => {
  const f = await fixture();
  const registeredTime = Date.now();
  let ticks = 0;
  const bridge = new ApprovalBridge({ enabled: true, installationId: f.installationId,
    now: () => new Date(registeredTime + ticks++),
    emit: (event) => f.runtime.collector.ingestNormalized(event),
    flush: async () => { await f.runtime.relay?.flushPending(); },
    isConnected: () => f.runtime.relay?.approvalAvailable() ?? false,
    publishPresence: (ids) => f.runtime.relay?.publishApprovalPresence(ids),
  });
  const socketPath = join(f.directory, "clock.sock");
  const socket = new UnixSocketIngestor({ socketPath,
    onMessage: async (message, peer) => { await bridge.handleLocalMessage(message, peer); } });
  await socket.start();
  const hook = runHookAdapter({ socketPath, approvalBridge: true, input: Readable.from([JSON.stringify(rawInput())]),
    writeLocalNotice: () => undefined, writeOutput: async () => { assert.fail("no remote decision was sent"); } });
  try {
    await until(() => f.snapshot().approvals?.length === 1);
    const approval = f.snapshot().approvals![0]!;
    assert.equal(approval.status, "pending", "Relay must accept the deadline even as the source clock advances during registration");
    assert.equal(Date.parse(approval.expires_at!) - Date.parse(approval.requested_at), 10 * 60_000);
  } finally {
    await bridge.stop();
    await socket.stop();
    await hook;
    await f.close();
  }
});

test("interactive questions and plan reviews bypass the permission bridge and preserve computer interaction", async () => {
  for (const [toolName, reason] of [["AskUserQuestion", "question"], ["ExitPlanMode", "approval"]] as const) {
    const f = await fixture();
    try {
      for (const hook_event_name of ["PreToolUse", "PermissionRequest"] as const) {
        await runHookAdapter({ socketPath: join(f.directory, "c.sock"), approvalBridge: true,
          input: Readable.from([JSON.stringify({ hook_event_name, session_id: "session-1", tool_name: toolName,
            ...(hook_event_name === "PreToolUse" ? { tool_use_id: "interactive-call-1" } : {}),
            tool_input: { questions: "private-question", answers: "private-answer", plan: "private-plan", planFilePath: "/Users/private/plan.md" } })]),
          writeLocalNotice: () => { assert.fail("native interaction must not create an approval bridge notice"); },
          writeOutput: async () => { assert.fail("no permission decision can answer a question or review a plan"); } });
      }
      await until(() => f.snapshot().sessions?.[0]?.waiting_reason === reason);
      assert.deepEqual(f.snapshot().approvals, []);
      const events = f.server.relay.repository.listEventsAfter(f.installationId, -1);
      assert.ok(events.every(({ event }) => event.event_type === "waiting"));
      assert.equal(JSON.stringify({ events, logs: f.logs, messages: f.messages }).includes("private"), false);
      const sequence = f.snapshot().sessions![0]!.last_activity_sequence;
      await runHookAdapter({ socketPath: join(f.directory, "c.sock"), approvalBridge: true,
        input: Readable.from([JSON.stringify({ hook_event_name: "PostToolUse", session_id: "session-1", tool_name: "Bash", tool_use_id: "parallel-bash" })]) });
      await until(() => f.server.relay.repository.listEventsAfter(f.installationId, -1).length === 3);
      assert.equal(f.snapshot().sessions![0]!.waiting_reason, reason);
      assert.equal(f.snapshot().sessions![0]!.last_activity_sequence, sequence);
      await runHookAdapter({ socketPath: join(f.directory, "c.sock"), approvalBridge: true,
        input: Readable.from([JSON.stringify({ hook_event_name: "PostToolUse", session_id: "session-1", tool_name: toolName, tool_use_id: "interactive-call-1" })]) });
      await until(() => f.snapshot().sessions?.[0]?.claude_state === "working");
      assert.equal(f.snapshot().sessions![0]!.waiting_reason, undefined);
    } finally { await f.close(); }
  }
});

test("actual hook CLI, Unix socket, paired Relay and phone return allow/deny/computer decisions", async () => {
  for (const decision of ["allow", "deny", "computer"] as const) {
    const f = await fixture();
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const collectorRoot = resolve(import.meta.dirname, "..");
      child = spawn(process.execPath, ["--import", join(collectorRoot, "node_modules/tsx/dist/loader.mjs"),
        join(collectorRoot, "src/cli.ts"), "--event", "--approval-bridge", "--socket", join(f.directory, "c.sock")],
      { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      const exited = new Promise<number | null>((resolve, reject) => {
        child!.once("exit", resolve);
        child!.once("error", reject);
      });
      child.stdin?.end(JSON.stringify(rawInput()));
      try {
        await until(() => f.snapshot().approvals?.some((item) => item.can_respond));
      } catch {
        throw new Error(`hook_not_live ${decision}: exit=${child.exitCode}; stdout=${stdout}; stderr=${stderr}; snapshot=${JSON.stringify(f.snapshot())}; relay=${JSON.stringify(f.runtime.relay?.state())}; events=${JSON.stringify(f.server.relay.repository.listEventsAfter(f.installationId, -1))}`);
      }
      const approval = f.snapshot().approvals![0]!;
      assert.match(approval.request_id, /^[0-9a-f-]{36}$/);
      assert.ok(stderr.includes(approval.request_id));
      assert.ok(!stderr.includes("PRIVATE_COMMAND") && !stderr.includes("secret-local-only"));
      const decisionId = f.decide(approval.request_id, decision);
      await until(() => f.messages.some((message) => message.type === "approval_decision_ack" && message.decision_id === decisionId));
      assert.equal(f.messages.find((message) => message.type === "approval_decision_ack" && message.decision_id === decisionId)?.accepted, true);
      assert.equal(await exited, 0);
      await until(() => f.snapshot().approvals?.[0]?.status !== "pending");
      assert.equal(f.snapshot().approvals![0]!.status, decision === "allow" ? "approved" : decision === "deny" ? "denied" : "unknown");
      assert.equal(f.snapshot().approvals![0]!.can_respond, false);
      if (decision === "computer") assert.equal(stdout, "");
      else assert.deepEqual(JSON.parse(stdout), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: decision } } });
      const transmitted = JSON.stringify({ messages: f.messages, logs: f.logs,
        events: f.server.relay.repository.listEventsAfter(f.installationId, -1) });
      assert.ok(!transmitted.includes("PRIVATE_COMMAND") && !transmitted.includes("secret-local-only") && !transmitted.includes("/Users/private"));
    } finally {
      child?.kill();
      await f.close();
    }
  }
});

test("forwarded acknowledgement remains pending until stdout is delivered, and duplicate decisions cannot change it", async () => {
  const f = await fixture();
  let release!: () => void;
  const outputGate = new Promise<void>((resolve) => { release = resolve; });
  const output: string[] = [];
  let writing = false;
  const hook = runHookAdapter({ socketPath: join(f.directory, "c.sock"), approvalBridge: true,
    input: Readable.from([JSON.stringify(rawInput())]), writeLocalNotice: () => undefined,
    writeOutput: async (text) => { writing = true; await outputGate; output.push(text); } });
  try {
    await until(() => f.snapshot().approvals?.[0]?.can_respond);
    const requestId = f.snapshot().approvals![0]!.request_id;
    const decisionId = f.decide(requestId, "allow");
    await until(() => writing);
    assert.equal(f.snapshot().approvals![0]!.status, "pending");
    assert.equal(f.snapshot().approvals![0]!.can_respond, false);
    f.decide(requestId, "allow", decisionId);
    f.decide(requestId, "deny");
    await until(() => f.messages.filter((message) => message.type === "approval_decision_ack").length === 3);
    const acks = f.messages.filter((message) => message.type === "approval_decision_ack");
    assert.deepEqual(acks.map((message) => [message.accepted, message.reason]), [[true, "forwarded"], [true, "forwarded"], [false, "already_decided"]]);
    release();
    await hook;
    await until(() => f.snapshot().approvals?.[0]?.status === "approved");
    assert.equal(output.length, 1);
  } finally { release(); await f.close(); await hook; }
});

test("parallel requests stay distinct; collector disconnect/restart releases held hooks and cannot revive old requests", async () => {
  const f = await fixture();
  const output = [[], []] as string[][];
  const hooks = [0, 1].map((index) => runHookAdapter({ socketPath: join(f.directory, "c.sock"), approvalBridge: true,
    input: Readable.from([JSON.stringify(rawInput(`private-operation-${index}`))]), writeLocalNotice: () => undefined,
    writeOutput: async (text) => { output[index]!.push(text); } }));
  try {
    await until(() => f.snapshot().approvals?.filter((item) => item.can_respond).length === 2);
    const ids = f.snapshot().approvals!.map((item) => item.request_id);
    assert.notEqual(ids[0], ids[1]);
    await f.restartCollector();
    await Promise.all(hooks);
    assert.deepEqual(output, [[], []]);
    assert.deepEqual(f.snapshot().approvals!.map((item) => [item.status, item.can_respond]), [["unknown", false], ["unknown", false]]);
    f.decide(ids[0]!, "allow");
    await until(() => f.messages.some((message) => message.type === "approval_decision_ack"));
    assert.equal(f.messages.find((message) => message.type === "approval_decision_ack")?.accepted, false);
  } finally { await f.close(); await Promise.all(hooks); }
});

test("hook timeout and failed stdout both restore native flow without a successful result", async () => {
  for (const failure of ["timeout", "stdout"] as const) {
    const f = await fixture(failure === "timeout" ? 1_000 : undefined);
    let writes = 0;
    const hook = runHookAdapter({ socketPath: join(f.directory, "c.sock"), approvalBridge: true,
      input: Readable.from([JSON.stringify(rawInput())]), writeLocalNotice: () => undefined,
      writeOutput: async () => { writes += 1; throw new Error("closed_claude_stdout"); } });
    try {
      await until(() => f.snapshot().approvals?.[0]?.can_respond);
      if (failure === "stdout") f.decide(f.snapshot().approvals![0]!.request_id, "allow");
      await hook;
      await until(() => f.snapshot().approvals?.[0]?.status === "unknown");
      assert.equal(writes, failure === "stdout" ? 1 : 0);
      assert.equal(f.snapshot().approvals![0]!.can_respond, false);
    } finally { await f.close(); await hook; }
  }
});

test("more than one outbox batch and concurrent finishing requests preserve real ACK-driven authority", async () => {
  const f = await fixture();
  const outputs: string[] = [];
  const hooks: Promise<boolean>[] = [];
  const received = f.server.relay.receiveMessage.bind(f.server.relay);
  const heldTerminals: Array<[string, unknown]> = [];
  let holdTerminals = false;
  f.server.relay.receiveMessage = (connectionId, message) => {
    if (holdTerminals && message && typeof message === "object" && (message as { event_type?: string }).event_type === "approval_resolved") {
      heldTerminals.push([connectionId, message]);
    } else received(connectionId, message);
  };
  const enqueueBacklog = async () => {
    for (let i = 0; i < 150; i += 1) {
      await f.runtime.collector.ingestHook({ hook_event_name: "SessionStart", session_id: `backlog-${i}` });
    }
  };
  const startHook = () => {
    const hook = runHookAdapter({ socketPath: join(f.directory, "c.sock"), approvalBridge: true,
      input: Readable.from([JSON.stringify(rawInput())]), writeLocalNotice: () => undefined,
      writeOutput: async (text) => { outputs.push(text); } });
    hooks.push(hook);
    return hook;
  };
  try {
    await enqueueBacklog();
    const firstHook = startHook();
    await until(() => f.snapshot().approvals?.[0]?.can_respond, "request_behind_backlog_never_became_actionable");
    const first = f.snapshot().approvals![0]!;
    assert.ok(first.sequence > 100);
    // A second batch delays the completion event, while actual WebSocket ACKs
    // keep draining the durable queue. Hold only the terminal at the real Relay.
    await enqueueBacklog();
    holdTerminals = true;
    f.decide(first.request_id, "allow");
    await firstHook;
    await until(() => heldTerminals.length === 1);
    assert.equal(outputs.length, 1, "the hook exits before remote terminal acknowledgement");
    assert.equal(f.snapshot().approvals!.find((item) => item.request_id === first.request_id)!.status, "pending");
    const secondHook = startHook();
    await until(() => f.snapshot().approvals?.filter((item) => item.can_respond).length === 1 && f.snapshot().approvals.length === 2);
    const second = f.snapshot().approvals!.find((item) => item.request_id !== first.request_id)!;
    assert.equal(f.snapshot().approvals!.find((item) => item.request_id === first.request_id)!.status, "pending",
      "another request's presence must retain the finishing owner");
    assert.equal(second.can_respond, true);
    holdTerminals = false;
    for (const [connectionId, message] of heldTerminals.splice(0)) received(connectionId, message);
    await until(() => f.snapshot().approvals!.find((item) => item.request_id === first.request_id)!.status === "approved");
    f.decide(second.request_id, "computer");
    await secondHook;
    await until(() => f.snapshot().approvals!.find((item) => item.request_id === second.request_id)!.status === "unknown");
    assert.equal(outputs.length, 1);
  } finally {
    holdTerminals = false;
    for (const [connectionId, message] of heldTerminals.splice(0)) received(connectionId, message);
    await f.close();
    await Promise.all(hooks);
  }
});
