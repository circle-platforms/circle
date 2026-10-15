import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PreviewRuntime,
  currentSession,
  branchMessages,
  visibleMessages,
} from '../src/model/state.ts';
import { parsePreviewBundle } from '../src/model/transfer.ts';
import { shownTime } from '../src/model/time.ts';
import { validateKeybindings, matchingAction } from '../src/model/shortcuts.ts';
import { PlatformPreviewService } from '../src/plugins/platform/store.ts';
import { PluginRegistry } from '../src/plugins/registry.ts';
import type { WorkbenchPlugin } from '../src/plugins/types.ts';
import {
  activityAge,
  canArchiveSession,
  historyMessages,
  orderedProjects,
  projectTag,
  RECENT_SHOWN,
  recentDetails,
  recentSessions,
  sessionActivityAt,
  sessionHasContent,
  sidebarProjects,
  visibleSessions,
  workspaceListed,
  workspaceSessions,
} from '../src/model/session-management.ts';
import {
  forgetHomeComposer,
  homeComposerMemory,
  homePath,
  homeProjectRequest,
  homeProjects,
  rememberHomeComposer,
  selectedHomeProject,
} from '../src/features/home-selection.ts';
import type { Workspace } from '../src/model/types.ts';
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

test('the first message from home creates one session in the chosen project', () => {
  const runtime = new PreviewRuntime();
  const before = runtime.getSnapshot().sessions.map((session) => session.id);
  assert.deepEqual(
    runtime.beginConversation({
      workspaceId: 'workspace2',
      text: 'edit the docs',
    }),
    { dialog: 'trust' },
  );
  assert.deepEqual(
    runtime.getSnapshot().sessions.map((session) => session.id),
    before,
  );
  runtime.change((state) => {
    state.workspaces.find((item) => item.id === 'workspace2')!.trusted = true;
  });
  const started = runtime.beginConversation({
    workspaceId: 'workspace2',
    text: 'edit the docs',
  });
  assert.ok('sessionId' in started);
  const created = runtime
    .getSnapshot()
    .sessions.filter((session) => !before.includes(session.id));
  assert.equal(created.length, 1);
  assert.equal(created[0]!.id, started.sessionId);
  assert.equal(created[0]!.workspaceId, 'workspace2');
  assert.deepEqual(
    created[0]!.messages.map((message) => message.text),
    ['edit the docs'],
  );
  assert.equal(sessionHasContent(created[0]!), true);
  assert.equal(
    sessionHasContent({
      ...created[0]!,
      title: 'new session',
      messages: [],
      queue: [],
      state: 'idle',
    }),
    false,
  );
});

function folder(
  id: string,
  name: string,
  kind: Workspace['kind'] = 'project',
): Workspace {
  return {
    id,
    name,
    path: '/folders/' + name,
    branch: '',
    trusted: true,
    kind,
    instructions: [],
  };
}

test('the first message keeps the home composer model, effort and mode', () => {
  const runtime = new PreviewRuntime();
  assert.throws(
    () =>
      runtime.beginConversation({
        workspaceId: 'workspace1',
        text: 'bad depth',
        effort: 'ludicrous' as 'high',
      }),
    /unknown thinking depth/,
  );
  const started = runtime.beginConversation({
    workspaceId: 'workspace1',
    text: 'think harder',
    model: 'sample-fast-model',
    effort: 'xhigh',
    mode: 'plan',
  });
  assert.ok('sessionId' in started);
  const created = runtime
    .getSnapshot()
    .sessions.find((session) => session.id === started.sessionId)!;
  assert.equal(created.model, 'sample-fast-model');
  assert.equal(created.effort, 'xhigh');
  assert.equal(created.mode, 'plan');
  assert.equal(created.readOnly, true);
  assert.equal(created.auto, false);
  assert.equal(created.messages[0]!.text, 'think harder');
});

