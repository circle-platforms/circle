import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PluginRegistry,
  effectivePlugins,
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

test('the shown plugins are the chosen plain ones and the live paired ones, whatever the chosen list says of a paired one', () => {
  const plugins = [plain, paired];
  assert.deepEqual(effectivePlugins(plugins, ['files'], [row()]), [
    'files',
    'hub',
  ]);
  assert.deepEqual(
    effectivePlugins(
      plugins,
      ['files', 'hub'],
      [row({ enabled: false })],
    ),
    ['files'],
  );
  assert.deepEqual(effectivePlugins(plugins, [], [row()]), ['hub']);
  const registry = new PluginRegistry(plugins);
  const shown = effectivePlugins(registry.plugins, ['files'], [row()]);
  assert.deepEqual(
    registry.pages(shown).map((item) => item.page.id),
    ['server'],
  );
});
