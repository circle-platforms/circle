import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRuntime } from '../../../src/runtime';
import { ScriptedModel } from '../../../src/testing';
import { emptyUsage, type Message } from '../../../src/types';
import { defaultSettings, trustFolder } from '../../../src/settings';
import { scratch, cleanup } from '../../../tests/helpers';
import { TaskService } from '../src/workspace/task-service';
import { createTaskVerifier } from '../src/workspace/task-verification';
import type { TaskRecord } from '../src/workspace/task-store';
import type { TaskVerificationContext } from '../src/workspace/task-executor';
const response = (content: string): Message => ({
  id: randomUUID(),
  role: 'assistant',
  content,
});
async function until(check: () => boolean | Promise<boolean>) {
  const until = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > until) throw Error('reviewer lifecycle fixture timed out');
    await delay(10);
  }
}
async function fixture(
  t: TestContext,
  reviewFactory: (
    task: TaskRecord,
    context: TaskVerificationContext,
    roots: { home: string; dataDir: string },
    worker: AgentRuntime,
  ) => Promise<AgentRuntime> | AgentRuntime,
  bindFailure = false,
) {
  const workspace = scratch(t),
    home = scratch(t),
    dataDir = scratch(t);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', workspace, ...args], {
      encoding: 'utf8',
    }).trim();
  git('init', '-q');
  git('config', '--local', 'core.autocrlf', 'false');
  await writeFile(join(workspace, 'value.txt'), 'baseline\n');
  git('add', 'value.txt');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Create fixture',
  );
  let worker!: AgentRuntime;
  const workerModel = new ScriptedModel([
    { message: response('worker finished') },
  ]);
  const verifier = createTaskVerifier({
    workspace,
    dataDir: join(dataDir, 'verification'),
    createReviewer: (task, context) =>
      reviewFactory(task, context, { home, dataDir }, worker),
  });
  const service = new TaskService({
    workspace,
    dataDir,
    emit() {},
    createRuntime(_task, context) {
      worker = new AgentRuntime({
        workspace: context.worktree,
        home,
        userHome: home,
        model: workerModel,
        settings: trustFolder(defaultSettings(), context.worktree),
        bundledExtensions: false,
        headless: true,
        screenshot: false,
      });
      return worker;
    },
    verify: (task, context) =>
      verifier(
        task,
        bindFailure
          ? {
              ...context,
              reviewer() {
                throw Error('injected durable reviewer binding failure');
              },
            }
          : context,
      ),
  });
  cleanup(t, () => service.close());
  await service.call('parent', 'enqueue', {
    operationId: 'case',
    tasks: [
      {
        id: 'case',
        prompt: 'Inspect baseline',
        access: 'write',
        acceptanceCriteria: ['review source'],
      },
    ],
  });
  return {
    service,
    workspace,
    home,
    dataDir,
    workerModel,
    get worker() {
      return worker;
    },
  };
}
for (const failure of [
  'foreign-workspace',
  'existing-history',
  'worker-identity',
  'bind-failure',
] as const) {
  test(`invalid reviewer ${failure} closes the returned runtime and never begins a review request`, async (t) => {
    let reviewer!: AgentRuntime;
    const reviewModel = new ScriptedModel([
      { message: response('existing answer') },
    ]);
    const f = await fixture(
      t,
      async (_task, context, { home }, worker) => {
        if (failure === 'worker-identity') {
          reviewer = worker;
          return worker;
        }
        const workspace =
          failure === 'foreign-workspace' ? scratch(t) : context.worktree;
        reviewer = new AgentRuntime({
          workspace,
          home,
          userHome: home,
          model: reviewModel,
          settings: trustFolder(defaultSettings(), workspace),
          bundledExtensions: false,
          headless: true,
          screenshot: false,
        });
        if (failure === 'existing-history')
          await reviewer.harness.run('previous unrelated conversation');
        return reviewer;
      },
      failure === 'bind-failure',
    );
    await until(() =>
      ['needs_review', 'failed', 'interrupted'].includes(
        f.service.getTask('case')!.state,
      ),
    );
    assert.equal(f.service.getTask('case')!.state, 'needs_review');
    assert.equal(reviewer.isClosing, true);
    assert.equal(f.service.getTask('case')!.reviewers, undefined);
    assert.equal(
      reviewModel.requests.length,
      failure === 'existing-history' ? 1 : 0,
    );
    assert.equal(f.workerModel.requests.length, 1);
    assert.equal(
      await readFile(join(f.workspace, 'value.txt'), 'utf8'),
      'baseline\n',
    );
  });
}
test('cancelling a pending reviewer awaits its real owned process cleanup and preserves a foreign process', async (t) => {
  let reviewer!: AgentRuntime;
  let entered = false;
  const reviewModel = new ScriptedModel([
    async (request) => {
      const script = join(reviewer.options.home, 'owned-review-process.cjs');
      await writeFile(
        script,
        'require("node:fs").writeFileSync("review-pid.txt",String(process.pid));setInterval(()=>{},1000)',
      );
      reviewer.jobs.startShell(`"${process.execPath}" "${script}"`, {
        sessionId: reviewer.session.id,
        startedBy: 'user',
      });
      entered = true;
      return await new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        );
      });
    },
  ]);
  const f = await fixture(t, (_task, context, { home }) => {
    reviewer = new AgentRuntime({
      workspace: context.worktree,
      home,
      userHome: home,
      model: reviewModel,
      settings: trustFolder(defaultSettings(), context.worktree),
      bundledExtensions: false,
      headless: true,
      screenshot: false,
    });
    return reviewer;
  });
  const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
  });
  await once(foreign, 'spawn');
  cleanup(t, async () => {
    if (foreign.exitCode === null && foreign.signalCode === null) {
      const exited = once(foreign, 'exit');
      foreign.kill();
      await exited;
    }
  });
  await until(async () => {
    if (!entered) return false;
    try {
      return !!(await readFile(
        join(reviewer.options.workspace, 'review-pid.txt'),
        'utf8',
      ));
    } catch {
      return false;
    }
  });
  const pid = Number(
    await readFile(join(reviewer.options.workspace, 'review-pid.txt'), 'utf8'),
  );
  assert.equal(f.service.getTask('case')!.runtimeState, 'succeeded');
  assert.equal(f.service.getTask('case')!.reviewers![0]!.state, 'running');
  await f.service.call('parent', 'cancel', { id: 'case' });
  assert.equal(f.service.getTask('case')!.state, 'cancelled');
  assert.equal(f.service.getTask('case')!.reviewers![0]!.state, 'cancelled');
  assert.equal(reviewer.isClosing, true);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  assert.doesNotThrow(() => process.kill(foreign.pid!, 0));
  assert.equal(reviewModel.requests.length, 1);
  assert.equal(f.workerModel.requests.length, 1);
  assert.equal(f.service.hasActiveSession('parent'), false);
});
test('reviewer close failure remains nonterminal, prevents retry, and only settles after actual close succeeds', async (t) => {
  let reviewer!: AgentRuntime, restore!: () => Promise<void>;
  let fail = true;
  const reviewModel = new ScriptedModel([
    { message: response('{"checks":[]}') },
  ]);
  const f = await fixture(t, (_task, context, { home }) => {
    reviewer = new AgentRuntime({
      workspace: context.worktree,
      home,
      userHome: home,
      model: reviewModel,
      settings: trustFolder(defaultSettings(), context.worktree),
      bundledExtensions: false,
      headless: true,
      screenshot: false,
    });
    restore = reviewer.close.bind(reviewer);
    reviewer.close = async () => {
      if (fail) throw Error('injected reviewer close failure');
      await restore();
    };
    return reviewer;
  });
  cleanup(t, async () => {
    fail = false;
    await restore();
  });
  await until(() => f.service.getTask('case')!.state === 'interrupted');
  const record = f.service.getTask('case')!;
  assert.match(record.reason!, /cleanup failed/);
  assert.equal(record.runtimeState, 'succeeded');
  assert.equal(record.reviewers![0]!.state, 'cancelling');
  assert.match(record.reviewers![0]!.reason!, /cleanup failed/);
  assert.equal(reviewer.isClosing, false);
  await assert.rejects(
    f.service.call('parent', 'retry', { id: 'case', operationId: 'blocked' }),
    /finish task cleanup/,
  );
  assert.equal(reviewModel.requests.length, 1);
  fail = false;
  await f.service.call('parent', 'cancel', { id: 'case' });
  assert.equal(reviewer.isClosing, true);
  assert.equal(f.service.getTask('case')!.reviewers![0]!.state, 'needs_review');
  assert.equal(f.service.hasActiveSession('parent'), false);
  assert.equal(reviewModel.requests.length, 1);
});
