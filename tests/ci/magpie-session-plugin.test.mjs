import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createNativeFixtures,
  makeChildEnv,
  parseArgs,
  processDescendants,
  redactSecrets,
} from '../../scripts/ci/magpie-session-plugin.mjs';

await import('../../packages/magpie-monitor/test/monitor.test.mjs');

test('runner requires absolute installed binaries and accepts explicit live-readonly mode', () => {
  assert.deepEqual(parseArgs(['--magpie', '/opt/magpie', '--bun', '/opt/magpie-bun']), {
    magpie: '/opt/magpie', bun: '/opt/magpie-bun',
  });
  assert.equal(parseArgs(['--magpie', '/opt/magpie', '--bun', '/opt/bun', '--live-readonly']).liveReadonly, true);
  assert.throws(() => parseArgs(['--magpie', 'magpie', '--bun', '/opt/bun']), /absolute path/);
  assert.throws(() => parseArgs(['--magpie', '/opt/magpie']), /Usage:/);
  assert.throws(() => parseArgs(['--magpie', '/opt/magpie', '--bun', '/opt/bun', '--fake-cli']), /Unknown argument/);
});

test('Magpie web environment isolates HOME/XDG and explicitly scopes native source roots', () => {
  const env = makeChildEnv({
    home: '/tmp/magpie-test-home', webPort: 24000, key: 'test-web-key', bun: '/opt/bun', magpie: '/opt/magpie',
    sourceRoots: { codex: '/tmp/codex-fixture', claude: '/tmp/claude-fixture', hermes: '/tmp/hermes-fixture' },
  });
  assert.equal(env.HOME, '/tmp/magpie-test-home');
  assert.equal(env.XDG_CONFIG_HOME, '/tmp/magpie-test-home/.config');
  assert.equal(env.XDG_CACHE_HOME, '/tmp/magpie-test-home/.cache');
  assert.equal(env.CODEX_HOME, '/tmp/codex-fixture');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/claude-fixture');
  assert.equal(env.HERMES_HOME, '/tmp/hermes-fixture');
  assert.equal(env.MAGPIE_NO_ACCOUNTS, '1');
  assert.equal(env.MAGPIE_NO_STATS, '1');
  assert.equal(Object.hasOwn(env, 'OPENAI_API_KEY'), false);
  assert.equal(env.PATH.split(path.delimiter).includes('/opt'), true);
  assert.match(env.MAGPIE_ADDR, /^127\.0\.0\.1:\d{1,5}$/);
  assert.throws(() => makeChildEnv({ home: '/tmp/home', webPort: Promise.resolve(24000), key: 'k', bun: '/opt/bun', magpie: '/opt/magpie' }), /webPort must be an integer TCP port/);
});

test('fixture builder creates native Codex rollout, index and SQLite without fabricating Magpie cache', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magpie-session-fixture-test-'));
  try {
    const codexRoot = path.join(root, '.codex');
    const fixtures = await createNativeFixtures(codexRoot, new Date('2026-10-13T12:00:00.000Z'));
    const index = (await readFile(fixtures.indexPath, 'utf8')).trim().split('\n').map((row) => JSON.parse(row));
    assert.equal(index.length, 2);
    assert.equal(index.find((row) => row.id === fixtures.oldId).thread_name, 'Original native title');
    const rows = (await readFile(fixtures.oldRollout, 'utf8')).trim().split('\n').map((row) => JSON.parse(row));
    assert.equal(rows[0].type, 'session_meta');
    assert.equal(rows[0].payload.id, fixtures.oldId);
    assert.equal(rows[2].payload.type, 'task_started');
    assert.equal((await readFile(fixtures.brokenRollout, 'utf8')).endsWith('"task_started"'), true);
    const db = new DatabaseSync(fixtures.dbPath, { readOnly: true });
    assert.equal(db.prepare('SELECT name FROM threads WHERE id=?').get(fixtures.oldId).name, 'Original native title');
    db.close();
    await assert.rejects(readFile(path.join(root, '.cache', 'magpie', 'sessions.json'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleanup discovery is bound to exact Magpie web process identity', () => {
  const ps = [
    { pid: 20, ppid: 1, started: 'web-start', command: 'magpie web' },
    { pid: 21, ppid: 20, started: 'bun-start', command: 'magpie-bun plugin-host' },
    { pid: 22, ppid: 21, started: 'monitor-start', command: 'magpie-bun plugin' },
    { pid: 23, ppid: 1, started: 'other-start', command: 'magpie web' },
    { pid: 24, ppid: 23, started: 'other-child', command: 'magpie-bun plugin' },
  ];
  assert.deepEqual(processDescendants(ps, [{ pid: 20, started: 'web-start', command: 'magpie web' }]).map((item) => item.pid), [21, 22]);
  assert.deepEqual(processDescendants(ps, [{ pid: 20, started: 'reused', command: 'magpie web' }]), []);
});

test('reports recursively redact auth keys and live reports omit session titles', () => {
  const safe = redactSecrets({ nested: { href: 'http://127.0.0.1/?k=secret', title: 'private-cookie' } }, ['secret', 'private-cookie']);
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  assert.equal(JSON.stringify(safe).includes('private-cookie'), false);
});
