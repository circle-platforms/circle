import type { DiffView } from '../model/types';
import { tn } from '../i18n';

/** A change as the core's approval preview draws it: `+  3  text`, `-  3  text`, `@@`. */
export function DiffBlock({
  diff,
  path,
  compact = false,
}: {
  diff: DiffView;
  path?: string;
  compact?: boolean;
}) {
  return (
    <div className={`diff-block${compact ? ' compact' : ''}`}>
      <header>
        {path && <code>{path}</code>}
        <span>{summary(diff.summary)}</span>
      </header>
      {diff.rows.length > 0 && (
        <pre>
          {diff.rows.map((row, index) => (
            <span
              key={index}
              className={
                row.tone ?? (row.text.startsWith('@@') ? 'hunk' : 'context')
              }
            >
              {row.text}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
    </div>
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
