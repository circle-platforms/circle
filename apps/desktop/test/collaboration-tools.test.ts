import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AgentRuntime } from '../../../src/runtime.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import { defaultSettings, trustFolder } from '../../../src/settings.ts';
import type { Message } from '../../../src/types.ts';
import { TaskService } from '../src/workspace/task-service.ts';
import { createCollaborationTools } from '../src/workspace/collaboration-tools.ts';

const exec = promisify(execFile);
const assistant = (
  content: string,
  tool_calls?: Message['tool_calls'],
): Message => ({
  id: randomUUID(),
  role: 'assistant',
  content,
  ...(tool_calls ? { tool_calls } : {}),
});
const tasks = [
  {
    id: 'build-ui',
    prompt: 'Implement the page in an isolated worktree',
    access: 'write',
    acceptanceCriteria: ['page renders without errors'],
  },
  {
    id: 'review-ui',
    prompt: 'Independently inspect the implementation',
    access: 'readonly',
    dependencies: ['build-ui'],
    acceptanceCriteria: ['review contains specific findings'],
  },
];
async function fixture(
  run: (value: {
    root: string;
    workspace: string;
    home: string;
    service: TaskService;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'circle-parent-tools-'));
  const workspace = join(root, 'workspace'),
    home = join(root, 'home');
  await mkdir(workspace);
  await mkdir(home);
  await exec('git', ['init', workspace]);
  await writeFile(join(workspace, 'README.md'), '# fixture\n');
  await exec('git', ['-C', workspace, 'add', 'README.md']);
  await exec('git', [
    '-C',
    workspace,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Create fixture',
  ]);
  const service = new TaskService({
    workspace,
    dataDir: join(root, 'tasks'),
    autoStart: false,
    emit: () => {},
    createRuntime: () => {
      throw Error('scheduler must remain paused during parent planning test');
    },
  });
  try {
    await run({ root, workspace, home, service });
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('real parent model enqueues two dependent tasks and receives ledger IDs next request', () =>
  fixture(async ({ workspace, home, service }) => {
    let approvals = 0;
    const model = new ScriptedModel([
      {
        message: assistant('', [
          {
            id: 'enqueue-graph',
            name: 'native_tasks_enqueue',
            args: { operationId: 'graph-one', tasks },
          },
        ]),
      },
      {
        message: assistant('', [
          { id: 'read-graph', name: 'native_tasks_list', args: {} },
        ]),
      },
      { message: assistant('Two tasks scheduled with a review dependency') },
    ]);
    let runtime!: AgentRuntime;
    runtime = new AgentRuntime({
      workspace,
      home,
      userHome: home,
      settings: trustFolder(defaultSettings(), workspace),
      model,
      headless: true,
      bundledExtensions: false,
      extraTools: createCollaborationTools({
        sessionId: () => runtime.session.id,
        service: () => service,
      }),
      approve: async () => {
        approvals++;
        return 'approve';
      },
    });
    try {
      await runtime.harness.run('Implement and independently review this page');
      assert.equal(
        approvals,
        1,
        'enqueue approval once; read-only list does not ask',
      );
      assert.equal(model.requests.length, 3);
      const result = model.requests[1].messages.find(
        (message) => message.tool_call_id === 'enqueue-graph',
      );
      assert.ok(
        result,
        'next model request must contain the actual tool result',
      );
      const actual = JSON.parse(result.content);
      assert.deepEqual(
        actual.tasks.map((task: { spec: { id: string } }) => task.spec.id),
        ['build-ui', 'review-ui'],
      );
      assert.deepEqual(actual.tasks[1].spec.dependencies, ['build-ui']);
      assert.ok(
        actual.tasks.every(
          (task: { spec: { baseline: string; sessionId: string } }) =>
            /^[a-f0-9]{40,64}$/.test(task.spec.baseline) &&
            task.spec.sessionId === runtime.session.id,
        ),
      );
      assert.deepEqual(actual.artifacts, []);
      assert.equal(service.getTask('build-ui')!.spec.access, 'write');
      assert.equal(service.getTask('review-ui')!.spec.access, 'readonly');
      assert.equal(
        model.requests[2].messages.find(
          (message) => message.tool_call_id === 'read-graph',
        )!.status,
        'success',
      );
      assert.ok(
        createCollaborationTools({
          sessionId: runtime.session.id,
          service: () => service,
        }).every(
          (tool) => tool.subagents === false && tool.variables === 'plain',
        ),
      );
    } finally {
      await runtime.close();
    }
  }));

test('rejected parent execution and foreign owners do not enqueue tasks', () =>
  fixture(async ({ workspace, home, service }) => {
    const model = new ScriptedModel([
      {
        message: assistant('', [
          {
            id: 'blocked',
            name: 'native_tasks_enqueue',
            args: { operationId: 'rejected', tasks },
          },
        ]),
      },
      { message: assistant('Permission was refused') },
    ]);
    let runtime!: AgentRuntime;
    runtime = new AgentRuntime({
      workspace,
      home,
      userHome: home,
      settings: trustFolder(defaultSettings(), workspace),
      model,
      headless: true,
      bundledExtensions: false,
      extraTools: createCollaborationTools({
        sessionId: () => runtime.session.id,
        service: () => service,
      }),
      approve: async () => 'reject',
    });
    try {
      await runtime.harness.run('Start graph');
      assert.equal(service.getTask('build-ui'), undefined);
      const denied = model.requests[1].messages.find(
        (message) => message.tool_call_id === 'blocked',
      )!;
      assert.equal(denied.status, 'error');
      const tools = createCollaborationTools({
        sessionId: runtime.session.id,
        service: () => service,
      });
      await assert.rejects(
        tools[0].run(
          { operationId: 'wrong-owner', tasks },
          { sessionId: 'other-session', signal: new AbortController().signal },
        ),
        /another parent/,
      );
      assert.equal(service.getTask('build-ui'), undefined);
    } finally {
      await runtime.close();
    }
  }));

test('auto parent execution is approved by policy while plan mode remains read-only', () =>
  fixture(async ({ workspace, home, service }) => {
    let approvals = 0;
    const model = new ScriptedModel([
      {
        message: assistant('', [
          {
            id: 'auto-graph',
            name: 'native_tasks_enqueue',
            args: { operationId: 'auto-operation', tasks },
          },
        ]),
      },
      { message: assistant('scheduled') },
      {
        message: assistant('', [
          {
            id: 'plan-graph',
            name: 'native_tasks_enqueue',
            args: {
              operationId: 'plan-operation',
              tasks: [{ ...tasks[0], id: 'plan-blocked' }],
            },
          },
        ]),
      },
      { message: assistant('plan only') },
    ]);
    let runtime!: AgentRuntime;
    runtime = new AgentRuntime({
      workspace,
      home,
      userHome: home,
      settings: trustFolder(defaultSettings(), workspace),
      model,
      headless: true,
      bundledExtensions: false,
      extraTools: createCollaborationTools({
        sessionId: () => runtime.session.id,
        service: () => service,
      }),
      approve: async () => {
        approvals++;
        return 'reject';
      },
    });
    try {
      runtime.policy.setMode(runtime.session.id, 'auto');
      await runtime.harness.run('Run graph automatically');
      assert.equal(approvals, 0);
      assert.ok(service.getTask('build-ui'));
      runtime.harness.planMode = true;
      await runtime.harness.run('Plan another task without execution');
      assert.equal(service.getTask('plan-blocked'), undefined);
      assert.equal(approvals, 0);
      assert.equal(
        model.requests[3].messages.find(
          (message) => message.tool_call_id === 'plan-graph',
        )!.status,
        'error',
      );
    } finally {
      await runtime.close();
    }
  }));
