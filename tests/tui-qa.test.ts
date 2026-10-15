import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { isHostAbsolutePath, Sandbox } from '../src/sandbox.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { sessionSearchText } from '../src/session_search.js';
import { friendlyModelError } from '../src/model_error.js';
import { fallbackTitle } from '../src/session_title.js';
import { defaultEffort } from '../src/model.js';
import { wrap, stripAnsi } from '../src/ink/string_width.js';
import { highlightTokens } from '../src/ink/highlight.js';
import { markdownRows } from '../src/ink/components/markdown_renderer.js';
import { contextInputOf, footerRow } from '../src/tui/status_rows.js';
import { variableCopy, hotkeysText } from '../src/tui/slash_commands.js';
import { Picker } from '../src/ink/components/picker.js';
import { DEFAULT_DARK, buildPalette, setPalette } from '../src/ink/theme.js';
import { SessionApp } from '../src/tui/session_app.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { emptyUsage, type ChatModel, type ModelRequest } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

test('an unanswered prompt is marked interrupted once', (t) => {
  const home = scratch(t);
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  const session = store.create(home, 'model');
  store.append(session.id, [{ id: 'u', role: 'user', content: 'hello' }]);
  store.repairInterrupted(session.id);
  store.repairInterrupted(session.id);
  const marks = store
    .messages(session.id)
    .filter((message) => message.internal === 'interrupted');
  assert.equal(marks.length, 1);
  assert.equal(marks[0]!.display, 'Interrupted');
});

test('a partial reply reports the same output on the turn line and in the footer', async (t) => {
  const { Harness } = await import('../src/harness.js');
  const { ApprovalPolicy, ApprovalStore } = await import('../src/approvals.js');
  const { TurnStatus } = await import('../src/tui/turn_status.js');
  const { join } = await import('node:path');
  const home = scratch(t);
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  const session = store.create(home, 'model');
  const thought = 'x'.repeat(944);
  const model: ChatModel = {
    model: 'scripted',
    async complete(request: ModelRequest) {
      request.token(thought, true);
      await new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () =>
          reject(request.signal.reason),
        );
      });
      return {
        message: { id: 'unused', role: 'assistant', content: '' },
        usage: emptyUsage(),
      };
    },
  };
  const run = new Harness({
    model,
    tools: [],
    store,
    session,
    policy: new ApprovalPolicy(
      new ApprovalStore(join(home, 'approvals')),
      home,
    ),
    system: 'test',
  });
  const events: import('../src/events.js').CircleEvent[] = [];
  run.bus.subscribe((event) => events.push(event));
  const pending = run.run(
    'please explain roman citizenship across the empire in detail',
  );
  await delay(20);
  await run.cancel();
  await pending.catch(() => {});
  const answer = store
    .messages(session.id)
    .find((message) => message.role === 'assistant');
  assert.equal(answer?.usage?.output_tokens, 236);
  assert.deepEqual(
    events
      .map((event) => event.kind)
      .filter((kind) => kind === 'llm_end' || kind === 'run_error'),
    ['llm_end', 'run_error'],
  );
  const status = new TurnStatus();
  for (const event of events) status.apply(event, () => answer?.id);
  assert.equal(status.usage[answer!.id]!.output, 236);
  assert.equal(contextInputOf({ usage: answer?.usage }, 'scripted'), undefined);
  const footer = stripAnsi(
    footerRow({ usage: answer!.usage!, contextInput: undefined }, '', 80),
  );
  assert.match(footer, /↓ 236/);
  assert.equal(footer.includes('N/A'), false);
});

test('every POSIX absolute path stays absolute, including outside the old top-level whitelist', () => {
  for (const path of ['/workspace/tui-proj', '/srv/app', '/data/x', '/code/a'])
    assert.equal(isHostAbsolutePath(path, 'linux'), true, path);
  assert.equal(isHostAbsolutePath('src/main.ts', 'linux'), false);
  assert.equal(isHostAbsolutePath('~/notes', 'linux'), true);
  assert.equal(isHostAbsolutePath('C:\\code', 'win32'), true);
  assert.equal(isHostAbsolutePath('C:/code', 'win32'), true);
  assert.equal(isHostAbsolutePath('\\\\server\\share\\a', 'win32'), true);
  assert.equal(isHostAbsolutePath('/workspace/tui-proj', 'win32'), true);
  assert.equal(isHostAbsolutePath('src\\main.ts', 'win32'), false);
  const box = new Sandbox('/workspace/tui-proj');
  const outside = box.resolvePath('/workspace/tui-proj');
  assert.equal(outside.includes('/workspace/tui-proj/workspace'), false);
  assert.match(outside, /tui-proj$/);
  const elsewhere = box.resolvePath('/srv/data/file.txt');
  assert.equal(elsewhere.startsWith('/workspace'), false);
  assert.match(elsewhere, /\/srv\/data\/file\.txt$/);
  assert.match(box.resolvePath('notes.txt'), /tui-proj\/notes\.txt$/);
});

