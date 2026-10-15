import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceStreamConnection } from '../src/model/workspace-stream-connection.ts';
import {
  WorkspaceStreamStore,
  type WorkspaceStreamEvent,
} from '../src/model/workspace-stream-store.ts';
const event = (seq: number, sessionId = 's'): WorkspaceStreamEvent => ({
  workspaceId: 'w',
  sessionId,
  service: 'terminal',
  resourceId: 'p',
  epoch: 'epoch',
  seq,
  at: 'now',
  cursor: { seq, offset: seq * 100 },
  data: { value: seq },
});

test('listener is installed before paginated replay and live arrivals are applied exactly once', async () => {
  const store = new WorkspaceStreamStore();
  let receive: (event: WorkspaceStreamEvent) => void = () =>
    assert.fail('listener not installed');
  const calls: number[] = [],
    applied: number[] = [];
  const stream = new WorkspaceStreamConnection(
    store,
    {
      listen: (callback) => {
        receive = callback;
        return () => {};
      },
      replay: async (after) => {
        calls.push(after.seq);
        if (!after.seq) {
          receive(event(3));
          return {
            events: [event(1), event(2, 'another-session')],
            cursor: event(2).cursor,
            hasMore: true,
          };
        }
        return { events: [event(3)], cursor: event(3).cursor, hasMore: false };
      },
    },
    (row) => applied.push(row.seq),
  );
  await stream.start();
  receive(event(3));
  receive(event(4));
  assert.deepEqual(calls, [0, 2]);
  assert.deepEqual(applied, [1, 2, 3, 4]);
  assert.equal(store.cursor.seq, 4);
  assert.equal(
    store.snapshot(
      WorkspaceStreamStore.resourceKey(event(2, 'another-session')),
    ).length,
    1,
  );
  stream.stop();
});
test('a live sequence gap fetches missing durable events before dispatching the newest event', async () => {
  const store = new WorkspaceStreamStore();
  let receive!: (event: WorkspaceStreamEvent) => void;
  const applied: number[] = [];
  let live = false;
  const stream = new WorkspaceStreamConnection(
    store,
    {
      listen: (callback) => {
        receive = callback;
        return () => {};
      },
      replay: async (after) => ({
        events: live
          ? [event(2), event(3)].filter((row) => row.seq > after.seq)
          : [event(1)],
        cursor: live ? event(3).cursor : event(1).cursor,
        hasMore: false,
      }),
    },
    (row) => applied.push(row.seq),
  );
  await stream.start();
  live = true;
  receive(event(3));
  await stream.synchronize();
  assert.deepEqual(applied, [1, 2, 3]);
  stream.stop();
});
test('stopping during replay prevents late responses from changing the detached view', async () => {
  const store = new WorkspaceStreamStore();
  let resolve!: (page: any) => void;
  let unsubscribed = false;
  const stream = new WorkspaceStreamConnection(store, {
    listen: () => () => {
      unsubscribed = true;
    },
    replay: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const ready = stream.start();
  await Promise.resolve();
  stream.stop();
  resolve({ events: [event(1)], cursor: event(1).cursor, hasMore: false });
  await ready;
  assert.equal(store.cursor.seq, 0);
  assert.equal(unsubscribed, true);
});
test('malformed replay cursors fail closed without fabricating sequence progress', async () => {
  const store = new WorkspaceStreamStore();
  const stream = new WorkspaceStreamConnection(store, {
    listen: () => () => {},
    replay: async () => ({
      events: [],
      cursor: event(9).cursor,
      hasMore: false,
    }),
  });
  await assert.rejects(stream.start(), /cursor/);
  assert.equal(store.cursor.seq, 0);
  stream.stop();
});
