import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  githubSlug,
  PullRequestReader,
  summarizeChecks,
  summarizePullRequest,
  type GhRunner,
} from '../src/workspace/pulls.ts';

const exec = promisify(execFile);
// The gh the application ships, prepared for the runtime tests.
const bundledGh =
  process.env.CIRCLE_TEST_BUNDLED_GH ??
  fileURLToPath(
    new URL(
      `../dist/tools/gh/bin/${process.platform === 'win32' ? 'gh.exe' : 'gh'}`,
      import.meta.url,
    ),
  );

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
  const quiet: string[][] = [];
  const gh: GhRunner = async (args, options) => {
    asked.push(args);
    if (options?.quiet) quiet.push(args);
    const key = args.slice(0, 2).join(' ');
    const answer = answers[key] ?? answers[args[0]!];
    if (answer === undefined) throw Error(`unexpected gh ${args.join(' ')}`);
    if (answer instanceof Error) throw answer;
    // What a quiet call prints is never read.
    return options?.quiet ? '' : answer;
  };
  return { gh, asked, quiet };
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
    'auth token': 'gho_fixture',
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
    'auth token': 'gho_fixture',
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
      'auth token': 'gho_fixture',
      'pr view': JSON.stringify(pullRow({ state })),
      'pr list': JSON.stringify([pullRow({ state })]),
    });
    const overview = await new PullRequestReader(root, { gh }).overview();
    assert.equal(overview.access, 'ready', state);
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
    'auth token': 'gho_fixture',
    'pr list': '[]',
  });
  const overview = await new PullRequestReader(root, { gh }).overview();
  assert.equal(overview.access, 'ready');
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
    'auth token': new Error('no oauth token found for github.com'),
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

/**
 * A `gh` with sign-ins as gh keeps them, the first account of a host its active one:
 * `auth status` tries every account of every host, or of the one named, against GitHub;
 * `auth token` reads the active account's token of one host without asking GitHub; and
 * reading pull requests asks GitHub.
 */
function ghWorld(world: {
  hosts: Record<string, readonly { token: string; broken?: boolean }[]>;
  offline?: boolean;
  revoked?: boolean;
  view?: string | Error;
}) {
  const asked: { args: string[]; quiet: boolean }[] = [];
  const gh: GhRunner = async (args, options) => {
    const quiet = !!options?.quiet;
    asked.push({ args, quiet });
    const hostname = args.includes('--hostname')
      ? args[args.indexOf('--hostname') + 1]!
      : undefined;
    if (args[0] === '--version') return 'gh version 2.83.2';
    if (args[0] === 'auth' && args[1] === 'status') {
      const accounts = Object.entries(world.hosts)
        .filter(([host]) => !hostname || host === hostname)
        .flatMap(([, list]) =>
          args.includes('--active') ? list.slice(0, 1) : list,
        );
      if (!accounts.length)
        throw Error('You are not logged into any GitHub hosts.');
      if (world.offline || accounts.some((account) => account.broken))
        throw Error('X Failed to log in: the token is invalid.');
      return 'Logged in';
    }
    if (args[0] === 'auth' && args[1] === 'token') {
      const active = world.hosts[hostname ?? 'github.com']?.[0];
      if (!active) throw Error(`no oauth token found for ${hostname}`);
      return quiet ? '' : active.token;
    }
    if (args[0] === 'pr') {
      if (world.offline)
        throw Error(
          'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host',
        );
      if (world.revoked)
        throw Error(
          'HTTP 401: Bad credentials (https://api.github.com/graphql)',
        );
      if (args[1] === 'view') {
        const view =
          world.view ??
          Error('no pull requests found for branch "fix/reconnect"');
        if (view instanceof Error) throw view;
        return view;
      }
      if (args[1] === 'list') return '[]';
    }
    throw Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, asked };
}

