import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { githubApi, prepareAssets, publishMagpie, releaseContext } from '../../scripts/ci/publish-magpie.mjs';

const sha = 'a'.repeat(40);
const environment = {
  MAGPIE_PUBLISH_ENABLED: 'true',
  GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/dev/magpie', GITHUB_SHA: sha,
  GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_NUMBER: '42',
  NODE_CHECKS_RESULT: 'success', ANDROID_CHECKS_RESULT: 'success',
};

test('Magpie release gate rejects other refs, events, failed checks and malformed provenance', () => {
  for (const override of [
    { MAGPIE_PUBLISH_ENABLED: undefined }, { MAGPIE_PUBLISH_ENABLED: 'false' },
    { GITHUB_REF: 'refs/heads/main' }, { GITHUB_REF: 'refs/tags/dev/magpie' },
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { NODE_CHECKS_RESULT: 'failure' }, { ANDROID_CHECKS_RESULT: 'skipped' },
    { GITHUB_SHA: 'b'.repeat(39) },
  ]) assert.throws(() => releaseContext({ ...environment, ...override }));
  assert.deepEqual(releaseContext(environment), {
    sha, repository: 'owner/repo', runNumber: 42, versionCode: 100042,
    tag: `magpie-dev-42-${sha.slice(0, 12)}`,
  });
});

test('prepared artifacts verify embedded source and checksum', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'magpie-release-test-'));
  try {
    const archiveRoot = join(directory, 'archive');
    const apkDirectory = join(directory, 'apk');
    await mkdir(archiveRoot);
    await mkdir(apkDirectory);
    await writeFile(join(archiveRoot, 'SOURCE_COMMIT'), `${sha}\n`);
    await writeFile(join(apkDirectory, 'android-magpie.apk'), 'signed-apk-placeholder');
    const backendPath = join(directory, `magpie-backend-${sha}.tar.gz`);
    const tar = spawnSync('tar', ['-czf', backendPath, '-C', archiveRoot, '.']);
    assert.equal(tar.status, 0);
    const assets = await prepareAssets(releaseContext(environment), { apkDirectory, backendPath, outputDirectory: join(directory, 'release') });
    assert.deepEqual([...assets.keys()], ['magpie-monitor.apk', 'magpie-backend.tar.gz', 'SHA256SUMS', 'build-manifest.json']);
    const digest = createHash('sha256').update(assets.get('magpie-monitor.apk')).digest('hex');
    assert.match(assets.get('SHA256SUMS').toString(), new RegExp(`${digest}  magpie-monitor\\.apk`));
    assert.equal(JSON.parse(await readFile(join(directory, 'release', 'build-manifest.json'), 'utf8')).sourceCommit, sha);
    await writeFile(join(archiveRoot, 'SOURCE_COMMIT'), `${'b'.repeat(40)}\n`);
    spawnSync('tar', ['-czf', backendPath, '-C', archiveRoot, '.']);
    await assert.rejects(prepareAssets(releaseContext(environment), { apkDirectory, backendPath, outputDirectory: join(directory, 'bad') }), /SOURCE_COMMIT mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('draft release uploads missing assets before publication and rerun is idempotent', async () => {
  const context = releaseContext(environment);
  const assets = new Map([
    ['magpie-monitor.apk', Buffer.from('apk')], ['magpie-backend.tar.gz', Buffer.from('backend')],
    ['SHA256SUMS', Buffer.from('sums')], ['build-manifest.json', Buffer.from('manifest')],
  ]);
  let release = null;
  const calls = [];
  const api = {
    find: async () => release,
    ensureTag: async (_, __, expected) => { if (expected !== sha) throw new Error('Release tag provenance mismatch'); },
    create: async (_, body) => { calls.push('create'); release = { id: 1, ...body, assets: [] }; return release; },
    upload: async (_, name, data) => {
      calls.push(`upload:${name}`);
      release.assets.push({ name, size: data.length, digest: `sha256:${createHash('sha256').update(data).digest('hex')}` });
    },
    publish: async () => { calls.push('publish'); release.draft = false; return release; },
  };
  await publishMagpie(context, assets, api);
  assert.deepEqual(calls, ['create', ...assets.keys()].map((value, index) => index ? `upload:${value}` : value).concat('publish'));
  await publishMagpie(context, assets, api);
  assert.equal(calls.length, 6);
  release.assets.pop();
  await assert.rejects(publishMagpie(context, assets, api), /incomplete/);
  release.assets.push({ name: 'build-manifest.json', size: 1, digest: 'sha256:wrong' });
  await assert.rejects(publishMagpie(context, assets, api), /differs/);
  release.target_commitish = 'b'.repeat(40);
  await assert.rejects(publishMagpie(context, assets, api), /provenance mismatch/);
  release.target_commitish = sha;
  api.ensureTag = async () => { throw new Error('Release tag provenance mismatch'); };
  await assert.rejects(publishMagpie(context, assets, api), /tag provenance mismatch/);
});

test('GitHub release create and publish payloads serialize make_latest as the string false', async () => {
  const requests = [];
  let release = null;
  let nextAsset = 0;
  const api = githubApi('test-token', async (url, options) => {
    const method = options.method ?? 'GET';
    const request = { url, options, method, payload: options.body && options.headers['content-type'] === 'application/json' ? JSON.parse(options.body) : null };
    requests.push(request);
    if (url.includes('/git/ref/tags/')) {
      return { ok: true, json: async () => ({ object: { type: 'commit', sha } }) };
    }
    if (url.endsWith('/releases/tags/magpie-test')) {
      return release
        ? { ok: true, json: async () => release }
        : { ok: false, status: 404 };
    }
    if (url.endsWith('/releases') && method === 'POST') {
      release = { id: 7, ...request.payload, upload_url: 'https://uploads.example/releases/7{?name}', assets: [] };
      return { ok: true, json: async () => release };
    }
    if (url.startsWith('https://uploads.example/')) {
      const asset = ['magpie-monitor.apk', 'magpie-backend.tar.gz', 'SHA256SUMS', 'build-manifest.json'][nextAsset++];
      const body = options.body;
      release.assets.push({ name: asset, size: body.length, digest: `sha256:${createHash('sha256').update(body).digest('hex')}` });
      return { ok: true, json: async () => ({}) };
    }
    if (method === 'PATCH') {
      release = { ...release, ...request.payload, draft: false };
      return { ok: true, json: async () => release };
    }
    throw new Error(`Unexpected mocked request: ${method} ${url}`);
  });
  const assets = new Map([
    ['magpie-monitor.apk', Buffer.from('apk')], ['magpie-backend.tar.gz', Buffer.from('backend')],
    ['SHA256SUMS', Buffer.from('sums')], ['build-manifest.json', Buffer.from('manifest')],
  ]);
  await publishMagpie({ ...releaseContext(environment), tag: 'magpie-test' }, assets, api);
  const create = requests.find(({ url, method }) => url.endsWith('/releases') && method === 'POST');
  const publish = requests.find(({ method }) => method === 'PATCH');
  assert.equal(create.payload.make_latest, 'false');
  assert.equal(typeof create.payload.make_latest, 'string');
  assert.equal(publish.payload.make_latest, 'false');
  assert.equal(typeof publish.payload.make_latest, 'string');
});
