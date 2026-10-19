import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  githubSlug,
  PullRequestReader,
  summarizeChecks,
  summarizePullRequest,
  type GhRunner,
} from '../src/workspace/pulls.ts';

const exec = promisify(execFile);

async function repository(
  t: { after: (action: () => Promise<void>) => void },
  options: { remote?: string; branch?: string } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulls-')));
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
  await writeFile(join(root, 'readme.md'), 'one\ntwo\nthree\n');
  await writeFile(join(root, 'gone.txt'), 'bye\n');
  await git('add', '.');
  await git('commit', '-m', 'Base');
  if (options.remote) await git('remote', 'add', 'origin', options.remote);
  // Remote-tracking refs written by hand, so no network and no second repository.
  const base = await git('rev-parse', 'HEAD');
  await git('update-ref', 'refs/remotes/origin/main', base);
  await git(
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main',
  );
  if (options.branch) await git('switch', '-c', options.branch);
  return { root, git };
}

/** A `gh` that answers from a table and records what it was asked. */
function fakeGh(answers: Record<string, string | Error>) {
  const asked: string[][] = [];
  const gh: GhRunner = async (args) => {
    asked.push(args);
    const key = args.slice(0, 2).join(' ');
    const answer = answers[key] ?? answers[args[0]!];
    if (answer === undefined) throw Error(`unexpected gh ${args.join(' ')}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { gh, asked };
}

const pullRow = (extra: Record<string, unknown> = {}) => ({
  number: 186,
  title: 'Fix the reconnect race',
  url: 'https://github.com/acme/orbit/pull/186',
  state: 'OPEN',
  isDraft: true,
  headRefName: 'fix/reconnect',
  ...extra,
});

test('a pull request row becomes a summary, and a row that is not one is dropped', () => {
  assert.deepEqual(summarizePullRequest(pullRow()), {
    number: 186,
    title: 'Fix the reconnect race',
    url: 'https://github.com/acme/orbit/pull/186',
    state: 'open',
    draft: true,
    headRef: 'fix/reconnect',
  });
  assert.equal(
    summarizePullRequest(pullRow({ state: 'MERGED' }))?.state,
    'merged',
  );
  assert.equal(
    summarizePullRequest(pullRow({ state: 'CLOSED' }))?.state,
    'closed',
  );
  for (const bad of [
    null,
    'x',
    [],
    {},
    { number: 0 },
    { number: 1.5 },
    { number: '7' },
  ])
    assert.equal(summarizePullRequest(bad), undefined);
});

test('checks are one word, and the newest failed run is the one to read', () => {
  assert.deepEqual(summarizeChecks([]), { checks: 'none' });
  assert.deepEqual(
    summarizeChecks([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { state: 'SUCCESS' },
    ]),
    { checks: 'passing' },
  );
  assert.deepEqual(
    summarizeChecks([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'IN_PROGRESS', conclusion: '' },
    ]),
    { checks: 'running' },
  );
  assert.deepEqual(
    summarizeChecks([
      { state: 'PENDING' },
      {
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        detailsUrl: 'https://github.com/acme/orbit/actions/runs/41/job/9',
      },
      {
        status: 'COMPLETED',
        conclusion: 'TIMED_OUT',
        detailsUrl: 'https://github.com/acme/orbit/actions/runs/77/job/3',
      },
    ]),
    // A failure wins over checks still running.
    { checks: 'failing', failedRunId: 77 },
  );
  assert.deepEqual(summarizeChecks([{ state: 'ERROR' }]), {
    checks: 'failing',
  });
});

test('only a github.com remote names a repository', () => {
  for (const remote of [
    'https://github.com/acme/orbit.git',
    'git@github.com:acme/orbit.git',
    'ssh://git@github.com/acme/orbit',
    'https://github.com/acme/orbit\n',
  ])
    assert.equal(githubSlug(remote), 'acme/orbit');
  for (const remote of [
    '',
    'https://gitlab.com/acme/orbit.git',
    'https://github.com.evil.example/acme/orbit',
    '/srv/git/orbit.git',
  ])
    assert.equal(githubSlug(remote), '');
});

test('a folder that is not a repository, or has no GitHub remote, has nothing to ask GitHub', async (t) => {
  const plain = await realpath(await mkdtemp(join(tmpdir(), 'pulls-plain-')));
  t.after(() => rm(plain, { recursive: true, force: true }));
  const { gh, asked } = fakeGh({});
  const none = await new PullRequestReader(plain, { gh }).overview();
  assert.equal(none.git.repository, false);
  assert.equal(none.access, 'unavailable');

  const local = await repository(t);
  const noRemote = await new PullRequestReader(local.root, { gh }).overview();
  assert.equal(noRemote.git.repository, true);
  assert.equal(noRemote.git.github, '');
  assert.equal(noRemote.access, 'unavailable');
  assert.deepEqual(
    asked,
    [],
    'gh is never asked about a folder GitHub does not know',
  );
});

test('the working tree counts changed and new files with their lines, and the branch counts its commits', async (t) => {
  const { root, git } = await repository(t, {
    remote: 'https://github.com/acme/orbit.git',
    branch: 'fix/reconnect',
  });
  // One commit ahead of main.
  await writeFile(join(root, 'committed.txt'), 'a\nb\n');
  await git('add', 'committed.txt');
  await git('commit', '-m', 'Ahead');
  // Modified (+1 -1), deleted, untracked with three lines, and one that is binary.
  await writeFile(join(root, 'readme.md'), 'one\n2\nthree\n');
  await rm(join(root, 'gone.txt'));
  await writeFile(join(root, 'fresh.ts'), 'x\ny\nz\n');
  await writeFile(join(root, 'image.bin'), Buffer.from([0, 1, 2, 0, 4]));
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', 'deep.txt'), 'no trailing newline');

  const { gh } = fakeGh({
    '--version': 'gh version 2.83.2',
    'auth status': 'Logged in',
    'pr view': new Error('no pull requests found for branch'),
    'pr list': '[]',
  });
  const overview = await new PullRequestReader(root, { gh }).overview();
  assert.equal(overview.access, 'ready');
  assert.equal(overview.git.branch, 'fix/reconnect');
  assert.equal(overview.git.defaultBranch, 'main');
  assert.equal(overview.git.github, 'acme/orbit');
  assert.equal(overview.git.ahead, 1);
  // No upstream: everything the branch has is unpushed.
  assert.equal(overview.git.unpushed, 1);
  // readme, gone, fresh, image, nested/deep
  assert.equal(overview.git.files, 5);
  assert.equal(overview.git.additions, 1 + 3 + 1, 'modified + fresh + deep');
  assert.equal(overview.git.deletions, 1 + 1, 'modified + gone');
  assert.equal(overview.current, null);
});

test("the branch's open pull request is the current one, and the other pull requests list after it", async (t) => {
  const { root } = await repository(t, {
    remote: 'git@github.com:acme/orbit.git',
    branch: 'fix/reconnect',
  });
  const { gh, asked } = fakeGh({
    '--version': 'gh version 2.83.2',
    'auth status': 'Logged in',
    'pr view': JSON.stringify(
      pullRow({
        statusCheckRollup: [
          {
            status: 'COMPLETED',
            conclusion: 'FAILURE',
            detailsUrl: 'https://github.com/acme/orbit/actions/runs/12/job/1',
          },
        ],
      }),
    ),
    'pr list': JSON.stringify([
      pullRow(),
      pullRow({
        number: 181,
        title: 'Retry with backoff',
        state: 'MERGED',
        isDraft: false,
        headRefName: 'feat/backoff',
      }),
      { nope: true },
    ]),
  });
  const overview = await new PullRequestReader(root, { gh }).overview();
  assert.equal(overview.current?.number, 186);
  assert.equal(overview.current?.checks, 'failing');
  assert.equal(overview.current?.failedRunId, 12);
  assert.deepEqual(
    overview.recent.map((item) => [item.number, item.state]),
    [[181, 'merged']],
    'the current one is not listed twice and a malformed row is skipped',
  );
  assert.ok(
    asked.some(
      (args) =>
        args[0] === 'pr' && args[1] === 'view' && args[2] === 'fix/reconnect',
    ),
  );
  assert.ok(
    asked.some((args) => args.join(' ').startsWith('pr list --author @me')),
  );
});

test('a branch whose pull request was merged or closed has no current pull request', async (t) => {
  const { root } = await repository(t, {
    remote: 'https://github.com/acme/orbit.git',
    branch: 'fix/reconnect',
  });
  for (const state of ['MERGED', 'CLOSED']) {
    const { gh } = fakeGh({
      '--version': 'gh',
      'auth status': 'ok',
      'pr view': JSON.stringify(pullRow({ state })),
      'pr list': JSON.stringify([pullRow({ state })]),
    });
    const overview = await new PullRequestReader(root, { gh }).overview();
    assert.equal(overview.current, null, state);
    assert.deepEqual(
      overview.recent.map((item) => item.number),
      [],
      'it is the current one, listed or not',
    );
  }
});

test('on the default branch the branch has no pull request to look for', async (t) => {
  const { root } = await repository(t, {
    remote: 'https://github.com/acme/orbit.git',
  });
  const { gh, asked } = fakeGh({
    '--version': 'gh',
    'auth status': 'ok',
    'pr list': '[]',
  });
  const overview = await new PullRequestReader(root, { gh }).overview();
  assert.equal(overview.git.branch, 'main');
  assert.equal(overview.current, null);
  assert.ok(!asked.some((args) => args[1] === 'view'));
});

test('a missing or signed-out gh says why and reads nothing else', async (t) => {
  const { root } = await repository(t, {
    remote: 'https://github.com/acme/orbit.git',
    branch: 'fix/reconnect',
  });
  const missing = fakeGh({ '--version': new Error('spawn gh ENOENT') });
  const gone = await new PullRequestReader(root, { gh: missing.gh }).overview();
  assert.equal(gone.access, 'missing');
  assert.equal(
    gone.git.github,
    'acme/orbit',
    'the repository is still described',
  );
  assert.deepEqual(missing.asked, [['--version']]);

  const signedOut = fakeGh({
    '--version': 'gh',
    'auth status': new Error('not logged in'),
  });
  const out = await new PullRequestReader(root, {
    gh: signedOut.gh,
  }).overview();
  assert.equal(out.access, 'signed-out');
  assert.equal(out.current, null);
  assert.deepEqual(out.recent, []);
});

test("a failed run's log is bounded per job and only a real run id is read", async (t) => {
  const { root } = await repository(t, {
    remote: 'https://github.com/acme/orbit.git',
  });
  const lines = Array.from({ length: 4000 }, (_, i) => `test\tstep\tline ${i}`);
  const { gh, asked } = fakeGh({ run: lines.join('\n') });
  const reader = new PullRequestReader(root, { gh });
  const log = await reader.failedLog(12);
  assert.equal(log.truncated, true);
  assert.ok(log.text.length < 40 * 1024);
  assert.ok(log.text.includes('line 3999'), 'the tail is what is kept');
  assert.deepEqual(asked, [['run', 'view', '12', '--log-failed']]);
  for (const bad of [0, -3, 1.5, '12', undefined, null, 2 ** 60])
    await assert.rejects(reader.failedLog(bad), /valid run id/);
  await assert.rejects(reader.call('merge', {}), /unknown pull request method/);
});
