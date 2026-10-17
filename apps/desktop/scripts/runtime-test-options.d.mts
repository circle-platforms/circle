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
export function runtimeTestGroups(
  files: string[],
  platform?: string,
): { name: string; files: string[] }[];
export function runRuntimeTestGroups(options: {
  executable: string;
  tsxPath: string;
  groups: { name: string; files: string[] }[];
  env: NodeJS.ProcessEnv;
  ci?: boolean;
  receiptDirectory: string;
  stdio?: 'inherit' | 'pipe';
}): {
  exitCode: number;
  receipts: { name: string; files: string[]; status: string }[];
};
