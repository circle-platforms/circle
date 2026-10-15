import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeController } from '../src/runtime-controller.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import { AgentRuntime } from '../../../src/runtime.ts';
import {
  defaultSettings,
  trustFolder,
  saveSettings,
} from '../../../src/settings.ts';
import type { WorkspaceServiceEvent } from '../src/workspace-protocol.ts';
const assistant = (content: string, calls?: any[]) => ({
  id: randomUUID(),
  role: 'assistant' as const,
  content,
  tool_calls: calls,
});
async function wait(check: () => boolean) {
  const until = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > until) throw Error('fixture timed out');
    await delay(10);
  }
}
async function setup(
  t: TestContext,
  replies: ConstructorParameters<typeof ScriptedModel>[0] = [],
  trusted = true,
) {
  const root = await mkdtemp(join(tmpdir(), 'circle-controller-services-'));
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  await mkdir(home);
  await mkdir(workspace);
  execFileSync('git', ['init', '-q', workspace]);
  saveSettings(
    trusted ? trustFolder(defaultSettings(), workspace) : defaultSettings(),
    home,
  );
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
  t.after(() => foreign.close());
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
  const f = await setup(t, [{ message: assistant('rules loaded') }]);
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
});
