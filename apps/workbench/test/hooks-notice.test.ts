import assert from 'node:assert/strict';
import test from 'node:test';
import { setLanguage } from '../src/i18n/index.ts';
import { formatHookNotice } from '../src/model/runtime-notice.ts';

test('a hook notice in zh-CN is Chinese and keeps the hook reason and tool name', () => {
  try {
    setLanguage('zh-CN');
    const denied = formatHookNotice({
      kind: 'denied',
      tool: 'write_file',
      reason: 'no writes',
    });
    assert.equal(denied, '钩子拒绝了 write_file · no writes');
    assert.doesNotMatch(
      denied.replaceAll('write_file', '').replaceAll('no writes', ''),
      /[A-Za-z]/,
    );
    assert.equal(
      formatHookNotice({ kind: 'untrusted' }),
      '项目钩子需要先信任文件夹',
    );
    assert.equal(
      formatHookNotice({
        kind: 'active',
        count: 2,
        reason: 'gate (before_tool, project)',
      }),
      '钩子已启用 · 2 · gate (before_tool, project)',
    );
    assert.equal(
      formatHookNotice({ kind: 'blocked', reason: 'tests failed' }),
      '钩子阻止了结束 · tests failed',
    );
  } finally {
    setLanguage('en');
  }
});
