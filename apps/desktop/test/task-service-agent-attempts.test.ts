import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realpath, symlink } from 'node:fs/promises';
import { TaskService } from '../src/workspace/task-service';
import { cleanup, scratch } from '../../../tests/helpers';

test('agent attempts are immutable owner/workspace scoped copies and preserve old attempts after reopening', async (t) => {
  const workspace = scratch(t),
    dataDir = scratch(t);
  const rawWorkspace = join(scratch(t), 'workspace-alias');
  await symlink(
    workspace,
    rawWorkspace,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', '--local', 'core.autocrlf', 'false');
  writeFileSync(join(workspace, 'source.txt'), 'source\n');
  git('add', 'source.txt');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Create fixture',
  );
  const options = {
    workspace: rawWorkspace,
    dataDir,
    autoStart: false,
    emit() {},
    createRuntime() {
      throw Error('must not execute');
    },
  };
  let service = new TaskService(options);
  cleanup(t, () => service.close());
  const spec = (id: string) => ({
    id,
    prompt: id,
    access: 'readonly',
    acceptanceCriteria: ['review actual source'],
  });
  await service.call('parent-one', 'enqueue', {
    operationId: 'one',
    tasks: [spec('one')],
  });
  await service.call('parent-two', 'enqueue', {
    operationId: 'two',
    tasks: [spec('two')],
  });
  const one = service.taskAttempts('parent-one');
  assert.equal(one[0]!.spec.workspace, await realpath(rawWorkspace));
  assert.deepEqual(
    one.map((task) => task.spec.id),
    ['one'],
  );
  assert.throws(() => {
    one[0]!.spec.prompt = 'tampered';
  }, TypeError);
  assert.throws(() => {
    (one as unknown[]).push({});
  }, TypeError);
  assert.equal(service.getTask('one')!.spec.prompt, 'one');
  await service.call('parent-one', 'cancel', { id: 'one' });
  await service.call('parent-one', 'retry', {
    id: 'one',
    operationId: 'retry',
  });
  assert.deepEqual(
    service
      .taskAttempts('parent-one')
      .map((task) => [task.attempt, task.state]),
    [
      [1, 'cancelled'],
      [2, 'queued'],
    ],
  );
  await service.close();
  service = new TaskService(options);
  assert.deepEqual(
    service
      .taskAttempts('parent-one')
      .map((task) => [task.attempt, task.state]),
    [
      [1, 'cancelled'],
      [2, 'queued'],
    ],
  );
  assert.deepEqual(
    service.taskAttempts('parent-two').map((task) => task.spec.id),
    ['two'],
  );
  assert.deepEqual(service.taskAttempts('unrelated'), []);
});
