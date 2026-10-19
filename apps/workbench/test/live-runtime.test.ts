import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveRuntime } from '../src/model/live.ts';
import { PreviewRuntime, STORAGE_KEY } from '../src/model/state.ts';
import { saveSessionScroll } from '../src/model/presentation.ts';
import { createFixtures } from '../src/preview/fixtures.ts';
import type { DesktopBridge } from '../../desktop/src/contracts.ts';
import type {
  RuntimeCommand,
  RuntimeUpdate,
} from '../../desktop/src/runtime-protocol.ts';

test('hub object pages disclose byte-budget omissions instead of claiming nothing was read', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { HubProjectionNotice } = await import('../src/plugins/hub');
  const { setLanguage } = await import('../src/i18n/index.ts');
  const storage = {
    getItem: () => null,
    setItem: () => {},
  } as unknown as Storage;
  setLanguage('en', storage);
  const projection = {
    byteLimit: 65536,
    shownItems: 300,
    omittedItems: 2500,
    shortenedFields: 4,
  };
  const english = renderToStaticMarkup(
    createElement(HubProjectionNotice, { projection }),
  );
  assert.match(english, /300 shown, 2500 omitted/);
  assert.match(english, /65536 byte budget/);
  assert.match(english, /4 text fields shortened/);
  assert.match(english, /full task details and results remain on hub/);
  assert.match(english, /counts apply to the records returned by this refresh/);
  assert.equal(
    renderToStaticMarkup(createElement(HubProjectionNotice, {})),
    '',
  );
  setLanguage('zh-CN', storage);
  const chinese = renderToStaticMarkup(
    createElement(HubProjectionNotice, { projection }),
  );
  assert.match(chinese, /显示 300 项，省略 2500 项/);
  assert.match(chinese, /65536 字节预算/);
  setLanguage('en', storage);
});

// A bridge stub that records the commands the window sends and answers them
// with the fixture snapshot, as the runtime worker would.
function bridge(update: RuntimeUpdate) {
  const commands: RuntimeCommand[] = [];
  let listener: ((update: RuntimeUpdate) => void) | undefined;
  const host = {
    update(snapshot: RuntimeUpdate['snapshot']) {
      update = { seq: update.seq + 1, connected: true, snapshot };
      listener?.(update);
    },
    commands,
    async runtimeCommand(command: RuntimeCommand) {
      commands.push(command);
      return { id: command.id, ok: true };
    },
    async runtimeState() {
      return update;
    },
    onRuntime: (callback: (update: RuntimeUpdate) => void) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
  } as unknown as DesktopBridge & {
    commands: RuntimeCommand[];
    update(snapshot: RuntimeUpdate['snapshot']): void;
  };
  return host;
}
function live() {
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  const update: RuntimeUpdate = { seq: 0, connected: true, snapshot };
  const host = bridge(update);
  return { runtime: new LiveRuntime(host, update), host };
}

for (const reusedFixtureId of [false, true])
  test(`reset invalidates a departing scroll view when its session ID is ${reusedFixtureId ? 'reused' : 'removed'}`, () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const runtime = new PreviewRuntime(storage);
    const sessionId = reusedFixtureId
      ? runtime.getSnapshot().activeSessionId
      : runtime.newSession();
    const epoch = runtime.presentationEpoch;
    saveSessionScroll(runtime, sessionId, epoch, { top: 123, follow: false });
    assert.notEqual(storage.getItem(STORAGE_KEY), null);
    runtime.reset();
    const resetSnapshot = runtime.getSnapshot();
    assert.equal(storage.getItem(STORAGE_KEY), null);
    // This is the actual Conversation layout-effect cleanup after reset.
    saveSessionScroll(runtime, sessionId, epoch, { top: 456, follow: false });
    assert.equal(runtime.getSnapshot(), resetSnapshot);
    assert.equal(storage.getItem(STORAGE_KEY), null);
    assert(
      runtime
        .getSnapshot()
        .sessions.every((session) => !session.presentation?.scroll),
    );
    const current = runtime.getSnapshot().activeSessionId;
    saveSessionScroll(runtime, current, runtime.presentationEpoch, {
      top: 42,
      follow: false,
    });
    assert.deepEqual(
      JSON.parse(storage.getItem(STORAGE_KEY)!).sessions.find(
        (session: { id: string }) => session.id === current,
      ).presentation.scroll,
      { top: 42, follow: false },
    );
  });

