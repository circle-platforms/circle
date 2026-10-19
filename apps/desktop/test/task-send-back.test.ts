import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { AgentRuntime } from '../../../src/runtime.js';
import { defaultSettings, trustFolder } from '../../../src/settings.js';
import { ScriptedModel } from '../../../src/testing.js';
import type { Message } from '../../../src/types.js';
import {
  TaskService,
  type TaskServiceOptions,
} from '../src/workspace/task-service.js';
import type { TaskVerificationCheck } from '../src/workspace/task-executor.js';
import type {
  CollaborationEvent,
  TaskArtifact,
  TaskRecord,
  TaskSendBack,
} from '../src/workspace/collaboration.js';
import { cleanup, scratch } from '../../../tests/helpers.js';
import { patience } from './helpers/patience.mjs';

const exec = promisify(execFile);
async function git(path: string, ...args: string[]): Promise<string> {
  return (
    await exec('git', ['-C', path, ...args], { encoding: 'utf8' })
  ).stdout.trim();
}
async function repository(path: string): Promise<string> {
  await git(path, 'init', '--initial-branch=main');
  await git(path, 'config', '--local', 'core.autocrlf', 'false');
  await writeFile(join(path, 'source.txt'), 'source\n');
  await git(path, 'add', 'source.txt');
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
const task = (id: string, dependencies: string[] = []) => ({
  id,
  prompt: `Implement ${id}`,
  access: 'write',
  acceptanceCriteria: ['actual file'],
  dependencies,
  resource: 'agent',
});
async function until(condition: () => boolean): Promise<void> {
  // Each attempt creates a real Git worktree and runtime; Windows needs seconds.
  const deadline = Date.now() + patience(20_000);
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(10);
  }
  assert.fail('task fixture did not settle');
}
const message = (
  content: string,
  tool_calls?: Message['tool_calls'],
): Message => ({
  id: randomUUID(),
  role: 'assistant',
  content,
  ...(tool_calls ? { tool_calls } : {}),
});
const passed = (record: TaskRecord): TaskVerificationCheck[] => [
  {
    criterion: 'actual file',
    status: 'passed',
    source: 'inspection',
    evidence: `read ${record.spec.id}.txt of attempt ${record.attempt}`,
  },
];
/** Each attempt's worker writes `<id>.txt` naming its attempt; `verify` decides acceptance. */
function fixture(
  t: TestContext,
  verify: (record: TaskRecord) => TaskVerificationCheck[],
) {
  const workspace = scratch(t),
    dataDir = scratch(t);
  const workers = new Map<
    string,
    { model: ScriptedModel; fromBaseline: boolean }
  >();
  const events: CollaborationEvent[] = [];
  const options: TaskServiceOptions = {
    workspace,
    dataDir,
    identity: { name: 'Fixture', email: 'fixture@example.invalid' },
    emit: (event) => events.push(event),
    createRuntime: async (record, ctx) => {
      const name = `${record.spec.id}.txt`;
      const home = join(
        dataDir,
        'homes',
        `${record.spec.id}-${record.attempt}`,
      );
      await mkdir(home, { recursive: true });
      const model = new ScriptedModel([
        {
          message: message('', [
            {
              id: 'write',
              name: 'write_file',
              args: { file_path: name, content: `attempt ${record.attempt}\n` },
            },
          ]),
        },
        { message: message('done') },
      ]);
      workers.set(`${record.spec.id}:${record.attempt}`, {
        model,
        fromBaseline: !existsSync(join(ctx.worktree, name)),
      });
      return new AgentRuntime({
        workspace: ctx.worktree,
        home,
        userHome: home,
        model,
        settings: trustFolder(defaultSettings(), ctx.worktree),
        bundledExtensions: false,
        screenshot: false,
        headless: true,
        approve: async () => 'approve',
      });
    },
    verify: async (record) => verify(record),
  };
  /** The instruction the worker of this attempt actually sent to its model. */
  const instruction = (key: string): string =>
    workers
      .get(key)!
      .model.requests[0]!.messages.filter((entry) => entry.role === 'user')
      .map((entry) => entry.content)
      .join('\n');
  return { workspace, dataDir, workers, events, options, instruction };
}
const shownVersion = (record: TaskRecord) => ({
  id: record.spec.id,
  expectedAttempt: record.attempt,
  expectedPatchSha256: (record.result as { changes: { sha256: string } })
    .changes.sha256,
});
const attempts = (service: TaskService, id: string) =>
  service.taskAttempts('owner').filter((record) => record.spec.id === id);

