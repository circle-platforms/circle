import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  rename,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { WorkspaceEventStream } from '../src/workspace/event-stream.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeController } from '../src/runtime-controller.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import { AgentRuntime } from '../../../src/runtime.ts';
import type { FileMutations } from '../../../src/file_mutations.ts';
import {
  defaultSettings,
  loadSettings,
  trustFolder,
  saveSettings,
  saveSettingsChange,
} from '../../../src/settings.ts';
import type { WorkspaceServiceEvent } from '../src/workspace-protocol.ts';
import { patience } from './helpers/patience.mjs';

// Windows refuses to rename a folder while anything holds a handle in it, such
// as a watcher that is closing or a virus scan, so retry for a short while.
async function moveAside(folder: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(folder, folder + '.old');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 50 || (code !== 'EBUSY' && code !== 'EPERM')) throw error;
      await delay(100);
    }
  }
}
const assistant = (content: string, calls?: any[]) => ({
  id: randomUUID(),
  role: 'assistant' as const,
  content,
  tool_calls: calls,
});
async function wait(check: () => boolean) {
  const until = Date.now() + patience(8000);
  while (!check()) {
    if (Date.now() > until) throw Error('fixture timed out');
    await delay(10);
  }
}
async function setup(
  t: TestContext,
  replies: ConstructorParameters<typeof ScriptedModel>[0] = [],
  trusted = true,
  extra: Partial<ConstructorParameters<typeof RuntimeController>[0]> = {},
  prepare: (settings: ReturnType<typeof defaultSettings>) => void = () => {},
) {
  const root = await mkdtemp(join(tmpdir(), 'circle-controller-services-'));
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  await mkdir(home);
  await mkdir(workspace);
  execFileSync('git', ['init', '-q', workspace]);
  const settings = trusted
    ? trustFolder(defaultSettings(), workspace)
    : defaultSettings();
  prepare(settings);
  saveSettings(settings, home);
  const model = new ScriptedModel(replies);
  const events: WorkspaceServiceEvent[] = [];
  const updates: any[] = [];
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model,
    emit: (u) => updates.push(u),
    emitWorkspaceEvent: (e) => events.push(e),
    ...extra,
  });
  const call = (
    name: string,
    payload: Record<string, unknown> = {},
    sessionId = controller.snapshot().activeSessionId,
  ) => controller.dispatch({ id: randomUUID(), name, payload, sessionId });
  const service = (
    name: string,
    method: string,
    params: Record<string, unknown> = {},
    sessionId = controller.snapshot().activeSessionId,
  ) => call('workspace-service', { service: name, method, params }, sessionId);
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    home,
    workspace,
    model,
    controller,
    call,
    service,
    events,
    updates,
  };
}
test('legacy write-file requires an explicit revision without changing existing or missing files', async (t) => {
  const f = await setup(t);
  await writeFile(join(f.workspace, 'README.md'), 'human content');
  for (const path of ['README.md', 'not-created.txt']) {
    const denied = await f.call('write-file', {
      path,
      content: 'unversioned overwrite',
    });
    if (path === 'README.md')
      assert.equal(
        await readFile(join(f.workspace, path), 'utf8'),
        'human content',
        'an unversioned request must preserve the actual disk contents',
      );
    assert.equal(denied.ok, false);
    assert.match(denied.error!, /revision.*required.*read/i);
  }
  await assert.rejects(readFile(join(f.workspace, 'not-created.txt')), {
    code: 'ENOENT',
  });
  assert.equal(f.model.requests.length, 0);
});
test('legacy write-file rejects an earlier read revision and preserves the later human contents', async (t) => {
  const f = await setup(t);
  await writeFile(join(f.workspace, 'README.md'), 'before');
  const read = await f.service('documents', 'read', { path: 'README.md' });
  assert.equal(read.ok, true, read.error);
  const revision = (read.data as { revision: string }).revision;
  await writeFile(join(f.workspace, 'README.md'), 'human after read');
  const denied = await f.call('write-file', {
    path: 'README.md',
    content: 'stale draft',
    expectedRevision: revision,
  });
  assert.equal(denied.ok, false);
  assert.match(denied.error!, /file changed on disk/);
  assert.equal(
    await readFile(join(f.workspace, 'README.md'), 'utf8'),
    'human after read',
  );
  assert.equal(f.model.requests.length, 0);
});
test('legacy write-file accepts null only for an explicit new file', async (t) => {
  const f = await setup(t);
  const created = await f.call('write-file', {
    path: 'nested/new.txt',
    content: 'new content',
    expectedRevision: null,
  });
  assert.equal(created.ok, true, created.error);
  assert.equal(
    await readFile(join(f.workspace, 'nested/new.txt'), 'utf8'),
    'new content',
  );
  const read = await f.service('documents', 'read', { path: 'nested/new.txt' });
  assert.equal(read.ok, true, read.error);
  assert.equal(
    (created.data as any).document.revision,
    (read.data as any).revision,
  );
  const collision = await f.call('write-file', {
    path: 'nested/new.txt',
    content: 'replace with null',
    expectedRevision: null,
  });
  assert.equal(collision.ok, false);
  assert.match(collision.error!, /file changed on disk/);
  assert.equal(
    await readFile(join(f.workspace, 'nested/new.txt'), 'utf8'),
    'new content',
  );
});
test('legacy write-file accepts the current read revision and returns the saved disk revision', async (t) => {
  const f = await setup(t);
  await writeFile(join(f.workspace, 'README.md'), 'before');
  const read = await f.service('documents', 'read', { path: 'README.md' });
  assert.equal(read.ok, true, read.error);
  const revision = (read.data as { revision: string }).revision;
  const saved = await f.call('write-file', {
    path: 'README.md',
    content: 'versioned human save',
    expectedRevision: revision,
  });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(
    await readFile(join(f.workspace, 'README.md'), 'utf8'),
    'versioned human save',
  );
  const current = await f.service('documents', 'read', { path: 'README.md' });
  assert.equal(current.ok, true, current.error);
  assert.notEqual((saved.data as any).document.revision, revision);
  assert.equal(
    (saved.data as any).document.revision,
    (current.data as any).revision,
  );
  assert.equal(f.model.requests.length, 0);
});
test('busy and inactive known sessions can save with CAS without switching selection or publishing chat snapshots', async (t) => {
  const f = await setup(t, [
    async (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        );
      }),
  ]);
  await writeFile(join(f.workspace, 'README.md'), 'before');
  const first = f.controller.snapshot().activeSessionId;
  assert.equal((await f.call('prompt', { text: 'stay active' })).ok, true);
  await wait(() => f.model.requests.length === 1);
  const initial = await f.service(
    'documents',
    'read',
    { path: 'README.md' },
    first,
  );
  assert.equal(initial.ok, true);
  assert.equal((await f.call('new-session')).ok, true);
  const selected = f.controller.snapshot().activeSessionId;
  assert.notEqual(first, selected);
  const count = f.updates.length;
  const doc = initial.data as any;
  const saved = await f.service(
    'documents',
    'save',
    {
      path: 'README.md',
      content: 'human edit',
      expectedRevision: doc.revision,
    },
    first,
  );
  assert.equal(saved.ok, true, saved.error);
  assert.equal(
    await readFile(join(f.workspace, 'README.md'), 'utf8'),
    'human edit',
  );
  assert.equal(f.controller.snapshot().activeSessionId, selected);
  assert.equal(f.updates.length, count);
  await wait(() => f.events.length > 0);
  const id = f.controller.snapshot().workspaces[0]!.id;
  assert.ok(f.events.every((event) => event.workspaceId === id));
  const replay = await f.service(
    'events',
    'replay',
    { after: { offset: 0, seq: 0 }, limit: 256 },
    first,
  );
  assert.equal(replay.ok, true, replay.error);
  assert.ok((replay.data as any).events.length);
  assert.equal(typeof (replay.data as any).cursor.offset, 'number');
  const conflict = await f.service(
    'documents',
    'save',
    {
      path: 'README.md',
      content: 'stale edit',
      expectedRevision: doc.revision,
    },
    first,
  );
  assert.equal(conflict.ok, false);
  assert.match(conflict.error!, /changed/);
  assert.equal(
    await readFile(join(f.workspace, 'README.md'), 'utf8'),
    'human edit',
  );
});
test('unknown and untrusted service requests cannot acquire workspace authority', async (t) => {
  const f = await setup(t, [], false);
  await writeFile(join(f.workspace, 'README.md'), 'untouched');
  const denied = await f.service('documents', 'read', { path: 'README.md' });
  assert.equal(denied.ok, false);
  assert.match(denied.error!, /trust/);
  const unknown = await f.service(
    'documents',
    'save',
    { path: 'README.md', content: 'bad', expectedRevision: null },
    'unknown-session',
  );
  assert.equal(unknown.ok, false);
  assert.match(unknown.error!, /session not found/);
  assert.equal(
    await readFile(join(f.workspace, 'README.md'), 'utf8'),
    'untouched',
  );
  assert.equal(f.events.length, 0);
});
test('foreign occupied viewed history can use workspace documents without acquiring its runtime lease', async (t) => {
  const f = await setup(t);
  await writeFile(join(f.workspace, 'README.md'), 'foreign view');
  const settings = trustFolder(defaultSettings(), f.workspace);
  const foreign = new AgentRuntime({
    workspace: f.workspace,
    home: f.home,
    userHome: f.home,
    settings,
    model: new ScriptedModel([]),
  });
  try {
    const selected = await f.call('select-session', { id: foreign.session.id });
    assert.equal(selected.ok, true, selected.error);
    const read = await f.service(
      'documents',
      'read',
      { path: 'README.md' },
      foreign.session.id,
    );
    assert.equal(read.ok, true, read.error);
    assert.equal((read.data as any).content, 'foreign view');
    assert.equal(f.controller.snapshot().activeSessionId, foreign.session.id);
  } finally {
    await foreign.close();
  }
});
test('human save while agent write approval waits prevents stale agent overwrite', async (t) => {
  const f = await setup(t, [
    {
      message: assistant('', [
        { id: 'read', name: 'read_file', args: { file_path: 'README.md' } },
      ]),
    },
    {
      message: assistant('', [
        {
          id: 'write',
          name: 'write_file',
          args: { file_path: 'README.md', content: 'agent stale' },
        },
      ]),
    },
    { message: assistant('stale write rejected') },
  ]);
  await writeFile(join(f.workspace, 'README.md'), 'before');
  await f.call('prompt', { text: 'read and update README' });
  await wait(() =>
    f.controller
      .snapshot()
      .interactions.some(
        (i) => i.kind === 'approval' && i.status === 'pending',
      ),
  );
  const read = await f.service('documents', 'read', { path: 'README.md' });
  const doc = read.data as any;
  const save = await f.service('documents', 'save', {
    path: 'README.md',
    content: 'human latest',
    expectedRevision: doc.revision,
  });
  assert.equal(save.ok, true, save.error);
  const approval = f.controller
    .snapshot()
    .interactions.find((i) => i.kind === 'approval' && i.status === 'pending')!;
  const answer = await f.call(
    'answer',
    { id: approval.id, revision: approval.revision, answer: 'approve' },
    approval.sessionId,
  );
  assert.equal(answer.ok, true, answer.error);
  await wait(() => f.model.requests.length >= 3);
  assert.equal(
    await readFile(join(f.workspace, 'README.md'), 'utf8'),
    'human latest',
  );
  assert.ok(
    f.model.requests[2]!.messages.some(
      (m) => m.role === 'tool' && /changed|revision|conflict/.test(m.content),
    ),
  );
});

