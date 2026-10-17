import test from 'node:test';
import assert from 'node:assert/strict';
import { githubPermissions } from '../src/model/github-permissions.ts';
import type { GitHubConnectionState } from '../../../src/github_connection.ts';
const base: GitHubConnectionState = {
  provider: 'github',
  client: 'GitHub CLI',
  epoch: 1,
  state: 'connected',
  repositories: [],
  remoteRevocation: 'not-requested',
};
test('missing, unreported and malformed scope metadata never implies CLI permissions', () => {
  assert.deepEqual(githubPermissions(base), {
    requested: undefined,
    granted: undefined,
  });
  for (const patch of [
    { scopeVerification: 'not-reported', grantedScopes: ['workflow'] },
    { scopeVerification: 'reported', grantedScopes: ['bad scope'] },
    { scopeVerification: 'reported', grantedScopes: 'repo' },
    { requestedAdditionalScopes: ['repo'] },
  ])
    assert.deepEqual(
      githubPermissions({ ...base, ...patch } as GitHubConnectionState),
      { requested: undefined, granted: undefined },
    );
});
test('explicit extra workflow and actual reported empty scopes remain distinct from unknown', () => {
  assert.deepEqual(
    githubPermissions({
      ...base,
      requestedAdditionalScopes: ['workflow'],
      scopeVerification: 'reported',
      grantedScopes: [],
    }),
    { requested: ['workflow'], granted: [] },
  );
  assert.deepEqual(
    githubPermissions({
      ...base,
      requestedAdditionalScopes: ['workflow'],
      scopeVerification: 'reported',
      grantedScopes: ['repo', 'workflow'],
    }),
    { requested: ['workflow'], granted: ['repo', 'workflow'] },
  );
});
