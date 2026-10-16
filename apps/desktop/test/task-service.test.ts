import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  readFile,
  realpath,
  symlink,
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
import { TaskService } from '../src/workspace/task-service.js';
import type {
  CollaborationEvent,
  TaskRecord,
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
  await writeFile(join(path, 'source.txt'), 'source');
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
const task = (id: string) => ({
  id,
  prompt: `Implement ${id}`,
  access: 'write',
  acceptanceCriteria: ['actual file'],
  dependencies: [],
  resource: 'agent',
});
async function until(condition: () => Promise<boolean>): Promise<void> {
  // Tasks create real Git worktrees and runtimes one after another; a Windows
  // runner needs seconds for each, so wait by time rather than by poll count.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
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

test('service injects authorized workspace/session/resources and rejects renderer authority', async (t) => {
  const workspace = scratch(t),
    dataDir = scratch(t);
  await repository(workspace);
  const service = new TaskService({
    workspace,
    dataDir,
    autoStart: false,
    allowedResources: ['granted'],
    emit: () => {},
    createRuntime: () => {
      throw new Error('must not run');
    },
  });
  cleanup(t, () => service.close());
  const created = (await service.call('origin-session', 'enqueue', {
    operationId: 'enqueue',
    tasks: [task('one')],
  })) as TaskRecord[];
  assert.equal(created[0]!.spec.workspace, await realpath(workspace));
  assert.equal(created[0]!.spec.sessionId, 'origin-session');
  assert.deepEqual(created[0]!.spec.allowedResources, ['granted']);
  await assert.rejects(
    service.call('origin-session', 'enqueue', {
      operationId: 'bad',
      tasks: [{ ...task('bad'), workspace: '/ungranted' }],
    }),
    /ungranted fields/,
  );
  await assert.rejects(
    service.call('origin-session', 'list', { dataDir: '/private' }),
    /cannot select/,
  );
  await assert.rejects(
    service.call('origin-session', 'enqueue', {
      operationId: 'bad-resource',
      tasks: [{ ...task('bad'), allowedResources: ['all'] }],
    }),
    /ungranted fields/,
  );
  await assert.rejects(service.call('', 'list'), /session id/);
  const cancelled = (await service.call('origin-session', 'cancel', {
    id: 'one',
  })) as TaskRecord;
  assert.equal(cancelled.state, 'cancelled');
  const retried = (await service.call('origin-session', 'retry', {
    id: 'one',
    operationId: 'retry',
  })) as TaskRecord;
  assert.equal(retried.attempt, 2);
  const events = (await service.call('origin-session', 'events', {
    cursor: 0,
    limit: 100,
  })) as CollaborationEvent[];
  assert.ok(events.some((event) => event.type === 'task.cancelled'));
  assert.deepEqual(
    await service.call('origin-session', 'artifacts', { id: 'one' }),
    [],
  );
});

test('task concurrency settings persist, validate ranges and never silently replace invalid saved settings', async (t) => {
  const workspace = scratch(t),
    dataDir = scratch(t);
  await repository(workspace);
  const options = {
    workspace,
    dataDir,
    autoStart: false,
    emit: () => {},
    createRuntime: () => {
      throw new Error('must not run');
    },
  };
  let service = new TaskService(options);
  cleanup(t, () => service.close());
  assert.deepEqual(await service.call('session', 'settings'), {
    agents: 8,
    builds: 2,
    ui: 1,
    browsers: 1,
  });
  await assert.rejects(
    service.call('session', 'settings', { limits: { agents: 33 } }),
    /invalid agents/,
  );
  await assert.rejects(
    service.call('session', 'settings', { limits: { ui: 2 } }),
    /invalid ui/,
  );
  await service.call('session', 'settings', {
    limits: { agents: 12, builds: 3 },
  });
  await service.close();
  assert.equal(service.hasActiveSession('session'), false);
  assert.equal(service.getTask('missing'), undefined);
  service = new TaskService(options);
  assert.deepEqual(await service.call('session', 'settings'), {
    agents: 12,
    builds: 3,
    ui: 1,
    browsers: 1,
  });
  await service.close();
  await writeFile(join(dataDir, 'task-settings.json'), '{invalid');
  assert.throws(() => new TaskService(options), /could not load task settings/);
});

test('service executes real runtime, exposes actual artifacts, refuses unverified merge and admits verified ledger candidates', async (t) => {
  const workspace = scratch(t),
    dataDir = scratch(t);
  const baseline = await repository(workspace);
  const events: CollaborationEvent[] = [];
  const service = new TaskService({
    workspace,
    dataDir,
    identity: { name: 'Fixture', email: 'fixture@example.invalid' },
    emit: (event) => events.push(event),
    createRuntime: async (record, ctx) => {
      const home = join(dataDir, 'homes', record.spec.id);
      await mkdir(home, { recursive: true });
      const model = new ScriptedModel([
        {
          message: message('', [
            {
              id: 'write',
              name: 'write_file',
              args: { file_path: record.spec.id + '.txt', content: 'actual' },
            },
          ]),
        },
        { message: message('done') },
      ]);
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
    verify: async (record, ctx) => {
      if (record.spec.id === 'claimed') return [];
      assert.equal(
        await readFile(join(ctx.worktree, record.spec.id + '.txt'), 'utf8'),
        'actual',
      );
      return [
        {
          criterion: 'actual file',
          status: 'passed',
          source: 'inspection',
          evidence: `assert compared actual ${record.spec.id}.txt`,
        },
      ];
    },
  });
  cleanup(t, () => service.close());
  await service.call('origin', 'enqueue', {
    operationId: 'actual',
    tasks: [task('accepted'), task('claimed')],
  });
  await until(async () =>
    ((await service.call('origin', 'list')) as TaskRecord[]).every((record) =>
      ['succeeded', 'needs_review'].includes(record.state),
    ),
  );
  assert.equal(service.getTask('accepted')!.spec.sessionId, 'origin');
  assert.equal(service.getTask('claimed')!.state, 'needs_review');
  const artifacts = (await service.call('origin', 'artifacts', {
    id: 'accepted',
  })) as { id: string; kind: string }[];
  const patch = artifacts.find((artifact) => artifact.kind === 'task-patch')!;
  const shown = (await service.call('origin', 'readArtifact', {
    id: 'accepted',
    artifactId: patch.id,
  })) as { content: string; sha256: string; truncated: boolean };
  assert.match(shown.content, /actual/);
  assert.equal(shown.truncated, false);
  await assert.rejects(
    service.call('origin', 'readArtifact', {
      id: 'claimed',
      artifactId: patch.id,
    }),
    /does not belong/,
  );
  assert.equal(artifacts.length, 4);
  assert.ok(events.some((event) => event.type === 'artifact.created'));
  const integration = (await service.call('origin', 'createIntegration', {
    baseline,
  })) as { id: string; path: string; baseline: string };
  const rejected = (await service.call('origin', 'mergeCandidates', {
    integrationId: integration.id,
    taskIds: ['claimed'],
    expectedHead: baseline,
  })) as { status: string };
  assert.equal(rejected.status, 'needs_review');
  await assert.rejects(
    service.call('origin', 'mergeCandidates', {
      integrationId: integration.id,
      taskIds: ['accepted'],
      expectedHead: baseline,
      patchPath: '/untrusted',
    }),
    /must come from/,
  );
  const merged = (await service.call('origin', 'mergeCandidates', {
    integrationId: integration.id,
    taskIds: ['accepted'],
    expectedHead: baseline,
  })) as { status: string };
  assert.equal(merged.status, 'merged');
  assert.equal(
    await readFile(join(integration.path, 'accepted.txt'), 'utf8'),
    'actual',
  );
  assert.equal(await git(workspace, 'rev-parse', 'HEAD'), baseline);
  const repairBaseline = await git(integration.path, 'rev-parse', 'HEAD');
  await service.call('origin', 'enqueue', {
    operationId: 'repair-round',
    tasks: [{ ...task('repair'), baseline: repairBaseline }],
  });
  await until(async () => service.getTask('repair')!.state === 'succeeded');
  const repairRequest = {
    integrationId: integration.id,
    taskIds: ['repair'],
    expectedHead: repairBaseline,
  };
  assert.equal(
    (
      (await service.call('origin', 'mergeCandidates', repairRequest)) as {
        status: string;
      }
    ).status,
    'needs_review',
    'a repair cannot silently use the initial integration baseline',
  );
  const unrelated = await git(
    workspace,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit-tree',
    await git(workspace, 'rev-parse', 'HEAD^{tree}'),
    '-m',
    'Create unrelated baseline',
  );
  for (const expectedBaseline of ['HEAD', unrelated, '0'.repeat(40)]) {
    const refused = (await service.call('origin', 'mergeCandidates', {
      ...repairRequest,
      expectedBaseline,
    })) as { status: string; reason: string };
    assert.equal(refused.status, 'needs_review');
    assert.match(refused.reason, /baseline/);
    assert.equal(
      await git(integration.path, 'rev-parse', 'HEAD'),
      repairBaseline,
    );
  }
  assert.equal(
    (
      (await service.call('origin', 'mergeCandidates', {
        ...repairRequest,
        expectedBaseline: repairBaseline,
      })) as { status: string }
    ).status,
    'merged',
  );
  assert.equal(
    await readFile(join(integration.path, 'repair.txt'), 'utf8'),
    'actual',
  );
  assert.equal(
    await readFile(join(integration.path, 'accepted.txt'), 'utf8'),
    'actual',
  );
  assert.equal(await git(workspace, 'rev-parse', 'HEAD'), baseline);
  const pendingReview = service.getTask('claimed')!;
  const reviewParams = {
    id: 'claimed',
    expectedAttempt: pendingReview.attempt,
    expectedPatchSha256: (
      pendingReview.result as { changes: { sha256: string } }
    ).changes.sha256,
    checks: [
      {
        criterion: 'actual file',
        evidence: 'I inspected claimed.txt and verified the actual contents',
      },
    ],
  };
  await assert.rejects(
    service.call('origin', 'review', {
      ...reviewParams,
      expectedAttempt: pendingReview.attempt + 1,
    }),
    /stale/,
  );
  await assert.rejects(
    service.call('origin', 'review', { ...reviewParams, checks: [] }),
    /each acceptance/,
  );
  const reviewed = (await service.call(
    'origin',
    'review',
    reviewParams,
  )) as TaskRecord;
  assert.equal(reviewed.state, 'succeeded');
  assert.equal(
    (reviewed.result as { review: { reviewer: string } }).review.reviewer,
    'human',
  );
  assert.equal(
    ((await service.call('origin', 'review', reviewParams)) as TaskRecord)
      .state,
    'succeeded',
  );
  const humanArtifacts = (await service.call('origin', 'artifacts', {
    id: 'claimed',
  })) as { kind: string }[];
  assert.equal(
    humanArtifacts.filter((artifact) => artifact.kind === 'human-review')
      .length,
    1,
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === 'task.reviewed' &&
        (event.payload as { reviewer: string }).reviewer === 'human',
    ),
  );
  const currentHead = await git(integration.path, 'rev-parse', 'HEAD');
  assert.equal(
    (
      (await service.call('origin', 'mergeCandidates', {
        integrationId: integration.id,
        taskIds: ['claimed'],
        expectedHead: currentHead,
      })) as { status: string }
    ).status,
    'merged',
  );
  assert.equal(
    await readFile(join(integration.path, 'claimed.txt'), 'utf8'),
    'actual',
  );
});

test('authorized workspaces share global agent/UI pools and one durable settings stream', async (t) => {
  const workspaceA = scratch(t),
    workspaceB = scratch(t),
    data = scratch(t);
  await repository(workspaceA);
  await repository(workspaceB);
  const { CollaborationResources } =
    await import('../src/workspace/collaboration.js');
  const resources = new CollaborationResources({ agents: 2 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [];
  const make = (workspace: string, name: string) =>
    new TaskService({
      workspace,
      dataDir: join(data, name),
      resources,
      settingsPath: join(data, 'shared', 'limits.json'),
      emit: () => {},
      createRuntime: async (record, ctx) => {
        const home = join(data, 'homes', record.spec.id);
        await mkdir(home, { recursive: true });
        const model = new ScriptedModel([
          async () => {
            started.push(record.spec.id);
            await gate;
            return {
              message: message('done'),
              usage: {
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
              },
            };
          },
        ]);
        return new AgentRuntime({
          workspace: ctx.worktree,
          home,
          userHome: home,
          model,
          settings: trustFolder(defaultSettings(), ctx.worktree),
          headless: true,
          bundledExtensions: false,
          screenshot: false,
        });
      },
    });
  const first = make(workspaceA, 'a'),
    second = make(workspaceB, 'b');
  cleanup(t, async () => {
    release();
    await Promise.all([first.close(), second.close()]);
  });
  await first.call('a-session', 'enqueue', {
    operationId: 'a',
    tasks: [{ ...task('ui-a'), resource: 'ui' }],
  });
  await until(async () => started.includes('ui-a'));
  await second.call('b-session', 'enqueue', {
    operationId: 'b',
    tasks: [{ ...task('ui-b'), resource: 'ui' }, task('independent-b')],
  });
  await until(async () => started.length === 2);
  assert.ok(started.includes('independent-b'));
  assert.ok(!started.includes('ui-b'));
  assert.notEqual(first.getTask('ui-a')!.runtimeSessionId, 'a-session');
  assert.ok(first.getTask('ui-a')!.runtimeSessionId);
  await Promise.all([
    first.call('a-session', 'settings', { limits: { agents: 3 } }),
    second.call('b-session', 'settings', { limits: { builds: 4 } }),
  ]);
  assert.deepEqual(await second.call('b-session', 'settings'), {
    agents: 3,
    builds: 4,
    ui: 1,
    browsers: 1,
  });
  release();
  await until(async () =>
    [
      ...((await first.call('a-session', 'list')) as TaskRecord[]),
      ...((await second.call('b-session', 'list')) as TaskRecord[]),
    ].every((record) => record.state === 'needs_review'),
  );
});

test('deleting an owner cancels only its task runtimes and awaits model cleanup; task views use the same ownership', async (t) => {
  const workspace = scratch(t),
    dataDir = scratch(t);
  await repository(workspace);
  const entered = new Set<string>(),
    closed = new Set<string>();
  const service = new TaskService({
    workspace,
    dataDir,
    emit: () => {},
    onRuntimeClosed: (task) => {
      closed.add(task.spec.id);
    },
    createRuntime: async (record, ctx) => {
      const home = join(dataDir, 'homes', record.spec.id);
      await mkdir(home, { recursive: true });
      const model = new ScriptedModel([
        async (request) => {
          entered.add(`${record.spec.id}:${record.attempt}`);
          await new Promise<void>((_resolve, reject) => {
            request.signal.addEventListener(
              'abort',
              () => reject(request.signal.reason),
              { once: true },
            );
          });
          throw new Error('not reached');
        },
      ]);
      return new AgentRuntime({
        workspace: ctx.worktree,
        home,
        userHome: home,
        model,
        settings: trustFolder(defaultSettings(), ctx.worktree),
        headless: true,
        bundledExtensions: false,
        screenshot: false,
      });
    },
  });
  cleanup(t, () => service.close());
  await service.call('parent-a', 'enqueue', {
    operationId: 'a',
    tasks: [task('a')],
  });
  await service.call('parent-b', 'enqueue', {
    operationId: 'b',
    tasks: [task('b')],
  });
  await until(async () => entered.size === 2);
  assert.equal(service.hasActiveSession('parent-a'), true);
  const childB = service.getTask('b')!.runtimeSessionId!;
  assert.equal(service.hasActiveSession(childB), true);
  const childA = service.getTask('a')!.runtimeSessionId!;
  await service.call(childA, 'enqueue', {
    operationId: 'nested',
    tasks: [task('nested')],
  });
  await until(async () => entered.size === 3);
  assert.equal(service.ownedRuntimeSessions('parent-a').length, 2);
  await service.cancelSession('parent-a');
  assert.equal(service.getTask('a')!.state, 'cancelled');
  assert.equal(closed.has('a'), true);
  assert.equal(service.getTask('nested')!.state, 'cancelled');
  assert.equal(service.hasActiveSession('parent-a'), false);
  assert.equal(service.getTask('b')!.state, 'running');
  assert.equal(closed.has('b'), false);
  assert.equal(service.hasActiveSession('parent-b'), true);
  await service.call('parent-a', 'retry', {
    id: 'a',
    operationId: 'new-attempt',
  });
  await until(async () => entered.has('a:2'));
  assert.notEqual(service.getTask('a')!.runtimeSessionId, childA);
  assert.equal(service.ownedRuntimeSessions('parent-a').length, 3);
  await service.cancelSession('parent-a');
  await service.cancelSession(childB);
  assert.equal(service.getTask('b')!.state, 'cancelled');
  assert.equal(closed.has('b'), true);
  assert.equal(service.hasActiveSession('parent-b'), false);
  await service.close();
  await service.cancelSession('parent-a');
  assert.equal(service.ownedRuntimeSessions('parent-a').length, 3);
});

test('human acceptance binds every criterion to the displayed attempt, actual head and immutable patch', async (t) => {
  const workspace = scratch(t),
    dataDir = scratch(t);
  await repository(workspace);
  const service = new TaskService({
    workspace,
    dataDir,
    emit: () => {},
    createRuntime: async (record, ctx) => {
      const home = join(dataDir, 'homes', record.spec.id);
      await mkdir(home, { recursive: true });
      return new AgentRuntime({
        workspace: ctx.worktree,
        home,
        userHome: home,
        model: new ScriptedModel([{ message: message('claim') }]),
        settings: trustFolder(defaultSettings(), ctx.worktree),
        headless: true,
        bundledExtensions: false,
        screenshot: false,
      });
    },
  });
  cleanup(t, () => service.close());
  await service.call('parent', 'enqueue', {
    operationId: 'reviewed',
    tasks: [
      {
        ...task('reviewed'),
        acceptanceCriteria: ['first criterion', 'second criterion'],
      },
    ],
  });
  await until(
    async () => service.getTask('reviewed')?.state === 'needs_review',
  );
  const record = service.getTask('reviewed')!,
    changes = (
      record.result as { changes: { sha256: string; patchPath: string } }
    ).changes;
  const params = {
    id: 'reviewed',
    expectedAttempt: record.attempt,
    expectedPatchSha256: changes.sha256,
    checks: [
      {
        criterion: 'first criterion',
        evidence: 'I inspected the first expected behavior',
      },
      {
        criterion: 'second criterion',
        evidence: 'I inspected the second expected behavior',
      },
    ],
  };
  await assert.rejects(
    service.call('parent', 'review', {
      ...params,
      checks: params.checks.slice(0, 1),
    }),
    /each acceptance/,
  );
  await writeFile(join(record.worktree!, 'source.txt'), 'later changes');
  await assert.rejects(
    service.call('parent', 'review', params),
    /worktree changed/,
  );
  await writeFile(join(record.worktree!, 'source.txt'), 'source');
  const originalPatch = await readFile(changes.patchPath);
  await writeFile(changes.patchPath, 'tampered');
  await assert.rejects(
    service.call('parent', 'review', params),
    /patch changed/,
  );
  await writeFile(changes.patchPath, originalPatch);
  await git(
    record.worktree!,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'Change candidate head',
  );
  await assert.rejects(
    service.call('parent', 'review', params),
    /worktree changed/,
  );
  assert.equal(service.getTask('reviewed')!.state, 'needs_review');
});

test('artifact viewer verifies ledger ownership and bytes, paginates Unicode and rejects symlink escapes', async (t) => {
  const workspace = scratch(t),
    dataDir = scratch(t),
    outside = scratch(t);
  await repository(workspace);
  const content = 'A😀中B';
  const service = new TaskService({
    workspace,
    dataDir,
    emit: () => {},
    createRuntime: async (record, ctx) => {
      const home = join(dataDir, 'homes', record.spec.id);
      await mkdir(home, { recursive: true });
      return new AgentRuntime({
        workspace: ctx.worktree,
        home,
        userHome: home,
        model: new ScriptedModel([{ message: message('done') }]),
        settings: trustFolder(defaultSettings(), ctx.worktree),
        headless: true,
        bundledExtensions: false,
        screenshot: false,
      });
    },
    verify: async (_record, ctx) => {
      const path = join(ctx.artifactDirectory, 'proof.log');
      await writeFile(path, content);
      return [
        {
          criterion: 'actual file',
          status: 'passed',
          source: 'inspection',
          evidence: 'source was inspected',
          artifactPaths: [path],
        },
      ];
    },
  });
  cleanup(t, () => service.close());
  await service.call('parent', 'enqueue', {
    operationId: 'artifact',
    tasks: [task('artifact')],
  });
  await until(async () => service.getTask('artifact')?.state === 'succeeded');
  const artifacts = (await service.call('parent', 'artifacts', {
    id: 'artifact',
  })) as { id: string; kind: string; path: string }[];
  const proof = artifacts.find((artifact) => artifact.kind === 'verification')!;
  const read = (offset = 0) =>
    service.call('parent', 'readArtifact', {
      id: 'artifact',
      artifactId: proof.id,
      offset,
      limit: 2,
    }) as Promise<{ content: string; truncated: boolean; nextOffset?: number }>;
  const first = await read();
  assert.equal(first.content, 'A');
  assert.equal(first.truncated, true);
  const second = await read(first.nextOffset!);
  assert.equal(second.content, '😀');
  const third = await read(second.nextOffset!);
  assert.equal(third.content, '中B');
  assert.equal(third.truncated, false);
  await assert.rejects(read(2), /splits a character/);
  await assert.rejects(
    service.call('parent', 'readArtifact', {
      id: 'artifact',
      artifactId: proof.id,
      path: '/private',
    }),
    /cannot select artifact paths/,
  );
  await writeFile(proof.path, 'changed');
  await assert.rejects(read(), /changed after it was recorded/);
  await writeFile(join(outside, 'same.txt'), content);
  await unlink(proof.path);
  await symlink(join(outside, 'same.txt'), proof.path);
  await assert.rejects(read(), /outside its owned/);
});
