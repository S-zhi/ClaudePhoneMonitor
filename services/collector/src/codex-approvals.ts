import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname } from "node:path";
import { codexIdentityHash, codexSessionId, codexTaskId } from "./codex-normalizer.js";
import type { EventAckMessage, EventEnvelope, NormalizedHookEvent } from "./types.js";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_REQUESTS = 128;
const METHODS = new Map([
  ["item/commandExecution/requestApproval", "Bash"],
  ["item/fileChange/requestApproval", "Edit"],
  ["item/permissions/requestApproval", "request_permissions"],
]);
type JsonRecord = Record<string, unknown>;
interface RequestSlot { id?: string | number; method?: string; threadId?: string; turnId?: string; itemId?: string }
interface ThreadState { owner?: string; revision?: number; slots: RequestSlot[]; authoritative: boolean; discovering: boolean; checkedAt: number; snapshotAt: number }
interface ObservedRequest {
  requestId: string; nativeId: string | number; threadId: string; owner: string; turnId: string; tool: string;
  status: "pending" | "resolved" | "unknown"; requestedAt: string;
  pendingEventId?: string; terminalEventId?: string; acknowledged: boolean;
  finishing?: boolean;
}
interface PendingRpc { resolve: (value: JsonRecord) => void; reject: () => void; timer: NodeJS.Timeout }

export interface CodexApprovalObserverOptions {
  socketPath: string;
  getThreadIds: () => string[];
  emit: (event: NormalizedHookEvent) => Promise<EventEnvelope>;
  flush: () => Promise<void>;
  isRelayConnected: () => boolean;
  publishPresence: (requestIds: string[]) => void;
  now?: () => number;
  pollIntervalMs?: number;
  ownerCheckMs?: number;
  requestTimeoutMs?: number;
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}
function nativeId(value: unknown): value is string | number {
  return (typeof value === "number" && Number.isSafeInteger(value)) ||
    (typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value));
}
function clientId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(value); }
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }

