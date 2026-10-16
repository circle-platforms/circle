/** Host provenance for Circle's own bounded GitHub status text, never model content. */
export interface GitHubRuntimeNotice {
  source: 'bundled:github';
  kind: 'github-connection';
  state: 'disconnected' | 'authorizing' | 'connected' | 'error';
}
export function githubStatusNotice(
  content: string,
  trusted: boolean,
): GitHubRuntimeNotice | undefined {
  if (!trusted) return;
  const match = /^GitHub: (disconnected|authorizing|connected|error)$/.exec(
    content,
  );
  if (match)
    return {
      source: 'bundled:github',
      kind: 'github-connection',
      state: match[1] as GitHubRuntimeNotice['state'],
    };
}
export function storedGitHubStatusNotice(
  content: string,
  value: unknown,
): GitHubRuntimeNotice | undefined {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const parsed = githubStatusNotice(content, true);
  return parsed &&
    record.source === parsed.source &&
    record.kind === parsed.kind &&
    record.state === parsed.state
    ? parsed
    : undefined;
}
