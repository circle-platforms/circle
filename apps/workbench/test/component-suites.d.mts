export const COMPONENT_SUITES: readonly string[];
export function componentShard<T>(
  suites: readonly T[],
  index: number,
  count: number,
): T[];
export interface ComponentSuiteResult {
  file: string;
  directory: string;
  state: 'running' | 'passed' | 'failed';
  code?: number | null;
  signal?: string | null;
  timedOut?: boolean;
}
export function runComponentSuites(options?: {
  suites?: readonly string[];
  shard?: { index: number; count: number };
  outputRoot?: string;
  nodeArguments?: string[];
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ output: string; suites: ComponentSuiteResult[] }>;
