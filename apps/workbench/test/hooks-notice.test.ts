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
    // The words a hook wrote for the person (`user_message`) go in place of the reason the model reads
    assert.equal(
      formatHookNotice({
        kind: 'denied',
        tool: 'write_file',
        reason: 'Write to notes/ only.',
        message: 'writes stay in notes/',
      }),
      '钩子拒绝了 write_file · writes stay in notes/',
    );
    assert.doesNotMatch(
      denied.replaceAll('write_file', '').replaceAll('no writes', ''),
      /[A-Za-z]/,
    );
    assert.equal(
      formatHookNotice({ kind: 'untrusted' }),
      '项目钩子需要先信任文件夹',
    );
    // A notice from a conversation before hooks ran on folder trust stays readable
    assert.equal(
      formatHookNotice({
        kind: 'changed',
        name: '.circle/hooks.json',
      } as unknown as Parameters<typeof formatHookNotice>[0]),
      '项目钩子需要批准 · .circle/hooks.json',
    );
    // Circle's own failure words in Chinese, what the program wrote as it wrote it
    assert.equal(
      formatHookNotice({
        kind: 'failed',
        name: 'lint',
        reason: 'timed out after 2s',
      }),
      '钩子失败 · lint · 钩子运行 2 秒后超时',
    );
    assert.equal(
      formatHookNotice({ kind: 'failed', reason: 'exited 1: boom' }),
      '钩子失败 · 钩子退出码 1: boom',
    );
    assert.equal(
      formatHookNotice({ kind: 'blocked', tool: 'prompt', reason: 'not that' }),
      '钩子拦下了这条消息 · not that',
    );
    assert.equal(
      formatHookNotice({ kind: 'stopped', reason: 'all done' }),
      '钩子结束了这一轮 · all done',
    );
    assert.equal(
      formatHookNotice({ kind: 'message', name: 'audit', reason: 'logged' }),
      '钩子 audit · logged',
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
