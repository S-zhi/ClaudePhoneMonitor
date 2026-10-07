import assert from "node:assert/strict";
import test from "node:test";
import {
  ERROR_DURATION_MS,
  EVENT_TYPES,
  FINISH_DURATION_MS,
  MESSAGE_TYPES,
  MONITOR_STATUS,
  PROTOCOL_VERSION,
  STATUS_PRECEDENCE,
  classifyEvent,
  classifySnapshot,
  createInitialMonitorState,
  effectiveMonitorStatus,
  highestPriorityBaseStatus,
  highestPriorityStatus,
  monitorReducer,
  nextOverlayExpiry,
  transientRemainingMs,
  type EventEnvelope,
  type EventPayload,
  type MonitorEventType,
} from "../src/index.js";

function event<T extends MonitorEventType>(
  event_type: T,
  payload: EventPayload<T>,
  sequence: number,
  occurred_at = sequence * 1_000,
): EventEnvelope<T> {
  return {
    type: MESSAGE_TYPES.EVENT,
    schema_version: PROTOCOL_VERSION,
    event_id: `event-${sequence}`,
    installation_id: "installation-1",
    session_id: "session-1",
    sequence,
    occurred_at: new Date(occurred_at).toISOString(),
    event_type,
    payload,
  };
}

test("classifies canonical activity events", () => {
  assert.equal(classifyEvent(event(EVENT_TYPES.SESSION_STARTED, {}, 1)).status, MONITOR_STATUS.IDLE);
  assert.equal(classifyEvent(event(EVENT_TYPES.TASK_STARTED, {}, 2)).status, MONITOR_STATUS.WORKING);
  assert.equal(
    classifyEvent(event(EVENT_TYPES.WAITING, { reason: "permission" }, 3)).status,
    MONITOR_STATUS.WAITING,
  );
  assert.equal(
    classifyEvent(event(EVENT_TYPES.TASK_FINISHED, {}, 4)).status,
    MONITOR_STATUS.FINISH,
  );
  assert.equal(
    classifyEvent(event(EVENT_TYPES.TASK_FAILED, { error_code: "E_FAIL" }, 5)).status,
    MONITOR_STATUS.ERROR,
  );
});

test("keeps Working ahead of Waiting when combining session statuses", () => {
  assert.deepEqual(STATUS_PRECEDENCE, [
    MONITOR_STATUS.OFFLINE,
    MONITOR_STATUS.ERROR,
    MONITOR_STATUS.WORKING,
    MONITOR_STATUS.WAITING,
    MONITOR_STATUS.IDLE,
  ]);
  assert.equal(
    highestPriorityStatus([
      MONITOR_STATUS.IDLE,
      MONITOR_STATUS.WORKING,
      MONITOR_STATUS.WAITING,
      MONITOR_STATUS.ERROR,
      MONITOR_STATUS.OFFLINE,
    ]),
    MONITOR_STATUS.OFFLINE,
  );
  assert.equal(
    highestPriorityStatus([MONITOR_STATUS.IDLE, MONITOR_STATUS.WORKING, MONITOR_STATUS.WAITING]),
    MONITOR_STATUS.WORKING,
  );
  assert.equal(
    highestPriorityBaseStatus([MONITOR_STATUS.WAITING, MONITOR_STATUS.WORKING]),
    MONITOR_STATUS.WORKING,
  );
});

test("reduces working and waiting transitions while ignoring duplicate/order violations", () => {
  let state = createInitialMonitorState();
  state = monitorReducer(state, {
    type: "event",
    event: event(EVENT_TYPES.TASK_STARTED, {}, 1),
  });
  assert.equal(effectiveMonitorStatus(state), MONITOR_STATUS.WORKING);

  state = monitorReducer(state, {
    type: "event",
    event: event(EVENT_TYPES.WAITING, { reason: "question" }, 2),
  });
  assert.equal(effectiveMonitorStatus(state), MONITOR_STATUS.WAITING);

  const duplicate = monitorReducer(state, {
    type: "event",
    event: event(EVENT_TYPES.TASK_STARTED, {}, 2),
  });
  assert.equal(duplicate, state);

  const gap = monitorReducer(state, {
    type: "event",
    event: event(EVENT_TYPES.TASK_STARTED, {}, 4),
  });
  assert.equal(gap, state);
});