test('the sign-in for github.com is what counts: an account failing beside it, a GitHub Enterprise login or being offline does not sign it out', async (t) => {
  const { root } = await repository(t, {
    remote: 'https://github.com/acme/orbit.git',
    branch: 'fix/reconnect',
  });
  const read = (world: ReturnType<typeof ghWorld>) =>
    new PullRequestReader(root, { gh: world.gh }).overview();
  for (const [what, hosts] of [
    [
      'a second account that fails',
      {
        'github.com': [
          { token: 'gho_active' },
          { token: 'gho_old', broken: true },
        ],
      },
    ],
    [
      'a GitHub Enterprise login that fails',
      {
        'github.com': [{ token: 'gho_active' }],
        'ghe.example.com': [{ token: 'gho_enterprise', broken: true }],
      },
    ],
  ] as const) {
    const world = ghWorld({ hosts, view: JSON.stringify(pullRow()) });
    // What the reader asked before: gh's own answer for every account and host.
    await assert.rejects(world.gh(['auth', 'status']), /Failed to log in/);
    world.asked.length = 0;
    const overview = await read(world);
    assert.equal(overview.access, 'ready', what);
    assert.equal(overview.current?.number, 186, what);
    assert.deepEqual(
      world.asked.filter((call) => call.args[0] === 'auth'),
      [{ args: ['auth', 'token', '--hostname', 'github.com'], quiet: true }],
      'github.com alone is asked about, and its token is not read',
    );
  }

  // Offline: the sign-in is there and GitHub does not answer. That is not signed out,
  // and a branch whose pull request cannot be read is not taken for one without.
  const offline = ghWorld({
    hosts: { 'github.com': [{ token: 'gho_active' }] },
    offline: true,
  });
  await assert.rejects(
    offline.gh(['auth', 'status', '--hostname', 'github.com', '--active']),
    /Failed to log in/,
    'gh cannot tell offline from a bad token',
  );
  const away = await read(offline);
  assert.equal(away.access, 'unreachable');
  assert.equal(away.current, null);
  assert.deepEqual(away.recent, []);
  assert.equal(away.git.github, 'acme/orbit', 'the repository is described');

  // A failure of GitHub's own is not the absence of a pull request either.
  const failing = ghWorld({
    hosts: { 'github.com': [{ token: 'gho_active' }] },
    view: Error('HTTP 502: Server Error (https://api.github.com/graphql)'),
  });
  assert.equal((await read(failing)).access, 'unreachable');

  // A sign-in only for another host is no sign-in for github.com: nothing is read.
  const elsewhere = ghWorld({
    hosts: { 'ghe.example.com': [{ token: 'gho_enterprise' }] },
  });
  assert.equal((await read(elsewhere)).access, 'signed-out');
  assert.ok(!elsewhere.asked.some((call) => call.args[0] === 'pr'));
  // A sign-in GitHub refuses is signed out.
  const revoked = ghWorld({
    hosts: { 'github.com': [{ token: 'gho_revoked' }] },
    revoked: true,
  });
  assert.equal((await read(revoked)).access, 'signed-out');
});

test('the gh the application ships keeps a github.com sign-in signed in when the computer is offline and an Enterprise login fails', async (t) => {
  const { root } = await repository(t, {
    remote: 'https://github.com/acme/orbit.git',
    branch: 'fix/reconnect',
  });
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'pulls-gh-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  // A proxy that answers nothing: every request of gh's fails as it would offline,
  // and nothing leaves this computer.
  const proxy = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
  const { port } = proxy.address() as AddressInfo;
  const config = async (name: string, hosts: string) => {
    const folder = join(scratch, name);
    await mkdir(folder);
    await writeFile(join(folder, 'hosts.yml'), hosts);
    return folder;
  };
  const account = (host: string, user: string, token: string) =>
    `${host}:\n    users:\n        ${user}:\n            oauth_token: ${token}\n    git_protocol: https\n    oauth_token: ${token}\n    user: ${user}\n`;
  const signedIn = await config(
    'signed-in',
    account('github.com', 'fixture', 'gho_fixturefixturefixture000000000000') +
      account(
        'ghe.example.invalid',
        'other',
        'gho_brokenbrokenbroken0000000000000',
      ),
  );
  // The reader runs gh with the application's environment: this test's own, for now.
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  for (const key of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'GH_HOST',
    'NO_PROXY',
    'no_proxy',
  ])
    delete process.env[key];
  Object.assign(process.env, {
    HOME: scratch,
    USERPROFILE: scratch,
    HTTPS_PROXY: `http://127.0.0.1:${port}`,
    HTTP_PROXY: `http://127.0.0.1:${port}`,
    https_proxy: `http://127.0.0.1:${port}`,
    http_proxy: `http://127.0.0.1:${port}`,
  });
  const read = () =>
    new PullRequestReader(root, { ghPath: bundledGh }).overview();
  process.env.GH_CONFIG_DIR = signedIn;
  const offline = await read();
  assert.equal(offline.access, 'unreachable');
  assert.equal(offline.current, null);
  // GH_CONFIG_DIR does not isolate the operating system's credential store.
  // The no-github.com-account case belongs to ghWorld above, where it can be
  // measured without depending on (or reading) the person's native sign-in.
});

