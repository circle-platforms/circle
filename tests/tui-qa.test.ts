import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { isHostAbsolutePath, Sandbox } from '../src/sandbox.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { sessionSearchText } from '../src/session_search.js';
import { friendlyModelError } from '../src/model_error.js';
import { fallbackTitle } from '../src/session_title.js';
import { defaultEffort } from '../src/model.js';
import { wrap, stripAnsi } from '../src/ink/string_width.js';
import { highlightTokens } from '../src/ink/highlight.js';
import { markdownRows } from '../src/ink/components/markdown_renderer.js';
import { messageCosts, formatCosts } from '../src/pricing.js';
import { contextInputOf, footerRow } from '../src/tui/status_rows.js';
import { thinkingRows } from '../src/tui/tool_rows.js';
import { variableCopy, hotkeysText } from '../src/tui/slash_commands.js';
import { Picker } from '../src/ink/components/picker.js';
import { DEFAULT_DARK, buildPalette, setPalette } from '../src/ink/theme.js';
import { SessionApp } from '../src/tui/session_app.js';
import { AgentRuntime } from '../src/runtime.js';
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
  const streamed = store.create(home, 'model');
  store.append(streamed.id, [
    { id: 'u2', role: 'user', content: 'go on' },
    {
      id: 'a2',
      role: 'assistant',
      content: 'partial',
      thinking: 'still going',
      interrupted: true,
      usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 0 },
    },
  ]);
  store.repairInterrupted(streamed.id);
  store.repairInterrupted(streamed.id);
  const after = store
    .messages(streamed.id)
    .filter((message) => message.internal === 'interrupted');
  assert.equal(after.length, 1);
  const finished = store.create(home, 'model');
  store.append(finished.id, [
    { id: 'u3', role: 'user', content: 'done' },
    {
      id: 'a3',
      role: 'assistant',
      content: 'all of it',
      request_model: 'model',
    },
  ]);
  store.repairInterrupted(finished.id);
  assert.equal(
    store
      .messages(finished.id)
      .some((message) => message.internal === 'interrupted'),
    false,
  );
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
    system: 'test system prompt',
    priceUsage: () => ({
      model: 'glm-5.3',
      currency: 'USD',
      amount: 0.0035,
      tokens: {
        input_miss: 100,
        input_hit: 0,
        input_write: 0,
        input_write_1h: 0,
        output: 236,
      },
      rates: { input: 1, output: 2 },
      provider: 'test',
    }),
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
  assert.ok((answer?.usage?.input_tokens ?? 0) > 0);
  assert.equal(answer?.interrupted, true);
  assert.deepEqual(
    events
      .map((event) => event.kind)
      .filter((kind) => kind === 'llm_end' || kind === 'run_error'),
    ['llm_end', 'run_error'],
  );
  const status = new TurnStatus();
  for (const event of events) status.apply(event, () => answer?.id);
  assert.equal(status.usage[answer!.id]!.output, 236);
  assert.equal(status.usage[answer!.id]!.input, answer!.usage!.input_tokens);
  assert.equal(
    contextInputOf({ usage: answer?.usage }, 'scripted'),
    answer!.usage!.input_tokens,
  );
  const footer = stripAnsi(
    footerRow(
      {
        usage: {
          ...answer!.usage!,
          estimated_input_tokens: answer!.usage!.input_tokens,
          estimated_output_tokens: answer!.usage!.output_tokens,
        },
      },
      '',
      80,
    ),
  );
  assert.match(footer, /↓ 236/);
  assert.equal(footer.includes('↑ 0'), false);
  assert.equal(footer.includes('cache 0.0%'), false);
  assert.match(footer, /cache N\/A/);
  assert.equal(answer?.cost?.amount, 0.0035);
  assert.equal(formatCosts([messageCosts([answer!])]), '~$0.0035');
  const unpriced = messageCosts([
    answer!,
    {
      id: 'other',
      role: 'assistant',
      content: '',
      usage: { ...answer!.usage!, estimated_input_tokens: undefined },
      interrupted: false,
      cost: { ...answer!.cost!, amount: null, currency: '' },
    },
  ]);
  assert.equal(formatCosts([unpriced]), '~$0.0035+');
  const estimateOnly = messageCosts([
    {
      ...answer!,
      cost: { ...answer!.cost!, amount: null, currency: '' },
    },
  ]);
  assert.equal(formatCosts([estimateOnly]), 'N/A');
});

test('renaming a session does not move it above a newer one', async (t) => {
  const home = scratch(t);
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  const older = store.create(home, 'model', 'older');
  await delay(5);
  const newer = store.create(home, 'model', 'newer');
  assert.deepEqual(
    store.list().map((session) => session.id),
    [newer.id, older.id],
  );
  const updated = store.get(older.id)!.updated;
  store.rename(older.id, 'renamed');
  assert.equal(store.get(older.id)!.title, 'renamed');
  assert.equal(store.get(older.id)!.updated, updated);
  assert.deepEqual(
    store.list().map((session) => session.id),
    [newer.id, older.id],
  );
});