test("shows FINISH for 5000ms and then returns to the durable base", () => {
  let state = monitorReducer(createInitialMonitorState(), {
    type: "event",
    event: event(EVENT_TYPES.TASK_FINISHED, {}, 1, 10_000),
  });
  assert.equal(effectiveMonitorStatus(state, 10_000), MONITOR_STATUS.FINISH);
  assert.equal(transientRemainingMs(state, 10_000), FINISH_DURATION_MS);
  assert.equal(nextOverlayExpiry(state), 10_000 + FINISH_DURATION_MS);

  state = monitorReducer(state, { type: "tick", at: 14_999 });
  assert.equal(effectiveMonitorStatus(state, 14_999), MONITOR_STATUS.FINISH);
  state = monitorReducer(state, { type: "tick", at: 15_000 });
  assert.equal(effectiveMonitorStatus(state, 15_000), MONITOR_STATUS.IDLE);
  assert.equal(state.overlay, null);
});

test("shows ERROR for 10000ms, and error is not hidden by a finish flash", () => {
  let state = monitorReducer(createInitialMonitorState(), {
    type: "event",
    event: event(EVENT_TYPES.TASK_FAILED, { error_code: "E_FAIL" }, 1, 20_000),
  });
  assert.equal(effectiveMonitorStatus(state, 20_000), MONITOR_STATUS.ERROR);
  assert.equal(transientRemainingMs(state, 20_000), ERROR_DURATION_MS);

  state = monitorReducer(state, {
    type: "overlay",
    status: MONITOR_STATUS.FINISH,
    at: 20_001,
  });
  assert.equal(effectiveMonitorStatus(state, 20_001), MONITOR_STATUS.ERROR);

  state = monitorReducer(state, { type: "tick", at: 30_000 });
  assert.equal(effectiveMonitorStatus(state, 30_000), MONITOR_STATUS.IDLE);
});

test("OFFLINE always wins over an active transient overlay", () => {
  let state = monitorReducer(createInitialMonitorState(), {
    type: "event",
    event: event(EVENT_TYPES.TASK_FINISHED, {}, 1, 1_000),
  });
  state = monitorReducer(state, {
    type: "base",
    status: MONITOR_STATUS.OFFLINE,
    at: 1_001,
  });
  assert.equal(effectiveMonitorStatus(state, 1_001), MONITOR_STATUS.OFFLINE);

  state = monitorReducer(state, {
    type: "base",
    status: MONITOR_STATUS.WORKING,
    at: 1_002,
  });
  assert.equal(effectiveMonitorStatus(state, 1_002), MONITOR_STATUS.FINISH);
});

test("maps canonical snapshots to base activity", () => {
  const online = {
    type: MESSAGE_TYPES.SNAPSHOT,
    schema_version: PROTOCOL_VERSION,
    installation_id: "installation-1",
    computer_state: "online" as const,
    claude_state: "waiting" as const,
    last_sequence: 8,
    updated_at: new Date(8_000).toISOString(),
  };
  assert.equal(classifySnapshot(online).status, MONITOR_STATUS.WAITING);

  const offline = { ...online, computer_state: "offline" as const };
  assert.equal(classifySnapshot(offline).status, MONITOR_STATUS.OFFLINE);
  assert.equal(effectiveMonitorStatus(monitorReducer(createInitialMonitorState(), {
    type: "snapshot",
    snapshot: offline,
  })), MONITOR_STATUS.OFFLINE);
});
