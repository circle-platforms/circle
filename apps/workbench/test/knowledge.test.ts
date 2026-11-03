import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLanguage } from '../src/i18n/index.ts';
import {
  knowledgeStatusText,
  knowledgeError,
  knowledgeLocation,
  knowledgeUpdated,
} from '../src/model/knowledge.ts';
import {
  settingsGroups,
  settingsSectionOf,
} from '../src/model/settings-sections.ts';
import { PluginRegistry } from '../src/plugins/registry.ts';
const storage = {
  length: 0,
  getItem: () => null,
  setItem: () => {},
  clear: () => {},
  removeItem: () => {},
  key: () => null,
};
test('the sync line names actual conditions in both languages and never shows a purge as complete', () => {
  setLanguage('zh-CN', storage);
  const base = {
    mode: 'hub' as const,
    clearing: false,
    server: 'selected',
    lastSyncedAt: null,
  };
  for (const [condition, label] of [
    ['synced', '已同步'],
    ['pending', '等待同步中'],
    ['offline', '无法连接'],
    ['login-required', '需要重新登录'],
    ['conflicted', '有冲突'],
  ] as const)
    assert.equal(knowledgeStatusText({ ...base, condition }), label);
  assert.equal(
    knowledgeStatusText({
      ...base,
      condition: 'local',
      mode: 'local',
      clearing: true,
    }),
    '等待清除中',
  );
  assert.equal(
    knowledgeStatusText({ ...base, condition: 'local', mode: 'local' }),
    '仅保存在本机',
  );
  setLanguage('en', storage);
  assert.equal(knowledgeStatusText({ ...base, condition: 'synced' }), 'synced');
  assert.equal(
    knowledgeStatusText({ ...base, condition: 'offline' }),
    'cannot connect',
  );
});
test('sync settings has its own section and plugin pages cannot replace the new built-in pages', () => {
  assert.equal(settingsSectionOf('/page/sync'), 'sync');
  assert.equal(settingsSectionOf('/page/knowledge'), null);
  assert.ok(
    settingsGroups({ live: true, network: false })
      .flatMap((g) => g.sections)
      .some((s) => s.id === 'sync'),
  );
  for (const id of ['knowledge', 'memory', 'workflows'])
    assert.throws(
      () =>
        new PluginRegistry([
          {
            id: 'synthetic',
            apiVersion: 1,
            name: 'synthetic',
            pages: [{ id, title: id, icon: () => null, component: () => null }],
          },
        ] as any),
      /reserved/,
    );
});
test('knowledge CSS follows the pane boundary, token surfaces and independent status text/dots', () => {
  const css = readFileSync(
    new URL('../src/features/knowledge.css', import.meta.url),
    'utf8',
  );
  assert.match(css, /380px/);
  assert.match(css, /max-width:\s*1179px/);
  assert.match(css, /var\(--drawer\)/);
  assert.match(css, /var\(--status-pass-text\)/);
  assert.match(css, /var\(--positive\)/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
});
test('boundary errors are localized without echoing raw host errors or paths', () => {
  setLanguage('zh-CN', storage);
  const message = knowledgeError(
    Error('/private/unknown.db: failure synthetic-token'),
  );
  assert.equal(message, '无法打开内容，请刷新后重试');
  assert.doesNotMatch(message, /private|token/);
  setLanguage('en', storage);
});

test('display locations use space names and hierarchy separators, and times never invent an update', () => {
  setLanguage('zh-CN', storage);
  assert.equal(knowledgeLocation('/', 'personal'), '');
  assert.equal(knowledgeLocation('/', 'personal', true), '我的');
  assert.equal(
    knowledgeLocation('/Native folder/child', 'personal'),
    '我的 › Native folder › child',
  );
  assert.equal(knowledgeLocation('/notes', 'team'), '团队 › notes');
  assert.equal(knowledgeUpdated(null), '更新时间未知');
  assert.equal(
    knowledgeUpdated('2026-11-03T08:49:00', new Date('2026-11-03T10:00:00')),
    '今天 08:49 更新',
  );
  setLanguage('en', storage);
  assert.equal(knowledgeLocation('/', 'personal', true), 'mine');
});
