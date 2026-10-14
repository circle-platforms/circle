import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

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
