import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  captureNativeBuildSource,
  generateNativeBuildManifest,
} from '../scripts/native-build-manifest.mjs';
test('pre-build source receipt binds both development files and actual packaged asar bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'circle-manifest-generator-'));
  const git = (args) => execFileSync('git', ['-C', root, ...args]);
  try {
    git(['init']);
    await writeFile(join(root, 'source.txt'), 'original source');
    git(['add', 'source.txt']);
    git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'Capture source',
    ]);
    const receipt = join(root, 'source-receipt.json');
    await captureNativeBuildSource({ root, output: receipt });
    const app = join(root, 'app');
    await mkdir(join(app, 'dist', 'renderer', 'assets'), { recursive: true });
    await writeFile(
      join(app, 'package.json'),
      JSON.stringify({ main: 'dist/main.cjs' }),
    );
    await mkdir(join(app, 'dist', 'tools'), { recursive: true });
    await mkdir(join(app, 'dist', 'node_modules', 'koffi'), {
      recursive: true,
    });
    await mkdir(join(app, 'dist', 'node_modules', '@koromix', 'koffi-target'), {
      recursive: true,
    });
    for (const name of [
      'main.cjs',
      'preload.cjs',
      'runtime-worker.mjs',
      'tools/command-supervisor.mjs',
      'node_modules/koffi/index.cjs',
      'node_modules/@koromix/koffi-target/koffi.node',
      'renderer/index.html',
      'renderer/assets/asset.js',
    ])
      await writeFile(join(app, 'dist', name), 'executed ' + name);
    const dev = await generateNativeBuildManifest({
      root,
      sourceReceipt: receipt,
      appPath: app,
      output: join(root, 'dev.json'),
    });
    await assert.rejects(
      () =>
        generateNativeBuildManifest({
          root,
          sourceReceipt: receipt,
          appPath: app,
          output: join(root, 'wrong-kind.json'),
          allowWorkingTree: true,
        }),
      /source kind/,
    );
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/untracked-only.ts'), 'new source');
    await assert.rejects(
      () =>
        captureNativeBuildSource({
          root,
          output: join(root, 'untracked-default.json'),
        }),
      /untracked build source/,
    );
    await rm(join(root, 'src/untracked-only.ts'));
    assert.equal(dev.artifacts.length, 8);
    assert.ok(dev.artifacts.every((entry) => entry.path.startsWith(app)));
    const require = createRequire(import.meta.url);
    const nested = createRequire(require.resolve('@electron/packager'));
    const asar = await import(
      pathToFileURL(nested.resolve('@electron/asar')).href
    );
    const archive = join(root, 'app.asar');
    await asar.createPackageWithOptions(app, archive, {
      unpack: '**/{tools,node_modules}/**',
    });
    const packaged = await generateNativeBuildManifest({
      root,
      sourceReceipt: receipt,
      appPath: archive,
      output: join(root, 'packaged.json'),
    });
    assert.deepEqual(
      packaged.artifacts.map((entry) => entry.sha256),
      dev.artifacts.map((entry) => entry.sha256),
    );
    assert.ok(
      packaged.artifacts.every((entry) => entry.path.startsWith(archive)),
    );
    await writeFile(join(root, 'source.txt'), 'changed source');
    await assert.rejects(() =>
      generateNativeBuildManifest({
        root,
        sourceReceipt: receipt,
        appPath: app,
        output: join(root, 'bad.json'),
      }),
    );
    assert.equal(
      JSON.parse(await readFile(join(root, 'dev.json'))).sourceBuildHead,
      dev.sourceBuildHead,
    );
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'apps/desktop/assets'), { recursive: true });
    await writeFile(join(root, 'src/new.ts'), 'untracked source');
    await writeFile(join(root, 'apps/desktop/assets/new.svg'), '<svg/>');
    await rm(join(root, 'source.txt'));
    await assert.rejects(
      () => captureNativeBuildSource({ root, output: receipt }),
      'default clean rules still reject WIP',
    );
    const wip = await captureNativeBuildSource({
      root,
      output: receipt,
      allowWorkingTree: true,
    });
    assert.equal(wip.sourceKind, 'working-tree');
    assert.equal(wip.sourceBaseHead, dev.sourceBuildHead);
    assert.match(wip.sourceTreeSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      wip.sourceFiles.find((file) => file.path === 'source.txt'),
      { path: 'source.txt', kind: 'tracked', sha256: null, deleted: true },
    );
    assert.equal(
      wip.sourceFiles.find((file) => file.path === 'src/new.ts').kind,
      'untracked',
    );
    assert.equal(
      wip.sourceFiles.find(
        (file) => file.path === 'apps/desktop/assets/new.svg',
      ).kind,
      'untracked',
    );
    const build = () =>
      generateNativeBuildManifest({
        root,
        sourceReceipt: receipt,
        appPath: app,
        output: join(root, 'wip.json'),
        allowWorkingTree: true,
      });
    await assert.rejects(
      () =>
        generateNativeBuildManifest({
          root,
          sourceReceipt: receipt,
          appPath: app,
          output: join(root, 'no-opt-in.json'),
        }),
      /explicit/,
    );
    const wipManifest = await build();
    assert.equal(wipManifest.sourceKind, 'working-tree');
    assert.equal(wipManifest.sourceTreeSha256, wip.sourceTreeSha256);
    assert.deepEqual(wipManifest.sourceFiles, wip.sourceFiles);
    for (const [file, content] of [
      ['src/new.ts', 'untracked source'],
      ['apps/desktop/assets/new.svg', '<svg/>'],
    ]) {
      await writeFile(join(root, file), content + 'changed');
      await assert.rejects(build, /source changed/);
      await writeFile(join(root, file), content);
    }
    await writeFile(join(root, 'source.txt'), 'restored tracked file');
    await assert.rejects(build, /source changed/);
    await rm(join(root, 'source.txt'));
    await writeFile(join(root, 'src/added-after-receipt.ts'), 'new');
    await assert.rejects(build, /source changed/);
    await rm(join(root, 'src/added-after-receipt.ts'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
