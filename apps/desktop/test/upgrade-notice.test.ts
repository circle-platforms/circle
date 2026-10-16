import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeController } from '../src/runtime-controller.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import { CheckpointStore } from '../../../src/checkpoint_store.ts';
import { VERSION } from '../../../src/version.ts';

test('opening the last session after an upgrade does not invent an interrupted reply', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-whats-new-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const store = new CheckpointStore(home);
  const session = store.create(workspace, 'model', 'kept');
  store.append(session.id, [
    { id: 'u', role: 'user', content: 'hello' },
    { id: 'a', role: 'assistant', content: 'saved' },
  ]);
  const updated = store.get(session.id)!.updated;
  store.close();
  writeFileSync(
    join(home, 'desktop-session.json'),
    JSON.stringify({ workspace, sessionId: session.id }) + '\n',
  );
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model: new ScriptedModel([]),
    emit: () => {},
  });
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  const opened = new CheckpointStore(home);
  try {
    assert.equal(
      opened
        .messages(session.id)
        .some((message) => message.internal === 'interrupted'),
      false,
    );
    assert.equal(opened.get(session.id)!.updated, updated);
  } finally {
    opened.close();
  }
  const notice = controller.snapshot().whatsNew;
  assert.equal(notice?.version, VERSION);
  assert.equal(
    notice!.items.some((item) => /circle-server/.test(item.en)),
    false,
  );
  assert.match(notice!.link, /releases\/tag\/v/);
  assert.equal(notice!.link.includes('blob/main'), false);
  const reply = await controller.dispatch({
    id: randomUUID(),
    name: 'dismiss-whats-new',
    payload: {},
    sessionId: controller.snapshot().activeSessionId,
  });
  assert.equal(reply.ok, true, reply.error);
  assert.equal(controller.snapshot().whatsNew, undefined);
  assert.equal(
    JSON.parse(readFileSync(join(home, 'whats-new.json'), 'utf8')).seen,
    VERSION,
  );
});

test('a stopped reply stays marked, and a crash marker still shows, without a false one', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-interrupted-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const store = new CheckpointStore(home);
  const stopped = store.create(workspace, 'model', 'stopped');
  store.append(stopped.id, [
    { id: 'u', role: 'user', content: 'hello' },
    {
      id: 'a',
      role: 'assistant',
      content: 'partial answer',
      interrupted: true,
    },
  ]);
  const crashed = store.create(workspace, 'model', 'crashed');
  store.append(crashed.id, [
    { id: 'u2', role: 'user', content: 'hi' },
    {
      id: 'm',
      role: 'user',
      content:
        'The previous turn was interrupted before a reply was saved. Continue from the last user message if they ask again.',
      display: 'Interrupted',
      internal: 'interrupted',
    },
  ]);
  const clean = store.create(workspace, 'model', 'clean');
  store.append(clean.id, [
    { id: 'u3', role: 'user', content: 'done' },
    { id: 'a3', role: 'assistant', content: 'all of it' },
  ]);
  store.close();
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model: new ScriptedModel([]),
    emit: () => {},
  });
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  const messages = (id: string) =>
    controller.snapshot().sessions.find((session) => session.id === id)!
      .messages;
  assert.equal(
    messages(stopped.id).some(
      (message) => message.interrupted && message.text === 'partial answer',
    ),
    true,
  );
  assert.equal(
    messages(stopped.id).some((message) => message.role === 'notice'),
    false,
  );
  assert.equal(
    messages(crashed.id).some(
      (message) => message.interrupted && message.text === '✖ Interrupted',
    ),
    true,
  );
  assert.equal(
    messages(crashed.id).some((message) =>
      message.text.includes('reply was not saved'),
    ),
    false,
  );
  assert.equal(
    messages(clean.id).some((message) => message.interrupted),
    false,
  );
});
