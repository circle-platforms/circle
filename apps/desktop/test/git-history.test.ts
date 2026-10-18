import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  GitWorkspaceService,
  type GitHistory,
  type GitCommitDiff,
} from '../src/workspace/git.ts';

import { validateWorkspaceRequest } from '../src/workspace-protocol.ts';
function call(
  git: GitWorkspaceService,
  method: string,
  params: Record<string, unknown> = {},
) {
  const request = validateWorkspaceRequest({ service: 'git', method, params });
  return git.call(request.method, request.params);
}

async function fixture(
  run: (git: GitWorkspaceService, root: string) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-history-'));
  const git = new GitWorkspaceService(root);
  try {
    await git.git(['init', '-b', 'main']);
    await git.git(['config', 'core.autocrlf', 'false']);
    await git.git(['config', 'user.name', 'History Test']);
    await git.git(['config', 'user.email', 'history@example.invalid']);
    await run(git, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function commit(git: GitWorkspaceService, message: string) {
  await git.git(['add', '--all']);
  await git.git(['commit', '-m', message]);
  return (await git.git(['rev-parse', 'HEAD'])).trim();
}

test('history pages are bounded and anchored; browsing root and historical changes never writes the worktree, index or refs', async () => {
  await fixture(async (git, root) => {
    assert.deepEqual(await call(git, 'history'), {
      head: '',
      commits: [],
      offset: 0,
      hasMore: false,
    });
    await writeFile(path.join(root, 'original.txt'), 'initial\n');
    const first = await commit(git, 'Initial document');
    await rename(
      path.join(root, 'original.txt'),
      path.join(root, 'renamed.txt'),
    );
    await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
    const second = await commit(git, 'Rename and add binary');
    const firstPage = (await call(git, 'history', { limit: 1 })) as GitHistory;
    assert.equal(firstPage.head, second);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.commits[0]!.subject, 'Rename and add binary');
    assert.equal(firstPage.commits[0]!.author, 'History Test');
    await writeFile(path.join(root, 'later.txt'), 'later\n');
    await commit(git, 'Later commit');
    const next = (await call(git, 'history', {
      head: firstPage.head,
      offset: 1,
      limit: 1,
    })) as GitHistory;
    assert.deepEqual(
      next.commits.map((entry) => entry.id),
      [first],
    );
    assert.equal(next.hasMore, false);
    await writeFile(
      path.join(root, 'renamed.txt'),
      'uncommitted working bytes\n',
    );
    await writeFile(path.join(root, 'staged.txt'), 'staged bytes\n');
    await git.git(['add', 'staged.txt']);
    const indexFile = path.resolve(
      root,
      (await git.git(['rev-parse', '--git-path', 'index'])).trim(),
    );
    const before = {
      index: await readFile(indexFile),
      head: await git.git(['rev-parse', 'HEAD']),
      refs: await git.git(['show-ref']),
      status: await git.git(['status', '--porcelain=v1', '-z']),
    };
    const rootDiff = (await call(git, 'commitDiff', {
      commit: first,
    })) as GitCommitDiff;
    assert.equal(rootDiff.parent, null);
    assert.match(rootDiff.text, /\+initial/);
    assert.deepEqual(rootDiff.entries, [
      { path: 'original.txt', status: 'A', added: 1, removed: 0 },
    ]);
    const historical = (await call(git, 'commitDiff', {
      commit: second,
    })) as GitCommitDiff;
    assert.equal(historical.parent, first);
    assert.deepEqual(historical.entries, [
      { path: 'binary.bin', status: 'A', added: null, removed: null },
      { path: 'original.txt', status: 'D', added: 0, removed: 1 },
      { path: 'renamed.txt', status: 'A', added: 1, removed: 0 },
    ]);
    assert.match(historical.text, /Binary files/);
    const scoped = (await call(git, 'commitDiff', {
      commit: second,
      paths: ['renamed.txt'],
    })) as GitCommitDiff;
    assert.deepEqual(scoped.entries, [
      { path: 'renamed.txt', status: 'A', added: 1, removed: 0 },
    ]);
    assert.match(scoped.text, /\+initial/);
    assert.doesNotMatch(scoped.text, /uncommitted/);
    assert.deepEqual(await readFile(indexFile), before.index);
    assert.equal(
      await readFile(path.join(root, 'renamed.txt'), 'utf8'),
      'uncommitted working bytes\n',
    );
    assert.equal(await git.git(['rev-parse', 'HEAD']), before.head);
    assert.equal(await git.git(['show-ref']), before.refs);
    assert.equal(
      await git.git(['status', '--porcelain=v1', '-z']),
      before.status,
    );
  });
});

test('merge history has explicit first-parent diff and rejects options, symbolic revisions and escaping paths', async () => {
  await fixture(async (git, root) => {
    await writeFile(path.join(root, 'base.txt'), 'base\n');
    await commit(git, 'Base');
    await git.git(['switch', '-c', 'topic']);
    await writeFile(path.join(root, 'topic.txt'), 'topic\n');
    await commit(git, 'Topic');
    await git.git(['switch', 'main']);
    await writeFile(path.join(root, 'main.txt'), 'main\n');
    const parent = await commit(git, 'Main');
    await git.git(['merge', '--no-ff', 'topic', '-m', 'Merge topic']);
    const id = (await git.git(['rev-parse', 'HEAD'])).trim();
    const diff = (await call(git, 'commitDiff', {
      commit: id,
    })) as GitCommitDiff;
    assert.equal(diff.parent, parent);
    assert.deepEqual(diff.entries, [
      { path: 'topic.txt', status: 'A', added: 1, removed: 0 },
    ]);
    const history = (await call(git, 'history')) as GitHistory;
    assert.equal(history.commits[0]!.parents.length, 2);
    for (const params of [
      { limit: 0 },
      { limit: 101 },
      { offset: -1 },
      { head: '--output=escape' },
    ])
      await assert.rejects(call(git, 'history', params));
    for (const value of ['HEAD', '--output=escape', id + '\n', '0'.repeat(40)])
      await assert.rejects(call(git, 'commitDiff', { commit: value }));
    await assert.rejects(
      call(git, 'commitDiff', { commit: id, paths: ['../outside'] }),
      /repository-relative/,
    );
    await assert.rejects(
      call(git, 'commitDiff', { commit: id, paths: [] }),
      /repository-relative/,
    );
    const changes = (await call(git, 'diff', {
      scope: 'branch',
      base: 'topic',
    })) as GitCommitDiff;
    assert.deepEqual(changes.entries, [
      { path: 'main.txt', status: 'A', added: 1, removed: 0 },
    ]);
  });
});

test('an explicit diff revision rejects changes during inspection instead of pairing stale text with current statistics', async () => {
  await fixture(async (setup, root) => {
    await writeFile(path.join(root, 'file.txt'), 'baseline\n');
    await commit(setup, 'Base');
    await writeFile(path.join(root, 'file.txt'), 'first edit\n');
    const expected = await setup.snapshot();
    class RacingDiff extends GitWorkspaceService {
      changed = false;
      override async git(args: string[], input?: string) {
        const result = await super.git(args, input);
        if (args[0] === 'diff' && !this.changed) {
          this.changed = true;
          await writeFile(path.join(root, 'file.txt'), 'external edit\n');
        }
        return result;
      }
    }
    const racing = new RacingDiff(root);
    await assert.rejects(
      racing.call('diff', { revision: expected.revision, paths: ['file.txt'] }),
      /changed while inspecting/,
    );
    assert.equal(
      await readFile(path.join(root, 'file.txt'), 'utf8'),
      'external edit\n',
    );
    assert.equal((await setup.git(['diff', '--cached'])).trim(), '');
    await assert.rejects(
      setup.call('diff', { revision: expected.revision }),
      /repository changed/,
    );
  });
});
