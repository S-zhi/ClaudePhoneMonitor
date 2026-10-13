import { createHash } from "node:crypto";

const AGENT_ID = /^[a-z0-9._-]{1,64}$/;
const CODEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function safeAgentId(value: unknown): string | undefined {
  if (typeof value !== "string" || !AGENT_ID.test(value)) return undefined;
  return ["claude", "claude-code", "claude_code"].includes(value) ? "claude_code" : value;
}

export function agentSessionId(agentId: string, rawId: string): string {
  const canonical = safeAgentId(agentId);
  if (!canonical || !rawId) throw new Error("invalid_agent_identity");
  if (canonical === "codex" && CODEX_UUID.test(rawId)) {
    return `codex:sess:${createHash("sha256").update(rawId.toLowerCase()).digest("hex")}`;
  }
  return `agent_${createHash("sha256").update(`${canonical}:${rawId}`).digest("hex").slice(0, 32)}`;
}
