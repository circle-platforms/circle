import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { SessionApp } from '../src/tui/session_app.js';
import { ScriptedModel } from '../src/testing.js';
import {
  defaultSettings,
  loadCredentials,
  saveCredentials,
} from '../src/settings.js';
import {
  renderScreen,
  transcriptRows,
  type ScreenState,
} from '../src/tui/render.js';
import { TranscriptFind } from '../src/tui/transcript_find.js';
import {
  buildPalette,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  setPalette,
} from '../src/ink/theme.js';
import { stripAnsi } from '../src/ink/string_width.js';
import { emptyUsage, type Message } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await delay(5);
  }
}

const user = (id: string, content: string): Message => ({
  id,
  role: 'user',
  content,
});
const reply = (id: string, content: string): Message => ({
  id,
  role: 'assistant',
  content,
});
function screen(messages: Message[]): ScreenState {
  return {
    messages,
    notices: [],
    welcome: [],
    draft: '',
    draftCursor: 0,
    model: 'model-x',
    workspace: '/project/app',
    version: '1.0.0',
    busy: false,
    waiting: false,
    planMode: false,
    autoMode: false,
    todos: [],
    showThinking: true,
    showTools: false,
    streaming: '',
    thinking: '',
    usage: emptyUsage(),
    flash: '',
    started: Date.now(),
    scroll: 0,
    hiddenTurns: 0,
  };
}

test('the store serves one shared messages array while the head stands still, and writes move it', () => {
  const store = new CheckpointStore();
  const session = store.create('/w', 'm');
  const firstHead = store.append(session.id, [
    user('u1', 'one'),
    reply('a1', 'first answer'),
  ])!;
  // Same head: the array and its messages are the same objects, not a rewalk.
  const first = store.messages(session.id);
  assert.equal(store.messages(session.id), first);
  assert.equal(store.messages(session.id, firstHead), first);
  // An append extends the cache: the old messages keep their identity.
  const version = store.version;
  const appended = user('u2', 'two');
  store.append(session.id, [appended]);
  assert.ok(store.version > version);
  const second = store.messages(session.id);
  assert.equal(second.length, 3);
  assert.ok(second.slice(0, 2).every((message, i) => message === first[i]));
  // It serves what was written, as a fresh read would, not the caller's object.
  assert.notEqual(second[2], appended);
  appended.content = 'changed afterwards';
  assert.equal(store.messages(session.id)[2]!.content, 'two');
  // Selecting the older head walks that branch, and the current head follows it.
  store.select(session.id, firstHead);
  assert.deepEqual(
    store.messages(session.id).map((message) => message.id),
    ['u1', 'a1'],
  );
});

test("a session's checkpoints are read once: a write adds only its rows, and another connection's are read", (t) => {
  const home = scratch(t);
  const store = new CheckpointStore(home);
  const other = new CheckpointStore(home);
  cleanup(t, () => {
    store.close();
    other.close();
  });
  const session = store.create('/w', 'm');
  // A pasted picture is several megabytes of base64 in one message
  const picture: Message = {
    id: 'u1',
    role: 'user',
    content: 'and this screenshot',
    attachments: [
      {
        kind: 'image',
        mime_type: 'image/png',
        filename: 'screen.png',
        data: 'A'.repeat(4_000_000),
        sha256: '0'.repeat(64),
      },
    ],
  };
  store.append(session.id, [picture, reply('a1', 'a big one')]);
  const first = store.tree(session.id);
  assert.equal(first.length, 2);
  // A repaint reads nothing again: the rows and their messages are the same objects
  assert.equal(store.tree(session.id), first);
  assert.equal(store.messages(session.id)[0], first[0]!.message);
  // A later turn adds its rows; the picture's row is not decoded again
  store.append(session.id, [user('u2', 'two'), reply('a2', 'second answer')]);
  const second = store.tree(session.id);
  assert.deepEqual(
    second.map((row) => row.message.id),
    ['u1', 'a1', 'u2', 'a2'],
  );
  assert.ok(second.slice(0, 2).every((row, i) => row === first[i]));
  assert.equal(store.messages(session.id)[2], second[2]!.message);
  // What another connection (the terminal) writes is read, and only that
  other.append(session.id, [user('u3', 'from the terminal')]);
  const third = store.tree(session.id);
  assert.deepEqual(
    third.map((row) => row.message.id),
    ['u1', 'a1', 'u2', 'a2', 'u3'],
  );
  assert.ok(third.slice(0, 4).every((row, i) => row === second[i]));
  assert.deepEqual(
    store.messages(session.id).map((message) => message.id),
    ['u1', 'a1', 'u2', 'a2', 'u3'],
  );
  // A branch from an earlier head is read from the same rows
  store.select(session.id, first[1]!.id);
  store.append(session.id, [user('u4', 'a branch')]);
  assert.deepEqual(
    store.messages(session.id).map((message) => message.id),
    ['u1', 'a1', 'u4'],
  );
  assert.equal(store.messages(session.id)[0], first[0]!.message);
  assert.equal(store.tree(session.id).length, 6);
  // A session another connection deleted has no rows left
  other.delete(session.id);
  assert.deepEqual(store.tree(session.id), []);
});

