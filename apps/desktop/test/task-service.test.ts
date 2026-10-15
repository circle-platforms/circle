import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
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
  for (let i = 0; i < 300; i++) {
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
        await readFile(join(ctx.worktree, 'accepted.txt'), 'utf8'),
        'actual',
      );
      return [
        {
          criterion: 'actual file',
          status: 'passed',
          source: 'inspection',
          evidence: 'assert compared actual accepted.txt',
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
  })) as unknown[];
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
});