test('the home picker lists known projects and the sidebar choice wins', () => {
  const circle = folder('circle', 'circle');
  const docs = folder('docs', 'docs-site');
  const loose = folder('loose', 'unscoped', 'scratch');
  const workspaces = [docs, loose, circle];
  assert.deepEqual(
    homeProjects(workspaces).map((item) => item.name),
    ['circle', 'docs-site'],
  );
  const sessions = [{ id: 'current', workspaceId: 'circle' }];
  assert.equal(
    selectedHomeProject(workspaces, sessions, 'current', null)?.id,
    'circle',
  );
  assert.equal(
    selectedHomeProject(workspaces, sessions, 'current', 'circle')?.id,
    'circle',
  );
  assert.equal(
    selectedHomeProject(workspaces, sessions, 'current', 'docs')?.id,
    'docs',
  );
  assert.equal(
    selectedHomeProject(workspaces, sessions, 'current', ''),
    undefined,
  );
  assert.equal(
    selectedHomeProject(workspaces, sessions, 'current', 'loose'),
    undefined,
  );
  assert.equal(homePath(), '/home');
  assert.equal(homePath('circle'), '/home?workspace=circle');
  assert.equal(homePath(null), '/home?workspace=');
});

test('a home draft is kept until the message is sent, and the route wins over it', () => {
  forgetHomeComposer();
  assert.equal(homeComposerMemory(), null);
  assert.equal(homeProjectRequest(null, null), null);
  assert.equal(homeProjectRequest('docs', null), 'docs');
  assert.equal(homeProjectRequest('', null), '');
  rememberHomeComposer({
    text: 'hold this',
    attachments: [],
    model: 'sample-fast-model',
    effort: 'xhigh',
    mode: 'plan',
    projectId: 'docs',
  });
  assert.equal(homeComposerMemory()?.text, 'hold this');
  assert.equal(homeComposerMemory()?.effort, 'xhigh');
  assert.equal(homeProjectRequest(null, homeComposerMemory()), 'docs');
  assert.equal(homeProjectRequest(null, { projectId: null }), '');
  assert.equal(homeProjectRequest('circle', homeComposerMemory()), 'circle');
  forgetHomeComposer();
  assert.equal(homeComposerMemory(), null);
});

test('the picker choice decides where the first message is stored', () => {
  const runtime = new PreviewRuntime();
  runtime.change((state) => {
    state.workspaces.push(folder('circle', 'circle'));
  });
  const inCircle = runtime.beginConversation({
    workspaceId: 'circle',
    text: 'build in circle',
  });
  assert.ok('sessionId' in inCircle);
  const circleSession = runtime
    .getSnapshot()
    .sessions.find((session) => session.id === inCircle.sessionId)!;
  assert.equal(circleSession.workspaceId, 'circle');
  const loose = runtime.beginConversation({
    workspaceId: null,
    text: 'a loose question',
  });
  assert.ok('sessionId' in loose);
  const looseSession = runtime
    .getSnapshot()
    .sessions.find((session) => session.id === loose.sessionId)!;
  const looseWorkspace = runtime
    .getSnapshot()
    .workspaces.find((item) => item.id === looseSession.workspaceId)!;
  assert.notEqual(looseSession.workspaceId, 'circle');
  assert.equal(looseWorkspace.kind, 'scratch');
  assert.equal(looseSession.messages[0]!.text, 'a loose question');
});

test('the first home message keeps files chosen beside the box', () => {
  const runtime = new PreviewRuntime();
  const started = runtime.beginConversation({
    text: 'see this',
    attachments: [
      {
        id: 'note',
        name: 'note.txt',
        kind: 'file',
        content: 'hello',
      },
    ],
  });
  assert.ok('sessionId' in started);
  const message = runtime
    .getSnapshot()
    .sessions.find((session) => session.id === started.sessionId)!.messages[0]!;
  assert.equal(message.text, 'see this');
  assert.equal(message.attachments?.[0]?.name, 'note.txt');
  assert.equal(message.attachments?.[0]?.content, 'hello');
});

test('search and session counts omit a placeholder session', () => {
  const runtime = new PreviewRuntime();
  const real = runtime.getSnapshot().sessions[0]!;
  const placeholder = {
    ...real,
    id: 'placeholder',
    title: 'new session',
    messages: [],
    queue: [],
    state: 'idle' as const,
  };
  const sessions = [placeholder, real];
  const shown = visibleSessions(sessions);
  assert.deepEqual(
    shown.map((session) => session.id),
    [real.id],
  );
  const indexed = shown.flatMap((session) => historyMessages(session));
  assert.ok(indexed.length > 0);
  assert.equal(
    indexed.some((message) => message.text.includes('placeholder')),
    false,
  );
  assert.equal(historyMessages(placeholder).length, 0);
  assert.equal(sessionHasContent(placeholder), false);
});