test('frozen message rows replay from the cache, and every input that changes them re-renders', () => {
  const messages: Message[] = [
    user('u1', 'compile the batches'),
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'c1', name: 'execute', args: { command: 'npm test' } },
      ],
    },
    {
      id: 't1',
      role: 'tool',
      tool_call_id: 'c1',
      name: 'execute',
      content: 'ok\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8',
    },
    reply('a2', 'Final report: all pass.'),
  ];
  const dark = buildPalette(...DEFAULT_DARK);
  const light = buildPalette(...DEFAULT_LIGHT);
  setPalette(dark);
  const first = transcriptRows(screen(messages), 80);
  // A repaint with fresh state objects but the same messages replays byte-identical rows.
  assert.deepEqual(transcriptRows(screen(messages), 80), first);
  // The fold flag, the width and the theme each produce different rows.
  assert.notDeepEqual(
    transcriptRows({ ...screen(messages), showTools: true }, 80),
    first,
  );
  assert.notDeepEqual(transcriptRows(screen(messages), 100), first);
  setPalette(light);
  const flipped = transcriptRows(screen(messages), 80);
  assert.notDeepEqual(flipped, first);
  // The words are the same; only the colours moved.
  assert.deepEqual(flipped.map(stripAnsi), first.map(stripAnsi));
  setPalette(dark);
  // A turn that is still working is never cached: the lamp follows the turn.
  const pending = messages.slice(0, 2);
  const running = transcriptRows({ ...screen(pending), busy: true }, 80);
  assert.ok(running.some((row) => stripAnsi(row).includes('Bash(npm test)')));
  assert.notDeepEqual(
    transcriptRows({ ...screen(pending), busy: true, waiting: true }, 80),
    running,
  );
  // Once the result is in, the answer is frozen and stays stable.
  const done = transcriptRows(screen(messages), 80);
  assert.deepEqual(transcriptRows(screen(messages), 80), done);
  assert.ok(done.some((row) => stripAnsi(row).includes('+2 lines')));
});

test('typing in find over a long transcript rematches cached rows and never renormalizes them', (t) => {
  const root = scratch(t);
  const app = new SessionApp(root, root, defaultSettings());
  const ui = app as any;
  ui.screen.render = (): void => {};
  cleanup(t, () => {
    if (ui.renderTimer) clearTimeout(ui.renderTimer);
    ui.input.close();
  });
  const messages: Message[] = [];
  for (let i = 0; i < 200; i++) {
    messages.push(user(`u${i}`, `question ${i} about the needle stack`));
    messages.push(reply(`a${i}`, `answer ${i} explains the haystack`));
  }
  ui.state.messages = messages;
  ui.handle({ type: 'key', key: 'ctrl+f', char: '' });
  const find = app.state.find!;
  assert.ok(find, 'ctrl+f opens find');
  assert.equal(
    find.normalizations,
    1,
    'opening normalizes the transcript once',
  );
  for (const char of 'needle') ui.handle({ type: 'key', key: '', char });
  assert.equal(find.query, 'needle');
  assert.equal(find.normalizations, 1, 'six keystrokes renormalize nothing');
  // The cached rematch agrees with a fresh full render of the same conversation.
  const width = process.stdout.columns || 80;
  const expected = new TranscriptFind();
  expected.query = 'needle';
  expected.refresh(transcriptRows(app.state, width));
  assert.deepEqual(find.matches, expected.matches);
  assert.ok(find.matches.length >= 200);
  ui.handle({ type: 'key', key: 'backspace', char: '' });
  assert.equal(find.query, 'needl');
  assert.equal(find.normalizations, 1);
  const rows = renderScreen(app.state, width, 40);
  assert.ok(
    rows.some((row) => stripAnsi(row).includes('find: needl')),
    'the find status shows the edited query',
  );
});

test('requestRender coalesces a burst into one frame and a direct repaint supersedes it', async (t) => {
  const root = scratch(t);
  const app = new SessionApp(root, root, defaultSettings());
  const ui = app as any;
  let frames = 0;
  ui.screen.render = (): void => {
    frames++;
  };
  try {
    ui.repaint();
    assert.equal(frames, 1);
    for (let i = 0; i < 50; i++) ui.requestRender();
    await delay(60);
    assert.equal(frames, 2);
    // A queued frame gives way to the direct draw.
    ui.requestRender();
    ui.repaint();
    await delay(60);
    assert.equal(frames, 3);
  } finally {
    if (ui.renderTimer) clearTimeout(ui.renderTimer);
    ui.input.close();
  }
});

