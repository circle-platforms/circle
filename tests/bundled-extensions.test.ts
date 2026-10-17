import { scratch, cleanup } from './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { ExtensionHost, bundledExtensionsRoot } from '../src/extensions.js';
import { SessionApp } from '../src/tui/session_app.js';
import { ScriptedModel } from '../src/testing.js';
import {
  defaultSettings,
  loadSettings,
  saveSettings,
} from '../src/settings.js';

const schema = '{type:"object",properties:{}}';
function extension(
  root: string,
  name: string,
  tool: string,
  manifest?: Record<string, unknown>,
): void {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'extension.mjs'),
    `export function register(api){api.registerTool('${tool}','${tool}',${schema},()=>'${tool}',{readOnly:true})}`,
  );
  if (manifest)
    writeFileSync(join(path, 'extension.json'), JSON.stringify(manifest));
}

test('bundled extensions are listed before they load, still off and with nothing registered', (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  const bundled = join(root, 'bundled');
  mkdirSync(workspace);
  extension(bundled, 'connector', 'connect', {
    version: '0.3.0',
    description: 'Connect to a team server',
  });
  const host = new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundled,
  });
  const connector = host.extensions.find((ext) => ext.name === 'connector');
  assert.ok(connector);
  assert.equal(connector.source, 'bundled');
  assert.equal(connector.enabled, false);
  assert.equal(connector.version, '0.3.0');
  assert.deepEqual(connector.tools, []);
  assert.equal(host.tools().length, 0);
  assert.equal(host.commands().size, 0);
});

test('an untrusted folder is not catalogued, and a file where extensions belong waits for load', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  const bundled = join(root, 'bundled');
  mkdirSync(workspace);
  mkdirSync(home);
  extension(bundled, 'connector', 'connect', { version: '0.3.0' });
  const untrusted = new ExtensionHost({
    home,
    workspace,
    trusted: false,
    bundledRoot: bundled,
  });
  assert.deepEqual(untrusted.extensions, []);
  writeFileSync(join(home, 'extensions'), 'not a directory');
  const broken = new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundled,
  });
  assert.deepEqual(broken.extensions, []);
  await assert.rejects(broken.load(), /ENOTDIR/);
});

test('bundled extensions are found in their own folder, stay off until enabled, and yield to yours', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  const bundled = join(root, 'bundled');
  mkdirSync(workspace);
  extension(bundled, 'connector', 'connect', {
    version: '0.3.0',
    description: 'Connect to a team server',
  });
  extension(bundled, 'shadowed', 'bundled_tool');
  extension(join(home, 'extensions'), 'shadowed', 'user_tool');

  const fresh = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundled,
  }).load();
  const connector = fresh.extensions.find((ext) => ext.name === 'connector')!;
  assert.equal(connector.source, 'bundled');
  assert.equal(connector.enabled, false);
  assert.equal(connector.version, '0.3.0');
  assert.deepEqual(
    fresh.tools().map((tool) => tool.name),
    ['user_tool'],
  );
  assert.match(
    fresh.describe(),
    /connector 0\.3\.0 \(bundled\) · off · \/extensions enable connector\n {2}Connect to a team server/,
  );
  assert.equal(
    fresh.extensions.find((ext) => ext.name === 'shadowed')!.source,
    'user',
  );

  const enabled = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: bundled,
    settings: { connector: { enabled: true } },
  }).load();
  assert.deepEqual(
    enabled
      .tools()
      .map((tool) => tool.name)
      .sort(),
    ['connect', 'user_tool'],
  );
  const none = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: false,
  }).load();
  assert.ok(!none.extensions.some((ext) => ext.source === 'bundled'));
  assert.ok(bundledExtensionsRoot().endsWith(`${sep}extensions${sep}`));
});

test('an extension reads its own settings entry and gets a private data folder of its own', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const path = join(home, 'extensions', 'probe');
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'extension.mjs'),
    `export function register(api){api.registerTool('probe','probe',${schema},()=>{const s=api.settings;s.url='changed';return {url:api.settings.url,dir:api.dataDir}},{readOnly:true})}`,
  );
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: false,
    settings: { probe: { url: 'http://127.0.0.1:7410' } },
  }).load();
  const output = JSON.parse(
    await host.tools()[0]!.run({}, {
      signal: new AbortController().signal,
      sessionId: 'test',
    } as never),
  );
  assert.equal(output.url, 'http://127.0.0.1:7410');
  assert.equal(output.dir, join(home, 'extension_data', 'probe'));
  if (process.platform !== 'win32')
    assert.equal(statSync(output.dir).mode & 0o777, 0o700);
});

test('/extensions enable and disable save the choice and reload the extension', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  const bundled = join(root, 'bundled');
  mkdirSync(workspace);
  extension(bundled, 'connector', 'connect', { version: '0.3.0' });
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
    bundledExtensions: bundled,
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
  assert.deepEqual(runtime.extensions.tools(), []);
  await app.submit('/extensions enable connector');
  assert.equal(loadSettings(home).extensions.connector?.enabled, true);
  assert.deepEqual(
    runtime.extensions.tools().map((tool) => tool.name),
    ['connect'],
  );
  assert.ok(app.state.notices.includes('connector enabled'));
  await app.submit('/extensions disable connector');
  assert.equal(loadSettings(home).extensions.connector?.enabled, false);
  assert.deepEqual(runtime.extensions.tools(), []);
  await app.submit('/extensions enable nothing-here');
  assert.match(
    String(app.state.notices.at(-1)),
    /No extension named nothing-here/,
  );
});

test('one tool and one command are singular on the extension line', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const path = join(home, 'extensions', 'solo');
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'extension.mjs'),
    `export function register(api) {
      api.registerTool('solo_tool', 'one tool', { type: 'object', properties: {} }, () => 'ok', { readOnly: true });
      api.registerCommand('solo', 'one command', async () => {});
    }`,
  );
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
  }).load();
  const line = host.describe();
  assert.match(line, /1 tool · 1 command/);
  assert.equal(line.includes('1 tools'), false);
  assert.equal(line.includes('1 commands'), false);
});
