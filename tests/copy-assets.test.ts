import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './helpers.js';

const repo = fileURLToPath(new URL('..', import.meta.url));

test('the build replaces the shipped extensions, so one Circle no longer ships does not stay in the output', (t) => {
  const out = scratch(t);
  // What an earlier build left: an extension that is not in src/extensions.
  const leftover = join(out, 'extensions', 'leftover');
  mkdirSync(leftover, { recursive: true });
  writeFileSync(
    join(leftover, 'extension.mjs'),
    'export function register() {}',
  );
  const result = spawnSync(
    process.execPath,
    [
      join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join('scripts', 'copy-assets.ts'),
      out,
    ],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(leftover), false);
  assert.equal(
    existsSync(join(out, 'extensions', 'github', 'extension.ts')),
    true,
  );
});
