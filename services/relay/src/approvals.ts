import type { RelayRepository } from "./repository.js";
import type { ApprovalDecisionAckMessage, ApprovalDecisionMessage, ApprovalSummary, EventEnvelope } from "./types.js";

const MAX_HOLD_MS = 10 * 60_000;
const TERMINAL_SNAPSHOT_MS = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOOL_NAMES = new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit", "WebFetch", "WebSearch", "Task", "TodoWrite", "AskUserQuestion", "ExitPlanMode", "Skill", "mcp", "request_permissions"]);

export interface ApprovalPayload {
  request_id: string;
  source: "claude_code" | "codex";
  status: ApprovalSummary["status"];
  can_respond: boolean;
  expires_at?: string;
  tool_name?: string;
}

export function isApprovalId(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }

export function parseApprovalPayload(value: unknown, eventType: EventEnvelope["event_type"]): ApprovalPayload | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).some((key) => !["request_id", "source", "status", "can_respond", "expires_at", "tool_name"].includes(key)) ||
    !isApprovalId(payload.request_id) || !["claude_code", "codex"].includes(String(payload.source)) || typeof payload.can_respond !== "boolean" ||
    (payload.tool_name !== undefined && (typeof payload.tool_name !== "string" || !TOOL_NAMES.has(payload.tool_name))) ||
    (payload.expires_at !== undefined && (typeof payload.expires_at !== "string" || !Number.isFinite(Date.parse(payload.expires_at))))) return undefined;
  if (payload.source === "codex" && (payload.can_respond !== false || payload.expires_at !== undefined ||
    !["pending", "resolved", "unknown"].includes(String(payload.status)))) return undefined;
  if (eventType === "approval_requested" && (payload.status !== "pending" || (payload.source === "claude_code" && typeof payload.expires_at !== "string"))) return undefined;
  if (eventType === "approval_resolved" && (!(payload.source === "codex" ? ["resolved", "unknown"] : ["approved", "denied", "unknown"]).includes(String(payload.status)) || payload.can_respond !== false)) return undefined;
  return payload as unknown as ApprovalPayload;
}

interface Owner { connectionId: string; active: boolean; decision?: ApprovalDecisionMessage }

export interface RelayApprovalsOptions {
  repository: RelayRepository;
  now: () => Date;
  ownerIsLive: (connectionId: string, installationId: string) => boolean;
  sendDecision: (connectionId: string, message: ApprovalDecisionMessage) => boolean;
}

/** Durable summaries and ephemeral socket authority deliberately have separate lifetimes. */
export class RelayApprovals {
  private readonly owners = new Map<string, Owner>();

  constructor(private readonly options: RelayApprovalsOptions) {
    for (const installationId of options.repository.listInstallationIds()) {
      for (const approval of options.repository.listApprovals(installationId)) {
        if (approval.status === "pending") options.repository.putApproval(installationId, { ...approval, status: "unknown", can_respond: false, resolved_at: options.now().toISOString() });
      }
    }
  }

  private key(installationId: string, requestId: string): string { return `${installationId}\u0000${requestId}`; }
  private find(installationId: string, requestId: string): ApprovalSummary | undefined {
    return this.options.repository.listApprovals(installationId).find((approval) => approval.request_id === requestId);
  }

