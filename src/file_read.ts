import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Same line window for a versioned text snapshot, without re-reading changing disk bytes. */
export function readTextContentWindow(
  content: string,
  offset: number,
  limit: number,
): string {
  const lines = content.split(/\r\n|\n|\r/);
  if (!content || /[\r\n]$/.test(content)) lines.pop();
  if (!lines.some((line) => line.trim()))
    return 'System reminder: File exists but has empty contents';
  if (limit === 0)
    return 'System reminder: no lines were read because `limit` was 0. The file was not inspected and may have contents; retry with `limit` >= 1 to read it.';
  if (offset >= lines.length)
    return `System reminder: no lines were read because offset ${offset} is at or past the end of the file (${lines.length} lines). Valid zero-based offsets are 0..${lines.length - 1}; retry from a valid offset.`;
  return lines
    .slice(offset, offset + limit)
    .map(
      (line, index) =>
        `${offset + index + 1}: ${line.length > 2000 ? line.slice(0, 2000) + '…' : line}`,
    )
    .join('\n');
}

/** Read a zero-based line window without loading a growing job log into memory. */
export async function readTextWindow(
  path: string,
  offset: number,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const input = createReadStream(path, { encoding: 'utf8', signal });
  const reader = createInterface({ input, crlfDelay: Infinity });
  const window: string[] = [];
  let total = 0;
  let blank = true;
  try {
    for await (const line of reader) {
      signal.throwIfAborted();
      if (line.trim()) blank = false;
      if (total >= offset && total - offset < limit)
        window.push(
          `${total + 1}: ${line.length > 2000 ? line.slice(0, 2000) + '…' : line}`,
        );
      total++;
    }
  } finally {
    reader.close();
    input.destroy();
  }
  signal.throwIfAborted();
  if (blank) return 'System reminder: File exists but has empty contents';
  if (limit === 0)
    return 'System reminder: no lines were read because `limit` was 0. The file was not inspected and may have contents; retry with `limit` >= 1 to read it.';
  if (offset >= total)
    return `System reminder: no lines were read because offset ${offset} is at or past the end of the file (${total} lines). Valid zero-based offsets are 0..${total - 1}; retry from a valid offset.`;
  return window.join('\n');
}
