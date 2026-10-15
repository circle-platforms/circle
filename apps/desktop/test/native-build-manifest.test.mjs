import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyNativeBuildManifest } from './helpers/native-build-manifest.mjs';
const hash = 'a'.repeat(64),
  head = 'b'.repeat(40);
const executed = {
  platform: 'darwin',
  mainPath: '/app/dist/main.cjs',
  preloadPath: '/app/dist/preload.cjs',
  rendererPath: '/app/dist/renderer/index.html',
  artifacts: [
    '/app/dist/main.cjs',
    '/app/dist/preload.cjs',
    '/app/dist/renderer/index.html',
  ].map((path) => ({ path, sha256: hash })),
};
const manifest = () => ({
  sourceBuildHead: head,
  artifacts: structuredClone(executed.artifacts),
});
test('manifest binds full source commit to the exact executed main/preload/renderer hashes', () => {
  assert.equal(
    verifyNativeBuildManifest(manifest(), executed).sourceBuildHead,
    head,
  );
});
test('same basename outside running app, changed bytes, missing role, duplicate and short commit fail closed', () => {
  const foreign = manifest();
  foreign.artifacts[0].path = '/other/dist/main.cjs';
  assert.throws(() => verifyNativeBuildManifest(foreign, executed), /outside/);
  const stale = manifest();
  stale.artifacts[0].sha256 = 'c'.repeat(64);
  assert.throws(() => verifyNativeBuildManifest(stale, executed), /hash/);
  const missing = manifest();
  missing.artifacts.pop();
  assert.throws(() => verifyNativeBuildManifest(missing, executed), /missing/);
  const duplicate = manifest();
  duplicate.artifacts.push(duplicate.artifacts[0]);
  assert.throws(
    () => verifyNativeBuildManifest(duplicate, executed),
    /duplicate/,
  );
  assert.throws(
    () =>
      verifyNativeBuildManifest(
        { ...manifest(), sourceBuildHead: 'abcdef1' },
        executed,
      ),
    /full/,
  );
});

test('executed evidence reads bytes only from the actual app identity and preload', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { executedNativeBuildEvidence } =
    await import('./helpers/native-build-manifest.mjs');
  const root = await mkdtemp(join(tmpdir(), 'circle-build-manifest-'));
  try {
    await mkdir(join(root, 'dist', 'renderer'), { recursive: true });
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ main: 'dist/main.cjs' }),
    );
    const entries = [
      ['main.cjs', 'executed main'],
      ['preload.cjs', 'executed preload'],
      ['renderer/index.html', 'executed renderer'],
    ];
    const artifacts = [];
    for (const [name, content] of entries) {
      const file = join(root, 'dist', name);
      await writeFile(file, content);
      artifacts.push({
        path: file,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
    const app = {
      evaluate: async (callback, arg) =>
        runInNewContext('(' + callback.toString() + ')', {
          require: createRequire(import.meta.url),
          process,
        })(
          {
            app: { getAppPath: () => root, isPackaged: false },
            BrowserWindow: {
              getAllWindows: () => [
                {
                  webContents: {
                    getURL: () => 'circle://workbench/index.html',
                    getLastWebPreferences: () => ({
                      preload: join(root, 'dist', 'preload.cjs'),
                    }),
                  },
                },
              ],
            },
          },
          arg,
        ),
    };
    const candidate = { sourceBuildHead: head, artifacts };
    assert.equal(
      verifyNativeBuildManifest(
        candidate,
        await executedNativeBuildEvidence(app, candidate),
      ).mainPath,
      join(root, 'dist', 'main.cjs'),
    );
    await assert.rejects(
      () =>
        executedNativeBuildEvidence(app, {
          artifacts: [{ path: join(root, 'other', 'main.cjs'), sha256: hash }],
        }),
      /outside/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
