import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { scratch } from './helpers.js';
import { verifyWindowsQueryPackage } from '../scripts/verify-windows-query-package.js';

function packageFixture(base: string, arch: 'x64' | 'arm64') {
  const worker = join(base, 'app', 'dist', 'windows_process_native.js');
  const addon = join(
    base,
    'app',
    'node_modules',
    '@koromix',
    `koffi-win32-${arch}`,
    `win32_${arch}`,
    'koffi.node',
  );
  const node = join(base, 'runtime', 'node.exe');
  for (const path of [worker, addon, node]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'synthetic package member');
  }
  return { worker, addon, node };
}

for (const arch of ['x64', 'arm64'] as const) {
  test(`the Windows ${arch} stage loads its worker with the bundled runtime from the relocated package`, (t) => {
    const root = scratch(t);
    const files = packageFixture(root, arch);
    const calls: unknown[] = [];
    verifyWindowsQueryPackage(
      root,
      `windows-${arch}`,
      (command, args, cwd) => {
        calls.push({ command, args, cwd });
        return JSON.stringify({
          platform: 'win32',
          arch,
          koffi: '3.3.3',
          loaded: true,
        });
      },
      { platform: 'win32', arch },
    );
    assert.deepEqual(calls, [
      {
        command: files.node,
        args: [files.worker, '--load-only'],
        cwd: join(root, 'app'),
      },
    ]);
  });
}

test('a package missing either the worker or its native optional addon fails before it can claim readiness', (t) => {
  for (const member of ['worker', 'addon'] as const) {
    const root = scratch(t);
    const files = packageFixture(root, 'arm64');
    rmSync(files[member]);
    assert.throws(
      () =>
        verifyWindowsQueryPackage(
          root,
          'windows-arm64',
          () => assert.fail('incomplete package executed'),
          { platform: 'win32', arch: 'arm64' },
        ),
      /missing/,
    );
  }
});

test('a host/target architecture mismatch cannot package the host native addon as another target', (t) => {
  const root = scratch(t);
  packageFixture(root, 'arm64');
  assert.throws(
    () =>
      verifyWindowsQueryPackage(
        root,
        'windows-arm64',
        () => assert.fail('wrong architecture executed'),
        { platform: 'win32', arch: 'x64' },
      ),
    /host/,
  );
});

test('an unsuccessful native load or wrong worker receipt fails the package check', (t) => {
  const root = scratch(t);
  packageFixture(root, 'x64');
  const primary = new Error('native addon could not load');
  assert.throws(
    () =>
      verifyWindowsQueryPackage(
        root,
        'windows-x64',
        () => {
          throw primary;
        },
        { platform: 'win32', arch: 'x64' },
      ),
    (error) => error === primary,
  );
  for (const receipt of [
    { platform: 'win32', arch: 'arm64', koffi: '3.3.3', loaded: true },
    { platform: 'win32', arch: 'x64', koffi: 'other', loaded: true },
    { platform: 'win32', arch: 'x64', koffi: '3.3.3', loaded: false },
  ]) {
    assert.throws(() =>
      verifyWindowsQueryPackage(
        root,
        'windows-x64',
        () => JSON.stringify(receipt),
        { platform: 'win32', arch: 'x64' },
      ),
    );
  }
});

test('other targets do not load the Windows installer worker', (t) => {
  verifyWindowsQueryPackage(
    scratch(t),
    'linux-arm64',
    () => assert.fail('Windows worker loaded on another target'),
    { platform: 'linux', arch: 'arm64' },
  );
});
