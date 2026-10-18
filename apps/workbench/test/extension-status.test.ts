import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionStatusText } from '../src/model/extension-status.ts';
import { setLanguage } from '../src/i18n/index.ts';
import type { RuntimeExtension } from '../src/model/types.ts';
const github = (text: string): RuntimeExtension => ({
  id: 'github',
  name: 'github',
  scope: 'bundled',
  enabled: true,
  version: '0.1.0',
  status: { text, lamp: 'none' },
  view: { provider: 'github', state: text },
  tools: [],
  commands: [],
  events: [],
});
test('only known owned GitHub state enums are localized and remain live to locale changes', () => {
  const extension = github('disconnected'),
    original = structuredClone(extension);
  setLanguage('en');
  assert.equal(extensionStatusText(extension), 'GitHub login required');
  setLanguage('zh-CN');
  assert.equal(extensionStatusText(extension), '需要登录 GitHub');
  for (const [state, expected] of [
    ['connected', '已连接 GitHub'],
    ['authorizing', '等待 GitHub 授权'],
    ['error', 'GitHub 连接出错'],
  ])
    assert.equal(extensionStatusText(github(state)), expected);
  assert.deepEqual(extension, original);
  setLanguage('en');
});
test('third-party, project, unknown and custom status content remains byte-for-byte', () => {
  setLanguage('zh-CN');
  const rows = [
    { ...github('disconnected'), scope: 'project' as const },
    { ...github('disconnected'), name: 'third-party' },
    { ...github('disconnected'), view: undefined },
    {
      ...github('disconnected'),
      view: { provider: 'other', state: 'disconnected' },
    },
    {
      ...github('disconnected'),
      view: { provider: 'github', state: 'connected' },
    },
    github('fetching log 中文\nraw detail'),
    github('future-state'),
  ];
  for (const row of rows)
    assert.equal(extensionStatusText(row), row.status!.text);
  const developerReady = {
    id: 'developer',
    name: 'developer',
    scope: 'project' as const,
    enabled: true,
    version: '0.1.0',
    status: { text: 'ready', lamp: 'ok' as const },
    view: { provider: 'developer' },
    tools: [],
    commands: [],
    events: [],
  };
  assert.equal(extensionStatusText(developerReady), 'ready');
  setLanguage('en');
});
test('the bundled developer extension ready status is interface text', () => {
  const row: RuntimeExtension = {
    id: 'developer',
    name: 'developer',
    scope: 'bundled',
    enabled: true,
    version: '0.1.0',
    status: { text: 'ready', lamp: 'ok' },
    view: { provider: 'developer', version: '0.1.0' },
    tools: [],
    commands: [],
    events: [],
  };
  setLanguage('en');
  assert.equal(extensionStatusText(row), 'ready');
  setLanguage('zh-CN');
  assert.equal(extensionStatusText(row), '就绪');
  assert.equal(
    extensionStatusText({
      ...row,
      status: { text: 'indexing', lamp: 'wait' },
    }),
    'indexing',
  );
  assert.equal(
    extensionStatusText({ ...row, view: { provider: 'other' } }),
    'ready',
  );
  setLanguage('en');
});