test('a person sends a task back with a reason; the next attempt starts from the baseline, is told why and is accepted the normal way', async (t) => {
  const f = fixture(t, (record) =>
    record.spec.id === 'work' && record.attempt === 1 ? [] : passed(record),
  );
  const baseline = await repository(f.workspace);
  const service = new TaskService(f.options);
  cleanup(t, () => service.close());
  await service.call('owner', 'enqueue', {
    operationId: 'enqueue',
    tasks: [task('work'), task('settled'), task('follow', ['work'])],
  });
  await until(
    () =>
      service.getTask('work')?.state === 'needs_review' &&
      service.getTask('settled')?.state === 'succeeded',
  );
  assert.equal(service.getTask('follow')!.state, 'blocked');
  const shown = service.getTask('work')!;
  const changes = (
    shown.result as {
      changes: { sha256: string; head: string; patchPath: string };
    }
  ).changes;
  const reason = 'Name the attempt on the first line and nothing else.';
  const params = { ...shownVersion(shown), reason: `  ${reason}\n` };

  for (const missing of [undefined, '', ' \n\t ', 42, 'x'.repeat(8193)])
    await assert.rejects(
      service.call('owner', 'reject', { ...params, reason: missing }),
      /invalid reason for sending the task back/,
    );
  await assert.rejects(
    service.call('owner', 'reject', { ...params, expectedAttempt: 2 }),
    /stale/,
  );
  await assert.rejects(
    service.call('owner', 'reject', {
      ...params,
      expectedPatchSha256: 'f'.repeat(64),
    }),
    /stale/,
  );
  await assert.rejects(
    service.call('owner', 'reject', { ...params, expectedPatchSha256: 'f' }),
    /invalid task review version/,
  );
  await assert.rejects(
    service.call('owner', 'reject', { ...params, id: 'missing' }),
    /unknown task/,
  );
  await assert.rejects(
    service.call('owner', 'reject', {
      ...shownVersion(service.getTask('settled')!),
      reason,
    }),
    /stale/,
    'only a task that needs review can be sent back',
  );
  // As strict as a passing review: the patch and the worktree are still what was shown.
  const patchBytes = await readFile(changes.patchPath);
  await writeFile(changes.patchPath, 'tampered');
  await assert.rejects(
    service.call('owner', 'reject', params),
    /patch changed/,
  );
  await writeFile(changes.patchPath, patchBytes);
  await writeFile(join(shown.worktree!, 'work.txt'), 'edited after review\n');
  await assert.rejects(
    service.call('owner', 'reject', params),
    /worktree changed/,
  );
  await writeFile(join(shown.worktree!, 'work.txt'), 'attempt 1\n');
  assert.equal(attempts(service, 'work').length, 1);
  assert.equal(service.getTask('work')!.state, 'needs_review');
  assert.equal(f.workers.has('work:2'), false);

  const sent = (await service.call('owner', 'reject', params)) as TaskRecord;
  assert.equal(sent.attempt, 2);
  const decision = sent.sentBack![0]!;
  assert.equal(typeof decision.at, 'number');
  assert.deepEqual(decision, {
    reviewer: 'human',
    decision: 'rejected',
    expectedAttempt: 1,
    expectedPatchSha256: changes.sha256,
    head: changes.head,
    reason,
    at: decision.at,
  } satisfies TaskSendBack);
  // A dependent waits for the new attempt instead of staying blocked or being cancelled.
  assert.equal(service.getTask('follow')!.state, 'queued');
  await until(() => service.getTask('follow')?.state === 'succeeded');

  const [rejected, accepted] = attempts(service, 'work');
  assert.equal(rejected!.state, 'failed');
  assert.equal(rejected!.reason, 'a person sent this attempt back');
  assert.deepEqual(rejected!.result, {
    ...(shown.result as object),
    verdict: 'failed',
    reason: 'a person sent this attempt back',
    review: decision,
  });
  assert.equal(accepted!.state, 'succeeded');
  assert.equal((accepted!.result as { verdict: string }).verdict, 'passed');
  assert.deepEqual(accepted!.sentBack, [decision]);

  const told = f.instruction('work:2');
  assert.ok(told.startsWith('Task work, attempt 2.\n\nImplement work\n\n'));
  assert.ok(
    told.includes(
      `Acceptance criteria:\n1. actual file\n\nAttempt 1 was sent back by a person: ${reason}\nThis attempt starts again from the baseline commit, without the changes that were sent back.`,
    ),
    told,
  );
  assert.doesNotMatch(f.instruction('work:1'), /sent back/);
  assert.equal(f.workers.get('work:2')!.fromBaseline, true);
  const workers = [...f.workers.keys()];
  assert.ok(workers.indexOf('work:2') < workers.indexOf('follow:1'));
  assert.match(f.instruction('follow:1'), /"id": "work",\s+"attempt": 2,/);

  // The attempt sent back keeps its worktree, branch and artifacts.
  assert.notEqual(accepted!.worktree, rejected!.worktree);
  assert.equal(
    await readFile(join(rejected!.worktree!, 'work.txt'), 'utf8'),
    'attempt 1\n',
  );
  assert.equal(
    await git(f.workspace, 'rev-parse', '--verify', rejected!.branch!),
    baseline,
  );
  const artifacts = (await service.call('owner', 'artifacts', {
    id: 'work',
  })) as TaskArtifact[];
  const record = artifacts.find(
    (artifact) => artifact.kind === 'human-review',
  )!;
  assert.equal(record.attempt, 1);
  const read = (artifact: TaskArtifact) =>
    service.call('owner', 'readArtifact', {
      id: 'work',
      artifactId: artifact.id,
    }) as Promise<{ content: string }>;
  assert.deepEqual(JSON.parse((await read(record)).content), decision);
  assert.match(
    (
      await read(
        artifacts.find(
          (artifact) =>
            artifact.kind === 'task-patch' && artifact.attempt === 1,
        )!,
      )
    ).content,
    /\+attempt 1/,
  );

  const stream = f.events
    .filter((event) => event.taskId === 'work')
    .map((event) => `${event.type}:${event.attempt}`);
  assert.ok(
    stream.indexOf('task.reviewed:1') < stream.indexOf('task.failed:1') &&
      stream.indexOf('task.failed:1') < stream.indexOf('task.queued:2') &&
      stream.indexOf('task.queued:2') < stream.indexOf('task.succeeded:2'),
    stream.join(' '),
  );
  assert.deepEqual(
    f.events.find(
      (event) => event.type === 'task.reviewed' && event.taskId === 'work',
    )!.payload,
    {
      reviewer: 'human',
      decision: 'rejected',
      patchSha256: changes.sha256,
      reason,
    },
  );

  // Repeating the decision that took effect starts no other attempt.
  const repeated = (await service.call(
    'owner',
    'reject',
    params,
  )) as TaskRecord;
  assert.equal(repeated.attempt, 2);
  assert.equal(repeated.state, 'succeeded');
  await assert.rejects(
    service.call('owner', 'reject', { ...params, reason: 'another reason' }),
    /stale/,
  );
  assert.equal(attempts(service, 'work').length, 2);
  assert.equal(f.workers.has('work:3'), false);

  const integration = (await service.call('owner', 'createIntegration', {
    baseline,
  })) as { id: string; path: string };
  const merged = (await service.call('owner', 'mergeCandidates', {
    integrationId: integration.id,
    taskIds: ['work'],
    expectedHead: baseline,
  })) as { status: string };
  assert.equal(merged.status, 'merged');
  assert.equal(
    await readFile(join(integration.path, 'work.txt'), 'utf8'),
    'attempt 2\n',
  );
});