  recordEvent(connectionId: string, event: EventEnvelope): boolean {
    const payload = parseApprovalPayload(event.payload, event.event_type);
    if (!payload) return false;
    const key = this.key(event.installation_id, payload.request_id);
    const existing = this.find(event.installation_id, payload.request_id);
    if (event.event_type === "approval_requested") {
      // A native owner can re-prove a pending request after losing observation.
      // Preserve its first identity/sequence so reconnect cannot renew the pin.
      if (existing) {
        if (existing.source !== "codex" || payload.source !== "codex" || existing.status !== "unknown" ||
          existing.session_id !== event.session_id || existing.task_id !== event.task_id ||
          !this.options.ownerIsLive(connectionId, event.installation_id)) return false;
        this.options.repository.putApproval(event.installation_id, { ...existing, status: "pending", resolved_at: undefined, can_respond: false });
        this.owners.set(key, { connectionId, active: false });
        return true;
      }
      const state = this.options.repository.getInstallationState(event.installation_id, this.options.now().toISOString());
      const session = state?.sessions?.find((session) => session.session_id === event.session_id);
      const task = state?.active_tasks?.find((task) => task.session_id === event.session_id);
      const expiresMs = Date.parse(payload.expires_at!);
      const validDeadline = payload.source === "codex" || (expiresMs > this.options.now().getTime() && expiresMs <= Date.parse(event.occurred_at) + MAX_HOLD_MS);
      const taskId = event.task_id ?? task?.task_id;
      this.options.repository.putApproval(event.installation_id, {
        request_id: payload.request_id, session_id: event.session_id,
        ...(taskId ? { task_id: taskId } : {}),
        display_name: session?.title ?? `会话 ${createHash("sha256").update(event.session_id).digest("hex").slice(-6)}`,
        sequence: event.sequence, requested_at: event.occurred_at,
        status: validDeadline ? "pending" : "unknown", source: payload.source, can_respond: false,
        ...(!validDeadline ? { resolved_at: this.options.now().toISOString() } : {}),
        ...(payload.expires_at ? { expires_at: payload.expires_at } : {}),
        ...(payload.tool_name ? { tool_name: payload.tool_name } : {}),
      });
      if (validDeadline) this.owners.set(key, { connectionId, active: false });
      return true;
    }
    if (!existing || existing.source !== payload.source || existing.status !== "pending" || existing.session_id !== event.session_id ||
      (existing.task_id && event.task_id && existing.task_id !== event.task_id)) return false;
    const owner = this.owners.get(key);
    if (!owner || owner.connectionId !== connectionId) return false;
    if (payload.source === "codex") {
      this.options.repository.putApproval(event.installation_id, { ...existing, status: payload.status, can_respond: false, resolved_at: this.options.now().toISOString() });
      this.owners.delete(key);
      return true;
    }
    // Receipt by Relay or the phone never proves a decision. A successful
    // result also requires that Relay forwarded a decision to this live owner.
    const expectedStatus = owner.decision?.decision === "allow" ? "approved" : owner.decision?.decision === "deny" ? "denied" : "unknown";
    const status = this.expired(existing) || (payload.status !== "unknown" && payload.status !== expectedStatus)
      ? "unknown" : payload.status;
    this.options.repository.putApproval(event.installation_id, { ...existing, status, can_respond: false, resolved_at: this.options.now().toISOString() });
    this.owners.delete(key);
    return true;
  }

  presence(connectionId: string, installationId: string, requestIds: unknown, source: unknown = "claude_code"): boolean {
    if (source !== "claude_code" && source !== "codex") return false;
    if (!Array.isArray(requestIds) || requestIds.length > 128 || !requestIds.every(isApprovalId) || new Set(requestIds).size !== requestIds.length) return false;
    const present = new Set(requestIds);
    for (const approval of this.options.repository.listApprovals(installationId)) {
      const key = this.key(installationId, approval.request_id);
      const owner = this.owners.get(key);
      if (!owner || owner.connectionId !== connectionId || approval.status !== "pending" || approval.source !== source) continue;
      if (this.expired(approval) || (owner.active && !present.has(approval.request_id))) this.invalidate(installationId, approval);
      else if (present.has(approval.request_id)) owner.active = true;
    }
    return true;
  }

