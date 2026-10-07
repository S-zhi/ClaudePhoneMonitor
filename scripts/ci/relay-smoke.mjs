import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const positive = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function stop(child) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  let graceTimer;
  try { await Promise.race([child.finished, new Promise((done) => { graceTimer = setTimeout(done, 500); })]); }
  finally { clearTimeout(graceTimer); }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  let killTimer;
  try { await Promise.race([child.finished, new Promise((_, reject) => { killTimer = setTimeout(() => reject(new Error("child did not exit after SIGKILL")), 2000); })]); }
  finally { clearTimeout(killTimer); }
}

// Options are for fault-injection regression tests; CLI always runs the compiled relay.
export async function runSmoke(options = {}) {
  const timeoutMs = positive(options.timeoutMs ?? process.env.RELAY_SMOKE_TIMEOUT_MS, 45000);
  const temp = await mkdtemp(join(tmpdir(), 'relay-smoke-'));
  options.onTemp?.(temp);
  const report = options.reportDir ?? join(root, 'reports/relay-smoke', `${Date.now()}-${randomBytes(4).toString('hex')}`);
  const secret = randomBytes(32).toString('hex');
  const children = [];
  const logs = [];
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error('relay smoke deadline exceeded')), timeoutMs);
  const cancel = () => controller.abort(new Error('relay smoke cancelled'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const externalCancel = () => controller.abort(options.signal.reason ?? new Error('relay smoke cancelled'));
  options.signal?.addEventListener('abort', externalCancel, { once: true });
  if (options.signal?.aborted) externalCancel();
  function launch(args, env, label) {
    controller.signal.throwIfAborted();
    // node:test sets this for its children; an independent test runner must not inherit it.
    const childEnv = { ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, args, { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child.finished = new Promise((done) => {
      child.once('error', (error) => { logs.push(`${label}: ${error.message}\n`); done({ code: -1 }); });
      child.once('close', (code, signal) => done({ code, signal }));
    });
    child.output = { label, stdout: [], stderr: [] };
    for (const name of ['stdout', 'stderr']) {
      child[name].on('data', (data) => child.output[name].push(Buffer.from(data)));
    }
    children.push(child);
    options.onChild?.(child.pid);
    return child;
  }
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  // Keep rejection handled even if failure occurs before a race is reached.
  aborted.catch(() => {});
  try {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const env = { ...process.env, RELAY_HOST: '127.0.0.1', RELAY_PORT: String(port), RELAY_PUBLIC_URL: base,
      RELAY_DB_PATH: join(temp, 'relay.sqlite'), RELAY_AUTH_MODE: 'paired', RELAY_BOOTSTRAP_SECRET: secret };
    const relay = launch([options.relayEntry ?? 'services/relay/dist/src/index.js'], env, 'relay');
    const startup = async () => {
      for (;;) {
        controller.signal.throwIfAborted();
        if (relay.exitCode !== null || relay.signalCode !== null) throw new Error('compiled relay exited during startup');
        let health;
        try {
          const response = await fetch(`${base}/healthz`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]) });
          assert.equal(response.status, 200);
          health = await response.json();
        } catch {
          controller.signal.throwIfAborted();
          await new Promise((done) => setTimeout(done, 50));
          continue;
        }
        assert.equal(health.service, 'relay');
        assert.equal(health.status, 'ok');
        assert.equal(health.auth?.mode, 'paired');
        assert.equal(health.storage, 'sqlite');
        const ready = await fetch(`${base}/readyz`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]) });
        assert.equal(ready.status, 200);
        const body = await ready.json();
        assert.equal(body.status, 'ready');
        assert.equal(body.service, 'relay');
        assert.equal(body.storage, 'sqlite');
        return;
      }
    };
    await Promise.race([startup(), aborted, relay.finished.then(() => { throw new Error('compiled relay exited during startup'); })]);
    // One direct test process owns every socket; cancellation cannot orphan file workers.
    const tests = launch(['--test', '--test-isolation=none', '--test-reporter=tap', 'tests/real-lan-contract.test.mjs'], {
      ...env, RELAY_REQUIRE_LIVE: "1", RELAY_BASE_URL: base, RELAY_BOOTSTRAP_SECRET: options.testSecret ?? secret,
      RELAY_TEST_TIMEOUT_MS: String(positive(options.testTimeoutMs, 2000)),
    }, 'contract');
    const result = await Promise.race([tests.finished, aborted, relay.finished.then(() => { throw new Error('compiled relay exited during contract'); })]);
    assert.equal(result.code, 0, 'live relay contract failed');
    const output = Buffer.concat(tests.output.stdout).toString('utf8');
    assert.match(output, /ok \d+ - approved real-LAN pairing, role tokens, event snapshots, redaction, and resume/);
    assert.match(output, /# skipped 0\b/, 'required live contract must not skip');
    logs.push('smoke: passed paired SQLite compiled relay contract\n');
    return { reportDir: report };
  } catch (error) {
    logs.push(`smoke: ${error.message}\n`);
    throw error;
  } finally {
    controller.abort(new Error('relay smoke cleanup'));
    clearTimeout(deadline);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    options.signal?.removeEventListener('abort', externalCancel);
    const cleanup = await Promise.allSettled(children.map(stop));
    const completeStreams = children.flatMap((child) => ['stdout', 'stderr'].map((name) =>
      `${child.output.label} ${name}:\n${Buffer.concat(child.output[name]).toString('utf8')}\n`,
    ));
    const sanitized = [...completeStreams, ...logs].join('').replaceAll(secret, '[REDACTED]').replaceAll(options.testSecret ?? secret, '[REDACTED]')
      .replace(/(?:Bearer\s+)[^\s"']+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:col|and)_[A-Za-z0-9_-]{43}\b/g, '[REDACTED]')
      .replace(/("(?:collector_token|android_token|bootstrap_secret|token|code)"\s*:\s*")[^"]*/g, '$1[REDACTED]');
    try {
      await mkdir(report, { recursive: true });
      await writeFile(join(report, 'smoke.log'), sanitized);
    }
    finally { await rm(temp, { recursive: true, force: true }); }
    for (const result of cleanup) if (result.status === "rejected") throw result.reason;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await runSmoke(); console.log(`Relay smoke passed. Logs: ${result.reportDir}`); }
  catch { console.error('Relay smoke failed; sanitized logs are under reports/relay-smoke.'); process.exitCode = 1; }
}