test('loaded project rules expose their real source path in the native snapshot', async (t) => {
  const f = await setup(t, [
    { message: assistant('rules loaded') },
    { message: assistant('new session rules loaded') },
  ]);
  await writeFile(
    join(f.workspace, 'AGENTS.md'),
    'independent loaded rule marker',
  );
  await f.call('prompt', { text: 'load actual project context' });
  await wait(() => f.model.requests.length === 1);
  assert.ok(
    f.model.requests[0]!.tools.some(
      (tool) => tool.name === 'native_tasks_enqueue',
    ),
  );
  const instructions = f.controller
    .snapshot()
    .workspaces.find(
      (w) =>
        w.path ===
        f.controller.snapshot().workspaces.find((p) => p.trusted)?.path,
    )!.instructions;
  const rule = instructions.find((rule) =>
    rule.content.includes('independent loaded rule marker'),
  );
  assert.ok(rule);
  assert.ok(rule.path);
  assert.equal(
    await readFile(rule.path!, 'utf8'),
    'independent loaded rule marker',
  );
  await writeFile(join(f.workspace, 'AGENTS.md'), 'new session actual rule');
  await f.call('new-session');
  await f.call('prompt', { text: 'load changed rules in this session' });
  await wait(() => f.model.requests.length === 2);
  assert.ok(
    f.controller
      .snapshot()
      .workspaces.some((workspace) =>
        workspace.instructions.some((rule) =>
          rule.content.includes('new session actual rule'),
        ),
      ),
  );
});

