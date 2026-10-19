import { setTimeout as delay } from 'node:timers/promises';
import {
  DeliveryPreflightError,
  DeliveryConfirmationPendingError,
} from './delivery-preflight.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { GitWorkspaceService } from './git.ts';
import type { NativeGitHubConnection } from './github-connection.ts';
import {
  DeliveryLogin,
  type LoginSpawn,
  type CredentialStore,
} from './delivery-login.ts';
const exec = promisify(execFile);
const deliveryLocks = new Map<string, Promise<unknown>>();
export const GH_VERSION = '2.83.2';
const JOB_LOG_TAIL = 32 * 1024;
function tailText(text: string): string {
  if (text.length <= JOB_LOG_TAIL) return text;
  const tail = text.slice(-JOB_LOG_TAIL),
    line = tail.indexOf('\n');
  return `[earlier log output omitted]\n${line >= 0 && line < tail.length - 1 ? tail.slice(line + 1) : tail}`;
}
/** Keep the tail of each job in `gh run view --log-failed` output, whose lines start with the job name and a tab. */
export function boundFailedRunLog(text: string): {
  text: string;
  truncated: boolean;
} {
  const jobs = new Map<string, string[]>();
  let current = '';
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab > 0) current = line.slice(0, tab);
    let lines = jobs.get(current);
    if (!lines) jobs.set(current, (lines = []));
    lines.push(line);
  }
  let truncated = false;
  const sections = [...jobs.values()].map((lines) => {
    const job = lines.join('\n'),
      bounded = tailText(job);
    if (bounded !== job) truncated = true;
    return bounded;
  });
  return truncated
    ? { text: sections.join('\n'), truncated }
    : { text, truncated };
}
export class DeliveryService {
  readonly git: GitWorkspaceService;
  readonly root: string;
  readonly ghPath: string;
  readonly login?: DeliveryLogin;
  private connection?: NativeGitHubConnection;
  private operationEpoch?: number;
  private operationSignal?: AbortSignal;
  private repositoryScope?: Promise<string>;
  private assertActive?: () => void;
  constructor(
    root: string,
    ghPath = 'gh',
    options?: {
      spawn: LoginSpawn;
      credentialStore?: CredentialStore;
      connection?: NativeGitHubConnection;
      epoch?: number;
      signal?: AbortSignal;
      assertActive?: () => void;
    },
  ) {
    this.root = root;
    this.ghPath = ghPath;
    this.git = new GitWorkspaceService(root);
    this.connection = options?.connection;
    this.operationEpoch = options?.epoch;
    this.operationSignal = options?.signal;
    this.assertActive = options?.assertActive;
    if (options && !this.connection)
      this.login = new DeliveryLogin(
        options.spawn,
        ghPath,
        root,
        options.credentialStore,
      );
  }
  private repository() {
    return (this.repositoryScope ??= (async () => {
      const remote = (await this.git.git(['remote', 'get-url', 'origin']))
        .trim()
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
        .replace(/\.git$/, '');
      const match = /^https:\/\/github\.com\/([-\w.]+\/[-\w.]+)$/.exec(remote);
      if (!match) throw Error('select an authorized GitHub repository remote');
      this.connection!.assertGrant(this.operationEpoch!, match[1]!);
      return match[1]!;
    })());
  }
  private guard() {
    this.operationSignal?.throwIfAborted();
    this.assertActive?.();
    if (this.connection && this.operationEpoch !== undefined)
      this.connection.assertEpoch(this.operationEpoch);
  }
  async gh(args: string[]): Promise<string> {
    if (this.connection && this.operationEpoch === undefined)
      return this.scoped().gh(args);
    this.guard();
    if (this.connection) {
      const repository = await this.repository();
      this.guard();
      return this.connection.run(
        args,
        this.operationEpoch ?? this.connection.snapshot().epoch,
        this.root,
        this.operationSignal,
        repository,
      );
    }
    const token = await this.login?.token();
    return (
      await exec(this.ghPath, args, {
        cwd: this.root,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 120_000,
        env: {
          ...process.env,
          ...(token ? { GH_TOKEN: token } : {}),
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
        },
      })
    ).stdout;
  }
  async dispose() {
    await this.login?.dispose();
  }
  private async pr() {
    return JSON.parse(
      await this.gh([
        'pr',
        'view',
        '--json',
        'number,url,isDraft,headRefOid,headRefName,state',
      ]),
    );
  }
  async call(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (this.connection && this.operationEpoch === undefined)
      return this.scoped().call(method, params);
    this.guard();
    if (!['publish', 'ready', 'retry'].includes(method))
      return this.execute(method, params);
    return this.serialized(() => this.execute(method, params));
  }
  private scoped() {
    return new DeliveryService(this.root, this.ghPath, {
      spawn: () => {
        throw Error('open the GitHub plugin details to connect');
      },
      connection: this.connection,
      epoch: this.connection!.snapshot().epoch,
      signal: this.operationSignal,
      assertActive: this.assertActive,
    });
  }
  private async readFailureLogs(runId: unknown) {
    if (!Number.isSafeInteger(runId) || Number(runId) <= 0)
      throw Error('valid run id is required');
    try {
      return boundFailedRunLog(
        await this.redactLogs(
          await this.gh(['run', 'view', String(runId), '--log-failed']),
        ),
      );
    } catch (primary) {
      try {
        return await this.completedJobLogs(Number(runId));
      } catch (fallback) {
        throw Error(
          await this.redactLogs(
            `failed logs are unavailable: ${String(primary)}\ncompleted-job fallback: ${String(fallback)}`,
          ),
        );
      }
    }
  }
  /** The local origin/HEAD, else GitHub's answer; undefined when neither knows. */
  private async defaultBranch(): Promise<string | undefined> {
    const local = await this.git
      .git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
      .catch(() => '');
    const tracked = /^refs\/remotes\/origin\/(.+)$/.exec(local.trim());
    if (tracked) return tracked[1]!;
    const name = await this.gh(['repo', 'view', '--json', 'defaultBranchRef'])
      .then(
        (text) =>
          (JSON.parse(text) as { defaultBranchRef?: { name?: unknown } })
            .defaultBranchRef?.name,
      )
      .catch(() => undefined);
    return typeof name === 'string' && name.trim() ? name : undefined;
  }
  private async candidateSnapshot() {
    const state = await this.git.snapshot();
    if ((await realpath(state.root)) !== (await realpath(this.root)))
      throw Error(
        'delivery repository root changed; inspect before continuing',
      );
    return state;
  }
  private async serialized<T>(action: () => Promise<T>): Promise<T> {
    // Queue identity is the granted directory, not mutable candidate contents.
    // Publication and review still take fresh full snapshots inside the queue.
    const key = await realpath(this.root);
    const before = deliveryLocks.get(key) ?? Promise.resolve();
    const operation = before.catch(() => {}).then(action);
    deliveryLocks.set(key, operation);
    try {
      return await operation;
    } finally {
      if (deliveryLocks.get(key) === operation) deliveryLocks.delete(key);
    }
  }
  private async execute(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === 'login') {
      if (this.connection)
        throw Error('open the GitHub plugin details to manage the connection');
      if (!this.login) throw Error('native login helper is unavailable');
      if (params.action === 'poll') return this.login.poll(String(params.id));
      if (params.action === 'cancel')
        return this.login.cancel(String(params.id));
      return this.login.start();
    }
    if (method === 'status') {
      const auth = await this.gh(['auth', 'status']).then(
        () => true,
        () => false,
      );
      const version = (await this.gh(['--version'])).split('\n')[0];
      const pullRequest = await this.pr().catch(() => null);
      return {
        authenticated: auth,
        version,
        expectedVersion: GH_VERSION,
        pullRequest,
      };
    }
    if (method === 'checks')
      return JSON.parse(
        await this.gh([
          'pr',
          'checks',
          '--json',
          'name,state,bucket,link,workflow',
        ]).catch(async (error: { stdout?: string }) => {
          if (error.stdout) {
            const value = JSON.parse(error.stdout);
            if (Array.isArray(value)) return error.stdout;
          }
          // gh exits nonzero when a PR has no checks at all; that is an
          // empty result, not an outage.
          const rollup = await this.gh([
            'pr',
            'view',
            '--json',
            'statusCheckRollup',
          ])
            .then(
              (text) =>
                (JSON.parse(text) as { statusCheckRollup?: unknown })
                  .statusCheckRollup,
            )
            .catch(() => undefined);
          if (Array.isArray(rollup) && !rollup.length) return '[]';
          throw error;
        }),
      );
    if (method === 'logs') return this.readFailureLogs(params.runId);
    if (method === 'publish') return this.publish(params);
    if (method === 'ready') {
      const state = await this.candidateSnapshot();
      const pr = await this.pr();
      if (state.revision !== params.revision || state.head !== pr.headRefOid)
        throw Error('PR head changed; refresh checks');
      if (
        state.entries.length ||
        pr.state !== 'OPEN' ||
        pr.headRefName !== state.branch ||
        !Number.isSafeInteger(pr.number) ||
        pr.number <= 0
      )
        throw Error('a clean candidate on its open pull request is required');
      const sameCandidate = (candidate: typeof pr) =>
        candidate &&
        candidate.number === pr.number &&
        candidate.url === pr.url &&
        candidate.state === 'OPEN' &&
        candidate.headRefName === state.branch &&
        candidate.headRefOid === state.head;
      const checks = (await this.call('checks')) as { bucket: string }[];
      if (
        !checks.some((check) => check.bucket === 'pass') ||
        checks.some((check) => !['pass', 'skipping'].includes(check.bucket))
      )
        throw Error(
          'CI needs a passing check and no pending, failed or unknown checks before requesting review',
        );
      const [current, checkedPR] = await Promise.all([
        this.candidateSnapshot(),
        this.pr(),
      ]);
      if (current.revision !== state.revision || !sameCandidate(checkedPR))
        throw Error(
          'PR head or repository changed while reading checks; refresh before requesting review',
        );
      if (checkedPR.isDraft === false) return checkedPR;
      await this.gh(['pr', 'ready', String(pr.number)]);
      const result = await this.pr();
      if (!sameCandidate(result)) {
        // GitHub's ready mutation has no expected-head parameter. Restore our
        // draft transition if another push raced the final server-side mutation.
        await this.gh(['pr', 'ready', String(pr.number), '--undo']).catch(
          (error) => {
            throw Error(
              `PR candidate changed; draft restoration is unconfirmed: ${String(error)}`,
            );
          },
        );
        throw Error(
          'PR candidate changed while requesting review; draft status restored',
        );
      }
      return result;
    }
    if (method === 'retry') {
      if (!Number.isSafeInteger(params.runId) || Number(params.runId) <= 0)
        throw Error('valid run id is required');
      await this.gh(['run', 'rerun', String(params.runId), '--failed']);
      return { requested: true };
    }
    throw Error('unknown delivery method');
  }
  private async redactLogs(text: string): Promise<string> {
    const secrets = [
      await this.login?.token(),
      process.env.GH_TOKEN,
      process.env.GITHUB_TOKEN,
      process.env.GH_ENTERPRISE_TOKEN,
      process.env.GITHUB_ENTERPRISE_TOKEN,
    ];
    for (const secret of secrets)
      if (secret) text = text.split(secret).join('[redacted]');
    return text.replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      '[redacted]',
    );
  }
  /** Read completed failures while other jobs continue. Repository and job IDs come only from verified API records. */
  private async completedJobLogs(runId: number): Promise<{
    text: string;
    truncated: boolean;
    source: 'completed-jobs';
    runId: number;
    attempt: number;
    partial: boolean;
    jobIds: number[];
  }> {
    const repository = JSON.parse(
      await this.gh(['repo', 'view', '--json', 'nameWithOwner,url']),
    ) as { nameWithOwner: string; url: string };
    if (
      typeof repository.nameWithOwner !== 'string' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.nameWithOwner)
    )
      throw Error('invalid authorized repository identity');
    const web = new URL(repository.url);
    if (
      web.protocol !== 'https:' ||
      web.username ||
      web.password ||
      web.search ||
      web.hash ||
      web.pathname.replace(/\/$/, '').toLowerCase() !==
        `/${repository.nameWithOwner}`.toLowerCase()
    )
      throw Error('repository URL does not match its authorized identity');
    const apiHosts = new Set([
      web.host.toLowerCase(),
      `api.${web.hostname}${web.port ? ':' + web.port : ''}`.toLowerCase(),
    ]);
    const endpoint = `repos/${repository.nameWithOwner}/actions`;
    const validAPIURL = (value: unknown, suffix: string) => {
      if (typeof value !== 'string') return false;
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        apiHosts.has(url.host.toLowerCase()) &&
        [`/${endpoint}${suffix}`, `/api/v3/${endpoint}${suffix}`].some(
          (path) => url.pathname.toLowerCase() === path.toLowerCase(),
        )
      );
    };
    const api = async (path: string) =>
      this.gh(['api', '--hostname', web.host, path]);
    type Run = {
      id: number;
      run_attempt: number;
      head_sha: string;
      status: string;
      url: string;
      repository: { full_name: string };
    };
    const validateRun = (value: Run) => {
      if (
        !value ||
        value.id !== runId ||
        !Number.isSafeInteger(value.run_attempt) ||
        value.run_attempt < 1 ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.head_sha) ||
        value.repository?.full_name?.toLowerCase() !==
          repository.nameWithOwner.toLowerCase() ||
        !validAPIURL(value.url, `/runs/${runId}`)
      )
        throw Error(
          'workflow run does not belong to the authorized repository',
        );
      return value;
    };
    const run = validateRun(
      JSON.parse(await api(`${endpoint}/runs/${runId}`)) as Run,
    );
    type Job = {
      id: number;
      run_id: number;
      run_attempt?: number;
      head_sha: string;
      run_url: string;
      url: string;
      status: string;
      conclusion: string;
      name: string;
    };
    const validateJob = (job: Job) => {
      if (
        !job ||
        !Number.isSafeInteger(job.id) ||
        job.id < 1 ||
        job.run_id !== runId ||
        job.head_sha !== run.head_sha ||
        (job.run_attempt !== undefined &&
          job.run_attempt !== run.run_attempt) ||
        !validAPIURL(job.run_url, `/runs/${runId}`) ||
        !validAPIURL(job.url, `/jobs/${job.id}`)
      )
        throw Error('job does not belong to the verified workflow run');
      return job;
    };
    const failures = new Set([
      'failure',
      'timed_out',
      'cancelled',
      'action_required',
      'startup_failure',
    ]);
    const jobs: Job[] = [],
      seen = new Set<number>();
    let complete = false;
    for (let page = 1; page <= 100; page++) {
      const result = JSON.parse(
        await api(
          `${endpoint}/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
        ),
      ) as { total_count: number; jobs: Job[] };
      if (
        !Array.isArray(result.jobs) ||
        result.jobs.length > 100 ||
        !Number.isSafeInteger(result.total_count) ||
        result.total_count < 0 ||
        result.total_count > 10000
      )
        throw Error('invalid workflow job page');
      for (const entry of result.jobs) {
        const job = validateJob(entry);
        if (seen.has(job.id))
          throw Error('workflow job pagination repeated a job');
        seen.add(job.id);
        if (job.status === 'completed' && failures.has(job.conclusion))
          jobs.push(job);
      }
      if (seen.size >= result.total_count) {
        complete = true;
        break;
      }
      if (!result.jobs.length)
        throw Error('workflow job pagination ended before its declared total');
    }
    if (!complete) throw Error('workflow job pagination limit reached');
    if (!jobs.length)
      throw Error('no completed failed jobs have downloadable logs yet');
    const sections: string[] = [];
    let truncated = false;
    for (const job of jobs.sort((left, right) => left.id - right.id)) {
      const current = validateJob(
        JSON.parse(await api(`${endpoint}/jobs/${job.id}`)) as Job,
      );
      if (
        current.id !== job.id ||
        current.status !== 'completed' ||
        !failures.has(current.conclusion)
      )
        throw Error('failed job changed before its logs could be read');
      // Redact before cutting so a credential cannot survive half-cut.
      const text = await this.redactLogs(
        await api(`${endpoint}/jobs/${job.id}/logs`),
      );
      if (!text.trim())
        throw Error(`completed failed job ${job.id} returned empty logs`);
      const name =
        typeof current.name === 'string'
          ? current.name.replace(/[\r\n\0]/g, ' ').slice(0, 1000)
          : 'failed job';
      const title = await this.redactLogs(
        `=== ${name} (job ${job.id}, ${current.conclusion}) ===\n`,
      );
      const tail = tailText(text);
      if (tail !== text) truncated = true;
      sections.push(title + tail);
    }
    const after = validateRun(
      JSON.parse(await api(`${endpoint}/runs/${runId}`)) as Run,
    );
    if (
      after.head_sha !== run.head_sha ||
      after.run_attempt !== run.run_attempt
    )
      throw Error('workflow run changed while reading completed job logs');
    const header = await this.redactLogs(
      `workflow run ${runId}, attempt ${run.run_attempt}: completed failed job logs${after.status === 'completed' ? '' : '; other jobs are still running'}\n\n`,
    );
    return {
      text: header + sections.join('\n\n'),
      truncated,
      source: 'completed-jobs',
      runId,
      attempt: run.run_attempt,
      partial: after.status !== 'completed',
      jobIds: jobs.map((job) => job.id),
    };
  }
  private async publish(params: Record<string, unknown>): Promise<unknown> {
    const state = await this.candidateSnapshot();
    if (state.revision !== params.revision)
      throw new DeliveryPreflightError('DELIVERY_CANDIDATE_CHANGED');
    if (state.entries.length)
      throw new DeliveryPreflightError('DELIVERY_WORKSPACE_DIRTY');
    if (
      state.branch === 'detached' ||
      /^(main|master)$/.test(state.branch) ||
      state.branch === (await this.defaultBranch())
    )
      throw new DeliveryPreflightError('DELIVERY_FEATURE_BRANCH_REQUIRED');
    const push = async () => {
      const repository = this.connection ? await this.repository() : undefined;
      this.guard();
      await this.git.call(
        'push',
        { revision: state.revision },
        {
          signal: this.operationSignal,
          assertActive: () => this.guard(),
          pushAuthentication:
            this.connection && repository
              ? this.connection.gitPushAuthentication(
                  this.operationEpoch!,
                  repository,
                  this.operationSignal,
                  () => this.guard(),
                )
              : undefined,
        },
      );
    };
    const openForBranch = (pr: { state?: string; headRefName?: string }) =>
      pr.state === 'OPEN' && pr.headRefName === state.branch;
    const findOpen = async () => {
      const list = JSON.parse(
        await this.gh([
          'pr',
          'list',
          '--head',
          state.branch,
          '--state',
          'open',
          '--json',
          'number,url,isDraft,headRefOid,headRefName,state',
        ]),
      );
      if (
        !Array.isArray(list) ||
        list.length > 1 ||
        list.some((pr) => !pr || !openForBranch(pr))
      )
        throw Error(
          'open pull request reconciliation returned an unexpected branch or state',
        );
      return list[0] ?? null;
    };
    // A completed PR is not the active candidate. Reconcile successfully before creating another.
    const confirmPublished = async (number?: number) => {
      for (const wait of [0, 100, 250, 500]) {
        if (wait)
          await delay(wait, undefined, { signal: this.operationSignal });
        this.guard();
        const current = await this.pr().catch(() => null);
        this.guard();
        if (
          current &&
          openForBranch(current) &&
          current.headRefOid === state.head &&
          Number.isSafeInteger(current.number) &&
          (number === undefined || current.number === number)
        ) {
          if ((await this.candidateSnapshot()).revision !== state.revision)
            throw new DeliveryConfirmationPendingError();
          this.guard();
          return current;
        }
      }
      throw new DeliveryConfirmationPendingError();
    };
    const existing = await this.pr().then(
      (pr) => (openForBranch(pr) ? pr : findOpen()),
      () => findOpen(),
    );
    if (existing) {
      await push();
      return confirmPublished(existing.number);
    }
    if (
      typeof params.title !== 'string' ||
      !params.title.trim() ||
      typeof params.body !== 'string'
    )
      throw Error('title and body are required');
    await push();
    try {
      await this.gh([
        'pr',
        'create',
        '--draft',
        '--head',
        state.branch,
        '--title',
        params.title,
        '--body',
        params.body,
      ]);
    } catch (error) {
      const recovered = await this.pr().catch(() => null);
      if (recovered && openForBranch(recovered))
        return confirmPublished(recovered.number);
      throw Error(
        `publish result is unknown; refresh before retrying: ${String(error)}`,
      );
    }
    return confirmPublished();
  }
}
