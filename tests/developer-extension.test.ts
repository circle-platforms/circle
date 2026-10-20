import { scratch, cleanup } from './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExtensionHost, bundledExtensionsRoot } from '../src/extensions.js';
import {
  defaultSettings,
  loadSettings,
  saveSettings,
} from '../src/settings.js';
import { SessionApp } from '../src/tui/session_app.js';
import { ScriptedModel } from '../src/testing.js';

// Earlier versions shipped a developer extension for the desktop's debugger and
// language service. Its entry in settings.json may still turn it on.
function earlierSettings(home: string) {
  const settings = defaultSettings();
  settings.extensions.developer = { enabled: true };
  saveSettings(settings, home);
  return loadSettings(home);
}

test('a developer extension turned on by an earlier version is not listed, fails nothing and stays in settings', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const settings = earlierSettings(home);
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundledExtensionsRoot(),
    settings: settings.extensions,
  }).load();
  cleanup(t, () => host.close());
  assert.ok(host.extensions.some((ext) => ext.name === 'github'));
  assert.equal(
    host.extensions.some((ext) => ext.name === 'developer'),
    false,
  );
  assert.deepEqual(
    host.extensions.filter((ext) => ext.error || ext.warnings.length),
    [],
  );
  assert.doesNotMatch(host.describe(), /developer/);
  assert.deepEqual(loadSettings(home).extensions.developer, { enabled: true });
});

test('/extensions enable developer names no extension and leaves the saved entry alone', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const settings = earlierSettings(home);
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
    runtime.extensions.extensions.some((ext) => ext.name === 'developer'),
    false,
  );
  await app.submit('/extensions disable developer');
  assert.match(
    String(app.state.notices.at(-1)),
    /No extension named developer/,
  );
  await app.submit('/extensions enable developer');
  assert.match(
    String(app.state.notices.at(-1)),
    /No extension named developer/,
  );
  assert.deepEqual(loadSettings(home).extensions.developer, { enabled: true });
});

test('a leftover developer folder from an older install is not an extension', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  const bundled = join(root, 'bundled');
  mkdirSync(workspace);
  for (const folder of [
    join(bundled, 'developer'),
    join(home, 'extensions', 'developer'),
  ]) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, 'extension.json'),
      JSON.stringify({
        version: '0.1.0',
        description: 'Node debugging and the language service',
      }),
    );
    writeFileSync(
      join(folder, 'extension.mjs'),
      'export function register() {}',
    );
  }
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundled,
  }).load();
  cleanup(t, () => host.close());
  assert.equal(
    host.extensions.some((ext) => ext.name === 'developer'),
    false,
  );
  assert.doesNotMatch(host.describe(), /developer/);
  assert.doesNotMatch(host.describe(), /Node debugging/);
});
