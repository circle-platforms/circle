import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { GitWorkspaceService } from '../src/workspace/git.ts';

const exec = promisify(execFile);

async function repository(t: { after: (action: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'git-changes-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) =>
    (
      await exec(
        'git',
        [
          '-C',
          root,
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { encoding: 'utf8' },
      )
    ).stdout.trim();
  await git('init', '--initial-branch=main');
  await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(root, 'b.txt'), 'keep\n');
  await writeFile(join(root, 'gone.txt'), 'bye\nbye\n');
  await git('add', '.');
  await git('commit', '-m', 'Base');
  return { root, git, service: new GitWorkspaceService(root) };
}

const letters = (files: { path: string; status: string }[]) =>
  Object.fromEntries(files.map((file) => [file.path, file.status]));

test('changes lists what differs from the last commit, staged or not, and every new file', async (t) => {
  const { root, git, service } = await repository(t);
  // Staged edit, unstaged edit, deletion, staged new file, untracked, binary, nested.
  await writeFile(join(root, 'a.txt'), 'one\n2\nthree\nfour\n');
  await git('add', 'a.txt');
  await writeFile(join(root, 'b.txt'), 'keep\nmore\n');
  await rm(join(root, 'gone.txt'));
  await writeFile(join(root, 'staged-new.txt'), 'x\ny\n');
  await git('add', 'staged-new.txt');
  await writeFile(join(root, 'fresh.ts'), 'p\nq\nr\n');
  await writeFile(join(root, 'image.bin'), Buffer.from([0, 1, 2, 0]));
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', 'deep.txt'), 'no newline');

  const result = (await service.call('changes')) as {
    revision: string;
    files: {
      path: string;
      status: string;
      added?: number | null;
      removed?: number | null;
    }[];
  };
  assert.match(result.revision, /^[0-9a-f]{64}$/);
  assert.deepEqual(letters(result.files), {
    'a.txt': 'M',
    'b.txt': 'M',
    'gone.txt': 'D',
    'staged-new.txt': 'A',
    'fresh.ts': 'A',
    'image.bin': 'A',
    'nested/deep.txt': 'A',
  });
  const by = Object.fromEntries(result.files.map((file) => [file.path, file]));
  assert.deepEqual([by['a.txt']!.added, by['a.txt']!.removed], [2, 1]);
  assert.deepEqual([by['b.txt']!.added, by['b.txt']!.removed], [1, 0]);
  assert.deepEqual([by['gone.txt']!.added, by['gone.txt']!.removed], [0, 2]);
  assert.deepEqual(
    [by['staged-new.txt']!.added, by['staged-new.txt']!.removed],
    [2, 0],
  );
  assert.deepEqual([by['fresh.ts']!.added, by['fresh.ts']!.removed], [3, 0]);
  assert.deepEqual(
    [by['nested/deep.txt']!.added, by['nested/deep.txt']!.removed],
    [1, 0],
  );
  // A binary file is listed, with no line counts.
  assert.equal(by['image.bin']!.added, null);
});

test('a clean repository has no changes, and a repository without a commit lists its files as new', async (t) => {
  const { service } = await repository(t);
  assert.deepEqual(
    ((await service.call('changes')) as { files: unknown[] }).files,
    [],
  );

  const fresh = await realpath(await mkdtemp(join(tmpdir(), 'git-unborn-')));
  t.after(() => rm(fresh, { recursive: true, force: true }));
  await exec('git', ['-C', fresh, 'init', '--initial-branch=main']);
  await writeFile(join(fresh, 'one.txt'), 'a\nb\n');
  const unborn = (await new GitWorkspaceService(fresh).call('changes')) as {
    files: { path: string; status: string; added: number }[];
  };
  assert.deepEqual(unborn.files, [
    { path: 'one.txt', status: 'A', added: 2, removed: 0 },
  ]);
});

test('the head scope shows one file against the last commit, whether the edit is staged or not', async (t) => {
  const { root, git, service } = await repository(t);
  await writeFile(join(root, 'a.txt'), 'one\n2\nthree\n');
  await git('add', 'a.txt');
  await writeFile(join(root, 'a.txt'), 'one\n2\nthree\nfour\n');

  const staged = (await service.call('diff', {
    scope: 'head',
    paths: ['a.txt'],
  })) as { text: string; entries: { path: string }[] };
  assert.deepEqual(
    staged.entries.map((entry) => entry.path),
    ['a.txt'],
  );
  assert.match(staged.text, /^-two$/m);
  assert.match(staged.text, /^\+2$/m);
  assert.match(staged.text, /^\+four$/m, 'the unstaged line shows too');

  // The working scope alone shows only what is not staged.
  const working = (await service.call('diff', {
    scope: 'working',
    paths: ['a.txt'],
  })) as { text: string };
  assert.ok(!/^\+2$/m.test(working.text));

  // A new file chosen by name is previewed as it would be added.
  await writeFile(join(root, 'fresh.ts'), 'p\nq\n');
  const created = (await service.call('diff', {
    scope: 'head',
    paths: ['fresh.ts'],
  })) as { text: string; entries: { path: string; status: string }[] };
  assert.match(created.text, /^\+p$/m);
  assert.deepEqual(
    created.entries.map((entry) => [entry.path, entry.status]),
    [['fresh.ts', 'A']],
  );
  await assert.rejects(
    service.call('diff', { scope: 'elsewhere' }),
    /invalid diff scope/,
  );
});