  decide(connectionId: string, installationId: string, message: Record<string, unknown>, paired: boolean): ApprovalDecisionAckMessage {
    const ack = (reason: ApprovalDecisionAckMessage["reason"], accepted = false): ApprovalDecisionAckMessage => ({
      type: "approval_decision_ack", schema_version: 1,
      request_id: isApprovalId(message.request_id) ? message.request_id : "",
      decision_id: isApprovalId(message.decision_id) ? message.decision_id : "",
      accepted, reason,
    });
    if (!paired || message.installation_id !== installationId) return ack("forbidden");
    if (message.schema_version !== 1 || !isApprovalId(message.request_id) || !isApprovalId(message.decision_id) ||
      !["allow", "deny", "computer"].includes(String(message.decision)) ||
      Object.keys(message).some((key) => !["type", "schema_version", "installation_id", "request_id", "decision_id", "decision"].includes(key))) return ack("invalid_request");
    const approval = this.find(installationId, message.request_id);
    if (approval?.source === "codex") return ack("forbidden");
    const owner = this.owners.get(this.key(installationId, message.request_id));
    if (approval && approval.status !== "pending") return ack("already_decided");
    if (!approval || !owner || !owner.active) return ack("unavailable");
    if (this.expired(approval) || !this.options.ownerIsLive(owner.connectionId, installationId)) {
      if (approval.status === "pending") this.invalidate(installationId, approval);
      return ack("unavailable");
    }
    if (owner.decision) return owner.decision.decision_id === message.decision_id && owner.decision.decision === message.decision
      ? ack("forwarded", true) : ack("already_decided");
    const decision: ApprovalDecisionMessage = {
      type: "approval_decision", schema_version: 1, installation_id: installationId,
      request_id: message.request_id, decision_id: message.decision_id, decision: message.decision as "allow" | "deny" | "computer",
    };
    owner.decision = decision;
    if (!this.options.sendDecision(owner.connectionId, decision)) {
      this.invalidate(installationId, approval);
      return ack("unavailable");
    }
    // connectionId is intentionally not a routing field sent to Collector.
    void connectionId;
    return ack("forwarded", true);
  }

  private expired(approval: ApprovalSummary): boolean {
    if (approval.source === "codex") return false;
    return !approval.expires_at || Date.parse(approval.expires_at) <= this.options.now().getTime();
  }

  private invalidate(installationId: string, approval: ApprovalSummary): void {
    this.options.repository.putApproval(installationId, { ...approval, status: "unknown", can_respond: false, resolved_at: this.options.now().toISOString() });
    this.owners.delete(this.key(installationId, approval.request_id));
  }

  invalidateConnection(connectionId: string): void {
    for (const installationId of this.options.repository.listInstallationIds()) {
      for (const approval of this.options.repository.listApprovals(installationId)) {
        if (this.owners.get(this.key(installationId, approval.request_id))?.connectionId === connectionId) this.invalidate(installationId, approval);
      }
    }
  }

  refresh(): boolean {
    let changed = false;
    for (const installationId of this.options.repository.listInstallationIds()) {
      for (const approval of this.options.repository.listApprovals(installationId)) {
        if (approval.status !== "pending") continue;
        const owner = this.owners.get(this.key(installationId, approval.request_id));
        if (this.expired(approval) || (owner && !this.options.ownerIsLive(owner.connectionId, installationId))) {
          this.invalidate(installationId, approval);
          changed = true;
        }
      }
    }
    return changed;
  }

  snapshot(installationId: string): ApprovalSummary[] {
    this.refresh();
    const state = this.options.repository.getInstallationState(installationId, this.options.now().toISOString());
    return this.options.repository.listApprovals(installationId).filter((approval) => {
      if (approval.status === "pending") return approval.source !== "codex" || this.owners.get(this.key(installationId, approval.request_id))?.active === true;
      return this.options.now().getTime() - Date.parse(approval.resolved_at ?? approval.expires_at ?? approval.requested_at) < TERMINAL_SNAPSHOT_MS;
    }).map((approval) => {
      const owner = this.owners.get(this.key(installationId, approval.request_id));
      const title = state?.sessions?.find((session) => session.session_id === approval.session_id)?.title;
      return {
        ...approval,
        ...(title ? { display_name: title } : {}),
        can_respond: Boolean(approval.source === "claude_code" && approval.status === "pending" && owner?.active && !owner.decision &&
          !this.expired(approval) && this.options.ownerIsLive(owner.connectionId, installationId)),
      };
    }).sort((a, b) => a.sequence - b.sequence);
  }
}
import { createHash } from "node:crypto";
