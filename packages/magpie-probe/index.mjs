import { startProbe } from './probe.mjs';

export default async function MagpieMonitorProbe({ directory }) {
  const probe = await startProbe({ directory });
  await probe.ready;
  return {};
}
