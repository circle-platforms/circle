import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AgentRuntime } from '../../../src/runtime.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import { defaultSettings, trustFolder } from '../../../src/settings.ts';
import { emptyUsage, type Message } from '../../../src/types.ts';
import {
  TaskService,
  type TaskServiceOptions,
} from '../src/workspace/task-service.ts';
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
  options?: (roots: {
    workspace: string;
    home: string;
  }) => Partial<
    Pick<TaskServiceOptions, 'autoStart' | 'createRuntime' | 'verify'>
  >,
) {
  const root = await mkdtemp(join(tmpdir(), 'circle-parent-tools-'));
  const workspace = join(root, 'workspace'),
    home = join(root, 'home');
  await mkdir(workspace);
  await mkdir(home);
  await exec('git', ['init', workspace]);
  await exec('git', [
    '-C',
    workspace,
    'config',
    '--local',
    'core.autocrlf',
    'false',
  ]);
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
    ...options?.({ workspace, home }),
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

test('plan parent schedules two actual parallel read-only analyses without allowing project writes', async () => {
  const childModels = new Map<string, ScriptedModel>();
  const childWorktrees: string[] = [];
  let entered = 0;
  let release!: () => void;
  const parallel = new Promise<void>((resolve) => {
    release = resolve;
  });
  await fixture(
    async ({ workspace, home, service }) => {
      const before = await readFile(join(workspace, 'README.md'));
      const index = await readFile(join(workspace, '.git', 'index'));
      const model = new ScriptedModel([
        {
          message: assistant('', [
            {
              id: 'analyze-graph',
              name: 'native_tasks_analyze',
              args: {
                operationId: 'planning-analysis',
                tasks: [
                  {
                    id: 'inspect-ui',
                    prompt: 'Read README.md and analyze the interface',
                    acceptanceCriteria: ['README reviewed without writes'],
                  },
                  {
                    id: 'inspect-diagnostics',
                    prompt: 'Read README.md and analyze diagnosis',
                    access: 'readonly',
                    resource: 'agent',
                    acceptanceCriteria: ['README reviewed without writes'],
                  },
                ],
              },
            },
          ]),
        },
        {
          message: assistant('', [
            {
              id: 'wait-ui',
              name: 'native_tasks_wait',
              args: { ids: ['inspect-ui'], timeoutMs: 10000 },
            },
            {
              id: 'wait-diagnostics',
              name: 'native_tasks_wait',
              args: { ids: ['inspect-diagnostics'], timeoutMs: 10000 },
            },
          ]),
        },
        {
          message: assistant('', [
            {
              id: 'write-in-plan',
              name: 'native_tasks_enqueue',
              args: {
                operationId: 'forbidden-plan-write',
                tasks: [{ ...tasks[0], id: 'plan-blocked' }],
              },
            },
          ]),
        },
        {
          message: assistant(
            'The two read-only analyses completed; implementation requires leaving plan mode',
          ),
        },
      ]);
      let runtime!: AgentRuntime;
      let approvals = 0;
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
      runtime.harness.planMode = true;
      try {
        await runtime.harness.run(
          'Plan with two independent investigations; do not implement',
        );
        assert.equal(
          entered,
          2,
          'both child models entered before either analysis could continue',
        );
        assert.equal(
          approvals,
          0,
          'plan analysis and reads never ask for execution approval',
        );
        const scheduled = model.requests[1]!.messages.find(
          (message) => message.tool_call_id === 'analyze-graph',
        )!;
        assert.equal(scheduled.status, 'success');
        const actual = JSON.parse(scheduled.content);
        assert.equal(actual.tasks.length, 2);
        for (const task of actual.tasks) {
          assert.equal(task.spec.access, 'readonly');
          assert.equal(task.spec.resource, 'agent');
          assert.equal(task.spec.sessionId, runtime.session.id);
          assert.match(task.spec.baseline, /^[a-f0-9]{40,64}$/);
        }
        for (const id of ['wait-ui', 'wait-diagnostics']) {
          const result = model.requests[2]!.messages.find(
            (message) => message.tool_call_id === id,
          )!;
          assert.equal(result.status, 'success');
          const completed = JSON.parse(result.content).tasks[0];
          assert.equal(completed.state, 'succeeded', JSON.stringify(completed));
        }
        assert.equal(
          model.requests[3]!.messages.find(
            (message) => message.tool_call_id === 'write-in-plan',
          )!.status,
          'error',
        );
        assert.equal(service.getTask('plan-blocked'), undefined);
        assert.deepEqual(await readFile(join(workspace, 'README.md')), before);
        assert.deepEqual(
          await readFile(join(workspace, '.git', 'index')),
          index,
        );
        assert.deepEqual((await readdir(workspace)).sort(), [
          '.git',
          'README.md',
        ]);
        for (const tree of childWorktrees) {
          await assert.rejects(access(join(tree, 'plan.md')));
          await assert.rejects(access(join(tree, 'forbidden.txt')));
          assert.equal(
            (
              await exec('git', ['-C', tree, 'status', '--porcelain'], {
                env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
              })
            ).stdout,
            '',
          );
        }
        for (const child of childModels.values()) {
          assert.ok(
            child.requests[0]!.tools.every(
              (tool) =>
                tool.effect === 'read' &&
                (!tool.name.startsWith('native_tasks_') ||
                  tool.name === 'native_tasks_propose') &&
                tool.name !== 'task',
            ),
          );
          const results = child.requests[1]!.messages;
          assert.equal(
            results.find((message) => message.tool_call_id === 'read')!.status,
            'success',
          );
          for (const id of ['write', 'execute', 'escape'])
            assert.equal(
              results.find((message) => message.tool_call_id === id)!.status,
              'error',
            );
        }
        assert.equal(runtime.harness.planMode, true);
      } finally {
        await runtime.close();
      }
    },
    ({ home }) => ({
      autoStart: true,
      createRuntime: async (task, context) => {
        const childHome = join(home, task.spec.id);
        await mkdir(childHome, { recursive: true });
        childWorktrees.push(context.worktree);
        const child = new ScriptedModel([
          async () => {
            entered++;
            if (entered === 2) release();
            await Promise.race([
              parallel,
              delay(8000, undefined, { ref: false }).then(() => {
                throw Error('read-only analyses did not run concurrently');
              }),
            ]);
            return {
              message: assistant('', [
                {
                  id: 'read',
                  name: 'read_file',
                  args: { file_path: 'README.md' },
                },
                {
                  id: 'write',
                  name: 'write_file',
                  args: { file_path: 'plan.md', content: 'forbidden' },
                },
                {
                  id: 'execute',
                  name: 'execute',
                  args: { command: 'touch forbidden.txt' },
                },
                {
                  id: 'escape',
                  name: 'native_tasks_enqueue',
                  args: { operationId: 'child-escape', tasks },
                },
              ]),
              usage: emptyUsage(),
            };
          },
          { message: assistant('README inspected without project changes') },
        ]);
        childModels.set(task.spec.id, child);
        const runtime = new AgentRuntime({
          workspace: context.worktree,
          home: childHome,
          userHome: childHome,
          settings: trustFolder(defaultSettings(), context.worktree),
          model: child,
          headless: true,
          bundledExtensions: false,
          approve: async () => 'approve',
        });
        runtime.setMode('auto');
        return runtime;
      },
      verify: async (task, context) => {
        assert.equal(
          await readFile(join(context.worktree, 'README.md'), 'utf8'),
          '# fixture\n',
        );
        assert.deepEqual(context.changes.paths, []);
        return [
          {
            criterion: task.spec.acceptanceCriteria[0]!,
            status: 'passed',
            source: 'inspection',
            evidence:
              'README bytes equal baseline; no changed paths or forbidden files',
          },
        ];
      },
    }),
  );
});

test('analysis tool rejects write and authority expansion before calling the trusted service', async () => {
  let calls = 0;
  const tools = createCollaborationTools({
    sessionId: 'parent',
    service: () => ({
      call: async () => {
        calls++;
        return [];
      },
    }),
  });
  const analyze = tools.find((tool) => tool.name === 'native_tasks_analyze')!;
  assert.equal(analyze.effect, 'read');
  assert.equal(analyze.subagents, false);
  assert.equal(
    tools.find((tool) => tool.name === 'native_tasks_enqueue')!.effect,
    'execute',
  );
  const task = {
    id: 'analysis',
    prompt: 'Read source',
    acceptanceCriteria: ['source reviewed'],
  };
  const context = { sessionId: 'parent', signal: new AbortController().signal };
  for (const override of [
    { access: 'write' },
    { resource: 'build' },
    { resource: 'browser' },
    { resource: 'ui' },
    { workspace: '/tmp/elsewhere' },
    { sessionId: 'foreign' },
    { allowedResources: ['write'] },
    { executor: 'arbitrary' },
    { tools: ['execute'] },
    { permissions: 'auto' },
    { planMode: false },
  ])
    await assert.rejects(
      analyze.run(
        { operationId: 'reject', tasks: [{ ...task, ...override }] },
        context,
      ),
    );
  await assert.rejects(
    analyze.run(
      { operationId: 'reject', tasks: [task], limits: { agents: 32 } },
      context,
    ),
  );
  await assert.rejects(
    analyze.run(
      { operationId: 'foreign', tasks: [task] },
      { ...context, sessionId: 'foreign' },
    ),
    /another parent/,
  );
  assert.equal(calls, 0);
});
