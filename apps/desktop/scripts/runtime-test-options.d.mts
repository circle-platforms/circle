export const RUNTIME_TEST_FILE_WORKERS: 2;
export function runtimeTestArguments(
  tsxPath: string,
  tests: string[],
  options?: { ci?: boolean },
): string[];
