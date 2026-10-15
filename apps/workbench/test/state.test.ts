import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PreviewRuntime,
  currentSession,
  branchMessages,
  sessionListed,
  visibleMessages,
} from '../src/model/state.ts';
import { parsePreviewBundle } from '../src/model/transfer.ts';
import { shownTime } from '../src/model/time.ts';
import {
  KEY_ACTIONS,
  effectiveBindings,
  validateKeybindings,
  matchingAction,
} from '../src/model/shortcuts.ts';
import { PlatformPreviewService } from '../src/plugins/platform/store.ts';
import { PluginRegistry } from '../src/plugins/registry.ts';
import type { WorkbenchPlugin } from '../src/plugins/types.ts';
import {
  canArchiveSession,
  workspaceSessions,
} from '../src/model/session-management.ts';
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}
function draft(runtime: PreviewRuntime, text: string) {
  runtime.change((state) => {
    currentSession(state).draft = text;
  });
}
test('session lists separate archived records, preserve their history, and reject running work or pending decisions', () => {
  const runtime = new PreviewRuntime();
  const state = runtime.getSnapshot();
  const session = currentSession(state);
  const history = structuredClone(session.messages);
  state.interactions = [];
  state.jobs = [];
  session.state = 'idle';
  assert.equal(canArchiveSession(state, session), true);
  session.archivedAt = '2026-10-14T00:00:00.000Z';
  assert.equal(
    workspaceSessions(state, session.workspaceId).some(
      (row) => row.id === session.id,
    ),
    false,
  );
  assert.equal(
    workspaceSessions(state, session.workspaceId, true).some(
      (row) => row.id === session.id,
    ),
    true,
  );
  assert.deepEqual(session.messages, history);
  session.state = 'waiting';
  assert.equal(canArchiveSession(state, session), false);
  session.state = 'idle';
  state.interactions = [
    {
      id: 'pending',
      sessionId: session.id,
      kind: 'approval',
      title: 'write approval',
      status: 'pending',
      revision: 1,
    },
  ];
  assert.equal(canArchiveSession(state, session), false);
});
test('free input is preserved without an invented reply or task', () => {
  const runtime = new PreviewRuntime();
  const before = runtime.getSnapshot().sessions[0]!.messages.length;
  draft(runtime, 'Check this design before changing anything.');
  runtime.send();
  assert.equal(
    currentSession(runtime.getSnapshot()).messages.length,
    before + 1,
  );
  assert.equal(
    currentSession(runtime.getSnapshot()).messages.at(-1)?.role,
    'user',
  );
  assert.equal(currentSession(runtime.getSnapshot()).state, 'waiting');
});
test('unknown commands stay in the draft; paths and leading spaces remain messages', () => {
  const runtime = new PreviewRuntime();
  draft(runtime, '/modles');
  assert.match(runtime.send().notice ?? '', /did you mean/);
  assert.equal(currentSession(runtime.getSnapshot()).draft, '/modles');
  for (const text of ['/usr/bin/env is missing', ' /help']) {
    const fresh = new PreviewRuntime();
    draft(fresh, text);
    fresh.send();
    assert.equal(
      currentSession(fresh.getSnapshot()).messages.at(-1)?.text,
      text,
    );
  }
});
test('steering and follow-ups remain separate pending inputs', () => {
  const runtime = new PreviewRuntime();
  draft(runtime, 'first');
  runtime.send();
  draft(runtime, 'steer');
  runtime.send();
  draft(runtime, 'after the turn');
  runtime.send('follow-up');
  const queue = currentSession(runtime.getSnapshot()).queue;
  assert.deepEqual(
    queue.map((item) => [item.kind, item.text]),
    [
      ['steering', 'steer'],
      ['follow-up', 'after the turn'],
    ],
  );
});
test('undo only affects visible rows; tree selection preserves raw history and files', () => {
  const runtime = new PreviewRuntime();
  const before = structuredClone(runtime.getSnapshot());
  runtime.command('undo');
  assert.equal(
    visibleMessages(currentSession(runtime.getSnapshot())).length,
    0,
  );
  assert.deepEqual(
    currentSession(runtime.getSnapshot()).messages,
    before.sessions[0]!.messages,
  );
  assert.deepEqual(runtime.getSnapshot().files, before.files);
  runtime.command('redo');
  assert.equal(
    visibleMessages(currentSession(runtime.getSnapshot())).length,
    5,
  );
  runtime.branch('m2', 'tree');
  assert.deepEqual(
    branchMessages(currentSession(runtime.getSnapshot())).map(
      (item) => item.id,
    ),
    ['m1', 'm2'],
  );
  assert.deepEqual(
    currentSession(runtime.getSnapshot()).messages,
    before.sessions[0]!.messages,
  );
});
test('fork and clone create separate sessions and reset auto mode', () => {
  const runtime = new PreviewRuntime();
  runtime.command('yolo');
  runtime.branch('m6', 'fork');
  const fork = currentSession(runtime.getSnapshot());
  assert.equal(fork.auto, false);
  assert.equal(fork.draft, 'First show me which tests cover reconnect.');
  assert.deepEqual(
    fork.messages.map((item) => item.id),
    ['m1', 'm2'],
  );
  runtime.command('clone');
  const clone = currentSession(runtime.getSnapshot());
  assert.notEqual(clone.id, fork.id);
  assert.deepEqual(clone.messages, fork.messages);
  assert.equal(clone.auto, false);
});
test('switching the current session does not erase the previous-session pointer', () => {
  const runtime = new PreviewRuntime();
  runtime.selectSession('session2');
  runtime.selectSession('session2');
  runtime.command('continue');
  assert.equal(runtime.getSnapshot().activeSessionId, 'session1');
  assert.throws(() => runtime.deleteSession('session1'), /open session/);
  runtime.deleteSession('session3');
  assert.equal(runtime.getSnapshot().sessions.length, 2);
});
test('auto and presentation undo do not survive a restart', () => {
  const memory = storage();
  const runtime = new PreviewRuntime(memory);
  runtime.command('yolo');
  runtime.command('undo');
  const reopened = new PreviewRuntime(memory);
  assert.equal(currentSession(reopened.getSnapshot()).auto, false);
  assert.deepEqual(currentSession(reopened.getSnapshot()).hiddenIds, []);
});
test('busy-sensitive commands cannot mutate the running preview', () => {
  const runtime = new PreviewRuntime();
  draft(runtime, 'start');
  runtime.send();
  const before = structuredClone(runtime.getSnapshot());
  for (const [name, args] of [
    ['new', ''],
    ['models', 'another'],
    ['skill', 'code-review'],
    ['mcp', 'reload'],
  ])
    assert.match(runtime.command(name!, args).notice ?? '', /wait/);
  assert.equal(runtime.getSnapshot().sessions.length, before.sessions.length);
  assert.equal(
    currentSession(runtime.getSnapshot()).model,
    before.sessions[0]!.model,
  );
});
test('secret values are discarded before local storage and request history', () => {
  const memory = storage();
  const runtime = new PreviewRuntime(memory);
  const secret = 'synthetic-secret-do-not-store';
  runtime.answer('secret1', 1, secret);
  assert.equal([...memory.values.values()].join('').includes(secret), false);
  assert.equal(JSON.stringify(runtime.getSnapshot()).includes(secret), false);
  assert.throws(
    () => runtime.answer('secret1', 1, 'again'),
    /already answered/,
  );
});
test('a stop request does not fabricate a stopped process', () => {
  const runtime = new PreviewRuntime();
  runtime.request('stop-job', { id: 'j1' });
  const job = runtime.getSnapshot().jobs.find((item) => item.id === 'j1')!;
  assert.equal(job.stopRequested, true);
  assert.equal(job.state, 'running');
  draft(runtime, '!echo test');
  runtime.send();
  assert.equal(runtime.getSnapshot().requests[0]!.kind, 'execute');
  assert.equal(runtime.getSnapshot().files[0]!.status, 'modified');
});
test('preview imports retain branches but reject cyclic and duplicate identities', () => {
  const runtime = new PreviewRuntime();
  const base = currentSession(runtime.getSnapshot());
  const text = JSON.stringify({
    schema: 'circle-workbench-preview/v1',
    session: base,
  });
  const imported = parsePreviewBundle(text, base);
  assert.deepEqual(imported.messages, base.messages);
  assert.equal(imported.auto, false);
  const broken = structuredClone(base);
  broken.messages[0]!.parentId = 'm5';
  assert.throws(
    () =>
      parsePreviewBundle(
        JSON.stringify({
          schema: 'circle-workbench-preview/v1',
          session: broken,
        }),
        base,
      ),
    /cyclic/,
  );
  broken.messages = base.messages.concat(base.messages[0]!);
  assert.throws(
    () =>
      parsePreviewBundle(
        JSON.stringify({
          schema: 'circle-workbench-preview/v1',
          session: broken,
        }),
        base,
      ),
    /duplicate/,
  );
});
test('custom key preferences validate actions and resolve aliases', () => {
  assert.throws(() => validateKeybindings({ unknown: 'ctrl+k' }), /unknown/);
  assert.throws(() => validateKeybindings({ find: 123 }), /keys/);
  const bindings = validateKeybindings({ 'model.select': ['ctrl+k', 'f3'] });
  assert.equal(
    matchingAction(
      {
        key: 'k',
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        metaKey: false,
      },
      bindings,
    ),
    'model.select',
  );
  assert.equal(
    matchingAction(
      {
        key: 'b',
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: true,
      },
      {},
    ),
    undefined,
  );
  assert.equal(KEY_ACTIONS['sidebar.toggle'], 'ctrl+b');
  assert.equal(KEY_ACTIONS['secret.enter'], 'ctrl+alt+s');
  assert.equal(KEY_ACTIONS['message.copy'], 'alt+c');
  assert.equal(KEY_ACTIONS['model.select'], 'ctrl+shift+m');
  assert.equal(KEY_ACTIONS['model.cycle'], 'alt+m');
  assert.equal(KEY_ACTIONS['job.background'], 'alt+b');
  assert.equal(
    matchingAction(
      {
        key: 'b',
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: true,
      },
      effectiveBindings(),
    ),
    'sidebar.toggle',
  );
  assert.equal(
    matchingAction(
      {
        key: 's',
        ctrlKey: true,
        altKey: true,
        shiftKey: false,
        metaKey: false,
      },
      effectiveBindings({ 'secret.enter': 'ctrl+k' }),
    ),
    undefined,
  );
});
test('platform work and execution retain independent states after Circle interaction', () => {
  const runtime = new PreviewRuntime();
  const platform = new PlatformPreviewService();
  const resources = structuredClone(platform.getSnapshot().resources);
  runtime.command('plan');
  runtime.request('abort');
  platform.requestWork('work1', 'pause');
  assert.equal(platform.getSnapshot().work[0]!.status, 'running');
  assert.deepEqual(platform.getSnapshot().resources, resources);
  assert.equal(currentSession(runtime.getSnapshot()).readOnly, true);
});
test('methods load per session without publishing candidates', () => {
  const service = new PlatformPreviewService();
  service.bindMethod('session1', 'method1', true);
  assert.equal(service.getSnapshot().bindings.session1?.[0]?.version, '0.8.0');
  assert.equal(service.getSnapshot().bindings.session2, undefined);
  assert.throws(
    () => service.bindMethod('session1', 'method3', true),
    /published/,
  );
  service.setRole('expert');
  service.requestReview('method3');
  assert.equal(service.getSnapshot().methods[2]!.status, 'candidate');
  assert.equal(service.getSnapshot().methods[2]!.reviewRequested, true);
});
test('platform roles constrain local mutations and do not grant access by enabling a plugin', () => {
  const service = new PlatformPreviewService();
  service.setRole('viewer');
  assert.equal(service.can('read'), true);
  assert.throws(() => service.requestWork('work1', 'cancel'), /role/);
  service.setRole('maintainer');
  assert.equal(service.can('read'), false);
  assert.throws(() => service.bindMethod('session1', 'method1', true), /role/);
});
const icon = (() => null) as unknown as WorkbenchPlugin['icon'];
const component = () => null;
const plugin = (
  id: string,
  extra: Partial<WorkbenchPlugin> = {},
): WorkbenchPlugin => ({
  id,
  title: id,
  description: id,
  version: '0.1.0',
  apiVersion: 1,
  icon,
  pages: [{ id, title: id, icon, component }],
  ...extra,
});
test('plugin registration rejects collisions, reserved pages and invalid dependencies', () => {
  assert.throws(
    () => new PluginRegistry([plugin('same'), plugin('same')]),
    /duplicate/,
  );
  assert.throws(() => new PluginRegistry([plugin('settings')]), /reserved/);
  assert.throws(
    () =>
      new PluginRegistry([
        plugin('a', { requires: ['b'] }),
        plugin('b', { requires: ['a'] }),
      ]),
    /cycle/,
  );
  assert.throws(
    () => new PluginRegistry([plugin('a', { requires: ['missing'] })]),
    /missing/,
  );
});
test('plugin dependencies are composed without changing service data', () => {
  const registry = new PluginRegistry([
    plugin('base'),
    plugin('extra', { requires: ['base'] }),
  ]);
  assert.deepEqual(registry.change([], 'extra', true), ['base', 'extra']);
  assert.throws(
    () => registry.change(['base', 'extra'], 'base', false),
    /disable/,
  );
  assert.deepEqual(registry.pages([]), []);
  assert.equal(registry.pages(['base', 'extra']).length, 2);
});
test('resume without an argument opens the session picker; explicit selection opens a conversation', () => {
  const runtime = new PreviewRuntime();
  assert.equal(runtime.command('resume').page, 'sessions');
  assert.equal(runtime.command('resume', 'session2').openSession, true);
  assert.equal(runtime.getSnapshot().activeSessionId, 'session2');
  assert.equal(runtime.command('new').openSession, true);
  assert.equal(runtime.command('new').focusComposer, true);
  assert.equal(runtime.command('redo').notice, 'nothing to redo');
});

