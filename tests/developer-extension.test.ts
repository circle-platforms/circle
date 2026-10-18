import { scratch, cleanup } from './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ExtensionHost, bundledExtensionsRoot } from '../src/extensions.js';
import {
  defaultSettings,
  loadSettings,
  saveSettings,
} from '../src/settings.js';
import { SessionApp } from '../src/tui/session_app.js';
import { ScriptedModel } from '../src/testing.js';

test('the developer extension is bundled, off, and lists nothing until enabled', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
  }).load();
  cleanup(t, () => host.close());
  const developer = host.extensions.find((ext) => ext.name === 'developer');
  assert.ok(developer);
  assert.equal(developer.source, 'bundled');
  assert.equal(developer.enabled, false);
  assert.equal(developer.version, '0.1.0');
  assert.deepEqual(developer.tools, []);
  assert.equal(host.commands().has('developer'), false);
  assert.match(host.describe(), /developer 0\.1\.0 \(bundled\) · off/);
});

test('/extensions enable developer saves the choice and publishes its view', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const settings = defaultSettings();
  saveSettings(settings, home);
  const app = new SessionApp(workspace, home, settings);
  const ui = app as any;
  ui.screen.render = () => {};
  await app.attach({
    workspace,
    home,
    settings,
    model: new ScriptedModel([]),
    headless: false,
    bundledExtensions: bundledExtensionsRoot(),
  });
  const runtime = app.runtime!;
  await runtime.initialize();
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
    await runtime.close();
  });
  assert.equal(
    runtime.extensions.extensions.find((ext) => ext.name === 'developer')
      ?.enabled,
    false,
  );
  await app.submit('/extensions enable developer');
  assert.equal(loadSettings(home).extensions.developer?.enabled, true);
  const enabled = runtime.extensions.extensions.find(
    (ext) => ext.name === 'developer',
  );
  assert.equal(enabled?.enabled, true);
  assert.equal(enabled?.error, '');
  assert.deepEqual(enabled?.view, { provider: 'developer', version: '0.1.0' });
  await app.submit('/extensions disable developer');
  assert.equal(loadSettings(home).extensions.developer?.enabled, false);
  assert.equal(
    runtime.extensions.extensions.find((ext) => ext.name === 'developer')
      ?.enabled,
    false,
  );
});
