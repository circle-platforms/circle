import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { ExtensionHost, bundledExtensionsRoot } from '../src/extensions.js';
import { scratch, cleanup } from './helpers.js';

test('only hub is registered and an old extension setting cannot enable it', async (t) => {
  const home = join(scratch(t), 'home');
  const old = await new ExtensionHost({
    home,
    workspace: home,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { 'circle-server': { enabled: true } },
  }).load();
  cleanup(t, () => old.close());
  assert.equal(
    old.extensions.some((e) => e.name === 'circle-server'),
    false,
  );
  assert.equal(old.commands().has('server'), false);
  assert.equal(old.commands().has('hub'), false);
  await old.close();
  const current = await new ExtensionHost({
    home,
    workspace: home,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: { hub: { enabled: true } },
  }).load();
  cleanup(t, () => current.close());
  assert.equal(current.commands().has('hub'), true);
  assert.equal(current.commands().has('server'), false);
  const names = current.tools().map((tool) => tool.name);
  assert.ok(names.includes('hub_packs'));
  assert.ok(names.includes('hub_submit'));
  assert.equal(
    names.some(
      (name) => name.startsWith('circle_server_') || name.startsWith('srv_'),
    ),
    false,
  );
});