test('task bridge runs isolated writers and read-only reviewer while task approval can be opened', async (t) => {
  const handler: NonNullable<
    ConstructorParameters<typeof ScriptedModel>[0]
  >[number] = async (request) => {
    const prompt =
      request.messages.find((m) => m.role === 'user')?.content ?? '';
    const match = /Task (left|right|review), attempt/.exec(prompt);
    if (!match)
      return {
        message: assistant('parent ready'),
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
      };
    assert.ok(
      !request.tools.some(
        (tool) =>
          tool.name.startsWith('native_tasks_') &&
          tool.name !== 'native_tasks_propose',
      ),
    );
    const name = match[1];
    const hadTool = request.messages.some((m) => m.role === 'tool');
    return {
      message: hadTool
        ? assistant(`finished ${name}`)
        : assistant('', [
            {
              id: `${name}-call`,
              name: name === 'review' ? 'read_file' : 'write_file',
              args:
                name === 'review'
                  ? { file_path: 'README.md' }
                  : { file_path: 'same.txt', content: name },
            },
          ]),
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
    };
  };
  const f = await setup(t, Array(30).fill(handler));
  await writeFile(join(f.workspace, 'README.md'), 'baseline');
  execFileSync('git', ['-C', f.workspace, 'add', 'README.md']);
  execFileSync('git', [
    '-C',
    f.workspace,
    '-c',
    'user.name=Circle Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Baseline',
  ]);
  const parent = f.controller.snapshot().activeSessionId;
  const enqueue = await f.service(
    'tasks',
    'enqueue',
    {
      operationId: 'fixture-isolated-three',
      tasks: ['left', 'right', 'review'].map((id) => ({
        id,
        access: id === 'review' ? 'readonly' : 'write',
        prompt: `perform ${id}`,
        acceptanceCriteria: ['inspect actual result'],
      })),
    },
    parent,
  );
  assert.equal(enqueue.ok, true, enqueue.error);
  await wait(() =>
    f.controller.snapshot().interactions.some((i) => i.status === 'pending'),
  );
  const waiting = f.controller
    .snapshot()
    .interactions.find((i) => i.status === 'pending')!;
  const selected = await f.call('select-session', { id: waiting.sessionId });
  assert.equal(selected.ok, true, selected.error);
  assert.equal(f.controller.snapshot().activeSessionId, waiting.sessionId);
  await f.call('select-session', { id: parent });
  // A wall-clock bound, not a product target: after their last model reply the
  // three tasks still capture candidates and close runtimes in real worktrees,
  // which a Windows runner has taken more than the remaining 4 s to finish.
  const until = Date.now() + 30000;
  let tasks: any[] = [];
  const bridgeTimeline: unknown[] = [];
  while (Date.now() < until) {
    for (const row of f.controller
      .snapshot()
      .interactions.filter((i) => i.status === 'pending')) {
      const answer = await f.call(
        'answer',
        { id: row.id, revision: row.revision, answer: 'approve' },
        row.sessionId,
      );
      assert.equal(answer.ok, true, answer.error);
    }
    const list = await f.service('tasks', 'list', {}, parent);
    assert.equal(list.ok, true, list.error);
    const nextTasks = list.data as any[];
    if (JSON.stringify(tasks) !== JSON.stringify(nextTasks))
      bridgeTimeline.push({ at: Date.now(), tasks: nextTasks });
    tasks = nextTasks;
    if (
      tasks.every((task) =>
        ['needs_review', 'succeeded', 'failed'].includes(task.state),
      )
    )
      break;
    await delay(10);
  }
  let bridgeFailureReceipt: string | undefined;
  if (!tasks.every((task) => task.state === 'needs_review')) {
    const directory = join(import.meta.dirname, '../artifacts/runtime');
    await mkdir(directory, { recursive: true });
    bridgeFailureReceipt = join(
      directory,
      `controller-task-bridge-failure-${randomUUID()}.json`,
    );
    await writeFile(
      bridgeFailureReceipt,
      JSON.stringify(
        {
          deadline: until,
          observedAt: Date.now(),
          tasks,
          authoritativeAfterFailure: (
            await f.service('tasks', 'list', {}, parent)
          ).data,
          timeline: bridgeTimeline,
          interactions: f.controller.snapshot().interactions,
          modelRequestCount: f.model.requests.length,
          requests: f.model.requests,
          events: f.events,
          files: await Promise.all(
            tasks.map(async (task) => ({
              id: task.spec.id,
              worktree: task.worktree,
              content: task.worktree
                ? await readFile(join(task.worktree, 'same.txt'), 'utf8').catch(
                    (error) => String(error),
                  )
                : undefined,
            })),
          ),
        },
        null,
        2,
      ),
    );
  }
  assert.equal(tasks.length, 3);
  assert.ok(
    tasks.every((task) => task.state === 'needs_review'),
    JSON.stringify({
      bridgeFailureReceipt,
      tasks: tasks.map((t) => ({
        id: t.spec.id,
        state: t.state,
        reason: t.reason,
      })),
    }),
  );
  assert.notEqual(tasks[0].worktree, tasks[1].worktree);
  for (const id of ['left', 'right'])
    assert.equal(
      await readFile(
        join(tasks.find((task) => task.spec.id === id).worktree, 'same.txt'),
        'utf8',
      ),
      id,
    );
  await assert.rejects(readFile(join(f.workspace, 'same.txt')));
  assert.ok(f.events.some((event) => event.service === 'tasks'));
});

