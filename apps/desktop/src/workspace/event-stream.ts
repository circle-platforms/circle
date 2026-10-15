import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, chmod } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WorkspaceServiceEvent } from '../workspace-protocol.ts';

export interface StreamCursor {
  offset: number;
  seq: number;
}
export interface PersistedWorkspaceEvent extends WorkspaceServiceEvent {
  cursor: StreamCursor;
  /** Producer sequence is distinct from this journal's global sequence. */
  sourceSeq?: number;
  sourceEpoch?: string;
}
export type EventInput = Omit<WorkspaceServiceEvent, 'epoch' | 'seq' | 'at'> & {
  sourceSeq?: number;
  sourceEpoch?: string;
};
export interface ReplayPage {
  events: PersistedWorkspaceEvent[];
  cursor: StreamCursor;
  hasMore: boolean;
}
export interface EventStreamOptions {
  ringBytes?: number;
  maxEventBytes?: number;
  sync?: boolean;
  maxPendingBytes?: number;
  /** Fault injection only; production defaults to fsync before publication. */
  beforeWrite?: () => Promise<void>;
}

/** Append-only evidence journal. Publication happens only after durable append.
 * A short final line from a killed producer is truncated on open; malformed complete
 * records fail closed. The ring is a cache, never the source of replay truth.
 */
export class WorkspaceEventStream {
  readonly epoch = randomUUID();
  private handle!: FileHandle;
  private writerLease?: DatabaseSync;
  private offset = 0;
  private seq = 0;
  private pending: Promise<unknown> = Promise.resolve();
  private failure: Error | undefined;
  private closed = false;
  private closing = false;
  private closePromise?: Promise<void>;
  private pendingBytes = 0;
  private ring: PersistedWorkspaceEvent[] = [];
  private ringSize = 0;
  private listeners = new Set<(event: PersistedWorkspaceEvent) => void>();
  readonly path: string;
  private options: EventStreamOptions;
  private constructor(path: string, options: EventStreamOptions) {
    this.path = path;
    this.options = options;
  }

  static async open(path: string, options: EventStreamOptions = {}) {
    const stream = new WorkspaceEventStream(path, options);
    await mkdir(dirname(path), { recursive: true });
    try {
      // A separate SQLite RESERVED lock provides cross-process ownership and
      // kernel crash release without stale PID files. The JSONL stays unchanged.
      const leasePath = path + '.owner.sqlite';
      stream.writerLease = new DatabaseSync(leasePath);
      try {
        stream.writerLease.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
      } catch (cause) {
        const busy = /locked|busy/i.test(
          cause instanceof Error ? cause.message : String(cause),
        );
        throw new Error(
          busy
            ? 'workspace event journal already has an active writer; close the other application before retrying'
            : 'workspace event journal writer lease could not be acquired',
          { cause },
        );
      }
      await chmod(leasePath, 0o600);
      // Windows append-only handles cannot truncate a crash tail. The writer
      // lease serializes appends; use read/write access and explicit offsets.
      stream.handle = await open(
        path,
        constants.O_RDWR | constants.O_CREAT,
        0o600,
      );
      if (!(await stream.handle.stat()).isFile())
        throw Error(
          'workspace event journal must be a regular file, not a directory or device',
        );
      for await (const row of stream.lines(0)) {
        const event = JSON.parse(row.text) as PersistedWorkspaceEvent;
        stream.validateRecord(event, row.end);
        stream.offset = row.end;
        stream.seq = event.seq;
        stream.cache(event);
      }
      // lines() deliberately omits only an unterminated final record.
      if ((await stream.handle.stat()).size !== stream.offset)
        await stream.handle.truncate(stream.offset);
      return stream;
    } catch (error) {
      try {
        await stream.handle?.close();
      } finally {
        stream.writerLease?.close();
        stream.writerLease = undefined;
      }
      throw error;
    }
  }

