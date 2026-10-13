// The terminal's numbers, written the same way (src/tui/status_rows.ts imports node
// modules, so the renderer keeps its own copy; test/format.test.ts holds them equal).

// `840`, `12.3k`, `7.8M`.
export function formatTokens(value: number): string {
  const count = Math.max(0, Math.floor(value || 0));
  return count >= 1_000_000
    ? `${(count / 1_000_000).toFixed(1)}M`
    : count >= 1000
      ? `${(count / 1000).toFixed(1)}k`
      : String(count);
}
// A context window: `128.0k`, `1.0M`.
export function formatWindow(value: number): string {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : formatTokens(value);
}
// The busy word's clock: `12.4s`, `3m 5s`, `1h 2m`.
export function formatBusyElapsed(seconds: number): string {
  const value = Math.max(0, seconds);
  if (value < 60) return `${value.toFixed(1)}s`;
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return `${minutes}m ${Math.floor(value) % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
/** A path inside `root` as it reads in the workspace: `src/app.ts`, not the full path. */
export function relativePath(path: string, root?: string): string {
  if (!root || !path) return path;
  const base = root.endsWith('/') ? root : root + '/';
  return path.startsWith(base) ? path.slice(base.length) : path;
}
/** How full the context is, in percent; null when either number is unknown. */
export function contextPercent(
  input: number | null | undefined,
  window: number | null | undefined,
): number | null {
  if (input === null || input === undefined || !window) return null;
  return Math.min(999, (input / window) * 100);
}
