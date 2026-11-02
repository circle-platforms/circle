import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { scratch } from '../../../tests/helpers.ts';
import {
  PATCHED_SHA256,
  patchNodePtySource,
  repairNodePtyOnMacos,
} from '../scripts/node-pty-macos.mjs';

const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');
const installed = dirname(
  createRequire(import.meta.url).resolve('node-pty/package.json'),
);
// On macOS the install already applied the fix; elsewhere this is 1.1.0 as published.
const installedSource = () =>
  readFile(join(installed, 'src/unix/pty.cc'), 'utf8');

test('the fix applies to node-pty 1.1.0 only, once, and gives the reviewed source', async () => {
  const fixed = patchNodePtySource(await installedSource());
  assert.equal(sha256(fixed), PATCHED_SHA256);
  assert.equal(
    patchNodePtySource(fixed),
    fixed,
    'a second run changes nothing',
  );
  assert.match(fixed, /\n {4}close\(kq\);\n#else/);
  assert.match(fixed, /if \(slave != -1\) \{\n {4}close\(slave\);/);
  assert.match(
    fixed,
    /while \(opened > 0\) \{\n {4}close\(low_fds\[--opened\]\);/,
  );
  assert.throws(
    () => patchNodePtySource(fixed.replace('close(kq);', '')),
    /unexpected node-pty src\/unix\/pty\.cc/,
  );
});

/** A node-pty package in a scratch folder: fixed source, the upstream binary, no build. */
async function fakePackage(t: TestContext, version = '1.1.0') {
  const root = scratch(t, 'circle-node-pty-');
  await writeFile(join(root, 'package.json'), '{"name":"fixture"}');
  const pkg = join(root, 'node_modules', 'node-pty');
  await mkdir(join(pkg, 'src', 'unix'), { recursive: true });
  await mkdir(join(pkg, 'prebuilds', 'darwin-arm64'), { recursive: true });
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'node-pty', version }),
  );
  await writeFile(
    join(pkg, 'src/unix/pty.cc'),
    patchNodePtySource(await installedSource()),
  );
  await writeFile(join(pkg, 'prebuilds/darwin-arm64/pty.node'), 'upstream');
  // node-pty is found by its real path, which on macOS is under /private.
  return { root, pkg: realpathSync(pkg) };
}

/** node-gyp and lipo as a test sees them: each build writes its arch into the files. */
function fakeTools(pkg: string, lies: Record<string, string> = {}) {
  const calls: string[] = [];
  let arch = '';
  const run = (file: string, args: string[]) => {
    calls.push([file === process.execPath ? 'node' : file, ...args].join(' '));
    if (file === 'lipo')
      return `${lies[arch] ?? (arch === 'x64' ? 'x86_64' : arch)}\n`;
    arch = args.find((arg) => arg.startsWith('--arch='))!.slice(7);
    mkdirSync(join(pkg, 'build', 'Release'), { recursive: true });
    for (const name of ['pty.node', 'spawn-helper'])
      writeFileSync(join(pkg, 'build', 'Release', name), `${name} ${arch}`);
    return '';
  };
  return { calls, run, gyp: () => 'node-gyp.js' };
}

test('on macOS both architectures are built into prebuilds, and a kept build is not made twice', async (t) => {
  const { root, pkg } = await fakePackage(t);
  const tools = fakeTools(pkg);
  assert.equal(
    await repairNodePtyOnMacos(root, { platform: 'darwin', ...tools }),
    true,
  );
  assert.deepEqual(tools.calls, [
    'node node-gyp.js rebuild --arch=arm64',
    `lipo -archs ${join(pkg, 'build/Release/pty.node')}`,
    `lipo -archs ${join(pkg, 'build/Release/spawn-helper')}`,
    'node node-gyp.js rebuild --arch=x64',
    `lipo -archs ${join(pkg, 'build/Release/pty.node')}`,
    `lipo -archs ${join(pkg, 'build/Release/spawn-helper')}`,
  ]);
  for (const arch of ['arm64', 'x64']) {
    const target = join(pkg, 'prebuilds', `darwin-${arch}`);
    assert.equal(
      await readFile(join(target, 'pty.node'), 'utf8'),
      `pty.node ${arch}`,
    );
    assert.equal(
      statSync(join(target, 'spawn-helper')).mode & 0o111,
      0o111,
      'the helper can be run',
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(target, 'circle-build.json'), 'utf8')),
      {
        version: '1.1.0',
        source: PATCHED_SHA256,
        arch,
      },
    );
  }
  assert.equal(
    existsSync(join(pkg, 'build')),
    false,
    'nothing shadows prebuilds',
  );
  await repairNodePtyOnMacos(root, { platform: 'darwin', ...tools });
  assert.equal(tools.calls.length, 6, 'the kept builds are not made again');
});

test('a build for the wrong architecture is refused before it replaces anything', async (t) => {
  const { root, pkg } = await fakePackage(t);
  await assert.rejects(
    repairNodePtyOnMacos(root, {
      platform: 'darwin',
      ...fakeTools(pkg, { arm64: 'x86_64' }),
    }),
    /pty\.node built for x86_64, not arm64/,
  );
  assert.equal(
    await readFile(join(pkg, 'prebuilds/darwin-arm64/pty.node'), 'utf8'),
    'upstream',
  );
});

test('another node-pty version is refused on macOS, and other systems are left as installed', async (t) => {
  const { root, pkg } = await fakePackage(t, '1.2.0');
  const tools = fakeTools(pkg);
  await assert.rejects(
    repairNodePtyOnMacos(root, { platform: 'darwin', ...tools }),
    /node-pty 1\.2\.0 is installed/,
  );
  for (const platform of ['linux', 'win32'])
    assert.equal(
      await repairNodePtyOnMacos(root, { platform, ...tools }),
      false,
    );
  assert.deepEqual(tools.calls, []);
});
