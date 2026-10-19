import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type TaskState =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'waiting'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'interrupted'
  | 'needs_review';
export type TaskResource = 'agent' | 'build' | 'ui' | 'browser';
export const TASK_RESOURCES: readonly TaskResource[] = Object.freeze([
  'agent',
  'build',
  'ui',
  'browser',
]);
/** Scheduling grants only: file, tool and credential authorization remain separate. */
export function taskResourceGrants(
  value: unknown,
  host: readonly TaskResource[] = TASK_RESOURCES,
): TaskResource[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some(
      (item) =>
        typeof item !== 'string' ||
        !TASK_RESOURCES.includes(item as TaskResource),
    )
  )
    throw Error(
      'invalid task resource grants; create a new attempt using current host grants',
    );
  const grants = [...new Set(value as TaskResource[])];
  if (
    !grants.includes('agent') ||
    grants.some((resource) => !host.includes(resource))
  )
    throw Error('task resource grants exceed the current host grant');
  return grants;
}
export interface ProposedTask {
  key: string;
  prompt: string;
  access: 'write' | 'readonly';
  acceptanceCriteria: string[];
  /** Only keys in this proposal; the host adds the proposing task as a dependency. */
  dependencies: string[];
  resource?: TaskResource;
}
export interface TaskProposal {
  version: 1;
  source: {
    taskId: string;
    attempt: number;
    sessionId: string;
    runtimeSessionId: string;
    workspace: string;
    baseline: string;
  };
  tasks: ProposedTask[];
}
export interface TaskProposalReceipt {
  artifact: TaskArtifact;
  source: TaskProposal['source'];
  taskKeys: string[];
}
/** A proposal contains recommendations, never caller-selected authority or executable callbacks. */
export function proposedTasks(input: unknown): ProposedTask[] {
  if (!Array.isArray(input) || !input.length || input.length > 100)
    throw Error('a proposal requires 1 to 100 tasks');
  const text = (value: unknown, maximum: number): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum)
      throw Error('invalid proposed task text');
    return value;
  };
  const tasks = input.map((item): ProposedTask => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw Error('invalid proposed task');
    const value = item as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) =>
          ![
            'key',
            'prompt',
            'access',
            'acceptanceCriteria',
            'dependencies',
            'resource',
          ].includes(key),
      )
    )
      throw Error('proposals cannot select task authority');
    const key = text(value.key, 128);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(key))
      throw Error('invalid proposed task key');
    if (value.access !== 'write' && value.access !== 'readonly')
      throw Error('invalid proposed task access');
    if (
      !Array.isArray(value.acceptanceCriteria) ||
      !value.acceptanceCriteria.length ||
      value.acceptanceCriteria.length > 100 ||
      (value.dependencies !== undefined && !Array.isArray(value.dependencies))
    )
      throw Error('invalid proposed task criteria or dependencies');
    const dependencies = (value.dependencies ?? []) as unknown[];
    if (dependencies.length > 100)
      throw Error('too many proposed task dependencies');
    if (
      value.resource !== undefined &&
      (typeof value.resource !== 'string' ||
        !['agent', 'build', 'ui', 'browser'].includes(value.resource))
    )
      throw Error('invalid proposed task resource');
    return {
      key,
      prompt: text(value.prompt, 1024 * 1024),
      access: value.access,
      acceptanceCriteria: value.acceptanceCriteria.map((item) =>
        text(item, 8192),
      ),
      dependencies: [...new Set(dependencies.map((item) => text(item, 128)))],
      ...(value.resource === undefined
        ? {}
        : { resource: value.resource as TaskResource }),
    };
  });
  if (JSON.stringify(tasks).length > 1024 * 1024)
    throw Error('task proposal is too large');
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  if (byKey.size !== tasks.length) throw Error('duplicate proposed task key');
  const visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) throw Error('proposed task dependency cycle');
    if (done.has(key)) return;
    const task = byKey.get(key);
    if (!task) throw Error('unknown proposed task dependency');
    visiting.add(key);
    for (const dependency of task.dependencies) visit(dependency);
    visiting.delete(key);
    done.add(key);
  };
  for (const task of tasks) visit(task.key);
  return tasks;
}
export interface TaskSpec {
  id: string;
  sessionId?: string;
  parentId?: string;
  workspace: string;
  /** Resolved to a commit before insertion; never inherits uncommitted caller files. */
  baseline?: string;
  dependencies?: string[];
  access: 'write' | 'readonly';
  prompt: string;
  acceptanceCriteria: string[];
  allowedResources?: TaskResource[];
  resource?: TaskResource;
}
export interface TaskRecord {
  spec: TaskSpec & { baseline: string; dependencies: string[] };
  state: TaskState;
  attempt: number;
  worktree?: string;
  runtimeSessionId?: string;
  /** Execution is separate from the task's acceptance result. */
  runtimeState?: TaskState;
  reviewers?: TaskReviewerRecord[];
  branch?: string;
  reason?: string;
  result?: Json;
  /** Earlier attempts a person sent back, oldest first. This attempt's worker is told each reason. */
  sentBack?: TaskSendBack[];
  createdAt: number;
  updatedAt: number;
}
/**
 * A person's decision to send back an attempt that needed review. It is the
 * `result.review` of the attempt it rejected, and an entry in `sentBack` of
 * every later attempt. The field names follow the record of a passing review.
 */
