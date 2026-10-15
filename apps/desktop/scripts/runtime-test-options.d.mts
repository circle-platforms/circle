export const RUNTIME_TEST_FILE_WORKERS: 2;
export function runtimeTestArguments(
  tsxPath: string,
  tests: string[],
  options?: { ci?: boolean },
): string[];
export const WINDOWS_NATIVE_TEST_PRIORITY: readonly string[];
export function orderRuntimeTestFiles(
  files: string[],
  platform?: string,
): string[];
