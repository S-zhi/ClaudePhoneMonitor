import assert from "node:assert/strict";
import test from "node:test";
import {
  EVENT_TYPES,
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  SNAPSHOT_SCHEMA,
  validateEventEnvelope,
  validateEventPayload,
  validateProtocolMessage,
  validateSnapshot,
  parseProtocolMessage,
  type EventEnvelope,
  type EventPayload,
  type MonitorEventType,
  type ProtocolMessage,
  type Snapshot,
} from "../src/index.js";

function makeEvent<T extends MonitorEventType>(
  event_type: T,
  payload: EventPayload<T>,
  sequence = 1,
): EventEnvelope<T> {
  return {
    type: MESSAGE_TYPES.EVENT,
    schema_version: PROTOCOL_VERSION,
    event_id: `event-${sequence}`,
    installation_id: "installation-1",
    session_id: "session-1",
    sequence,
    occurred_at: new Date(sequence * 100).toISOString(),
    event_type,
    payload,
  };
}

const snapshot: Snapshot = {
  type: MESSAGE_TYPES.SNAPSHOT,
  schema_version: PROTOCOL_VERSION,
  installation_id: "installation-1",
  computer_state: "online",
  claude_state: "working",
  activity: "tool running",
  last_sequence: 4,
  updated_at: new Date(400).toISOString(),
};

test("validates canonical event envelopes and snapshots", () => {
  const event = makeEvent(EVENT_TYPES.TOOL_STARTED, { tool_name: "bash" });
  const eventResult = validateEventEnvelope(event);
  const snapshotResult = validateSnapshot(snapshot);

  assert.equal(eventResult.success, true);
  assert.equal(snapshotResult.success, true);
  assert.equal(SNAPSHOT_SCHEMA.type, "object");
});

test("validates event payloads without allowing arbitrary fields", () => {
  const valid = validateEventPayload(EVENT_TYPES.WAITING, { reason: "permission" });
  const unknown = validateEventPayload(EVENT_TYPES.WAITING, {
    reason: "permission",
    prompt: "do the thing",
  });
  const toolResult = validateEventPayload(EVENT_TYPES.TOOL_FINISHED, {
    tool_name: "bash",
    result: "secret output",
  });

  assert.equal(valid.success, true);
  assert.equal(unknown.success, false);
  assert.equal(toolResult.success, false);
});

test("rejects prompt and tool content even when nested", () => {
  const event = makeEvent(EVENT_TYPES.TASK_STARTED, {
    prompt: "never forward this",
  } as never);
  const result = validateEventEnvelope(event);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.issues.some((issue) => issue.path.endsWith(".prompt")));
  }
});

test("recognizes every wire message discriminator", () => {
  const messages: ProtocolMessage[] = [
    {
      type: MESSAGE_TYPES.HELLO,
      schema_version: PROTOCOL_VERSION,
      installation_id: "installation-1",
      client_id: "phone-1",
    },
    {
      type: MESSAGE_TYPES.HEARTBEAT,
      schema_version: PROTOCOL_VERSION,
      sent_at: new Date(100).toISOString(),
    },
    snapshot,
    {
      type: MESSAGE_TYPES.RESUME,
      schema_version: PROTOCOL_VERSION,
      installation_id: "installation-1",
      session_id: "session-1",
      last_sequence: 4,
    },
    {
      type: MESSAGE_TYPES.PROBE,
      schema_version: PROTOCOL_VERSION,
      nonce: "nonce-1",
    },
    {
      type: MESSAGE_TYPES.ERROR,
      schema_version: PROTOCOL_VERSION,
      code: "BAD_REQUEST",
      message: "invalid message",
    },
  ];

  for (const message of messages) {
    assert.equal(validateProtocolMessage(message).success, true, message.type);
  }

  assert.deepEqual(
    parseProtocolMessage(JSON.stringify(messages[0])),
    messages[0],
  );
});