export interface TaskSendBack {
  reviewer: 'human';
  decision: 'rejected';
  /** The attempt sent back, and the candidate patch and HEAD the person was shown. */
  expectedAttempt: number;
  expectedPatchSha256: string;
  head: string;
  reason: string;
  at: number;
}
export interface TaskReviewerRecord {
  sessionId: string;
  workspace: string;
  baseline: string;
  head: string;
  patchSha256: string;
  state: TaskState;
  reason?: string;
  artifact?: { id: string; path: string; sha256: string };
  createdAt: number;
  updatedAt: number;
}
export type TaskReviewerUpdate = Omit<
  TaskReviewerRecord,
  'createdAt' | 'updatedAt'
>;
export interface TaskArtifact {
  id: string;
  taskId: string;
  attempt: number;
  baseline: string;
  path: string;
  sha256: string;
  kind: string;
  createdAt: number;
}
export interface CollaborationEvent {
  cursor: number;
  epoch: string;
  seq: number;
  source: 'collaboration';
  taskId?: string;
  attempt?: number;
  type: string;
  payload: Json;
  createdAt: number;
}
export interface OperationRecord {
  id: string;
  kind: string;
  fingerprint: string;
  taskId?: string;
  attempt?: number;
  state: 'running' | 'succeeded' | 'needs_review';
  result?: Json;
}

export function taskArtifactDirectory(
  dataDir: string,
  taskId: string,
  attempt: number,
): string {
  return join(
    dataDir,
    'artifacts',
    createHash('sha256').update(JSON.stringify(taskId)).digest('hex'),
    String(attempt),
  );
}

/** Dedicated database: no migration or access to the user's Circle session database. */
export class TaskStore {
  readonly epoch = randomUUID();
  private seq = 0;
  private readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (
      Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0) >
      1
    ) {
      this.db.close();
      throw new Error('collaboration database requires a newer Circle version');
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(task_id TEXT NOT NULL, attempt INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY(task_id,attempt));
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(cursor INTEGER PRIMARY KEY AUTOINCREMENT, epoch TEXT NOT NULL, seq INTEGER NOT NULL, record TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  list(): TaskRecord[] {
    return this.db
      .prepare('SELECT record FROM tasks ORDER BY rowid')
      .all()
      .map((row) => JSON.parse(String(row.record)) as TaskRecord);
  }
  get(id: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT record FROM tasks WHERE id=?').get(id);
    return row ? (JSON.parse(String(row.record)) as TaskRecord) : undefined;
  }
  put(task: TaskRecord): void {
    const record = JSON.stringify(task);
    this.db
      .prepare(
        'INSERT INTO tasks(id,record) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record',
      )
      .run(task.spec.id, record);
    this.db
      .prepare(
        'INSERT INTO attempts(task_id,attempt,record) VALUES(?,?,?) ON CONFLICT(task_id,attempt) DO UPDATE SET record=excluded.record',
      )
      .run(task.spec.id, task.attempt, record);
  }
  attempts(id: string): TaskRecord[] {
    return this.db
      .prepare('SELECT record FROM attempts WHERE task_id=? ORDER BY attempt')
      .all(id)
      .map((row) => JSON.parse(String(row.record)) as TaskRecord);
  }
  /** Update an existing historical attempt without replacing the current one. */
  putHistoricalAttempt(task: TaskRecord): void {
    const result = this.db
      .prepare('UPDATE attempts SET record=? WHERE task_id=? AND attempt=?')
      .run(JSON.stringify(task), task.spec.id, task.attempt);
    if (result.changes !== 1) throw Error('task attempt is missing');
  }
  operation(id: string): OperationRecord | undefined {
    const row = this.db
      .prepare('SELECT record FROM operations WHERE id=?')
      .get(id);
    return row
      ? (JSON.parse(String(row.record)) as OperationRecord)
      : undefined;
  }
  putOperation(operation: OperationRecord): void {
    this.db
      .prepare(
        'INSERT INTO operations(id,record) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record',
      )
      .run(operation.id, JSON.stringify(operation));
  }
  operations(): OperationRecord[] {
    return this.db
      .prepare('SELECT record FROM operations')
      .all()
      .map((row) => JSON.parse(String(row.record)) as OperationRecord);
  }
  addArtifact(artifact: TaskArtifact): void {
    this.db
      .prepare('INSERT INTO artifacts(id,record) VALUES(?,?)')
      .run(artifact.id, JSON.stringify(artifact));
  }
  artifacts(taskId?: string): TaskArtifact[] {
    const all = this.db
      .prepare('SELECT record FROM artifacts ORDER BY rowid')
      .all()
      .map((row) => JSON.parse(String(row.record)) as TaskArtifact);
    return taskId ? all.filter((artifact) => artifact.taskId === taskId) : all;
  }
  event(type: string, payload: Json, task?: TaskRecord): CollaborationEvent {
    const record: Omit<CollaborationEvent, 'cursor'> = {
      epoch: this.epoch,
      seq: ++this.seq,
      source: 'collaboration',
      type,
      payload,
      ...(task ? { taskId: task.spec.id, attempt: task.attempt } : {}),
      createdAt: Date.now(),
    };
    const result = this.db
      .prepare('INSERT INTO events(epoch,seq,record) VALUES(?,?,?)')
      .run(this.epoch, record.seq, JSON.stringify(record));
    return { ...record, cursor: Number(result.lastInsertRowid) };
  }
  eventsAfter(cursor = 0, limit = 1000): CollaborationEvent[] {
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new Error('invalid event cursor');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
      throw new Error('invalid event limit');
    return this.db
      .prepare(
        'SELECT cursor,record FROM events WHERE cursor>? ORDER BY cursor LIMIT ?',
      )
      .all(cursor, limit)
      .map(
        (row) =>
          ({
            ...JSON.parse(String(row.record)),
            cursor: Number(row.cursor),
          }) as CollaborationEvent,
      );
  }
  close(): void {
    this.db.close();
  }
}
