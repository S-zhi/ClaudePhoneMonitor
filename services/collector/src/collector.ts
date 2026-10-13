import { eventId, type LocalSequence } from "./sequence.js";
import { normalizeHookEvent, type NormalizeOptions } from "./normalize.js";
import { safeAgentId } from "./agent-identity.js";
import { isSafeEventPayload, type EventEnvelope, type Outbox, type NormalizedHookEvent, type RelayOutboundMessage } from "./types.js";

export interface CollectorOptions {
  installationId: string;
  sequence: Pick<LocalSequence, "next" | "current">;
  outbox: Pick<Outbox<RelayOutboundMessage>, "enqueue" | "size">;
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
    const agentId = safeAgentId(normalized.agent_id);
    const { source_started_at: _started, source_last_activity_at: _activity, ...ordinaryPayload } = normalized.payload;
    const metadata = normalized.event_type === "session_metadata_updated";
    const metadataPayload = metadata && isSafeEventPayload(normalized.payload) ? {
      ...(normalized.payload.source_started_at ? { source_started_at: normalized.payload.source_started_at } : {}),
      ...(normalized.payload.source_last_activity_at ? { source_last_activity_at: normalized.payload.source_last_activity_at } : {}),
    } : {};
    const sequence = await this.options.sequence.next();
    const envelope: EventEnvelope = {
      type: "event",
      schema_version: 1,
      event_id: eventId(this.options.installationId, sequence),
      installation_id: this.options.installationId,
      session_id: normalized.session_id,
      ...(agentId ? { agent_id: agentId } : {}),
      ...(normalized.task_id && !metadata ? { task_id: normalized.task_id } : {}),
      ...(normalized.session_title ? { session_title: normalized.session_title } : {}),
      ...(normalized.session_kind ? { session_kind: normalized.session_kind } : {}),
      sequence,
      occurred_at: normalized.occurred_at,
      event_type: normalized.event_type,
      payload: metadata ? metadataPayload : ordinaryPayload,
      ...(normalized.correlation_id && !metadata ? { correlation_id: normalized.correlation_id } : {}),
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
