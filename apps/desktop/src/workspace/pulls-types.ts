/** What the workspace `pulls` service answers, as the renderer reads it. Types only. */

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
 * `ready` reads pull requests. `missing` and `signed-out` say why it cannot,
 * `unreachable` that GitHub did not answer, as when the computer is offline, and
 * `unavailable` that this folder has no GitHub remote to ask about.
 */
export type PullRequestAccess =
  'ready' | 'missing' | 'signed-out' | 'unreachable' | 'unavailable';

export interface PullRequestOverview {
  git: RepositorySummary;
  access: PullRequestAccess;
  current: PullRequestSummary | null;
  recent: PullRequestSummary[];
}
