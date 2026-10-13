import { createHash } from 'node:crypto';
import { cpSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const sourceSha = process.env.SOURCE_SHA ?? process.env.GITHUB_SHA ?? spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Cannot identify source commit');
const root = resolve(import.meta.dirname, '../..');
const staging = mkdtempSync(join(tmpdir(), 'magpie-backend-'));
const artifactDir = join(root, 'artifacts');

try {
  const files = [
    '.node-version', 'scripts/start-magpie-monitor.sh', 'scripts/setup-magpie-monitor.sh',
    'scripts/start-lan-monitor.sh', 'scripts/usage-preference.py',
    'skills/claude-monitor/scripts/lib/real_pair.py',
    'skills/claude-monitor/scripts/render-qr.swift',
  ];
  for (const directory of ['packages/protocol', 'services/collector', 'services/relay']) {
    files.push(`${directory}/dist`, `${directory}/package.json`, `${directory}/package-lock.json`);
  }
  for (const file of files) {
    const target = join(staging, file);
    mkdirSync(join(target, '..'), { recursive: true });
    cpSync(join(root, file), target, { recursive: true });
  }
  const protocolManifest = join(staging, 'packages/protocol/package.json');
  const manifest = JSON.parse(readFileSync(protocolManifest, 'utf8'));
  manifest.exports = Object.fromEntries([['.', 'index'], ['./schemas', 'schemas']].map(([name, module]) => [name, {
    types: `./dist/${module}.d.ts`, import: `./dist/${module}.js`, default: `./dist/${module}.js`,
  }]));
  writeFileSync(protocolManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(staging, 'SOURCE_COMMIT'), `${sourceSha}\n`);
  writeFileSync(join(staging, 'README.md'), `# Magpie desktop runtime\n\nSource commit: ${sourceSha}\n\nRequires macOS, Node 24.13.0 through 24.x, Python 3, Swift, curl, OpenSSL, and the Magpie CLI. Install locked production dependencies while online with \`scripts/setup-magpie-monitor.sh\`, then run \`scripts/start-magpie-monitor.sh --check\` and \`scripts/start-magpie-monitor.sh --pair --open-qr\`. The launcher uses port 8788 and private state in \`~/.claude-phone-monitor-magpie\` by default. Pair the separate Android app with its one-time QR on a trusted LAN. No original monitor Hooks or service settings are changed.\n`);
  mkdirSync(artifactDir, { recursive: true });
  const filename = `magpie-backend-${sourceSha}.tar.gz`;
  const archive = join(artifactDir, filename);
  const tar = spawnSync('tar', ['-czf', archive, '-C', staging, '.'], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error(`tar failed (${tar.status ?? 'signal'})`);
  const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(`${archive}.sha256`, `${hash}  ${filename}\n`);
  process.stdout.write(`${archive}\n`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
