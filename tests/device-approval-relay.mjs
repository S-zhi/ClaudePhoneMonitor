// Isolated real-device fixture. Production hooks, Unix Collector and paired
// SQLite Relay receive synthetic metadata; no Claude command is executed.
// Run after building: DEVICE_TEST_PORT=18883 node tests/device-approval-relay.mjs
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { createCollectorRuntime } from "../services/collector/dist/cli.js";
import { runHookAdapter } from "../services/collector/dist/hook-adapter.js";
import { createRelayServer } from "../services/relay/dist/src/server.js";
import { JsonLogger } from "../services/relay/dist/src/logger.js";

const requestedPort = Number(process.env.DEVICE_TEST_PORT ?? 18883);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error("invalid_fixture_port");
const installationId = "issue23-device-fixture";
const root = await mkdtemp("/tmp/issue23-device-");
const dbPath = join(root, "relay.sqlite");
const socketPath = join(root, "c.sock");
const logger = new JsonLogger({ sink: () => undefined });
const { app, relay } = createRelayServer({
  config: { host: "127.0.0.1", port: requestedPort, authMode: "paired", databasePath: dbPath,
    heartbeatIntervalMs: 10_000, staleAfterMs: 120_000, offlineAfterMs: 240_000, bookkeepingIntervalMs: 1000 },
  logger,
});
const androidSockets = new Set();
const children = new Set();
const requests = new Map();
let runtime;
let token;
let port;
let generation = 0;
let busy = false;
let closing = false;
let closingPromise;
let started = false;
let question;
let plan;
let reviewTask;
let otherTask;
let lastRequestId;
let controlPhone;
const reviewSession = "device-review-session";
const otherSession = "device-parallel-session";
const controlClientId = `device-fixture-controller-${randomUUID()}`;
const cliPath = fileURLToPath(new URL("../services/collector/dist/cli.js", import.meta.url));
const origin = () => `http://127.0.0.1:${port}`;
const wsOrigin = () => `ws://127.0.0.1:${port}`;
const snapshot = () => relay.snapshot(installationId);

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("device_fixture_timeout");
}

async function hook(payload) {
  const before = snapshot().last_sequence ?? 0;
  await runHookAdapter({ socketPath, approvalBridge: true,
    input: Readable.from([JSON.stringify(payload)]), writeLocalNotice: () => undefined,
    writeOutput: async () => { throw new Error("unexpected_fixture_decision"); } });
  await waitFor(() => (snapshot().last_sequence ?? 0) > before);
}

async function start() {
  if (started) return;
  reviewTask = `device-review-task-${generation}`;
  otherTask = `device-parallel-task-${generation}`;
  for (const [session_id, task_id, session_title] of [
    [reviewSession, reviewTask, "Device question task"],
    [otherSession, otherTask, "Device parallel task"],
  ]) {
    await hook({ hook_event_name: "SessionStart", session_id, session_title });
    await hook({ hook_event_name: "UserPromptSubmit", session_id, task_id, session_title });
  }
  started = true;
}

function state() {
  return {
    generation, installation_id: installationId, snapshot: snapshot(),
    active_requests: [...requests.values()].filter((request) => !request.result).map((request) => ({
      request_id: request.request_id, session_id: request.session_id, task_id: request.task_id,
    })),
    hook_results: [...requests.values()].filter((request) => request.result).map((request) => request.result),
    ...(question ? { question } : {}), ...(plan ? { plan } : {}),
  };
}