/** Stable native identity, not an inferred command or a replay of a transcript. */
export function nativeApprovalRequestId(owner: string, threadId: string, turnId: string, id: string | number, itemId?: string): string {
  const bytes = createHash("sha256").update(JSON.stringify(["codex-desktop-pending-v1", owner, threadId.toLowerCase(), turnId.toLowerCase(), typeof id, id, itemId ?? null])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Drop all text and arguments immediately; preserve array positions for Immer patches. */
function requestSlot(value: unknown, threadId: string): RequestSlot | undefined {
  const item = record(value);
  if (!item || typeof item.method !== "string") return undefined;
  const params = record(item.params);
  if (!METHODS.has(item.method)) return nativeId(item.id) ? { id: item.id } : {};
  if (!nativeId(item.id) || !params || typeof params.threadId !== "string" ||
    params.threadId.toLowerCase() !== threadId || !codexIdentityHash(params.turnId) ||
    (params.itemId !== undefined && (typeof params.itemId !== "string" || !nativeId(params.itemId)))) return undefined;
  return { id: item.id, method: item.method, threadId, turnId: (params.turnId as string).toLowerCase(),
    ...(params.itemId !== undefined ? { itemId: params.itemId as string } : {}) };
}
function requestSlots(value: unknown, threadId: string): RequestSlot[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_REQUESTS) return undefined;
  const slots = value.map((item) => requestSlot(item, threadId));
  if (slots.some((slot) => slot === undefined)) return undefined;
  const ids = slots.filter((slot) => slot?.id !== undefined).map((slot) => JSON.stringify(slot!.id));
  return new Set(ids).size === ids.length ? slots as RequestSlot[] : undefined;
}

/** Apply only requests metadata. Non-request patches are never retained or forwarded. */
export function patchNativeApprovalSlots(current: RequestSlot[], patches: unknown, threadId: string): RequestSlot[] | undefined {
  if (!Array.isArray(patches) || patches.length > 10_000) return undefined;
  let slots = current.map((slot) => ({ ...slot }));
  for (const value of patches) {
    const patch = record(value);
    if (!patch || !["add", "remove", "replace"].includes(String(patch.op)) || !Array.isArray(patch.path)) return undefined;
    const path = patch.path;
    if (path.length === 0) {
      const root = record(patch.value);
      const next = root?.id === threadId && requestSlots(root.requests, threadId);
      if (!next || patch.op === "remove") return undefined;
      slots = next;
      continue;
    }
    if (path[0] !== "requests") continue;
    if (path.length === 1) {
      const next = patch.op === "remove" ? [] : requestSlots(patch.value, threadId);
      if (!next) return undefined;
      slots = next;
      continue;
    }
    const index = path[1];
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > slots.length) return undefined;
    const i = index as number;
    if (path.length === 2) {
      if (patch.op === "remove") {
        if (i >= slots.length) return undefined;
        slots.splice(i, 1);
      } else {
        const next = requestSlot(patch.value, threadId);
        if (!next || (patch.op === "replace" && i >= slots.length)) return undefined;
        if (patch.op === "add") slots.splice(i, 0, next); else slots[i] = next;
      }
    } else {
      if (i >= slots.length) return undefined;
      const slot = slots[i]!;
      if (path.length === 3 && path[2] === "params") {
        const params = record(patch.value);
        if (patch.op === "remove" || params?.threadId !== slot.threadId || params?.turnId !== slot.turnId || params?.itemId !== slot.itemId) return undefined;
        continue;
      }
      const field = path.length === 3 ? path[2] : path.length === 4 && path[2] === "params" ? path[3] : undefined;
      if (!["id", "method", "threadId", "turnId", "itemId"].includes(String(field))) continue;
      // In-place identity edits cannot be interpreted as a answered prompt.
      const key = field as keyof RequestSlot;
      if (patch.op === "remove" || patch.value !== slot[key]) return undefined;
    }
    if (slots.length > MAX_REQUESTS) return undefined;
  }
  return slots;
}

function slotWire(slot: RequestSlot): JsonRecord {
  return { ...(slot.id !== undefined ? { id: slot.id } : {}), method: slot.method ?? "other",
    params: { threadId: slot.threadId, turnId: slot.turnId, ...(slot.itemId !== undefined ? { itemId: slot.itemId } : {}) } };
}
function safePatches(value: unknown, threadId: string): unknown[] | undefined {
  if (!Array.isArray(value) || value.length > 10_000) return undefined;
  const patches: JsonRecord[] = [];
  for (const raw of value) {
    const patch = record(raw);
    if (!patch || !["add", "remove", "replace"].includes(String(patch.op)) || !Array.isArray(patch.path)) return undefined;
    const path = patch.path;
    if (path.length !== 0 && path[0] !== "requests") continue;
    const safe: JsonRecord = { op: patch.op, path: [...path] };
    if (patch.op !== "remove") {
      if (path.length === 0) {
        const root = record(patch.value);
        const slots = root?.id === threadId ? requestSlots(root.requests, threadId) : undefined;
        if (!slots) return undefined;
        safe.value = { id: threadId, requests: slots.map(slotWire) };
      } else if (path.length === 1) {
        const slots = requestSlots(patch.value, threadId);
        if (!slots) return undefined;
        safe.value = slots.map(slotWire);
      } else if (path.length === 2) {
        const slot = requestSlot(patch.value, threadId);
        if (!slot) return undefined;
        safe.value = slotWire(slot);
      } else if (path.length === 3 && path[2] === "params") {
        const params = record(patch.value);
        if (!params || !codexIdentityHash(params.threadId) || !codexIdentityHash(params.turnId)) return undefined;
        if (params.itemId !== undefined && (typeof params.itemId !== "string" || !nativeId(params.itemId))) return undefined;
        safe.value = { threadId: params.threadId, turnId: params.turnId, ...(params.itemId !== undefined ? { itemId: params.itemId } : {}) };
      } else {
        const field = path.length === 3 ? path[2] : path.length === 4 && path[2] === "params" ? path[3] : undefined;
        if (!["id", "method", "threadId", "turnId", "itemId"].includes(String(field))) continue;
        // Even malformed fields must not retain arbitrary native text in a queued closure.
        if (field === "id" || field === "itemId" ? !nativeId(patch.value) : field === "method" ? !METHODS.has(String(patch.value)) : !codexIdentityHash(patch.value)) return undefined;
        safe.value = patch.value;
      }
    }
    patches.push(safe);
  }
  return patches;
}

