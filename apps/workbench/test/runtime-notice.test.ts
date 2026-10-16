import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRuntimeNotice } from '../src/model/runtime-notice.ts';
import { setLanguage } from '../src/i18n/index.ts';
import { githubStatusNotice } from '../../../src/runtime_notice.ts';
test('runtime status localization requires the exact persisted source and canonical text, never a matching model sentence', () => {
  try {
    setLanguage('zh-CN');
    const runtimeNotice = githubStatusNotice('GitHub: connected', true)!;
    assert.equal(
      formatRuntimeNotice({
        role: 'notice',
        text: 'GitHub: connected',
        runtimeNotice,
      }),
      '已连接 GitHub',
    );
    for (const role of ['user', 'assistant', 'tool'] as const)
      assert.equal(
        formatRuntimeNotice({ role, text: 'GitHub: connected', runtimeNotice }),
        'GitHub: connected',
      );
    assert.equal(
      formatRuntimeNotice({ role: 'notice', text: 'GitHub: connected' }),
      'GitHub: connected',
    );
    assert.equal(
      formatRuntimeNotice({
        role: 'notice',
        text: 'model description GitHub: connected',
        runtimeNotice,
      }),
      'model description GitHub: connected',
    );
    assert.equal(
      formatRuntimeNotice({
        role: 'notice',
        text: 'GitHub: disconnected',
        runtimeNotice,
      }),
      'GitHub: disconnected',
    );
    assert.equal(githubStatusNotice('GitHub: connected', false), undefined);
    assert.equal(githubStatusNotice('GitHub: unknown', true), undefined);
  } finally {
    setLanguage('en');
  }
});
