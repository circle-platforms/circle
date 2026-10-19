import type { ChangeLetter } from './overview';

/** What the file tree shows of a working tree's changes. */
export interface ChangedFiles {
  /** The letter of every file that differs from the last commit. */
  letters: ReadonlyMap<string, ChangeLetter>;
  /** Every folder with a changed file somewhere beneath it. */
  folders: ReadonlySet<string>;
}

/**
 * A deleted file is no longer in the tree, so it marks no folder: a dot with nothing
 * coloured under it would only puzzle. The changes list is where deletions are.
 */
export function changedFiles(
  rows: readonly { path: string; letter: ChangeLetter }[],
): ChangedFiles {
  const letters = new Map<string, ChangeLetter>();
  const folders = new Set<string>();
  for (const row of rows) {
    letters.set(row.path, row.letter);
    if (row.letter === 'D') continue;
    const parts = row.path.split('/');
    for (let end = 1; end < parts.length; end++)
      folders.add(parts.slice(0, end).join('/'));
  }
  return { letters, folders };
}
