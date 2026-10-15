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
