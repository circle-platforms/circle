import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { downloadRuntime, downloadRuntimeCached } from '../scripts/download.js';

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

test('the release build reuses the pinned Node.js archive from disk and only while its digest matches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'circle-download-cache-'));
  try {
    const cachePath = join(dir, 'node-v24.21.0-linux-x64.tar.gz');
    const bytes = Buffer.from('node archive');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const url = 'https://nodejs.test/node-v24.21.0-linux-x64.tar.gz';
    const quiet = { pause: async () => {}, log: () => {} };
    let calls = 0;
    const serving = async () => {
      calls++;
      return new Response(bytes);
    };

    // The first build downloads and leaves the archive on disk.
    assert.deepEqual(
      await downloadRuntimeCached(url, cachePath, digest, {
        ...quiet,
        request: serving,
      }),
      bytes,
    );
    assert.equal(calls, 1);
    assert.equal(existsSync(cachePath), true);

    // The next build reads it back without touching the network.
    assert.deepEqual(
      await downloadRuntimeCached(url, cachePath, digest, {
        ...quiet,
        request: async () => {
          throw new Error('the network was used');
        },
      }),
      bytes,
    );
    assert.equal(calls, 1);

    // An entry that no longer matches the digest is replaced, not trusted.
    writeFileSync(cachePath, Buffer.from('a different archive'));
    assert.deepEqual(
      await downloadRuntimeCached(url, cachePath, digest, {
        ...quiet,
        request: serving,
      }),
      bytes,
    );
    assert.equal(calls, 2);

    // A download that does not match the digest is refused and never cached.
    const refused = join(dir, 'node-v24.21.0-darwin-arm64.tar.gz');
    await assert.rejects(
      downloadRuntimeCached(url, refused, digest, {
        ...quiet,
        request: async () => new Response(Buffer.from('not the archive')),
      }),
      /runtime checksum does not match pinned digest/,
    );
    assert.equal(existsSync(refused), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