test('a replaced trusted root cannot redirect an existing session into another trusted repository', async (t) => {
  const f = await setup(t, [{ message: assistant('opened') }]);
  await writeFile(join(f.workspace, 'marker.txt'), 'A');
  const first = f.controller.snapshot().activeSessionId;
  const other = join(f.root, 'other');
  await mkdir(other);
  execFileSync('git', ['init', '-q', other]);
  await writeFile(join(other, 'marker.txt'), 'B');
  saveSettingsChange(f.home, (settings) =>
    Object.assign(settings, trustFolder(settings, other)),
  );
  const initial = await f.service(
    'documents',
    'read',
    { path: 'marker.txt' },
    first,
  );
  assert.equal(initial.ok, true);
  const revision = (initial.data as any).revision;
  await moveAside(f.workspace);
  await symlink(
    other,
    f.workspace,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  for (const [service, method, params] of [
    ['documents', 'read', { path: 'marker.txt' }],
    [
      'documents',
      'save',
      { path: 'marker.txt', content: 'redirected', expectedRevision: revision },
    ],
    ['git', 'status', {}],
  ] as const) {
    const denied = await f.service(service, method, params, first);
    assert.equal(denied.ok, false);
    assert.match(denied.error!, /workspace root changed/);
  }
  const shell = await f.call(
    'shell',
    { command: 'node -e process.exit(0)' },
    first,
  );
  assert.equal(shell.ok, false);
  assert.match(shell.error!, /workspace root changed/);
  assert.equal(f.model.requests.length, 0);
  assert.equal(await readFile(join(other, 'marker.txt'), 'utf8'), 'B');
  assert.equal(
    await readFile(join(f.workspace + '.old', 'marker.txt'), 'utf8'),
    'A',
  );
  // Opening the folder again authorizes its own root. A session in it starts
  // with the first message from home, as in the application.
  const opened = await f.call('open-workspace', { path: other });
  assert.equal(opened.ok, true, opened.error);
  const begun = await f.call('begin-session', {
    workspaceId: (opened.data as { workspaceId: string }).workspaceId,
    text: 'read the marker',
    display: 'read the marker',
  });
  assert.equal(begun.ok, true, begun.error);
  const reopened = (begun.data as { sessionId: string }).sessionId;
  await wait(
    () =>
      f.controller
        .snapshot()
        .sessions.find((session) => session.id === reopened)
        ?.messages.some((message) => message.role === 'assistant') ?? false,
  );
  const independent = await f.service(
    'documents',
    'read',
    { path: 'marker.txt' },
    reopened,
  );
  assert.equal(independent.ok, true, independent.error);
  assert.equal((independent.data as any).content, 'B');
  await moveAside(other);
  await mkdir(other);
  await writeFile(join(other, 'marker.txt'), 'replacement inode');
  const replaced = await f.service(
    'documents',
    'read',
    { path: 'marker.txt' },
    reopened,
  );
  assert.equal(replaced.ok, false);
  assert.match(replaced.error!, /workspace root changed/);
  // A new conversation from home cannot start in the replaced folder either.
  const sessions = f.controller.snapshot().sessions.length;
  const refused = await f.call('begin-session', {
    workspaceId: (opened.data as { workspaceId: string }).workspaceId,
    text: 'start over',
    display: 'start over',
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error!, /workspace root changed/);
  assert.equal(f.controller.snapshot().sessions.length, sessions);
  assert.equal(f.model.requests.length, 1);
  assert.equal(
    await readFile(join(other, 'marker.txt'), 'utf8'),
    'replacement inode',
  );
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
test('archive refuses native processes and confirmed delete awaits only its owning PTY', async (t) => {
  const f = await setup(t);
  const first = f.controller.snapshot().activeSessionId;
  const create = () =>
    f.service('terminal', 'create', {
      command: {
        file: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
      },
    });
  const a = await create();
  assert.equal(a.ok, true, a.error);
  const pidA = (a.data as any).pid;
  assert.ok(alive(pidA));
  assert.equal(
    f.controller.snapshot().sessions.find((s) => s.id === first)
      ?.nativeResourcesActive,
    true,
  );
  await f.call('new-session');
  const second = f.controller.snapshot().activeSessionId;
  const b = await create();
  assert.equal(b.ok, true, b.error);
  const pidB = (b.data as any).pid;
  const archive = await f.call('archive-session', {
    id: first,
    archived: true,
  });
  assert.equal(archive.ok, false);
  assert.match(archive.error!, /native resources/);
  const archiveAll = await f.call('archive-workspace', {
    workspaceId: f.controller.snapshot().sessions.find((s) => s.id === first)!
      .workspaceId,
  });
  assert.equal(archiveAll.ok, false);
  assert.match(archiveAll.error!, /native resources/);
  const unconfirmed = await f.call('delete-session', { id: first });
  assert.equal(unconfirmed.ok, false);
  assert.match(unconfirmed.error!, /confirm/);
  assert.ok(alive(pidA));
  const deleted = await f.call('delete-session', {
    id: first,
    confirmed: true,
  });
  assert.equal(deleted.ok, true, deleted.error);
  await wait(() => !alive(pidA));
  assert.ok(alive(pidB));
  assert.equal(f.controller.snapshot().activeSessionId, second);
  const close = await f.service('terminal', 'close', {
    id: (b.data as any).id,
  });
  assert.equal(close.ok, true, close.error);
  await wait(() => !alive(pidB));
  await wait(() =>
    f.updates.some(
      (u) =>
        u.snapshot.sessions.find((s: any) => s.id === second)
          ?.nativeResourcesActive === false,
    ),
  );
  assert.equal(
    f.controller.snapshot().sessions.find((s) => s.id === second)
      ?.nativeResourcesActive,
    false,
  );
});

test('a native shell exiting by itself publishes archive availability without a command', async (t) => {
  const f = await setup(t);
  const session = f.controller.snapshot().activeSessionId;
  const created = await f.service('terminal', 'create', {
    command: {
      file: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
    },
  });
  assert.equal(created.ok, true, created.error);
  const terminal = created.data as any;
  assert.ok(alive(terminal.pid));
  await wait(() =>
    f.updates.some(
      (u) =>
        u.snapshot.sessions.find((s: any) => s.id === session)
          ?.nativeResourcesActive === true,
    ),
  );
  const afterStart = f.updates.length;
  process.kill(terminal.pid, 'SIGKILL');
  await wait(() => !alive(terminal.pid));
  await wait(() =>
    f.updates
      .slice(afterStart)
      .some(
        (u) =>
          u.snapshot.sessions.find((s: any) => s.id === session)
            ?.nativeResourcesActive === false,
      ),
  );
  const archived = await f.call('archive-session', {
    id: session,
    archived: true,
  });
  assert.equal(archived.ok, true, archived.error);
  assert.ok(
    f.controller.snapshot().sessions.find((s) => s.id === session)?.archivedAt,
  );
});

test('a confirmed archive closes the terminal tabs first, and stops nothing while something else keeps a session (#201)', async (t) => {
  const f = await setup(t, [
    {
      message: assistant('', [
        {
          id: 'write',
          name: 'write_file',
          args: { file_path: 'blocked.txt', content: 'only after approval' },
        },
      ]),
    },
    { message: assistant('rejected') },
  ]);
  const first = f.controller.snapshot().activeSessionId;
  const shell = await f.service('terminal', 'create', {
    command: {
      file: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
    },
  });
  assert.equal(shell.ok, true, shell.error);
  const pid = (shell.data as any).pid;
  assert.ok(alive(pid));
  const workspaceId = f.controller
    .snapshot()
    .sessions.find((s) => s.id === first)!.workspaceId;
  // Another session of the folder waits for an approval: archiving all of them
  // cannot happen, so it closes nothing, confirmed or not.
  await f.call('new-session');
  const second = f.controller.snapshot().activeSessionId;
  await f.call('prompt', { text: 'request a write' });
  await wait(() =>
    f.controller
      .snapshot()
      .interactions.some((row) => row.status === 'pending'),
  );
  for (const confirmed of [false, true]) {
    const refused = await f.call('archive-workspace', {
      workspaceId,
      confirmed,
    });
    assert.equal(refused.ok, false);
    assert.match(refused.error!, /before archiving it/);
  }
  assert.ok(alive(pid));
  assert.equal(
    f.controller.snapshot().sessions.some((s) => s.archivedAt),
    false,
  );
  const pending = f.controller
    .snapshot()
    .interactions.find((row) => row.status === 'pending')!;
  await f.call('answer', {
    id: pending.id,
    revision: pending.revision,
    answer: 'reject',
  });
  await wait(
    () =>
      f.controller.snapshot().sessions.find((s) => s.id === second)!.state ===
      'idle',
  );
  const archived = await f.call('archive-workspace', {
    workspaceId,
    confirmed: true,
  });
  assert.equal(archived.ok, true, archived.error);
  await wait(() => !alive(pid));
  for (const id of [first, second]) {
    const session = f.controller.snapshot().sessions.find((s) => s.id === id)!;
    assert.ok(session.archivedAt, id);
    assert.equal(session.nativeResourcesActive, false);
  }
  // One session alone: its shell closes and it is archived.
  await f.call('archive-session', { id: first, archived: false });
  await f.call('select-session', { id: first });
  const again = await f.service(
    'terminal',
    'create',
    {
      command: {
        file: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
      },
    },
    first,
  );
  assert.equal(again.ok, true, again.error);
  const pidAgain = (again.data as any).pid;
  assert.ok(alive(pidAgain));
  const one = await f.call('archive-session', {
    id: first,
    archived: true,
    confirmed: true,
  });
  assert.equal(one.ok, true, one.error);
  await wait(() => !alive(pidAgain));
  assert.ok(
    f.controller.snapshot().sessions.find((s) => s.id === first)!.archivedAt,
  );
});

test('streaming token IPC sends deltas while final snapshots remain authoritative', async (t) => {
  const content = Array(128).fill('chunk ').join('');
  const f = await setup(t, [
    async (request) => {
      for (let i = 0; i < 128; i++) request.token('chunk ');
      return {
        message: assistant(content),
        usage: { input_tokens: 1, output_tokens: 128, cache_read_tokens: 0 },
      };
    },
  ]);
  const deltas: any[] = [];
  f.controller.options.emitTokenDelta = (delta) => deltas.push(delta);
  await f.call('prompt', { text: 'stream a response' });
  await wait(() =>
    f.controller
      .snapshot()
      .sessions.some((session) =>
        session.messages.some((message) => message.text === content),
      ),
  );
  assert.equal(deltas.length, 128);
  assert.equal(deltas.map((delta) => delta.text ?? '').join(''), content);
  assert.ok(
    deltas.every(
      (delta, index) => delta.seq === index + 1 && delta.baseSeq > 0,
    ),
  );
  assert.ok(
    f.updates.length < 20,
    'tokens must not amplify into full history snapshots',
  );
  assert.ok(f.updates.every((update) => update.event?.kind !== 'llm_token'));
  await wait(() => f.updates.some((update) => update.tokenStream?.seq === 128));
  assert.ok(
    f.updates
      .at(-1)
      .snapshot.sessions.some((session: any) =>
        session.messages.some((message: any) => message.text === content),
      ),
  );
});

test('workspace journal failure cancels its producers and remains visible after state polling', async (t) => {
  let aborted = false;
  const f = await setup(t, [
    async (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(request.signal.reason);
          },
          { once: true },
        );
      }),
  ]);
  await writeFile(join(f.workspace, 'README.md'), 'existing document');
  await f.call('prompt', { text: 'stay running while native journal fails' });
  await wait(() => f.model.requests.length === 1);
  let attemptedJournal: string | undefined;
  const open = WorkspaceEventStream.open.bind(WorkspaceEventStream);
  // Corrupt the exact physical journal selected by the real service, rather
  // than duplicating its path/hash policy in the test (8.3 aliases differ).
  t.mock.method(
    WorkspaceEventStream,
    'open',
    async (
      path: string,
      options?: Parameters<typeof WorkspaceEventStream.open>[1],
    ) => {
      attemptedJournal = path;
      // Opening a directory with a+ is platform dependent on Windows. Corrupt
      // the actual journal bytes instead, preserving sibling PTY directories.
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{synthetic invalid journal record}\n');
      return open(path, options);
    },
  );
  const failed = await f.service('documents', 'read', { path: 'README.md' });
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? '', /JSON|Unexpected token|invalid/i);
  assert.ok(attemptedJournal?.endsWith('events.jsonl'));
  try {
    await wait(() => aborted);
  } catch (error) {
    throw Error(
      `${String(error)}: ${JSON.stringify({ attemptedJournal, failed, runtime: f.controller.snapshot().runtime, activeWorkspaces: [...(f.controller as any).runtimes.values()].map((runtime: any) => runtime.options.workspace) })}`,
    );
  }

  assert.match(
    f.controller.snapshot().runtime?.error ?? '',
    /persistence failed/,
  );
  await f.call('state');
  assert.match(
    f.controller.snapshot().runtime?.error ?? '',
    /persistence failed/,
  );
});

