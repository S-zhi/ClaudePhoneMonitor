import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const version = spawnSync('bash', ['--version'], { encoding: 'utf8' }).stdout;
if (!/^GNU bash, version (?:[3-9]|[1-9]\d)\./.test(version)) throw new Error('Bash 3 or newer is required');
function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', '.gradle', 'build', 'dist'].includes(entry.name)) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) check(path);
    else if (entry.name.endsWith('.sh') || /^#![^\n]*(?:bash|\/sh)/.test(readFileSync(path, 'utf8').slice(0, 150))) {
      const result = spawnSync('bash', ['-n', path], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  }
}
check('.');
