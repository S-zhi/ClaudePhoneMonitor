import { execFile as execFileCallback } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MAX_LIMIT = 5000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TIMEOUT_MS = 60_000;

async function parentExecutable() {
  if (process.platform === 'linux') {
    try { return await fs.readlink(`/proc/${process.ppid}/exe`); } catch { return undefined; }
  }
  if (process.platform === 'darwin') {
    try {
      const result = await execFile('/bin/ps', ['-p', String(process.ppid), '-o', 'comm='], { timeout: 2000, maxBuffer: 4096 });
      const candidate = result.stdout.trim();
      if (candidate.startsWith('/')) return candidate;
    } catch { /* Use PATH fallback. */ }
  }
  return undefined;
}

export async function discoverMagpieBin(options = {}) {
  if (typeof options.magpieBin === 'string' && options.magpieBin.trim()) return options.magpieBin.trim();
  const candidate = await parentExecutable();
  if (candidate) {
    try {
      const info = await fs.stat(candidate);
      if (info.isFile()) await fs.access(candidate, fsConstants.X_OK);
      if (info.isFile()) return candidate;
    } catch { /* PATH fallback. */ }
  }
  return 'magpie';
}

export async function readMagpieSnapshot({ options, env, signal, runner, limit }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error('magpie_invalid_limit');
  const args = ['sessions', '--json', '--limit', String(limit)];
  let output;
  if (runner) {
    output = await runner(args, { signal, env: { ...env, MAGPIE_MONITOR_SNAPSHOT_CHILD: '1' } });
  } else {
    const timeout = options.commandTimeoutMs ?? 30_000;
    const maxBuffer = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > MAX_TIMEOUT_MS) throw new Error('magpie_invalid_timeout');
    if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1024 || maxBuffer > MAX_OUTPUT_BYTES) throw new Error('magpie_invalid_output_limit');
    const command = await discoverMagpieBin(options);
    const result = await execFile(command, args, {
      env: { ...env, MAGPIE_MONITOR_SNAPSHOT_CHILD: '1' },
      timeout, maxBuffer, signal, windowsHide: true,
    });
    output = result.stdout;
  }
  if (typeof output !== 'string' || Buffer.byteLength(output) > (options.maxOutputBytes ?? MAX_OUTPUT_BYTES)) {
    throw new Error('magpie_output_too_large');
  }
  try { return JSON.parse(output); } catch { throw new Error('magpie_snapshot_invalid'); }
}

export const CLI_LIMITS = Object.freeze({ MAX_LIMIT, MAX_OUTPUT_BYTES, MAX_TIMEOUT_MS });
