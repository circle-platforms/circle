import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';

type Run = (command: string, args: string[], cwd: string) => string;

// This installer-only worker stays outside the desktop application's bundled runtime.
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

function protectedTree(root: string): unknown[] {
  const entries: unknown[] = [];
  const visit = (relative: string): void => {
    const path = join(root, relative);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      entries.push({ relative, link: readlinkSync(path) });
    } else if (stat.isDirectory()) {
      entries.push({ relative, directory: true });
      for (const name of readdirSync(path).sort()) visit(join(relative, name));
    } else {
      entries.push({
        relative,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      });
    }
  };
  if (existsSync(root)) visit('');
  return entries;
}

// Drive the relocated package's real manager and native worker. The copied Node
// is the only held image, and every home/install location belongs to this smoke.
export async function verifyRelocatedWindowsQuery(
  root: string,
  temporary: string,
  home: string,
  env: NodeJS.ProcessEnv,
) {
  assert.equal(process.platform, 'win32');
  const base = join(temporary, 'held query fixture');
  const prefix = join(base, 'prefix');
  const bin = join(base, 'bin');
  const version = join(prefix, 'versions', '0.5.0');
  const folder = join(version, 'circle');
  const node = join(root, 'runtime', 'node.exe');
  const program = join(folder, 'circle.exe');
  mkdirSync(folder, { recursive: true });
  mkdirSync(bin, { recursive: true });
  cpSync(node, program);
  symlinkSync(version, join(prefix, 'current'), 'junction');
  const environment: NodeJS.ProcessEnv = { ...env, CIRCLE_HOME: home };
  for (const key of [
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_TEST_CONTEXT',
    'CIRCLE_PREFIX',
    'CIRCLE_BIN_DIR',
    'CIRCLE_INSTALL_RESULT',
  ])
    delete environment[key];
  const protectedRoots = [prefix, bin, home];
  const before = protectedRoots.map(protectedTree);
  const child = spawn(
    program,
    [
      '-e',
      "process.stdout.write('R'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));",
    ],
    {
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const cleanupErrors: unknown[] = [];
  child.on('error', (error) => cleanupErrors.push(error));
  child.stdin.on('error', (error) => cleanupErrors.push(error));
  child.stderr.on('error', (error) => cleanupErrors.push(error));
  let closed:
    { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const close = new Promise<void>((resolveClose) =>
    child.once('close', (code, signal) => {
      closed = { code, signal };
      resolveClose();
    }),
  );
  child.stderr.resume();
  let primary: unknown;
  const waitForClose = async (): Promise<boolean> => {
    if (closed) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        close.then(() => true),
        new Promise<boolean>((resolveWait) => {
          timer = setTimeout(() => resolveWait(false), 15_000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  try {
    const [, [value]] = await Promise.all([
      once(child, 'spawn'),
      once(child.stdout, 'data', { signal: AbortSignal.timeout(15_000) }),
    ]);
    assert.equal(
      value.toString(),
      'R',
      'the owned copied runtime reached its code',
    );
    const pid = child.pid;
    assert.ok(pid);
    const runManager = (packageRoot: string) => {
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      const result = spawnSync(
        join(packageRoot, 'runtime', 'node.exe'),
        [
          join(packageRoot, 'app', 'dist', 'install_manager.js'),
          packageRoot,
          prefix,
          bin,
          'circle-platforms/circle',
        ],
        {
          env: environment,
          encoding: 'utf8',
          timeout: 60_000,
          maxBuffer: 16_000_000,
        },
      );
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.signal, null);
      assert.equal(result.status, 1, result.stderr + result.stdout);
      assert.equal(
        result.stdout,
        '',
        'a blocked manager must not stage any release',
      );
      assert.deepEqual(
        protectedRoots.map(protectedTree),
        before,
        'blocked installation preserves every old install/data entry',
      );
      return result;
    };
    const blocked = runManager(root);
    assert.ok(
      blocked.stderr.includes(`still running (process ${pid})`),
      blocked.stderr,
    );
    // Corrupt only a new owned copy; the original relocated package stays intact.
    const missingBinding = join(base, 'package missing native binding');
    cpSync(root, missingBinding, { recursive: true });
    rmSync(
      join(
        missingBinding,
        'app',
        'node_modules',
        '@koromix',
        `koffi-win32-${process.arch}`,
        `win32_${process.arch}`,
        'koffi.node',
      ),
    );
    const rejected = runManager(missingBinding);
    assert.match(
      rejected.stderr,
      /running programs could not be listed/,
      rejected.stderr,
    );
    assert.deepEqual(protectedRoots.map(protectedTree), before);
  } catch (error) {
    primary = error;
    // Keep the primary durable before any owned-process cleanup failure.
    console.error(error);
    throw error;
  } finally {
    const errors = cleanupErrors;
    try {
      child.stdin.end();
      if (!(await waitForClose())) {
        errors.push(
          new Error('owned smoke runtime did not close after stdin ended'),
        );
        if (!child.kill())
          errors.push(
            new Error('owned smoke runtime did not accept termination'),
          );
        if (!(await waitForClose()))
          errors.push(new Error('owned smoke runtime close was not observed'));
      }
      if (closed && (closed.code !== 0 || closed.signal !== null))
        errors.push(new Error('owned smoke runtime did not exit normally'));
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      for (const error of errors) console.error(error);
      if (primary === undefined)
        throw new AggregateError(errors, 'owned query smoke cleanup failed');
    }
  }
  return {
    ownedPidMatched: true,
    missingBindingStopped: true,
    oldInstallAndDataPreserved: true,
    ownedChildClosed: true,
  };
}