test('a session row appears on the first message, and an empty or unanswered one does not stay', (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  const parked = store.create(workspace, 'model', '', undefined, null, true);
  assert.equal(store.list().length, 0);
  assert.equal(store.get(parked.id)?.head, null);
  store.append(parked.id, []);
  assert.equal(
    store.list().length,
    0,
    'an empty append must not write the row',
  );
  store.append(parked.id, [{ id: 'u1', role: 'user', content: 'hi' }]);
  assert.equal(store.list().length, 1);
  assert.equal(store.abandonUnanswered(parked.id), true);
  assert.equal(store.list().length, 0);
  assert.equal(store.get(parked.id)?.title, '');
  const kept = store.create(workspace, 'model');
  store.append(kept.id, [
    { id: 'u2', role: 'user', content: 'stay' },
    { id: 'a2', role: 'assistant', content: 'ok' },
  ]);
  assert.equal(store.abandonUnanswered(kept.id), false);
  store.close();
  const legacy = new CheckpointStore(home);
  cleanup(t, () => legacy.close());
  legacy.create(workspace, 'model', '', 'circle-empty');
  assert.equal(
    legacy.list().some((session) => session.id === 'circle-empty'),
    false,
  );
  legacy.close();
  const held = new CheckpointStore(home);
  cleanup(t, () => held.close());
  const live = held.create(workspace, 'model', '', 'circle-live');
  held.claimSession(live.id);
  const purged = new CheckpointStore(home);
  cleanup(t, () => purged.close());
  purged.purgeEmptySessions();
  assert.equal(purged.get('circle-empty'), undefined);
  assert.ok(purged.get('circle-live'));
  assert.equal(purged.list().length, 1);
  held.releaseSession(live.id);
  purged.purgeEmptySessions();
  assert.equal(purged.get('circle-live'), undefined);
});

test('session search matches later replies and skips tool output', () => {
  const text = sessionSearchText(
    { id: 'circle-1', title: 'Hi', workspace: '/work' },
    [
      { id: '1', role: 'user', content: 'hello' },
      { id: '2', role: 'assistant', content: 'the fibonacci sequence' },
      { id: '3', role: 'tool', content: 'tool-only-word' },
      { id: '4', role: 'user', content: 'and later still' },
    ],
  );
  assert.match(text, /fibonacci/);
  assert.match(text, /later still/);
  assert.equal(text.includes('tool-only-word'), false);
});

test('a bad model name becomes a short message that points at /models', () => {
  const raw =
    '400 {"error":{"message":"model `nope` does not exist","type":"not_found_error"}}';
  const friendly = friendlyModelError(raw, 400);
  assert.match(friendly, /Unknown model/);
  assert.match(friendly, /\/models/);
  assert.equal(friendly.includes('{'), false);
  assert.equal(defaultEffort('anthropic'), 'medium');
  assert.equal(
    fallbackTitle('please write a short note about the build'),
    'write a short note about the build',
  );
});

test('help text wraps on spaces, code fences name their language, and a narrow footer drops a meter', () => {
  const colours = buildPalette(...DEFAULT_DARK);
  setPalette(colours);
  assert.deepEqual(wrap('detail page', 8), ['detail', 'page']);
  const help = wrap(hotkeysText(), 60);
  assert.ok(help.every((line) => !/\S$/.test('x') || !line.endsWith(' pa')));
  const rows = markdownRows('```ts\nconst n = "hi";\n```', 40);
  const plain = rows.map(stripAnsi).join('\n');
  assert.match(plain, /\bts\b/);
  assert.match(plain, /const/);
  assert.ok(rows.join('').includes(colours.blue));
  assert.ok(rows.every((row) => row.includes(colours.panel_bg)));
  const kinds = highlightTokens('ts', 'const n = "hi";');
  assert.equal(kinds.find((token) => token.text === 'const')?.kind, 'keyword');
  assert.equal(kinds.find((token) => token.text === '"hi"')?.kind, 'string');
  const footer = stripAnsi(
    footerRow(
      {
        usage: {
          input_tokens: 36_600,
          output_tokens: 560,
          cache_read_tokens: 20_000,
        },
        contextInput: 91_000,
        contextWindow: 100_000,
      },
      '',
      36,
    ),
  );
  assert.equal(footer.includes('…'), false);
  assert.match(footer, /↑/);
  assert.equal(footer.includes('ctx'), false);
});

