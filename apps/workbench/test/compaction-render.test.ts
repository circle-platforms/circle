import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CompactionStatus } from '../src/features/CompactionStatus.tsx';
import { TurnClock } from '../src/components/TurnClock.tsx';
import { compactionOutcomeText } from '../src/model/compaction.ts';
import { setLanguage } from '../src/i18n/index.ts';
import type { CompactionSnapshot } from '../../../src/compaction.ts';

const progress: CompactionSnapshot = {
  operationId: 'op',
  sessionId: 'session',
  branchHead: 'head',
  trigger: 'tool',
  status: 'running',
  stage: 'merging',
  startedAt: 1,
  updatedAt: 2,
  completed: 2,
  total: 3,
  covered: 100,
  sourceSize: 100,
  attempts: 2,
  recoveries: 0,
  usage: { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 0 },
  unknownCalls: 0,
  liveTokens: 12,
  recoverable: false,
};
test('manual desktop compaction renders without a normal turn in both interface languages', () => {
  setLanguage('en');
  const english = renderToStaticMarkup(
    createElement(CompactionStatus, { state: progress }),
  );
  assert.match(english, /merging 2\/3/);
  assert.doesNotMatch(english, /↑|↓|1000|112|usage/);
  setLanguage('zh-CN');
  assert.match(
    renderToStaticMarkup(
      createElement(TurnClock, {
        turn: {
          startedAt: Date.now(),
          waited: 0,
          tokens: 3,
          verb: 'compacting',
        },
      }),
    ),
    /正在压缩/,
  );
  const chinese = renderToStaticMarkup(
    createElement(CompactionStatus, {
      state: { ...progress, trigger: 'auto' },
    }),
  );
  assert.match(chinese, /正在合并 2\/3/);
  assert.doesNotMatch(chinese, /自动|↑|↓|用量/);
  assert.match(
    renderToStaticMarkup(
      createElement(CompactionStatus, {
        state: { ...progress, stage: 'summarizing' },
      }),
    ),
    /正在压缩 2\/3/,
  );
  assert.match(
    compactionOutcomeText({
      ...progress,
      status: 'failed',
      failureCode: 'context_limit',
    }),
    /上下文已满/,
  );
  assert.match(
    compactionOutcomeText({
      ...progress,
      status: 'failed',
      failureCode: 'context_limit',
      error: 'request does not fit the model context budget',
    }),
    /请求无法放入模型上下文预算/,
  );
  assert.match(
    compactionOutcomeText({ ...progress, status: 'cancelled' }),
    /已完成的部分已保存/,
  );
  assert.equal(
    renderToStaticMarkup(
      createElement(CompactionStatus, {
        state: { ...progress, status: 'succeeded' },
      }),
    ),
    '',
  );
  setLanguage('en');
});
