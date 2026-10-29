import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test, type TestContext } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { AgentRuntime } from '../src/runtime.js';
import { SessionApp } from '../src/tui/session_app.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import type { ChatModel, ModelRequest, ModelResponse } from '../src/types.js';
import { cleanup, scratch, until } from './helpers.js';

const blocked = (request: ModelRequest): Promise<ModelResponse> =>
  new Promise((_resolve, reject) => {
    request.signal.throwIfAborted();
    request.signal.addEventListener('abort', () =>
      reject(request.signal.reason),
    );
  });
function database(runtime: AgentRuntime): DatabaseSync {
  return (runtime.store as unknown as { db: DatabaseSync }).db;
}
function rows(runtime: AgentRuntime) {
  return database(runtime)
    .prepare(
      'SELECT id,state,payload FROM input_outbox WHERE session_id=? ORDER BY ordinal',
    )
    .all(runtime.session.id) as {
    id: string;
    state: string;
    payload: string;
  }[];
}
const cleared = JSON.stringify({ text: '', display: '' });
const reply = (content: string) => ({
  message: { id: crypto.randomUUID(), role: 'assistant' as const, content },
});
function runtime(
  home: string,
  workspace: string,
  sessionId?: string,
  model = new ScriptedModel(),
) {
  return new AgentRuntime({
    home,
    userHome: home,
    workspace,
    sessionId,
    model,
    settings: defaultSettings(),
    headless: true,
    bundledExtensions: false,
    screenshot: false,
  });
}
async function session(t: TestContext, model: ChatModel) {
  const home = scratch(t),
    workspace = scratch(t),
    settings = defaultSettings();
  const app = new SessionApp(workspace, home, settings),
    ui = app as any;
  ui.screen.render = () => {};
  app.terminal = {
    platform: process.platform,
    write: () => {},
    input: () => {},
    kill: () => {},
  };
  await app.attach({ workspace, home, settings, model, headless: true });
  const running = app.runtime!;
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    ui.interactions.close();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    if (ui.animation) clearInterval(ui.animation);
    ui.input.close();
    await running.close();
  });
  const key = (name: string, char = '') =>
    ui.handle({ type: 'key', key: name, char });
  const type = (text: string) => {
    for (const char of text) key(char, char);
  };
  return { app, ui, runtime: running, home, workspace, key, type };
}

test('a terminal runtime drops its queue on close and keeps no payload of consumed or discarded rows', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  let running = runtime(
    home,
    workspace,
    undefined,
    new ScriptedModel([reply('one'), reply('two')]),
  );
  cleanup(t, () => running.close());
  const id = running.session.id;
  await running.harness.run('first');
  running.harness.queue('read by the model', 'followUp');
  await running.harness.run();
  running.harness.queue('removed one');
  running.harness.removeQueued('steer', 0, 'removed one');
  running.harness.queue('cleared one');
  running.harness.clearQueue();
  running.harness.queue('left when quitting', 'followUp');
  assert.deepEqual(
    rows(running).map((row) => row.state),
    ['consumed', 'discarded', 'discarded', 'queued'],
  );
  await running.close();
  running = runtime(home, workspace, id);
  assert.deepEqual(running.harness.recoverableInputs.items, []);
  assert.equal(running.harness.pendingMessageCount, 0);
  for (const row of rows(running)) {
    assert.notEqual(row.state, 'queued');
    assert.equal(row.payload, cleared);
  }
  assert.ok(
    running.harness.messages.some(
      (message) => message.content === 'read by the model',
    ),
    'the consumed message itself keeps the text',
  );
});

test('discarding a recovered input clears its row and the stored operation receipt', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  const options = (sessionId?: string) =>
    new AgentRuntime({
      home,
      userHome: home,
      workspace,
      sessionId,
      model: new ScriptedModel(),
      settings: defaultSettings(),
      headless: true,
      bundledExtensions: false,
      screenshot: false,
      preserveQueuedInputs: true,
    });
  let running = options();
  cleanup(t, () => running.close());
  const id = running.session.id;
  running.harness.queue('secret draft text');
  await running.close();
  running = options(id);
  const recovery = running.harness.recoverableInputs;
  const input = recovery.items[0]!;
  assert.equal(input.payload.text, 'secret draft text');
  const request = {
    ids: [input.id],
    expectedVersion: recovery.version,
    operationId: 'drop',
    action: 'discard' as const,
  };
  running.harness.resolveInputs(request);
  assert.equal(rows(running)[0]!.payload, cleared);
  const receipts = database(running)
    .prepare('SELECT result FROM input_outbox_operations WHERE session_id=?')
    .all(id)
    .map((row) => String(row.result));
  assert.equal(receipts.length, 1);
  assert.doesNotMatch(receipts[0]!, /secret draft text/);
  const replay = running.harness.resolveInputs(request);
  assert.equal(replay.applied, false);
  assert.deepEqual(
    replay.items.map((item) => [item.id, item.state]),
    [[input.id, 'discarded']],
  );
});

