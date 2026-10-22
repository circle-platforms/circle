import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  CollaborationScheduler,
  DEFAULT_COLLABORATION_LIMITS,
  OperationNeedsReviewError,
  type CollaborationEvent,
  type Json,
  type TaskArtifact,
  type TaskSendBack,
  type TaskSpec,
  type TaskExecutor,
} from '../src/workspace/collaboration.js';
import { cleanup, scratch } from '../../../tests/helpers.js';
const exec = promisify(execFile);
async function git(path: string, ...args: string[]): Promise<string> {
  return (
    await exec('git', ['-C', path, ...args], { encoding: 'utf8' })
  ).stdout.trim();
}
async function repository(path: string): Promise<string> {
  await git(path, 'init', '--initial-branch=main');
  // Fixture bytes must not depend on the developer/CI machine's checkout policy.
  await git(path, 'config', '--local', 'core.autocrlf', 'false');
  await writeFile(join(path, 'same.txt'), 'baseline\n');
  await git(path, 'add', 'same.txt');
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
  fields: Partial<TaskSpec> = {},
): TaskSpec {
  return {
    id,
    workspace,
    prompt: `Execute ${id}`,
    access: 'write',
    acceptanceCriteria: ['fixture verified'],
    ...fields,
  };
}
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (condition()) return;
    await delay(10);
  }
  assert.fail('condition did not settle');
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('two write tasks isolate same-named files; readonly review pins baseline and ignores dirty source', async (t) => {
  const repo = scratch(t),
    data = scratch(t);
  const baseline = await repository(repo);
  await writeFile(join(repo, 'same.txt'), 'human uncommitted\n');
  await writeFile(join(repo, 'private.txt'), 'must not copy');
  const release = gate(),
    entered: string[] = [];
  const scheduler = new CollaborationScheduler({
    dataDir: data,
    executor: async (task, context) => {
      entered.push(task.spec.id);
      assert.equal(await git(context.worktree, 'rev-parse', 'HEAD'), baseline);
      assert.equal(
        await readFile(join(context.worktree, 'same.txt'), 'utf8'),
        'baseline\n',
      );
      await assert.rejects(access(join(context.worktree, 'private.txt')));
      if (context.access === 'write')
        await writeFile(join(context.worktree, 'same.txt'), task.spec.id);
      await release.promise;
      return {
        passed: true,
        result: { baseline },
        artifacts: [
          { path: join(context.worktree, 'same.txt'), kind: 'source' },
        ],
      };
    },
  });
  cleanup(t, () => scheduler.close());
  const observed: number[] = [];
  scheduler.subscribe((event) => observed.push(event.cursor));
  await scheduler.enqueue(
    [
      spec('writer-a', repo),
      spec('writer-b', repo),
      spec('review', repo, { access: 'readonly' }),
    ],
    { operationId: 'batch' },
  );
  scheduler.start();
  await until(() => entered.length === 3);
  const records = scheduler.list();
  assert.equal(new Set(records.map((task) => task.worktree)).size, 3);
  assert.ok(
    records.find((task) => task.spec.id === 'review')!.branch === undefined,
  );
  release.resolve();
  await scheduler.waitForIdle();
  assert.deepEqual(
    scheduler.list().map((task) => task.state),
    ['succeeded', 'succeeded', 'succeeded'],
    JSON.stringify(scheduler.list()),
  );
  assert.equal(
    await readFile(join(repo, 'same.txt'), 'utf8'),
    'human uncommitted\n',
  );
  assert.equal(
    await readFile(join(records[0]!.worktree!, 'same.txt'), 'utf8'),
    'writer-a',
  );
  assert.equal(
    await readFile(join(records[1]!.worktree!, 'same.txt'), 'utf8'),
    'writer-b',
  );
  assert.equal(scheduler.artifacts().length, 3);
  assert.equal(scheduler.artifacts()[0]!.sha256.length, 64);
  assert.ok(
    observed.every((cursor, index) => !index || cursor > observed[index - 1]!),
  );
  assert.equal(await scheduler.removeCleanWorktree('writer-a'), false);
  assert.equal(await scheduler.removeCleanWorktree('review'), true);
});

