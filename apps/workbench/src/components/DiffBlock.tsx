import type { DiffView } from '../model/types';
import { tn } from '../i18n';

// The core's approval preview numbers its rows, `+  12  text`; a Git difference does not,
// `+text`. Whichever a block has, the sign and number stay in a column of their own.
const NUMBERED = /^([+\- ])( *\d+  )(.*)$/s;

/**
 * Each row of a difference as a gutter and its text: the sign with the line number when
 * every row has one, or the sign alone. A hunk header or a "… more lines" row is whole.
 */
export function diffRowParts(
  rows: DiffView['rows'],
): { gutter?: string; text: string }[] {
  const whole = (text: string) => text.startsWith('@@') || text.startsWith('…');
  const body = rows.filter((row) => !whole(row.text));
  const numbered =
    body.length > 0 && body.every((row) => NUMBERED.test(row.text));
  return rows.map(({ text }) => {
    if (whole(text)) return { text };
    if (numbered) {
      const [, sign, number, rest] = NUMBERED.exec(text)!;
      return { gutter: sign! + number!, text: rest! };
    }
    return /^[+\- ]/.test(text)
      ? { gutter: text[0], text: text.slice(1) }
      : { text };
  });
}

/**
 * A change as the core's approval preview draws it: `+  3  text`, `-  3  text`, `@@`. A long
 * line wraps under its own text, so every line can be read whole, the sign and number stay
 * in sight, and a row's colour runs the full width; nothing scrolls sideways.
 */
export function DiffBlock({
  diff,
  path,
  compact = false,
  header = true,
}: {
  diff: DiffView;
  path?: string;
  compact?: boolean;
  /** Off where the row above already says the path and the summary, as a tool call's does. */
  header?: boolean;
}) {
  const parts = diffRowParts(diff.rows);
  return (
    <div className={`diff-block${compact ? ' compact' : ''}`}>
      {header && (
        <header>
          {path && <code>{path}</code>}
          <DiffSummary text={diff.summary} />
        </header>
      )}
      {diff.rows.length > 0 && (
        <pre>
          {diff.rows.map((row, index) => {
            const part = parts[index]!;
            return (
              <span
                key={index}
                className={
                  row.tone ?? (row.text.startsWith('@@') ? 'hunk' : 'context')
                }
              >
                {part.gutter !== undefined && (
                  <span className="diff-gutter">{part.gutter}</span>
                )}
                <span
                  className={
                    part.gutter === undefined
                      ? 'diff-text diff-whole'
                      : 'diff-text'
                  }
                >
                  {part.text}
                  {'\n'}
                </span>
              </span>
            );
          })}
        </pre>
      )}
    </div>
  );
}
/**
 * A difference's summary as every place shows it: added and removed lines in the colours
 * and signs of the folded line's count (`+3 −1`), or a new or deleted file's lines in the
 * interface language.
 */
export function DiffSummary({ text }: { text: string }) {
  const counts = /^\+(\d+) -(\d+)$/.exec(text);
  return counts ? (
    <span className="diff-count">
      <span className="added">+{counts[1]}</span>
      <span className="removed">−{counts[2]}</span>
    </span>
  ) : (
    <span>{summary(text)}</span>
  );
}
// The core writes the summary in English: `+3 -1`, `new file, 4 lines`, `deleted, 2 lines`.
function summary(text: string) {
  const counted = text.match(/^(new file|deleted), (\d+) lines?$/);
  if (!counted) return text;
  const count = Number(counted[2]);
  return counted[1] === 'new file'
    ? tn(count, 'new file, {n} line', 'new file, {n} lines')
    : tn(count, 'deleted, {n} line', 'deleted, {n} lines');
}
