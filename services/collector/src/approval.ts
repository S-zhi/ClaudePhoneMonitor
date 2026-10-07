import type net from "node:net";
import { nativeInteractionReason, normalizeHookEvent } from "./normalize.js";
import { isApprovalId, type ApprovalDecisionMessage, type EventAckMessage, type EventEnvelope, type NormalizedHookEvent } from "./types.js";

export const APPROVAL_HOLD_MS = 10 * 60_000;
const MAX_PENDING_APPROVALS = 128;

interface HeldApproval {
  requestId: string;
  event: NormalizedHookEvent;
  socket: net.Socket;
  expiresAt: string;
  timer: NodeJS.Timeout;
  published: Promise<void>;
  decision?: ApprovalDecisionMessage;
  settled: boolean;
  requestEventId?: string;
  requestedAcknowledged: boolean;
  resolvedEventId?: string;
  finalStatus?: "approved" | "denied" | "unknown";
  finished?: Promise<void>;
}

export interface ApprovalBridgeOptions {
  enabled: boolean;
  installationId: string;
  emit: (event: NormalizedHookEvent) => Promise<EventEnvelope>;
  flush: () => Promise<void>;
  isConnected: () => boolean;
  publishPresence: (requestIds: string[]) => void;
  holdMs?: number;
  now?: () => Date;
}

/**
 * Owns actual held local hook sockets. Neither durable events nor a restarted
 * daemon can reconstruct this authority. Only an applied handshake from the
 * same socket can produce approved/denied metadata.
 */
export class ApprovalBridge {
  private readonly pending = new Map<string, HeldApproval>();
  private readonly sockets = new Set<net.Socket>();
  private readonly finishing = new Set<Promise<void>>();
  private stopped = false;
  private readonly now: () => Date;
  private readonly holdMs: number;

  constructor(private readonly options: ApprovalBridgeOptions) {
    this.now = options.now ?? (() => new Date());
    this.holdMs = Math.min(APPROVAL_HOLD_MS, Math.max(1, options.holdMs ?? APPROVAL_HOLD_MS));
  }

  publishPresence(): void {
    this.options.publishPresence([...this.pending.values()]
      .filter((pending) => pending.requestedAcknowledged && this.now().getTime() < Date.parse(pending.expiresAt) &&
        ((!pending.settled && !pending.socket.destroyed) || pending.finalStatus === "approved" || pending.finalStatus === "denied"))
      .map((pending) => pending.requestId));
  }

  handleEventAck(message: EventAckMessage): void {
    const accepted = message.status === "accepted" || message.status === "duplicate";
    for (const request of this.pending.values()) {
      if (request.requestEventId === message.event_id) {
        if (!accepted) { void this.finish(request, "unknown"); return; }
        request.requestedAcknowledged = true;
        this.publishPresence();
        return;
      }
      if (request.resolvedEventId === message.event_id) {
        this.remove(request);
        return;
      }
    }
  }

  private remove(request: HeldApproval): void {
    clearTimeout(request.timer);
    this.pending.delete(request.requestId);
    this.publishPresence();
  }

  async handleLocalMessage(message: unknown, socket: net.Socket): Promise<boolean> {
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    const value = message as Record<string, unknown>;
    if (value.type === "approval_wait") {
      await this.register(value, socket);
      return true;
    }
    if (value.type === "approval_applied") {
      const request = isApprovalId(value.request_id) ? this.pending.get(value.request_id) : undefined;
      if (!request || request.socket !== socket || !request.decision || request.settled ||
        value.decision_id !== request.decision.decision_id || this.now().getTime() >= Date.parse(request.expiresAt)) {
        socket.end();
        return true;
      }
      await this.finish(request, request.decision.decision === "allow" ? "approved" : request.decision.decision === "deny" ? "denied" : "unknown");
      return true;
    }
    return false;
  }