test('atomic DAG validation and enqueue deduplication survive restart without repinning HEAD', async (t) => {
  const repo = scratch(t),
    data = scratch(t);
  const baseline = await repository(repo);
  let calls = 0;
  const executor: TaskExecutor = async () => {
    calls++;
    return { passed: true };
  };
  let scheduler = new CollaborationScheduler({ dataDir: data, executor });
  cleanup(t, () => scheduler.close());
  await assert.rejects(
    scheduler.enqueue(
      [
        spec('a', repo, { dependencies: ['b'] }),
        spec('b', repo, { dependencies: ['a'] }),
      ],
      { operationId: 'cycle' },
    ),
    /cycle/,
  );
  await assert.rejects(
    scheduler.enqueue([spec('a', repo, { dependencies: ['absent'] })], {
      operationId: 'unknown',
    }),
    /unknown dependency/,
  );
  await assert.rejects(
    scheduler.enqueue([spec('self', repo, { parentId: 'self' })], {
      operationId: 'parent-cycle',
    }),
    /parent cycle/,
  );
  assert.equal(scheduler.list().length, 0);
  const inputs = [spec('a', repo), spec('b', repo, { dependencies: ['a'] })];
  await Promise.all([
    scheduler.enqueue(inputs, { operationId: 'once' }),
    scheduler.enqueue(inputs, { operationId: 'once' }),
  ]);
  await assert.rejects(
    scheduler.enqueue([spec('changed', repo)], { operationId: 'once' }),
    /reused/,
  );
  scheduler.start();
  await scheduler.waitForIdle();
  assert.equal(calls, 2);
  const cursor = scheduler.eventsAfter().at(-1)!.cursor;
  await scheduler.close();
  await writeFile(join(repo, 'same.txt'), 'second baseline');
  await git(repo, 'add', 'same.txt');
  await git(
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Change fixture',
  );
  scheduler = new CollaborationScheduler({ dataDir: data, executor });
  const repeated = await scheduler.enqueue(inputs, { operationId: 'once' });
  assert.equal(repeated[0]!.spec.baseline, baseline);
  scheduler.start();
  await scheduler.waitForIdle();
  assert.equal(calls, 2);
  assert.deepEqual(scheduler.eventsAfter(cursor), []);
  assert.throws(() => scheduler.eventsAfter(-1), /invalid event cursor/);
});

test('failed dependency blocks descendants, explicit retry creates a fresh attempt and unblocks the graph', async (t) => {
  const repo = scratch(t),
    data = scratch(t);
  await repository(repo);
  const ran: string[] = [];
  const scheduler = new CollaborationScheduler({
    dataDir: data,
    executor: async (task, context) => {
      if (task.spec.id === 'b') {
        assert.equal(context.dependencies[0]!.task.state, 'succeeded');
        assert.equal(context.dependencies[0]!.task.attempt, 2);
      }
      ran.push(`${task.spec.id}:${task.attempt}`);
      return {
        passed: task.spec.id !== 'a' || task.attempt > 1,
        reason: 'acceptance',
      };
    },
  });
  cleanup(t, () => scheduler.close());
  await scheduler.enqueue(
    [
      spec('a', repo),
      spec('b', repo, { dependencies: ['a'] }),
      spec('c', repo, { dependencies: ['b'] }),
    ],
    { operationId: 'graph' },
  );
  scheduler.start();
  await scheduler.waitForIdle();
  assert.deepEqual(
    scheduler.list().map((task) => task.state),
    ['failed', 'blocked', 'blocked'],
  );
  const previousTree = scheduler.get('a')!.worktree;
  scheduler.retry('a', { operationId: 'retry-a' });
  scheduler.retry('a', { operationId: 'retry-a' });
  await scheduler.waitForIdle();
  assert.deepEqual(ran, ['a:1', 'a:2', 'b:1', 'c:1']);
  assert.notEqual(scheduler.get('a')!.worktree, previousTree);
  assert.equal(scheduler.attempts('a').length, 2);
  assert.equal(scheduler.attempts('a')[0]!.state, 'failed');
  assert.ok(scheduler.list().every((task) => task.state === 'succeeded'));
});

/** A person's send-back of the attempt they were shown, as TaskService records it. */
function sendBack(
  scheduler: CollaborationScheduler,
  data: string,
  id: string,
  decision: TaskSendBack,
) {
  return scheduler.rejectHumanReview(id, {
    decision,
    result: {
      verdict: 'failed',
      review: decision as unknown as Json,
      changes: { sha256: decision.expectedPatchSha256 },
    },
    artifact: {
      id: randomUUID(),
      taskId: id,
      attempt: decision.expectedAttempt,
      baseline: decision.head,
      path: join(data, `${randomUUID()}.json`),
      sha256: '0'.repeat(64),
      kind: 'human-review',
      createdAt: Date.now(),
    } satisfies TaskArtifact,
  });
}