async function approvalRequest() {
  await start();
  const active = [...requests.values()].find((request) => !request.result);
  if (active) return { ...state(), request_id: active.request_id, session_id: active.session_id, task_id: active.task_id };
  reviewTask = `device-approval-task-${generation}-${requests.size}`;
  await hook({ hook_event_name: "UserPromptSubmit", session_id: reviewSession, task_id: reviewTask, session_title: "Device approval task" });
  const request = { session_id: reviewSession, task_id: reviewTask, decision: undefined, stdout_json: undefined };
  const child = spawn(process.execPath, [cliPath, "--event", "--approval-bridge", "--socket", socketPath],
    { stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  child.once("close", () => children.delete(child));
  child.once("error", () => children.delete(child));
  request.child = child;
  let output = "";
  let notice = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
    if (Buffer.byteLength(output) > 4096) child.kill("SIGTERM");
  });
  child.stderr.on("data", (chunk) => {
    notice = `${notice}${String(chunk)}`.slice(-8192);
    const id = /approval request ([0-9a-f-]{36})/i.exec(notice)?.[1];
    if (id && !request.request_id) {
      request.request_id = id;
      requests.set(id, request);
      lastRequestId = id;
    }
  });
  request.promise = new Promise((resolve) => {
    child.once("error", () => resolve(-1));
    child.once("close", (code) => resolve(code));
  }).then(async (exitCode) => {
    if (exitCode === 0 && output.trim()) {
      try {
        const parsed = JSON.parse(output);
        const behavior = parsed?.hookSpecificOutput?.decision?.behavior;
        if (parsed?.hookSpecificOutput?.hookEventName === "PermissionRequest" && ["allow", "deny"].includes(behavior)) {
          request.stdout_json = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior } } };
        }
      } catch { /* Only fixed allow/deny JSON is returned by the fixture API. */ }
    }
    await waitFor(() => snapshot().approvals?.find((item) => item.request_id === request.request_id)?.status !== "pending").catch(() => undefined);
    const final = snapshot().approvals?.find((item) => item.request_id === request.request_id);
    request.result = { request_id: request.request_id, status: final?.status ?? "unknown",
      decision: request.decision ?? request.stdout_json?.hookSpecificOutput.decision.behavior ?? null,
      child_exit_code: exitCode,
      stdout_empty: output.length === 0,
      ...(request.stdout_json ? { stdout_json: request.stdout_json } : {}) };
  });
  child.fixtureCompletion = request.promise;
  child.stdin.end(JSON.stringify({ hook_event_name: "PermissionRequest", session_id: reviewSession,
    task_id: reviewTask, tool_name: "Bash", tool_input: {} }));
  await waitFor(() => request.request_id && snapshot().approvals?.some((item) => item.request_id === request.request_id && item.can_respond));
  return { ...state(), request_id: request.request_id, session_id: request.session_id, task_id: request.task_id };
}

async function reset() {
  await runtime.approvalBridge.expireAll();
  const completions = [...children].map((child) => child.fixtureCompletion);
  for (const child of children) child.kill("SIGTERM");
  await Promise.all([...completions, ...[...requests.values()].map((request) => request.promise)]);
  await waitFor(async () => await runtime.outbox.size() === 0);
  await runtime.relay.drain();
  // Only this temporary fixture database is touched. Device/Collector tokens
  // and connections survive, and the Collector sequence remains monotonic.
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE; DELETE FROM relay_events; DELETE FROM relay_sessions; DELETE FROM relay_approvals; DELETE FROM relay_installations; DELETE FROM relay_usage_sequences; COMMIT;");
  } finally { db.close(); }
  generation += 1;
  started = false;
  question = undefined;
  plan = undefined;
  requests.clear();
  lastRequestId = undefined;
  await hook({ hook_event_name: "SessionStart", session_id: "device-reset-marker" });
  await hook({ hook_event_name: "SessionEnd", session_id: "device-reset-marker" });
  runtime.approvalBridge.publishPresence();
  return state();
}

