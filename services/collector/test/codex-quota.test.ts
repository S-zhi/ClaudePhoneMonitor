import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseCodexRateLimits, readCodexQuota } from "../src/codex-quota.js";

const now = Date.parse("2030-01-01T00:00:00.000Z");
const reset = Math.floor(now / 1000) + 86_400;
const window = (usedPercent: number, resetsAt = reset) => ({ usedPercent, windowDurationMins: 10_080, resetsAt });

test("Codex rate limits select only the codex bucket and prefer a valid primary window", () => {
  const parsed = parseCodexRateLimits({
    accountId: "private-account-id",
    rateLimitsByLimitId: {
      other: { primary: window(1) },
      codex: { primary: window(52.5), secondary: window(90) },
    },
  }, now);
  assert.deepEqual({ ...parsed, account_key: undefined }, {
    used_percent: 52.5, reset_at: new Date(reset * 1000).toISOString(), window_minutes: 10_080,
    window: "primary", sampled_at: new Date(now).toISOString(), account_key: undefined,
  });
  assert.match(parsed?.account_key ?? "", /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(parsed).includes("private-account-id"), false);
  const appServerDto = parseCodexRateLimits({
    accountId: "another-private-account",
    rateLimits: { rateLimitsByLimitId: [
      { limitId: "codex", primary: window(18), secondary: window(71) },
      { limitId: "other", primary: window(4) },
    ] },
  }, now);
  assert.equal(appServerDto?.used_percent, 18);
  assert.match(appServerDto?.account_key ?? "", /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(appServerDto).includes("another-private-account"), false);
  assert.equal(parseCodexRateLimits({ rateLimitsByLimitId: { other: { primary: window(2) } } }, now), undefined);
  assert.equal(parseCodexRateLimits({ rateLimitsByLimitId: { codex: { primary: window(1, Math.floor(now / 1000) - 1), secondary: window(60) }, other: { primary: window(10) } } }, now)?.window, "secondary");
  assert.equal(parseCodexRateLimits({ rateLimitsByLimitId: { codex: { primary: null, secondary: null }, other: { primary: window(10) } } }, now), undefined);
  assert.equal(parseCodexRateLimits({ limitId: "codex", primary: window(33) }, now)?.used_percent, 33, "explicitly labeled legacy codex buckets remain supported");
  assert.equal(parseCodexRateLimits({ rateLimitsByLimitId: { codex: { primary: window(100.1) } } }, now), undefined);
  assert.equal(parseCodexRateLimits({ rateLimitsByLimitId: { codex: { primary: window(50, Number.MAX_SAFE_INTEGER) } } }, now), undefined, "unrepresentable reset dates are rejected without throwing");
});

async function fakeCodex(t: { after(fn: () => void | Promise<void>): void }, behavior: "normal" | "failure" | "oversize" | "silent" | "delayed" = "normal") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fake-codex-quota-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scriptPath = path.join(directory, "codex-fake");
  const logPath = path.join(directory, "requests.jsonl");
  const result = JSON.stringify({
    accountId: "fake-account",
    rateLimitsByLimitId: { codex: { primary: window(12.25) } },
  });
  const responseDelayMs = behavior === "delayed" ? 5_200 : 0;
  const script = `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nimport readline from 'node:readline';\nconst log = ${JSON.stringify(logPath)};\nconst mode = ${JSON.stringify(behavior)};\nconst delayMs = ${responseDelayMs};\nif (delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);\nif (mode === 'oversize') { process.stdout.write('x'.repeat(300000) + '\\n'); process.stdin.resume(); }\nelse if (mode === 'silent') process.stdin.resume();\nelse readline.createInterface({ input: process.stdin }).on('line', (line) => {\n const request = JSON.parse(line); appendFileSync(log, request.method + '\\n');\n if (request.id === 1) process.stdout.write(JSON.stringify(mode === 'failure' ? { jsonrpc:'2.0', id:1, error:{code:-1,message:'fixed'} } : {jsonrpc:'2.0',id:1,result:{}}) + '\\n');\n if (request.id === 2) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:2,result:${result}}) + '\\n');\n});\n`;
  await writeFile(scriptPath, script, { mode: 0o700 });
  await chmod(scriptPath, 0o700);
  return { scriptPath, logPath };
}

test("app-server quota reader performs only the read-only handshake and rate-limits request", async (t) => {
  const fake = await fakeCodex(t);
  const sample = await readCodexQuota(fake.scriptPath, now);
  assert.equal(sample?.used_percent, 12.25);
  assert.equal(sample?.window, "primary");
  assert.notEqual(sample?.account_key, "fake-account");
  const requests = (await readFile(fake.logPath, "utf8")).trim().split("\n");
  assert.deepEqual(requests, ["initialize", "initialized", "account/rateLimits/read"]);
  assert.equal(requests.some((method) => method.includes("thread") || method.includes("turn") || method.includes("model")), false);
});

test("default app-server timeout allows quota reads that take longer than five seconds", async (t) => {
  const fake = await fakeCodex(t, "delayed");
  const sample = await readCodexQuota(fake.scriptPath, now);
  assert.equal(sample?.used_percent, 12.25);
});

test("app-server failures, missing executables, bounded output, and timeout fail closed", async (t) => {
  const failure = await fakeCodex(t, "failure");
  assert.equal(await readCodexQuota(failure.scriptPath, now), undefined);
  assert.equal(await readCodexQuota(path.join(os.tmpdir(), "missing-codex-binary"), now, 100), undefined);
  const oversize = await fakeCodex(t, "oversize");
  assert.equal(await readCodexQuota(oversize.scriptPath, now, 500), undefined);
  const silent = await fakeCodex(t, "silent");
  assert.equal(await readCodexQuota(silent.scriptPath, now, 25), undefined);
});