test('sending back an attempt records the decision on it, queues the next attempt with the reason and keeps dependents waiting', async (t) => {
  const repo = scratch(t),
    data = scratch(t);
  const baseline = await repository(repo);
  const patch = (attempt: number) => String(attempt).repeat(64);
  const started = gate(),
    second = gate();
  const ran: string[] = [],
    dependencies = new Map<string, string[]>();
  const scheduler = new CollaborationScheduler({
    dataDir: data,
    executor: async (task, context) => {
      ran.push(`${task.spec.id}:${task.attempt}`);
      dependencies.set(
        task.spec.id,
        context.dependencies.map(
          ({ task: dependency }) =>
            `${dependency.spec.id}:${dependency.attempt}:${dependency.state}`,
        ),
      );
      if (task.spec.id !== 'a') return { passed: true };
      if (task.attempt === 1)
        return {
          passed: false,
          verdict: 'needs_review',
          reason: 'not every acceptance criterion has independent evidence',
          result: { changes: { sha256: patch(1) } },
        };
      started.resolve();
      await second.promise;
      return { passed: true, result: { changes: { sha256: patch(2) } } };
    },
  });
  cleanup(t, () => scheduler.close());
  const events: CollaborationEvent[] = [];
  scheduler.subscribe((event) => events.push(event));
  await scheduler.enqueue(
    [
      spec('a', repo),
      spec('b', repo, { dependencies: ['a'] }),
      spec('c', repo, { dependencies: ['b'] }),
    ],
    { operationId: 'graph' },
  );
  scheduler.start();
  await scheduler.waitForIdle();
  assert.deepEqual(
    scheduler.list().map((task) => task.state),
    ['needs_review', 'blocked', 'blocked'],
  );
  const shownTree = scheduler.get('a')!.worktree!;
  const decision = (fields: Partial<TaskSendBack> = {}): TaskSendBack => ({
    reviewer: 'human',
    decision: 'rejected',
    expectedAttempt: 1,
    expectedPatchSha256: patch(1),
    head: baseline,
    reason: 'the summary must also list the second file',
    at: Date.now(),
    ...fields,
  });
  for (const stale of [
    decision({ expectedAttempt: 2 }),
    decision({ expectedPatchSha256: patch(2) }),
  ])
    assert.throws(() => sendBack(scheduler, data, 'a', stale), /stale/);
  assert.throws(() => sendBack(scheduler, data, 'b', decision()), /stale/);
  assert.equal(scheduler.attempts('a').length, 1);
  assert.equal(scheduler.get('a')!.state, 'needs_review');

  const before = events.length;
  const next = sendBack(scheduler, data, 'a', decision());
  assert.equal(next.attempt, 2);
  assert.equal(next.state, 'queued');
  assert.deepEqual(
    next.sentBack!.map((entry) => [entry.expectedAttempt, entry.reason]),
    [[1, 'the summary must also list the second file']],
  );
  const [shown] = scheduler.attempts('a');
  assert.equal(shown!.state, 'failed');
  assert.equal(shown!.reason, 'a person sent this attempt back');
  assert.equal(shown!.worktree, shownTree);
  assert.equal(
    (shown!.result as unknown as { review: TaskSendBack }).review.decision,
    'rejected',
  );
  // Dependents wait for the new attempt: none is cancelled, none is started.
  assert.deepEqual(
    ['b', 'c'].map((id) => scheduler.get(id)!.state),
    ['queued', 'queued'],
  );
  assert.deepEqual(
    events
      .slice(before, before + 4)
      .map((event) => [
        event.type,
        event.attempt,
        (event.payload as { decision?: string; retryOf?: number }).decision ??
          (event.payload as { retryOf?: number }).retryOf ??
          null,
      ]),
    [
      ['artifact.created', 1, null],
      ['task.reviewed', 1, 'rejected'],
      ['task.failed', 1, null],
      ['task.queued', 2, 1],
    ],
  );
  await started.promise;
  assert.equal(scheduler.get('a')!.state, 'running');
  assert.notEqual(scheduler.get('a')!.worktree, shownTree);
  assert.deepEqual(
    ['b', 'c'].map((id) => scheduler.get(id)!.state),
    ['queued', 'queued'],
  );
  assert.deepEqual(ran, ['a:1', 'a:2']);

  // The same decision again changes nothing; a different one is refused.
  assert.equal(sendBack(scheduler, data, 'a', decision()).attempt, 2);
  assert.throws(
    () => sendBack(scheduler, data, 'a', decision({ reason: 'another' })),
    /different reason/,
  );
  assert.equal(scheduler.attempts('a').length, 2);

  second.resolve();
  await scheduler.waitForIdle();
  assert.deepEqual(ran, ['a:1', 'a:2', 'b:1', 'c:1']);
  assert.deepEqual(dependencies.get('b'), ['a:2:succeeded']);
  assert.ok(scheduler.list().every((task) => task.state === 'succeeded'));
});

