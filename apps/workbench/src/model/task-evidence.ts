import type { TaskRecord } from '../../../desktop/src/workspace/task-store';

export interface TaskEvidenceCheck {
  criterion: string;
  status: 'passed' | 'failed' | 'needs_review';
  source: 'command' | 'independent-review' | 'inspection' | 'human';
  evidence: string;
  command?: string;
  exitCode?: number;
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Project persisted host evidence, never infer checks from the worker's prose. */
export function taskEvidence(task: TaskRecord) {
  const report = object(task.result);
  // A result from a prior attempt must never be presented as the current result.
  if (
    !report ||
    report.attempt !== task.attempt ||
    report.taskId !== task.spec.id
  )
    return null;
  const checks: TaskEvidenceCheck[] = [];
  for (const input of Array.isArray(report.checks) ? report.checks : []) {
    const check = object(input);
    if (
      !check ||
      typeof check.criterion !== 'string' ||
      typeof check.evidence !== 'string' ||
      !['passed', 'failed', 'needs_review'].includes(String(check.status)) ||
      !['command', 'independent-review', 'inspection', 'human'].includes(
        String(check.source),
      )
    )
      continue;
    checks.push({
      criterion: check.criterion,
      status: check.status as TaskEvidenceCheck['status'],
      source:
        check.reviewer === 'human'
          ? 'human'
          : (check.source as TaskEvidenceCheck['source']),
      evidence: check.evidence,
      ...(typeof check.command === 'string' ? { command: check.command } : {}),
      ...(Number.isInteger(check.exitCode)
        ? { exitCode: check.exitCode as number }
        : {}),
    });
  }
  const changes = object(report.changes);
  return {
    checks,
    paths: Array.isArray(changes?.paths)
      ? changes.paths.filter((path): path is string => typeof path === 'string')
      : [],
    sha256: typeof changes?.sha256 === 'string' ? changes.sha256 : undefined,
    head: typeof changes?.head === 'string' ? changes.head : undefined,
  };
}
