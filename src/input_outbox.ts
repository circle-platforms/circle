import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaAttachment } from './types.js';
import { validateAttachments } from './media.js';

export type InputKind = 'steer' | 'followUp';
export type InputState =
  'queued' | 'recovery_pending' | 'consumed' | 'discarded';
export interface InputPayload {
  text: string;
  display: string;
  pastes?: Record<string, string>;
  attachments?: MediaAttachment[];
}
export interface StoredInput {
  id: string;
  sessionId: string;
  kind: InputKind;
  state: InputState;
  epoch: string;
  order: number;
  payload: InputPayload;
  createdAt: number;
  updatedAt: number;
}
export interface RecoverableInputs {
  version: number;
  items: StoredInput[];
}
export interface ResolveInputsRequest {
  ids: string[];
  expectedVersion: number;
  operationId: string;
  action: 'resume' | 'returnToDraft' | 'discard';
}
export interface ResolveInputsResult extends RecoverableInputs {
  action: ResolveInputsRequest['action'];
  /** False for an already-applied operation: callers must not start another run. */
  applied: boolean;
}
function payload(value: InputPayload): InputPayload {
  if (
    typeof value.text !== 'string' ||
    !value.text.trim() ||
    typeof value.display !== 'string' ||
    value.text.length > 64 * 1024 * 1024 ||
    value.display.length > 64 * 1024 * 1024 ||
    (value.pastes &&
      Object.values(value.pastes).some((text) => typeof text !== 'string'))
  )
    throw new Error('invalid queued input payload');
  if (value.attachments) validateAttachments(value.attachments);
  return structuredClone(value);
}
/** Private per-session outbox in the existing checkpoint database. Never executes recovered inputs. */
export class InputOutbox {
  constructor(
    private readonly db: DatabaseSync,
    private readonly writing: <T>(sessionId: string, action: () => T) => T,
    private readonly sessions?: {
      deferred(id: string): boolean;
      materialize(id: string): void;
      committed(id: string): void;
    },
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS input_outbox (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        epoch TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, ordinal INTEGER NOT NULL,
        payload TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS input_outbox_session ON input_outbox(session_id,state,ordinal);
      CREATE TABLE IF NOT EXISTS input_outbox_versions (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS input_outbox_operations (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL, signature TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(session_id,operation_id));
      CREATE TABLE IF NOT EXISTS input_outbox_identities (
        input_id TEXT PRIMARY KEY REFERENCES input_outbox(id) ON DELETE CASCADE,
        signature TEXT NOT NULL);
    `);
  }
  private transaction<T>(
    sessionId: string,
    action: () => T,
    materialize = false,
  ): T {
    return this.writing(sessionId, () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (materialize) this.sessions?.materialize(sessionId);
        if (
          !this.db.prepare('SELECT id FROM sessions WHERE id=?').get(sessionId)
        )
          throw new Error('unknown session');
        const result = action();
        this.db.exec('COMMIT');
        if (materialize) this.sessions?.committed(sessionId);
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }
  private bump(sessionId: string): void {
    this.db
      .prepare(
        'INSERT INTO input_outbox_versions VALUES (?,1) ON CONFLICT(session_id) DO UPDATE SET version=version+1',
      )
      .run(sessionId);
  }
  version(sessionId: string): number {
    return Number(
      this.db
        .prepare('SELECT version FROM input_outbox_versions WHERE session_id=?')
        .get(sessionId)?.version ?? 0,
    );
  }
  private decode(row: Record<string, unknown>): StoredInput {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      epoch: String(row.epoch),
      kind: row.kind as InputKind,
      state: row.state as InputState,
      order: Number(row.ordinal),
      payload: JSON.parse(String(row.payload)) as InputPayload,
      createdAt: Number(row.created),
      updatedAt: Number(row.updated),
    };
  }
  get(sessionId: string, id: string): StoredInput | undefined {
    const row = this.db
      .prepare('SELECT * FROM input_outbox WHERE session_id=? AND id=?')
      .get(sessionId, id);
    return row ? this.decode(row) : undefined;
  }
  list(sessionId: string, state?: InputState): StoredInput[] {
    return this.db
      .prepare(
        `SELECT * FROM input_outbox WHERE session_id=?${state ? ' AND state=?' : ''} ORDER BY ordinal,id`,
      )
      .all(...(state ? [sessionId, state] : [sessionId]))
      .map((row) => this.decode(row));
  }
  recover(sessionId: string, epoch: string): void {
    // An untouched deferred conversation has no persisted queue to recover.
    // Unknown IDs still reach the transaction and are rejected.
    if (this.sessions?.deferred(sessionId)) return;
    this.transaction(sessionId, () => {
      const result = this.db
        .prepare(
          "UPDATE input_outbox SET state='recovery_pending',updated=? WHERE session_id=? AND state='queued' AND epoch!=?",
        )
        .run(Date.now(), sessionId, epoch);
      if (result.changes) this.bump(sessionId);
    });
  }
  recoverable(sessionId: string): RecoverableInputs {
    return {
      version: this.version(sessionId),
      items: this.list(sessionId, 'recovery_pending'),
    };
  }
  enqueue(
    sessionId: string,
    epoch: string,
    kind: InputKind,
    value: InputPayload,
    inputId?: string,
  ): StoredInput {
    const safe = payload(value);
    if (!['steer', 'followUp'].includes(kind))
      throw new Error('invalid queue kind');
    if (
      inputId !== undefined &&
      (typeof inputId !== 'string' || !inputId.trim() || inputId.length > 256)
    )
      throw new Error('invalid input identity');
    const signature = createHash('sha256')
      .update(JSON.stringify({ sessionId, kind, payload: safe }))
      .digest('hex');
    return this.transaction(
      sessionId,
      () => {
        const id = inputId ?? randomUUID(),
          now = Date.now();
        const previous = this.db
          .prepare(
            'SELECT signature FROM input_outbox_identities WHERE input_id=?',
          )
          .get(id);
        if (previous) {
          if (previous.signature !== signature)
            throw new Error(
              'queued input identity reused with different input',
            );
          const stored = this.get(sessionId, id);
          if (!stored) throw new Error('queued input identity owner changed');
          return stored;
        }
        const order =
          Number(
            this.db
              .prepare(
                'SELECT MAX(ordinal) AS latest FROM input_outbox WHERE session_id=?',
              )
              .get(sessionId)?.latest ?? 0,
          ) + 1;
        this.db
          .prepare("INSERT INTO input_outbox VALUES (?,?,?,?,'queued',?,?,?,?)")
          .run(
            id,
            sessionId,
            epoch,
            kind,
            order,
            JSON.stringify(safe),
            now,
            now,
          );
        this.db
          .prepare('INSERT INTO input_outbox_identities VALUES (?,?)')
          .run(id, signature);
        this.bump(sessionId);
        return this.get(sessionId, id)!;
      },
      true,
    );
  }
  update(
    sessionId: string,
    epoch: string,
    changes: {
      id: string;
      payload?: InputPayload;
      kind?: InputKind;
      state?: 'discarded' | 'recovery_pending';
    }[],
  ): void {
    // Closing an untouched deferred runtime has no queued rows to discard.
    // A real change or unknown session must still pass the durable transaction.
    if (changes.length === 0 && this.sessions?.deferred(sessionId)) return;
    this.transaction(sessionId, () => {
      for (const change of changes) {
        const previous = this.get(sessionId, change.id);
        if (
          !previous ||
          previous.state !== 'queued' ||
          previous.epoch !== epoch
        )
          throw new Error('queued input changed');
        const next = change.payload
          ? payload(change.payload)
          : previous.payload;
        this.db
          .prepare(
            'UPDATE input_outbox SET payload=?,kind=?,state=?,updated=? WHERE session_id=? AND id=?',
          )
          .run(
            JSON.stringify(next),
            change.kind ?? previous.kind,
            change.state ?? previous.state,
            Date.now(),
            sessionId,
            change.id,
          );
      }
      if (changes.length) this.bump(sessionId);
    });
  }
  /** Called only inside CheckpointStore.appendOwned's transaction. */
  consumeInTransaction(sessionId: string, id: string, epoch: string): void {
    const result = this.db
      .prepare(
        "UPDATE input_outbox SET state='consumed',updated=? WHERE session_id=? AND id=? AND epoch=? AND state='queued'",
      )
      .run(Date.now(), sessionId, id, epoch);
    if (result.changes !== 1)
      throw new Error('queued input changed before consumption');
    this.bump(sessionId);
  }
  resolve(
    sessionId: string,
    epoch: string,
    request: ResolveInputsRequest,
  ): ResolveInputsResult {
    if (
      !request ||
      !Array.isArray(request.ids) ||
      !request.ids.length ||
      request.ids.length > 1000 ||
      new Set(request.ids).size !== request.ids.length ||
      request.ids.some((id) => typeof id !== 'string' || !id) ||
      !Number.isSafeInteger(request.expectedVersion) ||
      request.expectedVersion < 0 ||
      typeof request.operationId !== 'string' ||
      !request.operationId.trim() ||
      request.operationId.length > 256 ||
      !['resume', 'returnToDraft', 'discard'].includes(request.action)
    )
      throw new Error('invalid input recovery request');
    const signature = createHash('sha256')
      .update(
        JSON.stringify({
          ids: request.ids,
          expectedVersion: request.expectedVersion,
          action: request.action,
        }),
      )
      .digest('hex');
    return this.transaction(sessionId, () => {
      const previous = this.db
        .prepare(
          'SELECT signature,result FROM input_outbox_operations WHERE session_id=? AND operation_id=?',
        )
        .get(sessionId, request.operationId);
      if (previous) {
        if (previous.signature !== signature)
          throw new Error(
            'input recovery operation reused with different input',
          );
        return {
          ...JSON.parse(String(previous.result)),
          applied: false,
        } as ResolveInputsResult;
      }
      if (this.version(sessionId) !== request.expectedVersion)
        throw new Error(
          'recoverable inputs changed; refresh before continuing',
        );
      const selected = request.ids
        .map((id) => {
          const input = this.get(sessionId, id);
          if (!input || input.state !== 'recovery_pending')
            throw new Error('recoverable input changed');
          return input;
        })
        .sort((a, b) => a.order - b.order);
      if (request.action !== 'returnToDraft') {
        for (const input of selected)
          this.db
            .prepare(
              'UPDATE input_outbox SET epoch=?,state=?,updated=? WHERE session_id=? AND id=?',
            )
            .run(
              epoch,
              request.action === 'resume' ? 'queued' : 'discarded',
              Date.now(),
              sessionId,
              input.id,
            );
        this.bump(sessionId);
      }
      const result: ResolveInputsResult = {
        action: request.action,
        applied: true,
        version: this.version(sessionId),
        items: selected.map((input) => this.get(sessionId, input.id)!),
      };
      this.db
        .prepare('INSERT INTO input_outbox_operations VALUES (?,?,?,?)')
        .run(sessionId, request.operationId, signature, JSON.stringify(result));
      return result;
    });
  }
}