test('later attempts keep what people sent back: a retry carries the reasons and another send-back adds to them', async (t) => {
  const repo = scratch(t),
    data = scratch(t);
  const baseline = await repository(repo);
  const patch = (attempt: number) => String(attempt).repeat(64);
  const told = new Map<number, string[]>();
  const scheduler = new CollaborationScheduler({
    dataDir: data,
    executor: async (task) => {
      told.set(
        task.attempt,
        (task.sentBack ?? []).map(
          (entry) => `${entry.expectedAttempt}: ${entry.reason}`,
        ),
      );
      if (task.attempt <= 2)
        return {
          passed: false,
          verdict: 'needs_review',
          result: { changes: { sha256: patch(task.attempt) } },
        };
      return { passed: task.attempt === 4, reason: 'acceptance' };
    },
  });
  cleanup(t, () => scheduler.close());
  await scheduler.enqueue([spec('a', repo)], { operationId: 'one' });
  scheduler.start();
  const decision = (attempt: number, reason: string): TaskSendBack => ({
    reviewer: 'human',
    decision: 'rejected',
    expectedAttempt: attempt,
    expectedPatchSha256: patch(attempt),
    head: baseline,
    reason,
    at: Date.now(),
  });
  await scheduler.waitForIdle();
  sendBack(scheduler, data, 'a', decision(1, 'use the existing parser'));
  await scheduler.waitForIdle();
  assert.equal(scheduler.get('a')!.state, 'needs_review');
  sendBack(scheduler, data, 'a', decision(2, 'keep the old flag working'));
  await scheduler.waitForIdle();
  assert.equal(scheduler.get('a')!.state, 'failed');
  scheduler.retry('a', { operationId: 'after-failure' });
  await scheduler.waitForIdle();
  const both = ['1: use the existing parser', '2: keep the old flag working'];
  assert.deepEqual(Object.fromEntries(told), {
    1: [],
    2: ['1: use the existing parser'],
    3: both,
    4: both,
  });
  assert.deepEqual(
    scheduler.attempts('a').map((attempt) => attempt.state),
    ['failed', 'failed', 'failed', 'succeeded'],
  );
  assert.deepEqual(
    scheduler
      .attempts('a')
      .map(
        (attempt) =>
          (attempt.result as { review?: TaskSendBack } | undefined)?.review
            ?.reason ?? null,
      ),
    ['use the existing parser', 'keep the old flag working', null, null],
  );
});

