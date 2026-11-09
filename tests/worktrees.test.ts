import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultPolicy } from '../src/approvals.js';
import { Sandbox } from '../src/sandbox.js';
import { repositoryWorktrees } from '../src/worktrees.js';
import { scratch } from './helpers.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Circle Test',
      '-c',
      'user.email=test@example.invalid',
      ...args,
    ],
    { cwd, stdio: 'pipe', encoding: 'utf8' },
  );

// A repository with a linked worktree beside it, one removed, and one only forged
function repository(root: string) {
  const main = join(root, 'main');
  mkdirSync(main);
  git(main, 'init', '-q');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'start');
  git(main, 'worktree', 'add', '-q', '-b', 'side', '../side');
  git(main, 'worktree', 'add', '-q', '-b', 'gone', '../gone');
  rmSync(join(root, 'gone'), { recursive: true, force: true });
  // A record git lists, for a folder whose .git names another worktree's record: the two
  // do not name each other, so it is no checkout of this repository
  const victim = join(root, 'victim');
  mkdirSync(victim);
  const records = join(main, '.git', 'worktrees');
  mkdirSync(join(records, 'forged'));
  writeFileSync(join(records, 'forged', 'gitdir'), join(victim, '.git') + '\n');
  writeFileSync(join(records, 'forged', 'HEAD'), 'ref: refs/heads/side\n');
  writeFileSync(join(records, 'forged', 'commondir'), '../..\n');
  writeFileSync(join(victim, '.git'), `gitdir: ${join(records, 'side')}\n`);
  return { main, side: join(root, 'side'), victim };
}

test("a repository's other checkouts are its worktrees, each checked both ways", (t) => {
  const root = realpathSync.native(scratch(t));
  const { main, side, victim } = repository(root);
  assert.match(
    git(main, 'worktree', 'list'),
    /victim/,
    'git lists the forged one',
  );
  assert.deepEqual(repositoryWorktrees(main), [side]);
  // From the linked worktree, the main checkout is the other one
  assert.deepEqual(repositoryWorktrees(side), [main]);
  // Not a repository
  const plain = join(root, 'plain');
  mkdirSync(plain);
  assert.deepEqual(repositoryWorktrees(plain), []);
  assert.ok(!repositoryWorktrees(main).includes(victim));
});

test('the sandbox finds the worktree a path is in, and one made since', async (t) => {
  const root = realpathSync.native(scratch(t));
  const { main, side, victim } = repository(root);
  const sandbox = new Sandbox(main, join(root, 'data'));
  assert.equal(
    sandbox.worktreeRoot(join(side, 'a.ts')),
    undefined,
    'unset: none',
  );
  sandbox.worktrees = () => repositoryWorktrees(main);
  assert.equal(sandbox.worktreeRoot(join(side, 'src', 'a.ts')), side);
  assert.equal(sandbox.worktreeRoot(side), side);
  assert.equal(sandbox.worktreeRoot(join(victim, 'a.ts')), undefined);
  assert.equal(sandbox.worktreeRoot(join(root, 'sidecar', 'a.ts')), undefined);
  assert.equal(
    sandbox.worktreeRoot(join(main, 'a.ts')),
    undefined,
    'the workspace is not another checkout',
  );
  git(main, 'worktree', 'add', '-q', '-b', 'later', '../later');
  await delay(300);
  assert.equal(
    sandbox.worktreeRoot(join(root, 'later', 'a.ts')),
    join(root, 'later'),
  );
});

test('a change in a worktree is a change in the workspace to approvals, where the runtime says so', (t) => {
  const root = realpathSync.native(scratch(t));
  const { main, side } = repository(root);
  const policy = defaultPolicy(main, join(root, 'home'));
  const edit = {
    file_path: join(side, 'a.ts'),
    old_string: 'a',
    new_string: 'b',
  };
  assert.notEqual(policy.review('edit_file', edit).pattern, 'workspace');
  const sandbox = new Sandbox(main, join(root, 'data'));
  sandbox.worktrees = () => repositoryWorktrees(main);
  policy.worktree = (path) => !!sandbox.worktreeRoot(path);
  const found = policy.review('edit_file', edit);
  assert.equal(found.pattern, 'workspace');
  assert.match(found.reason, /changes files in the workspace/);
});
