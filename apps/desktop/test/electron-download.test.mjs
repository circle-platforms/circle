import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadArtifact } from '@electron/get';
import {
  electronDownloadOptions,
  electronCacheRoot,
  validateElectronDownload,
} from '../scripts/electron-download.mjs';

// The version the manifest asks for: the checksums belong to it and to no other.
const { version } = JSON.parse(
  await readFile(
    new URL('../node_modules/electron/package.json', import.meta.url),
    'utf8',
  ),
);
const older = version.replace(/\d+$/, (patch) => String(Number(patch) + 1));
const artifact = `electron-v${version}-darwin-arm64.zip`;
const bytes = Buffer.from('synthetic Electron archive');
const checksums = {
  [artifact]: createHash('sha256').update(bytes).digest('hex'),
};
const identity = {
  version,
  installedVersion: version,
  lockedVersion: version,
  checksums,
  platform: 'darwin',
  arch: 'arm64',
};

test('Electron download binds installed checksums to the exact manifest and lock version', async () => {
  const options = await electronDownloadOptions({ env: {} });
  assert.match(
    options.checksums[
      `electron-v${version}-${process.platform}-${process.arch}.zip`
    ],
    /^[a-f0-9]{64}$/,
  );
  // With no folder named, the downloader's own default is the one the development
  // install used; a named one goes to both.
  assert.equal('cacheRoot' in options, false);
  assert.equal(electronCacheRoot({}), undefined);
  assert.equal(
    (
      await electronDownloadOptions({
        env: { electron_config_cache: join(tmpdir(), 'electron-cache') },
      })
    ).cacheRoot,
    join(tmpdir(), 'electron-cache'),
  );
  for (const change of [
    { installedVersion: older },
    { lockedVersion: older },
    { checksums: {} },
    { checksums: { [artifact]: 'bad' } },
  ])
    assert.throws(
      () => validateElectronDownload({ ...identity, ...change }),
      /version mismatch|missing Electron SHA-256/,
    );
});

test('the cache step of a workflow runs before the desktop packages are installed', async (t) => {
  // The step copies nothing but this script's own imports: a package that only `npm ci`
  // brings would fail it on a fresh runner.
  const source = await readFile(
    new URL('../scripts/electron-download.mjs', import.meta.url),
    'utf8',
  );
  for (const [, specifier] of source.matchAll(/from '([^']+)'/g))
    assert.match(specifier, /^node:/, specifier);
  const root = await mkdtemp(join(tmpdir(), 'circle-electron-configure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const copy = join(root, 'scripts', 'electron-download.mjs');
  await mkdir(join(root, 'scripts'));
  await writeFile(copy, source);
  const env = join(root, 'github-env');
  await writeFile(env, '');
  const result = spawnSync(process.execPath, [copy, '--configure-cache'], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GITHUB_ENV: env,
      CIRCLE_ELECTRON_CACHE_ROOT: join(root, 'cache'),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(env, 'utf8'),
    `electron_config_cache=${join(root, 'cache')}\n`,
  );
});

test('cold and offline warm Electron cache retain SHA-256 verification without remote checksums', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-electron-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const details = {
    ...validateElectronDownload(identity),
    version,
    platform: 'darwin',
    arch: 'arm64',
    artifactName: 'electron',
    cacheRoot: join(root, 'cache'),
    tempDirectory: root,
    downloader: {
      async download(url, target) {
        requests.push(url);
        assert.ok(url.endsWith('/' + artifact), url);
        await writeFile(target, bytes);
      },
    },
  };
  const path = await downloadArtifact(details);
  assert.deepEqual(await readFile(path), bytes);
  assert.equal(requests.length, 1);
  const offline = {
    ...details,
    downloader: {
      async download(url) {
        throw Error(`offline: ${url}`);
      },
    },
  };
  assert.equal(await downloadArtifact(offline), path);
  assert.equal(requests.length, 1);
  await writeFile(path, 'corrupt cached archive');
  await assert.rejects(downloadArtifact(offline), /offline:/);
  assert.equal(await downloadArtifact(details), path);
  assert.deepEqual(await readFile(path), bytes);
  await assert.rejects(
    downloadArtifact({
      ...details,
      cacheRoot: join(root, 'bad'),
      downloader: {
        async download(_url, target) {
          await writeFile(target, 'corrupt download');
        },
      },
    }),
    /checksum/i,
  );
  assert.ok(requests.every((url) => !url.includes('SHASUMS')));
});
