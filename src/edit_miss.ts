/** How many lines of the file a hint quotes at most. */
const QUOTED_LINES = 20;

const quoted = (lines: string[], from: number, count: number): string =>
  lines
    .slice(from, from + Math.min(count, QUOTED_LINES))
    .map((line, index) => {
      const text = line.replace(/\r$/, '');
      return `${from + index + 1}\t${JSON.stringify(text.length > 300 ? text.slice(0, 300) + '…' : text)}`;
    })
    .join('\n');

/**
 * What an edit says when its old text is not in the file, beyond that it is not: where the
 * file has the same lines with other spacing, which read_file's `N: text` lines make easy to
 * miscount, or where the old text's first line is, quoting the file's lines so their exact
 * spacing shows. The text before the first `.` stays what it always was.
 */
export function oldStringMissing(content: string, old: string): string {
  const missing = 'oldString not found in content';
  const lines = content.split('\n');
  const wanted = old.split('\n');
  if (wanted.length <= 200 && wanted.some((line) => line.trim())) {
    const matches: number[] = [];
    for (let at = 0; at + wanted.length <= lines.length; at++)
      if (
        wanted.every(
          (line, offset) => line.trim() === lines[at + offset]!.trim(),
        )
      )
        matches.push(at);
    if (matches.length === 1) {
      const at = matches[0]!;
      return `${missing}. Lines ${at + 1}-${at + wanted.length} have the same text with other spacing at the start or end of a line. The file has them as below, each line quoted; copy that spacing exactly:\n${quoted(lines, at, wanted.length)}`;
    }
    if (matches.length > 1) {
      const where = matches
        .slice(0, 5)
        .map((at) => at + 1)
        .join(', ');
      return `${missing}. With other spacing it is at ${matches.length} places (lines ${where}); copy the exact text of one, with lines around it to make it unique.`;
    }
    const first = wanted.find((line) => line.trim())!.trim();
    const at = lines.findIndex((line) => line.includes(first));
    if (at >= 0)
      return `${missing}. Its first line is at line ${at + 1}, but what follows differs. The file there reads as below, each line quoted:\n${quoted(lines, at, wanted.length)}`;
  }
  return `${missing}. The file may have changed since it was read: read it again before editing.`;
}
