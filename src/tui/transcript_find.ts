import { stripAnsi } from '../ink/string_width.js';
// The form matching compares: lowercase, runs of whitespace folded to one space.
function normalized(text: string): string {
  return text.toLocaleLowerCase().replace(/\s+/g, ' ');
}
export class TranscriptFind {
  query = '';
  matches: number[] = [];
  at = -1;
  /** How many times rows were normalized; the cache holds it to once per transcript change. */
  normalizations = 0;
  private rows: string[] = [];
  private haystacks: string[] = [];
  private memo?: { needle: string; matches: number[] };
  // Rows replayed from the transcript's block cache are the same string objects, so an
  // unchanged transcript is recognised by reference without normalizing it again.
  private adopt(rows: string[]): void {
    if (
      rows.length === this.rows.length &&
      rows.every((row, index) => row === this.rows[index])
    )
      return;
    this.rows = rows;
    this.haystacks = rows.map((row) => normalized(stripAnsi(row)));
    this.normalizations++;
    this.memo = undefined;
  }
  private scan(needle: string): number[] {
    if (this.memo?.needle === needle) return this.memo.matches;
    const matches = needle
      ? this.haystacks.flatMap((row, index) =>
          row.includes(needle) ? [index] : [],
        )
      : [];
    this.memo = { needle, matches };
    return matches;
  }
  refresh(rows: string[], top = 0): void {
    this.adopt(rows);
    this.matches = this.scan(normalized(this.query).trim());
    this.at = this.matches.length
      ? Math.max(
          0,
          this.matches.findIndex((row) => row >= top),
        )
      : -1;
  }
  /** Rematches an edited query against the rows of the last refresh: a keystroke never
   * re-renders the transcript. */
  retype(): void {
    this.refresh(this.rows);
  }
  next(reverse = false): void {
    if (this.matches.length)
      this.at =
        (this.at + (reverse ? -1 : 1) + this.matches.length) %
        this.matches.length;
  }
  updateRows(rows: string[]): void {
    const current = this.row;
    this.refresh(rows, current ?? 0);
    if (current !== undefined && this.matches.includes(current))
      this.at = this.matches.indexOf(current);
  }
  get row(): number | undefined {
    return this.matches[this.at];
  }
  get status(): string {
    return `find: ${this.query}▏${this.query ? `  ${this.matches.length ? `${this.at + 1}/${this.matches.length}` : 'no matches'}` : ''} · enter next · shift+enter previous · esc closes`;
  }
}
export function highlightMatches(row: string, query: string): string {
  if (!query.trim()) return row;
  // Preserve locally generated SGR spans while matching the visible text.
  const plain = stripAnsi(row);
  const words = query
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(words.join('\\s+'), 'giu');
  const ranges: [number, number][] = [];
  for (const match of plain.matchAll(pattern))
    ranges.push([match.index, match.index + match[0].length]);
  if (!ranges.length) return row;
  let offset = 0;
  let result = '';
  for (const part of row.split(/(\x1b\[[0-9;]*m)/)) {
    if (/^\x1b\[[0-9;]*m$/.test(part)) {
      result += part;
      if (ranges.some(([a, b]) => offset >= a && offset < b))
        result += '\x1b[7m';
      continue;
    }
    for (const char of part) {
      if (ranges.some(([a]) => offset === a)) result += '\x1b[7m';
      result += char;
      offset += char.length;
      if (ranges.some(([, b]) => offset === b)) result += '\x1b[27m';
    }
  }
  return result + '\x1b[27m';
}
