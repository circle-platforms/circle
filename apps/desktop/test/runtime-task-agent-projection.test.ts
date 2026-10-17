import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeController } from '../src/runtime-controller';
import { ScriptedModel } from '../../../src/testing';
import {
  emptyUsage,
  type Message,
  type ModelRequest,
  type ModelResponse,
} from '../../../src/types';
import {
  defaultSettings,
  trustFolder,
  saveSettings,
} from '../../../src/settings';
import type { RuntimeCommandName } from '../src/runtime-protocol';
import { TaskStore } from '../src/workspace/task-store';

const assistant = (
  content: string,
  tool_calls?: Message['tool_calls'],
): Message => ({ id: randomUUID(), role: 'assistant', content, tool_calls });
async function wait(check: () => boolean, description: string) {
  // A task builds its own worktree first, which Windows runners take seconds to do.
  const until = Date.now() + 30000;
  while (!check()) {
    if (Date.now() > until) throw Error(`timed out: ${description}`);
    await delay(10);
  }
}
test('native delegation reuses real agent sessions, retains child approval owner and restores history without replay', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-agent-projection-')),
    home = join(root, 'home'),
    rawWorkspace = join(root, 'project');
  await mkdir(home);
  await mkdir(rawWorkspace);
  const workspace = await realpath(rawWorkspace);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', '--local', 'core.autocrlf', 'false');
  await writeFile(join(workspace, 'README.md'), 'parent bytes\n');
  await writeFile(join(workspace, 'main.ts'), 'export const value = 1;\n');
  git('add', 'README.md', 'main.ts');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Create fixture',
  );
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const modelTrace: unknown[] = [];
  const workspaceEvents: unknown[] = [];
  const handler = async (request: ModelRequest): Promise<ModelResponse> => {
    const user =
      request.messages.find((message) => message.role === 'user')?.content ??
      '';
    const complete = request.messages.some(
      (message) => message.role === 'tool',
    );
    let message: Message;
    if (user.startsWith('Independently review'))
      message = assistant('{"checks":[]}');
    else if (user.startsWith('Task writer,'))
      message = complete
        ? assistant('changed source')
        : assistant('', [
            {
              id: 'child-write',
              name: 'write_file',
              args: { file_path: 'README.md', content: 'child bytes\n' },
            },
          ]);
    else if (user.startsWith('Task '))
      message = complete
        ? assistant('read source')
        : assistant('', [
            {
              id: 'child-read',
              name: 'read_file',
              args: { file_path: 'README.md' },
            },
          ]);
    else if (
      request.messages.findLast((message) => message.role === 'user')
        ?.content === 'list agents'
    )
      message = request.messages.some(
        (message) => message.tool_call_id === 'list-progress',
      )
        ? assistant('checked agent progress')
        : assistant('', [
            { id: 'list-progress', name: 'native_tasks_list', args: {} },
          ]);
    else
      message = complete
        ? assistant('scheduled two agents')
        : assistant('', [
            {
              id: 'delegate',
              name: 'native_tasks_enqueue',
              args: {
                operationId: 'delegate-once',
                tasks: [
                  {
                    id: 'writer',
                    prompt: 'Update README',
                    access: 'write',
                    acceptanceCriteria: ['inspect changed bytes'],
                  },
                  {
                    id: 'reader',
                    prompt: 'Inspect README',
                    access: 'readonly',
                    acceptanceCriteria: ['inspect read bytes'],
                  },
                ],
              },
            },
          ]);
    modelTrace.push({
      at: Date.now(),
      firstUser: user,
      lastUser: request.messages.findLast((row) => row.role === 'user')
        ?.content,
      toolResults: request.messages.filter((row) => row.role === 'tool'),
      response: message,
    });
    return { message, usage: emptyUsage() };
  };
  const model = new ScriptedModel(Array(40).fill(handler));
  const options = {
    home,
    workspace,
    userHome: home,
    model,
    emit() {},
    emitWorkspaceEvent: (event: unknown) =>
      workspaceEvents.push({ observedAt: Date.now(), event }),
  };
  let controller = new RuntimeController(options);
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  const call = (
    name: RuntimeCommandName,
    payload: Record<string, unknown> = {},
    sessionId = controller.snapshot().activeSessionId,
  ) => controller.dispatch({ id: randomUUID(), name, payload, sessionId });
  const service = (
    service: string,
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
  ) => call('workspace-service', { service, method, params }, sessionId);
  const parent = controller.snapshot().activeSessionId;
  assert.equal((await call('prompt', { text: 'delegate work' })).ok, true);
  await wait(
    () =>
      controller
        .snapshot()
        .interactions.some(
          (row) => row.sessionId === parent && row.status === 'pending',
        ),
    'parent delegation approval',
  );
  const scheduled = controller
    .snapshot()
    .interactions.find(
      (row) => row.sessionId === parent && row.status === 'pending',
    )!;
  assert.equal(
    (
      await call(
        'answer',
        { id: scheduled.id, revision: scheduled.revision, answer: 'approve' },
        parent,
      )
    ).ok,
    true,
  );
  await wait(
    () =>
      controller
        .snapshot()
        .agents.filter(
          (agent) =>
            agent.sessionId === parent && agent.task?.role !== 'reviewer',
        ).length === 2,
    'two real child agents',
  );
  await wait(
    () =>
      controller
        .snapshot()
        .interactions.some(
          (row) => row.sessionId !== parent && row.status === 'pending',
        ),
    'child write approval',
  );
  const initialSnapshot = controller.snapshot();
  const agents = initialSnapshot.agents.filter(
      (agent) => agent.sessionId === parent && agent.task?.role !== 'reviewer',
    ),
    writer = agents.find((agent) => agent.task?.id === 'writer')!,
    reader = agents.find((agent) => agent.task?.id === 'reader')!;
  for (const agent of agents) {
    assert.equal(agent.id, agent.resourceSessionId);
    assert.ok(agent.workspaceId);
    assert.notEqual(agent.id, parent);
    assert.ok(
      controller.snapshot().sessions.some((session) => session.id === agent.id),
    );
  }
  assert.equal(writer.readOnly, false);
  assert.equal(reader.readOnly, true);
  const parentSession = initialSnapshot.sessions.find(
    (session) => session.id === parent,
  )!;
  assert.deepEqual(
    new Set(
      parentSession.messages.find(
        (message) => message.tool?.name === 'native_tasks_enqueue',
      )!.tool!.agentIds,
    ),
    new Set(
      initialSnapshot.agents
        .filter(
          (agent) => agent.sessionId === parent && agent.task?.attempt === 1,
        )
        .map((agent) => agent.id),
    ),
  );
  const pending = controller
    .snapshot()
    .interactions.find(
      (row) => row.sessionId === writer.id && row.status === 'pending',
    )!;
  assert.equal(pending.origin?.agent, writer.id);
  const falseOwner = await call(
    'answer',
    { id: pending.id, revision: pending.revision, answer: 'approve' },
    parent,
  );
  assert.equal(falseOwner.ok, false);
  assert.match(falseOwner.error!, /stale interaction/);
  const read = await service(
    'documents',
    'read',
    { path: 'README.md' },
    reader.id,
  );
  assert.equal(read.ok, true, read.error);
  assert.equal((read.data as any).content, 'parent bytes\n');
  const denied = await service(
    'documents',
    'save',
    {
      path: 'README.md',
      content: 'illegal',
      expectedRevision: (read.data as any).revision,
    },
    reader.id,
  );
  assert.equal(denied.ok, false);
  assert.match(denied.error!, /read-only agent/);
  const apply = await service(
    'documents',
    'applyEdits',
    { changes: [] },
    reader.id,
  );
  assert.equal(apply.ok, false);
  assert.match(apply.error!, /read-only agent/);
  const preview = await service(
    'language',
    'request',
    {
      method: 'rename',
      path: 'main.ts',
      line: 1,
      column: 14,
      newName: 'renamed',
    },
    reader.id,
  );
  assert.equal(preview.ok, true, preview.error);
  assert.ok(Array.isArray(preview.data));
  const parentDoc = await service(
    'documents',
    'read',
    { path: 'main.ts' },
    parent,
  );
  assert.equal(
    (
      await service(
        'documents',
        'save',
        {
          path: 'main.ts',
          content: 'export const value = 2;\n',
          expectedRevision: (parentDoc.data as any).revision,
        },
        parent,
      )
    ).ok,
    true,
  );
  assert.equal((await call('select-session', { id: writer.id })).ok, true);
  assert.equal(controller.snapshot().activeSessionId, writer.id);
  assert.equal(
    (
      await call(
        'answer',
        { id: pending.id, revision: pending.revision, answer: 'approve' },
        writer.id,
      )
    ).ok,
    true,
  );
  await wait(
    () =>
      controller
        .snapshot()
        .agents.filter((agent) => agent.sessionId === parent)
        .every((agent) => agent.task?.state === 'needs_review'),
    'unverified completion stays needs review',
  );
  assert.equal(
    await readFile(join(workspace, 'README.md'), 'utf8'),
    'parent bytes\n',
  );
  const records = await service('tasks', 'list', {}, parent);
  const stored = (records.data as any[]).find(
    (task) => task.spec.id === 'writer',
  );
  assert.equal(
    await readFile(join(stored.worktree, 'README.md'), 'utf8'),
    'child bytes\n',
  );
  const retried = await service(
    'tasks',
    'retry',
    { id: 'writer', operationId: 'retry-writer' },
    parent,
  );
  assert.equal(retried.ok, true, retried.error);
  await wait(
    () =>
      controller
        .snapshot()
        .agents.some(
          (agent) =>
            agent.sessionId === parent &&
            agent.task?.id === 'writer' &&
            agent.task.attempt === 2,
        ),
    'retry child has a distinct real session',
  );
  const secondWriter = controller
    .snapshot()
    .agents.find(
      (agent) =>
        agent.sessionId === parent &&
        agent.task?.id === 'writer' &&
        agent.task.attempt === 2,
    )!;
  assert.notEqual(secondWriter.id, writer.id);
  const originalCard = controller
    .snapshot()
    .sessions.find((session) => session.id === parent)!
    .messages.find((message) => message.tool?.name === 'native_tasks_enqueue')!;
  assert.deepEqual(
    new Set(originalCard.tool!.agentIds),
    new Set(
      controller
        .snapshot()
        .agents.filter(
          (agent) => agent.sessionId === parent && agent.task?.attempt === 1,
        )
        .map((agent) => agent.id),
    ),
    'original scheduling card retains its original attempts',
  );
  assert.equal(
    (await service('tasks', 'cancel', { id: 'writer' }, parent)).ok,
    true,
  );
  assert.equal(
    controller.snapshot().agents.find((agent) => agent.id === secondWriter.id)!
      .task!.state,
    'cancelled',
  );
  assert.equal((await call('select-session', { id: parent })).ok, true);
  assert.equal((await call('new-session')).ok, true);
  const foreignParent = controller.snapshot().activeSessionId;
  assert.equal(
    (
      await service(
        'tasks',
        'enqueue',
        {
          operationId: 'foreign-task',
          tasks: [
            {
              id: 'foreign',
              prompt: 'Inspect separately owned README',
              access: 'readonly',
              acceptanceCriteria: ['inspect read bytes'],
            },
          ],
        },
        foreignParent,
      )
    ).ok,
    true,
  );
  const foreignWaitStartedAt = Date.now();
  try {
    await wait(
      () =>
        controller
          .snapshot()
          .agents.some(
            (agent) =>
              agent.sessionId === foreignParent &&
              agent.task?.state === 'needs_review',
          ),
      'foreign owner child completes',
    );
  } catch (error) {
    // Preserve actual ledger/model/approval ownership before controller cleanup
    // removes the fixture. A timeout alone cannot identify a runtime or UI bug.
    try {
      const path = join(
        import.meta.dirname,
        '../artifacts/runtime',
        `task-agent-projection-failure-${randomUUID()}.json`,
      );
      let db: DatabaseSync | undefined;
      let ledger: unknown;
      try {
        db = new DatabaseSync(
          join(
            home,
            'collaboration',
            createHash('sha256').update(workspace).digest('hex').slice(0, 24),
            'collaboration.sqlite',
          ),
          { readOnly: true },
        );
        ledger = Object.fromEntries(
          ['tasks', 'attempts', 'operations', 'events'].map((table) => [
            table,
            db!
              .prepare(`SELECT record FROM ${table}`)
              .all()
              .map((row) => JSON.parse(String(row.record))),
          ]),
        );
      } catch (readError) {
        ledger = { error: String(readError) };
      } finally {
        db?.close();
      }
      await mkdir(join(import.meta.dirname, '../artifacts/runtime'), {
        recursive: true,
      });
      await writeFile(
        path,
        JSON.stringify(
          {
            phase: 'foreign owner child completes',
            foreignWaitStartedAt,
            observedAt: Date.now(),
            error: String(error),
            root,
            workspace,
            parent,
            foreignParent,
            snapshot: controller.snapshot(),
            ledger,
            actualModelRequestCount: model.requests.length,
            modelTrace,
            workspaceEvents,
          },
          null,
          2,
        ),
      );
      t.diagnostic(`Actual foreign-owner failure receipt: ${path}`);
    } catch (receiptError) {
      t.diagnostic(`Foreign-owner receipt failed: ${String(receiptError)}`);
    }
    throw error;
  }
  const foreignChild = controller
    .snapshot()
    .agents.find((agent) => agent.sessionId === foreignParent)!;
  assert.equal((await call('select-session', { id: parent })).ok, true);
  const progress = await call('prompt', { text: 'list agents' }, parent);
  assert.equal(progress.ok, true, progress.error);
  await wait(
    () =>
      controller
        .snapshot()
        .sessions.find((session) => session.id === parent)!
        .messages.some(
          (message) =>
            message.tool?.name === 'native_tasks_list' &&
            message.tool.status === 'success',
        ),
    'real list result projected',
  );
  const listCard = controller
    .snapshot()
    .sessions.find((session) => session.id === parent)!
    .messages.find((message) => message.tool?.name === 'native_tasks_list')!;
  assert.ok(listCard.tool!.agentIds?.includes(secondWriter.id));
  assert.ok(
    !listCard.tool!.agentIds?.includes(foreignChild.id),
    'foreign task returned by workspace list cannot become this parent’s agent',
  );
  const expectedAgents = controller
    .snapshot()
    .agents.filter((agent) => agent.sessionId === parent);
  await controller.close();
  const count = model.requests.length;
  controller = new RuntimeController(options);
  const restored = controller
    .snapshot()
    .agents.filter((agent) => agent.sessionId === parent);
  assert.deepEqual(
    new Set(restored.map((agent) => agent.id)),
    new Set(expectedAgents.map((agent) => agent.id)),
  );
  assert.deepEqual(
    restored.map((agent) => [agent.id, agent.task?.state]).sort(),
    expectedAgents.map((agent) => [agent.id, agent.task?.state]).sort(),
  );
  assert.equal(model.requests.length, count);
  const again = await service(
    'documents',
    'save',
    {
      path: 'README.md',
      content: 'still illegal',
      expectedRevision: (read.data as any).revision,
    },
    reader.id,
  );
  assert.equal(again.ok, false);
  assert.match(again.error!, /read-only agent/);
  assert.equal(model.requests.length, count);
  await controller.close();
  const ledgerPath = join(
    home,
    'collaboration',
    createHash('sha256').update(workspace).digest('hex').slice(0, 24),
    'collaboration.sqlite',
  );
  // Model the persisted boundary left by a process death. History projection
  // must not reconcile it, declare it running, or replay its unknown command.
  let ledger = new TaskStore(ledgerPath);
  const unfinished = ledger.get('writer')!;
  ledger.put({ ...unfinished, state: 'running', runtimeState: 'running' });
  ledger.putOperation({
    id: 'unknown-side-effect',
    kind: 'task',
    fingerprint: 'original',
    taskId: 'writer',
    attempt: unfinished.attempt,
    state: 'running',
  });
  ledger.close();
  controller = new RuntimeController(options);
  const unknown = controller
    .snapshot()
    .agents.find((agent) => agent.id === secondWriter.id)!;
  assert.equal(unknown.task!.state, 'running');
  assert.equal(unknown.task!.recovery, 'needs_reconciliation');
  assert.equal(unknown.status, 'waiting');
  assert.equal(model.requests.length, count);
  ledger = new TaskStore(ledgerPath);
  try {
    assert.equal(ledger.get('writer')!.state, 'running');
    assert.equal(ledger.operation('unknown-side-effect')!.state, 'running');
  } finally {
    ledger.close();
  }
});
