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
      planCollapsed: true,
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
  assert.equal(restored.presentation?.planCollapsed, true);
  assert.equal(restored.presentation?.toolTabs?.['a-tool'], 'input');
  assert.equal(restored.messages.at(-1)!.text, 'new saved answer');
  assert.equal(
    runtime.getSnapshot().sessions.find((item) => item.id === b)!.draft,
    'draft for B',
  );
  assert.deepEqual(host.commands, []);
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