test('resource queues do not block unrelated work; UI serializes, build defaults to two, agent limits resize', async (t) => {
  const repo = scratch(t),
    data = scratch(t);
  await repository(repo);
  assert.deepEqual(DEFAULT_COLLABORATION_LIMITS, {
    agents: 8,
    builds: 2,
    ui: 1,
    browsers: 1,
  });
  const release = gate(),
    started: string[] = [];
  let ui = 0,
    maxUi = 0,
    builds = 0,
    maxBuilds = 0;
  const scheduler = new CollaborationScheduler({
    dataDir: data,
    executor: async (task) => {
      started.push(task.spec.id);
      if (task.spec.resource === 'ui') {
        ui++;
        maxUi = Math.max(ui, maxUi);
      }
      if (task.spec.resource === 'build') {
        builds++;
        maxBuilds = Math.max(builds, maxBuilds);
      }
      await release.promise;
      if (task.spec.resource === 'ui') ui--;
      if (task.spec.resource === 'build') builds--;
      return { passed: true };
    },
  });
  cleanup(t, () => scheduler.close());
  assert.throws(() => scheduler.setLimits({ agents: 33 }), /invalid agents/);
  assert.throws(() => scheduler.setLimits({ ui: 2 }), /invalid ui/);
  await scheduler.enqueue(
    [
      spec('ui1', repo, { resource: 'ui' }),
      spec('ui2', repo, { resource: 'ui' }),
      spec('b1', repo, { resource: 'build' }),
      spec('b2', repo, { resource: 'build' }),
      spec('b3', repo, { resource: 'build' }),
      spec('independent', repo),
    ],
    { operationId: 'resources' },
  );
  scheduler.start();
  await until(() => started.length === 4);
  assert.ok(started.includes('independent'));
  assert.ok(!started.includes('ui2'));
  assert.ok(!started.includes('b3'));
  release.resolve();
  await scheduler.waitForIdle();
  assert.equal(maxUi, 1);
  assert.equal(maxBuilds, 2);
  scheduler.setLimits({ agents: 1 });
  assert.equal(scheduler.getLimits().agents, 1);
  const copy = scheduler.getLimits();
  copy.agents = 20;
  assert.equal(scheduler.getLimits().agents, 1);
});

test('cancel waits for cleanup, removes resource waiters, leaves successors blocked and other tasks running', async (t) => {
  const repo = scratch(t),
    data = scratch(t);
  await repository(repo);
  const holder = gate(),
    cleanupRelease = gate();
  let waiting = false,
    cleanupStarted = false,
    independent = false;
  const scheduler = new CollaborationScheduler({
    dataDir: data,
    executor: async (task, context) => {
      if (task.spec.id === 'holder')
        return context.withResource('ui', async () => {
          await holder.promise;
          return { passed: true };
        });
      if (task.spec.id === 'waiting') {
        context.onCleanup(async () => {
          cleanupStarted = true;
          await cleanupRelease.promise;
        });
        waiting = true;
        context.waiting('UI lease');
        return context.withResource('ui', async () => {
          assert.fail('cancelled waiter executed');
        });
      }
      if (task.spec.id === 'other') independent = true;
      return { passed: true };
    },
  });
  cleanup(t, () => scheduler.close());
  await scheduler.enqueue(
    [
      spec('holder', repo),
      spec('waiting', repo),
      spec('successor', repo, { dependencies: ['waiting'] }),
      spec('other', repo),
    ],
    { operationId: 'cancel' },
  );
  scheduler.start();
  await until(() => waiting && independent);
  let settled = false;
  const cancellation = scheduler.cancel('waiting').then(() => {
    settled = true;
  });
  await until(() => cleanupStarted);
  assert.equal(settled, false);
  assert.equal(scheduler.get('waiting')!.state, 'cancelling');
  cleanupRelease.resolve();
  await cancellation;
  assert.equal(scheduler.get('waiting')!.state, 'cancelled');
  holder.resolve();
  await scheduler.waitForIdle();
  assert.equal(scheduler.get('successor')!.state, 'blocked');
  assert.equal(scheduler.get('other')!.state, 'succeeded');
});

test('operation IDs coalesce side effects; mismatches and unknown outcomes cannot replay', async (t) => {
  const repo = scratch(t),
    data = scratch(t);
  await repository(repo);
  let effects = 0;
  const scheduler = new CollaborationScheduler({
    dataDir: data,
    executor: async (_task, context) => {
      const work = async () => {
        effects++;
        await delay(5);
        await writeFile(join(context.worktree, 'effect.txt'), 'one');
        return { done: true };
      };
      const results = await Promise.all([
        context.runOperation('write', { file: 'effect.txt' }, work),
        context.runOperation('write', { file: 'effect.txt' }, work),
      ]);
      assert.deepEqual(results, [{ done: true }, { done: true }]);
      await context.runOperation('write', { file: 'effect.txt' }, work);
      assert.equal(effects, 1);
      await assert.rejects(
        context.runOperation('write', { file: 'other' }, work),
        /different input/,
      );
      await assert.rejects(
        context.runOperation('unknown', null, async () => {
          effects++;
          throw new Error('transport lost after side effect');
        }),
        /transport lost/,
      );
      await assert.rejects(
        context.runOperation('unknown', null, work),
        OperationNeedsReviewError,
      );
      return { passed: true };
    },
  });
  cleanup(t, () => scheduler.close());
  await scheduler.enqueue([spec('task', repo)], { operationId: 'effects' });
  scheduler.start();
  await scheduler.waitForIdle();
  // Catching a lost receipt cannot verify the side effect or release successors.
  assert.equal(scheduler.get('task')!.state, 'needs_review');
  assert.equal(effects, 2);
});

