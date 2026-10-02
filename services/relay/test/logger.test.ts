import { test } from "node:test";
import assert from "node:assert/strict";

import { JsonLogger, sanitizeForLog } from "../src/logger.js";

test("JSON logger omits sensitive values and preserves safe routing metadata", () => {
  const lines: string[] = [];
  const logger = new JsonLogger({ sink: (line) => lines.push(line) });
  logger.info("safe_event", {
    token: "do-not-log-token",
    pairing_code: "do-not-log-pairing-code",
    text: "private user text",
    message_type: "probe",
    gateway: "collector",
  });

  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.includes("do-not-log-token"), false);
  assert.equal(lines[0]?.includes("do-not-log-pairing-code"), false);
  assert.equal(lines[0]?.includes("private user text"), false);
  assert.equal(lines[0]?.includes('"message_type":"probe"'), true);
  assert.equal(lines[0]?.includes('"gateway":"collector"'), true);
  assert.deepEqual(sanitizeForLog({ payload: { text: "private" }, ok: true }), { ok: true });
});
