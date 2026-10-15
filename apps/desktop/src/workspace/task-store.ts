import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
  allowedResources?: string[];
  resource?: TaskResource;
}
export interface TaskRecord {
  spec: TaskSpec & { baseline: string; dependencies: string[] };
  state: TaskState;
  attempt: number;
  worktree?: string;
  branch?: string;
  reason?: string;
  result?: Json;
  createdAt: number;
  updatedAt: number;
}
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
