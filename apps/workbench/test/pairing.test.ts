import test from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage } from '../src/i18n/index.ts';
import { extensionErrorText } from '../src/plugins/labels.ts';
import {
  PluginRegistry,
  effectivePlugins,
  pairing,
} from '../src/plugins/registry.ts';
import type { WorkbenchPlugin } from '../src/plugins/types.ts';
import { developerToolsEnabled } from '../src/plugins/developer.tsx';

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
  id: 'hub',
  apiVersion: 1,
  version: '0.1.0',
  title: 'hub',
  description: '',
  icon,
  runtimeExtension: 'hub',
  pages: [page('server')],
};
const row = (
  change: Partial<{ version: string; enabled: boolean; error: string }> = {},
) => ({
  name: 'hub',
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
  const knowledge: WorkbenchPlugin = {
    ...paired,
    id: 'knowledge',
    pages: [page('knowledge')],
  };
  const plugins = [plain, paired, knowledge];
  const live = [row()];
  assert.deepEqual(effectivePlugins(plugins, ['files', 'hub'], live), [
    'files',
    'hub',
  ]);
  assert.deepEqual(effectivePlugins(plugins, ['files'], live), ['files']);
  assert.deepEqual(effectivePlugins(plugins, ['hub', 'knowledge'], live), [
    'hub',
    'knowledge',
  ]);
  assert.deepEqual(
    effectivePlugins(plugins, ['files', 'hub'], [row({ enabled: false })]),
    ['files'],
  );
  const registry = new PluginRegistry(plugins);
  const shown = effectivePlugins(registry.plugins, ['files', 'hub'], live);
  assert.deepEqual(
    registry.pages(shown).map((item) => item.page.id),
    ['server'],
  );
});

test('pairing reasons and a missing module use the interface language', () => {
  setLanguage('zh-CN');
  try {
    assert.equal(pairing(paired, []).reason, '运行时扩展 枢纽 未安装');
    assert.equal(
      pairing(paired, [row({ enabled: false })]).reason,
      '运行时扩展 枢纽 已关闭',
    );
    assert.equal(
      pairing(paired, [row({ error: 'Error: Cannot find module' })]).reason,
      '运行时扩展 枢纽 加载失败',
    );
    assert.equal(
      extensionErrorText(
        "Error: Cannot find module '/opt/circle/hub_text.js' imported from extension.ts",
      ),
      '找不到模块 /opt/circle/hub_text.js',
    );
  } finally {
    setLanguage('en');
  }
  assert.match(
    pairing(paired, []).reason,
    /runtime extension hub is not installed/,
  );
});

test('developer tools follow the bundled extension and stay off until it is enabled', () => {
  assert.equal(developerToolsEnabled([]), false);
  assert.equal(
    developerToolsEnabled([
      { name: 'developer', version: '0.1.0', enabled: false },
    ]),
    false,
  );
  assert.equal(
    developerToolsEnabled([
      { name: 'developer', version: '0.1.0', enabled: true, error: 'boom' },
    ]),
    false,
  );
  assert.equal(
    developerToolsEnabled([
      { name: 'developer', version: '0.1.0', enabled: true },
    ]),
    true,
  );
});