test('parent conversations share the configured app model pool without holding leases for whole turns', async (t) => {
  const f = await setup(t, [
    async (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        );
      }),
    { message: assistant('second parent completed') },
  ]);
  const configured = await f.service('tasks', 'settings', {
    limits: { agents: 1 },
  });
  assert.equal(configured.ok, true, configured.error);
  const first = f.controller.snapshot().activeSessionId;
  await f.call('prompt', { text: 'first parent blocked' });
  await wait(() => f.model.requests.length === 1);
  await f.call('new-session');
  const second = f.controller.snapshot().activeSessionId;
  await f.call('prompt', { text: 'second parent queued' });
  await delay(50);
  assert.equal(f.model.requests.length, 1);
  await f.call('select-session', { id: first });
  await f.call('abort');
  await wait(() => f.model.requests.length === 2);
  await wait(
    () =>
      f.controller
        .snapshot()
        .sessions.find((s) => s.id === second)
        ?.messages.some((m) => m.text === 'second parent completed') === true,
  );
});

test('completed native saves survive controller restart without replaying writes', async (t) => {
  const f = await setup(t);
  await writeFile(join(f.workspace, 'answer.txt'), 'before');
  const read = await f.service('documents', 'read', { path: 'answer.txt' });
  assert.equal(read.ok, true, read.error);
  const command = {
    id: randomUUID(),
    name: 'workspace-service',
    sessionId: f.controller.snapshot().activeSessionId,
    payload: {
      service: 'documents',
      method: 'save',
      params: {
        path: 'answer.txt',
        content: 'saved once',
        expectedRevision: (read.data as any).revision,
      },
    },
  };
  const saved = await f.controller.dispatch(command);
  assert.equal(saved.ok, true, saved.error);
  await f.controller.close();
  await writeFile(join(f.workspace, 'answer.txt'), 'external edit after save');
  const restarted = new RuntimeController({
    home: f.home,
    workspace: f.workspace,
    userHome: f.home,
    model: new ScriptedModel([]),
    emit: () => {},
  });

  const replay = await restarted.dispatch(command);
  assert.equal(replay.ok, true, replay.error);
  assert.deepEqual(replay.data, saved.data);
  assert.equal(
    await readFile(join(f.workspace, 'answer.txt'), 'utf8'),
    'external edit after save',
  );
  const different = await restarted.dispatch({
    ...command,
    payload: {
      ...command.payload,
      params: { ...command.payload.params, content: 'wrong second input' },
    },
  });
  assert.equal(different.ok, false);
  assert.equal(
    await readFile(join(f.workspace, 'answer.txt'), 'utf8'),
    'external edit after save',
  );
  await restarted.close();
});

