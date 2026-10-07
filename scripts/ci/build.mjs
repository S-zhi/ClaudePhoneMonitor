import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const directory of ['packages/protocol', 'services/collector', 'services/relay']) {
  rmSync(`${directory}/dist`, { recursive: true, force: true });
  const result = spawnSync('npm', ['run', 'build'], { cwd: directory, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