test('a send-back and its reason survive a restart, and a later attempt is told every reason', async (t) => {
  const f = fixture(t, (record) => (record.attempt < 3 ? [] : passed(record)));
  await repository(f.workspace);
  let service = new TaskService(f.options);
  cleanup(t, () => service.close());
  await service.call('owner', 'enqueue', {
    operationId: 'enqueue',
    tasks: [task('work')],
  });
  await until(() => service.getTask('work')?.state === 'needs_review');
  const first = {
    ...shownVersion(service.getTask('work')!),
    reason: 'Keep the file to one line.',
  };
  await service.call('owner', 'reject', first);
  await until(
    () =>
      service.getTask('work')?.attempt === 2 &&
      service.getTask('work')?.state === 'needs_review',
  );
  await service.close();

  service = new TaskService({ ...f.options, autoStart: false });
  const reopened = service.getTask('work')!;
  assert.deepEqual(
    reopened.sentBack!.map((entry) => [entry.expectedAttempt, entry.reason]),
    [[1, 'Keep the file to one line.']],
  );
  const [rejected] = attempts(service, 'work');
  assert.equal(rejected!.state, 'failed');
  assert.equal(
    (rejected!.result as unknown as { review: TaskSendBack }).review.reason,
    'Keep the file to one line.',
  );
  const record = (
    (await service.call('owner', 'artifacts', {
      id: 'work',
    })) as TaskArtifact[]
  ).find((artifact) => artifact.kind === 'human-review')!;
  const shown = (await service.call('owner', 'readArtifact', {
    id: 'work',
    artifactId: record.id,
  })) as { content: string };
  assert.equal(JSON.parse(shown.content).decision, 'rejected');
  assert.equal(
    ((await service.call('owner', 'reject', first)) as TaskRecord).attempt,
    2,
    'the same decision after a restart starts no other attempt',
  );

  await service.call('owner', 'reject', {
    ...shownVersion(reopened),
    reason: 'Name the attempt in the file.',
  });
  assert.equal(service.getTask('work')!.state, 'queued');
  await service.close();

  // The queued attempt keeps both reasons through another restart.
  service = new TaskService(f.options);
  await until(() => service.getTask('work')?.state === 'succeeded');
  assert.equal(service.getTask('work')!.attempt, 3);
  assert.ok(
    f
      .instruction('work:3')
      .includes(
        'Attempt 1 was sent back by a person: Keep the file to one line.\nAttempt 2 was sent back by a person: Name the attempt in the file.\n',
      ),
    f.instruction('work:3'),
  );
  assert.deepEqual(
    attempts(service, 'work').map((attempt) => attempt.state),
    ['failed', 'failed', 'succeeded'],
  );
});

test('a plain retry of a task that needs review records no decision and tells its worker nothing new', async (t) => {
  const f = fixture(t, () => []);
  await repository(f.workspace);
  const service = new TaskService(f.options);
  cleanup(t, () => service.close());
  await service.call('owner', 'enqueue', {
    operationId: 'enqueue',
    tasks: [task('work')],
  });
  await until(() => service.getTask('work')?.state === 'needs_review');
  const retried = (await service.call('owner', 'retry', {
    id: 'work',
    operationId: 'plain',
  })) as TaskRecord;
  assert.equal(retried.attempt, 2);
  assert.equal(retried.sentBack, undefined);
  await until(
    () =>
      service.getTask('work')?.attempt === 2 &&
      service.getTask('work')?.state === 'needs_review',
  );
  const [first] = attempts(service, 'work');
  assert.equal(first!.state, 'needs_review');
  assert.equal((first!.result as { review?: unknown }).review, undefined);
  assert.equal(
    (
      (await service.call('owner', 'artifacts', {
        id: 'work',
      })) as TaskArtifact[]
    ).filter((artifact) => artifact.kind === 'human-review').length,
    0,
  );
  assert.doesNotMatch(f.instruction('work:2'), /sent back/);
});