test('pending operation review is restricted to its owning session and never replays effects', async (t) => {
  const f = await setup(t);
  const owner = f.controller.snapshot().activeSessionId;
  const operationId = randomUUID();
  const failed = await f.controller.dispatch({
    id: operationId,
    name: 'workspace-service',
    sessionId: owner,
    payload: {
      service: 'terminal',
      method: 'write',
      params: { id: 'missing-terminal', data: 'private input' },
    },
  });
  assert.equal(failed.ok, false);
  const listed = await f.service('operations', 'list', {
    state: 'needs_review',
  });
  assert.equal(listed.ok, true, listed.error);
  const metadata = (listed.data as any[]).find((row) => row.id === operationId);
  assert.equal(metadata.sessionId, owner);
  assert.equal(JSON.stringify(metadata).includes('private input'), false);
  await f.call('new-session');
  const foreign = await f.service('operations', 'review', {
    id: operationId,
    note: 'checked',
  });
  assert.equal(foreign.ok, false);
  const reviewed = await f.service(
    'operations',
    'review',
    { id: operationId, note: 'confirmed no terminal was created' },
    owner,
  );
  assert.equal(reviewed.ok, true, reviewed.error);
  assert.equal((reviewed.data as any).state, 'reconciled');
  const pending = await f.service(
    'operations',
    'list',
    { state: 'needs_review' },
    owner,
  );
  assert.equal((pending.data as any[]).length, 0);
});
test('controller task verification executes a pinned project oracle in an isolated candidate', async (t) => {
  const handler = async (request: any) => ({
    message: request.messages.some((m: any) => m.role === 'tool')
      ? assistant('implemented answer')
      : assistant('', [
          {
            id: 'oracle-write',
            name: 'write_file',
            args: { file_path: 'answer.txt', content: '42' },
          },
        ]),
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
  });
  const f = await setup(t, Array(15).fill(handler));
  await mkdir(join(f.workspace, '.circle'));
  await writeFile(
    join(f.workspace, 'package.json'),
    JSON.stringify({ scripts: { test: 'node verify.cjs' } }),
  );
  await writeFile(
    join(f.workspace, 'verify.cjs'),
    "if(require('node:fs').readFileSync('answer.txt','utf8')!=='42')process.exit(1)",
  );
  await writeFile(join(f.workspace, 'answer.txt'), '0');
  await writeFile(
    join(f.workspace, '.circle/verification.json'),
    JSON.stringify({
      version: 1,
      checks: [
        {
          criterion: 'answer is 42',
          script: 'test',
          oraclePaths: ['verify.cjs'],
        },
      ],
    }),
  );
  execFileSync('git', [
    '-C',
    f.workspace,
    'add',
    'package.json',
    'verify.cjs',
    'answer.txt',
    '.circle/verification.json',
  ]);
  execFileSync('git', [
    '-C',
    f.workspace,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Baseline',
  ]);
  const parent = f.controller.snapshot().activeSessionId;
  const started = await f.service(
    'tasks',
    'enqueue',
    {
      operationId: 'controller-oracle',
      tasks: [
        {
          id: 'oracle',
          access: 'write',
          prompt: 'write answer.txt with 42',
          acceptanceCriteria: ['answer is 42'],
        },
      ],
    },
    parent,
  );
  assert.equal(started.ok, true, started.error);
  let task: any;
  const deadline = Date.now() + patience(15000);
  while (Date.now() < deadline) {
    for (const interaction of f.controller
      .snapshot()
      .interactions.filter((i) => i.status === 'pending'))
      await f.call(
        'answer',
        {
          id: interaction.id,
          revision: interaction.revision,
          answer: 'approve',
        },
        interaction.sessionId,
      );
    const list = await f.service('tasks', 'list', {}, parent);
    task = (list.data as any[])?.[0];
    if (task && ['succeeded', 'failed', 'needs_review'].includes(task.state))
      break;
    await delay(20);
  }
  assert.equal(task?.state, 'succeeded', JSON.stringify(task));
  assert.equal(await readFile(join(f.workspace, 'answer.txt'), 'utf8'), '0');
  assert.equal(await readFile(join(task.worktree, 'answer.txt'), 'utf8'), '42');
});

test('nested agent patch reports committed paths to the next model after a real competing disk write', async (t) => {
  const f = await setup(t, [
    {
      message: assistant('', [
        {
          id: 'partial-patch',
          name: 'apply_patch',
          args: {
            patchText:
              '*** Begin Patch\n*** Update File: nested/a.ts\n@@\n-old A\n+agent A\n*** Update File: nested/b.ts\n@@\n-old B\n+agent B\n*** End Patch',
          },
        },
      ]),
    },
    { message: assistant('inspect partial result') },
  ]);
  await mkdir(join(f.workspace, 'nested'));
  await writeFile(join(f.workspace, 'nested/a.ts'), 'old A\n');
  await writeFile(join(f.workspace, 'nested/b.ts'), 'old B\n');
  await f.service('documents', 'read', { path: 'nested/a.ts' });
  const documents = (f.controller as any).services(
    realpathSync.native(f.workspace),
  ).documents;
  const readTarget = documents.readTarget.bind(documents);
  let triggered = false;
  t.mock.method(documents, 'readTarget', async (...args: any[]) => {
    const result = await readTarget(...args);
    if (
      args[1] === 'nested/a.ts' &&
      result.content === 'agent A\n' &&
      !triggered
    ) {
      triggered = true;
      await writeFile(join(f.workspace, 'nested/b.ts'), 'external B\n');
    }
    return result;
  });
  const started = await f.call('prompt', { text: 'update both nested files' });
  assert.equal(started.ok, true, started.error);
  await wait(() =>
    f.controller.snapshot().interactions.some((i) => i.status === 'pending'),
  );
  const approval = f.controller
    .snapshot()
    .interactions.find((i) => i.status === 'pending')!;
  await f.call(
    'answer',
    { id: approval.id, revision: approval.revision, answer: 'approve' },
    approval.sessionId,
  );
  await wait(() => f.model.requests.length >= 2);
  assert.equal(
    await readFile(join(f.workspace, 'nested/a.ts'), 'utf8'),
    'agent A\n',
  );
  assert.equal(
    await readFile(join(f.workspace, 'nested/b.ts'), 'utf8'),
    'external B\n',
  );
  const result = f.model.requests[1].messages
    .filter((m) => m.role === 'tool')
    .map((m) => m.content)
    .join('\n');
  assert.match(result, /committed paths: nested\/a\.ts/);
  assert.match(result, /failures: nested\/b\.ts/);
});

