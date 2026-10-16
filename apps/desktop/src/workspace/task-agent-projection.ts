import { statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TaskRecord } from './task-store';

/** Read history without creating a scheduler, reconciling state or replaying work. */
export function readArchivedTaskAttempts(options: {
  dataDir: string;
  workspace: string;
  ownerSessionId: string;
}): readonly TaskRecord[] {
  const path = join(options.dataDir, 'collaboration.sqlite');
  try {
    statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const workspace = realpathSync.native(options.workspace);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0) > 1)
      throw Error('collaboration database requires a newer Circle version');
    const records = db
      .prepare('SELECT record FROM attempts ORDER BY task_id,attempt')
      .all()
      .map((row) => JSON.parse(String(row.record)) as TaskRecord)
      .filter(
        (task) =>
          task.spec.sessionId === options.ownerSessionId &&
          task.spec.workspace === workspace,
      );
    const freeze = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    };
    freeze(records);
    return records;
  } finally {
    db.close();
  }
}

/** Tool output selects an attempt; only the main-process owner-scoped ledger grants identity. */
export function taskToolAgentIds(
  name: string,
  args: Record<string, unknown>,
  output: string,
  attempts: readonly TaskRecord[],
): string[] | undefined {
  if (!name.startsWith('native_tasks_')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  let selection: { id: string; attempt: number }[] = [];
  if (name === 'native_tasks_enqueue' || name === 'native_tasks_analyze') {
    if (
      !Array.isArray(args.tasks) ||
      !parsed ||
      typeof parsed !== 'object' ||
      !('tasks' in parsed) ||
      !Array.isArray(parsed.tasks)
    )
      return undefined;
    const requested = new Set(
      args.tasks.flatMap((task) =>
        task && typeof task === 'object' && typeof task.id === 'string'
          ? [task.id]
          : [],
      ),
    );
    selection = parsed.tasks.flatMap((task) =>
      task &&
      typeof task === 'object' &&
      task.spec &&
      requested.has(task.spec.id) &&
      task.attempt === 1
        ? [{ id: task.spec.id, attempt: 1 }]
        : [],
    );
  } else if (
    ['native_tasks_retry', 'native_tasks_list', 'native_tasks_wait'].includes(
      name,
    )
  ) {
    const records =
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      'tasks' in parsed
        ? parsed.tasks
        : name === 'native_tasks_retry' &&
            parsed &&
            typeof parsed === 'object' &&
            'task' in parsed
          ? [parsed.task]
          : undefined;
    if (!Array.isArray(records)) return undefined;
    const requested =
      name === 'native_tasks_retry'
        ? [args.id]
        : name === 'native_tasks_wait'
          ? args.ids
          : undefined;
    selection = records.flatMap((record) => {
      if (
        !record ||
        typeof record !== 'object' ||
        !record.spec ||
        typeof record.spec.id !== 'string' ||
        !Number.isSafeInteger(record.attempt)
      )
        return [];
      if (
        requested !== undefined &&
        (!Array.isArray(requested) || !requested.includes(record.spec.id))
      )
        return [];
      return [{ id: record.spec.id, attempt: record.attempt }];
    });
  }
  const ids = selection.flatMap((selected) => {
    const task = attempts.find(
      (task) =>
        task.spec.id === selected.id && task.attempt === selected.attempt,
    );
    return task
      ? [
          task.runtimeSessionId,
          ...(task.reviewers ?? []).map((reviewer) => reviewer.sessionId),
        ].filter((id): id is string => !!id)
      : [];
  });
  return ids.length ? [...new Set(ids)] : undefined;
}

export const taskNeedsReconciliation = (
  task: Pick<TaskRecord, 'state'>,
): boolean =>
  ['queued', 'preparing', 'running', 'waiting', 'cancelling'].includes(
    task.state,
  );

/** Language edits are previews. Disk changes must pass the documents write guard. */
export function assertReadonlyTaskRequest(
  service: string,
  method: string,
  params: Record<string, unknown> = {},
): void {
  if (
    service === 'documents' &&
    !['read', 'refresh', 'resolveSource'].includes(method)
  )
    throw Error('read-only agent source cannot modify workspace documents');
  if (service === 'language') {
    const request = method === 'request' ? params.method : method;
    if (
      typeof request !== 'string' ||
      ![
        'open',
        'change',
        'close',
        'sync',
        'project',
        'refresh',
        'definition',
        'references',
        'rename',
        'completion',
        'format',
        'diagnostics',
        'hover',
      ].includes(request) ||
      params.apply === true ||
      params.write === true
    )
      throw Error('read-only agent source permits language previews only');
  }
}
