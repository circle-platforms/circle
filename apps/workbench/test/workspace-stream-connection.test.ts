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

test('two workspace journals can interleave seq 1 while session switches and reload preserve each cursor', async () => {
  const { WorkspaceStreamRegistry } =
    await import('../src/model/workspace-stream-connection.ts');
  let receive!: (event: WorkspaceStreamEvent) => void;
  const journals = new Map<string, WorkspaceStreamEvent[]>([
    ['a', [{ ...event(1, 'a-first'), workspaceId: 'a' }]],
    ['b', [{ ...event(1, 'b-first'), workspaceId: 'b' }]],
  ]);
  const auth: string[] = [],
    seen: string[] = [];
  const transport = {
    listen: (listener: (event: WorkspaceStreamEvent) => void) => {
      receive = listener;
      return () => {};
    },
    replay: async (
      workspaceId: string,
      sessionId: string,
      after: { seq: number; offset: number },
    ) => {
      auth.push(`${workspaceId}:${sessionId}`);
      const events = journals
        .get(workspaceId)!
        .filter((row) => row.seq > after.seq);
      return { events, cursor: events.at(-1)?.cursor ?? after, hasMore: false };
    },
  };
  const registry = new WorkspaceStreamRegistry(transport, undefined, (row) =>
    seen.push(`${row.workspaceId}:${row.seq}`),
  );
  await registry.connect('a', 'a-first');
  await registry.connect('b', 'b-first');
  const a2 = { ...event(2, 'a-background'), workspaceId: 'a' };
  journals.get('a')!.push(a2);
  receive(a2);
  const b2 = { ...event(2, 'b-first'), workspaceId: 'b' };
  journals.get('b')!.push(b2);
  receive(b2);
  await registry.connect('a', 'a-switched-session');
  assert.deepEqual(seen, ['a:1', 'b:1', 'a:2', 'b:2']);
  const checkpoints = new Map(
    ['a', 'b'].map((id) => [id, registry.store(id).checkpoint()]),
  );
  registry.close();
  const reloaded = new WorkspaceStreamRegistry(transport, (id) => {
    const store = new WorkspaceStreamStore();
    assert.equal(store.restore(checkpoints.get(id)), true);
    return store;
  });
  const a3 = { ...event(3, 'a-after-reload'), workspaceId: 'a' };
  journals.get('a')!.push(a3);
  await reloaded.connect('b', 'b-first');
  await reloaded.connect('a', 'a-after-reload');
  assert.equal(reloaded.store('a').cursor.seq, 3);
  assert.equal(reloaded.store('b').cursor.seq, 2);
  assert.ok(auth.includes('a:a-switched-session'));
  assert.equal(
    reloaded.store('a').snapshot(WorkspaceStreamStore.resourceKey(a2)).length,
    1,
  );
  reloaded.close();
});

test('replay authorization cannot substitute another workspace journal', async () => {
  const { WorkspaceStreamRegistry } =
    await import('../src/model/workspace-stream-connection.ts');
  const registry = new WorkspaceStreamRegistry({
    listen: () => () => {},
    replay: async () => ({
      events: [event(1)],
      cursor: event(1).cursor,
      hasMore: false,
    }),
  });
  await assert.rejects(
    registry.connect('different-workspace', 's'),
    /different journal/,
  );
  assert.equal(registry.store('different-workspace').cursor.seq, 0);
  registry.close();
});

test('switching away from a deleted replay authorization retries once using the new session', async () => {
  const { WorkspaceStreamRegistry } =
    await import('../src/model/workspace-stream-connection.ts');
  let rejectOld!: (reason: Error) => void;
  const used: string[] = [];
  const registry = new WorkspaceStreamRegistry({
    listen: () => () => {},
    replay: async (_workspace, session, after) => {
      used.push(session);
      if (session === 'old')
        return new Promise((_resolve, reject) => {
          rejectOld = reject;
        });
      return { events: [event(1)], cursor: event(1).cursor, hasMore: false };
    },
  });
  const old = registry.connect('w', 'old');
  await Promise.resolve();
  const current = registry.connect('w', 'new');
  rejectOld(Error('session no longer exists'));
  await Promise.all([old, current]);
  assert.deepEqual(used, ['old', 'new']);
  assert.equal(registry.store('w').cursor.seq, 1);
  registry.close();
});
test('stop and restart cannot apply an old generation response or clear the new replay', async () => {
  let first!: (page: any) => void;
  let count = 0;
  const store = new WorkspaceStreamStore();
  const connection = new WorkspaceStreamConnection(store, {
    listen: () => () => {},
    replay: async () => {
      if (++count === 1)
        return new Promise((resolve) => {
          first = resolve;
        });
      return { events: [event(1)], cursor: event(1).cursor, hasMore: false };
    },
  });
  const old = connection.start();
  await Promise.resolve();
  connection.stop();
  const current = connection.start();
  await current;
  first({ events: [event(9)], cursor: event(9).cursor, hasMore: false });
  await old;
  assert.equal(store.cursor.seq, 1);
  connection.stop();
});
