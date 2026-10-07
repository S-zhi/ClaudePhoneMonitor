import { spawnSync } from 'node:child_process';
for (const directory of ['.', 'packages/protocol', 'services/collector', 'services/relay']) {
  const result = spawnSync('npm', ['ci', '--registry=https://registry.npmjs.org'], { cwd: directory, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
