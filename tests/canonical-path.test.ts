import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import {
  canonicalPath,
  normalizeWorkspace,
  projectDataDir,
} from '../src/paths.js';
import { Sandbox } from '../src/sandbox.js';
import { scratch } from './helpers.js';

test('the legacy JavaScript realpath spelling cannot replace the native canonical spelling', async (t) => {
  const root = scratch(t),
    native = await realpath(root),
    original = fs.realpathSync;
  const legacy = Object.assign(
    ((...args: unknown[]) => {
      const result = Reflect.apply(original, fs, args);
      return typeof result === 'string'
        ? join(result, 'legacy-short-spelling')
        : result;
    }) as typeof realpathSync,
    { native: original.native },
  );
  fs.realpathSync = legacy;
  syncBuiltinESMExports();
  try {
    assert.equal(normalizeWorkspace(root), native);
    assert.equal(
      new Sandbox(root).resolvePath('missing.txt'),
      join(native, 'missing.txt'),
    );
  } finally {
    fs.realpathSync = original;
    syncBuiltinESMExports();
  }
});

test('canonicalization never treats a filesystem permission error as a missing file', (t) => {
  const root = scratch(t);
  t.mock.method(realpathSync, 'native', () => {
    throw Object.assign(Error('controlled path access denied'), {
      code: 'EACCES',
    });
  });
  assert.throws(() => canonicalPath(join(root, 'new.txt')), { code: 'EACCES' });
});

test('workspace roots, existing files and missing file tails use the same native representation as asynchronous realpath', async (t) => {
  const root = scratch(t),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'existing.txt'), 'actual file');
  const canonical = await realpath(workspace);
  const sandbox = new Sandbox(workspace);
  assert.equal(normalizeWorkspace(workspace), canonical);
  assert.equal(sandbox.workspace, canonical);
  assert.equal(
    canonicalPath(join(workspace, 'existing.txt')),
    await realpath(join(workspace, 'existing.txt')),
  );
  assert.equal(
    sandbox.resolvePath('nested/new.txt'),
    join(canonical, 'nested', 'new.txt'),
  );
  assert.equal(
    normalizeWorkspace(join(workspace, 'nested')),
    join(canonical, 'nested'),
  );
  assert.equal(sandbox.isInside('existing.txt'), true);
  assert.equal(sandbox.isInside('nested/new.txt'), true);
  assert.throws(() => sandbox.resolvePath('../outside.txt'), /traversal/);
  assert.throws(
    () => sandbox.checkMutablePath(sandbox.resolvePath('credentials.json')),
    /credential/,
  );
});

test('native path normalization retains symlink boundaries and refuses dangling links rather than granting their missing targets', async (t) => {
  const root = scratch(t),
    workspace = join(root, 'workspace'),
    outside = join(root, 'outside');
  mkdirSync(workspace);
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'outside');
  const directoryType = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(workspace, join(root, 'workspace-alias'), directoryType);
  symlinkSync(outside, join(workspace, 'external'), directoryType);
  const sandbox = new Sandbox(join(root, 'workspace-alias'));
  assert.equal(sandbox.workspace, await realpath(workspace));
  assert.equal(sandbox.isInside('external/secret.txt'), false);
  assert.equal(sandbox.isInside('external/nested/missing.txt'), false);
  assert.equal(
    projectDataDir(workspace, root),
    projectDataDir(join(root, 'workspace-alias'), root),
  );
  // A directory junction does not require Windows developer-mode symlink rights.
  symlinkSync(
    join(outside, 'not-created'),
    join(workspace, 'dangling'),
    directoryType,
  );
  assert.throws(() => sandbox.resolvePath('dangling/new.txt'), {
    code: 'ENOENT',
  });
});

test('background job output remains read-only through aliases and missing tails', (t) => {
  const root = scratch(t),
    workspace = join(root, 'workspace'),
    offload = join(root, 'offload');
  mkdirSync(workspace);
  mkdirSync(join(offload, 'background_jobs'), { recursive: true });
  const sandbox = new Sandbox(workspace, offload);
  assert.throws(
    () =>
      sandbox.checkMutablePath(
        sandbox.resolvePath('background_jobs/new/output.txt'),
      ),
    /read-only/,
  );
});

test(
  'Windows 8.3 temporary paths preserve root identity, workspace hashes and future file writes',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const temporary = scratch(t),
      workspace = join(temporary, 'workspace with a long native name');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'source.txt'), 'source');
    const canonical = await realpath(workspace);
    const short = execFileSync(
      'cmd.exe',
      ['/d', '/c', `for %I in ("${workspace}") do @echo %~sI`],
      { encoding: 'utf8' },
    ).trim();
    assert.equal(realpathSync.native(short), canonical);
    assert.equal(normalizeWorkspace(short), canonical);
    assert.equal(normalizeWorkspace(workspace), canonical);
    assert.equal(
      projectDataDir(short, temporary),
      projectDataDir(canonical, temporary),
    );
    const sandbox = new Sandbox(short);
    assert.equal(sandbox.workspace, canonical);
    assert.equal(
      sandbox.resolvePath('source.txt'),
      await realpath(join(workspace, 'source.txt')),
    );
    assert.equal(
      sandbox.resolvePath('not-yet/created.txt'),
      join(canonical, 'not-yet', 'created.txt'),
    );
    assert.equal(sandbox.isInside(join(canonical, 'source.txt')), true);
    assert.equal(sandbox.isInside(join(temporary, 'outside.txt')), false);
    if (short === canonical)
      t.diagnostic(
        'This volume returned no distinct 8.3 alias; native and async path consistency still checked.',
      );
    else t.diagnostic('A distinct Windows short-name alias was exercised.');
  },
);
