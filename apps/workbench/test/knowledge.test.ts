import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLanguage } from '../src/i18n/index.ts';
import {
  knowledgeActionWords,
  knowledgeStatusText,
  knowledgeSyncLine,
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
import {
  knowledgeShareRefusal,
  unexplainedShareRefusal,
} from '../src/model/knowledge.ts';
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
  // Pending verification is the design system's muted hollow dot, not a warning.
  assert.match(
    css,
    /\.knowledge-state\.unverified > i \{\s*background: transparent;\s*box-shadow: inset 0 0 0 1\.5px var\(--status-muted\);/,
  );
  assert.doesNotMatch(
    css,
    /\.unverified\)? > i,?\s*[^{]*\{\s*background: var\(--status-warn\)/,
  );
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
});
test('boundary errors are localized without echoing raw host errors or paths', () => {
  setLanguage('zh-CN', storage);
  const message = knowledgeError(
    Error('/private/unknown.db: failure synthetic-token'),
  );
  assert.equal(message, '无法打开内容，请刷新后重试');
  assert.doesNotMatch(message, /private|token/);
  // What the sync server answered is said by its kind; its own words are shown with the status
  assert.equal(
    knowledgeError(Error('knowledge-sync-confirm')),
    '在同步服务器的页面上确认后，才能完成这次更改',
  );
  assert.equal(
    knowledgeError(Error('knowledge-sync-login')),
    '请重新登录同步服务器',
  );
  assert.equal(
    knowledgeError(Error('knowledge-sync-later')),
    '同步服务器暂时不可用，请稍后再试',
  );
  assert.equal(
    knowledgeError(Error('knowledge-sync-refused')),
    '同步服务器拒绝了这次请求',
  );
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

test('every server refusal is shown verbatim and escaped in both languages, with a stated reason when none was given', () => {
  const refusal = {
    code: 'SHARE_UPLOAD_UNSIGNED',
    message: '上传原文需上传人署名\n<Server> & unchanged  ',
    fix: '请上传人在原文详情中选择“署名为团队来源…”，确认后重新预检',
  };
  assert.deepEqual(knowledgeShareRefusal({ shareRefusal: refusal }), refusal);
  assert.deepEqual(
    knowledgeShareRefusal({
      shareRefusal: { ...refusal, code: 'SOURCE_RETRYABLE' },
    }),
    { ...refusal, code: 'SOURCE_RETRYABLE' },
  );
  assert.deepEqual(knowledgeShareRefusal({ shareRefusal: {} }), {
    code: 'REFUSED',
    message: '',
    fix: '',
  });
  assert.deepEqual(
    unexplainedShareRefusal(Error('knowledge-remote-unavailable')),
    { code: 'REFUSED', message: '', fix: '' },
  );
  assert.equal(unexplainedShareRefusal(Error('knowledge-changed')), undefined);
  assert.equal(knowledgeShareRefusal({ saved: true }), undefined);
  for (const lang of ['zh-CN', 'en'] as const) {
    setLanguage(lang, storage);
    const html = renderToStaticMarkup(
      createElement(KnowledgeShareRefusalNotice, { refusal }),
    );
    assert.ok(
      html.includes('上传原文需上传人署名\n&lt;Server&gt; &amp; unchanged  '),
    );
    assert.ok(html.includes(refusal.fix));
    assert.ok(
      html.includes(
        lang === 'zh-CN'
          ? '服务器拒绝了这次分享'
          : 'the server refused this share',
      ),
    );
    assert.doesNotMatch(
      html,
      /Hub|role="alert"|reload|network|无法打开|刷新|稍后重试|没有给出原因/,
    );
    const silent = renderToStaticMarkup(
      createElement(KnowledgeShareRefusalNotice, {
        refusal: { code: 'REFUSED', message: '', fix: '' },
      }),
    );
    assert.ok(
      silent.includes(
        lang === 'zh-CN'
          ? '服务器拒绝了这次分享，没有给出原因'
          : 'the server refused this share and gave no reason',
      ),
    );
    assert.doesNotMatch(silent, /knowledge-share-refusal-text/);
  }
  setLanguage('en', storage);
});

test('the sync line names the bound connection and never says Hub', () => {
  const base = {
    bound: true,
    mode: 'hub' as const,
    clearing: false,
    server: '团队服务器',
    lastSyncedAt: null,
  };
  setLanguage('zh-CN', storage);
  assert.equal(
    knowledgeSyncLine({ ...base, condition: 'synced' }),
    '已连接 · 团队服务器',
  );
  assert.equal(
    knowledgeSyncLine({ ...base, condition: 'conflicted' }),
    '有冲突 · 团队服务器',
  );
  assert.equal(
    knowledgeSyncLine({ ...base, condition: 'local', mode: 'local' }),
    '仅保存在本机',
  );
  assert.equal(
    knowledgeSyncLine({ ...base, bound: false, condition: 'local' }),
    '未连接同步服务器',
  );
  setLanguage('en', storage);
  assert.equal(
    knowledgeSyncLine({ ...base, condition: 'synced', server: 'team server' }),
    'connected · team server',
  );
  assert.equal(
    knowledgeSyncLine({ ...base, bound: false, condition: 'local' }),
    'sync server not connected',
  );
});

test('knowledge confirmations name their action and their notices say what was done', () => {
  setLanguage('zh-CN', storage);
  assert.deepEqual(knowledgeActionWords('share'), {
    confirm: '确认分享到团队',
    done: '已分享到团队',
  });
  assert.equal(
    knowledgeActionWords('share', { replaces: true }).confirm,
    '确认替换',
  );
  assert.equal(knowledgeActionWords('delete').confirm, '确认删除');
  assert.equal(knowledgeActionWords('resolve').confirm, '确认替换');
  assert.equal(knowledgeActionWords('create-memory').done, '已新建');
  assert.equal(
    knowledgeActionWords('enabled', { enabling: false }).confirm,
    '确认停用',
  );
  for (const action of [
    'share',
    'delete',
    'resolve',
    'create-entry',
    'edit',
    'move',
    'enabled',
    'install',
    'register-pack',
    'import',
  ])
    assert.notEqual(knowledgeActionWords(action).confirm, '确认更改');
  setLanguage('en', storage);
});

for (const section of ['knowledge', 'memory'] as const)
  test(`${section} shows only mine without a sync server binding, including a remote-scope URL; bound local-only keeps its scopes`, () => {
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
          language === 'zh-CN'
            ? '未连接同步服务器'
            : 'sync server not connected',
        ),
      );
      assert.doesNotMatch(line, /Hub/);
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
