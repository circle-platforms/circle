import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { boundFailedRunLog } from './delivery.ts';
import { GitWorkspaceService } from './git.ts';

const exec = promisify(execFile);
const GH_TIMEOUT = 20_000;
const RECENT_LIMIT = 6;
const UNTRACKED_LINE_LIMIT = 1024 * 1024;
const UNTRACKED_FILE_LIMIT = 200;

export type PullRequestState = 'open' | 'merged' | 'closed';
export type PullRequestChecks = 'passing' | 'failing' | 'running' | 'none';

export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  draft: boolean;
  headRef: string;
  /** Only read for the branch's own pull request. */
  checks?: PullRequestChecks;
  /** The newest failed GitHub Actions run of that pull request, for its log. */
  failedRunId?: number;
}

export interface RepositorySummary {
  repository: boolean;
  /** Empty while HEAD is detached. */
  branch: string;
  defaultBranch: string;
  /** `owner/name` when origin is a github.com remote. */
  github: string;
  files: number;
  additions: number;
  deletions: number;
  /** Commits on this branch that its default branch does not have. */
  ahead: number;
  /** Commits its upstream branch does not have; all of `ahead` with no upstream. */
  unpushed: number;
}

/**
 * `ready` reads pull requests. `missing` and `signed-out` say why it cannot, and
 * `unavailable` says this folder has no GitHub remote to ask about.
 */
export type PullRequestAccess =
  'ready' | 'missing' | 'signed-out' | 'unavailable';

export interface PullRequestOverview {
  git: RepositorySummary;
  access: PullRequestAccess;
  current: PullRequestSummary | null;
  recent: PullRequestSummary[];
}

export type GhRunner = (args: string[]) => Promise<string>;

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
  return async (args) =>
    (
      await exec(ghPath, args, {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: GH_TIMEOUT,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          GH_PAGER: 'cat',
          NO_COLOR: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
      })
    ).stdout;
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
 * the person's own `gh`, as the create-pr skill does, so what Circle opened is what
 * shows here. Nothing it reads is written back.
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
    const [current, recent] = await Promise.all([
      onDefault
        ? Promise.resolve(null)
        : this.gh([
            'pr',
            'view',
            git.branch,
            '--json',
            'number,title,url,state,isDraft,headRefName,statusCheckRollup',
          ]).then(
            (out) => summarizePullRequest(JSON.parse(out)) ?? null,
            () => null,
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
        (out) =>
          (JSON.parse(out) as unknown[])
            .map(summarizePullRequest)
            .filter((item): item is PullRequestSummary => !!item),
        () => [],
      ),
    ]);
    return {
      git,
      access,
      // A branch whose pull request is closed or merged starts another one.
      current: current && current.state === 'open' ? current : null,
      recent: recent.filter((item) => item.number !== current?.number),
    };
  }

  /** The tail of what failed in one GitHub Actions run, bounded per job. */
  async failedLog(
    runId: unknown,
  ): Promise<{ text: string; truncated: boolean }> {
    if (typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId < 1)
      throw Error('valid run id is required');
    const log = await this.gh(['run', 'view', String(runId), '--log-failed']);
    return boundFailedRunLog(log);
  }

  private async access(): Promise<PullRequestAccess> {
    try {
      await this.gh(['--version']);
    } catch {
      return 'missing';
    }
    try {
      await this.gh(['auth', 'status']);
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
