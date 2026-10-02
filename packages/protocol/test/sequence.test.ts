import assert from "node:assert/strict";
import test from "node:test";
import {
  EVENT_TYPES,
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  acceptSequence,
  acceptSequenceWithGap,
  advanceCursor,
  classifySequence,
  compareEvents,
  dedupeEvents,
  decideResume,
  filterNewEvents,
  isDuplicateSequence,
  isNextSequence,
  isOutOfOrderSequence,
  isStaleSequence,
  makeResumeMessage,
  orderEvents,
  type EventEnvelope,
} from "../src/index.js";

function event(sequence: number, event_id = `event-${sequence}`): EventEnvelope {
  return {
    type: MESSAGE_TYPES.EVENT,
    schema_version: PROTOCOL_VERSION,
    event_id,
    installation_id: "installation-1",
    session_id: "session-1",
    sequence,
    occurred_at: new Date(sequence).toISOString(),
    event_type: EVENT_TYPES.TASK_STARTED,
    payload: {},
  };
}

test("classifies next, duplicate, stale, and gap sequence numbers", () => {
  assert.equal(classifySequence(1, 0), "next");
  assert.equal(classifySequence(4, 4), "duplicate");
  assert.equal(classifySequence(2, 4), "stale");
  assert.equal(classifySequence(7, 4), "gap");
  assert.equal(isNextSequence(5, 4), true);
  assert.equal(isDuplicateSequence(3, 4), true);
  assert.equal(isStaleSequence(3, 4), true);
  assert.equal(isOutOfOrderSequence(6, 4), true);
});

test("accepts only contiguous events and preserves the cursor on duplicates/gaps", () => {
  assert.deepEqual(acceptSequence(0, 1), {
    accepted: true,
    disposition: "next",
    previous: 0,
    incoming: 1,
    next: 1,
  });
  assert.equal(acceptSequence(1, 1).accepted, false);
  assert.equal(acceptSequence(1, 3).disposition, "gap");
  assert.deepEqual(advanceCursor({ last_sequence: 1 }, 2), { last_sequence: 2 });
  assert.equal(advanceCursor({ last_sequence: 1 }, 3), null);
  assert.equal(acceptSequenceWithGap(1, 3).accepted, true);
});

test("orders and de-duplicates replay batches by sequence and event id", () => {
  const events = [event(3), event(1), event(2), event(2, "other-id"), event(3)];
  const ordered = orderEvents(events);
  assert.deepEqual(ordered.map(({ sequence }) => sequence), [1, 2, 2, 3, 3]);
  assert.equal(compareEvents(event(1), event(2)), -1);

  const unique = dedupeEvents(events);
  assert.deepEqual(unique.map(({ sequence }) => sequence), [1, 2, 3]);
  assert.deepEqual(filterNewEvents(events, 1).map(({ sequence }) => sequence), [2, 3]);
});

test("decides resume boundaries and creates a canonical resume message", () => {
  assert.deepEqual(
    decideResume({
      requested_session_id: "session-1",
      last_sequence: 4,
      window: { session_id: "session-1", first_sequence: 1, latest_sequence: 8 },
    }),
    {
      status: "resumed",
      session_id: "session-1",
      replay_from: 5,
      latest_sequence: 8,
    },
  );
  assert.equal(
    decideResume({
      requested_session_id: "other",
      last_sequence: 0,
      window: { session_id: "session-1", first_sequence: 1, latest_sequence: 8 },
    }).status,
    "reset",
  );
  assert.equal(
    decideResume({
      requested_session_id: "session-1",
      last_sequence: 0,
      window: { session_id: "session-1", first_sequence: 5, latest_sequence: 8 },
    }).status,
    "reset",
  );
  assert.deepEqual(makeResumeMessage("installation-1", "session-1", 4), {
    type: MESSAGE_TYPES.RESUME,
    schema_version: PROTOCOL_VERSION,
    installation_id: "installation-1",
    session_id: "session-1",
    last_sequence: 4,
  });
});
