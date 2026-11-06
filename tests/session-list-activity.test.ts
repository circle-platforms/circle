import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { scratch } from './helpers.js';

const internals = (store: CheckpointStore) =>
  store as unknown as { db: DatabaseSync };
const setCreated = (
  store: CheckpointStore,
  session: string,
  content: string,
  created: number,
) =>
  internals(store)
    .db.prepare(
      "UPDATE checkpoints SET created = ? WHERE session_id = ? AND json_extract(message, '$.content') = ?",
    )
    .run(created, session, content);

test('sessions list by their latest prompt or reply, whatever follows it and however rows were written', (t) => {
  const store = new CheckpointStore(scratch(t));
  t.after(() => store.close());
  const workspace = scratch(t);
  store.create(workspace, 'fixture', 'older', 'older');
  store.create(workspace, 'fixture', 'newer', 'newer');
  store.append('older', [
    { id: 'o1', role: 'user', content: 'older prompt' },
    {
      id: 'o2',
      role: 'tool',
      tool_call_id: 'none',
      content: 'a tool result is not activity',
    },
    {
      id: 'o3',
      role: 'assistant',
      internal: 'interrupted',
      content: 'a marker is not activity',
    },
  ]);
  store.append('newer', [
    { id: 'n1', role: 'user', content: 'newer prompt' },
    { id: 'n2', role: 'assistant', content: 'newer reply' },
  ]);
  setCreated(store, 'older', 'older prompt', 1000);
  setCreated(store, 'older', 'a tool result is not activity', 9000);
  setCreated(store, 'older', 'a marker is not activity', 9500);
  setCreated(store, 'newer', 'newer prompt', 2000);
  // Written earlier but stamped later than what follows it: the time decides, not the order.
  setCreated(store, 'newer', 'newer reply', 1500);
  assert.deepEqual(
    store.list().map((row) => row.id),
    ['newer', 'older'],
  );
  const activity = (id: string) =>
    Number(
      internals(store)
        .db.prepare(
          "SELECT COALESCE((SELECT c.created FROM checkpoints c WHERE c.session_id = ? AND json_extract(c.message, '$.role') IN ('user', 'assistant') AND IFNULL(json_extract(c.message, '$.internal'), '') = '' ORDER BY c.created DESC LIMIT 1), 0) AS at",
        )
        .get(id)?.at,
    );
  assert.equal(activity('newer'), 2000);
  assert.equal(activity('older'), 1000);
  setCreated(store, 'older', 'older prompt', 3000);
  assert.deepEqual(
    store.list().map((row) => row.id),
    ['older', 'newer'],
  );
  // No message that counts: the session's own creation time places it.
  store.create(workspace, 'fixture', 'only a marker', 'marker');
  store.append('marker', [
    {
      id: 'm1',
      role: 'assistant',
      internal: 'interrupted',
      content: 'marker only',
    },
  ]);
  setCreated(store, 'marker', 'marker only', 9000);
  internals(store)
    .db.prepare('UPDATE sessions SET created = 2500 WHERE id = ?')
    .run('marker');
  assert.deepEqual(
    store.list().map((row) => row.id),
    ['older', 'marker', 'newer'],
  );
});

test('listing sessions reads from the newest row of each and not through all their messages', (t) => {
  const store = new CheckpointStore(scratch(t));
  t.after(() => store.close());
  const workspace = scratch(t);
  store.create(workspace, 'fixture', 'long', 'long');
  store.append(
    'long',
    Array.from({ length: 200 }, (_, index) => ({
      id: `m${index}`,
      role: 'user' as const,
      content: `message ${index}`,
    })),
  );
  const { db } = internals(store);
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT c.created FROM checkpoints c WHERE c.session_id = 'long' AND json_extract(c.message, '$.role') IN ('user', 'assistant') ORDER BY c.created DESC LIMIT 1",
    )
    .all()
    .map((row) => String(row.detail));
  assert.ok(
    plan.some((step) => step.includes('checkpoints_session_created')),
    plan.join('\n'),
  );
  assert.ok(
    !plan.some((step) => step.includes('TEMP B-TREE')),
    plan.join('\n'),
  );
});

test('the change version moves with every write to the database and with no read', (t) => {
  const home = scratch(t);
  const store = new CheckpointStore(home);
  t.after(() => store.close());
  const workspace = scratch(t);
  store.create(workspace, 'fixture', 'one', 'one');
  const version = store.changeVersion();
  assert.equal(store.changeVersion(), version);
  store.list();
  store.messages('one');
  store.labels('one');
  assert.equal(store.changeVersion(), version, 'reads move nothing');
  store.append('one', [{ id: 'a', role: 'user', content: 'a' }]);
  const appended = store.changeVersion();
  assert.notEqual(appended, version);
  store.setLabel('one', 'a', 'a label');
  const labelled = store.changeVersion();
  assert.notEqual(labelled, appended);
  // Through another connection, as the terminal is.
  const other = new CheckpointStore(home);
  other.append('one', [{ id: 'b', role: 'user', content: 'b' }]);
  other.close();
  assert.notEqual(store.changeVersion(), labelled);
});
