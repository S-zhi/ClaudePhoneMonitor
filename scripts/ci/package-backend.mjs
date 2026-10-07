import { cpSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const nodeVersion = readFileSync('.node-version', 'utf8').trim();
const commit = process.env.GITHUB_SHA ?? spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Cannot identify source commit');
const staging = mkdtempSync(join(tmpdir(), 'monitor-backend-'));
try {
  for (const directory of ['packages/protocol', 'services/collector', 'services/relay']) {
    mkdirSync(join(staging, directory), { recursive: true });
    for (const file of ['dist', 'package.json', 'package-lock.json']) cpSync(`${directory}/${file}`, join(staging, directory, file), { recursive: true });
    if (directory === 'packages/protocol') {
      const manifestPath = join(staging, directory, 'package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.exports = Object.fromEntries([['.', 'index'], ['./schemas', 'schemas']].map(([name, file]) => [name, { types: `./dist/${file}.d.ts`, import: `./dist/${file}.js`, default: `./dist/${file}.js` }]));
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }
  writeFileSync(join(staging, '.node-version'), `${nodeVersion}\n`);
  writeFileSync(join(staging, 'README.md'), `# Monitor backend\n\nUse Node ${nodeVersion}. From the extracted directory install production dependencies:\n\n\`\`\`sh\nnpm --prefix services/relay ci --omit=dev --registry=https://registry.npmjs.org\nnpm --prefix services/collector ci --omit=dev --registry=https://registry.npmjs.org\nnpm --prefix packages/protocol ci --omit=dev --registry=https://registry.npmjs.org\n\`\`\`\n\nFirst create a bootstrap secret in your current shell: \`export RELAY_BOOTSTRAP_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"\`. Then start a local relay with \`RELAY_AUTH_MODE=paired RELAY_HOST=127.0.0.1 RELAY_DB_PATH=./relay.sqlite npm --prefix services/relay start\`. Set RELAY_PUBLIC_URL for reachable deployment URLs and retain your bootstrap secret for pairing. Collector CLI: \`npm --prefix services/collector start -- --help\`. Protocol compiled modules are in packages/protocol/dist. This archive contains no node_modules.\n`);
  writeFileSync(join(staging, 'SOURCE_COMMIT'), `${commit}\n`);
  mkdirSync('artifacts', { recursive: true });
  const filename = `backend-${commit}.tar.gz`;
  const result = spawnSync('tar', ['-czf', `artifacts/${filename}`, '-C', staging, '.'], { stdio: 'inherit' });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally { rmSync(staging, { recursive: true, force: true }); }
