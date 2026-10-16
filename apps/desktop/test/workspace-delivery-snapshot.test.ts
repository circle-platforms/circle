import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { DeliveryService } from '../src/workspace/delivery.js';
const exec = promisify(execFile);

test('already-pushed publication scans the candidate at publication and confirmation boundaries and still rejects actual edits and root redirection', async (t) => {
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
  await git(workspace, 'push', 'origin', 'codex/feature');
  const service = new DeliveryService(workspace);
  const state = await service.git.snapshot();
  const input = {
    revision: state.revision,
    head: state.head,
    title: 'Candidate',
    body: 'Real pushed candidate',
  };
  let reads = 0;
  const snapshot = service.git.snapshot.bind(service.git);
  t.mock.method(service.git, 'snapshot', async () => {
    reads++;
    return snapshot();
  });
  const requests: string[][] = [];
  t.mock.method(service, 'gh', async (args: string[]) => {
    requests.push(args);
    return JSON.stringify({
      number: 1,
      url: 'https://example.invalid/pull/1',
      isDraft: true,
      headRefOid: state.head,
      headRefName: 'codex/feature',
      state: 'OPEN',
    });
  });
  const gitRequests: string[][] = [];
  const actualGit = service.git.git.bind(service.git);
  let changeDuringRemoteRead = false;
  t.mock.method(
    service.git,
    'git',
    async (args: string[], content?: string) => {
      gitRequests.push(args);
      const result = await actualGit(args, content);
      if (changeDuringRemoteRead && args[0] === 'ls-remote') {
        changeDuringRemoteRead = false;
        await writeFile(
          join(workspace, 'file.txt'),
          'edit during remote check\n',
        );
      }
      return result;
    },
  );
  await service.publishPushed(input);
  assert.equal(
    reads,
    3,
    'pre-publish, post-remote and confirmed-result snapshots; lock key does not rescan candidate',
  );
  assert.equal(
    requests.filter((x) => x[0] === 'pr' && x[1] === 'ready').length,
    0,
    'publishing does not make the PR ready',
  );
  assert.equal(
    gitRequests.filter((args) => args[0] === 'push').length,
    0,
    'already-pushed publication does not duplicate a network mutation',
  );
  changeDuringRemoteRead = true;
  await assert.rejects(service.publishPushed(input), /changed while verifying/);
  assert.equal(
    await readFile(join(workspace, 'file.txt'), 'utf8'),
    'edit during remote check\n',
  );
  await writeFile(join(workspace, 'file.txt'), 'external edit\n');
  await assert.rejects(service.publishPushed(input), /changed/);
  assert.equal(
    await readFile(join(workspace, 'file.txt'), 'utf8'),
    'external edit\n',
  );
  await writeFile(join(workspace, 'file.txt'), 'candidate\n');
  const redirect = join(root, 'redirect');
  await mkdir(redirect);
  await git(workspace, 'config', 'core.worktree', redirect);
  assert.equal(
    await realpath(await git(workspace, 'rev-parse', '--show-toplevel')),
    await realpath(redirect),
  );
  await assert.rejects(service.publishPushed(input), /root changed/);
});
