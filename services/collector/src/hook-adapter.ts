import { randomUUID } from "node:crypto";
import net from "node:net";
import { stdin, stdout, stderr } from "node:process";
import { nativeInteractionReason, normalizeHookEvent } from "./normalize.js";
import { sendUnixSocketPayload } from "./socket.js";
import { APPROVAL_HOLD_MS } from "./approval.js";
import { isApprovalId, type NormalizedHookEvent } from "./types.js";

export interface HookAdapterOptions {
  socketPath: string;
  input?: AsyncIterable<Uint8Array | string>;
  maxInputBytes?: number;
  socketTimeoutMs?: number;
  approvalBridge?: boolean;
  approvalHoldMs?: number;
  /** Resolve only once the decision has been written to Claude's stdout. */
  writeOutput?: (text: string) => Promise<void>;
  writeLocalNotice?: (text: string) => void;
}

function writeClaudeOutput(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stdout.write(text, (error) => error ? reject(error) : resolve());
  });
}

/** The hook connects only to a private local Unix socket, even in bridge mode. */
async function holdApproval(options: HookAdapterOptions, event: NormalizedHookEvent): Promise<void> {
  const requestId = randomUUID();
  // Metadata only: successful-hook stderr may enter Claude's local debug
  // logs, so tool input, commands and paths must never be written here.
  (options.writeLocalNotice ?? ((text) => { stderr.write(text); }))(
    `Claude phone approval request ${requestId}\nTool: ${event.payload.tool_name ?? "unknown"}\nVerify the operation in the computer session before approving. If it cannot be identified, use Return to computer to continue native permission review.\n`,
  );
  const holdMs = Math.min(APPROVAL_HOLD_MS, Math.max(1, options.approvalHoldMs ?? APPROVAL_HOLD_MS));
  await new Promise<void>((resolve) => {
    const socket = net.createConnection({ path: options.socketPath });
    socket.setEncoding("utf8");
    let settled = false;
    let applying = false;
    let buffer = "";
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(connectTimer);
      socket.destroy();
      resolve();
    };
    const timer = setTimeout(settle, holdMs);
    const connectTimer = setTimeout(settle, Math.max(1, options.socketTimeoutMs ?? 250));
    socket.once("connect", () => {
      clearTimeout(connectTimer);
      socket.write(`${JSON.stringify({
        type: "approval_wait", request_id: requestId, session_id: event.session_id,
        ...(event.task_id ? { task_id: event.task_id } : {}),
        ...(event.payload.tool_name ? { tool_name: event.payload.tool_name } : {}),
      })}\n`);
    });
    socket.on("data", (chunk: string) => {
      if (settled || applying) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4_096) { settle(); return; }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let message: Record<string, unknown>;
      try { message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>; }
      catch { settle(); return; }
      if (!message || message.type !== "approval_decision" || message.request_id !== requestId ||
        !isApprovalId(message.decision_id) || !["allow", "deny", "computer"].includes(String(message.decision))) {
        settle(); return;
      }
      applying = true;
      void (async () => {
        try {
          if (settled || socket.destroyed) return;
          if (message.decision !== "computer") {
            await (options.writeOutput ?? writeClaudeOutput)(`${JSON.stringify({
              hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: message.decision } },
            })}\n`);
          }
          if (settled || socket.destroyed) return;
          // This acknowledgement cannot precede successfully writing the
          // actual Claude decision. Relay receipt alone is never resolution.
          socket.write(`${JSON.stringify({ type: "approval_applied", request_id: requestId, decision_id: message.decision_id })}\n`);
        } catch { settle(); }
      })();
    });
    socket.once("error", settle);
    socket.once("close", settle);
    socket.once("end", settle);
  });
}

async function readLimited(
  input: AsyncIterable<Uint8Array | string>,
  maxInputBytes: number,
): Promise<string> {
  const chunks: string[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > maxInputBytes) throw new Error("hook_input_too_large");
    chunks.push(text);
  }
  return chunks.join("");
}

/**
 * The default telemetry hook only talks to the local Unix socket, with a
 * 250 ms delivery limit and silent fallback. Explicit approval bridge mode
 * holds a real PermissionRequest for up to ten minutes; errors release it
 * without a decision so Claude resumes its normal permission flow.
 */
export async function runHookAdapter(options: HookAdapterOptions): Promise<boolean> {
  try {
    const maxInputBytes = Math.max(256, options.maxInputBytes ?? 256 * 1024);
    const input = options.input ?? (stdin as unknown as AsyncIterable<Uint8Array | string>);
    const text = await readLimited(input, maxInputBytes);
    if (!text.trim()) return true;

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return true;
    }
    const normalized = normalizeHookEvent(raw);
    if (!normalized) return true;

    if (options.approvalBridge && raw && typeof raw === "object" &&
      (raw as Record<string, unknown>).hook_event_name === "PermissionRequest" && normalized.session_id !== "unknown" &&
      !nativeInteractionReason(normalized.payload.tool_name)) {
      await holdApproval(options, normalized);
      return true;
    }

    // This is the only side effect in hook mode. sendUnixSocketPayload uses
    // node:net's `path` option and cannot make a remote network call.
    await sendUnixSocketPayload(options.socketPath, normalized, {
      timeoutMs: options.socketTimeoutMs ?? 250,
    });
    return true;
  } catch {
    return true;
  }
}

export const hookAdapter = runHookAdapter;
