import test from 'node:test';
import assert from 'node:assert/strict';
import { attention } from '../src/attention.ts';
import { nativeText, systemNativeLocale } from '../src/native-text.ts';
import type { RuntimeUpdate } from '../src/runtime-protocol.ts';

const update = (
  interactions: object[],
  state: 'idle' | 'waiting' = 'idle',
  event?: object,
): RuntimeUpdate =>
  ({
    seq: 1,
    connected: true,
    snapshot: {
      sessions: [{ id: 's1', title: 'fix add', state }],
      interactions,
    },
    event,
  }) as unknown as RuntimeUpdate;

const en = nativeText('en');
const approval = {
  id: 'i1',
  sessionId: 's1',
  kind: 'approval',
  status: 'pending',
  title: 'execute · runs a shell command',
  tool: 'execute',
  command: 'npm test',
};

test('a new request is announced once and counted on the badge', () => {
  const seen = new Set<string>();
  const first = attention(update([approval], 'waiting'), seen, en);
  assert.equal(first.badge, 1);
  assert.equal(first.busy, true);
  assert.deepEqual(first.notices, [
    {
      title: 'Circle needs your approval',
      body: 'execute · npm test',
      sessionId: 's1',
    },
  ]);
  assert.deepEqual(
    attention(update([approval], 'waiting'), seen, en).notices,
    [],
  );
  // Answered: the badge clears and the id is forgotten.
  const answered = attention(
    update([{ ...approval, status: 'recorded' }], 'waiting'),
    seen,
    en,
  );
  assert.equal(answered.badge, 0);
  assert.equal(seen.size, 0);
});

test('the end of a turn is announced, an interrupted one is not, in the window language', () => {
  const seen = new Set<string>();
  const ended = attention(
    update([], 'idle', { kind: 'run_end', sessionId: 's1', payload: {} }),
    seen,
    nativeText('zh-CN'),
  );
  assert.deepEqual(ended.notices, [
    { title: 'Circle 已完成', body: 'fix add', sessionId: 's1' },
  ]);
  assert.equal(ended.busy, false);
  assert.deepEqual(
    attention(
      update([], 'idle', {
        kind: 'run_error',
        sessionId: 's1',
        payload: { interrupted: true },
      }),
      seen,
      en,
    ).notices,
    [],
  );
  // A subagent's run is not a session of its own here.
  assert.deepEqual(
    attention(
      update([], 'idle', { kind: 'run_end', sessionId: 'child', payload: {} }),
      seen,
      en,
    ).notices,
    [],
  );
});

test('the main process words follow the window language and the system at first', () => {
  assert.equal(systemNativeLocale(['zh-Hans-CN', 'en']), 'zh-CN');
  assert.equal(systemNativeLocale(['en-GB']), 'en');
  assert.equal(nativeText('zh-CN')('open folder'), '打开文件夹');
  assert.equal(nativeText('en')('open folder'), 'open folder');
});
