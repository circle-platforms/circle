import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CheckpointStore, emptyContextState } from '../src/checkpoint_store.js';
import type { CompactionOperation } from '../src/compaction.js';
import { emptyUsage } from '../src/types.js';
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

function operation(sessionId: string, head: string): CompactionOperation {
  return {
    snapshot: {
      operationId: randomUUID(),
      sessionId,
      branchHead: head,
      trigger: 'tool',
      status: 'succeeded',
      stage: 'done',
      startedAt: 1,
      updatedAt: 1,
      completed: 1,
      total: 1,
      covered: 0,
      sourceSize: 0,
      attempts: 0,
      recoveries: 0,
      usage: emptyUsage(),
      unknownCalls: 0,
      liveTokens: 0,
      recoverable: false,
    },
    sourceHash: 'source',
    cutoffId: 'cutoff',
    policy: 'complete-history-v1',
  };
}

test("a write to one session keeps the others' cached context and an append carries its own to the new head", (t) => {
  const home = scratch(t, 'circle-context-per-session-');
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  const ids = ['a', 'b', 'c'].map((name) => {
    const session = store.create('/fixture', 'scripted', 'session ' + name);
    store.append(session.id, [
      { id: name + '-user', role: 'user', content: 'ask ' + name },
      { id: name + '-answer', role: 'assistant', content: 'answer ' + name },
    ]);
    store.setContextState(session.id, {
      ...emptyContextState(),
      prunedIds: [name + '-state'],
    });
    store.append(session.id, [
      { id: name + '-next', role: 'user', content: 'after the state ' + name },
    ]);
    return session.id;
  });
  const [a, , c] = ids as [string, string, string];
  const probe = visits(store);
  for (const id of ids) store.contextState(id);
  assert.equal(probe.count, 6, 'each session walks back to its state');
  const head = store.append(a, [
    { id: 'a-more', role: 'assistant', content: 'more for a' },
  ]);
  store.rename(c, 'renamed c');
  store.compactions.saveOperation(operation(c, store.get(c)!.head!));
  probe.reset();
  const states = ids.map((id) => store.contextState(id));
  assert.equal(probe.count, 0, 'no session walks its chain again');
  assert.equal(store.get(a)!.head, head);
  assert.deepEqual(
    states.map((state) => state.prunedIds),
    [['a-state'], ['b-state'], ['c-state']],
  );
  const other = new CheckpointStore(home);
  try {
    assert.deepEqual(
      states,
      ids.map((id) => other.contextState(id)),
    );
  } finally {
    other.close();
  }
});

test('a context write is read again for every head cached for that session', () => {
  const store = new CheckpointStore();
  try {
    const session = store.create('/fixture', 'scripted', 'branches');
    const bystander = store.create('/fixture', 'scripted', 'bystander');
    store.append(bystander.id, [
      { id: 'bystander-user', role: 'user', content: 'unrelated' },
    ]);
    const older = store.append(session.id, [
      { id: 'first-user', role: 'user', content: 'first' },
      { id: 'first-answer', role: 'assistant', content: 'first answer' },
    ])!;
    const later = store.append(session.id, [
      { id: 'second-user', role: 'user', content: 'second' },
      { id: 'second-answer', role: 'assistant', content: 'second answer' },
    ])!;
    store.contextState(bystander.id);
    assert.deepEqual(
      store.contextState(session.id, later),
      emptyContextState(),
    );
    store.select(session.id, older);
    store.setContextState(session.id, {
      ...emptyContextState(),
      prunedIds: ['written at the older head'],
    });
    const probe = visits(store);
    assert.deepEqual(store.contextState(session.id, later).prunedIds, [
      'written at the older head',
    ]);
    assert.ok(probe.count > 0);
    probe.reset();
    store.contextState(bystander.id);
    assert.equal(probe.count, 0, 'another session keeps its cached context');
  } finally {
    store.close();
  }
});

test('deleting, abandoning or purging a session forgets its context', () => {
  // A forgotten entry frees its place: with the cache full, reading one more session
  // then leaves the oldest one cached. An entry kept for the removed session evicts it.
  const cases: [string, (store: CheckpointStore, id: string) => void][] = [
    ['delete', (store, id) => store.delete(id)],
    ['abandon', (store, id) => assert.ok(store.abandonUnanswered(id))],
    ['purge', (store) => store.purgeEmptySessions()],
  ];
  for (const [name, remove] of cases) {
    const store = new CheckpointStore();
    try {
      const ids = Array.from({ length: 64 }, (_, i) => {
        const empty = name === 'purge' && i === 10;
        const session = store.create(
          '/fixture',
          'scripted',
          empty ? '' : 'session ' + i,
        );
        if (!empty)
          store.append(session.id, [
            { id: `user-${i}`, role: 'user', content: 'session ' + i },
          ]);
        return session.id;
      });
      for (const id of ids) store.contextState(id);
      remove(store, ids[10]!);
      const added = store.create('/fixture', 'scripted', 'added');
      store.append(added.id, [{ id: 'added', role: 'user', content: 'added' }]);
      store.contextState(added.id);
      const probe = visits(store);
      store.contextState(ids[0]!);
      assert.equal(probe.count, 0, `${name} kept the oldest session cached`);
      assert.deepEqual(store.contextState(ids[10]!), emptyContextState());
    } finally {
      store.close();
    }
  }
});

