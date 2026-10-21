import type { DiffView, Session } from './types';
import { relativeTo, type ChangeLetter } from './overview';

/** One file in the changes list. */
export interface ChangeRow {
  path: string;
  name: string;
  folder: string;
  letter: ChangeLetter;
  /** Lines added and removed; null where Git does not count them (a binary file). */
  added: number | null;
  removed: number | null;
}

function row(
  path: string,
  letter: ChangeLetter,
  added: number | null,
  removed: number | null,
): ChangeRow {
  const parts = path.split('/');
  return {
    path,
    name: parts.at(-1) ?? path,
    folder: parts.slice(0, -1).join('/'),
    letter,
    added,
    removed,
  };
}

/** The lines a change adds and removes, from the core's summary: `+3 -1`, `new file, 4 lines`. */
export function diffCounts(diff: Pick<DiffView, 'summary' | 'rows'>): {
  added: number;
  removed: number;
} {
  const plain = /^\+(\d+) -(\d+)$/.exec(diff.summary);
  if (plain) return { added: Number(plain[1]), removed: Number(plain[2]) };
  const whole = /^(new file|deleted), (\d+) lines?$/.exec(diff.summary);
  if (whole)
    return whole[1] === 'new file'
      ? { added: Number(whole[2]), removed: 0 }
      : { added: 0, removed: Number(whole[2]) };
  // A summary in some other words: count what the rows show.
  return {
    added: diff.rows.filter((item) => item.tone === 'added').length,
    removed: diff.rows.filter((item) => item.tone === 'removed').length,
  };
}

/** What this conversation changed on disk, each file with its own diff. */
export function sessionChangeRows(
  changes: Session['changes'],
  root?: string,
): (ChangeRow & { diff: DiffView })[] {
  return (changes ?? []).map((change) => {
    const counts = diffCounts(change.diff);
    return {
      ...row(
        relativeTo(change.path, root),
        change.kind === 'added' ? 'A' : change.kind === 'deleted' ? 'D' : 'M',
        counts.added,
        counts.removed,
      ),
      diff: change.diff,
    };
  });
}

/** What `git` says differs from the last commit: name-status letters, with numstat counts. */
export function gitChangeRows(
  files: {
    path: string;
    status: string;
    added?: number | null;
    removed?: number | null;
  }[],
): ChangeRow[] {
  return files
    .map((file) =>
      row(
        file.path,
        file.status.startsWith('A')
          ? 'A'
          : file.status.startsWith('D')
            ? 'D'
            : 'M',
        file.added ?? null,
        file.removed ?? null,
      ),
    )
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * This session's list, agreed with the overview's changes card. File tools keep their
 * own diff; uncommitted files Git reports and the session did not record are included
 * too, so a shell edit shows in both places.
 */
export function sessionScopeRows(
  sessionRows: ChangeRow[],
  gitRows: ChangeRow[] | undefined,
): ChangeRow[] {
  if (!gitRows) return sessionRows;
  const sessionByPath = new Map(sessionRows.map((row) => [row.path, row]));
  const seen = new Set<string>();
  const merged: ChangeRow[] = [];
  for (const row of gitRows) {
    seen.add(row.path);
    merged.push(sessionByPath.get(row.path) ?? row);
  }
  for (const row of sessionRows) if (!seen.has(row.path)) merged.push(row);
  return merged.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A unified patch, as rows the diff block draws: added and removed lines carry their tone.
 * What comes before a file's first hunk is Git's header (names, modes, hashes) and is left
 * out; inside a hunk every line is the file's own, even one that starts with `---`.
 */
export function diffViewFromPatch(text: string): DiffView {
  const rows: DiffView['rows'] = [];
  let hunk = false;
  for (const line of text.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      hunk = false;
      continue;
    }
    if (line.startsWith('@@')) {
      hunk = true;
      rows.push({ text: line });
      continue;
    }
    if (!hunk) {
      // A binary file has no hunk; its one line says so.
      if (/^Binary files |^Preview unavailable/.test(line))
        rows.push({ text: line });
      continue;
    }
    rows.push({
      text: line,
      ...(line.startsWith('+')
        ? { tone: 'added' as const }
        : line.startsWith('-')
          ? { tone: 'removed' as const }
          : {}),
    });
  }
  const added = rows.filter((item) => item.tone === 'added').length;
  const removed = rows.filter((item) => item.tone === 'removed').length;
  return { summary: `+${added} -${removed}`, rows };
}