test('native document access applies trusted project credential file rules', async (t) => {
  const f = await setup(t);
  await mkdir(join(f.workspace, '.circle'));
  await writeFile(
    join(f.workspace, '.circle/settings.json'),
    JSON.stringify({ credential_files: ['private.fixture'] }),
  );
  await writeFile(
    join(f.workspace, 'private.fixture'),
    'synthetic protected value',
  );
  for (const [method, params] of [
    ['read', { path: 'private.fixture' }],
    [
      'save',
      { path: 'private.fixture', content: 'bad', expectedRevision: null },
    ],
    [
      'applyEdits',
      {
        edits: [
          { path: 'private.fixture', content: 'bad', expectedRevision: null },
        ],
      },
    ],
  ] as const) {
    const reply = await f.service('documents', method, params);
    if (reply.ok) assert.equal((reply.data as any)?.status, 'rejected');
    assert.equal(
      JSON.stringify(reply).includes('synthetic protected value'),
      false,
    );
    assert.equal(
      await readFile(join(f.workspace, 'private.fixture'), 'utf8'),
      'synthetic protected value',
    );
    if (method === 'read') assert.equal(reply.ok, false);
  }
});

test('controller preserves queued input across restart and requires explicit idempotent recovery', async (t) => {
  const f = await setup(t, [
    async (request) =>
      new Promise((_resolve, reject) =>
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        ),
      ),
  ]);
  await f.call('prompt', { text: 'stay busy' });
  await wait(() => f.model.requests.length === 1);
  const sessionId = f.controller.snapshot().activeSessionId;
  const queued = {
    id: randomUUID(),
    name: 'prompt',
    sessionId,
    payload: {
      text: 'recover exact original content',
      display: 'short shown draft',
      kind: 'follow-up',
    },
  };
  assert.equal((await f.controller.dispatch(queued)).ok, true);
  await f.controller.close();
  const model = new ScriptedModel([{ message: assistant('recovered once') }]);
  const restarted = new RuntimeController({
    home: f.home,
    workspace: f.workspace,
    userHome: f.home,
    model,
    emit: () => {},
  });
  const service = (method: string, params: Record<string, unknown> = {}) =>
    restarted.dispatch({
      id: randomUUID(),
      name: 'workspace-service',
      sessionId,
      payload: { service: 'inputs', method, params },
    });
  try {
    const listing = await service('list');
    assert.equal(listing.ok, true, listing.error);
    const recovery = listing.data as any;
    assert.equal(recovery.items.length, 1);
    assert.equal(recovery.items[0].payload.text, queued.payload.text);
    assert.equal(recovery.items[0].payload.display, queued.payload.display);
    await delay(30);
    assert.equal(model.requests.length, 0);
    const oldRPC = await restarted.dispatch(queued);
    assert.equal(oldRPC.ok, true, oldRPC.error);
    assert.equal(
      model.requests.length,
      0,
      'lost queued receipt cannot turn into a new prompt after restart',
    );
    const toDraft = await service('resolve', {
      ids: [queued.id],
      expectedVersion: recovery.version,
      operationId: 'return-draft',
      action: 'returnToDraft',
    });
    assert.equal(toDraft.ok, true, toDraft.error);
    assert.equal(
      ((await service('list')).data as any).items.length,
      1,
      'draft return retains durable source',
    );
    const fresh = (await service('list')).data as any;
    const request = {
      ids: [queued.id],
      expectedVersion: fresh.version,
      operationId: 'resume-once',
      action: 'resume',
    };
    const resumed = await service('resolve', request);
    assert.equal(resumed.ok, true, resumed.error);
    await wait(() => model.requests.length === 1);
    assert.ok(
      model.requests[0].messages.some(
        (message) =>
          message.role === 'user' && message.content === queued.payload.text,
      ),
    );
    const repeat = await service('resolve', request);
    assert.equal(repeat.ok, true, repeat.error);
    assert.equal((repeat.data as any).applied, false);
    await delay(30);
    assert.equal(model.requests.length, 1);
  } finally {
    await restarted.close();
  }
});

test('private input drafts remain recoverable after workspace trust is revoked', async (t) => {
  const f = await setup(t, [
    async (request) =>
      new Promise((_resolve, reject) =>
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        ),
      ),
  ]);
  await f.call('prompt', { text: 'busy' });
  await wait(() => f.model.requests.length === 1);
  await f.call('prompt', { text: 'private durable draft' });
  await f.controller.close();
  const restarted = new RuntimeController({
    home: f.home,
    workspace: f.workspace,
    userHome: f.home,
    model: new ScriptedModel([]),
    emit: () => {},
  });
  const sessionId = restarted.snapshot().activeSessionId;
  saveSettings(defaultSettings(), f.home);
  const call = (method: string, params: Record<string, unknown> = {}) =>
    restarted.dispatch({
      id: randomUUID(),
      name: 'workspace-service',
      sessionId,
      payload: { service: 'inputs', method, params },
    });
  try {
    const listing = await call('list');
    assert.equal(listing.ok, true, listing.error);
    const value = listing.data as any;
    const request = {
      ids: [value.items[0].id],
      expectedVersion: value.version,
      operationId: 'revoked-copy',
      action: 'returnToDraft',
    };
    const copy = await call('resolve', request);
    assert.equal(copy.ok, true, copy.error);
    assert.equal(
      (copy.data as any).items[0].payload.text,
      'private durable draft',
    );
    const resume = await call('resolve', {
      ...request,
      operationId: 'revoked-resume',
      action: 'resume',
    });
    assert.equal(resume.ok, false);
    assert.match(resume.error!, /trust/);
    const fresh = (await call('list')).data as any;
    const discard = await call('resolve', {
      ...request,
      expectedVersion: fresh.version,
      operationId: 'revoked-discard',
      action: 'discard',
    });
    assert.equal(discard.ok, true, discard.error);
    assert.equal(((await call('list')).data as any).items.length, 0);
  } finally {
    await restarted.close();
  }
});

test('late events after normal service disposal do not become storage failures or cancel live models', async (t) => {
  let signal: AbortSignal | undefined;
  const f = await setup(t, [
    async (request) => {
      signal = request.signal;
      return new Promise((_resolve, reject) =>
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        ),
      );
    },
  ]);
  await f.call('prompt', { text: 'keep model active' });
  await wait(() => !!signal);
  await writeFile(join(f.workspace, 'file.txt'), 'fixture');
  assert.equal(
    (await f.service('documents', 'read', { path: 'file.txt' })).ok,
    true,
  );
  const root = realpathSync.native(f.workspace),
    controller = f.controller as any;
  const service = controller.workspaceServices.get(root);
  await service.dispose();
  const event = {
    workspaceId: createHash('sha256').update(root).digest('hex').slice(0, 24),
    sessionId: f.controller.snapshot().activeSessionId,
    service: 'tasks',
    resourceId: 'late',
    epoch: 'late',
    seq: 1,
    at: new Date().toISOString(),
    data: { type: 'late-cleanup' },
  };
  await assert.rejects(
    () => service.publishSource(event),
    (error: any) => error.code === 'WORKSPACE_SERVICES_CLOSED',
  );
  controller.workspaceEvent(root, event);
  await delay(30);
  assert.equal(
    signal!.aborted,
    false,
    'normal closed stream must not abort another ongoing model',
  );
  assert.equal(controller.workspaceStreamFailures.size, 0);
  assert.equal(service.eventHealth.error, undefined);
  await f.controller.close();
  const count = controller.workspaceServices.size;
  controller.workspaceEvent(join(f.root, 'never-opened'), event);
  await delay(10);
  assert.equal(
    controller.workspaceServices.size,
    count,
    'closing does not create a new service',
  );
  assert.equal(controller.workspaceStreamFailures.size, 0);
});

