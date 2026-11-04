import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ConversationPlan,
  ConversationJobs,
} from '../src/features/ConversationChrome.tsx';
import { CircleMark } from '../src/components/CircleMark.tsx';
import { setLanguage } from '../src/i18n/index.ts';
import type { Session, Job } from '../src/model/types.ts';

test('the inline plan retains step text and distinguishes current, completed and pending', () => {
  const session = {
    id: 'one',
    todos: [
      { id: 'a', text: 'Read source', status: 'completed' },
      { id: 'b', text: 'Fix synthetic fixture', status: 'running' },
      { id: 'c', text: 'Run checks', status: 'pending' },
    ],
  } as Session;
  const html = renderToStaticMarkup(
    createElement(ConversationPlan, { session }),
  );
  assert.match(html, /1 \/ 3/);
  assert.match(html, /data-state="running" aria-current="step"/);
  assert.match(html, /Read source/);
  assert.match(html, /Run checks/);
  assert.equal(
    renderToStaticMarkup(
      createElement(ConversationPlan, {
        session: {
          ...session,
          todos: session.todos.map((todo) => ({
            ...todo,
            status: 'completed' as const,
          })),
        },
      }),
    ),
    '',
  );
});
test('the composer footer lists only this session’s active jobs and no usage', () => {
  setLanguage('en');
  const session = {
    id: 'one',
    meters: {
      input: 1400,
      output: 600,
      inputUnknown: false,
      cacheRead: 0,
      cost: '$0.01',
      contextInput: 1400,
      contextWindow: 16000,
    },
  } as Session;
  const jobs = [
    {
      id: 'j1',
      sessionId: 'one',
      state: 'running',
      title: 'synthetic test',
      elapsed: '2s',
    },
    { id: 'j2', sessionId: 'other', state: 'running', title: 'foreign' },
    { id: 'j3', sessionId: 'one', state: 'completed', title: 'finished' },
  ] as Job[];
  const html = renderToStaticMarkup(
    createElement(ConversationJobs, { session, jobs }),
  );
  assert.match(html, /synthetic test/);
  assert.match(html, /2s/);
  assert.doesNotMatch(html, /foreign|finished/);
  assert.doesNotMatch(html, /↑|↓|1\.4k|600|context|cache|\$0\.01/);
  assert.equal(
    renderToStaticMarkup(
      createElement(ConversationJobs, { session, jobs: jobs.slice(1) }),
    ),
    '',
  );
});
test('Circle logo retains the four SVG arcs, joins and unique gradient identities', () => {
  const html = renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(CircleMark),
      createElement(CircleMark),
    ),
  );
  assert.equal((html.match(/<path /g) ?? []).length, 8);
  assert.equal((html.match(/stroke-width="14"/g) ?? []).length, 2);
  assert.match(html, /M64 20 A44 44 0 0 1 108 64/);
  const ids = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.equal(new Set(ids).size, 8);
});
