import assert from 'node:assert/strict';
import test from 'node:test';
import { setLanguage } from '../src/i18n/index.ts';
import { formatHookNotice } from '../src/model/runtime-notice.ts';
import { shownMessageText } from '../src/components/MessageView.tsx';
import type { Message } from '../src/model/types.ts';

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
    // The files stay as written; the words say how to be asked again.
    assert.equal(
      formatHookNotice({ kind: 'changed', name: '.circle/hooks.json' }),
      '项目钩子需要批准 · .circle/hooks.json · 新对话会再问一次',
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
    assert.equal(
      formatHookNotice({
        kind: 'failed',
        name: 'lint',
        reason: 'hook timed out',
      }),
      '钩子失败 · lint · 钩子超时',
    );
    assert.equal(
      formatHookNotice({ kind: 'failed', reason: 'hook output is not JSON' }),
      '钩子失败 · 钩子输出不是合法 JSON',
    );
    assert.equal(
      formatHookNotice({ kind: 'failed', reason: 'hook exited 2' }),
      '钩子失败 · 钩子退出码 2',
    );
    assert.equal(
      formatHookNotice({ kind: 'allowed', tool: 'write_file', reason: 'safe' }),
      '钩子允许了 write_file · safe',
    );
    assert.equal(
      formatHookNotice({
        kind: 'asked',
        tool: 'write_file',
        reason: 'look first',
      }),
      '钩子要求确认 write_file · look first',
    );
    assert.equal(
      shownMessageText({
        role: 'notice',
        text: 'hook allowed write_file · safe',
        hookNotice: { kind: 'allowed', tool: 'write_file', reason: 'safe' },
      } as Message),
      '钩子允许了 write_file · safe',
    );
  } finally {
    setLanguage('en');
  }
});