test('native controller mutations share a canonical root across actual filesystem path aliases', async (t) => {
  const f = await setup(t);
  await f.controller.close();
  const canonical = realpathSync.native(f.workspace);
  let alias: string;
  if (process.platform === 'win32') {
    // Call Windows' API directly: cmd/execFile's quote re-escaping can return
    // literal \" characters rather than a filesystem path.
    const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CircleShortPath {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint GetShortPathName(string path, StringBuilder buffer, uint length);
}
'@
$buffer = New-Object System.Text.StringBuilder 32768
$result = [CircleShortPath]::GetShortPathName($env:CIRCLE_TEST_ALIAS_PATH, $buffer, $buffer.Capacity)
if ($result -eq 0 -or $result -ge $buffer.Capacity) { throw "GetShortPathName failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
[Console]::WriteLine($buffer.ToString())
`;
    alias = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, CIRCLE_TEST_ALIAS_PATH: canonical },
      },
    ).trim();
    assert.ok(
      alias && realpathSync.native(alias) === canonical,
      'Windows short name must resolve to the exact granted directory',
    );
    if (alias.toLowerCase() === canonical.toLowerCase()) {
      assert.notEqual(
        f.workspace.toLowerCase(),
        canonical.toLowerCase(),
        'runner fixture must expose a real 8.3 alias',
      );
      alias = f.workspace;
    }
  } else {
    alias = join(f.root, 'project-alias');
    await symlink(canonical, alias, 'dir');
  }
  await mkdir(join(canonical, 'nested'));
  await writeFile(
    join(canonical, 'nested/current.ts'),
    'export const current = 0;\n',
  );
  saveSettings(trustFolder(defaultSettings(), canonical), f.home);
  const model = new ScriptedModel([
    {
      message: assistant('', [
        {
          id: 'alias-create',
          name: 'write_file',
          args: {
            file_path: 'nested/created.ts',
            content: 'export const created = 42;\n',
          },
        },
      ]),
    },
    { message: assistant('created using the native document coordinator') },
  ]);
  const controller = new RuntimeController({
    home: f.home,
    workspace: alias,
    userHome: f.home,
    model,
    emit: () => {},
  });
  const call = (name: string, payload: Record<string, unknown> = {}) =>
    controller.dispatch({
      id: randomUUID(),
      name,
      sessionId: controller.snapshot().activeSessionId,
      payload,
    });
  const document = (method: string, params: Record<string, unknown>) =>
    call('workspace-service', { service: 'documents', method, params });
  try {
    const read = await document('read', { path: 'nested/current.ts' });
    assert.equal(read.ok, true, read.error);
    // The native backend is bound to the actual runtime, whose sandbox decides
    // whether an alias is internal or needs this session's exact-file grant.
    const owner: AgentRuntime = (controller as any).runtimes.get(
      controller.snapshot().activeSessionId,
    );
    assert.ok(owner instanceof AgentRuntime);
    const signal = new AbortController().signal;
    const mutations: FileMutations = (controller as any).fileMutations(
      canonical,
      () => owner,
    );
    const aliasedRead = await mutations.read(
      join(alias, 'nested/current.ts'),
      signal,
    );
    assert.equal(aliasedRead.revision, (read.data as any).revision);
    await mutations.apply(
      [
        {
          path: join(alias, 'nested/by-alias.ts'),
          content: 'export const alias = true;\n',
          expectedRevision: null,
        },
      ],
      signal,
    );
    assert.equal(
      await readFile(join(canonical, 'nested/by-alias.ts'), 'utf8'),
      'export const alias = true;\n',
    );
    assert.equal(
      (await call('prompt', { text: 'create a nested file' })).ok,
      true,
    );
    await wait(() =>
      controller
        .snapshot()
        .interactions.some((row) => row.status === 'pending'),
    );
    const approval = controller
      .snapshot()
      .interactions.find((row) => row.status === 'pending')!;
    await call('answer', {
      id: approval.id,
      revision: approval.revision,
      answer: 'approve',
    });
    await wait(() => model.requests.length >= 2);
    assert.equal(
      await readFile(join(canonical, 'nested/created.ts'), 'utf8'),
      'export const created = 42;\n',
    );
    const save = await document('save', {
      path: 'nested/current.ts',
      content: 'export const current = 1;\n',
      expectedRevision: (read.data as any).revision,
    });
    assert.equal(save.ok, true, save.error);
    assert.equal(
      await readFile(join(canonical, 'nested/current.ts'), 'utf8'),
      'export const current = 1;\n',
    );
    await assert.rejects(
      () =>
        mutations.apply(
          [
            {
              path: join(alias, 'nested/current.ts'),
              content: 'must not overwrite a newer revision',
              expectedRevision: aliasedRead.revision,
            },
          ],
          signal,
        ),
      /revision|changed|conflict/i,
    );
    assert.equal(
      await readFile(join(canonical, 'nested/current.ts'), 'utf8'),
      'export const current = 1;\n',
    );
    await assert.rejects(
      () =>
        mutations.apply(
          [
            {
              path: join(f.root, 'outside.ts'),
              content: 'escape',
              expectedRevision: null,
            },
          ],
          signal,
        ),
      /external file requires a grant/i,
    );
    await assert.rejects(readFile(join(f.root, 'outside.ts')), {
      code: 'ENOENT',
    });
    assert.equal(
      await readFile(join(canonical, 'nested/created.ts'), 'utf8'),
      'export const created = 42;\n',
    );
  } finally {
    await controller.close();
  }
});

test('a developer extension setting saved by an earlier version is ignored, and debug and language requests are refused', async (t) => {
  const f = await setup(t, [], true, {}, (settings) => {
    settings.extensions.developer = { enabled: true };
  });
  const extensions = f.controller.snapshot().extensions;
  assert.ok(extensions.some((item) => item.name === 'github'));
  assert.equal(
    extensions.some((item) => item.name === 'developer'),
    false,
  );
  await writeFile(join(f.workspace, 'main.ts'), 'export const value = 1;\n');
  for (const [service, method, params] of [
    ['language', 'open', { path: 'main.ts' }],
    ['debug', 'launch', { program: 'main.ts' }],
  ] as const) {
    const reply = await f.service(service, method, params);
    assert.equal(reply.ok, false);
    assert.match(String(reply.error), /unknown workspace service operation/);
  }
  const saved = await f.call('save-settings', {
    settings: {},
    extensions: [{ name: 'github', enabled: false }],
  });
  assert.equal(saved.ok, true, String(saved.error));
  assert.deepEqual(loadSettings(f.home).extensions.developer, {
    enabled: true,
  });
});
