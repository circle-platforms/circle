import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CheckpointStore, emptyContextState } from '../src/checkpoint_store.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { cleanup, scratch } from './helpers.js';

function visits(store: CheckpointStore) {
  const checkpoint = store.checkpoint.bind(store);
  let count = 0;
  store.checkpoint = (id) => {
    count++;
    return checkpoint(id);
  };
  return {
    get count() {
      return count;
    },
    reset() {
      count = 0;
    },
  };
}

test('a ten thousand checkpoint context is reused without exposing mutable cache objects or changing history', () => {
  const store = new CheckpointStore();
  try {
    const session = store.create('/fixture', 'scripted');
    store.append(
      session.id,
      Array.from({ length: 10000 }, (_, n) => ({
        id: 'message-' + n,
        role: n % 2 ? ('assistant' as const) : ('user' as const),
        content: 'real history ' + n,
      })),
    );
    const head = store.get(session.id)!.head;
    const history = store.messages(session.id);
    const probe = visits(store);
    assert.deepEqual(store.contextState(session.id), emptyContextState());
    assert.equal(probe.count, 10000);
    probe.reset();
    const second = store.contextState(session.id);
    assert.equal(
      probe.count,
      0,
      'same head must not repeat the checkpoint ancestry queries',
    );
    second.prunedIds.push('caller mutation');
    second.offloaded['tool'] = 'changed';
    assert.deepEqual(store.contextState(session.id), emptyContextState());
    const state = {
      ...emptyContextState(),
      summary: { cutoffMessageId: 'message-0', text: 'stored summary' },
    };
    store.setContextState(session.id, state, head);
    const stored = store.contextState(session.id);
    stored.summary!.text = 'caller changed nested summary';
    assert.equal(
      store.contextState(session.id).summary!.text,
      'stored summary',
    );
    assert.equal(store.get(session.id)!.head, head);
    assert.equal(store.messages(session.id), history);
  } finally {
    store.close();
  }
});

test('same-head own and independent connection updates invalidate context, explicit old heads stay isolated and reopen reads persisted state', (t) => {
  const home = scratch(t, 'circle-context-cache-');
  const first = new CheckpointStore(home),
    second = new CheckpointStore(home);
  cleanup(t, () => first.close());
  cleanup(t, () => second.close());
  const session = first.create('/fixture', 'scripted');
  const oldHead = first.append(session.id, [
    { id: 'old', role: 'user', content: 'old branch' },
  ])!;
  first.setContextState(session.id, {
    ...emptyContextState(),
    prunedIds: ['old-state'],
  });
  const newHead = first.append(session.id, [
    { id: 'new', role: 'assistant', content: 'new branch' },
  ])!;
  assert.deepEqual(first.contextState(session.id).prunedIds, ['old-state']);
  second.setContextState(
    session.id,
    { ...emptyContextState(), prunedIds: ['other-connection'] },
    newHead,
  );
  assert.equal(first.get(session.id)!.head, newHead);
  assert.deepEqual(first.contextState(session.id).prunedIds, [
    'other-connection',
  ]);
  assert.deepEqual(first.contextState(session.id, oldHead).prunedIds, [
    'old-state',
  ]);
  assert.deepEqual(first.contextState(session.id, newHead).prunedIds, [
    'other-connection',
  ]);
  const version = first.version;
  first.setContextState(
    session.id,
    { ...emptyContextState(), offloaded: { result: 'latest own state' } },
    newHead,
  );
  assert(first.version > version);
  assert.equal(
    first.contextState(session.id).offloaded.result,
    'latest own state',
  );
  assert.equal(
    second.contextState(session.id).offloaded.result,
    'latest own state',
  );
  assert.throws(
    () => first.setContextState(session.id, emptyContextState(), oldHead),
    /session changed/,
  );
  assert.equal(
    first.contextState(session.id).offloaded.result,
    'latest own state',
  );
  second.select(session.id, oldHead);
  assert.deepEqual(first.contextState(session.id).prunedIds, ['old-state']);
  assert.equal(
    first.contextState(session.id, newHead).offloaded.result,
    'latest own state',
  );
  first.close();
  second.close();
  const reopened = new CheckpointStore(home);
  try {
    assert.deepEqual(reopened.contextState(session.id).prunedIds, [
      'old-state',
    ]);
    assert.equal(
      reopened.contextState(session.id, newHead).offloaded.result,
      'latest own state',
    );
  } finally {
    reopened.close();
  }
});

