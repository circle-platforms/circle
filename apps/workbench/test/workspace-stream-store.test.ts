import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WorkspaceStreamStore,
  type WorkspaceStreamEvent,
} from '../src/model/workspace-stream-store.ts';
const event = (
  seq: number,
  epoch = 'one',
  resourceId = 'pty',
): WorkspaceStreamEvent => ({
  workspaceId: 'w',
  sessionId: 's',
  service: 'terminal',
  resourceId,
  epoch,
  seq,
  at: 'now',
  data: { text: 'x'.repeat(100) },
  cursor: { offset: seq * 300, seq },
});
test('duplicates, reorder gaps and retired producer epochs cannot overwrite current state', () => {
  const store = new WorkspaceStreamStore();
  assert.equal(store.apply(event(1)), 'applied');
  assert.equal(store.apply(event(1)), 'duplicate');
  assert.equal(store.apply(event(3)), 'gap');
  assert.equal(store.cursor.seq, 1);
  assert.equal(store.apply(event(2)), 'applied');
  assert.equal(store.apply(event(3, 'two')), 'applied');
  assert.equal(store.apply(event(4)), 'stale-epoch');
  assert.equal(store.apply(event(4, 'two')), 'applied');
});
test('resource subscriptions coalesce and unrelated resource does not rerender', () => {
  let flush: (() => void) | undefined;
  const store = new WorkspaceStreamStore({
    schedule: (callback) => {
      flush = callback;
    },
  });
  let calls = 0,
    unrelated = 0;
  store.subscribe(WorkspaceStreamStore.resourceKey(event(1)), () => calls++);
  store.subscribe(
    WorkspaceStreamStore.resourceKey(event(1, 'one', 'other')),
    () => unrelated++,
  );
  for (let seq = 1; seq <= 100; seq++) store.apply(event(seq));
  assert.equal(calls, 0);
  flush!();
  assert.equal(calls, 1);
  assert.equal(unrelated, 0);
});
test('eight producer resources and ten thousand events keep renderer cache bounded', () => {
  const store = new WorkspaceStreamStore({
    maxBytes: 4000,
    maxEventsPerResource: 3,
  });
  for (let seq = 1; seq <= 10000; seq++)
    assert.equal(store.apply(event(seq, 'one', `agent-${seq % 8}`)), 'applied');
  assert.equal(store.cursor.seq, 10000);
  assert.ok(store.cachedBytes <= 4000);
  const key = WorkspaceStreamStore.resourceKey(event(10000, 'one', 'agent-0'));
  assert.ok(store.snapshot(key).length <= 3);
  store.reset();
  assert.equal(store.cachedBytes, 0);
  assert.equal(store.cursor.seq, 0);
  assert.equal(store.apply(event(1, 'restart')), 'applied');
});