async function decision(body) {
  const requestId = body.request_id ?? lastRequestId;
  if (!requests.has(requestId) || !["allow", "deny", "computer"].includes(body.decision)) throw new Error("invalid_fixture_decision");
  if (!controlPhone || controlPhone.readyState !== WebSocket.OPEN) {
    controlPhone = new WebSocket(`${wsOrigin()}/ws/android`);
    await waitFor(() => controlPhone.readyState === WebSocket.OPEN);
    controlPhone.send(JSON.stringify({ type: "hello", schema_version: 1, installation_id: installationId,
      client_id: controlClientId, token }));
    await waitFor(() => relay.repository.listConnections().some((connection) => connection.client_id === controlClientId && connection.status === "online"));
  }
  controlPhone.send(JSON.stringify({ type: "approval_decision", schema_version: 1, installation_id: installationId,
    request_id: requestId, decision_id: body.decision_id ?? randomUUID(), decision: body.decision }));
  await waitFor(() => requests.get(requestId)?.result);
  return state();
}

async function operate(operation, body = {}) {
  if (!runtime || !token) throw new Error("fixture_starting");
  switch (operation) {
    case "reset": return reset();
    case "start": await start(); break;
    case "native_question":
      await start();
      question = { session_id: reviewSession, task_id: reviewTask, correlation_id: `question-${randomUUID()}` };
      await hook({ hook_event_name: "PreToolUse", ...question, tool_use_id: question.correlation_id, tool_name: "AskUserQuestion", tool_input: {} });
      return { ...state(), ...question };
    case "question_answer":
      if (!question) throw new Error("no_fixture_question");
      await hook({ hook_event_name: "PostToolUse", ...question, tool_use_id: question.correlation_id, tool_name: "AskUserQuestion", tool_response: {} });
      break;
    case "unrelated_progress":
      await start();
      for (const session_id of [reviewSession, otherSession]) {
        const task_id = session_id === reviewSession ? reviewTask : otherTask;
        const tool_use_id = `parallel-${randomUUID()}`;
        await hook({ hook_event_name: "PreToolUse", session_id, task_id, tool_use_id, tool_name: "Bash", tool_input: {} });
        await hook({ hook_event_name: body.mode === "failure" ? "PostToolUseFailure" : "PostToolUse", session_id,
          task_id, tool_use_id, tool_name: "Bash", tool_response: {} });
      }
      break;
    case "plan_request":
      await start();
      plan = { session_id: reviewSession, task_id: reviewTask, correlation_id: `plan-${randomUUID()}` };
      await hook({ hook_event_name: "PreToolUse", ...plan, tool_use_id: plan.correlation_id, tool_name: "ExitPlanMode", tool_input: {} });
      return { ...state(), ...plan };
    case "plan_answer":
      if (!plan) throw new Error("no_fixture_plan");
      await hook({ hook_event_name: "PostToolUse", ...plan, tool_use_id: plan.correlation_id, tool_name: "ExitPlanMode", tool_response: {} });
      break;
    case "input_request":
      await start();
      await hook({ hook_event_name: "Notification", session_id: reviewSession, task_id: reviewTask, notification_type: "agent_needs_input" });
      break;
    case "finish_task":
      await hook({ hook_event_name: "Stop", session_id: reviewSession, task_id: reviewTask });
      break;
    case "approval_request": return approvalRequest();
    case "decision": return decision(body);
    case "duplicate": {
      const requestId = body.request_id ?? lastRequestId;
      const original = relay.repository.listEventsAfter(installationId, -1).find(({ event }) =>
        event.event_type === "approval_requested" && event.payload.request_id === requestId)?.event;
      if (!original) throw new Error("no_fixture_approval");
      await runtime.outbox.enqueue({ id: original.event_id, sequence: original.sequence, payload: original, created_at: original.occurred_at });
      await runtime.relay.flushPending();
      await waitFor(async () => !(await runtime.outbox.snapshot()).some((entry) => entry.id === original.event_id));
      runtime.approvalBridge.publishPresence();
      relay.broadcastSnapshotsForInstallation(installationId);
      break;
    }
    // Exercise the production authenticated snapshot send path with the same
    // request/sequence; the device must observe a frame without a new identity.
    case "refresh": relay.broadcastSnapshotsForInstallation(installationId); break;
    case "disconnect_phone":
      for (const socket of androidSockets) socket.destroy();
      break;
    case "shutdown":
      setTimeout(() => { void close().then(() => process.exit(0)); }, 100);
      break;
    default: throw new Error("unknown_fixture_operation");
  }
  return state();
}

