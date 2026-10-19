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

test('atomic cache/cursor checkpoint restores recent resources and continues replay', () => {
  const original = new WorkspaceStreamStore({ maxEventsPerResource: 2 });
  for (let seq = 1; seq <= 10; seq++)
    original.apply(event(seq, seq < 9 ? 'old' : 'new', `agent-${seq % 2}`));
  const checkpoint = original.checkpoint();
  const reloaded = new WorkspaceStreamStore({ maxEventsPerResource: 2 });
  assert.equal(reloaded.restore(checkpoint), true);
  assert.equal(reloaded.cursor.seq, 10);
  const key = WorkspaceStreamStore.resourceKey(event(10, 'new', 'agent-0'));
  assert.deepEqual(
    reloaded.snapshot(key).map((row) => row.seq),
    [8, 10],
  );
  assert.equal(reloaded.apply(event(11, 'old')), 'stale-epoch');
  assert.equal(reloaded.apply(event(11, 'new')), 'applied');
  checkpoint.resources[0].events[0].data.text = 'external mutation';
  assert.notEqual(
    reloaded.snapshot(checkpoint.resources[0].key)[0].data.text,
    'external mutation',
  );
});
test('cursor-only, missing endpoint, oversized and malformed checkpoints fail atomically', () => {
  const store = new WorkspaceStreamStore({ maxBytes: 1000 });
  store.apply(event(1));
  const valid = store.checkpoint();
  assert.equal(store.restore({ version: 1, cursor: valid.cursor }), false);
  assert.equal(store.restore({ ...valid, resources: [] }), false);
  assert.equal(
    store.restore({ ...valid, cursor: { ...valid.cursor, seq: 2 } }),
    false,
  );
  const invalid = structuredClone(valid);
  invalid.resources[0].key = 'forged';
  assert.equal(store.restore(invalid), false);
  const enormous = structuredClone(valid);
  enormous.resources[0].events[0].data.text = 'x'.repeat(70000);
  assert.equal(store.restore(enormous), false);
  assert.equal(store.cursor.seq, 1);
  assert.deepEqual(store.checkpoint(), valid);
});

test('rolling UTF8 accounting is exact across trimming, eviction, reset and checkpoint restoration', () => {
  const store = new WorkspaceStreamStore({
    maxEventsPerResource: 3,
    maxBytes: 1400,
    schedule: () => {},
  });
  const exact = () =>
    store
      .checkpoint()
      .resources.reduce(
        (sum, resource) =>
          sum +
          new TextEncoder().encode(JSON.stringify(resource.events)).byteLength,
        0,
      );
  for (let seq = 1; seq <= 24; seq++) {
    const next = event(seq, 'one', seq % 2 ? '中文' : 'other');
    next.data = {
      text: '中文🙂\n"\\'.repeat((seq % 4) + 1),
      nested: { value: seq },
    };
    assert.equal(store.apply(next), 'applied');
    assert.equal(store.cachedBytes, exact());
    assert.ok(store.cachedBytes <= 1400);
  }
  const restored = new WorkspaceStreamStore({
    maxEventsPerResource: 3,
    maxBytes: 1400,
    schedule: () => {},
  });
  assert.equal(restored.restore(store.checkpoint()), true);
  assert.equal(restored.cachedBytes, store.cachedBytes);
  const restoredResource = restored.checkpoint().resources[0]!;
  assert.throws(() => {
    restored.snapshot(restoredResource.key)[0]!.data.text =
      'cannot mutate owned replay';
  }, TypeError);
  for (let seq = 25; seq <= 30; seq++) {
    assert.equal(restored.apply(event(seq, 'one', '中文')), 'applied');
    assert.equal(
      restored.cachedBytes,
      restored
        .checkpoint()
        .resources.reduce(
          (sum, r) =>
            sum + new TextEncoder().encode(JSON.stringify(r.events)).byteLength,
          0,
        ),
    );
  }
  restored.reset();
  assert.equal(restored.cachedBytes, 0);
  assert.equal(restored.apply(event(1, 'new')), 'applied');
  assert.equal(
    restored.cachedBytes,
    new TextEncoder().encode(
      JSON.stringify(
        restored.snapshot(WorkspaceStreamStore.resourceKey(event(1))),
      ),
    ).byteLength,
  );
});

test('owned snapshots cannot be changed by caller mutation, and retained events serialize only once', () => {
  const store = new WorkspaceStreamStore({
    maxEventsPerResource: 128,
    schedule: () => {},
  });
  let serialized = 0;
  const original = event(1);
  original.data = { nested: { text: 'original' } };
  store.apply(original);
  (original.data.nested as { text: string }).text = 'caller changed';
  original.cursor.seq = 999;
  const key = WorkspaceStreamStore.resourceKey(original);
  const owned = store.snapshot(key)[0]!;
  assert.equal((owned.data.nested as { text: string }).text, 'original');
  assert.equal(owned.cursor.seq, 1);
  assert.throws(() => {
    (owned.data.nested as { text: string }).text = 'snapshot changed';
  }, TypeError);
  assert.throws(() => {
    (store.snapshot(key) as WorkspaceStreamEvent[]).push(event(99));
  }, TypeError);
  for (let seq = 2; seq <= 130; seq++) {
    const next = event(seq);
    next.data = {
      toJSON() {
        serialized++;
        return { text: 'actual owned JSON' };
      },
    };
    store.apply(next);
  }
  assert.equal(
    serialized,
    129,
    'each incoming event serializes once, never the retained128 again',
  );
  store.checkpoint();
  assert.equal(serialized, 129);
  assert.equal(store.snapshot(key).length, 128);
  assert.equal(
    store.cachedBytes,
    new TextEncoder().encode(JSON.stringify(store.snapshot(key))).byteLength,
  );
});
test('a checkpoint holding events of services an earlier version had restores, so a reload need not replay everything again', () => {
  const store = new WorkspaceStreamStore();
  // the journal of a folder used by 1.9.0 still holds automatic delivery's events
  assert.equal(
    store.apply({ ...event(1), service: 'cycles' as never, resourceId: 'c1' }),
    'applied',
  );
  assert.equal(store.apply(event(2)), 'applied');
  const reloaded = new WorkspaceStreamStore();
  assert.equal(reloaded.restore(store.checkpoint()), true);
  assert.deepEqual(reloaded.cursor, store.cursor);
  // a service no version had is still refused
  const strange = store.checkpoint();
  strange.resources[0]!.events[0]!.service = 'unknown' as never;
  assert.equal(new WorkspaceStreamStore().restore(strange), false);
});
