import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const sourceSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
const cleanEnv = (overrides = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MAGPIE_') && key !== 'CLAUDE_PHONE_MONITOR_HOME')),
  MAGPIE_BIN: process.execPath,
  ...overrides,
});

test('Magpie archive is self-contained, allowlisted and isolated', () => {
  const result = spawnSync('node', ['scripts/ci/package-magpie.mjs'], {
    cwd: root, encoding: 'utf8', env: cleanEnv({ SOURCE_SHA: sourceSha }),
  });
  assert.equal(result.status, 0, result.stderr);
  const filename = `magpie-backend-${sourceSha}.tar.gz`;
  const archive = join(root, 'artifacts', filename);
  const temp = mkdtempSync(join(tmpdir(), 'magpie-package-test-'));
  try {
    assert.equal(spawnSync('tar', ['-xzf', archive, '-C', temp]).status, 0);
    assert.equal(readFileSync(join(temp, 'SOURCE_COMMIT'), 'utf8'), `${sourceSha}\n`);
    const files = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' }).stdout.split('\n');
    for (const expected of [
      './scripts/start-magpie-monitor.sh', './scripts/setup-magpie-monitor.sh',
      './scripts/start-lan-monitor.sh', './scripts/usage-preference.py',
      './skills/claude-monitor/scripts/lib/real_pair.py',
      './skills/claude-monitor/scripts/render-qr.swift',
      './services/collector/dist/cli.js', './services/relay/dist/src/index.js',
      './packages/protocol/dist/index.js', './SOURCE_COMMIT',
    ]) assert.ok(files.includes(expected), `${expected} missing`);
    assert.ok(files.every((file) => !/(node_modules|monitor\.env|pairing\.png|\.sqlite|bootstrap\.secret|\.codex|\.claude\/)/.test(file)));
    assert.equal(readdirSync(join(temp, 'scripts')).sort().join(','),
      'setup-magpie-monitor.sh,start-lan-monitor.sh,start-magpie-monitor.sh,usage-preference.py');
    const help = spawnSync('bash', [join(temp, 'scripts/start-magpie-monitor.sh'), '--help'], {
      encoding: 'utf8', env: cleanEnv({ HOME: join(temp, 'fresh-home') }),
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /8788/);
    assert.match(help.stdout, /\.claude-phone-monitor-magpie/);
    assert.equal(readdirSync(temp).includes('fresh-home'), false);
    const launcher = join(temp, 'scripts/start-magpie-monitor.sh');
    const checkState = (home, state, extra = {}) => spawnSync('bash', [launcher, '--check'], {
      encoding: 'utf8', env: cleanEnv({ HOME: home, MAGPIE_MONITOR_HOME: state, ...extra }),
    });
    const assertStateRejected = (result) => {
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /state must not overlap/);
    };
    assertStateRejected(checkState(temp, join(temp, '.claude-phone-monitor')));
    assertStateRejected(checkState(temp, join(temp, '.claude-phone-monitor', 'nested')));
    assertStateRejected(checkState(temp, temp));
    const originalLink = join(temp, 'original-link');
    symlinkSync(join(temp, '.claude-phone-monitor'), originalLink);
    assertStateRejected(checkState(temp, join(originalLink, 'nested')));
    const customOriginal = join(temp, 'custom-original');
    assertStateRejected(checkState(temp, join(customOriginal, 'magpie-nested'), { CLAUDE_PHONE_MONITOR_HOME: customOriginal }));
    assertStateRejected(checkState(temp, customOriginal, { CLAUDE_PHONE_MONITOR_HOME: customOriginal }));
    const originalPort = spawnSync('bash', [join(temp, 'scripts/start-magpie-monitor.sh'), '--check'], {
      encoding: 'utf8', env: cleanEnv({ HOME: temp, MAGPIE_RELAY_PORT: '8787' }),
    });
    assert.equal(originalPort.status, 2);
    assert.match(originalPort.stderr, /Port 8787/);

    const stubBin = join(temp, 'stub-bin');
    mkdirSync(stubBin);
    const swiftStub = join(stubBin, 'swift');
    writeFileSync(swiftStub, '#!/bin/sh\nexit 0\n');
    chmodSync(swiftStub, 0o755);
    const runtimeCheck = (env = {}) => spawnSync('bash', [launcher, '--check'], {
      encoding: 'utf8', env: cleanEnv({ HOME: join(temp, 'runtime-home'), PATH: `${stubBin}:${dirname(process.execPath)}:${process.env.PATH}`, ...env }),
    });
    const missingDependencies = runtimeCheck();
    assert.notEqual(missingDependencies.status, 0);
    assert.match(missingDependencies.stderr, /Relay production dependencies are missing/);
    assert.match(missingDependencies.stderr, /scripts\/setup-magpie-monitor\.sh/);
    const relayNodeModules = join(root, 'services/relay/node_modules');
    assert.ok(readdirSync(relayNodeModules).length > 0, 'repository Relay dependencies are required for this package test');
    symlinkSync(relayNodeModules, join(temp, 'services/relay/node_modules'));
    const installedRuntime = runtimeCheck();
    assert.equal(installedRuntime.status, 0, installedRuntime.stderr);
    assert.equal(readdirSync(join(temp, 'services/collector')).includes('node_modules'), false);

    const linkParent = join(temp, 'launcher-link');
    mkdirSync(linkParent);
    symlinkSync(launcher, join(linkParent, 'start-magpie-monitor.sh'));
    const lanLauncher = join(temp, 'scripts/start-lan-monitor.sh');
    writeFileSync(lanLauncher, '#!/bin/sh\nprintf "%s\\n" "$0" > "$(dirname "$0")/.forwarded-path"\nprintf "%s\\n" "$@" > "$(dirname "$0")/.forwarded-args"\n');
    chmodSync(lanLauncher, 0o755);
    const launchViaLink = spawnSync('bash', [join(linkParent, 'start-magpie-monitor.sh'), '--no-watch-codex'], {
      encoding: 'utf8', env: cleanEnv({
        HOME: join(temp, 'launcher-home'), MAGPIE_MONITOR_HOME: join(temp, 'launcher-state'),
        MAGPIE_RELAY_PORT: '48889', PATH: `${stubBin}:${dirname(process.execPath)}:${process.env.PATH}`,
      }),
    });
    assert.equal(launchViaLink.status, 0, launchViaLink.stderr);
    assert.equal(readFileSync(join(temp, 'scripts/.forwarded-path'), 'utf8'), `${realpathSync(lanLauncher)}\n`);
    assert.match(readFileSync(join(temp, 'scripts/.forwarded-args'), 'utf8'), /--no-build/);
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
    assert.equal(readFileSync(`${archive}.sha256`, 'utf8'), `${digest}  ${filename}\n`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