test('settings changes never carry the default workspace folders', async () => {
  const { runtime, host } = live();
  runtime.change((state) => {
    state.settings.theme = 'dark';
    // A draft that touches the controller-owned keys must not smuggle them
    // into the batched save-settings command.
    state.settings.workspaceFolder = '/tmp/forged';
    state.settings.oldWorkspaceFolder = '/tmp/also-forged';
  });
  // request() flushes the queued change first, then sends its own command.
  await runtime.request('set-default-workspace', { workspaceGrant: 'grant-1' });
  assert.deepEqual(
    host.commands.map((command) => command.name),
    ['save-settings', 'set-default-workspace'],
  );
  const settings = host.commands[0]!.payload.settings as Record<
    string,
    unknown
  >;
  assert.equal(settings.theme, 'dark');
  assert.equal('workspaceFolder' in settings, false);
  assert.equal('oldWorkspaceFolder' in settings, false);
  // The folder itself travels only as the native dialog's grant id.
  assert.deepEqual(host.commands[1]!.payload, { workspaceGrant: 'grant-1' });
});

test('session presentation survives background snapshots and switching without replacing core history', async () => {
  const { runtime, host } = live();
  const a = runtime.getSnapshot().activeSessionId;
  const b = runtime.getSnapshot().sessions.find((item) => item.id !== a)!.id;
  runtime.change((state) => {
    const target = state.sessions.find((item) => item.id === a)!;
    target.draft = 'draft for A';
    target.attachments = [
      { id: 'a-file', kind: 'file', name: 'A.txt', content: 'A bytes' },
    ];
    target.presentation = {
      scroll: { top: 123, follow: false },
      disclosures: { 'thinking:a': { open: true, defaultOpen: false } },
      toolTabs: { 'a-tool': 'input' },
    };
  });
  const next = createFixtures();
  next.runtime = { connected: true, configured: true };
  next.activeSessionId = b;
  host.update(next);
  runtime.change((state) => {
    state.sessions.find((item) => item.id === b)!.draft = 'draft for B';
  });
  const returning = createFixtures();
  returning.runtime = next.runtime;
  returning.activeSessionId = a;
  returning.sessions
    .find((item) => item.id === a)!
    .messages.push({
      id: 'background',
      parentId: null,
      role: 'assistant',
      text: 'new saved answer',
      at: 'now',
    });
  host.update(returning);
  const restored = runtime
    .getSnapshot()
    .sessions.find((item) => item.id === a)!;
  assert.equal(restored.draft, 'draft for A');
  assert.equal(restored.attachments[0]!.content, 'A bytes');
  assert.deepEqual(restored.presentation?.scroll, { top: 123, follow: false });
  assert.equal(restored.presentation?.disclosures?.['thinking:a']?.open, true);
  assert.equal(restored.presentation?.toolTabs?.['a-tool'], 'input');
  assert.equal(restored.messages.at(-1)!.text, 'new saved answer');
  assert.equal(
    runtime.getSnapshot().sessions.find((item) => item.id === b)!.draft,
    'draft for B',
  );
  assert.deepEqual(host.commands, []);
});

test('a pasted picture is stored once, not again with each keystroke, and comes back with the draft', () => {
  const values = new Map<string, string>();
  const writes: { key: string; characters: number }[] = [];
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push({ key, characters: value.length });
      values.set(key, value);
    },
  };
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  const update: RuntimeUpdate = { seq: 0, connected: true, snapshot };
  const runtime = new LiveRuntime(bridge(update), update, storage);
  const id = runtime.getSnapshot().activeSessionId;
  // What the composer keeps for a pasted screenshot: several megabytes of base64
  const picture = 'iVBO' + 'A'.repeat(4_000_000);
  runtime.updateSessionView(id, {
    attachments: [
      {
        id: 'shot',
        kind: 'image',
        name: 'screen.png',
        content: picture,
        mime: 'image/png',
        size: 3_000_000,
      },
    ],
  });
  assert.equal(
    writes.filter((write) => write.characters > picture.length).length,
    1,
  );
  writes.length = 0;
  for (const draft of ['a', 'an', 'and', 'and this screenshot'])
    runtime.updateSessionView(id, { draft });
  assert.equal(writes.length, 4);
  assert.ok(writes.every((write) => write.characters < 100_000));
  // A restart finds the draft and its picture
  const restarted = new LiveRuntime(bridge(update), update, storage);
  const session = restarted
    .getSnapshot()
    .sessions.find((item) => item.id === id)!;
  assert.equal(session.draft, 'and this screenshot');
  assert.equal(session.attachments[0]!.content, picture);
  // A removed picture leaves storage
  restarted.updateSessionView(id, { attachments: [] });
  assert.ok(![...values.values()].some((value) => value.includes(picture)));
});

