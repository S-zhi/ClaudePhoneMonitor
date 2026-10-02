import type {
  EventEnvelope,
  SequenceDecision,
  SequenceNumber,
} from "./types.js";

export type SequenceDisposition = SequenceDecision["disposition"];

export function compareSequence(a: SequenceNumber, b: SequenceNumber): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function classifySequence(
  incoming: SequenceNumber,
  previous: SequenceNumber,
): SequenceDisposition {
  if (incoming === previous + 1) return "next";
  if (incoming === previous) return "duplicate";
  if (incoming < previous) return "stale";
  return "gap";
}

/** Duplicate includes replayed and stale sequence numbers. */
export function isDuplicateSequence(
  incoming: SequenceNumber,
  previous: SequenceNumber,
): boolean {
  return incoming <= previous;
}

export const isDuplicate = isDuplicateSequence;

export function isStaleSequence(
  incoming: SequenceNumber,
  previous: SequenceNumber,
): boolean {
  return incoming < previous;
}

export function isOutOfOrderSequence(
  incoming: SequenceNumber,
  previous: SequenceNumber,
): boolean {
  return incoming > previous + 1;
}

export const isOutOfOrder = isOutOfOrderSequence;

export function isNextSequence(
  incoming: SequenceNumber,
  previous: SequenceNumber,
): boolean {
  return incoming === previous + 1;
}

/**
 * Apply only the next contiguous sequence. A gap is deliberately rejected so
 * callers can issue a resume request instead of silently losing an event.
 */
export function acceptSequence(
  previous: SequenceNumber,
  incoming: SequenceNumber,
): SequenceDecision {
  const disposition = classifySequence(incoming, previous);
  return {
    accepted: disposition === "next",
    disposition,
    previous,
    incoming,
    next: disposition === "next" ? incoming : previous,
  };
}

/** Useful when a snapshot has established a new cursor and gaps are intentional. */
export function acceptSequenceWithGap(
  previous: SequenceNumber,
  incoming: SequenceNumber,
): SequenceDecision {
  const disposition = classifySequence(incoming, previous);
  const accepted = incoming > previous;
  return {
    accepted,
    disposition,
    previous,
    incoming,
    next: accepted ? incoming : previous,
  };
}

export interface EventSequenceCursor {
  readonly last_sequence: SequenceNumber;
}

export function advanceCursor(
  cursor: EventSequenceCursor,
  incoming: SequenceNumber,
): EventSequenceCursor | null {
  const decision = acceptSequence(cursor.last_sequence, incoming);
  return decision.accepted ? { last_sequence: decision.next } : null;
}

export function compareEvents(a: EventEnvelope, b: EventEnvelope): -1 | 0 | 1 {
  const bySequence = compareSequence(a.sequence, b.sequence);
  if (bySequence !== 0) return bySequence;
  if (a.event_id < b.event_id) return -1;
  if (a.event_id > b.event_id) return 1;
  return 0;
}

export function orderEvents(events: readonly EventEnvelope[]): EventEnvelope[] {
  return [...events].sort(compareEvents);
}

/**
 * De-duplicate by both event id and sequence. The first event in sequence order
 * wins, making the function deterministic for replay batches.
 */
export function dedupeEvents(events: readonly EventEnvelope[]): EventEnvelope[] {
  const result: EventEnvelope[] = [];
  const eventIds = new Set<string>();
  const sequences = new Set<SequenceNumber>();

  for (const event of orderEvents(events)) {
    if (eventIds.has(event.event_id) || sequences.has(event.sequence)) continue;
    eventIds.add(event.event_id);
    sequences.add(event.sequence);
    result.push(event);
  }
  return result;
}

export function filterNewEvents(
  events: readonly EventEnvelope[],
  previous: SequenceNumber,
): EventEnvelope[] {
  return dedupeEvents(events).filter((event) => event.sequence > previous);
}

export function validateSequenceNumber(value: unknown): value is SequenceNumber {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
