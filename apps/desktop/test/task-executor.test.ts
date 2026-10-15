import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  access,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AgentRuntime } from '../../../src/runtime.js';
import { defaultSettings, trustFolder } from '../../../src/settings.js';
import { ScriptedModel } from '../../../src/testing.js';
import type { Message } from '../../../src/types.js';
import {
  CollaborationScheduler,
  type TaskSpec,
  type TaskRecord,
} from '../src/workspace/collaboration.js';
import {
  createAgentTaskExecutor,
  captureTaskChanges,
} from '../src/workspace/task-executor.js';
import { TaskIntegrator } from '../src/workspace/task-merge.js';
import { cleanup, scratch } from '../../../tests/helpers.js';
const exec = promisify(execFile);
async function git(path: string, ...args: string[]): Promise<string> {
  return (
    await exec('git', ['-C', path, ...args], { encoding: 'utf8' })
  ).stdout.trim();
}
async function repository(path: string): Promise<string> {
  await git(path, 'init', '--initial-branch=main');
  await git(path, 'config', 'core.autocrlf', 'false');
  await writeFile(join(path, 'value.txt'), 'base\n');
  await git(path, 'add', 'value.txt');
  await git(
    path,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Create fixture',
  );
  return git(path, 'rev-parse', 'HEAD');
}
function spec(
  id: string,
  workspace: string,
  changes: Partial<TaskSpec> = {},
): TaskSpec {
  return {
    id,
    workspace,
    access: 'write',
    prompt: `Implement ${id}`,
    acceptanceCriteria: ['output verified'],
    ...changes,
  };
}
function assistant(
  content: string,
  tool_calls?: Message['tool_calls'],
): Message {
  return {
    id: randomUUID(),
    role: 'assistant',
    content,
    ...(tool_calls ? { tool_calls } : {}),
  };
}
async function until(
  condition: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await condition()) return;
    await delay(10);
  }
  assert.fail('fixture did not settle');
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function runtimeFactory(
  home: string,
  model: ScriptedModel,
  options: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {},
) {
  return async (_task: TaskRecord, context: { worktree: string }) => {
    await mkdir(home, { recursive: true });
    return new AgentRuntime({
      workspace: context.worktree,
      home,
      userHome: home,
      model,
      settings: trustFolder(defaultSettings(), context.worktree),
      bundledExtensions: false,
      screenshot: false,
      headless: true,
      ...options,
    });
  };
}

test('real AgentRuntime writes file; independent command verification creates accepted patch and durable artifacts', async (t) => {
  const repo = scratch(t),
    data = scratch(t),
    home = scratch(t);
  await repository(repo);
  await writeFile(join(repo, 'value.txt'), 'human dirty');
  const model = new ScriptedModel([
    {
      message: assistant('', [
        {
          id: 'write',
          name: 'write_file',
          args: { file_path: 'new.txt', content: 'real output' },
        },
      ]),
    },
    { message: assistant('Done and tests pass') },
  ]);
  let runtime!: AgentRuntime;
  const executor = createAgentTaskExecutor({
    createRuntime: async (task, ctx) => {
      runtime = await runtimeFactory(home, model, {
        approve: async () => 'approve',
      })(task, ctx);
      return runtime;
    },
    verify: async (_task, ctx) => {
      const command = 'node assertion for new.txt';
      const result = await exec(
        process.execPath,
        [
          '-e',
          'require("node:assert/strict").equal(require("node:fs").readFileSync("new.txt","utf8"),"real output")',
        ],
        { cwd: ctx.worktree },
      );
      const path = join(ctx.artifactDirectory, 'test.log');
      await writeFile(path, result.stdout + 'exit=0\n');
      return [
        {
          criterion: 'output verified',
          status: 'passed',
          source: 'command',
          command,
          exitCode: 0,
          evidence: 'Node assertion exited successfully',
          artifactPaths: [path],
        },
      ];
    },
  });
  const scheduler = new CollaborationScheduler({ dataDir: data, executor });
  cleanup(t, () => scheduler.close());
  await scheduler.enqueue([spec('writer', repo)], { operationId: 'write' });
  scheduler.start();
  await scheduler.waitForIdle();
  assert.equal(scheduler.get('writer')!.state, 'succeeded');
  assert.ok(runtime.isClosing);
  assert.equal(await readFile(join(repo, 'value.txt'), 'utf8'), 'human dirty');
  const record = scheduler.get('writer')!;
  const report = record.result as {
    verdict: string;
    changes: { paths: string[]; patchPath: string };
  };
  assert.equal(report.verdict, 'passed');
  assert.deepEqual(report.changes.paths, ['new.txt']);
  assert.match(await readFile(report.changes.patchPath, 'utf8'), /real output/);
  assert.deepEqual(
    scheduler.artifacts('writer').map((artifact) => artifact.kind),
    [
      'task-patch',
      'acceptance',
      'transcript',
      'runtime-events',
      'verification',
    ],
  );
  assert.ok(
    scheduler.eventsAfter().some((event) => event.type === 'task.waiting'),
  );
  assert.ok(
    model.requests[0]!.messages[0]!.content.includes('output verified'),
  );
});

