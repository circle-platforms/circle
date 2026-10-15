import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { serialize, deserialize } from 'node:v8';

export interface OperationIdentity {
  id: string;
  sessionId: string;
  service: string;
  method: string;
  paramsHash: string;
}
export interface OperationResultCodec {
  seal(value: string): Promise<string>;
  unseal(value: string): Promise<string>;
}
export interface OperationLedgerOptions {
  directory: string;
  inlineResultBytes?: number;
  /** Host-only secure codec may replace the private encrypted local result store. */
  resultCodec?: OperationResultCodec;
  /** Must return a public safe message. Original error/stack are never persisted. */
  redactError?: (error: unknown) => string;
}
export class OperationNeedsReviewError extends Error {
  readonly code = 'OPERATION_NEEDS_REVIEW';
  constructor(
    message = 'operation outcome needs review; inspect effects before retrying',
  ) {
    super(message);
    this.name = 'OperationNeedsReviewError';
  }
}
export class OperationIdentityConflictError extends Error {
  readonly code = 'OPERATION_ID_CONFLICT';
  constructor() {
    super('operation id was reused with different input or ownership');
    this.name = 'OperationIdentityConflictError';
  }
}
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
function fingerprint(operation: OperationIdentity): string {
  if (
    !/^[A-Za-z0-9:_-]{1,200}$/.test(operation.id) ||
    !/^[A-Za-z0-9:_-]{1,200}$/.test(operation.sessionId) ||
    !/^[a-z][a-z0-9_-]{0,63}$/i.test(operation.service) ||
    !/^[a-z][a-z0-9_-]{0,63}$/i.test(operation.method) ||
    !/^[a-f0-9]{64}$/.test(operation.paramsHash)
  )
    throw Error('valid operation identity and parameter SHA256 are required');
  return digest(
    JSON.stringify([
      operation.sessionId,
      operation.service,
      operation.method,
      operation.paramsHash,
    ]),
  );
}
function encode(value: unknown): string {
  return 'v8:' + serialize(value).toString('base64');
}
function decode(value: string): unknown {
  if (!value.startsWith('v8:'))
    throw Error('invalid operation result envelope');
  return deserialize(Buffer.from(value.slice(3), 'base64'));
}
async function privateCodec(directory: string): Promise<OperationResultCodec> {
  const path = join(directory, 'result.key');
  let key: Buffer;
  try {
    key = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    key = randomBytes(32);
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(key);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  if (key.length !== 32) throw Error('invalid private operation result key');
  await chmod(path, 0o600);
  return {
    async seal(value) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([
        cipher.update(value, 'utf8'),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
        'base64',
      );
    },
    async unseal(value) {
      const bytes = Buffer.from(value, 'base64');
      if (bytes.length < 28) throw Error('invalid encrypted operation result');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        bytes.subarray(0, 12),
      );
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}

/** Durable mutation deduplication. Read operations should bypass this store. */
export class OperationLedger {
  private readonly token = randomUUID();
  private readonly inFlight = new Map<
    string,
    { fingerprint: string; promise: Promise<unknown> }
  >();
  private closing = false;
  private closed = false;
  private constructor(
    private readonly options: OperationLedgerOptions,
    private readonly db: DatabaseSync,
    private readonly codec: OperationResultCodec,
  ) {}
  static async open(options: OperationLedgerOptions): Promise<OperationLedger> {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    await chmod(options.directory, 0o700);
    const dbPath = join(options.directory, 'operations.sqlite');
    const db = new DatabaseSync(dbPath);
    await chmod(dbPath, 0o600);
    try {
      if (
        Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0) > 1
      )
        throw Error('operation ledger requires a newer Circle version');
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,token TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,identity_hash TEXT NOT NULL,session_id TEXT NOT NULL,service TEXT NOT NULL,method TEXT NOT NULL,params_hash TEXT NOT NULL,state TEXT NOT NULL,result TEXT,artifact_hash TEXT,error_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
        PRAGMA user_version=1;`);
      const ledger = new OperationLedger(
        options,
        db,
        options.resultCodec ?? (await privateCodec(options.directory)),
      );
      db.exec('BEGIN IMMEDIATE');
      try {
        const owner = db
          .prepare('SELECT pid,token FROM owner WHERE id=1')
          .get();
        if (owner) {
          let alive = true;
          try {
            process.kill(Number(owner.pid), 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH')
              alive = false;
            else throw error;
          }
          if (alive) throw Error('operation ledger already has a live owner');
        }
        db.prepare(
          'INSERT OR REPLACE INTO owner(id,pid,token) VALUES(1,?,?)',
        ).run(process.pid, ledger.token);
        db.prepare(
          "UPDATE operations SET state='needs_review',error_code='INTERRUPTED',updated_at=? WHERE state='started'",
        ).run(Date.now());
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return ledger;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  async run<T>(
    operation: OperationIdentity,
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.closing || this.closed) throw Error('operation ledger is closed');
    const identity = fingerprint(operation);
    const current = this.inFlight.get(operation.id);
    if (current) {
      if (current.fingerprint !== identity)
        throw new OperationIdentityConflictError();
      return current.promise as Promise<T>;
    }
    const saved = this.db
      .prepare('SELECT * FROM operations WHERE id=?')
      .get(operation.id);
    if (saved) {
      if (saved.identity_hash !== identity)
        throw new OperationIdentityConflictError();
      if (saved.state !== 'completed') throw new OperationNeedsReviewError();
      const replay = Promise.resolve()
        .then(async () => {
          try {
            let sealed: string;
            if (saved.artifact_hash) {
              const artifactHash = String(saved.artifact_hash);
              if (!/^[a-f0-9]{64}$/.test(artifactHash))
                throw Error('invalid operation artifact identity');
              sealed = await readFile(
                join(
                  this.options.directory,
                  'results',
                  `${artifactHash}.sealed`,
                ),
                'utf8',
              );
              if (digest(sealed) !== artifactHash)
                throw Error('operation artifact integrity failure');
            } else sealed = String(saved.result);
            return decode(await this.codec.unseal(sealed)) as T;
          } catch {
            this.db
              .prepare(
                "UPDATE operations SET state='needs_review',error_code='RESULT_UNAVAILABLE',updated_at=? WHERE id=?",
              )
              .run(Date.now(), operation.id);
            throw new OperationNeedsReviewError(
              'stored operation result is unavailable; inspect effects before retrying',
            );
          }
        })
        .finally(() => this.inFlight.delete(operation.id));
      this.inFlight.set(operation.id, {
        fingerprint: identity,
        promise: replay,
      });
      return replay;
    }
    this.db
      .prepare(
        "INSERT INTO operations(id,identity_hash,session_id,service,method,params_hash,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'started',?,?)",
      )
      .run(
        operation.id,
        identity,
        operation.sessionId,
        operation.service,
        operation.method,
        operation.paramsHash,
        Date.now(),
        Date.now(),
      );
    // Defer action one microtask so identical concurrent callers see this entry first.
    const promise = Promise.resolve().then(async () => {
      try {
        const value = await action();
        const sealed = await this.codec.seal(encode(value));
        let inline: string | null = sealed,
          artifactHash: string | null = null;
        if (
          Buffer.byteLength(sealed) > (this.options.inlineResultBytes ?? 16_384)
        ) {
          const directory = join(this.options.directory, 'results');
          await mkdir(directory, { recursive: true, mode: 0o700 });
          artifactHash = digest(sealed);
          const path = join(directory, `${artifactHash}.sealed`),
            temp = `${path}.${randomUUID()}.tmp`;
          await writeFile(temp, sealed, { mode: 0o600 });
          await rename(temp, path);
          inline = null;
        }
        this.db
          .prepare(
            "UPDATE operations SET state='completed',result=?,artifact_hash=?,updated_at=? WHERE id=?",
          )
          .run(inline, artifactHash, Date.now(), operation.id);
        return value;
      } catch (error) {
        const rawCode = (error as { code?: unknown })?.code;
        const code =
          typeof rawCode === 'string' &&
          new Set([
            'EACCES',
            'EPERM',
            'ENOENT',
            'EEXIST',
            'EIO',
            'ENOSPC',
            'ETIMEDOUT',
            'ECONNRESET',
            'ECONNREFUSED',
            'EPIPE',
            'EINVAL',
            'ECANCELED',
          ]).has(rawCode)
            ? rawCode
            : 'OPERATION_ERROR';
        this.db
          .prepare(
            "UPDATE operations SET state='needs_review',error_code=?,updated_at=? WHERE id=?",
          )
          .run(code, Date.now(), operation.id);
        throw new OperationNeedsReviewError(
          this.options.redactError?.(error) ||
            'operation failed; inspect effects before retrying',
        );
      } finally {
        this.inFlight.delete(operation.id);
      }
    });
    this.inFlight.set(operation.id, { fingerprint: identity, promise });
    return promise;
  }
  /** Metadata only; input bytes, results and raw exception messages are never exposed. */
  status(id: string): { state: string; errorCode?: string } | undefined {
    if (this.closed) throw Error('operation ledger is closed');
    const row = this.db
      .prepare('SELECT state,error_code FROM operations WHERE id=?')
      .get(id);
    return row
      ? {
          state: String(row.state),
          ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
        }
      : undefined;
  }
  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    await Promise.allSettled(
      [...this.inFlight.values()].map((value) => value.promise),
    );
    this.db.prepare('DELETE FROM owner WHERE id=1 AND token=?').run(this.token);
    this.db.close();
    this.closed = true;
  }
}
