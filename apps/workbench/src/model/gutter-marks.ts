/**
 * Where a file differs from the last commit, as marks beside its line numbers: orange for
 * a line that changed, blue for one that is new, and a red triangle on the line after the
 * place where lines were deleted. Read from the file's unified diff against the last
 * commit, so the lines are those of the file as it stands on disk.
 */
export type GutterMark = {
  kind: 'changed' | 'added' | 'deleted';
  /** The first line the mark covers, from 1. A deletion marks the line after the gap. */
  start: number;
  /** The last line the mark covers; the same as `start` for a deletion. */
  end: number;
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The marks for one file's diff text; a diff of other files is read as if it were this one's. */
export function gutterMarks(diff: string): GutterMark[] {
  const marks: GutterMark[] = [];
  let line = 0;
  let removed = 0;
  let added = 0;
  let inHunk = false;
  const flush = () => {
    if (!removed && !added) return;
    // Lines the block replaces are changed; any it adds beyond them are new.
    const first = line - added;
    if (!added) {
      marks.push({ kind: 'deleted', start: line, end: line });
    } else {
      const replaced = Math.min(removed, added);
      if (replaced)
        marks.push({
          kind: 'changed',
          start: first,
          end: first + replaced - 1,
        });
      if (added > replaced)
        marks.push({ kind: 'added', start: first + replaced, end: line - 1 });
    }
    removed = 0;
    added = 0;
  };
  for (const text of diff.split('\n')) {
    const hunk = HUNK.exec(text);
    if (hunk) {
      flush();
      line = Number(hunk[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (text.startsWith('diff --git ')) {
      flush();
      inHunk = false;
    } else if (text.startsWith('+')) {
      added++;
      line++;
    } else if (text.startsWith('-')) {
      removed++;
    } else if (text.startsWith(' ')) {
      flush();
      line++;
    } else if (text.startsWith('\\')) {
      // "\ No newline at end of file" belongs to the line above it.
    } else {
      flush();
    }
  }
  flush();
  return marks;
}