test('search history includes assistant replies and skips tool rows', () => {
  const runtime = new PreviewRuntime();
  const session = runtime.getSnapshot().sessions[0]!;
  const hits = historyMessages(session);
  assert.ok(hits.some((message) => message.role === 'user'));
  assert.ok(
    hits.some(
      (message) =>
        message.role === 'assistant' && message.text.includes('pending buffer'),
    ),
  );
  assert.equal(
    hits.some((message) => message.role === 'tool'),
    false,
  );
});

test('working without a project creates one scratch session, and an empty project stays unlisted', () => {
  const runtime = new PreviewRuntime();
  const before = runtime.getSnapshot().sessions.length;
  const started = runtime.beginConversation({
    workspaceId: null,
    text: 'a loose question',
  });
  assert.ok('sessionId' in started);
  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.sessions.length, before + 1);
  const created = snapshot.sessions.find(
    (session) => session.id === started.sessionId,
  )!;
  const workspace = snapshot.workspaces.find(
    (item) => item.id === created.workspaceId,
  )!;
  assert.equal(workspace.kind, 'scratch');
  assert.equal(created.messages[0]!.text, 'a loose question');
  assert.equal(workspaceListed(workspace, snapshot.sessions), true);
  assert.equal(
    sidebarProjects(snapshot.workspaces, snapshot.sessions).some(
      (item) => item.id === workspace.id,
    ),
    false,
  );
  assert.ok(
    recentSessions(snapshot.sessions).some(
      (session) => session.id === created.id,
    ),
  );
  const placeholder = {
    ...created,
    title: 'new session',
    messages: [],
    queue: [],
    state: 'idle' as const,
  };
  assert.equal(sessionHasContent(placeholder), false);
  assert.equal(workspaceListed(workspace, [placeholder]), false);
  const opened = { ...workspace, id: 'opened', kind: 'project' as const };
  const openedPlaceholder = { ...placeholder, workspaceId: 'opened' };
  assert.equal(workspaceListed(opened, [openedPlaceholder]), false);
  assert.equal(workspaceListed(opened, []), false);
  assert.equal(
    homeProjects([opened, workspace]).some((item) => item.id === 'opened'),
    true,
  );
  const again = runtime.beginConversation({ text: 'another question' });
  assert.ok('sessionId' in again);
  assert.notEqual(again.sessionId, started.sessionId);
  const scratch = runtime
    .getSnapshot()
    .sessions.filter((session) => session.workspaceId === workspace.id);
  assert.equal(scratch.length, 2);
  assert.ok(scratch.every((session) => session.messages.length === 1));
});

