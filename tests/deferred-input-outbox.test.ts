import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { cleanup, scratch } from './helpers.js';
const db = (store: CheckpointStore) =>
  (store as unknown as { db: DatabaseSync }).db;
const payload = {
  text: 'queued first message',
  display: 'queued first message',
};

test('recovering an untouched deferred session writes no session and rejects a truly unknown identity', () => {
  const store = new CheckpointStore();
  try {
    const session = store.create(
      '/synthetic',
      'model',
      '',
      'deferred-empty',
      null,
      true,
    );
    store.inputs.recover(session.id, 'epoch');
    store.inputs.update(session.id, 'epoch', []);
    assert.throws(
      () => store.inputs.update('unknown', 'epoch', []),
      /unknown session/,
    );
    assert.throws(
      () =>
        store.inputs.update(session.id, 'epoch', [
          { id: 'missing', state: 'discarded' },
        ]),
      /unknown session/,
    );
    assert.equal(
      db(store).prepare('SELECT id FROM sessions WHERE id=?').get(session.id),
      undefined,
    );
    assert.equal(store.get(session.id)?.head, null);
    assert.deepEqual(store.list(), []);
    assert.throws(
      () => store.inputs.recover('unknown', 'epoch'),
      /unknown session/,
    );
    assert.throws(
      () => store.inputs.enqueue('unknown', 'epoch', 'steer', payload),
      /unknown session/,
    );
  } finally {
    store.close();
  }
});

test('first durable enqueue survives empty-session purge and restart without consuming or replaying it', (t) => {
  const home = scratch(t);
  let store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  const session = store.create(
    '/synthetic',
    'model',
    '',
    'deferred-queued',
    null,
    true,
  );
  const queued = store.inputs.enqueue(
    session.id,
    'first-epoch',
    'followUp',
    payload,
    'stable-input',
  );
  assert.equal(queued.id, 'stable-input');
  assert.equal(store.get(session.id)?.head, null);
  assert.equal(store.list()[0]?.id, session.id);
  store.purgeEmptySessions();
  assert.equal(store.inputs.get(session.id, queued.id)?.state, 'queued');
  store.close();
  store = new CheckpointStore(home);
  store.inputs.recover(session.id, 'second-epoch');
  store.purgeEmptySessions();
  assert.equal(store.get(session.id)?.head, null);
  assert.deepEqual(store.messages(session.id), []);
  assert.equal(store.inputs.recoverable(session.id).items[0]?.id, queued.id);
  assert.equal(store.list()[0]?.id, session.id);
});

test('failed initial enqueue rolls back materialization and leaves the deferred session retryable', () => {
  const store = new CheckpointStore();
  try {
    const session = store.create(
      '/synthetic',
      'model',
      '',
      'deferred-retry',
      null,
      true,
    );
    db(store).exec(
      "CREATE TRIGGER reject_initial BEFORE INSERT ON input_outbox BEGIN SELECT RAISE(ABORT, 'synthetic outbox disk failure'); END",
    );
    assert.throws(
      () => store.inputs.enqueue(session.id, 'epoch', 'steer', payload),
      /synthetic outbox disk failure/,
    );
    assert.equal(
      db(store).prepare('SELECT id FROM sessions WHERE id=?').get(session.id),
      undefined,
    );
    assert.equal(store.get(session.id)?.id, session.id);
    db(store).exec('DROP TRIGGER reject_initial');
    const queued = store.inputs.enqueue(session.id, 'epoch', 'steer', payload);
    const head = store.appendInput(session.id, queued.id, 'epoch', {
      id: queued.id,
      role: 'user',
      content: payload.text,
    });
    assert.ok(head);
    assert.equal(store.inputs.get(session.id, queued.id)?.state, 'consumed');
    assert.equal(store.messages(session.id)[0]?.id, queued.id);
  } finally {
    store.close();
  }
});

test('a failed first history CAS leaves the deferred identity available for the actual first write', () => {
  const store = new CheckpointStore();
  try {
    const session = store.create(
      '/synthetic',
      'model',
      '',
      'deferred-cas',
      null,
      true,
    );
    assert.throws(
      () =>
        store.append(
          session.id,
          [{ id: 'first', role: 'user', content: 'work' }],
          'wrong-head',
        ),
      /session changed/,
    );
    assert.equal(
      db(store).prepare('SELECT id FROM sessions WHERE id=?').get(session.id),
      undefined,
    );
    assert.equal(store.get(session.id)?.id, session.id);
    assert.ok(
      store.append(
        session.id,
        [{ id: 'first', role: 'user', content: 'work' }],
        null,
      ),
    );
    assert.equal(store.messages(session.id)[0]?.content, 'work');
  } finally {
    store.close();
  }
});
