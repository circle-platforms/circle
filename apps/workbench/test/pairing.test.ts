import test from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage } from '../src/i18n/index.ts';
import { extensionErrorText } from '../src/plugins/labels.ts';
import {
  PluginRegistry,
  effectivePlugins,
  pairedSwitch,
  pairing,
} from '../src/plugins/registry.ts';
import type { WorkbenchPlugin } from '../src/plugins/types.ts';

const icon = (() => null) as unknown as WorkbenchPlugin['icon'];
const page = (id: string) => ({
  id,
  title: id,
  icon,
  component: () => null,
});
const plain: WorkbenchPlugin = {
  id: 'files',
  apiVersion: 1,
  version: '0.1.0',
  title: 'files',
  description: '',
  icon,
};
const paired: WorkbenchPlugin = {
  id: 'connector',
  apiVersion: 1,
  version: '0.1.0',
  title: 'connector',
  description: '',
  icon,
  runtimeExtension: 'connector',
  pages: [page('connection')],
};
const row = (
  change: Partial<{ version: string; enabled: boolean; error: string }> = {},
) => ({
  name: 'connector',
  version: '0.1.0',
  enabled: true,
  ...change,
});

test('a paired plugin shows exactly while its runtime extension is installed, loaded, on and of its version', () => {
  assert.deepEqual(pairing(paired, [row()]), { live: true, reason: '' });
  assert.match(pairing(paired, []).reason, /not installed/);
  assert.match(pairing(paired, [row({ enabled: false })]).reason, /is off/);
  assert.match(
    pairing(paired, [row({ error: 'boom' })]).reason,
    /failed to load/,
  );
  assert.match(
    pairing(paired, [row({ version: '0.2.0' })]).reason,
    /is 0\.2\.0, this interface is 0\.1\.0/,
  );
  assert.equal(pairing(plain, []).live, true);
});

test('a paired page shows only when it is chosen and its extension is live', () => {
  const reports: WorkbenchPlugin = {
    ...paired,
    id: 'reports',
    pages: [page('reports')],
  };
  const plugins = [plain, paired, reports];
  const live = [row()];
  assert.deepEqual(effectivePlugins(plugins, ['files', 'connector'], live), [
    'files',
    'connector',
  ]);
  assert.deepEqual(effectivePlugins(plugins, ['files'], live), ['files']);
  assert.deepEqual(effectivePlugins(plugins, ['connector', 'reports'], live), [
    'connector',
    'reports',
  ]);
  assert.deepEqual(
    effectivePlugins(
      plugins,
      ['files', 'connector'],
      [row({ enabled: false })],
    ),
    ['files'],
  );
  const registry = new PluginRegistry(plugins);
  const shown = effectivePlugins(
    registry.plugins,
    ['files', 'connector'],
    live,
  );
  assert.deepEqual(
    registry.pages(shown).map((item) => item.page.id),
    ['connection'],
  );
});

test('a page chosen in an earlier version that the application no longer has is ignored', () => {
  // Earlier versions had a developer page paired with a developer extension.
  const extensions = [
    row(),
    { name: 'developer', version: '0.1.0', enabled: true },
  ];
  assert.deepEqual(
    effectivePlugins(
      [plain, paired],
      ['developer', 'files', 'connector'],
      extensions,
    ),
    ['files', 'connector'],
  );
  assert.deepEqual(
    new PluginRegistry([plain, paired])
      .pages(effectivePlugins([plain, paired], ['developer'], extensions))
      .map((item) => item.page.id),
    [],
  );
});

test('pairing reasons and a missing module use the interface language', () => {
  setLanguage('zh-CN');
  try {
    assert.equal(pairing(paired, []).reason, '运行时扩展 connector 未安装');
    assert.equal(
      pairing(paired, [row({ enabled: false })]).reason,
      '运行时扩展 connector 已关闭',
    );
    assert.equal(
      pairing(paired, [row({ error: 'Error: Cannot find module' })]).reason,
      '运行时扩展 connector 加载失败',
    );
    assert.equal(
      extensionErrorText(
        "Error: Cannot find module '/opt/circle/extension_error.js' imported from extension.ts",
      ),
      '找不到模块 /opt/circle/extension_error.js',
    );
  } finally {
    setLanguage('en');
  }
  assert.match(
    pairing(paired, []).reason,
    /runtime extension connector is not installed/,
  );
});

test('of two pages of one extension, switching one off keeps the extension on for the other; the last one off turns it off', () => {
  const reports: WorkbenchPlugin = {
    ...paired,
    id: 'reports',
    pages: [page('reports')],
  };
  const registry = new PluginRegistry([plain, paired, reports]);
  // Turning a page on turns the extension on and leaves the other page as it was
  assert.deepEqual(pairedSwitch(registry, ['files'], 'connector', true), {
    chosen: ['files', 'connector'],
    extension: true,
  });
  const both = ['files', 'connector', 'reports'];
  assert.deepEqual(pairedSwitch(registry, both, 'connector', false), {
    chosen: ['files', 'reports'],
    extension: true,
  });
  assert.deepEqual(
    pairedSwitch(registry, ['files', 'reports'], 'reports', false),
    { chosen: ['files'], extension: false },
  );
  // A page an earlier version had is not counted as one of the extension's
  assert.deepEqual(
    pairedSwitch(registry, ['developer', 'connector'], 'connector', false),
    { chosen: [], extension: false },
  );
});