test('renderer consumer failure is isolated; lease prevents concurrent owners and queued cancellation never executes', async (t) => {
  const repo = scratch(t),
    data = scratch(t);
  await repository(repo);
  let ran = false;
  const scheduler = new CollaborationScheduler({
    dataDir: data,
    executor: async () => {
      ran = true;
      return { passed: true };
    },
  });
  cleanup(t, () => scheduler.close());
  assert.throws(
    () =>
      new CollaborationScheduler({
        dataDir: data,
        executor: async () => ({ passed: true }),
      }),
    /already open/,
  );
  scheduler.subscribe(() => {
    throw new Error('renderer detached');
  });
  await scheduler.enqueue([spec('never', repo)], {
    operationId: 'cancel-before-start',
  });
  await scheduler.cancel('never');
  scheduler.start();
  await scheduler.waitForIdle();
  assert.equal(ran, false);
  assert.equal(scheduler.get('never')!.worktree, undefined);
});

test('killed scheduler recovers in-flight task and operation as interrupted without replaying effects', async (t) => {
  const repo = scratch(t),
    data = scratch(t);
  await repository(repo);
  const source = new URL('../src/workspace/collaboration.ts', import.meta.url)
    .href;
  const worker = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `
    import { CollaborationScheduler } from ${JSON.stringify(source)};
    import { writeFile } from 'node:fs/promises';
    const scheduler = new CollaborationScheduler({dataDir:${JSON.stringify(data)},executor:async(task,ctx)=>ctx.runOperation('side-effect',null,async()=>{
      await writeFile(${JSON.stringify(join(data, 'effect.txt'))},'once'); process.send({ready:true}); await new Promise(()=>{}); return {passed:true};
    })});
    await scheduler.enqueue([${JSON.stringify(spec('interrupted', repo))},${JSON.stringify(spec('dependent', repo, { dependencies: ['interrupted'] }))}],{operationId:'crash'}); scheduler.start();
  `,
    ],
    {
      env: { ...process.env, CIRCLE_HOME: join(data, 'scratch-home') },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  cleanup(t, async () => {
    if (worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, 'exit');
      worker.kill('SIGKILL');
      await exited;
    }
  });
  let errors = '';
  worker.stderr?.on('data', (chunk) => {
    errors += chunk;
  });
  await Promise.race([
    once(worker, 'message'),
    once(worker, 'exit').then(() => {
      throw new Error(`fixture exited: ${errors}`);
    }),
  ]);
  const exited = once(worker, 'exit');
  worker.kill('SIGKILL');
  await exited;
  let called = false;
  const scheduler = new CollaborationScheduler({
    dataDir: data,
    executor: async () => {
      called = true;
      return { passed: true };
    },
  });
  cleanup(t, () => scheduler.close());
  scheduler.start();
  await scheduler.waitForIdle();
  assert.equal(called, false);
  assert.equal(scheduler.get('interrupted')!.state, 'interrupted');
  assert.equal(scheduler.get('dependent')!.state, 'blocked');
  assert.equal(await readFile(join(data, 'effect.txt'), 'utf8'), 'once');
  const events = scheduler.eventsAfter();
  assert.ok(new Set(events.map((event) => event.epoch)).size === 2);
  assert.ok(events.some((event) => event.type === 'task.interrupted'));
});

test('scheduler awaits operations even when executor returns before its operation settles', async (t) => {
  const repo = scratch(t),
    data = scratch(t);
  await repository(repo);
  const release = gate();
  let started = false,
    cleaned = false;
  const scheduler = new CollaborationScheduler({
    dataDir: data,
    executor: async (_task, context) => {
      context.onCleanup(() => {
        cleaned = true;
      });
      void context.runOperation('deferred', null, async () => {
        started = true;
        await release.promise;
        await writeFile(join(context.worktree, 'owned.txt'), 'settled');
        return null;
      });
      return { passed: true };
    },
  });
  cleanup(t, () => scheduler.close());
  await scheduler.enqueue([spec('task', repo)], { operationId: 'owned' });
  scheduler.start();
  await until(() => started);
  assert.equal(scheduler.get('task')!.state, 'running');
  assert.equal(cleaned, false);
  let cancelled = false;
  const pending = scheduler.cancel('task').then(() => {
    cancelled = true;
  });
  await delay(10);
  assert.equal(cancelled, false);
  release.resolve();
  await pending;
  assert.equal(cleaned, true);
  assert.equal(scheduler.get('task')!.state, 'cancelled');
  assert.equal(
    await readFile(join(scheduler.get('task')!.worktree!, 'owned.txt'), 'utf8'),
    'settled',
  );
});

