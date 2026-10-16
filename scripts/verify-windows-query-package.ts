import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

type Run = (command: string, args: string[], cwd: string) => string;

// The native process query worker of circle uninstall on Windows. It stays outside the
// desktop application's bundled runtime.
export function verifyWindowsQueryPackage(
  root: string,
  target: string,
  run: Run,
  host: { platform: string; arch: string } = process,
): void {
  if (!target.startsWith('windows-')) return;
  const arch = target.slice('windows-'.length);
  assert.equal(
    host.platform,
    'win32',
    'Windows package host must match its target',
  );
  assert.equal(
    host.arch,
    arch,
    'native addon host must match its target architecture',
  );
  assert.ok(
    arch === 'x64' || arch === 'arm64',
    'unsupported Windows package architecture',
  );
  const app = join(root, 'app');
  const worker = join(app, 'dist', 'windows_process_native.js');
  const node = join(root, 'runtime', 'node.exe');
  const addon = join(
    app,
    'node_modules',
    '@koromix',
    `koffi-win32-${arch}`,
    `win32_${arch}`,
    'koffi.node',
  );
  for (const path of [node, worker, addon])
    assert.ok(
      existsSync(path),
      `Windows query package member is missing: ${path}`,
    );
  const receipt = JSON.parse(run(node, [worker, '--load-only'], app));
  assert.deepEqual(
    receipt,
    { platform: 'win32', arch, koffi: '3.3.3', loaded: true },
    'the bundled runtime must load the target native query worker',
  );
}
