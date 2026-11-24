import { scratch, cleanup } from './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { ExtensionHost } from '../src/extensions.js';
import {
  buildBundledExtensions,
  keepExtensionImports,
  shareExtensionError,
} from '../apps/desktop/scripts/extensions.mjs';

test('a clean desktop build loads a shipped extension from extension.js', async (t) => {
  const root = scratch(t);
  const dist = join(root, 'dist');
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  mkdirSync(home);
  await buildBundledExtensions(dist);

  for (const name of ['github', 'hub']) {
    const folder = join(dist, 'extensions', name);
    assert.equal(existsSync(join(folder, 'extension.js')), true);
    assert.equal(existsSync(join(folder, 'extension.ts')), false);
    assert.equal(existsSync(join(folder, 'extension.json')), true);
    assert.equal(
      readFileSync(join(folder, 'extension.js'), 'utf8').includes('__require('),
      false,
      `${name}/extension.js must not contain __require(`,
    );
  }
  assert.equal(existsSync(join(dist, 'extension_error.js')), true);

  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: join(dist, 'extensions'),
    settings: { github: { enabled: true }, hub: { enabled: true } },
  }).load();
  cleanup(t, () => host.close());
  for (const name of ['github', 'hub']) {
    const ext = host.extensions.find((item) => item.name === name);
    assert.ok(ext, `${name} was not discovered`);
    assert.equal(ext.error, '', ext.error);
    assert.equal(ext.path.endsWith(`${sep}extension.js`), true);
    assert.equal(host.commands().has(name), true);
  }
});

test('a shipped extension and the desktop worker share one ExtensionError', async (t) => {
  const dist = join(scratch(t), 'dist');
  await buildBundledExtensions(dist);
  // An extension that imports the host's error class, built as the shipped ones are.
  const extension = join(dist, 'extensions', 'probe', 'extension.js');
  await build({
    stdin: {
      contents: `export { ExtensionError } from '../../extension_error.js';\n`,
      resolveDir: join(dist, 'extensions', 'probe'),
      sourcefile: 'extension.ts',
      loader: 'ts',
    },
    outfile: extension,
    bundle: true,
    platform: 'node',
    format: 'esm',
    plugins: [keepExtensionImports()],
  });
  assert.match(
    readFileSync(extension, 'utf8'),
    /from ['"]\.\.\/\.\.\/extension_error\.js['"]/,
  );
  // The worker, which imports the file beside it.
  const worker = join(dist, 'probe.mjs');
  await build({
    stdin: {
      contents: `export { ExtensionError } from './extension_error.js';\n`,
      resolveDir: dist,
      sourcefile: 'probe.ts',
      loader: 'ts',
    },
    outfile: worker,
    bundle: true,
    platform: 'node',
    format: 'esm',
    plugins: [shareExtensionError()],
  });
  const fromWorker = await import(pathToFileURL(worker).href);
  const fromExtension = await import(pathToFileURL(extension).href);
  const shared = await import(
    pathToFileURL(join(dist, 'extension_error.js')).href
  );
  assert.equal(fromWorker.ExtensionError, shared.ExtensionError);
  assert.equal(fromExtension.ExtensionError, shared.ExtensionError);
  assert.ok(
    new shared.ExtensionError('x') instanceof fromWorker.ExtensionError,
  );
});