test('draft attachments saved with the view by an earlier version are kept', () => {
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  const update: RuntimeUpdate = { seq: 0, connected: true, snapshot };
  const id = snapshot.activeSessionId;
  const values = new Map([
    [
      'circle.workbench.live.views.v1',
      JSON.stringify({
        views: [
          [
            id,
            {
              draft: 'kept',
              attachments: [
                { id: 'a', kind: 'file', name: 'A.txt', content: 'A bytes' },
              ],
            },
          ],
        ],
      }),
    ],
  ]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  const runtime = new LiveRuntime(bridge(update), update, storage);
  const session = () =>
    runtime.getSnapshot().sessions.find((item) => item.id === id)!;
  assert.equal(session().attachments[0]!.content, 'A bytes');
  runtime.updateSessionView(id, { draft: 'kept, then typed' });
  // Saved again in the current form, the attachment is still there after a restart
  const restarted = new LiveRuntime(bridge(update), update, storage);
  const again = restarted
    .getSnapshot()
    .sessions.find((item) => item.id === id)!;
  assert.equal(again.draft, 'kept, then typed');
  assert.equal(again.attachments[0]!.content, 'A bytes');
  assert.ok(!values.get('circle.workbench.live.views.v1')!.includes('A bytes'));
});

test('a tab switch while send and stop wait for queued changes keeps the originating session identity', async () => {
  const { runtime, host } = live();
  const a = runtime.getSnapshot().activeSessionId;
  const b = runtime.getSnapshot().sessions.find((item) => item.id !== a)!.id;
  runtime.change((state) => {
    state.sessions.find((item) => item.id === a)!.draft = 'prompt A';
  });
  const sending = runtime.send();
  const stopping = runtime.request('abort');
  const changed = structuredClone(runtime.getSnapshot());
  changed.activeSessionId = b;
  changed.sessions.find((item) => item.id === b)!.draft = 'keep B draft';
  host.update(changed);
  await Promise.all([sending, stopping]);
  assert.deepEqual(
    host.commands.map((command) => [command.name, command.sessionId]),
    [
      ['prompt', a],
      ['abort', a],
    ],
  );
  assert.equal(host.commands[0]!.payload.text, 'prompt A');
  assert.equal(
    runtime.getSnapshot().sessions.find((item) => item.id === b)!.draft,
    'keep B draft',
  );
});

test('delete sends explicit confirmation and addresses the selected row', async () => {
  const { runtime, host } = live();
  await runtime.deleteSession('background-session', true);
  assert.equal(host.commands[0]!.name, 'delete-session');
  assert.deepEqual(host.commands[0]!.payload, {
    id: 'background-session',
    confirmed: true,
  });
});

test('a skill loaded while switching tabs is attached only to its originating conversation', async () => {
  const { runtime, host } = live();
  const a = runtime.getSnapshot().activeSessionId;
  const b = runtime.getSnapshot().sessions.find((item) => item.id !== a)!.id;
  let finish!: () => void;
  host.runtimeCommand = async (command) => {
    host.commands.push(command);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      id: command.id,
      ok: true,
      data: { name: 'fixture-skill', content: 'synthetic instructions' },
    };
  };
  const loading = runtime.command('skill', 'fixture-skill');
  await Promise.resolve();
  const changed = structuredClone(runtime.getSnapshot());
  changed.activeSessionId = b;
  host.update(changed);
  finish();
  await loading;
  assert.equal(host.commands[0]!.sessionId, a);
  assert.equal(
    runtime
      .getSnapshot()
      .sessions.find((item) => item.id === a)!
      .attachments.at(-1)!.name,
    'fixture-skill',
  );
  assert.equal(
    runtime
      .getSnapshot()
      .sessions.find((item) => item.id === b)!
      .attachments.some((item) => item.name === 'fixture-skill'),
    false,
  );
});

test('a delayed command rejection stays with its originating session after a tab switch', async () => {
  const { runtime, host } = live();
  const a = runtime.getSnapshot().activeSessionId;
  const b = runtime.getSnapshot().sessions.find((item) => item.id !== a)!.id;
  let finish!: () => void;
  host.runtimeCommand = async (command) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { id: command.id, ok: false, error: 'A-only synthetic failure' };
  };
  const running = runtime.request('abort');
  await Promise.resolve();
  const changed = structuredClone(runtime.getSnapshot());
  changed.activeSessionId = b;
  host.update(changed);
  finish();
  await assert.rejects(running, /A-only synthetic failure/);
  assert.equal(runtime.getSnapshot().runtime?.error, undefined);
  assert.equal(
    runtime.getSnapshot().sessions.find((item) => item.id === b)!.actionError,
    undefined,
  );
  assert.equal(
    runtime.getSnapshot().sessions.find((item) => item.id === a)!.actionError,
    'A-only synthetic failure',
  );
  host.update(structuredClone(runtime.getSnapshot()));
  assert.equal(
    runtime.getSnapshot().sessions.find((item) => item.id === a)!.actionError,
    'A-only synthetic failure',
  );
});

