import { startSessionMonitor } from './monitor.mjs';

export default async function MagpieSessionMonitor(input = {}, options = {}) {
  if (process.env.MAGPIE_MONITOR_SNAPSHOT_CHILD === '1') return {};
  const directory = input?.directory;
  if (typeof directory !== 'string' || !directory) return {};
  const configured = { ...(input.options ?? {}), ...(options ?? {}) };
  await startSessionMonitor({ directory, options: configured, waitForInitialPoll: false });
  return {};
}
