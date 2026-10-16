import type { GitHubConnectionState } from '../../../../src/github_connection';
/** Display only the backend's explicit scope report; never infer CLI defaults. */
export function githubPermissions(view: GitHubConnectionState) {
  const valid = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every(
      (scope) =>
        typeof scope === 'string' && /^[a-z][a-z0-9_:.-]{0,127}$/.test(scope),
    );
  const requested =
    valid(view.requestedAdditionalScopes) &&
    view.requestedAdditionalScopes.every((scope) => scope === 'workflow')
      ? [...new Set(view.requestedAdditionalScopes)]
      : undefined;
  const granted =
    view.scopeVerification === 'reported' && valid(view.grantedScopes)
      ? [...new Set(view.grantedScopes)]
      : undefined;
  return { requested, granted };
}
