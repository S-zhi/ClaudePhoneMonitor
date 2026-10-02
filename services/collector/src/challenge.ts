import { createHmac } from "node:crypto";
import type { ChallengeAckMessage, ChallengeMessage } from "./types.js";

export interface ChallengeResponder {
  respond(probeId: string, nonce: string): Promise<ChallengeAckMessage> | ChallengeAckMessage;
}

const SAFE_CHALLENGE_PART = /^[A-Za-z0-9._:/+=-]{1,512}$/;

function safePart(value: unknown): value is string {
  return typeof value === "string" && SAFE_CHALLENGE_PART.test(value);
}

/** Echo-only responder used when the relay does not configure a shared secret. */
export class EchoChallengeResponder implements ChallengeResponder {
  public respond(probeId: string, nonce: string): ChallengeAckMessage {
    return { type: "challenge_ack", probe_id: probeId, nonce };
  }
}

/** Optional proof responder. The secret is only loaded by the relay process. */
export class HmacChallengeResponder implements ChallengeResponder {
  public constructor(private readonly secret: string) {
    if (!secret) throw new Error("challenge_secret_required");
  }

  public respond(probeId: string, nonce: string): ChallengeAckMessage {
    const signature = createHmac("sha256", this.secret)
      .update(`${probeId}:${nonce}`, "utf8")
      .digest("hex");
    return { type: "challenge_ack", probe_id: probeId, nonce, signature };
  }
}

export function challengeResponderFromSecret(secret?: string): ChallengeResponder {
  return secret ? new HmacChallengeResponder(secret) : new EchoChallengeResponder();
}

export async function respondToChallenge(
  message: Partial<ChallengeMessage>,
  responder: ChallengeResponder,
): Promise<ChallengeAckMessage | null> {
  if (!safePart(message.probe_id) || !safePart(message.nonce)) return null;
  return responder.respond(message.probe_id, message.nonce);
}

export function isChallengeMessage(value: unknown): value is ChallengeMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ChallengeMessage>;
  return message.type === "challenge" && safePart(message.probe_id) && safePart(message.nonce);
}
