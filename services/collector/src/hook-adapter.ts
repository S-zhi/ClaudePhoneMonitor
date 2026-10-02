import { stdin } from "node:process";
import { normalizeHookEvent } from "./normalize.js";
import { sendUnixSocketPayload } from "./socket.js";

export interface HookAdapterOptions {
  socketPath: string;
  input?: AsyncIterable<Uint8Array | string>;
  maxInputBytes?: number;
  socketTimeoutMs?: number;
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
 * Claude hook entrypoint. It only talks to the local Unix socket and is
 * intentionally fail-open: every parse, normalization, and delivery error is
 * swallowed so a telemetry outage cannot affect the user's Claude command.
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