test('core times show as local clock times, with the day when it is not today', () => {
  const now = new Date(2026, 9, 11, 18, 30);
  const iso = (...parts: [number, number, number, number, number]) =>
    new Date(...parts).toISOString();
  assert.equal(shownTime(iso(2026, 9, 11, 9, 5), now), '09:05');
  assert.equal(shownTime(iso(2026, 9, 10, 14, 5), now), '10 Oct 14:05');
  assert.equal(shownTime(iso(2025, 11, 31, 23, 59), now), '31 Dec 2025 23:59');
  // The preview's own words stay as they are
  assert.equal(shownTime('10:24', now), '10:24');
  assert.equal(shownTime('yesterday', now), 'yesterday');
  assert.equal(shownTime('streaming', now), 'streaming');
});

test('an empty new session is not listed, and hi keeps that title', () => {
  const runtime = new PreviewRuntime();
  const before = runtime.getSnapshot().sessions.length;
  const created = runtime.newSession();
  assert.equal(runtime.getSnapshot().sessions.length, before + 1);
  assert.equal(sessionListed(currentSession(runtime.getSnapshot())), false);
  assert.equal(runtime.newSession(), created);
  assert.equal(runtime.getSnapshot().sessions.length, before + 1);
  runtime.change((state) => {
    currentSession(state).draft = 'leftover';
  });
  assert.equal(runtime.newSession(), created);
  assert.equal(currentSession(runtime.getSnapshot()).draft, '');
  runtime.change((state) => {
    currentSession(state).draft = 'hi';
  });
  runtime.send();
  assert.equal(currentSession(runtime.getSnapshot()).title, 'hi');
  assert.equal(sessionListed(currentSession(runtime.getSnapshot())), true);
  const again = runtime.newSession();
  assert.notEqual(again, created);
  runtime.selectSession(created);
  assert.equal(
    runtime.getSnapshot().sessions.some((session) => session.id === again),
    false,
  );
});
