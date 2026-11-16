// A publication lists the sessions once (#577): the root sessions, the subagents and the
// owners of tasks come from that one listing, as they came from three before.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeController } from '../src/runtime-controller.ts';
import type { RuntimeUpdate } from '../src/runtime-protocol.ts';
import { CheckpointStore } from '../../../src/checkpoint_store.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import type { Message } from '../../../src/types.ts';

const talk = (id: string): Message[] => [
  { id: `${id}-question`, role: 'user', content: `a question to ${id}` },
  { id: `${id}-answer`, role: 'assistant', content: `the answer of ${id}` },
];

test('a publication lists the sessions once and shows the same sessions and agents in the same order', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-session-listing-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home);
  await mkdir(join(workspace, '.git'), { recursive: true });
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  // Roots with talk in another order than they were made, subagents two layers deep, and
  // a new session with no message and no title, which only the empty listing showed.
  const seed = new CheckpointStore(home);
  seed.create(workspace, 'fixture', 'older', 'older');
  seed.create(workspace, 'fixture', '', 'empty-new');
  seed.create(workspace, 'fixture', 'newer', 'newer');
  seed.append('newer', talk('newer'));
  seed.append('older', talk('older'));
  seed.create(workspace, 'fixture', 'child', 'child', 'newer');
  seed.append('child', talk('child'));
  seed.create(workspace, 'fixture', 'grandchild', 'grandchild', 'child');
  seed.append('grandchild', talk('grandchild'));
  seed.create(workspace, 'fixture', '', 'child-without-messages', 'older');
  seed.close();
  await writeFile(
    join(home, 'desktop-session.json'),
    JSON.stringify({ workspace, sessionId: 'newer' }),
  );
  const updates: RuntimeUpdate[] = [];
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model: new ScriptedModel(),
    emit: (update) => updates.push(update),
  });
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  const store = (controller as unknown as { store: CheckpointStore }).store;
  const list = store.list.bind(store);
  const calls: Parameters<CheckpointStore['list']>[] = [];
  store.list = (...args) => {
    calls.push(args);
    return list(...args);
  };

  const { snapshot } = controller.publish()!;
  assert.deepEqual(calls, [[undefined, true]]);
  assert.equal(updates.length, 1);

  // What the listings it replaced give, in their order.
  const roots = list(undefined, false, true).map((row) => row.id);
  assert.deepEqual(
    snapshot.sessions.map((session) => session.id),
    roots,
  );
  assert.ok(roots.includes('empty-new'));
  assert.ok(roots.includes(snapshot.activeSessionId));
  assert.deepEqual(
    snapshot.agents.map((agent) => [agent.id, agent.sessionId]),
    list(undefined, true)
      .filter((row) => row.parent_id)
      .map((row) => [row.id, row.parent_id]),
  );
  assert.deepEqual(snapshot.agents.map((agent) => agent.id).sort(), [
    'child',
    'child-without-messages',
    'grandchild',
  ]);
  assert.deepEqual(
    snapshot.agents
      .find((agent) => agent.id === 'grandchild')!
      .messages.map((row) => row.text),
    ['a question to grandchild', 'the answer of grandchild'],
  );
  assert.deepEqual(
    snapshot.sessions
      .find((session) => session.id === 'older')!
      .messages.map((row) => row.text),
    ['a question to older', 'the answer of older'],
  );
  assert.equal(
    snapshot.sessions.find((session) => session.id === 'empty-new')!.title,
    'new session',
  );

  // The same for every publication, not only the first.
  calls.length = 0;
  controller.publish();
  assert.deepEqual(calls, [[undefined, true]]);
});