/** A `gh` for a workflow run whose first jobs failed while one still runs. */
function runWorld(failed: number, options: { secret?: string } = {}) {
  const api = 'https://api.github.com/repos/acme/orbit/actions';
  const head = 'a'.repeat(40);
  const job = (id: number, status: string, conclusion: string | null) => ({
    id,
    run_id: 12,
    run_attempt: 1,
    head_sha: head,
    run_url: `${api}/runs/12`,
    url: `${api}/jobs/${id}`,
    name: `test ${id}`,
    status,
    conclusion,
  });
  const jobs = [
    ...Array.from({ length: failed }, (_, index) =>
      job(100 + index, 'completed', 'failure'),
    ),
    job(200, 'in_progress', null),
  ];
  return fakeGhCalls((args) => {
    if (args[0] === 'run' && args[1] === 'view')
      throw Error(
        'run 12 is still in progress; logs will be available when it is complete',
      );
    if (args[0] === 'repo' && args[1] === 'view')
      return JSON.stringify({
        nameWithOwner: 'acme/orbit',
        url: 'https://github.com/acme/orbit',
      });
    assert.deepEqual(args.slice(0, 3), ['api', '--hostname', 'github.com']);
    const path = args[3]!;
    if (path === 'repos/acme/orbit/actions/runs/12')
      return JSON.stringify({
        id: 12,
        run_attempt: 1,
        head_sha: head,
        status: 'in_progress',
        url: `${api}/runs/12`,
        repository: { full_name: 'acme/orbit' },
      });
    if (path.startsWith('repos/acme/orbit/actions/runs/12/attempts/1/jobs?'))
      return JSON.stringify({ total_count: jobs.length, jobs });
    const log = /^repos\/acme\/orbit\/actions\/jobs\/(\d+)\/logs$/.exec(path);
    if (log)
      return `start of job ${log[1]}\n${'noise\n'.repeat(20_000)}${options.secret ?? ''}\nassertion failed in job ${log[1]}\n`;
    const detail = /^repos\/acme\/orbit\/actions\/jobs\/(\d+)$/.exec(path);
    if (detail)
      return JSON.stringify(jobs.find((item) => item.id === Number(detail[1])));
    throw Error(`unexpected gh ${args.join(' ')}`);
  });
}
/** A `gh` that answers by a function and records what it was asked. */
function fakeGhCalls(answer: (args: string[]) => string) {
  const asked: string[][] = [];
  const gh: GhRunner = async (args) => {
    asked.push(args);
    return answer(args);
  };
  return { gh, asked };
}

test('failed CI logs of a run that still runs are read from the jobs that already failed, bounded and with credentials hidden', async (t) => {
  const { root } = await repository(t, {
    remote: 'https://github.com/acme/orbit.git',
  });
  const secret = 'ghp_' + 'x'.repeat(36);
  const { gh, asked } = runWorld(12, { secret });
  const log = await new PullRequestReader(root, { gh }).failedLog(12);
  assert.match(
    log.text,
    /^workflow run 12, attempt 1: completed failed job logs; other jobs are still running; 2 more failed jobs left out\n/,
  );
  assert.equal(log.truncated, true);
  // Ten jobs, each its tail, the earliest first.
  assert.equal(
    log.text.match(/^=== test \d+ \(job \d+, failure\) ===$/gm)?.length,
    10,
  );
  for (let id = 100; id < 110; id++)
    assert.match(log.text, new RegExp(`assertion failed in job ${id}\\n`));
  assert.doesNotMatch(log.text, /job 110|job 111|start of job/);
  assert.ok(log.text.length < 10 * 33 * 1024, String(log.text.length));
  assert.ok(!log.text.includes(secret), 'a token in a log is hidden');
  assert.match(log.text, /\[redacted\]/);
  assert.deepEqual(asked[0], ['run', 'view', '12', '--log-failed']);
  assert.equal(
    asked.filter((args) => /\/logs$/.test(args[3] ?? '')).length,
    10,
    'the jobs left out are not downloaded',
  );
  assert.ok(
    !asked.some((args) => (args[3] ?? '').endsWith('/jobs/200/logs')),
    'the job still running is not read',
  );
});

test('a complete run keeps the whole failed log path, bounded to ten jobs with credentials hidden, and says when neither path can read it', async (t) => {
  const { root } = await repository(t, {
    remote: 'https://github.com/acme/orbit.git',
  });
  const secret = 'github_pat_' + 'y'.repeat(30);
  const lines = Array.from(
    { length: 12 },
    (_, job) => `job ${job}\tstep\tfailure ${job} ${secret}`,
  );
  const whole = fakeGh({ run: lines.join('\n') });
  const log = await new PullRequestReader(root, { gh: whole.gh }).failedLog(7);
  assert.equal(log.truncated, true);
  assert.match(log.text, /failure 9 \[redacted\]/);
  assert.doesNotMatch(log.text, /failure 10|failure 11/);
  assert.match(log.text, /\[2 more failed jobs left out\]$/);
  assert.ok(!log.text.includes(secret));
  assert.deepEqual(whole.asked, [['run', 'view', '7', '--log-failed']]);

  const neither = fakeGhCalls((args) => {
    throw Error(`no answer to ${args.slice(0, 2).join(' ')} ${secret}`);
  });
  const reader = new PullRequestReader(root, { gh: neither.gh });
  await assert.rejects(reader.failedLog(7), (error: Error) => {
    assert.match(error.message, /failed logs are unavailable/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
});
