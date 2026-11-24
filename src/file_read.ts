import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { decodeOutput } from './output_encoding.js';

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

export const MAX_LINE_CHARS = 2000;

interface TruncatedLine {
  lineNumber: number;
  start: number;
  end: number;
  total: number;
}

function formatWindowLine(
  lineNumber: number,
  line: string,
  charOffset: number,
  charLimit: number,
  truncated: TruncatedLine[],
): { text: string; length: number } {
  if (charOffset === 0 && line.length <= charLimit) {
    return { text: `${lineNumber}: ${line}`, length: line.length };
  }
  const chars = Array.from(line);
  const total = chars.length;
  if (charOffset === 0 && total <= charLimit) {
    return { text: `${lineNumber}: ${line}`, length: total };
  }
  const start = Math.min(charOffset, total);
  const end = Math.min(total, start + charLimit);
  const slice = chars.slice(start, end).join('');
  const prefix = start > 0 && start < total ? '…' : '';
  const suffix = end < total ? '…' : '';
  if (start > 0 || end < total) {
    truncated.push({ lineNumber, start, end, total });
  }
  return { text: `${lineNumber}: ${prefix}${slice}${suffix}`, length: total };
}

function windowBoundaryError(
  offset: number,
  limit: number,
  total: number,
  blank: boolean,
): string | undefined {
  if (blank) return 'System reminder: File exists but has empty contents';
  if (limit === 0)
    return 'System reminder: no lines were read because `limit` was 0. The file was not inspected and may have contents; retry with `limit` >= 1 to read it.';
  if (offset >= total)
    return `System reminder: no lines were read because offset ${offset} is at or past the end of the file (${total} lines). Valid zero-based offsets are 0..${total - 1}; retry from a valid offset.`;
  return undefined;
}

function finishWindow(
  window: string[],
  truncated: TruncatedLine[],
  charOffset: number,
  charLimit: number,
  maxLineChars: number,
): string {
  if (charOffset > 0 && maxLineChars <= charOffset) {
    return `System reminder: no characters were read because char_offset ${charOffset} is at or past the end of the selected lines (longest line is ${maxLineChars} characters). Valid zero-based char_offset values are 0..${Math.max(0, maxLineChars - 1)}; retry from a smaller char_offset.`;
  }
  if (!truncated.length) return window.join('\n');
  const details = truncated.slice(0, 5).map((entry) => {
    const more =
      entry.end < entry.total
        ? `; pass char_offset=${entry.end} (with char_limit=${charLimit}) to continue`
        : '';
    return `line ${entry.lineNumber} chars ${entry.start}..${entry.end} of ${entry.total}${more}`;
  });
  const rest =
    truncated.length > 5
      ? ` (+${truncated.length - 5} more sliced/truncated lines)`
      : '';
  return `${window.join('\n')}\nSystem reminder: long line window (${details.join('; ')}${rest}).`;
}

export function readTextContentWindow(
  content: string,
  offset: number,
  limit: number,
  charOffset = 0,
  charLimit = MAX_LINE_CHARS,
): string {
  const lines = content.split(/\r\n|\n|\r/);
  if (!content || /[\r\n]$/.test(content)) lines.pop();
  const boundary = windowBoundaryError(
    offset,
    limit,
    lines.length,
    !lines.some((line) => line.trim()),
  );
  if (boundary) return boundary;
  const truncated: TruncatedLine[] = [];
  let maxLineChars = 0;
  const window = lines.slice(offset, offset + limit).map((line, index) => {
    const formatted = formatWindowLine(
      offset + index + 1,
      line,
      charOffset,
      charLimit,
      truncated,
    );
    maxLineChars = Math.max(maxLineChars, formatted.length);
    return formatted.text;
  });
  return finishWindow(window, truncated, charOffset, charLimit, maxLineChars);
}

export async function readTextWindow(
  path: string,
  offset: number,
  limit: number,
  signal: AbortSignal,
  output = false,
  charOffset = 0,
  charLimit = MAX_LINE_CHARS,
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
  const truncated: TruncatedLine[] = [];
  let maxLineChars = 0;
  let total = 0;
  let blank = true;
  try {
    for await (const line of reader) {
      signal.throwIfAborted();
      if (line.trim()) blank = false;
      if (total >= offset && total - offset < limit) {
        const formatted = formatWindowLine(
          total + 1,
          line,
          charOffset,
          charLimit,
          truncated,
        );
        maxLineChars = Math.max(maxLineChars, formatted.length);
        window.push(formatted.text);
      }
      total++;
    }
  } finally {
    reader.close();
    input.destroy();
  }
  signal.throwIfAborted();
  const boundary = windowBoundaryError(offset, limit, total, blank);
  if (boundary) return boundary;
  return finishWindow(window, truncated, charOffset, charLimit, maxLineChars);
}