test('a focused list row is marked and a rename starts with the old name selected', () => {
  const picker = new Picker(
    'Sessions',
    [{ key: 'a', label: 'question one' }],
    () => {},
    () => {},
  );
  assert.match(stripAnsi(picker.rows(60).join('\n')), /> question one/);
  picker.ask('Rename', 'question one', () => {}, { replace: true });
  picker.handle('Z', 'Z');
  const asked = stripAnsi(picker.rows(80).join('\n'));
  assert.match(asked, /Rename: Z/);
  assert.doesNotMatch(asked, /Rename: question/);
});

test('/variables and /secrets omit the Windows placeholder except on Windows', () => {
  assert.equal(variableCopy('linux').variables.includes('%NAME%'), false);
  assert.equal(variableCopy('linux').secrets.includes('%NAME%'), false);
  assert.match(variableCopy('win32').variables, /%NAME%/);
  assert.match(variableCopy('linux').saved('BASE'), /Circle fills BASE in/);
  assert.match(variableCopy('win32').saved('BASE'), /%BASE%/);
});

test('the terminal creates a session on the first message, keeps the user text after a model error, and counts streamed text', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  let release: (() => void) | undefined;
  const held = new Promise<void>((ready) => {
    release = ready;
  });
  const model = new ScriptedModel([
    async (request) => {
      request.token('hello there');
      await held;
      return {
        message: {
          id: 'a1',
          role: 'assistant',
          content: 'hello there',
        },
        usage: { ...emptyUsage(), output_tokens: 3 },
      };
    },
    () => {
      const error = new Error(
        '400 {"error":{"message":"model `nope` does not exist","type":"not_found_error"}}',
      );
      (error as { status?: number }).status = 400;
      throw error;
    },
  ]);
  const app = new SessionApp(workspace, home, defaultSettings());
  const ui = app as unknown as {
    screen: { render: () => void };
    off?: () => void;
    offSignals?: () => void;
    flashTimer?: ReturnType<typeof setTimeout>;
    input: { close: () => void };
    views: Map<unknown, { interactions: { close: () => void } }>;
    sessions?: { close: () => Promise<void> };
    browsers: Map<unknown, { close: () => Promise<void> }>;
    handle: (event: { type: string; key: string; char: string }) => void;
    repaint: () => void;
    frameRows: string[];
  };
  ui.screen.render = () => {};
  await app.attach({
    workspace,
    home,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  const runtime = app.runtime!;
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
    for (const view of ui.views.values()) view.interactions.close();
    await (ui.sessions?.close() ?? runtime.close());
    await Promise.all(
      [...ui.browsers.values()].map((browser) => browser.close()),
    );
  });
  const startupId = runtime.session.id;
  assert.equal(runtime.store.list().length, 0);
  await app.submit('/new');
  const current = app.runtime!;
  assert.notEqual(current.session.id, startupId);
  assert.equal(current.store.list().length, 0);
  assert.match(app.state.notices.at(-1) ?? '', /New session/);
  const turn = app.submit('hi');
  for (let i = 0; i < 50 && !app.state.streaming.includes('hello'); i++)
    await delay(20);
  ui.repaint();
  assert.match(app.state.streaming, /hello/);
  assert.ok((app.state.busyTokens ?? 0) > 0);
  assert.ok(app.state.usage.output_tokens > 0);
  release?.();
  await turn;
  const id = current.session.id;
  assert.equal(current.store.list().length, 1);
  assert.equal(current.store.get(id)?.title, 'hi');
  await app.submit('/new');
  const failedId = app.runtime!.session.id;
  assert.notEqual(failedId, id);
  assert.equal(
    runtime.store.list().some((session) => session.id === failedId),
    false,
  );
  const failed = app.submit('again');
  await failed.catch(() => {});
  await delay(30);
  assert.match(app.state.notices.at(-1) ?? '', /Unknown model/);
  assert.match(app.state.notices.at(-1) ?? '', /\/models/);
  assert.equal((app.state.notices.at(-1) ?? '').includes('{'), false);
  assert.equal(
    app.runtime!.store.list().some((session) => session.id === failedId),
    true,
  );
  assert.match(
    app.runtime!.harness.messages.find((message) => message.role === 'user')
      ?.content ?? '',
    /again/,
  );
  ui.repaint();
  assert.match(ui.frameRows.map(stripAnsi).join('\n'), /again/);
});
