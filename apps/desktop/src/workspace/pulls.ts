import { execFile, spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  boundFailedRunLog,
  completedFailedJobLogs,
  redactGitHubCredentials,
} from './delivery.ts';
import { GitWorkspaceService } from './git.ts';
import type {
  PullRequestAccess,
  PullRequestChecks,
  PullRequestOverview,
  PullRequestSummary,
  RepositorySummary,
} from './pulls-types.ts';

export type * from './pulls-types.ts';

const exec = promisify(execFile);
const GH_TIMEOUT = 20_000;
const RECENT_LIMIT = 6;
const UNTRACKED_LINE_LIMIT = 1024 * 1024;
const UNTRACKED_FILE_LIMIT = 200;
/** The failed jobs whose logs one copy holds, each cut to its tail. */
const FAILED_JOBS_COPIED = 10;

/**
 * Runs `gh` with these arguments and gives what it printed. `quiet` asks only whether it
 * succeeded: what it prints is not read at all.
 */
export type GhRunner = (
  args: string[],
  options?: { quiet?: boolean },
) => Promise<string>;

const EMPTY_GIT: RepositorySummary = {
  repository: false,
  branch: '',
  defaultBranch: '',
  github: '',
  files: 0,
  additions: 0,
  deletions: 0,
  ahead: 0,
  unpushed: 0,
};

function runGh(root: string, ghPath: string): GhRunner {
  const env = {
    ...process.env,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_PAGER: 'cat',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  return async (args, { quiet = false } = {}) => {
    if (quiet) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(ghPath, args, {
          cwd: root,
          env,
          stdio: 'ignore',
          timeout: GH_TIMEOUT,
        });
        child.once('error', reject);
        child.once('exit', (code, signal) =>
          code === 0
            ? resolve()
            : reject(
                Error(`gh ${args.slice(0, 2).join(' ')}: ${signal ?? code}`),
              ),
        );
      });
      return '';
    }
    return (
      await exec(ghPath, args, {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: GH_TIMEOUT,
        env,
      })
    ).stdout;
  };
}

/**
 * Why a read of GitHub failed: a sign-in GitHub refused, or no answer, as when the
 * computer is offline or GitHub fails.
 */
function readFailure(error: unknown): 'signed-out' | 'unreachable' {
  return /\bHTTP 401\b|bad credentials/i.test(String(error))
    ? 'signed-out'
    : 'unreachable';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** What a `gh pr` JSON row says, or nothing when it does not look like one. */
export function summarizePullRequest(
  value: unknown,
): PullRequestSummary | undefined {
  const row = record(value);
  if (!row) return undefined;
  const number = row.number;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1)
    return undefined;
  const state = text(row.state).toUpperCase();
  const summary: PullRequestSummary = {
    number,
    title: text(row.title),
    url: text(row.url),
    state:
      state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open',
    draft: row.isDraft === true,
    headRef: text(row.headRefName),
  };
  if (Array.isArray(row.statusCheckRollup)) {
    const { checks, failedRunId } = summarizeChecks(row.statusCheckRollup);
    summary.checks = checks;
    if (failedRunId !== undefined) summary.failedRunId = failedRunId;
  }
  return summary;
}

const FAILED_CONCLUSIONS = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);

/** One word for a pull request's checks, and the run to read when one failed. */
export function summarizeChecks(rollup: unknown[]): {
  checks: PullRequestChecks;
  failedRunId?: number;
} {
  let failing = false;
  let running = false;
  let failedRunId: number | undefined;
  for (const item of rollup) {
    const row = record(item);
    if (!row) continue;
    // A check run has a status and, once it finished, a conclusion. A commit
    // status has only a state.
    const status = text(row.status).toUpperCase();
    const conclusion = text(row.conclusion).toUpperCase();
    const state = text(row.state).toUpperCase();
    const failed =
      FAILED_CONCLUSIONS.has(conclusion) ||
      state === 'FAILURE' ||
      state === 'ERROR';
    if (failed) {
      failing = true;
      const run = /\/actions\/runs\/(\d+)/.exec(
        text(row.detailsUrl) || text(row.targetUrl),
      );
      if (run) {
        const id = Number(run[1]);
        if (Number.isSafeInteger(id) && id > (failedRunId ?? 0))
          failedRunId = id;
      }
    } else if (
      (status && status !== 'COMPLETED') ||
      state === 'PENDING' ||
      state === 'EXPECTED'
    )
      running = true;
  }
  return {
    checks: failing
      ? 'failing'
      : running
        ? 'running'
        : rollup.length
          ? 'passing'
          : 'none',
    ...(failedRunId !== undefined ? { failedRunId } : {}),
  };
}

