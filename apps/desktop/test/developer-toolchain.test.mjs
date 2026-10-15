import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepareNativeDependencies,
  prepareDeveloperTools,
  verifyArchive,
} from '../scripts/developer-toolchain.mjs';

test('developer tools reject tampered bytes before extraction or execution', async (t) => {
  const bytes = Buffer.from('fixture');
  assert.equal(
    verifyArchive(bytes, createHash('sha256').update(bytes).digest('hex'))
      .length,
    64,
  );
  assert.throws(
    () => verifyArchive(bytes, '0'.repeat(64)),
    /checksum mismatch/,
  );
  const dist = await mkdtemp(join(tmpdir(), 'circle-tool-reject-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await assert.rejects(
    prepareDeveloperTools(dist, {
      platform: 'darwin',
      arch: 'arm64',
      fetchArchive: async () => bytes,
    }),
    /checksum mismatch/,
  );
  await assert.rejects(stat(join(dist, 'tools/gh')), { code: 'ENOENT' });
});

test('unsupported architecture fails explicitly instead of copying host tools', async () => {
  await assert.rejects(
    prepareDeveloperTools('/unused', { platform: 'win32', arch: 'arm64' }),
    /unsupported developer tool target/,
  );
});

test('staged native runtime includes target addons, executable helper and TypeScript libraries', async (t) => {
  const dist = await mkdtemp(join(tmpdir(), 'circle-native-runtime-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('..', import.meta.url));
  await prepareNativeDependencies(root, dist);
  const require = createRequire(join(dist, 'probe.cjs'));
  const ts = require('typescript');
  assert.match(
    await readFile(ts.getDefaultLibFilePath({}), 'utf8'),
    /reference lib="es5"/,
  );
  assert.ok(
    (
      await stat(
        join(dist, 'node_modules/typescript-language-server/lib/cli.mjs'),
      )
    ).size > 1000,
  );
  const pty = require('node-pty');
  assert.equal(typeof pty.spawn, 'function');
  if (process.platform !== 'win32') {
    const helper = await stat(
      join(
        dist,
        process.platform === 'linux'
          ? 'node_modules/node-pty/build/Release/spawn-helper'
          : `node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`,
      ),
    );
    assert.ok(helper.mode & 0o111);
  }
});