test('a failed background interaction reports its true owner through the request wrapper', async () => {
  const { runtime, host } = live();
  const a = runtime.getSnapshot().activeSessionId;
  const b = runtime.getSnapshot().sessions.find((item) => item.id !== a)!.id;
  const changed = structuredClone(runtime.getSnapshot());
  changed.interactions.push({
    id: 'background-question',
    sessionId: b,
    kind: 'question',
    title: 'B-only question',
    status: 'pending',
    revision: 1,
  });
  host.update(changed);
  host.runtimeCommand = async (command) => ({
    id: command.id,
    ok: false,
    error: 'B interaction already closed',
  });
  await assert.rejects(
    runtime.request('cancel-interaction', {
      id: 'background-question',
      revision: 1,
    }),
    (error: unknown) =>
      error instanceof Error && 'sessionId' in error && error.sessionId === b,
  );
  assert.equal(
    runtime.getSnapshot().sessions.find((item) => item.id === a)!.actionError,
    undefined,
  );
  assert.equal(
    runtime.getSnapshot().sessions.find((item) => item.id === b)!.actionError,
    'B interaction already closed',
  );
});

test('background job requests and delayed imports carry their actual target session', async () => {
  const { runtime, host } = live();
  const a = runtime.getSnapshot().activeSessionId;
  const b = runtime.getSnapshot().sessions.find((item) => item.id !== a)!.id;
  const changed = structuredClone(runtime.getSnapshot());
  changed.jobs.push({
    id: b + ':synthetic-job',
    sessionId: b,
    kind: 'command',
    title: 'B-only job',
    state: 'running',
    elapsed: '1s',
    output: '',
    outputPath: '',
    stopRequested: false,
  });
  host.update(changed);
  await runtime.request('stop-job', { id: b + ':synthetic-job' });
  assert.equal(host.commands[0]!.sessionId, b);
  const switched = structuredClone(runtime.getSnapshot());
  switched.activeSessionId = b;
  host.update(switched);
  await runtime.request(
    'import-native-session',
    { content: 'synthetic export selected from A' },
    a,
  );
  assert.equal(host.commands[1]!.name, 'import');
  assert.equal(host.commands[1]!.sessionId, a);
});

test('the first home message begins one session and does not call new-session', async () => {
  const { runtime, host } = live();
  host.runtimeCommand = async (command) => {
    host.commands.push(command);
    return {
      id: command.id,
      ok: true,
      data:
        command.name === 'begin-session'
          ? { sessionId: 'session-home' }
          : undefined,
    };
  };
  assert.deepEqual(
    await runtime.beginConversation({
      workspaceId: 'workspace1',
      text: 'fix the parser',
    }),
    { sessionId: 'session-home' },
  );
  assert.deepEqual(
    host.commands.map((command) => command.name),
    ['begin-session'],
  );
  assert.equal(host.commands[0]!.payload.workspaceId, 'workspace1');
  assert.equal(host.commands[0]!.payload.text, 'fix the parser');
  assert.equal(host.commands[0]!.payload.display, 'fix the parser');
  assert.deepEqual(
    await runtime.beginConversation({ text: 'without a project' }),
    { sessionId: 'session-home' },
  );
  assert.equal(host.commands[1]!.payload.workspaceId, undefined);
});

test('a home message sends the chosen model, effort and mode', async () => {
  const { runtime, host } = live();
  host.runtimeCommand = async (command) => {
    host.commands.push(command);
    return { id: command.id, ok: true, data: { sessionId: 'session-home' } };
  };
  assert.deepEqual(
    await runtime.beginConversation({
      workspaceId: 'workspace1',
      text: 'think harder',
      model: 'sample-fast-model',
      effort: 'xhigh',
      mode: 'plan',
    }),
    { sessionId: 'session-home' },
  );
  assert.equal(host.commands[0]!.name, 'begin-session');
  assert.equal(host.commands[0]!.payload.modelId, 'sample-fast-model');
  assert.equal(host.commands[0]!.payload.effort, 'xhigh');
  assert.equal(host.commands[0]!.payload.mode, 'plan');
});

