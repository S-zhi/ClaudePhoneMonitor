import assert from 'node:assert/strict';
import test from 'node:test';
import { makeChildEnv, parseArgs, processDescendants, redactSecrets } from '../../scripts/ci/magpie-plugin-probe.mjs';

await import('../../packages/magpie-probe/test/probe.test.mjs');

test('requires absolute Magpie and Bun paths and accepts optional report directory', () => {
  assert.deepEqual(parseArgs(['--magpie', '/opt/magpie', '--bun', '/opt/bun']), {
    magpie: '/opt/magpie', bun: '/opt/bun',
  });
  assert.equal(parseArgs(['--magpie', '/opt/magpie', '--bun', '/opt/bun', '--report-dir', './reports/out'])['report-dir'].endsWith('/reports/out'), true);
  assert.throws(() => parseArgs(['--magpie', 'magpie', '--bun', '/opt/bun']), /absolute path/);
  assert.throws(() => parseArgs(['--magpie', '/opt/magpie']), /Usage:/);
  assert.throws(() => parseArgs(['--magpie', '/opt/magpie', '--bun', '/opt/bun', '--unexpected']), /Unknown argument/);
});

test('child environment is an allowlist with isolated HOME, XDG, and no inherited secrets', () => {
  const previous = process.env.SHOULD_NOT_LEAK;
  process.env.SHOULD_NOT_LEAK = 'test-secret';
  try {
    const env = makeChildEnv('/tmp/probe-home', 23123, 'random-web-key', '/opt/bun');
    assert.equal(env.HOME, '/tmp/probe-home');
    assert.equal(env.XDG_CONFIG_HOME, '/tmp/probe-home/.config');
    assert.equal(env.MAGPIE_BUN, '/opt/bun');
    assert.equal(env.MAGPIE_NO_ACCOUNTS, '1');
    assert.equal(env.MAGPIE_NO_STATS, '1');
    assert.equal(env.DO_NOT_TRACK, '1');
    assert.equal(env.MAGPIE_WEB_KEY, 'random-web-key');
    assert.equal(env.MAGPIE_ADDR, '127.0.0.1:23123');
    assert.equal(Object.hasOwn(env, 'SHOULD_NOT_LEAK'), false);
    assert.equal(Object.hasOwn(env, 'PATH'), true);
    assert.equal(Object.keys(env).every((key) => ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'MAGPIE_BUN', 'MAGPIE_NO_ACCOUNTS', 'MAGPIE_NO_STATS', 'DO_NOT_TRACK', 'MAGPIE_WEB_KEY', 'MAGPIE_ADDR', 'PATH'].includes(key)), true);
  } finally {
    if (previous === undefined) delete process.env.SHOULD_NOT_LEAK;
    else process.env.SHOULD_NOT_LEAK = previous;
  }
});

test('report redaction removes auth key and cookie from nested diagnostics', () => {
  const report = redactSecrets({ error: 'request https://127.0.0.1/?k=auth-key failed', diagnostics: { cookie: 'session-cookie' } }, ['auth-key', 'session-cookie']);
  assert.equal(JSON.stringify(report).includes('auth-key'), false);
  assert.equal(JSON.stringify(report).includes('session-cookie'), false);
});

test('cleanup descendant discovery is limited to the exact tracked web process tree', () => {
  const processes = [
    { pid: 10, ppid: 1, started: 'root-start', command: 'magpie web' },
    { pid: 11, ppid: 10, started: 'bun-start', command: 'magpie-bun host' },
    { pid: 12, ppid: 11, started: 'plugin-start', command: 'magpie-bun plugin' },
    { pid: 13, ppid: 1, started: 'other-start', command: 'magpie web' },
    { pid: 14, ppid: 13, started: 'other-child', command: 'magpie-bun host' },
  ];
  const descendants = processDescendants(processes, [{ pid: 10, started: 'root-start', command: 'magpie web' }]);
  assert.deepEqual(descendants.map(({ pid }) => pid), [11, 12]);
  assert.deepEqual(processDescendants(processes, [{ pid: 10, started: 'reused-pid', command: 'magpie web' }]), []);
});
