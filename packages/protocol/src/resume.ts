import { MESSAGE_TYPES, PROTOCOL_VERSION } from "./constants.js";
import { acceptSequence } from "./sequence.js";
import type {
  ResumeMessage,
  ResumeResetReason,
  ResumeResult,
  SequenceNumber,
} from "./types.js";

export interface ResumeWindow {
  readonly session_id: string;
  /** First event still available for replay. */
  readonly first_sequence: SequenceNumber;
  /** Highest event currently available. */
  readonly latest_sequence: SequenceNumber;
}

export interface ResumeOptions {
  readonly requested_session_id: string;
  readonly last_sequence: SequenceNumber;
  readonly window: ResumeWindow;
}

export function makeResumeMessage(
  installation_id: string,
  session_id: string,
  last_sequence: SequenceNumber,
): ResumeMessage {
  return {
    type: MESSAGE_TYPES.RESUME,
    schema_version: PROTOCOL_VERSION,
    installation_id,
    session_id,
    last_sequence,
  };
}

export function canResume(options: ResumeOptions): boolean {
  return decideResume(options).status === "resumed";
}

export function decideResume(options: ResumeOptions): ResumeResult {
  const { requested_session_id, last_sequence, window } = options;
  if (requested_session_id !== window.session_id) {
    return resetResult(requested_session_id, "session_mismatch", window.latest_sequence);
  }
  if (last_sequence > window.latest_sequence) {
    return resetResult(requested_session_id, "sequence_ahead", window.latest_sequence);
  }

  // A cursor immediately before the retained window can replay from its first event.
  if (last_sequence < window.first_sequence - 1) {
    return resetResult(requested_session_id, "history_expired", window.latest_sequence);
  }

  return {
    status: "resumed",
    session_id: window.session_id,
    replay_from: last_sequence + 1,
    latest_sequence: window.latest_sequence,
  };
}

function resetResult(
  session_id: string,
  reason: ResumeResetReason,
  snapshot_sequence: SequenceNumber,
): ResumeResult {
  return { status: "reset", session_id, reason, snapshot_sequence };
}

export function nextReplaySequence(last_sequence: SequenceNumber): SequenceNumber {
  return last_sequence + 1;
}

export function isReplaySequence(
  sequence: SequenceNumber,
  last_sequence: SequenceNumber,
  latest_sequence: SequenceNumber,
): boolean {
  return sequence > last_sequence && sequence <= latest_sequence;
}

/**
 * Apply a replay event cursor without allowing duplicates or gaps. This helper
 * is intentionally shared by reconnecting collectors and phone clients.
 */
export function advanceReplayCursor(
  last_sequence: SequenceNumber,
  incoming_sequence: SequenceNumber,
): SequenceNumber | null {
  const decision = acceptSequence(last_sequence, incoming_sequence);
  return decision.accepted ? decision.next : null;
}
