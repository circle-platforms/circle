import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { DeliveryService } from '../src/workspace/delivery.js';
const exec = promisify(execFile);

test('publication refuses a repository whose root was redirected, before it pushes or asks GitHub', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'delivery-scan-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'),
    remote = join(root, 'remote.git');
  await mkdir(workspace);
  const git = async (cwd: string, ...args: string[]) =>
    (
      await exec('git', ['-C', cwd, ...args], { encoding: 'utf8' })
    ).stdout.trim();
  await git(root, 'init', '--bare', '--initial-branch=main', remote);
  await git(workspace, 'init', '--initial-branch=codex/feature');
  await writeFile(join(workspace, 'file.txt'), 'candidate\n');
  await git(workspace, 'add', 'file.txt');
  await git(
    workspace,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Candidate',
  );
  await git(workspace, 'remote', 'add', 'origin', remote);
  const service = new DeliveryService(workspace);
  const state = await service.git.snapshot();
  const requests: string[][] = [];
  t.mock.method(service, 'gh', async (args: string[]) => {
    requests.push(args);
    throw Error('unexpected GitHub call');
  });
  const gitRequests: string[][] = [];
  const actualGit = service.git.git.bind(service.git);
  t.mock.method(
    service.git,
    'git',
    async (args: string[], content?: string) => {
      gitRequests.push(args);
      return actualGit(args, content);
    },
  );
  const redirect = join(root, 'redirect');
  await mkdir(redirect);
  await git(workspace, 'config', 'core.worktree', redirect);
  assert.equal(
    await realpath(await git(workspace, 'rev-parse', '--show-toplevel')),
    await realpath(redirect),
  );
  await assert.rejects(
    service.call('publish', {
      revision: state.revision,
      title: 'Candidate',
      body: 'Real candidate',
    }),
    /root changed/,
  );
  assert.deepEqual(requests, []);
  assert.equal(
    gitRequests.filter((args) => args[0] === 'push').length,
    0,
    'a redirected repository is not pushed',
  );
  assert.equal(await git(root, '--git-dir', remote, 'branch', '--list'), '');
});
