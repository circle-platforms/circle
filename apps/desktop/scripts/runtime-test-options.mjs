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
