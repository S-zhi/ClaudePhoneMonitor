import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startProbe } from '../probe.mjs';

test('reads only contiguous synthetic fixture rows and resumes cursor after restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'magpie-probe-'));
  const root = path.join(directory, 'monitor-plugin-probe');
  try {
    const first = await startProbe({ directory, intervalMs: 100 });
    await first.ready;
    assert.equal(first.role, 'writer');
    const standby = await startProbe({ directory, intervalMs: 100 });
    assert.equal(standby.role, 'standby');
    await appendFile(path.join(root, 'fixture.jsonl'), '{"probe":true,"sequence":1}\n');
    await new Promise((resolve) => setTimeout(resolve, 150));
    let state = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'));
    assert.equal(state.cursor, 1);
    assert.equal(state.processedCount, 1);
    assert.ok(state.tick >= 2);
    await standby.stop();
    await first.stop();

    const second = await startProbe({ directory, intervalMs: 100 });
    await second.ready;
    state = await second.getState();
    assert.equal(state.cursor, 1);
    assert.equal(state.processedCount, 1);
    assert.equal(state.resumedFrom.cursor, 1);
    await appendFile(path.join(root, 'fixture.jsonl'), '{"probe":true,"sequence":2}\n');
    await new Promise((resolve) => setTimeout(resolve, 150));
    state = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'));
    assert.equal(state.cursor, 2);
    assert.equal(state.processedCount, 2);
    await second.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('standby takes over once and stop halts future ticks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'magpie-probe-'));
  try {
    const writer = await startProbe({ directory, intervalMs: 100 });
    const standby = await startProbe({ directory, intervalMs: 100 });
    assert.equal(standby.role, 'standby');
    await writer.stop();
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(standby.role, 'writer');
    const beforeStop = (await standby.getState()).tick;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const afterWait = (await standby.getState()).tick;
    assert.ok(afterWait - beforeStop <= 3, `unexpected timer multiplication: ${beforeStop} -> ${afterWait}`);
    await standby.stop();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const onDisk = JSON.parse(await readFile(path.join(directory, 'monitor-plugin-probe', 'state.json'), 'utf8'));
    assert.equal(onDisk.tick, afterWait);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects malformed fixture without advancing cursor and exports no test helpers', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'magpie-probe-'));
  try {
    const probe = await startProbe({ directory, intervalMs: 100 });
    await probe.ready;
    const fixturePath = path.join(directory, 'monitor-plugin-probe', 'fixture.jsonl');
    await writeFile(fixturePath, 'null\n');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal((await probe.getState()).cursor, 0);
    await writeFile(fixturePath, '{"probe":true,"sequence":2}\n');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal((await probe.getState()).cursor, 0);
    await probe.stop();
    const plugin = await import('../index.mjs');
    assert.deepEqual(Object.keys(plugin), ['default']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupt checkpoint fails closed instead of resetting its cursor', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'magpie-probe-'));
  const root = path.join(directory, 'monitor-plugin-probe');
  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(root, { recursive: true }));
    for (const [contents, message] of [['{broken', /checkpoint is unreadable/], ['null', /checkpoint is invalid/]]) {
      await writeFile(path.join(root, 'state.json'), contents);
      await assert.rejects(startProbe({ directory, intervalMs: 100 }), message);
      assert.equal(await readFile(path.join(root, 'state.json'), 'utf8'), contents);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
