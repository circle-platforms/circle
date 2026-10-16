import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainPreview, sessionRowLabel } from '../src/tui/session_label.js';

test('a shared title drops markdown and stays distinct', () => {
  assert.equal(plainPreview('**递归** 的例子'), '递归 的例子');
  const store = {
    messages(id: string) {
      return [
        {
          role: 'assistant',
          content: id === 'a' ? '**月亮** 很圆' : '**桂花** 糕',
        },
      ];
    },
  };
  const sessions = [
    { id: 'a', title: '中秋节 800 字文章' },
    { id: 'b', title: '中秋节 800 字文章' },
  ];
  assert.equal(
    sessionRowLabel(sessions[0]!, sessions, store),
    '中秋节 800 字文章 · 月亮 很圆',
  );
  assert.notEqual(
    sessionRowLabel(sessions[0]!, sessions, store),
    sessionRowLabel(sessions[1]!, sessions, store),
  );
});