test('a streaming turn keeps the loop responsive: a key works right away and frames coalesce', async (t) => {
  const root = scratch(t);
  const settings = defaultSettings();
  const app = new SessionApp(root, root, settings);
  const ui = app as any;
  let frames = 0;
  ui.screen.render = (): void => {
    frames++;
  };
  await app.attach({
    workspace: root,
    home: root,
    settings,
    model: new ScriptedModel(),
  });
  const runtime = app.runtime!;
  cleanup(t, () => runtime.close());
  cleanup(t, () => {
    if (ui.renderTimer) clearTimeout(ui.renderTimer);
    if (ui.animation) clearInterval(ui.animation);
    ui.input.close();
  });
  // A burst of stream tokens, as a fast model answer produces.
  const started = performance.now();
  for (let i = 0; i < 200; i++)
    runtime.bus.emit('llm_token', { payload: { text: 'answer ' + i + ' ' } });
  // A key in the middle of it is the user's, not the stream's.
  ui.handle({ type: 'key', key: 'ctrl+o', char: '' });
  assert.equal(app.state.showTools, true, 'the key was handled at once');
  await delay(80);
  assert.ok(app.state.streaming.includes('answer 199'));
  assert.ok(
    performance.now() - started < 1000,
    'a 200-token burst and a key stay well under a second',
  );
  assert.ok(
    frames <= 5,
    `frames coalesced (${frames} drawn, not one per token)`,
  );
});

test('/logout waits for running sessions while read-only /skill remains available', async (t) => {
  const root = scratch(t);
  // A skill of the run's own, so the list does not depend on the machine's ~/.agents.
  mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
  writeFileSync(
    join(root, 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: A demo skill\n---\nAlways answer in haiku.\n',
  );
  const settings = defaultSettings();
  saveCredentials({ api_key: 'sk-live' }, root);
  const model = new ScriptedModel([
    (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () =>
          reject(request.signal.reason),
        );
      }) as never,
  ]);
  const app = new SessionApp(root, root, settings);
  const ui = app as any;
  ui.screen.render = (): void => {};
  await app.attach({ workspace: root, home: root, settings, model });
  const runtime = app.runtime!;
  cleanup(t, () => runtime.close());
  cleanup(t, () => {
    if (ui.renderTimer) clearTimeout(ui.renderTimer);
    if (ui.animation) clearInterval(ui.animation);
    ui.input.close();
  });
  const turn = runtime.harness.run('work').catch(() => {});
  await until(() => runtime.busy);
  // Busy includes asynchronous initialization and attachment preparation. A history
  // comparison needs the actual initial user checkpoint, not that earlier boundary.
  await until(() => model.requests.length === 1);
  const sentUser = model.requests[0]!.messages.find(
    (message) => message.role === 'user',
  );
  assert.equal(sentUser?.content, 'work');
  assert.equal(
    runtime.store
      .messages(runtime.session.id)
      .find((message) => message.role === 'user')?.id,
    sentUser?.id,
    'the model is waiting on the same user message already stored in history',
  );
  assert.equal(loadCredentials(root).api_key, 'sk-live');
  await app.command('logout', '');
  assert.equal(app.state.busy, true, 'the turn still runs');
  assert.equal(
    loadCredentials(root).api_key,
    'sk-live',
    'busy logout cannot replace credentials used by an in-flight session',
  );
  assert.match(app.state.flash!, /wait for all sessions to finish/);
  assert.ok(!app.state.notices.some((note) => note.includes('Signed out')));
  await app.command('skill', '');
  assert.ok(
    app.state.notices.some(
      (note) => note.startsWith('Skills:') && note.includes('demo'),
    ),
    'the skill list is answered while the turn runs',
  );
  // Loading one writes into the conversation the turn is writing, and a reload replaces
  // the tools the turn may be calling: those forms wait for the turn.
  const head = runtime.store.get(runtime.session.id)?.head;
  assert.ok(head, 'the running model request has a persisted checkpoint');
  await app.command('skill', 'demo');
  assert.equal(
    app.state.flash,
    'Busy · load the skill when the turn has finished',
  );
  assert.equal(runtime.store.get(runtime.session.id)?.head, head);
  assert.ok(!app.state.notices.some((note) => note.startsWith('Loaded skill')));
  await app.command('extensions', 'reload');
  assert.equal(
    app.state.flash,
    'Busy · reload extensions when the turn has finished',
  );
  assert.ok(
    !app.state.notices.some((note) => note.startsWith('Extensions reloaded')),
  );
  await runtime.cancel();
  await turn;
  await app.command('logout', '');
  assert.equal(loadCredentials(root).api_key, undefined);
  assert.ok(app.state.notices.some((note) => note.includes('Signed out')));
});
