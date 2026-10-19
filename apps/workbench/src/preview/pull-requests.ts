import type { PullRequestOverview } from '../../../desktop/src/workspace/pulls-types';

/** What the preview's overview shows for pull requests, since the preview reads no repository. */
export const SAMPLE_PULL_REQUESTS: PullRequestOverview = {
  git: {
    repository: true,
    branch: 'fix/reconnect',
    defaultBranch: 'main',
    github: 'acme/orbit-api',
    files: 3,
    additions: 64,
    deletions: 9,
    ahead: 1,
    unpushed: 1,
  },
  access: 'ready',
  current: {
    number: 186,
    title: 'Fix the reconnect race',
    url: 'https://github.com/acme/orbit-api/pull/186',
    state: 'open',
    draft: true,
    headRef: 'fix/reconnect',
    checks: 'failing',
    failedRunId: 4021,
  },
  recent: [
    {
      number: 181,
      title: 'Retry with exponential backoff',
      url: 'https://github.com/acme/orbit-api/pull/181',
      state: 'merged',
      draft: false,
      headRef: 'feat/backoff',
    },
    {
      number: 178,
      title: 'Close the socket before reopening it',
      url: 'https://github.com/acme/orbit-api/pull/178',
      state: 'merged',
      draft: false,
      headRef: 'fix/close-first',
    },
    {
      number: 172,
      title: 'Drop the legacy retry helper',
      url: 'https://github.com/acme/orbit-api/pull/172',
      state: 'closed',
      draft: false,
      headRef: 'chore/legacy-retry',
    },
  ],
};