test('model completion claim has needs_review verdict and blocks dependent tasks', async (t) => {
  const repo = scratch(t),
    data = scratch(t),
    home = scratch(t);
  await repository(repo);
  const model = new ScriptedModel([
    { message: assistant('All criteria pass. Ship it.') },
  ]);
  const scheduler = new CollaborationScheduler({
    dataDir: data,
    executor: createAgentTaskExecutor({
      createRuntime: runtimeFactory(home, model),
    }),
  });
  cleanup(t, () => scheduler.close());
  await scheduler.enqueue(
    [spec('claim', repo), spec('later', repo, { dependencies: ['claim'] })],
    { operationId: 'claim' },
  );
  scheduler.start();
  await scheduler.waitForIdle();
  assert.equal(scheduler.get('claim')!.state, 'needs_review');
  assert.equal(scheduler.get('later')!.state, 'blocked');
  assert.equal(
    (scheduler.get('claim')!.result as { verdict: string }).verdict,
    'needs_review',
  );
  assert.equal(model.requests.length, 1);
});

test('readonly task cannot write even plan.md, execute, leave plan mode or expand through children', async (t) => {
  const repo = scratch(t),
    data = scratch(t),
    home = scratch(t);
  await repository(repo);
  const calls = [
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
      id: 'child',
      name: 'task',
      args: {
        prompt: 'write forbidden.txt',
        subagent_type: 'general-purpose',
        description: 'escape',
      },
    },
    { id: 'exit', name: 'plan_exit', args: {} },
  ];
  const model = new ScriptedModel([
    { message: assistant('', calls) },
    { message: assistant('Inspected') },
  ]);
  let runtime!: AgentRuntime;
  const scheduler = new CollaborationScheduler({
    dataDir: data,
    executor: createAgentTaskExecutor({
      createRuntime: async (task, ctx) => {
        runtime = await runtimeFactory(home, model, {
          approve: async () => 'approve',
        })(task, ctx);
        runtime.setMode('auto');
        return runtime;
      },
      verify: async (_task, ctx) => {
        await assert.rejects(access(join(ctx.worktree, 'plan.md')));
        await assert.rejects(access(join(ctx.worktree, 'forbidden.txt')));
        return [
          {
            criterion: 'output verified',
            status: 'passed',
            source: 'inspection',
            evidence: 'worktree bytes remain baseline',
          },
        ];
      },
    }),
  });
  cleanup(t, () => scheduler.close());
  await scheduler.enqueue([spec('review', repo, { access: 'readonly' })], {
    operationId: 'readonly',
  });
  scheduler.start();
  await scheduler.waitForIdle();
  assert.equal(scheduler.get('review')!.state, 'succeeded');
  assert.equal(runtime.harness.planMode, true);
  for (const request of model.requests)
    assert.ok(
      request.tools.every(
        (tool) =>
          tool.effect === 'read' &&
          !['task', 'plan_exit', 'skill', 'execute', 'write_file'].includes(
            tool.name,
          ),
      ),
    );
  const transcript = await readFile(
    scheduler
      .artifacts('review')
      .find((artifact) => artifact.kind === 'transcript')!.path,
    'utf8',
  );
  assert.equal(
    (JSON.parse(transcript) as Message[]).filter(
      (message) => message.role === 'tool' && message.status === 'error',
    ).length,
    4,
  );
});