  private async register(value: Record<string, unknown>, socket: net.Socket): Promise<void> {
    if (this.stopped || socket.destroyed || !this.options.enabled || !isApprovalId(value.request_id) || this.sockets.has(socket) ||
      this.pending.has(value.request_id) || this.pending.size >= MAX_PENDING_APPROVALS) {
      socket.end();
      return;
    }
    const registeredAt = this.now();
    const event = normalizeHookEvent({
      hook_event_name: "PermissionRequest",
      session_id: value.session_id,
      task_id: value.task_id,
      tool_name: value.tool_name,
    }, { now: registeredAt });
    if (!event || event.session_id === "unknown") {
      socket.end();
      return;
    }
    if (nativeInteractionReason(event.payload.tool_name)) {
      // Also protect the daemon boundary from old/custom adapters trying to
      // hold a question or plan review as a permission-only approval request.
      await this.options.emit(event);
      await this.options.flush();
      socket.end();
      return;
    }
    const expiresAt = new Date(registeredAt.getTime() + this.holdMs).toISOString();
    const request: HeldApproval = {
      requestId: value.request_id,
      event,
      socket,
      expiresAt,
      timer: setTimeout(() => {
        if (request.settled) this.remove(request);
        else void this.finish(request, "unknown");
      }, this.holdMs),
      published: Promise.resolve(),
      settled: false,
      requestedAcknowledged: false,
    };
    this.pending.set(request.requestId, request);
    this.sockets.add(socket);
    socket.once("close", () => {
      this.sockets.delete(socket);
      void this.finish(request, "unknown");
    });
    request.published = (async () => {
      // Preserve the usual waiting state while keeping approval history out of
      // the activity overlay and session ordering.
      await this.options.emit(event);
      const requested = await this.options.emit({
        ...event,
        event_type: "approval_requested",
        payload: {
          request_id: request.requestId,
          source: "claude_code",
          status: "pending",
          can_respond: true,
          expires_at: expiresAt,
          ...(event.payload.tool_name ? { tool_name: event.payload.tool_name } : {}),
        },
      });
      request.requestEventId = requested.event_id;
      await this.options.flush();
    })();
    try {
      await request.published;
      if (socket.destroyed || !this.options.isConnected()) {
        await this.finish(request, "unknown");
      }
    } catch {
      await this.finish(request, "unknown");
    }
  }

  async decide(message: ApprovalDecisionMessage): Promise<boolean> {
    const request = this.pending.get(message.request_id);
    if (!this.options.enabled || message.installation_id !== this.options.installationId ||
      !isApprovalId(message.request_id) || !isApprovalId(message.decision_id) ||
      !["allow", "deny", "computer"].includes(message.decision) || !request || request.settled || request.decision ||
      request.socket.destroyed || !this.options.isConnected() || this.now().getTime() >= Date.parse(request.expiresAt)) return false;
    request.decision = message;
    try {
      await new Promise<void>((resolve, reject) => {
        request.socket.write(`${JSON.stringify({
          type: "approval_decision", request_id: message.request_id, decision_id: message.decision_id, decision: message.decision,
        })}\n`, (error) => error ? reject(error) : resolve());
      });
      return true;
    } catch {
      await this.finish(request, "unknown");
      return false;
    }
  }

  private finish(request: HeldApproval, status: "approved" | "denied" | "unknown"): Promise<void> {
    if (request.finished) return request.finished;
    request.settled = true;
    request.finalStatus = status;
    // Let Claude read the returned output and proceed immediately. A remote
    // outbox backlog must never keep a completed hook process alive.
    request.socket.end();
    if (status === "unknown") this.remove(request);
    request.finished = (async () => {
      try {
      await request.published.catch(() => undefined);
      const resolved = await this.options.emit({
        ...request.event,
        event_type: "approval_resolved",
        occurred_at: this.now().toISOString(),
        payload: {
          request_id: request.requestId,
          source: "claude_code",
          status,
          can_respond: false,
          expires_at: request.expiresAt,
          ...(request.event.payload.tool_name ? { tool_name: request.event.payload.tool_name } : {}),
        },
      });
      request.resolvedEventId = resolved.event_id;
      // Keep a proven, claimed finishing invocation advertised until its
      // terminal event ACK. Other requests may publish presence concurrently.
      this.publishPresence();
      await this.options.flush();
      } catch {
        this.remove(request);
      }
    })();
    this.finishing.add(request.finished);
    void request.finished.finally(() => this.finishing.delete(request.finished!));
    return request.finished;
  }

  async expireAll(): Promise<void> {
    await Promise.all([...this.pending.values()].map((request) => {
      if (request.settled) {
        this.remove(request);
        return request.finished;
      }
      return this.finish(request, "unknown");
    }));
    // Unknown fallbacks are removed from the authority map before their
    // sequence/outbox writes finish. They must still drain during shutdown.
    while (this.finishing.size > 0) await Promise.all([...this.finishing]);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.expireAll();
  }
}
