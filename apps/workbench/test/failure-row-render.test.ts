import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Tooltip from '@radix-ui/react-tooltip';
import { RuntimeNotice } from '../src/components/MessageView.tsx';
import { CompactionOutcome } from '../src/features/CompactionStatus.tsx';
import { completionNoticeText } from '../src/model/completion.ts';
import { compactionOutcomeText } from '../src/model/compaction.ts';
import { setLanguage } from '../src/i18n/index.ts';
import type { Message } from '../src/model/types.ts';
import type { CompactionSnapshot } from '../../../src/compaction.ts';

const provided = (children: ReactNode) =>
  createElement(Tooltip.Provider, null, children);
const notice = (message: Message) =>
  renderToStaticMarkup(
    provided(
      createElement(RuntimeNotice, {
        message: { ...message, text: completionNoticeText(message) },
        onConnection: () => {},
        onMessage: () => {},
      }),
    ),
  );

test('a failed turn restored from the history is the same failure line as when it happened', () => {
  setLanguage('en');
  const happened = notice({
    id: 'failure-live',
    parentId: 'turn',
    role: 'notice',
    text: '✖ model output limit reached; response incomplete',
    completionFailure: 'output_limit',
    at: '2026-11-09T00:00:00Z',
  });
  const restored = notice({
    id: 'completion-node',
    parentId: 'node',
    role: 'notice',
    text: '✖ model output limit reached; response incomplete',
    completionFailure: 'output_limit',
    at: '2026-11-09T00:00:00Z',
  });
  for (const markup of [happened, restored]) {
    assert.match(markup, /class="line-row failure-row" role="alert"/);
    assert.match(
      markup,
      /<span class="runtime-failure-cause">✖ model output limit reached; response incomplete<\/span>/,
    );
    assert.match(markup, /aria-expanded="false"/);
  }
  // An ordinary notice stays a notice
  const quoted = notice({
    id: 'quoted',
    parentId: 'turn',
    role: 'notice',
    text: '✖ 404 is quoted text, not a runtime failure',
    at: '2026-11-09T00:00:00Z',
  });
  assert.doesNotMatch(quoted, /role="alert"/);
  assert.match(quoted, /class="transcript-notice"/);
});

test("a compaction's outcome marks only success; a failure keeps its one cross", () => {
  setLanguage('en');
  const base: CompactionSnapshot = {
    operationId: 'op',
    sessionId: 'session',
    branchHead: 'head',
    trigger: 'tool',
    status: 'succeeded',
    stage: 'done',
    startedAt: 0,
    updatedAt: 1,
    completed: 1,
    total: 1,
    covered: 1,
    sourceSize: 1,
    attempts: 1,
    recoveries: 0,
    usage: { input_tokens: 13, output_tokens: 3, cache_read_tokens: 0 },
    unknownCalls: 0,
    liveTokens: 0,
    recoverable: false,
    tokensBefore: 120_000,
    tokensAfter: 8_000,
    summarized: 37,
  };
  const outcome = (state: CompactionSnapshot) =>
    renderToStaticMarkup(
      createElement(CompactionOutcome, {
        state,
        text: compactionOutcomeText(state),
      }),
    );
  const done = outcome(base);
  assert.match(done, /data-state="succeeded"/);
  assert.match(done, /<svg[^>]*lucide-check/);
  const failed = outcome({
    ...base,
    status: 'failed',
    failureCode: 'filtered',
  });
  assert.match(failed, /data-state="failed"/);
  assert.doesNotMatch(failed, /<svg/);
  assert.equal(failed.match(/✖/g)?.length, 1);
  const interrupted = outcome({ ...base, status: 'interrupted' });
  assert.doesNotMatch(interrupted, /<svg|✖/);
});