test('actual approval waits in task state; cancel cleans the owned real process while leaving foreign process alive', async (t) => {
  const repo = scratch(t),
    data = scratch(t),
    home = scratch(t);
  await repository(repo);
  const permission = gate();
  let approveReached = false;
  const code =
    'require("node:fs").writeFileSync("pid.txt",String(process.pid));setInterval(()=>{},1000)';
  const script = join(data, 'owned-process.cjs');
  await writeFile(script, code);
  // Run the same actual program through cmd.exe and POSIX shells without inline
  // JavaScript quoting changing its bytes or turning an executable into a string.
  const command = `"${process.execPath}" "${script}"`;
  const model = new ScriptedModel([
    {
      message: assistant('', [
        { id: 'run', name: 'execute', args: { command, timeout: 120 } },
      ]),
    },
  ]);
  let runtime!: AgentRuntime;
  const scheduler = new CollaborationScheduler({
    dataDir: data,
    executor: createAgentTaskExecutor({
      createRuntime: async (task, ctx) => {
        runtime = await runtimeFactory(home, model, {
          approve: async () => {
            approveReached = true;
            await permission.promise;
            return 'approve';
          },
        })(task, ctx);
        return runtime;
      },
    }),
  });
  cleanup(t, () => scheduler.close());
  const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
  });
  cleanup(t, async () => {
    const exit = once(foreign, 'exit');
    foreign.kill();
    await exit;
  });
  await scheduler.enqueue([spec('process', repo)], { operationId: 'process' });
  scheduler.start();
  await until(() => approveReached);
  assert.equal(scheduler.get('process')!.state, 'waiting');
  permission.resolve();
  await until(async () => {
    const worktree = scheduler.get('process')?.worktree;
    if (!worktree) return false;
    try {
      await access(join(worktree, 'pid.txt'));
      return true;
    } catch {
      return false;
    }
  });
  const pid = Number(
    await readFile(
      join(scheduler.get('process')!.worktree!, 'pid.txt'),
      'utf8',
    ),
  );
  assert.equal(scheduler.get('process')!.state, 'running');
  await scheduler.cancel('process');
  assert.equal(scheduler.get('process')!.state, 'cancelled');
  assert.ok(runtime.isClosing);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  assert.doesNotThrow(() => process.kill(foreign.pid!, 0));
});