test('opening a session does not move it above a later message', async (t) => {
  const home = scratch(t);
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  const older = store.create(home, 'model', 'older');
  store.append(older.id, [
    { id: 'u', role: 'user', content: 'first question from earlier today' },
    { id: 'a', role: 'assistant', content: 'done' },
  ]);
  await delay(5);
  const newer = store.create(home, 'model', 'newer');
  store.append(newer.id, [
    { id: 'u2', role: 'user', content: 'second question from later today' },
    { id: 'a2', role: 'assistant', content: 'done' },
  ]);
  const order = [newer.id, older.id];
  assert.deepEqual(
    store.list().map((session) => session.id),
    order,
  );
  store.append(older.id, [
    {
      id: 'mark',
      role: 'user',
      content: 'opened',
      display: 'Interrupted',
      internal: 'interrupted',
    },
  ]);
  store.rename(older.id, 'repaired title');
  assert.deepEqual(
    store.list().map((session) => session.id),
    order,
  );
  store.close();
  const settings = defaultSettings();
  settings.default_mode = 'plan';
  const runtime = new AgentRuntime({
    workspace: home,
    home,
    settings,
    model: new ScriptedModel([]),
    session: older.id,
    headless: true,
    localContext: false,
    bundledExtensions: false,
  });
  cleanup(t, () => runtime.close());
  assert.deepEqual(
    runtime.store.list().map((session) => session.id),
    order,
  );
});

test('a saved thought keeps its duration after the turn', async (t) => {
  const { Harness } = await import('../src/harness.js');
  const { ApprovalPolicy, ApprovalStore } = await import('../src/approvals.js');
  const { join } = await import('node:path');
  const home = scratch(t);
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  const session = store.create(home, 'model');
  const model: ChatModel = {
    model: 'scripted',
    async complete(request: ModelRequest) {
      request.token('**Check the notes**\n\nThe file has three lines.', true);
      await delay(20);
      request.token('done');
      return {
        message: {
          id: 'a',
          role: 'assistant',
          content: 'done',
          thinking: '**Check the notes**\n\nThe file has three lines.',
        },
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
  await run.run('hello there');
  const saved = store
    .messages(session.id)
    .find((message) => message.role === 'assistant');
  assert.equal(typeof saved?.thinking_seconds, 'number');
  assert.ok((saved?.thinking_seconds ?? -1) >= 0);
  const row = stripAnsi(
    thinkingRows(saved!.thinking!, {
      done: true,
      seconds: saved!.thinking_seconds,
      expanded: false,
      width: 80,
    })[0]!,
  );
  assert.match(row, /∴ Thought \d+\.\ds · Check the notes {2}ctrl\+t/);
  assert.equal(row.includes('Thought  ctrl'), false);
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
  // Windows resolves a rooted path onto the current drive: D:\srv\data\file.txt.
  const slashes = (path: string) => path.replaceAll('\\', '/');
  const box = new Sandbox('/workspace/tui-proj');
  const outside = slashes(box.resolvePath('/workspace/tui-proj'));
  assert.equal(outside.includes('/workspace/tui-proj/workspace'), false);
  assert.match(outside, /tui-proj$/);
  const elsewhere = slashes(box.resolvePath('/srv/data/file.txt'));
  assert.equal(elsewhere.includes('/workspace'), false);
  assert.match(elsewhere, /(^|:)\/srv\/data\/file\.txt$/);
  assert.match(slashes(box.resolvePath('notes.txt')), /tui-proj\/notes\.txt$/);
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
  // The desktop lists the conversation it has open before the first message.
  assert.equal(
    legacy
      .list(workspace, false, true)
      .some((session) => session.id === 'circle-empty'),
    true,
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

test('the command list loads where there is no process, as in the desktop window', () => {
  // The desktop renderer and its browser preview import this list. A top-level
  // `process.platform` there left the window blank.
  const source = stripTypeScriptTypes(
    readFileSync(
      new URL('../src/tui/slash_commands.ts', import.meta.url),
      'utf8',
    ),
  ).replace(/^export /gm, '');
  for (const [agent, windows] of [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Circle', true],
    ['Mozilla/5.0 (X11; Linux x86_64) Circle', false],
  ] as const) {
    const loaded = runInNewContext(
      `${source}\n({ BUILTIN_SLASH, variableCopy })`,
      { navigator: { userAgent: agent } },
    ) as {
      BUILTIN_SLASH: { name: string; description: string }[];
      variableCopy: typeof variableCopy;
    };
    const variables = loaded.BUILTIN_SLASH.find(
      (command) => command.name === 'variables',
    )!;
    assert.equal(variables.description.includes('%NAME%'), windows, agent);
    assert.equal(
      loaded.variableCopy().saved('BASE').includes('%BASE%'),
      windows,
    );
  }
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
