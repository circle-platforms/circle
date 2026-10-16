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
  shareExtensionError,
} from '../apps/desktop/scripts/extensions.mjs';

test('a clean desktop build loads the hub extension from extension.js', async (t) => {
  const root = scratch(t);
  const dist = join(root, 'dist');
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  await buildBundledExtensions(dist);

  const entry = join(dist, 'extensions', 'hub', 'extension.js');
  assert.equal(existsSync(entry), true);
  assert.equal(
    existsSync(join(dist, 'extensions', 'hub', 'extension.ts')),
    false,
  );
  assert.equal(existsSync(join(dist, 'hub_text.js')), true);
  assert.equal(existsSync(join(dist, 'extension_error.js')), true);
  const source = readFileSync(entry, 'utf8');
  assert.match(source, /from ['"]\.\.\/\.\.\/hub_text\.js['"]/);
  assert.match(source, /from ['"]\.\.\/\.\.\/extension_error\.js['"]/);

  mkdirSync(home);
  const probe = join(dist, 'probe.mjs');
  await build({
    stdin: {
      contents: `export { ExtensionError } from './extension_error.js';\n`,
      resolveDir: dist,
      sourcefile: 'probe.ts',
      loader: 'ts',
    },
    outfile: probe,
    bundle: true,
    platform: 'node',
    format: 'esm',
    plugins: [shareExtensionError()],
  });
  const worker = await import(pathToFileURL(probe).href);
  const shared = await import(
    pathToFileURL(join(dist, 'extension_error.js')).href
  );
  assert.equal(worker.ExtensionError, shared.ExtensionError);
  assert.ok(new shared.ExtensionError('x') instanceof worker.ExtensionError);

  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: join(dist, 'extensions'),
    settings: { hub: { enabled: true } },
  }).load();
  cleanup(t, () => host.close());
  const hub = host.extensions.find((ext) => ext.name === 'hub');
  assert.ok(hub, 'hub was not discovered');
  assert.equal(hub.error, '', hub.error);
  assert.equal(hub.path.endsWith(`${sep}extension.js`), true);
  assert.equal(host.commands().has('hub'), true);
});