test('alternate-index capture includes deleted/new/binary files and preserves task staging', async (t) => {
  const repo = scratch(t),
    directory = scratch(t);
  const baseline = await repository(repo);
  await writeFile(join(repo, 'staged.txt'), 'staged');
  await git(repo, 'add', 'staged.txt');
  const index = await git(repo, 'diff', '--cached');
  await unlink(join(repo, 'value.txt'));
  await writeFile(join(repo, 'new.bin'), Buffer.from([0, 255, 1, 2, 0]));
  const task: TaskRecord = {
    spec: { ...spec('patch', repo), baseline, dependencies: [] },
    state: 'running',
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const snapshot = await captureTaskChanges(task, repo, directory);
  assert.deepEqual(snapshot.paths, ['new.bin', 'staged.txt', 'value.txt']);
  assert.equal(await git(repo, 'diff', '--cached'), index);
  const patch = await readFile(snapshot.patchPath, 'utf8');
  assert.match(patch, /GIT binary patch/);
  assert.match(patch, /deleted file mode/);
});

async function acceptedTasks(
  repo: string,
  data: string,
  t: Parameters<typeof scratch>[0],
  targets: [string, string, string][],
): Promise<TaskRecord[]> {
  const scheduler = new CollaborationScheduler({
    dataDir: data,
    executor: createAgentTaskExecutor({
      createRuntime: async (task, ctx) => {
        const target = targets.find(([id]) => id === task.spec.id)!;
        const model = new ScriptedModel([
          {
            message: assistant('', [
              {
                id: 'write',
                name: 'write_file',
                args: { file_path: target[1], content: target[2] },
              },
            ]),
          },
          { message: assistant('implemented') },
        ]);
        return runtimeFactory(join(data, 'homes', task.spec.id), model, {
          approve: async () => 'approve',
        })(task, ctx);
      },
      verify: async (task, ctx) => {
        const target = targets.find(([id]) => id === task.spec.id)!;
        assert.equal(
          await readFile(join(ctx.worktree, target[1]), 'utf8'),
          target[2],
        );
        return [
          {
            criterion: 'output verified',
            status: 'passed',
            source: 'inspection',
            evidence: 'fixture assertion compared actual disk output',
          },
        ];
      },
    }),
  });
  cleanup(t, () => scheduler.close());
  await scheduler.enqueue(
    targets.map(([id]) => spec(id, repo)),
    { operationId: randomUUID() },
  );
  scheduler.start();
  await scheduler.waitForIdle();
  assert.ok(scheduler.list().every((task) => task.state === 'succeeded'));
  return scheduler.list();
}

test('accepted task patches merge in owned worktree, repeat idempotently and preserve dirty source/index', async (t) => {
  const repo = scratch(t),
    data = scratch(t);
  const baseline = await repository(repo);
  const tasks = await acceptedTasks(repo, data, t, [
    ['a', 'a.txt', 'a'],
    ['b', 'b.txt', 'b'],
  ]);
  await writeFile(join(repo, 'human.txt'), 'human');
  await git(repo, 'add', 'human.txt');
  await writeFile(join(repo, 'value.txt'), 'dirty source');
  const staged = await git(repo, 'diff', '--cached');
  const integrator = new TaskIntegrator({
    workspace: repo,
    dataDir: data,
    identity: { name: 'Fixture', email: 'fixture@example.invalid' },
  });
  const workspace = await integrator.create(baseline);
  tasks[1]!.spec.dependencies = ['a'];
  const result = await integrator.mergeCandidates(
    workspace.id,
    [...tasks].reverse(),
    {
      expectedHead: baseline,
    },
  );
  assert.equal(result.status, 'merged');
  assert.equal(result.workspace.merged.length, 2);
  assert.deepEqual(
    result.workspace.merged.map((entry) => entry.taskId),
    ['a', 'b'],
  );
  assert.notEqual(result.head, baseline);
  assert.equal(await readFile(join(workspace.path, 'a.txt'), 'utf8'), 'a');
  assert.equal(await readFile(join(workspace.path, 'b.txt'), 'utf8'), 'b');
  const again = await integrator.mergeCandidates(workspace.id, tasks, {
    expectedHead: result.head,
  });
  assert.equal(again.head, result.head);
  assert.equal(again.workspace.merged.length, 2);
  assert.equal(await readFile(join(repo, 'value.txt'), 'utf8'), 'dirty source');
  assert.equal(await git(repo, 'diff', '--cached'), staged);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), baseline);
  const changed = await integrator.mergeCandidates(workspace.id, tasks, {
    expectedHead: baseline,
  });
  assert.equal(changed.status, 'baseline_changed');
});

