import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CheckpointStore } from '../src/checkpoint_store.js';
import type { Message } from '../src/types.js';

const user = (id: string, content: string): Message => ({
  id,
  role: 'user',
  content,
});

test('rename and selecting a head leave recency on the last message', async () => {
  const store = new CheckpointStore();
  const session = store.create('/w', 'm');
  const created = store.get(session.id)!.updated;
  await delay(5);
  store.append(session.id, [user('u1', 'one')]);
  const afterMessage = store.get(session.id)!.updated;
  assert.ok(afterMessage > created);
  const head = store.get(session.id)!.head;
  const version = store.version;
  store.rename(session.id, 'named');
  assert.equal(store.get(session.id)!.title, 'named');
  assert.equal(store.get(session.id)!.updated, afterMessage);
  assert.ok(store.version > version);
  await delay(5);
  store.append(session.id, [user('u2', 'two')]);
  const afterSecond = store.get(session.id)!.updated;
  assert.ok(afterSecond > afterMessage);
  store.select(session.id, head);
  assert.equal(store.get(session.id)!.head, head);
  assert.equal(store.get(session.id)!.updated, afterSecond);
});
