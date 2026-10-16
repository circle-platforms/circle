import { readFile } from 'node:fs/promises';

/** The scripted worker publishes one JSON record by terminating it with LF. */
export function parseModelRequestFrames(
  bytes,
  { requireComplete = false } = {},
) {
  const end = bytes.lastIndexOf(10) + 1;
  const complete = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes.subarray(0, end));
  const records = complete
    ? complete
        .slice(0, -1)
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
  if (requireComplete && end !== bytes.length)
    throw Error(
      `model request log has an incomplete final frame (${bytes.length - end} bytes after its last LF)`,
    );
  return records;
}

export async function readModelRequests(path, options) {
  return parseModelRequestFrames(await readFile(path), options);
}
