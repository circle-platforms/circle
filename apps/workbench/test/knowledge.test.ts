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
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  KnowledgePage,
  KnowledgeShareRefusalNotice,
  KnowledgeSyncStatus,
} from '../src/features/KnowledgePage.tsx';
import { PreviewRuntime } from '../src/model/state.ts';
import { RuntimeProvider } from '../src/app/context.tsx';
import { MemoryRouter } from 'react-router-dom';
import { Tooltip } from 'radix-ui';
import { knowledgeShareRefusal } from '../src/model/knowledge.ts';
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

test('Hub refusal text stays verbatim and escaped in both interface languages, with uploader action instead of a network retry', () => {
  const refusal = {
    code: 'SHARE_UPLOAD_UNSIGNED' as const,
    message: '上传原文需上传人署名\n<Hub> & unchanged  ',
    fix: '请上传人在原文详情中选择“署名为团队来源…”，确认后重新预检',
  };
  assert.deepEqual(knowledgeShareRefusal({ shareRefusal: refusal }), refusal);
  assert.equal(
    knowledgeShareRefusal({
      shareRefusal: { ...refusal, code: 'SOURCE_RETRYABLE' },
    }),
    undefined,
  );
  for (const lang of ['zh-CN', 'en'] as const) {
    setLanguage(lang, storage);
    const html = renderToStaticMarkup(
      createElement(KnowledgeShareRefusalNotice, { refusal }),
    );
    assert.ok(
      html.includes('上传原文需上传人署名\n&lt;Hub&gt; &amp; unchanged  '),
    );
    assert.ok(html.includes(refusal.fix));
    assert.ok(
      html.includes(
        lang === 'zh-CN'
          ? 'Hub 未接受此次分享'
          : 'Hub did not accept this share',
      ),
    );
    assert.ok(
      html.includes(
        lang === 'zh-CN'
          ? '请上传人在 Hub 控制台为原文署名，再重新分享'
          : 'as the uploader, sign the upload in the Hub console, then share again',
      ),
    );
    assert.doesNotMatch(
      html,
      /role="alert"|reload|network|无法打开|刷新|稍后重试/,
    );
  }
  setLanguage('en', storage);
});

for (const section of ['knowledge', 'memory'] as const)
  test(`${section} shows only mine without a Hub binding, including a remote-scope URL; bound local-only keeps its scopes`, () => {
    const runtime = new PreviewRuntime(storage);
    const status = {
      server: 'configured but unbound',
      bound: false,
      condition: 'local' as const,
      mode: 'local' as const,
      clearing: false,
      lastSyncedAt: null,
    };
    runtime.getSnapshot().knowledgeSync = status;
    const render = () =>
      renderToStaticMarkup(
        createElement(
          Tooltip.Provider,
          null,
          createElement(
            MemoryRouter,
            { initialEntries: [`/page/${section}?scope=team`] },
            createElement(RuntimeProvider, {
              runtime,
              children: createElement(KnowledgePage, { section }),
            }),
          ),
        ),
      );
    for (const language of ['zh-CN', 'en'] as const) {
      setLanguage(language, storage);
      const html = render(),
        scopes = html.match(
          /class="segmented knowledge-scopes"[\s\S]*?<\/div>/,
        )![0];
      assert.equal((scopes.match(/<button/g) ?? []).length, 1);
      assert.match(scopes, /aria-pressed="true"/);
      assert.ok(scopes.includes(language === 'zh-CN' ? '我的' : 'mine'));
      assert.doesNotMatch(
        html,
        /knowledge-error|knowledge list could not load/,
      );
      const line = renderToStaticMarkup(
        createElement(KnowledgeSyncStatus, { status, onClick: () => {} }),
      );
      assert.ok(
        line.includes(
          language === 'zh-CN' ? '未连接 Hub' : 'Hub not connected',
        ),
      );
      status.bound = true;
      const connected = render().match(
        /class="segmented knowledge-scopes"[\s\S]*?<\/div>/,
      )![0];
      assert.equal((connected.match(/<button/g) ?? []).length, 3);
      assert.ok(
        connected.includes(
          language === 'zh-CN' ? '与我共享' : 'shared with me',
        ),
      );
      status.bound = false;
    }
    setLanguage('en', storage);
  });
