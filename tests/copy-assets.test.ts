import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

test('the build starts from an empty output folder, so what a removed source compiled to does not stay in it', (t) => {
  const scripts = (
    JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  assert.match(scripts.build!, /^tsx scripts\/clean-build\.ts && tsc /);
  const out = join(scratch(t), 'dist');
  // What an earlier build left: the output of a source that is gone
  mkdirSync(join(out, 'extensions', 'old'), { recursive: true });
  writeFileSync(join(out, 'removed_module.js'), 'export {};');
  writeFileSync(join(out, 'removed_module.d.ts'), 'export {};');
  const result = spawnSync(
    process.execPath,
    [
      join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join('scripts', 'clean-build.ts'),
      out,
    ],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(out), false);
});
