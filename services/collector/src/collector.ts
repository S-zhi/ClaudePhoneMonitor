import { eventId, type LocalSequence } from "./sequence.js";
import { normalizeHookEvent, type NormalizeOptions } from "./normalize.js";
import type { EventEnvelope, Outbox, NormalizedHookEvent } from "./types.js";

export interface CollectorOptions {
  installationId: string;
  sequence: Pick<LocalSequence, "next" | "current">;
  outbox: Outbox<EventEnvelope>;
  now?: () => Date;
}

/** Converts sanitized hook metadata into canonical envelopes and queues it. */
export class Collector {
  private readonly now: () => Date;

  public constructor(private readonly options: CollectorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public async ingestHook(input: unknown): Promise<EventEnvelope | null> {
    const normalized = normalizeHookEvent(input, { now: this.now });
    if (!normalized) return null;
    return this.ingestNormalized(normalized);
  }

  public async ingestNormalized(normalized: NormalizedHookEvent): Promise<EventEnvelope> {
    const sequence = await this.options.sequence.next();
    const envelope: EventEnvelope = {
      type: "event",
      schema_version: 1,
      event_id: eventId(this.options.installationId, sequence),
      installation_id: this.options.installationId,
      session_id: normalized.session_id,
      ...(normalized.task_id ? { task_id: normalized.task_id } : {}),
      ...(normalized.session_title ? { session_title: normalized.session_title } : {}),
      sequence,
      occurred_at: normalized.occurred_at,
      event_type: normalized.event_type,
      payload: normalized.payload,
      ...(normalized.correlation_id ? { correlation_id: normalized.correlation_id } : {}),
    };
    await this.options.outbox.enqueue({
      id: envelope.event_id,
      sequence,
      payload: envelope,
      created_at: envelope.occurred_at,
    });
    return envelope;
  }

  public async queueSize(): Promise<number> {
    return this.options.outbox.size();
  }
}

export function normalizeForCollector(input: unknown, options?: NormalizeOptions): NormalizedHookEvent | null {
  return normalizeHookEvent(input, options);
}