/**
 * Read-only follower of the already running desktop router. It never claims
 * ownership, resumes a thread, creates a server, or responds to an approval.
 * Desktop IPC is versioned but private: incompatible frames fail to unknown.
 */
export class CodexApprovalObserver {
  private socket?: Socket;
  private client?: string;
  private buffer: Buffer = Buffer.alloc(0);
  private running = false;
  private connecting = false;
  private timer?: NodeJS.Timeout;
  private generation = 0;
  private operation: Promise<void> = Promise.resolve();
  private readonly threads = new Map<string, ThreadState>();
  private readonly observed = new Map<string, ObservedRequest>();
  private readonly rpcs = new Map<string, PendingRpc>();
  private readonly now: () => number;
  private diagnostic = "codex_approval_ipc_unavailable";

  constructor(private readonly options: CodexApprovalObserverOptions) { this.now = options.now ?? Date.now; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => { void this.poll(); }, this.options.pollIntervalMs ?? 1_000);
    this.timer.unref();
    void this.poll();
  }
  getDiagnostics(): Readonly<{ codes: string[] }> { return { codes: this.diagnostic ? [this.diagnostic] : [] }; }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.operation.then(work);
    this.operation = next.catch(() => { this.diagnostic = "codex_approval_emit_failed"; });
    return next;
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    if (!this.socket && !this.connecting) { await this.connect(); return; }
    if (!this.client) return;
    const active = new Set(this.options.getThreadIds().slice(0, MAX_REQUESTS).filter((id) => codexIdentityHash(id)).map((id) => id.toLowerCase()));
    for (const [id, thread] of this.threads) {
      if (!active.has(id) && ![...this.observed.values()].some((item) => item.threadId === id && item.status === "pending")) {
        this.follow(id, thread, false);
        this.threads.delete(id);
      }
    }
    for (const id of active) {
      if (!codexIdentityHash(id)) continue;
      const threadId = id.toLowerCase();
      if (!this.threads.has(threadId)) this.threads.set(threadId, { slots: [], authoritative: false, discovering: false, checkedAt: 0, snapshotAt: 0 });
    }
    // Completed JSONL sessions do not retire an independently live native request.
    for (const [threadId, thread] of this.threads) {
      if (thread.discovering || this.now() - thread.checkedAt < (this.options.ownerCheckMs ?? 5_000)) continue;
      thread.discovering = true;
      thread.checkedAt = this.now();
      const generation = this.generation;
      void this.discover(threadId, thread, generation).finally(() => { thread.discovering = false; });
    }
  }

  private async connect(): Promise<void> {
    this.connecting = true;
    try {
      const uid = process.getuid?.();
      const [socketStat, parent] = await Promise.all([fs.lstat(this.options.socketPath), fs.lstat(dirname(this.options.socketPath))]);
      if (uid === undefined || !socketStat.isSocket() || socketStat.isSymbolicLink() || socketStat.uid !== uid ||
        (socketStat.mode & 0o077) !== 0 || !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o077) !== 0) return;
      if (!this.running) return;
      const socket = createConnection(this.options.socketPath);
      this.socket = socket;
      const generation = ++this.generation;
      socket.on("data", (bytes: Buffer) => this.read(bytes, generation));
      socket.on("error", () => { socket.destroy(); });
      socket.on("close", () => this.closed(socket));
      socket.once("connect", () => {
        void this.rpc("initialize", { clientType: "desktop" }, 0).then((response) => {
          const result = record(response.result);
          if (this.generation !== generation || response.resultType !== "success" || !clientId(result?.clientId)) { socket.destroy(); return; }
          this.client = result.clientId;
          this.diagnostic = "";
          void this.poll();
        }, () => socket.destroy());
      });
    } catch { this.diagnostic = "codex_approval_ipc_unavailable"; }
    finally { this.connecting = false; }
  }

  private send(message: JsonRecord): boolean {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return false;
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(body.length);
    try { this.socket.write(Buffer.concat([prefix, body])); return true; } catch { return false; }
  }
  private rpc(method: "initialize" | "thread-owner-discovery", params: JsonRecord, version = 1): Promise<JsonRecord> {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => { this.rpcs.delete(requestId); reject(new Error("codex_approval_ipc_timeout")); }, this.options.requestTimeoutMs ?? 3_000);
      timer.unref();
      this.rpcs.set(requestId, { resolve, reject: () => reject(new Error("codex_approval_ipc_unavailable")), timer });
      if (!this.send({ type: "request", requestId, sourceClientId: this.client ?? "initializing-client", version, method, params })) {
        clearTimeout(timer); this.rpcs.delete(requestId); reject(new Error("codex_approval_ipc_unavailable"));
      }
    });
  }

  private async discover(threadId: string, thread: ThreadState, generation: number): Promise<void> {
    try {
      const response = await this.rpc("thread-owner-discovery", { hostId: "local", conversationId: threadId });
      if (!this.running || generation !== this.generation) return;
      if (response.resultType !== "success" || !clientId(response.handledByClientId)) {
        await this.enqueue(() => this.invalidate(threadId)); return;
      }
      const owner = response.handledByClientId;
      if (thread.owner !== owner) {
        await this.enqueue(() => this.invalidate(threadId));
        thread.owner = owner;
        thread.revision = undefined;
        thread.snapshotAt = 0;
      }
      if (!thread.authoritative) this.follow(threadId, thread, true);
    } catch {
      if (generation === this.generation) await this.enqueue(() => this.invalidate(threadId)).catch(() => undefined);
    }
  }
  private follow(threadId: string, thread: ThreadState, following: boolean): void {
    if (!this.client || !thread.owner) return;
    if (following && this.now() - thread.snapshotAt < (this.options.ownerCheckMs ?? 5_000)) return;
    thread.snapshotAt = this.now();
    this.send({ type: "broadcast", method: "thread-stream-following-changed", version: 1,
      sourceClientId: this.client, targetClientIds: [thread.owner], params: { conversationId: threadId, hostId: "local", following } });
  }

  private read(bytes: Buffer, generation: number): void {
    if (generation !== this.generation) return;
    this.buffer = Buffer.concat([this.buffer, bytes]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE(0);
      if (size === 0 || size > MAX_FRAME_BYTES) { this.socket?.destroy(); return; }
      if (this.buffer.length < size + 4) return;
      const body = this.buffer.subarray(4, size + 4);
      this.buffer = this.buffer.subarray(size + 4);
      let message: JsonRecord | undefined;
      try { message = record(JSON.parse(body.toString("utf8"))); } catch { this.socket?.destroy(); return; }
      if (message) this.message(message, generation);
    }
  }

  private message(message: JsonRecord, generation: number): void {
    if (message.type === "response" && typeof message.requestId === "string") {
      const rpc = this.rpcs.get(message.requestId);
      if (rpc) { clearTimeout(rpc.timer); this.rpcs.delete(message.requestId); rpc.resolve(message); }
      return;
    }
    if (message.type === "client-discovery-request" && typeof message.requestId === "string" && this.client) {
      this.send({ type: "client-discovery-response", requestId: message.requestId, sourceClientId: this.client, response: { canHandle: false } });
      return;
    }
    if (!this.client || message.type !== "broadcast") return;
    const params = record(message.params);
    if (message.method === "ipc-connection-reset") { this.socket?.destroy(); return; }
    if (message.method === "client-status-changed") {
      // Re-discover without assuming which private client-status fields remain stable.
      for (const thread of this.threads.values()) thread.checkedAt = 0;
      return;
    }
    if (message.method !== "thread-stream-state-changed" || !params || params.hostId !== "local" || typeof params.conversationId !== "string") return;
    const threadId = params.conversationId.toLowerCase();
    const thread = this.threads.get(threadId);
    if (!thread?.owner || message.sourceClientId !== thread.owner ||
      (message.targetClientIds !== undefined && (!Array.isArray(message.targetClientIds) || !message.targetClientIds.includes(this.client)))) return;
    const rawChange = record(params.change);
    const incomingRevision = rawChange?.revision;
    const incomingType = rawChange?.type;
    const baseRevision = rawChange?.baseRevision;
    const source = message.sourceClientId;
    const version = message.version;
    const nativeState = record(rawChange?.conversationState);
    // Queue only the projection; conversation messages, arguments, paths and questions die here.
    const snapshotSlots = incomingType === "snapshot" && nativeState?.id === threadId ? requestSlots(nativeState.requests, threadId) : undefined;
    const patches = incomingType === "patches" ? safePatches(rawChange?.patches, threadId) : undefined;
    void this.enqueue(async () => {
      if (generation !== this.generation || !this.running || source !== thread.owner) return;
      if (version !== 11 || !revision(incomingRevision)) { await this.invalidate(threadId); this.follow(threadId, thread, true); return; }
      let slots: RequestSlot[] | undefined;
      if (incomingType === "snapshot") {
        if (thread.revision !== undefined && (incomingRevision < thread.revision ||
          (incomingRevision === thread.revision && thread.authoritative))) return;
        slots = snapshotSlots;
      } else if (incomingType === "patches" && thread.authoritative && revision(baseRevision) && baseRevision === thread.revision && incomingRevision > baseRevision) {
        slots = patchNativeApprovalSlots(thread.slots, patches, threadId);
      }
      if (!slots) {
        thread.revision = Math.max(thread.revision ?? 0, incomingRevision);
        await this.invalidate(threadId); this.follow(threadId, thread, true); return;
      }
      await this.reconcile(threadId, thread, slots);
      thread.slots = slots;
      thread.revision = incomingRevision;
      thread.authoritative = true;
      this.diagnostic = "";
      this.publishPresence();
    }).catch(() => undefined);
  }

  private async reconcile(threadId: string, thread: ThreadState, slots: RequestSlot[]): Promise<void> {
    const present = new Set<string>();
    for (const slot of slots) {
      if (slot.id === undefined || !thread.owner) continue;
      if (!slot.method || !slot.turnId) {
        if ([...this.observed.values()].some((item) => item.threadId === threadId && item.owner === thread.owner && item.nativeId === slot.id && item.status === "pending")) {
          await this.invalidate(threadId); throw new Error("codex_approval_identity_changed");
        }
        continue;
      }
      const id = nativeApprovalRequestId(thread.owner, threadId, slot.turnId, slot.id, slot.itemId);
      present.add(id);
      let observed = this.observed.get(id);
      if (observed?.status === "resolved") continue;
      if (!observed) {
        observed = { requestId: id, nativeId: slot.id, threadId, owner: thread.owner, turnId: slot.turnId, tool: METHODS.get(slot.method)!, status: "unknown",
          requestedAt: new Date(this.now()).toISOString(), acknowledged: false };
        this.observed.set(id, observed);
      }
      if (observed.turnId !== slot.turnId || observed.tool !== METHODS.get(slot.method)) { await this.invalidate(threadId); throw new Error("codex_approval_identity_changed"); }
      if (observed.status !== "pending") {
        observed.status = "pending";
        observed.acknowledged = false;
        await this.emit(observed);
      }
    }
    if (thread.authoritative) for (const observed of this.observed.values()) {
      if (observed.threadId === threadId && observed.owner === thread.owner && observed.status === "pending" && !present.has(observed.requestId)) {
        observed.status = "resolved";
        observed.finishing = true;
        await this.emit(observed);
      }
    }
  }

  private async emit(observed: ObservedRequest): Promise<void> {
    const status = observed.status;
    let event: EventEnvelope;
    try { event = await this.options.emit({
      event_type: status === "pending" ? "approval_requested" : "approval_resolved",
      session_id: codexSessionId(codexIdentityHash(observed.threadId)!), task_id: codexTaskId(codexIdentityHash(observed.turnId)!),
      occurred_at: new Date(this.now()).toISOString(),
      payload: { request_id: observed.requestId, source: "codex", status, can_respond: false, tool_name: observed.tool },
    }); } catch (error) { observed.status = "unknown"; observed.acknowledged = false; observed.finishing = false; throw error; }
    if (status === "pending") observed.pendingEventId = event.event_id;
    else observed.terminalEventId = event.event_id;
    try { await this.options.flush(); } catch { /* Durable outbox retries independently of native observation. */ }
  }

  private async invalidate(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (thread) { thread.authoritative = false; thread.slots = []; }
    this.diagnostic = "codex_approval_status_unavailable";
    for (const observed of this.observed.values()) {
      if (observed.threadId !== threadId || observed.status !== "pending") continue;
      observed.status = "unknown";
      observed.acknowledged = false;
      await this.emit(observed);
    }
    this.publishPresence();
  }

  publishPresence(): void {
    if (!this.options.isRelayConnected()) return;
    this.options.publishPresence([...this.observed.values()].filter((observed) => {
      const thread = this.threads.get(observed.threadId);
      return observed.acknowledged && thread?.authoritative && thread.owner === observed.owner &&
        (observed.status === "pending" || (observed.status === "resolved" && observed.finishing));
    }).map((observed) => observed.requestId).slice(0, MAX_REQUESTS));
  }
  handleEventAck(message: EventAckMessage): void {
    if (message.status !== "accepted" && message.status !== "duplicate") return;
    for (const observed of this.observed.values()) {
      if (observed.pendingEventId === message.event_id && observed.status === "pending") observed.acknowledged = true;
      if (observed.terminalEventId === message.event_id) { observed.acknowledged = false; observed.terminalEventId = undefined; observed.finishing = false; }
    }
    this.publishPresence();
  }
  onRelayDisconnected(): void { for (const observed of this.observed.values()) observed.acknowledged = false; }
  onRelayReady(): void {
    void this.enqueue(async () => {
      for (const observed of this.observed.values()) {
        const thread = this.threads.get(observed.threadId);
        if (observed.status === "pending" && thread?.authoritative && thread.owner === observed.owner) await this.emit(observed);
      }
      this.publishPresence();
    }).catch(() => undefined);
  }

  private closed(socket: Socket): void {
    if (this.socket !== socket) return;
    this.socket = undefined; this.client = undefined; this.buffer = Buffer.alloc(0); ++this.generation;
    for (const rpc of this.rpcs.values()) { clearTimeout(rpc.timer); rpc.reject(); }
    this.rpcs.clear();
    for (const thread of this.threads.values()) { thread.checkedAt = 0; thread.snapshotAt = 0; }
    void this.enqueue(async () => { for (const id of this.threads.keys()) await this.invalidate(id); }).catch(() => undefined);
  }
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    for (const [id, thread] of this.threads) this.follow(id, thread, false);
    const socket = this.socket;
    if (socket && !socket.destroyed) await new Promise<void>((resolve) => { socket.once("close", resolve); socket.destroy(); });
    await this.operation;
  }
}
