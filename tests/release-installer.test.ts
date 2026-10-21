import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runReleaseInstaller } from '../scripts/release-installer.js';
import { cleanup, cleanupServer, scratch } from './helpers.js';

test('the release smoke waits for installer completion while the caller can observe its progress', async (t) => {
  const base = scratch(t);
  const receipt = join(base, 'installation receipt.txt');
  const script = join(base, 'installer fixture.cjs');
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release: (() => void) | undefined;
  const server = createServer((_request, response) => {
    release = () => response.end('verified release');
    started();
  });
  cleanupServer(t, server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  writeFileSync(
    script,
    `const fs = require('node:fs');
require('node:http').get(process.argv[2], (response) => {
  let body = '';
  response.on('data', (chunk) => { body += chunk; });
  response.on('end', () => {
    fs.writeFileSync(process.argv[3], body);
    process.stdout.write(process.argv[4]);
  });
}).on('error', (error) => { console.error(error); process.exitCode = 1; });
`,
  );
  const running = runReleaseInstaller(
    process.execPath,
    [
      script,
      `http://127.0.0.1:${address.port}/`,
      receipt,
      'installed with spaces',
    ],
    process.env,
  );
  cleanup(t, async () => {
    release?.();
    await running.catch(() => {});
  });
  let completed = false;
  void running.then(
    () => {
      completed = true;
    },
    () => {
      completed = true;
    },
  );
  await Promise.race([
    ready,
    running.then(() => {
      throw Error('installer exited before reaching the controlled gate');
    }),
  ]);
  assert.equal(completed, false);
  assert.equal(existsSync(receipt), false);
  release!();
  assert.equal(await running, 'installed with spaces');
  assert.equal(readFileSync(receipt, 'utf8'), 'verified release');
});

test('a failed release installer preserves its exit code and diagnostic output', async (t) => {
  const base = scratch(t);
  const receipt = join(base, 'failure receipt.txt');
  await assert.rejects(
    runReleaseInstaller(
      process.execPath,
      [
        '-e',
        "require('node:fs').writeFileSync(process.argv[1], 'checked'); process.stdout.write('checking release'); process.stderr.write('invalid checksum'); process.exitCode = 7;",
        receipt,
      ],
      process.env,
    ),
    (error: unknown) => {
      const failure = error as { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 7);
      assert.equal(failure.stdout, 'checking release');
      assert.equal(failure.stderr, 'invalid checksum');
      return true;
    },
  );
  assert.equal(readFileSync(receipt, 'utf8'), 'checked');
});