  get cursor(): StreamCursor {
    return { offset: this.offset, seq: this.seq };
  }
  get cachedBytes() {
    return this.ringSize;
  }
  subscribe(listener: (event: PersistedWorkspaceEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  append(input: EventInput): Promise<PersistedWorkspaceEvent> {
    return this.appendBatch([input]).then((events) => events[0]);
  }

  /** Bridge an independently sequenced service without destroying its cursor. */
  appendSource(event: WorkspaceServiceEvent): Promise<PersistedWorkspaceEvent> {
    const { seq, epoch, at: _at, ...input } = event;
    if (!Number.isSafeInteger(seq) || seq < 1 || !epoch)
      return Promise.reject(Error('invalid workspace source sequence'));
    return this.append({ ...input, sourceSeq: seq, sourceEpoch: epoch });
  }

  appendBatch(
    inputs: readonly EventInput[],
  ): Promise<PersistedWorkspaceEvent[]> {
    if (this.closing || this.closed)
      return Promise.reject(Error('workspace event stream is closed'));
    // Snapshot before scheduling so later producer mutation cannot rewrite history.
    let snapshot: EventInput[];
    let queuedBytes: number;
    try {
      const json = JSON.stringify(inputs);
      queuedBytes = Buffer.byteLength(json);
      snapshot = JSON.parse(json);
    } catch (cause) {
      return Promise.reject(
        new Error('workspace event is not serializable', { cause }),
      );
    }
    if (
      this.pendingBytes + queuedBytes >
      (this.options.maxPendingBytes ?? 8 * 1024 * 1024)
    )
      return Promise.reject(
        Error(
          'workspace event journal backpressure; producer must await append before retrying',
        ),
      );
    this.pendingBytes += queuedBytes;
    const operation = this.pending.then(async () => {
      if (this.closed) throw Error('workspace event stream is closed');
      if (this.failure) throw this.failure;
      const events: PersistedWorkspaceEvent[] = [];
      const lines: string[] = [];
      let offset = this.offset;
      let seq = this.seq;
      for (const input of snapshot) {
        const event = {
          ...input,
          epoch: this.epoch,
          seq: ++seq,
          at: new Date().toISOString(),
          cursor: { offset: 0, seq },
        };
        // Offset length can change as the decimal offset grows; converge exactly.
        let line = '';
        for (;;) {
          line = JSON.stringify(event) + '\n';
          const end = offset + Buffer.byteLength(line);
          if (event.cursor.offset === end) break;
          event.cursor.offset = end;
        }
        if (
          Buffer.byteLength(line) > (this.options.maxEventBytes ?? 1024 * 1024)
        )
          throw Error(
            'workspace event exceeds maximum size; store the original as a file artifact',
          );
        offset = event.cursor.offset;
        events.push(event);
        lines.push(line);
      }
      try {
        await this.options.beforeWrite?.();
        const buffer = Buffer.from(lines.join(''));
        let written = 0;
        while (written < buffer.length) {
          const result = await this.handle.write(
            buffer,
            written,
            buffer.length - written,
            this.offset + written,
          );
          if (!result.bytesWritten)
            throw Error('workspace event journal made no write progress');
          written += result.bytesWritten;
        }
        if (this.options.sync !== false) await this.handle.sync();
      } catch (cause) {
        this.failure = new Error(
          'workspace event journal persistence failed; no events were published',
          { cause },
        );
        throw this.failure;
      }
      this.offset = offset;
      this.seq = seq;
      for (const event of events) {
        this.cache(event);
        for (const listener of this.listeners) {
          // Consumer errors cannot turn a committed append into a failed retry.
          try {
            listener(event);
          } catch {
            /* consumer must reconnect using cursor */
          }
        }
      }
      return events;
    });
    this.pending = operation
      .finally(() => {
        this.pendingBytes -= queuedBytes;
      })
      .catch(() => undefined);
    return operation;
  }

  async replay(
    after: StreamCursor = { offset: 0, seq: 0 },
    limit = 256,
  ): Promise<ReplayPage> {
    await this.pending;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096)
      throw Error('invalid replay page size');
    if (
      !Number.isSafeInteger(after.offset) ||
      !Number.isSafeInteger(after.seq) ||
      after.offset < 0 ||
      after.seq < 0 ||
      after.offset > this.offset ||
      after.seq > this.seq
    )
      throw Error('invalid workspace event cursor');
    const events: PersistedWorkspaceEvent[] = [];
    let seq = after.seq;
    for await (const row of this.lines(after.offset, this.offset)) {
      const event = JSON.parse(row.text) as PersistedWorkspaceEvent;
      if (event.seq !== seq + 1 || event.cursor.offset !== row.end)
        throw Error('workspace event cursor gap');
      events.push(event);
      seq = event.seq;
      if (events.length === limit) break;
    }
    const cursor = events.at(-1)?.cursor ?? after;
    if (cursor.offset === this.offset && cursor.seq !== this.seq)
      throw Error('workspace event cursor gap');
    return { events, cursor, hasMore: cursor.offset < this.offset };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await this.pending;
      this.closed = true;
      this.listeners.clear();
      try {
        await this.handle.close();
      } finally {
        this.writerLease?.close();
        this.writerLease = undefined;
      }
    })();
    return this.closePromise;
  }

  private validateRecord(event: PersistedWorkspaceEvent, end: number) {
    if (
      !event ||
      event.seq !== this.seq + 1 ||
      event.cursor?.seq !== event.seq ||
      event.cursor?.offset !== end ||
      typeof event.epoch !== 'string' ||
      !event.epoch
    )
      throw Error('corrupt workspace event journal');
  }
  private cache(event: PersistedWorkspaceEvent) {
    const size = Buffer.byteLength(JSON.stringify(event));
    const bound = this.options.ringBytes ?? 2 * 1024 * 1024;
    this.ring.push(event);
    this.ringSize += size;
    while (this.ringSize > bound && this.ring.length)
      this.ringSize -= Buffer.byteLength(JSON.stringify(this.ring.shift()));
  }
  private async *lines(start: number, end?: number) {
    let offset = start;
    let pending = Buffer.alloc(0);
    const limit = end ?? (await this.handle.stat()).size;
    while (offset < limit) {
      const chunk = Buffer.alloc(Math.min(65536, limit - offset));
      const { bytesRead } = await this.handle.read(
        chunk,
        0,
        chunk.length,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let newline: number;
      while ((newline = pending.indexOf(10)) >= 0) {
        const text = pending.subarray(0, newline).toString('utf8');
        const rowEnd = offset - pending.length + newline + 1;
        pending = pending.subarray(newline + 1);
        yield { text, end: rowEnd };
      }
      if (pending.length > (this.options.maxEventBytes ?? 1024 * 1024))
        throw Error('workspace event journal record exceeds limit');
    }
  }
}
