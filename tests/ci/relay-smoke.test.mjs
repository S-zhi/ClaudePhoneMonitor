import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSmoke } from '../../scripts/ci/relay-smoke.mjs';

function assertDead(pids) {
  assert.ok(pids.length > 0, 'smoke must spawn a child');
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `child ${pid} leaked`);
}

test('startup failure finishes within deadline and reaps its child', { timeout: 8000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-smoke-regression-'));
  const pids = [];
  let temp;
  try {
    const entry = join(dir, 'failure.mjs');
    await writeFile(entry, 'process.exit(7);');
    const start = Date.now();
    await assert.rejects(runSmoke({ relayEntry: entry, reportDir: join(dir, 'report'), timeoutMs: 3000, onTemp: (path) => { temp = path; }, onChild: (pid) => pids.push(pid) }), /exited during startup/);
    assert.ok(Date.now() - start < 5000);
    assertDead(pids);
    await assert.rejects(access(temp), { code: "ENOENT" });
    assert.match(await readFile(join(dir, 'report/smoke.log'), 'utf8'), /exited during startup/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('auth failure finishes within deadline, reaps relay and contract, and sanitizes logs', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-smoke-regression-'));
  const pids = [];
  let temp;
  try {
    const start = Date.now();
    const secret = 'regression-wrong-bootstrap-secret';
    await assert.rejects(runSmoke({ reportDir: join(dir, 'report'), timeoutMs: 10000, testSecret: secret, testTimeoutMs: 1000, onTemp: (path) => { temp = path; }, onChild: (pid) => pids.push(pid) }), /live relay contract failed/);
    assert.ok(Date.now() - start < 12000);
    assert.equal(pids.length, 2);
    assertDead(pids);
    await assert.rejects(access(temp), { code: "ENOENT" });
    const log = await readFile(join(dir, 'report/smoke.log'), 'utf8');
    assert.equal(log.includes(secret), false);
    assert.match(log, /live relay contract failed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('deadline kills a relay that never becomes ready', { timeout: 6000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-smoke-regression-'));
  const pids = [];
  let temp;
  try {
    const entry = join(dir, 'hung.mjs');
    await writeFile(entry, 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
    await assert.rejects(runSmoke({ relayEntry: entry, reportDir: join(dir, 'report'), timeoutMs: 500, onTemp: (path) => { temp = path; }, onChild: (pid) => pids.push(pid) }), /deadline exceeded/);
    assertDead(pids);
    await assert.rejects(access(temp), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancellation reaps an unready child and removes its database directory', { timeout: 6000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-smoke-regression-'));
  const pids = [];
  let temp;
  const controller = new AbortController();
  try {
    const entry = join(dir, 'cancelled.mjs');
    await writeFile(entry, 'setInterval(() => {}, 1000);');
    await assert.rejects(runSmoke({ relayEntry: entry, reportDir: join(dir, 'report'), timeoutMs: 3000,
      signal: controller.signal, onTemp: (path) => { temp = path; },
      onChild: (pid) => { pids.push(pid); controller.abort(new Error('regression cancellation')); },
    }), /regression cancellation/);
    assertDead(pids);
    await assert.rejects(access(temp), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('split pipe writes preserve complete text and redact secrets across chunks', { timeout: 8000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-smoke-regression-'));
  const pids = [];
  let temp;
  try {
    const entry = join(dir, 'chunked.mjs');
    const token = `col_${'A'.repeat(43)}`;
    await writeFile(entry, `
      const token = ${JSON.stringify(token)};
      const output = Buffer.from(JSON.stringify({ token, secret: process.env.RELAY_BOOTSTRAP_SECRET, text: '你好' }) + '\\n');
      const split = output.indexOf(Buffer.from('你好')) + 1;
      process.stdout.write(output.subarray(0, 20));
      setTimeout(() => {
        process.stdout.write(output.subarray(20, split));
        process.stderr.write(token.slice(0, 15));
        setTimeout(() => {
          process.stdout.write(output.subarray(split));
          process.stderr.write(token.slice(15) + '\\n', () => process.exit(7));
        }, 20);
      }, 20);
    `);
    await assert.rejects(runSmoke({ relayEntry: entry, reportDir: join(dir, 'report'), timeoutMs: 3000,
      onTemp: (path) => { temp = path; }, onChild: (pid) => pids.push(pid),
    }), /exited during startup/);
    const log = await readFile(join(dir, 'report/smoke.log'), 'utf8');
    assert.match(log, /relay stdout:\n\{"token":"\[REDACTED\]","secret":"\[REDACTED\]","text":"你好"\}/);
    assert.match(log, /relay stderr:\n\[REDACTED\]\n/);
    assert.equal(log.includes(token), false);
    assert.equal(log.includes(token.slice(0, 15)), false);
    assertDead(pids);
    await assert.rejects(access(temp), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
