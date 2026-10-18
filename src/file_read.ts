import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { decodeOutput } from './output_encoding.js';

// Command output as text, decoded a run of whole lines at a time (see decodeOutput).
async function* outputText(input: Readable): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  for await (const chunk of input as AsyncIterable<Buffer>) {
    const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const end =
      bytes.length > 1_048_576
        ? bytes.length
        : Math.max(bytes.lastIndexOf(0x0a), bytes.lastIndexOf(0x0d)) + 1;
    pending = Buffer.from(bytes.subarray(end));
    if (end) yield decodeOutput(bytes.subarray(0, end));
  }
  if (pending.length) yield decodeOutput(pending);
}

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

/** Read a zero-based line window without loading a growing job log into memory.
 * `output` reads a command's output, which may be in the console's code page. */
export async function readTextWindow(
  path: string,
  offset: number,
  limit: number,
  signal: AbortSignal,
  output = false,
): Promise<string> {
  signal.throwIfAborted();
  const input = output
    ? createReadStream(path, { signal })
    : createReadStream(path, { encoding: 'utf8', signal });
  const reader = createInterface({
    input: output ? Readable.from(outputText(input)) : input,
    crlfDelay: Infinity,
  });
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