export function githubSlug(remote: string): string {
  const url = remote
    .trim()
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
    .replace(/\.git$/, '');
  return /^https:\/\/github\.com\/([-\w.]+\/[-\w.]+)$/.exec(url)?.[1] ?? '';
}

/**
 * What the overview shows about a folder's repository and its pull requests. It asks
 * `gh` with the person's own sign-in, the one the create-pr skill uses, so what Circle
 * opened is what shows here. The application passes the `gh` it ships. Nothing it reads
 * is written back.
 */
export class PullRequestReader {
  readonly git: GitWorkspaceService;
  private readonly gh: GhRunner;
  private readonly root: string;

  constructor(root: string, options: { ghPath?: string; gh?: GhRunner } = {}) {
    this.root = root;
    this.git = new GitWorkspaceService(root);
    this.gh = options.gh ?? runGh(root, options.ghPath ?? 'gh');
  }

  async call(method: string, params: Record<string, unknown>) {
    if (method === 'overview') return this.overview();
    if (method === 'failedLog') return this.failedLog(params.runId);
    throw Error('unknown pull request method');
  }

  async overview(): Promise<PullRequestOverview> {
    const git = await this.repository().catch(() => EMPTY_GIT);
    if (!git.repository || !git.github)
      return { git, access: 'unavailable', current: null, recent: [] };
    const access = await this.access();
    if (access !== 'ready') return { git, access, current: null, recent: [] };
    const onDefault = !git.branch || git.branch === git.defaultBranch;
    // A read that fails says why; only gh's own answer that the branch has none means no
    // pull request, so a computer offline never turns update into create.
    const [current, recent] = await Promise.all([
      onDefault
        ? { pull: null }
        : this.gh([
            'pr',
            'view',
            git.branch,
            '--json',
            'number,title,url,state,isDraft,headRefName,statusCheckRollup',
          ]).then(
            (out) => ({ pull: summarizePullRequest(JSON.parse(out)) ?? null }),
            (error: unknown) =>
              /no pull requests found/i.test(String(error))
                ? { pull: null }
                : { failure: readFailure(error) },
          ),
      this.gh([
        'pr',
        'list',
        '--author',
        '@me',
        '--state',
        'all',
        '--limit',
        String(RECENT_LIMIT),
        '--json',
        'number,title,url,state,isDraft,headRefName',
      ]).then(
        (out) => ({
          pulls: (JSON.parse(out) as unknown[])
            .map(summarizePullRequest)
            .filter((item): item is PullRequestSummary => !!item),
        }),
        (error: unknown) => ({ failure: readFailure(error) }),
      ),
    ]);
    if ('failure' in current || 'failure' in recent) {
      const failures = [current, recent].flatMap((read) =>
        'failure' in read ? [read.failure] : [],
      );
      return {
        git,
        access: failures.includes('signed-out') ? 'signed-out' : 'unreachable',
        current: null,
        recent: [],
      };
    }
    const branchPull = current.pull;
    return {
      git,
      access,
      // A branch whose pull request is closed or merged starts another one.
      current: branchPull && branchPull.state === 'open' ? branchPull : null,
      recent: recent.pulls.filter((item) => item.number !== branchPull?.number),
    };
  }

  /**
   * The tail of what failed in one GitHub Actions run: each failed job's last 32 KB, of
   * ten jobs at most, with credentials hidden. While other jobs of the run still run,
   * `gh run view --log-failed` refuses, and the jobs that already failed are read one by
   * one instead.
   */
  async failedLog(
    runId: unknown,
  ): Promise<{ text: string; truncated: boolean }> {
    if (typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId < 1)
      throw Error('valid run id is required');
    let whole: unknown;
    try {
      // Hidden before it is cut, so a credential cannot survive half cut.
      return boundFailedRunLog(
        redactGitHubCredentials(
          await this.gh(['run', 'view', String(runId), '--log-failed']),
        ),
        { maxJobs: FAILED_JOBS_COPIED },
      );
    } catch (error) {
      whole = error;
    }
    try {
      const { text, truncated } = await completedFailedJobLogs(
        (args) => this.gh(args),
        runId,
        (text) => redactGitHubCredentials(text),
        { maxJobs: FAILED_JOBS_COPIED },
      );
      return { text, truncated };
    } catch (jobs) {
      throw Error(
        redactGitHubCredentials(
          `failed logs are unavailable: ${String(whole)}\ncompleted jobs: ${String(jobs)}`,
        ),
      );
    }
  }