test('real 3-way conflicts retain integration files and do not mark later task merged', async (t) => {
  const repo = scratch(t),
    data = scratch(t);
  const baseline = await repository(repo);
  const tasks = await acceptedTasks(repo, data, t, [
    ['a', 'value.txt', 'first\n'],
    ['b', 'value.txt', 'second\n'],
  ]);
  const integrator = new TaskIntegrator({
    workspace: repo,
    dataDir: data,
    identity: { name: 'Fixture', email: 'fixture@example.invalid' },
  });
  const workspace = await integrator.create(baseline);
  const result = await integrator.mergeCandidates(workspace.id, tasks, {
    expectedHead: baseline,
  });
  assert.equal(result.status, 'conflict');
  assert.equal(result.taskId, 'b', JSON.stringify(result));
  assert.ok(result.conflicts!.includes('value.txt'));
  assert.equal(result.workspace.merged.length, 1);
  assert.match(
    await readFile(join(workspace.path, 'value.txt'), 'utf8'),
    /<<<<<<<|=======/,
  );
  assert.equal(await readFile(join(repo, 'value.txt'), 'utf8'), 'base\n');
});

test('patch tampering or unaccepted candidate is refused before integration effects', async (t) => {
  const repo = scratch(t),
    data = scratch(t);
  const baseline = await repository(repo);
  const tasks = await acceptedTasks(repo, data, t, [['a', 'a.txt', 'a']]);
  const integrator = new TaskIntegrator({
    workspace: repo,
    dataDir: data,
    identity: { name: 'Fixture', email: 'fixture@example.invalid' },
  });
  const workspace = await integrator.create(baseline);
  let result = await integrator.mergeCandidates(
    workspace.id,
    [{ ...tasks[0]!, state: 'needs_review' }],
    { expectedHead: baseline },
  );
  assert.equal(result.status, 'needs_review');
  const patch = (tasks[0]!.result as { changes: { patchPath: string } }).changes
    .patchPath;
  await writeFile(patch, 'tampered');
  result = await integrator.mergeCandidates(workspace.id, tasks, {
    expectedHead: baseline,
  });
  assert.equal(result.status, 'needs_review');
  assert.match(result.reason!, /changed after acceptance/);
  assert.equal(await git(workspace.path, 'rev-parse', 'HEAD'), baseline);
  await assert.rejects(access(join(workspace.path, 'a.txt')));
});

test('rename capture removes the original path and verification mutations require review', async (t) => {
  const repo = scratch(t),
    data = scratch(t),
    home = scratch(t);
  const baseline = await repository(repo);
  const model = new ScriptedModel([{ message: assistant('Inspected') }]);
  const scheduler = new CollaborationScheduler({
    dataDir: data,
    executor: createAgentTaskExecutor({
      createRuntime: runtimeFactory(home, model),
      verify: async (_task, ctx) => {
        await rename(
          join(ctx.worktree, 'value.txt'),
          join(ctx.worktree, 'renamed.txt'),
        );
        return [
          {
            criterion: 'output verified',
            status: 'passed',
            source: 'inspection',
            evidence: 'before mutation inspection',
          },
        ];
      },
    }),
  });
  cleanup(t, () => scheduler.close());
  await scheduler.enqueue([spec('mutation', repo)], {
    operationId: 'mutation',
  });
  scheduler.start();
  await scheduler.waitForIdle();
  const task = scheduler.get('mutation')!;
  assert.equal(task.state, 'needs_review');
  const report = task.result as {
    changes: { paths: string[]; patchPath: string };
  };
  assert.deepEqual(report.changes.paths, ['renamed.txt', 'value.txt']);
  const integrator = new TaskIntegrator({
    workspace: repo,
    dataDir: data,
    identity: { name: 'Fixture', email: 'fixture@example.invalid' },
  });
  const target = await integrator.create(baseline);
  await git(target.path, 'apply', report.changes.patchPath);
  await assert.rejects(access(join(target.path, 'value.txt')));
  assert.equal(
    await readFile(join(target.path, 'renamed.txt'), 'utf8'),
    'base\n',
  );
});