function controlHandler(operation) {
  return async (request, reply) => {
    if (busy) return reply.code(409).send({ error: "fixture_busy" });
    busy = true;
    try { return await operate(operation ?? request.body?.operation, request.body ?? {}); }
    catch { return reply.code(400).send({ error: "fixture_operation_failed" }); }
    finally { busy = false; }
  };
}
for (const prefix of ["", "/device-test"]) {
  app.get(`${prefix}/config`, async (_request, reply) => token ? {
    installation_id: installationId, android_token: token, ws_url: `${wsOrigin()}/ws/android`, relay_ws_url: `${wsOrigin()}/ws/android`,
    fixture_base_url: origin(), hold_ms: 10 * 60_000,
  } : reply.code(503).send({ error: "fixture_starting" }));
  app.get(`${prefix}/state`, async () => state());
  for (const operation of ["reset", "start", "native_question", "question_answer", "unrelated_progress", "plan_request", "plan_answer",
    "input_request", "finish_task", "approval_request", "decision", "duplicate", "refresh", "disconnect_phone", "shutdown"]) {
    app.post(`${prefix}/${operation}`, controlHandler(operation));
  }
}
app.post("/device-test/control", controlHandler());

async function close() {
  if (closingPromise) return closingPromise;
  closing = true;
  closingPromise = (async () => {
    controlPhone?.close();
    await runtime?.stop();
    const completions = [...children].map((child) => child.fixtureCompletion);
    for (const child of children) child.kill("SIGTERM");
    await Promise.all([...completions, ...[...requests.values()].map((request) => request.promise)]);
    for (const socket of androidSockets) socket.destroy();
    // Drain close events while SQLite is still open. The production server's
    // onClose hook closes the repository; late socket callbacks must not race it.
    await waitFor(() => relay.stats().active_connections === 0).catch(() => undefined);
    for (const connection of relay.repository.listConnections()) relay.disconnect(connection.connection_id);
    await app.close();
    await rm(root, { recursive: true, force: true });
  })();
  return closingPromise;
}

try {
  await app.ready();
  // Fastify's websocket plugin is encapsulated below the root app. Track the
  // real upgraded Android TCP sockets without changing any production route.
  app.server.on("upgrade", (request, socket) => {
    if (!request.url?.startsWith("/ws/android")) return;
    androidSockets.add(socket);
    socket.once("close", () => androidSockets.delete(socket));
  });
  await app.listen({ host: "127.0.0.1", port: requestedPort });
  port = app.server.address().port;
  const pairing = relay.createPairing({ installation_id: installationId, public_url: origin() });
  token = relay.claimPairingResult(pairing.pairing_id, pairing.code, "isolated device fixture").android_token;
  runtime = await createCollectorRuntime({ dataDir: join(root, "collector"), socketPath, installationId,
    relayUrl: `${wsOrigin()}/ws/collector`, relayToken: pairing.collector_token, approvalBridge: true,
    approvalHoldMs: 10 * 60_000, watchCodex: false, watchUsage: false });
  const receive = runtime.relay.handleServerMessage.bind(runtime.relay);
  runtime.relay.handleServerMessage = async (event) => {
    try {
      const message = JSON.parse(typeof event === "string" ? event : String(event.data));
      if (message.type === "approval_decision" && message.installation_id === installationId && requests.has(message.request_id)) {
        requests.get(message.request_id).decision = message.decision;
      }
    } catch { /* Never log frame data or credentials. */ }
    await receive(event);
  };
  await waitFor(() => runtime.relay.approvalAvailable());
  console.log(JSON.stringify({ status: "ready", port, installation_id: installationId, source: "synthetic_hooks" }));
} catch {
  await close().catch(() => undefined);
  console.error("device_approval_fixture_start_failed");
  process.exit(1);
}
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  void close().then(() => process.exit(0), () => process.exit(1));
});