test('context cache is bounded, skips open transactions and never hides unknown or corrupted ancestry', (t) => {
  const store = new CheckpointStore();
  try {
    const sessions = Array.from({ length: 70 }, (_, i) => {
      const session = store.create('/fixture', 'scripted', 'session ' + i);
      store.append(session.id, [
        { id: 'user-' + i, role: 'user', content: 'session ' + i },
      ]);
      return session;
    });
    const probe = visits(store);
    for (const session of sessions) store.contextState(session.id);
    probe.reset();
    store.contextState(sessions.at(-1)!.id);
    assert.equal(probe.count, 0);
    store.contextState(sessions[0]!.id);
    assert.equal(
      probe.count,
      1,
      'least recent session was evicted and recomputed',
    );
    const db = (store as unknown as { db: DatabaseSync }).db;
    probe.reset();
    db.exec('BEGIN');
    try {
      store.contextState(sessions[0]!.id);
      assert.equal(
        probe.count,
        1,
        'transaction reads must not reuse another snapshot cache',
      );
    } finally {
      db.exec('ROLLBACK');
    }
    assert.deepEqual(
      store.contextState('missing-session'),
      emptyContextState(),
    );
    assert.throws(
      () =>
        store.contextState('missing-session', store.get(sessions[0]!.id)!.head),
      /invalid checkpoint ancestry/,
    );
  } finally {
    store.close();
  }
  const home = scratch(t, 'circle-context-corruption-');
  const reader = new CheckpointStore(home),
    writer = new CheckpointStore(home);
  cleanup(t, () => reader.close());
  cleanup(t, () => writer.close());
  const session = reader.create('/fixture', 'scripted');
  const head = reader.append(session.id, [
    { id: 'root', role: 'user', content: 'real root' },
  ]);
  reader.contextState(session.id);
  const db = (writer as unknown as { db: DatabaseSync }).db;
  db.prepare('UPDATE checkpoints SET parent = ? WHERE id = ?').run(head, head);
  assert.throws(
    () => reader.contextState(session.id),
    /checkpoint ancestry cycle/,
  );
});

test('a same-head context update reaches the actual next model request without rewriting earlier messages', async (t) => {
  const home = scratch(t, 'circle-context-model-');
  const model = new ScriptedModel([
    { message: { id: 'real-answer', role: 'assistant', content: 'done' } },
  ]);
  const runtime = new AgentRuntime({
    home,
    userHome: home,
    workspace: home,
    settings: defaultSettings(),
    model,
    headless: true,
    bundledExtensions: false,
  });
  cleanup(t, () => runtime.close());
  runtime.store.append(runtime.session.id, [
    { id: 'first-user', role: 'user', content: 'original full history' },
    { id: 'first-answer', role: 'assistant', content: 'earlier answer' },
  ]);
  const head = runtime.store.get(runtime.session.id)!.head;
  const original = JSON.stringify(runtime.store.messages(runtime.session.id));
  runtime.store.setContextState(
    runtime.session.id,
    {
      ...emptyContextState(),
      summary: { cutoffMessageId: 'first-user', text: 'OLD SUMMARY' },
    },
    head,
  );
  runtime.store.contextState(runtime.session.id);
  runtime.store.setContextState(
    runtime.session.id,
    {
      ...emptyContextState(),
      summary: { cutoffMessageId: 'first-user', text: 'UPDATED SUMMARY' },
    },
    head,
  );
  assert.equal(
    JSON.stringify(runtime.store.messages(runtime.session.id)),
    original,
  );
  await runtime.harness.run('continue after same-head update');
  assert.equal(model.requests.length, 1);
  assert(
    model.requests[0]!.messages.some((m) =>
      m.content.includes('UPDATED SUMMARY'),
    ),
  );
  assert(
    !model.requests[0]!.messages.some((m) => m.content.includes('OLD SUMMARY')),
  );
  assert(
    runtime.store
      .messages(runtime.session.id)
      .some((m) => m.content === 'original full history'),
  );
  assert(
    runtime.store
      .messages(runtime.session.id)
      .some((m) => m.content === 'done'),
  );
});

test('legacy context updates on another connection remain visible and a version read failure cannot serve cached state', (t) => {
  const home = scratch(t, 'circle-context-legacy-cache-');
  const reader = new CheckpointStore(home),
    writer = new CheckpointStore(home);
  cleanup(t, () => reader.close());
  cleanup(t, () => writer.close());
  const session = reader.create('/fixture', 'scripted');
  const head = reader.append(session.id, [
    { id: 'legacy-user', role: 'user', content: 'actual legacy history' },
  ]);
  assert.equal(reader.contextState(session.id).summary, undefined);
  const writerDb = (writer as unknown as { db: DatabaseSync }).db;
  writerDb
    .prepare(
      'INSERT INTO context_projections (session_id, at_checkpoint, summary) VALUES (?, ?, ?)',
    )
    .run(session.id, head, 'legacy persisted summary');
  assert.equal(
    reader.contextState(session.id).summary!.text,
    'legacy persisted summary',
  );
  const db = (reader as unknown as { db: DatabaseSync }).db;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql === 'PRAGMA data_version')
      throw Error('injected version-read failure');
    return prepare(sql);
  };
  try {
    assert.throws(
      () => reader.contextState(session.id),
      /injected version-read failure/,
    );
  } finally {
    db.prepare = prepare;
  }
  assert.equal(
    reader.contextState(session.id).summary!.text,
    'legacy persisted summary',
  );
});
