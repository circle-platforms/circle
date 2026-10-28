import { isAbsolute, relative, sep } from 'node:path';

/** Compare the session's recorded changes alongside Git's current changes. */
export function expectedSessionChanges(gitRows, changes, workspace) {
  const rows = new Map(gitRows);
  for (const change of changes) {
    const candidate = isAbsolute(change.path)
      ? relative(workspace, change.path)
      : change.path;
    const path =
      candidate === '..' ||
      candidate.startsWith('..' + sep) ||
      isAbsolute(candidate)
        ? change.path.replaceAll('\\', '/')
        : candidate.replaceAll('\\', '/');
    rows.set(
      path,
      change.kind === 'added' ? 'A' : change.kind === 'deleted' ? 'D' : 'M',
    );
  }
  return [...rows].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