test('integration applies verified bytes from stdin and prevents concurrent staging from entering its commit', async (t) => {
  const repo = scratch(t),
    data = scratch(t),
    shim = scratch(t);
  const baseline = await repository(repo);
  const tasks = await acceptedTasks(repo, data, t, [
    ['a', 'a.txt', 'verified'],
  ]);
  const integrator = new TaskIntegrator({
    workspace: repo,
    dataDir: data,
    identity: { name: 'Fixture', email: 'fixture@example.invalid' },
  });
  const workspace = await integrator.create(baseline);
  const patchPath = (tasks[0]!.result as { changes: { patchPath: string } })
    .changes.patchPath;
  const stageResult = join(data, 'concurrent-stage.txt');
  // A fresh Node child installs its interception before loading the real merger.
  // This preserves actual Git processes/stdin/index locks on Windows and POSIX,
  // without executable shebangs, global PATH changes or production test hooks.
  const script = `
import cp from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const original=cp.spawn;
cp.spawn=function(file,args,options){
 if(file==='git'&&args.includes('apply')){
  fs.writeFileSync(${JSON.stringify(patchPath)},'tampered after hash');
  fs.writeFileSync(${JSON.stringify(join(workspace.path, 'unrelated.txt'))},'human concurrent file');
  const env={...process.env};delete env.GIT_INDEX_FILE;
  const stage=cp.spawnSync('git',['-C',${JSON.stringify(workspace.path)},'add','--','unrelated.txt'],{encoding:'utf8',env});
  fs.writeFileSync(${JSON.stringify(stageResult)},String(stage.status));
 }
 return original.call(this,file,args,options);
};
syncBuiltinESMExports();
const {TaskIntegrator}=await import(${JSON.stringify(new URL('../src/workspace/task-merge.ts', import.meta.url).href)});
const integrator=new TaskIntegrator(${JSON.stringify({ workspace: repo, dataDir: data, identity: { name: 'Fixture', email: 'fixture@example.invalid' } })});
const result=await integrator.mergeCandidates(${JSON.stringify(workspace.id)},${JSON.stringify(tasks)},{expectedHead:${JSON.stringify(baseline)}});
process.stdout.write(JSON.stringify(result));
`;
  const childFile = join(shim, 'merge-race.mjs');
  await writeFile(childFile, script);
  const child = await exec(
    process.execPath,
    [
      '--import',
      new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url)
        .href,
      childFile,
    ],
    { encoding: 'utf8' },
  );
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, 'merged', result.reason);
  assert.equal(
    await readFile(join(workspace.path, 'a.txt'), 'utf8'),
    'verified',
  );
  assert.equal(await readFile(patchPath, 'utf8'), 'tampered after hash');
  assert.notEqual(await readFile(stageResult, 'utf8'), '0');
  await assert.rejects(git(workspace.path, 'show', 'HEAD:unrelated.txt'));
  assert.equal(
    await readFile(join(workspace.path, 'unrelated.txt'), 'utf8'),
    'human concurrent file',
  );
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), baseline);
});

test('task runtime cannot inherit parent-only native task tools through a mistaken factory', async (t) => {
  const repo = scratch(t),
    data = scratch(t),
    home = scratch(t);
  await repository(repo);
  let expanded = 0;
  const model = new ScriptedModel([
    {
      message: assistant('', [
        { id: 'escape', name: 'native_tasks_enqueue', args: {} },
      ]),
    },
    { message: assistant('finished') },
  ]);
  const scheduler = new CollaborationScheduler({
    dataDir: data,
    executor: createAgentTaskExecutor({
      createRuntime: runtimeFactory(home, model, {
        approve: async () => 'approve',
        extraTools: [
          {
            name: 'native_tasks_enqueue',
            effect: 'execute',
            subagents: false,
            description: 'parent only',
            parameters: { type: 'object', properties: {} },
            run: async () => {
              expanded++;
              return 'unexpected';
            },
          },
        ],
      }),
    }),
  });
  cleanup(t, () => scheduler.close());
  await scheduler.enqueue([spec('child', repo)], { operationId: 'recursive' });
  scheduler.start();
  await scheduler.waitForIdle();
  assert.equal(expanded, 0);
  assert.ok(
    model.requests.every(
      (request) =>
        !request.tools.some((tool) => tool.name.startsWith('native_tasks_')),
    ),
  );
});
