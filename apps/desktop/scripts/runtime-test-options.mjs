import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { basename, join } from 'node:path';

// Test-file processes each own independent runtime/service pools. Bound their
// aggregate host load without changing product agent or task concurrency.
export const RUNTIME_TEST_FILE_WORKERS = 2;
export function runtimeTestArguments(tsxPath, tests, { ci = false } = {}) {
  return [
    tsxPath,
    '--test',
    `--test-concurrency=${RUNTIME_TEST_FILE_WORKERS}`,
    ...(ci ? ['--test-reporter=tap'] : []),
    ...tests,
  ];
}

export const WINDOWS_NATIVE_TEST_PRIORITY = Object.freeze([
  'pty-exit-cleanup.test.ts',
  'pty-close-order.test.ts',
  'workspace-terminal-windows.test.ts',
  'workspace-terminal-drain.test.ts',
  'workspace-bundled-terminal.test.ts',
  'workspace-debug-terminal.test.ts',
]);

/** Keep every discovered file; prioritize real Windows lifecycle evidence. */
export function orderRuntimeTestFiles(files, platform = process.platform) {
  const remaining = [...files].sort();
  if (new Set(remaining).size !== remaining.length)
    throw Error('duplicate runtime test file');
  if (platform !== 'win32') return remaining;
  const available = new Set(remaining);
  const priority = WINDOWS_NATIVE_TEST_PRIORITY.filter((name) =>
    available.has(name),
  );
  return [...priority, ...remaining.filter((name) => !priority.includes(name))];
}

/** Separate processes are required: Node discovers/sorts test files itself. */
export function runtimeTestGroups(files, platform = process.platform) {
  const ordered = orderRuntimeTestFiles(files, platform);
  if (platform !== 'win32') return [{ name: 'all', files: ordered }];
  const priority = new Set(WINDOWS_NATIVE_TEST_PRIORITY);
  return [
    {
      name: 'windows-native',
      files: ordered.filter((file) => priority.has(basename(file))),
    },
    {
      name: 'remaining',
      files: ordered.filter((file) => !priority.has(basename(file))),
    },
  ].filter((group) => group.files.length);
}

export function runRuntimeTestGroups({
  executable,
  tsxPath,
  groups,
  env,
  ci = false,
  receiptDirectory,
  stdio = 'inherit',
}) {
  mkdirSync(receiptDirectory, { recursive: true });
  let exitCode = 0;
  const receipts = [];
  for (const [index, group] of groups.entries()) {
    const path = join(
      receiptDirectory,
      `stage-${index + 1}-${group.name}.json`,
    );
    const receipt = {
      name: group.name,
      files: group.files,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    const persist = () => {
      writeFileSync(path + '.tmp', JSON.stringify(receipt, null, 2) + '\n');
      const handle = openSync(path + '.tmp', 'r');
      try {
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      renameSync(path + '.tmp', path);
    };
    persist();
    console.log(
      `# runtime stage ${index + 1}/${groups.length}: ${group.name} (${group.files.length} files)`,
    );
    const result = spawnSync(
      executable,
      runtimeTestArguments(tsxPath, group.files, { ci }),
      { stdio, env },
    );
    const code = result.status ?? 1;
    Object.assign(receipt, {
      status: code === 0 ? 'passed' : 'failed',
      completedAt: new Date().toISOString(),
      exitCode: result.status,
      signal: result.signal,
      ...(result.error
        ? { errorCode: result.error.code ?? 'SPAWN_FAILED' }
        : {}),
    });
    persist();
    receipts.push(receipt);
    if (code !== 0) exitCode = code;
  }
  return { exitCode, receipts };
}
