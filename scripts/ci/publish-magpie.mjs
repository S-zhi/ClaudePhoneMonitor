import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const assetNames = ['magpie-monitor.apk', 'magpie-backend.tar.gz', 'SHA256SUMS', 'build-manifest.json'];

export function releaseContext(env) {
  const { MAGPIE_PUBLISH_ENABLED: publishEnabled, GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_SHA: sha,
    GITHUB_REPOSITORY: repository, GITHUB_RUN_NUMBER: runNumber,
    NODE_CHECKS_RESULT: nodeResult, ANDROID_CHECKS_RESULT: androidResult } = env;
  if (publishEnabled !== 'true') throw new Error('Magpie publication is not enabled');
  if (event !== 'push' || ref !== 'refs/heads/dev/magpie') throw new Error('Magpie release requires a dev/magpie push');
  if (nodeResult !== 'success' || androidResult !== 'success') throw new Error('Magpie release requires both successful CI checks');
  if (!SHA.test(sha ?? '') || !REPO.test(repository ?? '') || !/^[1-9]\d*$/.test(runNumber ?? '')) {
    throw new Error('Invalid Magpie release provenance');
  }
  const versionCode = 100000 + Number(runNumber);
  if (!Number.isSafeInteger(versionCode) || versionCode > 2147483647) throw new Error('Magpie version code exhausted');
  return { sha, repository, runNumber: Number(runNumber), versionCode,
    tag: `magpie-dev-${runNumber}-${sha.slice(0, 12)}` };
}

export async function prepareAssets(context, { apkDirectory, backendPath, outputDirectory }) {
  const apks = (await readdir(apkDirectory)).filter((name) => name.endsWith('.apk'));
  if (apks.length !== 1) throw new Error(`Expected one Magpie APK, found ${apks.length}`);
  if (!basename(backendPath).includes(context.sha)) throw new Error('Backend artifact name does not match source SHA');
  const source = spawnSync('tar', ['-xOzf', backendPath, './SOURCE_COMMIT'], { encoding: 'utf8' });
  if (source.status !== 0 || source.stdout.trim() !== context.sha) throw new Error('Backend SOURCE_COMMIT mismatch');
  await mkdir(outputDirectory, { recursive: true });
  const apk = await readFile(join(apkDirectory, apks[0]));
  const backend = await readFile(backendPath);
  const assets = new Map([['magpie-monitor.apk', apk], ['magpie-backend.tar.gz', backend]]);
  const checksums = [...assets].map(([name, data]) => `${createHash('sha256').update(data).digest('hex')}  ${name}`).join('\n') + '\n';
  assets.set('SHA256SUMS', Buffer.from(checksums));
  const manifest = {
    channel: 'dev/magpie', sourceCommit: context.sha, tag: context.tag,
    runNumber: context.runNumber, android: { applicationId: 'com.example.claudephonemonitor.magpie', versionCode: context.versionCode },
    runtime: { platform: 'macOS for the included starter', node: '24.13.0 through 24.x', python: '3',
      tools: ['Magpie CLI', 'Swift CLI and CoreImage for auto-pairing', 'curl', 'OpenSSL'],
      install: 'npm ci --omit=dev in each packaged workspace; see archive README.md' },
    assets: Object.fromEntries([...assets].map(([name, data]) => [name, { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length }])),
  };
  assets.set('build-manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  for (const [name, data] of assets) await writeFile(join(outputDirectory, name), data);
  return assets;
}

function matchesAssets(release, assets) {
  const existing = release.assets ?? [];
  if (existing.some((asset) => !assets.has(asset.name))) throw new Error('Release contains unexpected assets');
  for (const asset of existing) {
    const expected = createHash('sha256').update(assets.get(asset.name)).digest('hex');
    if (asset.digest !== `sha256:${expected}` || asset.size !== assets.get(asset.name).length) {
      throw new Error(`Existing release asset differs or has no verifiable digest: ${asset.name}`);
    }
  }
  return existing;
}

export async function publishMagpie(context, assets, api) {
  await api.ensureTag(context.repository, context.tag, context.sha);
  let release = await api.find(context.repository, context.tag);
  if (!release) release = await api.create(context.repository, {
    tag_name: context.tag, target_commitish: context.sha,
    name: 'Magpie development build', body: `Source: ${context.sha}\nChannel: dev/magpie\nThis is a signed Android APK and macOS backend package, not a native binary or Magpie plugin. The starter needs Node 24.13+, Python 3, and Magpie CLI. Automatic pairing also uses Swift CLI/CoreImage. See the archive README.`,
    draft: true, prerelease: true, make_latest: 'false',
  });
  if (release.tag_name !== context.tag || release.target_commitish !== context.sha || release.prerelease !== true) {
    throw new Error('Release provenance mismatch');
  }
  const existing = matchesAssets(release, assets);
  if (!release.draft) {
    if (existing.length !== assetNames.length) throw new Error('Published release is incomplete');
    return release;
  }
  const found = new Set(existing.map((asset) => asset.name));
  for (const name of assetNames) {
    if (!assets.has(name)) throw new Error(`Missing release asset: ${name}`);
    if (!found.has(name)) await api.upload(release, name, assets.get(name));
  }
  release = await api.find(context.repository, context.tag);
  if (!release?.draft || release.target_commitish !== context.sha || matchesAssets(release, assets).length !== assetNames.length) {
    throw new Error('Draft release assets or source changed before publication');
  }
  return api.publish(context.repository, release.id);
}

export function githubApi(token, fetchImpl = fetch) {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  async function request(url, options = {}) {
    const response = await fetchImpl(url, { ...options, headers: { ...headers, ...options.headers } });
    if (!response.ok) throw new Error(`GitHub API ${options.method ?? 'GET'} failed: HTTP ${response.status}`);
    return response.json();
  }
  const base = 'https://api.github.com/repos/';
  return {
    async ensureTag(repo, tag, sha) {
      const url = `${base}${repo}/git/ref/tags/${encodeURIComponent(tag)}`;
      let response = await fetchImpl(url, { headers });
      if (response.status === 404) {
        await request(`${base}${repo}/git/refs`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ref: `refs/tags/${tag}`, sha }) });
        response = await fetchImpl(url, { headers });
      }
      if (!response.ok) throw new Error(`GitHub tag lookup failed: HTTP ${response.status}`);
      const ref = await response.json();
      if (ref.object?.type !== 'commit' || ref.object.sha !== sha) throw new Error('Release tag provenance mismatch');
    },
    async find(repo, tag) {
      const response = await fetchImpl(`${base}${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GitHub release lookup failed: HTTP ${response.status}`);
      return response.json();
    },
    create: (repo, body) => request(`${base}${repo}/releases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    upload: (release, name, data) => request(`${release.upload_url.split('{')[0]}?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: data }),
    publish: (repo, id) => request(`${base}${repo}/releases/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft: false, prerelease: true, make_latest: 'false' }) }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const context = releaseContext(process.env);
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required');
  const assets = await prepareAssets(context, {
    apkDirectory: process.env.MAGPIE_APK_DIRECTORY ?? 'apk',
    backendPath: process.env.MAGPIE_BACKEND_PATH ?? `backend/magpie-backend-${context.sha}.tar.gz`,
    outputDirectory: process.env.MAGPIE_RELEASE_DIRECTORY ?? 'magpie-release',
  });
  await publishMagpie(context, assets, githubApi(process.env.GITHUB_TOKEN));
  process.stdout.write(`Published ${context.tag} from ${context.sha}\n`);
}