test('a legacy summary is checked again after an append', () => {
  const store = new CheckpointStore();
  try {
    const session = store.create('/fixture', 'scripted', 'legacy');
    const start = store.append(session.id, [
      { id: 'legacy-user', role: 'user', content: 'legacy question' },
    ])!;
    // The summary's message is on another branch, so this one has no summary yet.
    const elsewhere = store.append(session.id, [
      { id: 'shared', role: 'assistant', content: 'first try' },
    ])!;
    store.select(session.id, start);
    const db = (store as unknown as { db: DatabaseSync }).db;
    db.prepare(
      'INSERT INTO context_projections (session_id, at_checkpoint, summary) VALUES (?, ?, ?)',
    ).run(session.id, elsewhere, 'legacy summary');
    assert.equal(store.contextState(session.id).summary, undefined);
    store.append(session.id, [
      { id: 'shared', role: 'assistant', content: 'second try' },
    ]);
    const probe = visits(store);
    assert.equal(
      store.contextState(session.id).summary?.text,
      'legacy summary',
    );
    assert.ok(probe.count > 0, 'the legacy state was not carried forward');
  } finally {
    store.close();
  }
});

test('writesTo moves only for the session written; another connection moves databaseVersion', (t) => {
  const home = scratch(t, 'circle-session-writes-');
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  const message = (id: string, role: 'user' | 'assistant' = 'user') => ({
    id,
    role,
    content: 'message ' + id,
  });
  const make = (title = 'session') => {
    const session = store.create('/fixture', 'scripted', title);
    store.append(session.id, [message(randomUUID())]);
    return session.id;
  };
  const bystander = make('bystander');
  const parent = make('parent');
  const cases: [string, () => string[]][] = [
    [
      'create with a parent',
      () => {
        const child = store.create(
          '/fixture',
          'scripted',
          'child',
          undefined,
          parent,
        );
        return [parent, child.id];
      },
    ],
    [
      'append',
      () => {
        store.append(parent, [message(randomUUID(), 'assistant')]);
        return [parent];
      },
    ],
    [
      'select',
      () => {
        const id = make();
        const older = store.get(id)!.head;
        store.append(id, [message(randomUUID(), 'assistant')]);
        const before = store.writesTo(id);
        store.select(id, older);
        assert.ok(store.writesTo(id) > before);
        return [id];
      },
    ],
    [
      'setContextState',
      () => {
        store.setContextState(parent, {
          ...emptyContextState(),
          summary: {
            cutoffMessageId: store.messages(parent)[0]!.id,
            text: 'summary',
          },
        });
        return [parent];
      },
    ],
    [
      'rename',
      () => {
        store.rename(parent, 'renamed');
        return [parent];
      },
    ],
    [
      'setLabel',
      () => {
        const id = make();
        const before = store.writesTo(id);
        store.setLabel(id, store.messages(id)[0]!.id, 'label');
        assert.ok(store.writesTo(id) > before);
        return [id];
      },
    ],
    [
      'compaction saveOperation',
      () => {
        store.compactions.saveOperation(
          operation(parent, store.get(parent)!.head!),
        );
        return [parent];
      },
    ],
    [
      'queued input',
      () => {
        store.inputs.enqueue(parent, 'epoch', 'followUp', {
          text: 'queued',
          display: 'queued',
        });
        return [parent];
      },
    ],
    [
      'delete',
      () => {
        const id = make();
        const before = store.writesTo(id);
        store.delete(id);
        assert.ok(store.writesTo(id) > before);
        return [id];
      },
    ],
    [
      'abandonUnanswered',
      () => {
        const id = make();
        const before = store.writesTo(id);
        assert.ok(store.abandonUnanswered(id));
        assert.ok(store.writesTo(id) > before);
        return [id];
      },
    ],
    [
      'purgeEmptySessions',
      () => {
        const id = store.create('/fixture', 'scripted').id;
        const before = store.writesTo(id);
        store.purgeEmptySessions();
        assert.equal(store.get(id), undefined);
        assert.ok(store.writesTo(id) > before);
        return [id];
      },
    ],
    [
      'fork',
      () => {
        const forked = store.fork(parent, '/fixture');
        assert.ok(store.writesTo(forked.id) > 0);
        return [forked.id];
      },
    ],
  ];
  const database = store.databaseVersion();
  for (const [name, write] of cases) {
    const before = store.writesTo(parent);
    const unrelated = store.writesTo(bystander);
    const written = write();
    assert.equal(store.writesTo(bystander), unrelated, name);
    if (written.includes(parent))
      assert.ok(store.writesTo(parent) > before, name);
    else assert.equal(store.writesTo(parent), before, name);
    assert.equal(store.databaseVersion(), database, name);
  }
  const other = new CheckpointStore(home);
  try {
    const written = store.writesTo(bystander);
    other.append(bystander, [message(randomUUID(), 'assistant')]);
    assert.notEqual(store.databaseVersion(), database);
    assert.equal(store.writesTo(bystander), written);
  } finally {
    other.close();
  }
});
