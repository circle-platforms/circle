export const COMPONENT_SUITES: readonly string[];
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
  outputRoot?: string;
  nodeArguments?: string[];
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ output: string; suites: ComponentSuiteResult[] }>;
