import assert from 'node:assert/strict';
import { test } from 'node:test';
import { downloadRuntime } from '../scripts/download.js';

test('the release build tries the Node.js download again when the connection fails, not when the file is missing', async () => {
  const bytes = Buffer.from('node archive');
  const timeout = () =>
    Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
    });
  const answers = [
    () => {
      throw timeout();
    },
    () => new Response(null, { status: 429 }),
    () => new Response(null, { status: 503 }),
    () => new Response(bytes),
  ];
  let calls = 0;
  const pauses: number[] = [];
  const lines: string[] = [];
  const quiet = {
    pause: async (ms: number) => {
      pauses.push(ms);
    },
    log: (line: string) => lines.push(line),
  };
  assert.deepEqual(
    await downloadRuntime('https://nodejs.test/node.tar.gz', {
      ...quiet,
      request: async () => answers[calls++]!(),
    }),
    bytes,
  );
  assert.equal(calls, 4);
  assert.deepEqual(pauses, [2000, 4000, 8000]);
  assert.equal(
    lines[0],
    'https://nodejs.test/node.tar.gz: fetch failed (UND_ERR_CONNECT_TIMEOUT); trying again in 2 s, attempt 2 of 6',
  );

  calls = 0;
  pauses.length = 0;
  await assert.rejects(
    downloadRuntime('https://nodejs.test/missing.tar.gz', {
      ...quiet,
      request: async () => {
        calls++;
        return new Response(null, { status: 404 });
      },
    }),
    /runtime download failed: 404 https:\/\/nodejs\.test\/missing\.tar\.gz/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(pauses, []);

  // Six attempts, a minute of pauses in all, before a download that never connects fails
  calls = 0;
  pauses.length = 0;
  await assert.rejects(
    downloadRuntime('https://nodejs.test/down.tar.gz', {
      ...quiet,
      request: async () => {
        calls++;
        throw timeout();
      },
    }),
    /fetch failed/,
  );
  assert.equal(calls, 6);
  assert.deepEqual(pauses, [2000, 4000, 8000, 16000, 32000]);
});