test('↑ takes a queued message back into the box and leaves no recovery copy for the desktop', async (t) => {
  const model = new ScriptedModel([blocked]);
  const s = await session(t, model);
  const turn = s.app.submit('first');
  await until(() => model.requests.length === 1);
  s.type('take me back');
  s.key('enter');
  assert.equal(s.runtime.harness.pendingMessageCount, 1);
  s.key('up');
  assert.equal(s.app.state.draft, 'take me back');
  assert.equal(s.runtime.harness.pendingMessageCount, 0);
  assert.deepEqual(
    rows(s.runtime).map((row) => [row.state, row.payload]),
    [['discarded', cleared]],
  );
  // ctrl+c clears it from the box; nothing of it stays in circle.sqlite
  await s.runtime.cancel();
  await turn;
  s.key('ctrl+c');
  assert.equal(s.app.state.draft, '');
  assert.deepEqual(s.runtime.harness.recoverableInputs.items, []);
  assert.doesNotMatch(
    JSON.stringify(
      database(s.runtime).prepare('SELECT * FROM input_outbox').all(),
    ),
    /take me back/,
  );
});

test('a store failure while queueing, taking back or drawing the queue is reported, not thrown', async (t) => {
  const model = new ScriptedModel([blocked]);
  const s = await session(t, model);
  const turn = s.app.submit('first');
  await until(() => model.requests.length === 1);
  const db = database(s.runtime);
  db.exec(
    "CREATE TRIGGER reject_enqueue BEFORE INSERT ON input_outbox BEGIN SELECT RAISE(ABORT,'database is locked'); END",
  );
  s.type('kept in the box');
  assert.doesNotThrow(() => s.key('enter'));
  assert.equal(s.app.state.draft, 'kept in the box');
  assert.equal(s.runtime.harness.pendingMessageCount, 0);
  assert.ok(
    s.app.state.notices.some((notice) => notice.includes('database is locked')),
  );
  db.exec('DROP TRIGGER reject_enqueue');
  s.key('enter');
  assert.equal(s.runtime.harness.pendingMessageCount, 1);
  db.exec(
    "CREATE TRIGGER reject_change BEFORE UPDATE ON input_outbox BEGIN SELECT RAISE(ABORT,'lease lost'); END",
  );
  assert.doesNotThrow(() => s.key('up'));
  assert.doesNotThrow(() => s.key('alt+up'));
  assert.equal(s.app.state.draft, '');
  assert.equal(s.runtime.harness.pendingMessageCount, 1);
  assert.equal(rows(s.runtime)[0]!.state, 'queued');
  assert.ok(
    s.app.state.notices.some((notice) => notice.includes('lease lost')),
  );
  db.exec('DROP TRIGGER reject_change');
  const get = s.runtime.store.inputs.get;
  s.runtime.store.inputs.get = () => {
    throw new Error('database is locked');
  };
  try {
    assert.deepEqual(s.runtime.harness.queuedShown, {
      steering: ['kept in the box'],
      followUp: [],
    });
    assert.doesNotThrow(() => s.ui.repaint());
    assert.deepEqual(s.app.state.queue?.steering, ['kept in the box']);
  } finally {
    s.runtime.store.inputs.get = get;
  }
  await s.runtime.cancel();
  await turn;
});

test('an input history that cannot be written is reported once, not on every submit', async (t) => {
  const s = await session(t, new ScriptedModel());
  const rename = fs.renameSync;
  Object.assign(fs, {
    renameSync: ((source, destination) => {
      if (destination === s.ui.history.path)
        throw Object.assign(new Error('read-only'), { code: 'EROFS' });
      return rename(source, destination);
    }) as typeof fs.renameSync,
  });
  syncBuiltinESMExports();
  t.after(() => {
    Object.assign(fs, { renameSync: rename });
    syncBuiltinESMExports();
  });
  for (const text of ['one', 'two', 'three']) {
    s.type(text);
    s.key('ctrl+c');
  }
  const reported = () =>
    s.app.state.notices.filter((notice) =>
      notice.includes('input history publish failed (EROFS)'),
    ).length;
  assert.equal(reported(), 1);
  assert.deepEqual(s.ui.history.items, ['one', 'two', 'three']);
  assert.equal(s.ui.history.pendingCount, 3);
});