test('a home message inlines text files and sends pictures as attachments', async () => {
  const { runtime, host } = live();
  host.runtimeCommand = async (command) => {
    host.commands.push(command);
    return { id: command.id, ok: true, data: { sessionId: 'session-home' } };
  };
  await runtime.beginConversation({
    workspaceId: 'workspace1',
    text: 'see this',
    attachments: [
      { id: 'note', name: 'note.txt', kind: 'file', content: 'hello' },
      {
        id: 'pic',
        name: 'pic.png',
        kind: 'image',
        content: 'data:image/png;base64,aaaa',
        mime: 'image/png',
      },
    ],
  });
  assert.equal(
    host.commands[0]!.payload.text,
    'see this\n\n<attachment name="note.txt">\nhello\n</attachment>',
  );
  assert.equal(host.commands[0]!.payload.display, 'see this');
  assert.deepEqual(host.commands[0]!.payload.attachments, [
    {
      id: 'pic',
      name: 'pic.png',
      kind: 'image',
      content: 'data:image/png;base64,aaaa',
      mime: 'image/png',
    },
  ]);
});

test('a stopped reply shows one interrupt mark under its stats, and the estimate is not a minus', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Tooltip } = await import('radix-ui');
  const { RuntimeProvider } = await import('../src/app/context.tsx');
  const { MessageView } = await import('../src/components/MessageView.tsx');
  const { PreviewRuntime } = await import('../src/model/state.ts');
  const { setLanguage } = await import('../src/i18n/index.ts');
  const storage = {
    getItem: () => null,
    setItem: () => {},
  } as unknown as Storage;
  setLanguage('zh-CN', storage);
  const assistant = {
    id: 'a',
    parentId: 'u',
    role: 'assistant' as const,
    text: 'partial answer',
    at: '2026-10-16T00:00:12.000Z',
    interrupted: true,
    usage: {
      input: 12476,
      output: 162,
      cost: 0.0181792,
      elapsed: '12s',
      estimated: true,
    },
  };
  const runtime = new PreviewRuntime();
  const view = (message: import('../src/model/types.ts').Message) =>
    createElement(Tooltip.Provider, {
      children: createElement(RuntimeProvider, {
        runtime,
        children: createElement(MessageView, {
          message,
          showThinking: false,
          onAttachment: () => {},
        }),
      }),
    });
  const html = renderToStaticMarkup(view(assistant));
  const summary = html.indexOf('data-testid="turn-summary"');
  const mark = html.indexOf('已中断');
  assert.ok(summary >= 0);
  assert.ok(mark > summary);
  assert.equal(html.split('已中断').length - 1, 1);
  assert.match(html, /\$0\.0182~/);
  assert.equal(html.includes('-$'), false);
  assert.equal(html.includes('~$'), false);
  assert.equal(html.includes('$-'), false);
  const negative = renderToStaticMarkup(
    view({
      ...assistant,
      usage: { ...assistant.usage, cost: -0.0182, estimated: false },
    }),
  );
  assert.match(negative, /\$0\.0000/);
  assert.equal(negative.includes('-$'), false);
  assert.equal(negative.includes('$-'), false);
  setLanguage('en', storage);
});

test('a page can drop a session error it is already showing', async () => {
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  const update: RuntimeUpdate = { seq: 0, connected: true, snapshot };
  const host = {
    async runtimeCommand() {
      return {
        id: '1',
        ok: false,
        error:
          '登录被拒绝（UNAUTHENTICATED）。请核对用户和密码，然后重新 /hub login。',
      };
    },
    async runtimeState() {
      return update;
    },
    onRuntime: () => () => {},
  } as unknown as DesktopBridge;
  const runtime = new LiveRuntime(host, update);
  const refused =
    '登录被拒绝（UNAUTHENTICATED）。请核对用户和密码，然后重新 /hub login。';
  await assert.rejects(
    runtime.request('extension-command', {
      name: 'hub',
      args: 'login http://127.0.0.1:7410 ada',
    }),
    { message: refused },
  );
  const session = () =>
    runtime
      .getSnapshot()
      .sessions.find((item) => item.id === snapshot.activeSessionId);
  assert.equal(session()?.actionError, refused);
  runtime.dismissActionError();
  assert.equal(session()?.actionError, undefined);
});

test('an untrusted project is not given a session from home', async () => {
  const { runtime, host } = live();
  assert.deepEqual(
    await runtime.beginConversation({
      workspaceId: 'workspace2',
      text: 'edit the docs',
    }),
    { dialog: 'trust' },
  );
  assert.deepEqual(host.commands, []);
});