test('recent lists every context newest first, and its hover names only a project', () => {
  const runtime = new PreviewRuntime();
  const sample = runtime
    .getSnapshot()
    .sessions.find((session) => sessionHasContent(session))!;
  const project: Workspace = {
    id: 'proj',
    name: 'docs-site',
    path: '/docs',
    branch: '',
    trusted: true,
    kind: 'project',
    instructions: [],
  };
  const scratch: Workspace = {
    id: 'loose',
    name: 'unscoped',
    path: 'unscoped',
    branch: '',
    trusted: true,
    kind: 'scratch',
    instructions: [],
  };
  const older = {
    ...sample,
    id: 'older',
    title: 'older work',
    workspaceId: project.id,
    updatedAt: '2020-01-01T00:00:00.000Z',
    archivedAt: undefined,
    pinned: true,
  };
  const newer = {
    ...sample,
    id: 'newer',
    title: 'newer question',
    workspaceId: scratch.id,
    updatedAt: '2024-06-01T00:00:00.000Z',
    archivedAt: undefined,
    pinned: false,
  };
  const archived = {
    ...sample,
    id: 'archived',
    workspaceId: project.id,
    updatedAt: '2025-01-01T00:00:00.000Z',
    archivedAt: '2025-01-02T00:00:00.000Z',
  };
  const placeholder = {
    ...sample,
    id: 'placeholder',
    title: 'new session',
    workspaceId: project.id,
    messages: [],
    queue: [],
    state: 'idle' as const,
    updatedAt: '2026-01-01T00:00:00.000Z',
    archivedAt: undefined,
  };
  const sessions = [older, newer, archived, placeholder];
  const workspaces = [project, scratch];
  assert.equal(RECENT_SHOWN, 5);
  assert.deepEqual(
    recentSessions(sessions).map((session) => session.id),
    ['newer', 'older'],
  );
  const now = new Date(2026, 9, 15, 12, 0, 0);
  const withAt = (session: typeof older, at: string) => ({
    ...session,
    messages: [{ ...session.messages[0]!, id: `${session.id}-m`, at }],
  });
  const talked = withAt(
    {
      ...older,
      id: 'talked',
      updatedAt: '2019-01-01T00:00:00.000Z',
      pinned: false,
    },
    new Date(now.getTime() - 3 * 60 * 1000).toISOString(),
  );
  const quiet = withAt(
    {
      ...newer,
      id: 'quiet',
      updatedAt: '2026-10-15T12:00:00.000Z',
    },
    '2020-01-01T00:00:00.000Z',
  );
  assert.equal(
    sessionActivityAt(talked),
    new Date(now.getTime() - 3 * 60 * 1000).toISOString(),
  );
  assert.deepEqual(
    recentSessions([quiet, talked]).map((session) => session.id),
    ['talked', 'quiet'],
  );
  const filed = recentDetails(talked, workspaces, now);
  const loose = recentDetails(quiet, workspaces, now);
  assert.equal(filed.project, 'docs-site');
  assert.deepEqual(filed.age, { kind: 'minutes', n: 3 });
  assert.ok(filed.absolute);
  assert.equal(loose.project, undefined);
  assert.equal(loose.age.kind, 'days');
  assert.ok(loose.age.kind === 'days' && loose.age.n >= 1);
  assert.ok(loose.absolute);
  assert.deepEqual(activityAge('today', now), { kind: 'raw', text: 'today' });
  assert.deepEqual(
    activityAge(new Date(now.getTime() - 30_000).toISOString(), now),
    { kind: 'just now' },
  );
  assert.deepEqual(
    activityAge(
      new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      now,
    ),
    { kind: 'hours', n: 2 },
  );
  // 4h45m floors to 4 hours, the same count the terminal shows as `4h`.
  assert.deepEqual(
    activityAge(
      new Date(now.getTime() - (4 * 60 + 45) * 60 * 1000).toISOString(),
      now,
    ),
    { kind: 'hours', n: 4 },
  );
  assert.equal(
    projectTag({ ...older, workspaceId: 'missing' }, workspaces),
    undefined,
  );
  const preview = recentDetails(
    { ...older, updatedAt: 'today' },
    workspaces,
    now,
  );
  assert.deepEqual(preview.age, { kind: 'raw', text: 'today' });
  assert.equal(preview.absolute, undefined);
  assert.deepEqual(
    sidebarProjects(workspaces, sessions).map((item) => item.id),
    ['proj'],
  );
  const late = { ...project, id: 'late', name: 'zeta' };
  const early = { ...project, id: 'early', name: 'alpha' };
  assert.deepEqual(
    orderedProjects(
      [late, early],
      [
        withAt(
          { ...older, id: 'late-session', workspaceId: 'late' },
          '2026-10-15T11:00:00.000Z',
        ),
        {
          ...withAt(
            { ...older, id: 'early-session', workspaceId: 'early' },
            '2026-10-15T08:00:00.000Z',
          ),
          updatedAt: '2026-10-15T12:00:00.000Z',
        },
      ],
    ).map((item) => item.id),
    ['late', 'early'],
  );
  assert.deepEqual(
    orderedProjects(
      [
        { ...project, id: 'b', name: 'zeta' },
        { ...project, id: 'a', name: 'alpha' },
      ],
      [
        {
          ...older,
          id: 's1',
          workspaceId: 'b',
          messages: [],
          updatedAt: 'today',
        },
        {
          ...older,
          id: 's2',
          workspaceId: 'a',
          messages: [],
          updatedAt: 'today',
        },
      ],
    ).map((item) => item.name),
    ['alpha', 'zeta'],
  );
  const inRecent = recentSessions(sessions).some(
    (session) => session.id === older.id,
  );
  const inProject = sessions.some(
    (session) =>
      session.id === older.id &&
      session.workspaceId === project.id &&
      sessionHasContent(session),
  );
  assert.equal(inRecent, true);
  assert.equal(inProject, true);
});
