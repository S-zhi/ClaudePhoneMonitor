import { challengeResponderFromSecret, isChallengeMessage, respondToChallenge, type ChallengeResponder } from "./challenge.js";
import type {
  ChallengeMessage,
  EventAckMessage,
  HeartbeatMessage,
  HelloMessage,
  Outbox,
  ProbeMessage,
  RelayInboundMessage,
  RelayOutboundMessage,
  OutboxRecord,
} from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

const CONNECTING = 0;
const OPEN = 1;

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface RelayTimerApi {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface RelayClientOptions {
  url: string;
  installationId: string;
  outbox: Outbox<RelayOutboundMessage>;
  websocketFactory?: WebSocketFactory;
  challengeResponder?: ChallengeResponder;
  challengeSecret?: string;
  token?: string;
  heartbeatIntervalMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  jitterMs?: number;
  random?: () => number;
  now?: () => number;
  timers?: RelayTimerApi;
  maxBatchSize?: number;
  logger?: Pick<Console, "warn">;
}

export interface RelayClientState {
  connected: boolean;
  reconnect_attempt: number;
  last_sequence: number;
  pending: number;
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  const constructor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!constructor) throw new Error("websocket_runtime_unavailable");
  return new constructor(url);
}

const defaultTimers: RelayTimerApi = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

function decodeMessage(event: unknown): string | null {
  if (typeof event === "string") return event;
  if (!event || typeof event !== "object") return null;
  const data = (event as { data?: unknown }).data;
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return null;
}

function parseMessage(raw: unknown): RelayInboundMessage | null {
  const text = decodeMessage(raw);
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") return null;
    return value as RelayInboundMessage;
  } catch {
    return null;
  }
}

function finiteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Relay connection for the collector daemon. Queue records remain durable
 * until an event_ack is received, so reconnects are safe to repeat.
 */
export class RelayClient {
  private readonly websocketFactory: WebSocketFactory;
  private readonly challengeResponder: ChallengeResponder;
  private readonly heartbeatIntervalMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly jitterMs: number;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly timers: RelayTimerApi;
  private readonly maxBatchSize: number;
  private readonly logger: Pick<Console, "warn">;
  private socket: WebSocketLike | undefined;
  private stopped = true;
  private reconnectTimer: unknown;
  private heartbeatTimer: unknown;
  private reconnectAttempt = 0;
  private lastSequence = 0;
  private readonly pendingIds = new Set<string>();
  private readonly pendingSequences = new Map<number, string>();