test('cleanup failure remains interrupted and close rejects until the actual cleanup succeeds', async (t) => {
  const repo = scratch(t),
    data = scratch(t);
  await repository(repo);
  let permitCleanup = false;
  const scheduler = new CollaborationScheduler({
    dataDir: data,
    executor: async (_task, ctx) => {
      ctx.onCleanup(() => {
        if (!permitCleanup) throw new Error('owned process did not exit');
      });
      return { passed: true };
    },
  });
  cleanup(t, () => scheduler.close());
  await scheduler.enqueue([spec('cleanup', repo)], { operationId: 'cleanup' });
  scheduler.start();
  await scheduler.waitForIdle();
  assert.equal(scheduler.get('cleanup')!.state, 'interrupted');
  await assert.rejects(scheduler.close(), /cleanup has not completed/);
  assert.throws(
    () =>
      new CollaborationScheduler({
        dataDir: data,
        executor: async () => ({ passed: true }),
      }),
    /already open/,
  );
  permitCleanup = true;
  await scheduler.close();
});

test('shared external build leases coordinate with tasks and nested verification reuses its owned lease', async (t) => {
  const repo = scratch(t),
    data = scratch(t);
  await repository(repo);
  const { CollaborationResources } =
    await import('../src/workspace/collaboration.js');
  const resources = new CollaborationResources({ agents: 2, builds: 1 });
  const release = gate();
  let externalStarted = false,
    buildStarted = false,
    independent = false,
    nested = false;
  const external = resources.withResource('build', async () => {
    externalStarted = true;
    await release.promise;
  });
  await until(() => externalStarted);
  const scheduler = new CollaborationScheduler({
    dataDir: data,
    resources,
    executor: async (task, ctx) => {
      if (task.spec.id === 'build') {
        buildStarted = true;
        await ctx.withResource('build', () =>
          resources.withResource('build', async () => {
            nested = true;
          }),
        );
      } else independent = true;
      return { passed: true };
    },
  });
  cleanup(t, async () => {
    release.resolve();
    await external;
    await scheduler.close();
  });
  await scheduler.enqueue(
    [spec('build', repo, { resource: 'build' }), spec('independent', repo)],
    { operationId: 'shared-build' },
  );
  scheduler.start();
  await until(() => independent);
  assert.equal(buildStarted, false);
  release.resolve();
  await external;
  await scheduler.waitForIdle();
  assert.equal(nested, true);
});

test('the collaboration lease is held by its heartbeat, not by a process id', async (t) => {
  const data = scratch(t);
  const lock = join(data, 'collaboration.lock');
  const open = () =>
    new CollaborationScheduler({
      dataDir: data,
      executor: async () => ({ passed: true }),
    });
  const first = open();
  cleanup(t, () => first.close());
  assert.throws(open, /already open/, 'a live owner holds the ledger');
  await first.close();
  // A runtime that was killed leaves its lease behind, and the system hands its
  // id to another process. The id proves nothing; a stopped heartbeat does.
  await writeFile(
    lock,
    JSON.stringify({
      pid: process.pid,
      token: randomUUID(),
      at: Date.now() - 31_000,
    }),
  );
  const second = open();
  cleanup(t, () => second.close());
  await second.close();
  // A lease from before Circle renewed it is judged by the file's own time.
  await writeFile(
    lock,
    JSON.stringify({ pid: process.pid, token: randomUUID() }),
  );
  assert.throws(open, /already open/, 'an older Circle still holds it');
  const gone = Math.floor(Date.now() / 1000) - 120;
  await utimes(lock, gone, gone);
  const third = open();
  cleanup(t, () => third.close());
  // The new owner renews, so nobody takes the ledger from under it.
  assert.throws(open, /already open/, 'the renewal holds it');
  await third.close();
});