  /**
   * Whether `gh` holds a sign-in for github.com: its active account there, or GH_TOKEN.
   * `gh auth token` reads it without asking GitHub, so an account that fails beside it, a
   * GitHub Enterprise host or a computer offline cannot make it look signed out; what it
   * prints is not read. Whether GitHub takes the sign-in shows when pull requests are read.
   */
  private async access(): Promise<PullRequestAccess> {
    try {
      await this.gh(['--version']);
    } catch {
      return 'missing';
    }
    try {
      await this.gh(['auth', 'token', '--hostname', 'github.com'], {
        quiet: true,
      });
    } catch {
      return 'signed-out';
    }
    return 'ready';
  }

  private async repository(): Promise<RepositorySummary> {
    const inside = await this.git
      .git(['rev-parse', '--is-inside-work-tree'])
      .then(
        (out) => out.trim() === 'true',
        () => false,
      );
    if (!inside) return EMPTY_GIT;
    const read = (args: string[]) =>
      this.git.git(args).then(
        (out) => out.trim(),
        () => '',
      );
    const [branch, remote, originHead, upstream] = await Promise.all([
      read(['symbolic-ref', '--short', '-q', 'HEAD']),
      read(['remote', 'get-url', 'origin']),
      read(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']),
      read([
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        '@{upstream}',
      ]),
    ]);
    let defaultBranch = /^refs\/remotes\/origin\/(.+)$/.exec(originHead)?.[1];
    for (const name of defaultBranch ? [] : ['main', 'master'])
      if (await read(['rev-parse', '--verify', '--quiet', `origin/${name}`])) {
        defaultBranch = name;
        break;
      }
    defaultBranch ??= '';
    const count = async (range: string) =>
      Number(await read(['rev-list', '--count', range])) || 0;
    const ahead = defaultBranch
      ? await count(`origin/${defaultBranch}..HEAD`)
      : 0;
    const unpushed = upstream ? await count(`${upstream}..HEAD`) : ahead;
    return {
      repository: true,
      branch,
      defaultBranch,
      github: githubSlug(remote),
      ...(await this.workingTree()),
      ahead,
      unpushed,
    };
  }

  /** Files that differ from HEAD, with the lines added and removed. */
  private async workingTree() {
    const status = await this.git
      .git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
      .catch(() => '');
    const paths: { path: string; untracked: boolean }[] = [];
    const fields = status.split('\0');
    for (let i = 0; i < fields.length; i++) {
      const row = fields[i];
      if (!row) continue;
      paths.push({ path: row.slice(3), untracked: row.startsWith('??') });
      if (/[RC]/.test(row.slice(0, 2))) i++;
    }
    let additions = 0;
    let deletions = 0;
    const numstat = await this.git
      .git(['diff', '--numstat', '-z', 'HEAD'])
      .catch(() => '');
    // With -z a numstat row is "added\tdeleted\tpath" and a rename carries its two
    // paths as the next fields; only the counts matter here.
    for (const field of numstat.split('\0')) {
      const match = /^(\d+|-)\t(\d+|-)\t/.exec(field);
      if (!match) continue;
      if (match[1] !== '-') additions += Number(match[1]);
      if (match[2] !== '-') deletions += Number(match[2]);
    }
    const untracked = paths.filter((item) => item.untracked);
    for (const item of untracked.slice(0, UNTRACKED_FILE_LIMIT)) {
      const file = path.join(this.root, item.path);
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size > UNTRACKED_LINE_LIMIT) continue;
        const content = await readFile(file, 'utf8');
        if (content.includes('\0')) continue;
        additions +=
          content === ''
            ? 0
            : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
      } catch {
        // A file that vanished or cannot be read adds no lines.
      }
    }
    return { files: paths.length, additions, deletions };
  }
}
