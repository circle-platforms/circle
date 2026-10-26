import type { DatabaseSync } from 'node:sqlite';
import type {
  CompactionArchive,
  CompactionAttempt,
  CompactionNode,
  CompactionOperation,
  CompactionSnapshot,
} from './compaction.js';
import { isRecord } from './settings.js';
import { emptyUsage, addUsage } from './types.js';
import {
  completionEvidenceFailure,
  ModelCompletionFailure,
} from './model_completion.js';

/** Independent rows: context versions retain references, never copies of the summary tree. */
export class CompactionStore {
  constructor(
    private db: DatabaseSync,
    private write: <T>(sessionId: string, run: () => T) => T,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS compaction_operations (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        head TEXT NOT NULL, updated REAL NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS compaction_operations_session ON compaction_operations(session_id,updated);
      CREATE TABLE IF NOT EXISTS compaction_attempts (
        id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES compaction_operations(id) ON DELETE CASCADE,
        request_hash TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS compaction_attempts_operation ON compaction_attempts(operation_id);
      CREATE INDEX IF NOT EXISTS compaction_attempts_request ON compaction_attempts(request_hash);
      CREATE TABLE IF NOT EXISTS compaction_nodes (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        key TEXT NOT NULL, source_key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,key));
      CREATE INDEX IF NOT EXISTS compaction_nodes_source ON compaction_nodes(session_id,source_key);
    `);
  }
  saveOperation(operation: CompactionOperation): void {
    const s = operation.snapshot;
    this.write(s.sessionId, () =>
      this.db
        .prepare(
          'INSERT INTO compaction_operations VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,data=excluded.data',
        )
        .run(
          s.operationId,
          s.sessionId,
          s.branchHead,
          s.updatedAt,
          JSON.stringify(operation),
        ),
    );
  }
  operations(sessionId: string, heads?: Set<string>): CompactionOperation[] {
    return this.db
      .prepare(
        'SELECT head,data FROM compaction_operations WHERE session_id=? ORDER BY rowid',
      )
      .all(sessionId)
      .filter((row) => !heads || heads.has(String(row.head)))
      .map((row) => JSON.parse(String(row.data)) as CompactionOperation);
  }
  saveAttempt(sessionId: string, attempt: CompactionAttempt): void {
    this.write(sessionId, () =>
      this.db
        .prepare(
          'INSERT INTO compaction_attempts VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        )
        .run(
          attempt.id,
          attempt.operationId,
          attempt.requestHash,
          JSON.stringify(attempt),
        ),
    );
  }
  attempts(operationId: string): CompactionAttempt[] {
    return this.db
      .prepare(
        'SELECT data FROM compaction_attempts WHERE operation_id=? ORDER BY rowid',
      )
      .all(operationId)
      .map((row) => JSON.parse(String(row.data)) as CompactionAttempt);
  }
  snapshot(value: CompactionSnapshot, interrupted = false) {
    const snapshot = structuredClone(value);
    if (snapshot.status === 'running') {
      const calls = this.attempts(snapshot.operationId);
      snapshot.usage = emptyUsage();
      snapshot.unknownCalls = 0;
      for (const call of calls) {
        if (call.usage) addUsage(snapshot.usage, call.usage);
        if (!call.usage || !call.usageComplete) snapshot.unknownCalls++;
      }
      snapshot.attempts = calls.length;
      if (interrupted) {
        snapshot.status = 'interrupted';
        snapshot.recoverable = true;
        snapshot.liveTokens = 0;
        snapshot.error = 'compaction interrupted; completed parts saved';
      }
    }
    return snapshot;
  }
  failedRequest(
    sessionId: string,
    hash: string,
  ): CompactionAttempt | undefined {
    const row = this.db
      .prepare(
        `SELECT a.data FROM compaction_attempts a JOIN compaction_operations o ON o.id=a.operation_id
      WHERE o.session_id=? AND a.request_hash=? ORDER BY a.rowid DESC LIMIT 1`,
      )
      .get(sessionId, hash);
    const attempt =
      row && (JSON.parse(String(row.data)) as CompactionAttempt | undefined);
    return attempt?.status === 'failed' &&
      ['context_limit', 'output_limit', 'non_shrinking'].includes(
        attempt.failureCode ?? '',
      )
      ? attempt
      : undefined;
  }
  node(sessionId: string, key: string): CompactionNode | undefined {
    const row = this.db
      .prepare('SELECT data FROM compaction_nodes WHERE session_id=? AND key=?')
      .get(sessionId, key);
    return row ? (JSON.parse(String(row.data)) as CompactionNode) : undefined;
  }
  bestNode(sessionId: string, sourceKey: string): CompactionNode | undefined {
    const row = this.db
      .prepare(
        "SELECT data FROM compaction_nodes WHERE session_id=? AND source_key=? ORDER BY length(json_extract(data,'$.text')) LIMIT 1",
      )
      .get(sessionId, sourceKey);
    return row ? (JSON.parse(String(row.data)) as CompactionNode) : undefined;
  }
  saveNode(sessionId: string, node: CompactionNode): void {
    this.write(sessionId, () =>
      this.db
        .prepare('INSERT OR IGNORE INTO compaction_nodes VALUES (?,?,?,?)')
        .run(sessionId, node.key, node.sourceKey, JSON.stringify(node)),
    );
  }
  archive(
    sessionId: string,
    heads: Set<string>,
  ): CompactionArchive | undefined {
    const operations = this.operations(sessionId, heads);
    if (!operations.length) return undefined;
    const nodes = new Map<string, CompactionNode>();
    const visit = (key: string) => {
      if (nodes.has(key)) return;
      const node = this.node(sessionId, key);
      if (!node) throw new Error('missing compaction node');
      nodes.set(key, node);
      node.children.forEach(visit);
    };
    operations.forEach((op) => op.nodes?.forEach(visit));
    return {
      operations,
      attempts: operations.flatMap((o) =>
        this.attempts(o.snapshot.operationId),
      ),
      nodes: [...nodes.values()],
    };
  }
  restore(sessionId: string, archive: CompactionArchive): void {
    for (const operation of archive.operations) this.saveOperation(operation);
    for (const attempt of archive.attempts)
      this.saveAttempt(sessionId, attempt);
    for (const node of archive.nodes) this.saveNode(sessionId, node);
    for (const operation of archive.operations) {
      if (operation.snapshot.status === 'interrupted') {
        operation.snapshot = this.snapshot(
          { ...operation.snapshot, status: 'running' },
          true,
        );
        this.saveOperation(operation);
      }
    }
  }
  /** Called only after acquiring a fresh exclusive session lease. */
  interruptAbandoned(sessionId: string): void {
    for (const operation of this.operations(sessionId)) {
      if (operation.snapshot.status !== 'running') continue;
      for (const attempt of this.attempts(operation.snapshot.operationId)) {
        const code = completionEvidenceFailure(attempt.completion);
        if (code) {
          attempt.status = 'failed';
          attempt.failureCode = code;
          attempt.error = new ModelCompletionFailure(code).message;
          this.saveAttempt(sessionId, attempt);
        } else if (attempt.status === 'running') {
          attempt.status = 'cancelled';
          attempt.error = 'runtime interrupted before completion';
          this.saveAttempt(sessionId, attempt);
        }
      }
      operation.snapshot = this.snapshot(operation.snapshot, true);
      operation.snapshot.updatedAt = Date.now();
      this.saveOperation(operation);
    }
  }
}

export function validateCompactionArchive(
  value: unknown,
  sessionId: string,
  heads: Set<string>,
): asserts value is CompactionArchive {
  if (
    !isRecord(value) ||
    !Array.isArray(value.operations) ||
    !Array.isArray(value.attempts) ||
    !Array.isArray(value.nodes)
  )
    throw new Error('invalid compaction archive');
  const ids = new Set<string>();
  for (const op of value.operations) {
    if (
      !isRecord(op) ||
      !isRecord(op.snapshot) ||
      typeof op.sourceHash !== 'string' ||
      typeof op.cutoffId !== 'string' ||
      typeof op.policy !== 'string'
    )
      throw new Error('invalid compaction operation');
    const s = op.snapshot;
    if (
      typeof s.operationId !== 'string' ||
      ids.has(s.operationId) ||
      s.sessionId !== sessionId ||
      !heads.has(String(s.branchHead)) ||
      !['running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(
        String(s.status),
      ) ||
      !['saving', 'summarizing', 'merging', 'recovering', 'done'].includes(
        String(s.stage),
      ) ||
      typeof s.recoverable !== 'boolean' ||
      !['auto', 'overflow', 'tool'].includes(String(s.trigger)) ||
      !isRecord(s.usage) ||
      ![
        'startedAt',
        'updatedAt',
        'completed',
        'total',
        'covered',
        'sourceSize',
        'attempts',
        'recoveries',
        'unknownCalls',
        'liveTokens',
      ].every(
        (key) =>
          typeof s[key] === 'number' && Number.isFinite(s[key]) && s[key] >= 0,
      )
    )
      throw new Error('invalid compaction snapshot');
    ids.add(s.operationId);
  }
  const calls = new Set<string>();
  for (const call of value.attempts) {
    if (
      !isRecord(call) ||
      typeof call.id !== 'string' ||
      calls.has(call.id) ||
      !ids.has(String(call.operationId)) ||
      typeof call.model !== 'string' ||
      typeof call.nodeKey !== 'string' ||
      typeof call.requestHash !== 'string' ||
      !['running', 'succeeded', 'failed', 'cancelled'].includes(
        String(call.status),
      )
    )
      throw new Error('invalid compaction attempt');
    if (
      call.usage !== undefined &&
      (!isRecord(call.usage) ||
        !['input_tokens', 'output_tokens', 'cache_read_tokens'].every(
          (key) =>
            Number.isSafeInteger(
              (call.usage as Record<string, unknown>)[key],
            ) && Number((call.usage as Record<string, unknown>)[key]) >= 0,
        ))
    )
      throw new Error('invalid compaction usage');
    if (
      call.usageComplete !== undefined &&
      typeof call.usageComplete !== 'boolean'
    )
      throw new Error('invalid compaction receipt');
    calls.add(call.id);
  }
  const nodes = new Set<string>();
  for (const node of value.nodes) {
    if (
      !isRecord(node) ||
      typeof node.key !== 'string' ||
      typeof node.sourceKey !== 'string' ||
      nodes.has(node.key) ||
      typeof node.text !== 'string' ||
      !Array.isArray(node.children) ||
      !node.children.every((k) => typeof k === 'string') ||
      !Array.isArray(node.ranges) ||
      !node.ranges.every(
        (r) =>
          isRecord(r) &&
          typeof r.messageId === 'string' &&
          Number.isSafeInteger(r.start) &&
          Number(r.start) >= 0 &&
          Number.isSafeInteger(r.end) &&
          Number(r.end) >= Number(r.start),
      )
    )
      throw new Error('invalid compaction node');
    nodes.add(node.key);
  }
  for (const node of value.nodes)
    if (!(node.children as string[]).every((key) => nodes.has(key)))
      throw new Error('missing compaction node');
  for (const op of value.operations)
    if (
      op.nodes !== undefined &&
      (!Array.isArray(op.nodes) ||
        !op.nodes.every((key: unknown) => nodes.has(String(key))))
    )
      throw new Error('invalid compaction node references');
  const remaining = new Map<string, number>();
  const parents = new Map<string, string[]>();
  for (const node of value.nodes as CompactionNode[]) {
    const children = new Set(node.children);
    remaining.set(node.key, children.size);
    for (const child of children)
      parents.set(child, [...(parents.get(child) ?? []), node.key]);
  }
  const ready = [...remaining]
    .filter(([, count]) => count === 0)
    .map(([id]) => id);
  for (let index = 0; index < ready.length; index++) {
    for (const parent of parents.get(ready[index]!) ?? []) {
      const count = remaining.get(parent)! - 1;
      remaining.set(parent, count);
      if (count === 0) ready.push(parent);
    }
  }
  if (ready.length !== nodes.size) throw new Error('cyclic compaction nodes');
}
