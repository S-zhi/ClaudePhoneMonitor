import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { createHash } from "node:crypto";

export interface CodexQuotaSample {
  used_percent: number;
  reset_at: string;
  window_minutes: number;
  window: "primary" | "secondary";
  sampled_at: string;
  account_key?: string;
}

export type CodexQuotaReader = (binary: string, nowMs: number, timeoutMs?: number) => Promise<CodexQuotaSample | undefined>;

const MAX_OUTPUT_BYTES = 256 * 1024;
const TIMEOUT_MS = 20_000;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validWindow(value: unknown, window: "primary" | "secondary", sampledAt: string, nowMs: number): CodexQuotaSample | undefined {
  if (!record(value)) return undefined;
  const used = value.usedPercent;
  const duration = value.windowDurationMins;
  const reset = value.resetsAt;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100 ||
      typeof duration !== "number" || !Number.isSafeInteger(duration) || duration <= 0 ||
      typeof reset !== "number" || !Number.isSafeInteger(reset) || reset <= nowMs / 1000 || reset > 8_640_000_000_000) return undefined;
  try { return { used_percent: used, reset_at: new Date(reset * 1000).toISOString(), window_minutes: duration, window, sampled_at: sampledAt }; }
  catch { return undefined; }
}

function codexLimit(value: unknown, sampledAt: string, nowMs: number, accountKey?: string): CodexQuotaSample | undefined {
  if (!record(value)) return undefined;
  // A present Codex limit is authoritative. Invalid Codex data must never fall back to another account/bucket.
  const sample = validWindow(value.primary, "primary", sampledAt, nowMs) ?? validWindow(value.secondary, "secondary", sampledAt, nowMs);
  return sample ? { ...sample, ...(accountKey ? { account_key: accountKey } : {}) } : undefined;
}

export function parseCodexRateLimits(result: unknown, nowMs: number, sampledAt = new Date(nowMs).toISOString()): CodexQuotaSample | undefined {
  if (!record(result)) return undefined;
  const limits = record(result.rateLimits) ? result.rateLimits : result;
  if (!record(limits)) return undefined;
  const accountId = typeof result.accountId === "string" ? result.accountId : undefined;
  const accountKey = accountId ? createHash("sha256").update(accountId).digest("hex") : undefined;
  const byId = limits.rateLimitsByLimitId ?? result.rateLimitsByLimitId;
  if (record(byId)) {
    if (!Object.hasOwn(byId, "codex")) return undefined;
    return codexLimit(byId.codex, sampledAt, nowMs, accountKey);
  }
  if (Array.isArray(byId)) {
    const codex = byId.find((item) => record(item) && item.limitId === "codex");
    return codex ? codexLimit(codex, sampledAt, nowMs, accountKey) : undefined;
  }
  // Legacy shape is accepted only when explicitly labeled codex.
  if (limits.limitId === "codex") return codexLimit(limits, sampledAt, nowMs, accountKey);
  return undefined;
}

/** Starts a read-only app-server, completes the public JSON-RPC handshake, and reads account rate limits. */
export const readCodexQuota: CodexQuotaReader = async (binary, nowMs, timeoutMs = TIMEOUT_MS) => new Promise((resolve) => {
  let child: ReturnType<typeof spawn>;
  try { child = spawn(binary, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "ignore"] }); }
  catch { resolve(undefined); return; }
  if (!child.stdin || !child.stdout) { child.kill(); resolve(undefined); return; }
  const stdin = child.stdin;
  const stdout = child.stdout;
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let outputBytes = 0;
  let settled = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let initialized = false;
  const sampledAt = new Date(nowMs).toISOString();
  const finish = (sample?: CodexQuotaSample) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 250);
      forceKillTimer.unref?.();
    }
    resolve(sample);
  };
  const timer = setTimeout(() => finish(), timeoutMs);
  child.once("error", () => finish());
  child.once("exit", () => { if (forceKillTimer) clearTimeout(forceKillTimer); finish(); });
  stdout.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT_BYTES) { finish(); return; }
    pending += decoder.write(chunk);
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try { message = JSON.parse(line); } catch { finish(); return; }
      if (!record(message)) continue;
      if (message.id === 1 && !initialized) {
        if (!Object.hasOwn(message, "result")) { finish(); return; }
        initialized = true;
        stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
        stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} })}\n`);
      } else if (message.id === 2) {
        finish(Object.hasOwn(message, "result") ? parseCodexRateLimits(message.result, nowMs, sampledAt) : undefined);
        return;
      }
    }
  });
  stdin.on("error", () => finish());
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "claude_phone_monitor_read_only", version: "0.1.0" }, capabilities: { experimentalApi: false } } })}\n`);
});