  public constructor(private readonly options: RelayClientOptions) {
    if (!options.url) throw new Error("relay_url_required");
    this.websocketFactory = options.websocketFactory ?? defaultWebSocketFactory;
    this.challengeResponder =
      options.challengeResponder ?? challengeResponderFromSecret(options.challengeSecret);
    this.heartbeatIntervalMs = Math.max(1_000, options.heartbeatIntervalMs ?? 10_000);
    this.reconnectBaseMs = Math.max(1, options.reconnectBaseMs ?? 500);
    this.reconnectMaxMs = Math.max(this.reconnectBaseMs, options.reconnectMaxMs ?? 30_000);
    this.jitterMs = Math.max(0, options.jitterMs ?? 250);
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => Date.now());
    this.timers = options.timers ?? defaultTimers;
    this.maxBatchSize = Math.max(1, options.maxBatchSize ?? 100);
    this.logger = options.logger ?? console;
  }

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  public stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.pendingIds.clear();
    this.pendingSequences.clear();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState !== 3) {
      try {
        socket.close(1000, "collector_stopped");
      } catch {
        // Fail-open for shutdown.
      }
    }
  }

  public state(): RelayClientState {
    return {
      connected: this.socket?.readyState === OPEN,
      reconnect_attempt: this.reconnectAttempt,
      last_sequence: this.lastSequence,
      pending: this.pendingIds.size,
    };
  }

  /** Flush events enqueued after an already-open connection was established. */
  public async flushPending(): Promise<void> {
    await this.flush();
  }

  private connect(): void {
    if (this.stopped || this.socket?.readyState === CONNECTING || this.socket?.readyState === OPEN) return;
    this.clearReconnectTimer();
    let socket: WebSocketLike;
    try {
      socket = this.websocketFactory(this.options.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => this.handleOpen());
    socket.addEventListener("message", (event) => {
      void this.handleServerMessage(event);
    });
    socket.addEventListener("close", () => this.handleClose());
    socket.addEventListener("error", () => this.handleError());
    if (socket.readyState === OPEN) this.handleOpen();
  }

  private handleOpen(): void {
    if (this.stopped) return;
    this.reconnectAttempt = 0;
    this.clearHeartbeatTimer();
    this.sendHello();
    this.heartbeatTimer = this.timers.setInterval(() => this.sendHeartbeat(), this.heartbeatIntervalMs);
    void this.flush();
  }

  private handleClose(): void {
    this.clearHeartbeatTimer();
    this.pendingIds.clear();
    this.pendingSequences.clear();
    this.socket = undefined;
    this.scheduleReconnect();
  }

  private handleError(): void {
    if (this.stopped) return;
    // Some WebSocket implementations emit error without a subsequent close.
    // Detach the failed socket now so the backoff callback can really create a
    // new connection instead of seeing a stale OPEN state.
    this.clearHeartbeatTimer();
    this.pendingIds.clear();
    this.pendingSequences.clear();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState !== 3) {
      try {
        socket.close();
      } catch {
        // Reconnect below; the failed socket is no longer used.
      }
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    const exponential = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.reconnectAttempt);
    const jitter = this.jitterMs > 0 ? Math.floor(Math.max(0, Math.min(1, this.random())) * this.jitterMs) : 0;
    const delay = Math.min(this.reconnectMaxMs, exponential + jitter);
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) return;
    this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer === undefined) return;
    this.timers.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private sendHello(): void {
    const message: HelloMessage & { token?: string } = {
      type: "hello",
      schema_version: SCHEMA_VERSION,
      role: "collector",
      installation_id: this.options.installationId,
      last_sequence: this.lastSequence,
      ...(this.options.token ? { token: this.options.token } : {}),
    };
    this.send(message);
  }

  private sendHeartbeat(heartbeatId?: string, acknowledged = false): void {
    const message: HeartbeatMessage = {
      type: "heartbeat",
      schema_version: SCHEMA_VERSION,
      role: "collector",
      installation_id: this.options.installationId,
      last_sequence: this.lastSequence,
      heartbeat_id: heartbeatId ?? `collector-${this.now()}`,
      sent_at: new Date(this.now()).toISOString(),
      occurred_at: new Date(this.now()).toISOString(),
      acknowledged,
    };
    this.send(message);
  }

  private send(message: RelayOutboundMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.logger.warn("collector relay send failed", error);
      return false;
    }
  }

  private async flush(): Promise<void> {
    if (this.stopped || this.socket?.readyState !== OPEN) return;
    let records: OutboxRecord<RelayOutboundMessage>[];
    try {
      records = await this.options.outbox.peek(this.maxBatchSize);
    } catch {
      return;
    }
    for (const record of records) {
      if (this.pendingIds.has(record.id)) continue;
      if (!this.send(record.payload)) {
        await this.options.outbox.retry(record.id, new Error("relay_send_failed"));
        this.handleError();
        break;
      }
      this.pendingIds.add(record.id);
      this.pendingSequences.set(record.sequence, record.id);
    }
  }

  /** Public for deterministic tests and alternate WebSocket adapters. */
  public async handleServerMessage(raw: unknown): Promise<void> {
    const message = parseMessage(raw);
    if (!message) return;

    switch (message.type) {
      case "event_ack":
        await this.handleAck(message);
        return;
      case "challenge": {
        if (isChallengeMessage(message)) {
          const response = await respondToChallenge(message, this.challengeResponder);
          if (response) this.send(response);
          return;
        }
        // The relay's v1 development route uses challenge_id/ok while the
        // phone-monitor probe contract uses probe_id/nonce. Support both wire
        // shapes without ever echoing arbitrary payload data.
        const challenge = message as ChallengeMessage;
        if (typeof challenge.challenge_id === "string" && challenge.challenge_id.length > 0) {
          this.send({
            type: "challenge_ack",
            schema_version: SCHEMA_VERSION,
            challenge_id: challenge.challenge_id,
            ok: true,
          });
        }
        return;
      }
      case "heartbeat":
        if (!(message as HeartbeatMessage).acknowledged) {
          this.sendHeartbeat((message as HeartbeatMessage).heartbeat_id, true);
        }
        return;
      case "probe":
        await this.handleProbe(message);
        return;
      case "hello_ack":
      case "resume":
      case "snapshot":
      case "subscribe":
        await this.flush();
        return;
      case "error":
        await this.handleRelayError(message);
        return;
      default:
        return;
    }
  }

  private async handleAck(message: EventAckMessage): Promise<void> {
    if (typeof message.event_id !== "string") return;
    const pendingSequence = [...this.pendingSequences.entries()].find(
      ([, eventId]) => eventId === message.event_id,
    )?.[0];
    const sequence = finiteInteger(message.sequence)
      ? message.sequence
      : pendingSequence;
    const rejected = message.status === "rejected" || message.accepted === false && message.status !== "duplicate" && message.duplicate !== true;
    if (rejected) {
      await this.options.outbox.retry(message.event_id, new Error("event_rejected"));
    } else {
      const acknowledged = await this.options.outbox.ack(message.event_id);
      if (!acknowledged && sequence !== undefined) await this.options.outbox.ack(sequence);
    }
    this.pendingIds.delete(message.event_id);
    if (sequence !== undefined) this.pendingSequences.delete(sequence);
    if (!rejected && sequence !== undefined) {
      this.lastSequence = Math.max(this.lastSequence, sequence);
    } else if (!rejected && finiteInteger(message.last_sequence)) {
      this.lastSequence = Math.max(this.lastSequence, message.last_sequence);
    }
    await this.flush();
  }

  private async handleProbe(message: ProbeMessage): Promise<void> {
    if (typeof message.probe_id === "string" && typeof message.nonce === "string") {
      const response = await respondToChallenge(
        { type: "challenge", probe_id: message.probe_id, nonce: message.nonce },
        this.challengeResponder,
      );
      if (response) this.send(response);
    }
    // A probe without a nonce is a routed control message. It is intentionally
    // not echoed: doing so would bounce the same probe between gateways.
  }

  private async handleRelayError(message: Record<string, unknown>): Promise<void> {
    const eventId = typeof message.event_id === "string" ? message.event_id : undefined;
    const sequence = finiteInteger(message.sequence) ? message.sequence : undefined;
    if (eventId) {
      await this.options.outbox.retry(eventId, new Error("relay_error"));
      this.pendingIds.delete(eventId);
    } else if (sequence !== undefined) {
      await this.options.outbox.retry(sequence, new Error("relay_error"));
      const pendingId = this.pendingSequences.get(sequence);
      if (pendingId) this.pendingIds.delete(pendingId);
      this.pendingSequences.delete(sequence);
    }
    await this.flush();
  }
}

export const WebSocketRelayClient = RelayClient;
