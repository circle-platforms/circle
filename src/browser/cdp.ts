import type { Readable, Writable } from 'node:stream';

/** An event from the browser or from one of its attached targets (by `sessionId`). */
export interface CdpEvent {
  method: string;
  // The protocol's own shapes; each handler reads the fields it knows
  params: Record<string, any>;
  sessionId?: string;
}

/** How long the browser has to answer one command unless the caller says otherwise. */
export const COMMAND_TIMEOUT = 15_000;

export interface CdpSendOptions {
  /**
   * How long the browser has to answer, in milliseconds. `Infinity` only where the caller
   * bounds the wait itself, as the start does.
   */
  timeout?: number;
  /** Ends the wait for the caller; the browser may still carry the command out. */
  signal?: AbortSignal;
  /** Who the command is for, named in its error: "tab t1", "the browser". */
  target?: string;
}

interface Waiting {
  method: string;
  sessionId?: string;
  target: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

/**
 * Chrome's DevTools protocol over `--remote-debugging-pipe`: JSON messages, each ended by a
 * NUL byte, written to the browser's fd 3 and read from its fd 4. No port is opened, so no
 * other program on the machine can reach the browser.
 *
 * Every command ends: with the browser's answer, at its deadline, when the caller's signal
 * aborts, when its session is failed (`fail`: its tab closed, detached or crashed), or
 * when the pipe closes. A page that never answers cannot hold a caller forever.
 */
export class CdpPipe {
  private next = 0;
  private waiting = new Map<number, Waiting>();
  private listeners = new Set<(event: CdpEvent) => void>();
  private buffer = Buffer.alloc(0);
  private ended?: Error;
  constructor(
    private input: Writable,
    output: Readable,
    private timeout = COMMAND_TIMEOUT,
  ) {
    output.on('data', (chunk: Buffer) => this.read(chunk));
    output.on('close', () => this.close(Error('the browser was closed')));
    output.on('error', (cause: Error) =>
      this.close(Error('the browser was closed', { cause })),
    );
    // A failed write need not be followed by a read-side close. Settle callers now.
    input.on('error', (cause: Error) =>
      this.close(Error('the browser was closed', { cause })),
    );
  }
  get closed(): boolean {
    return !!this.ended;
  }
  private read(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let end: number;
    while ((end = this.buffer.indexOf(0)) >= 0) {
      const text = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 1);
      let message: {
        id?: number;
        result?: unknown;
        error?: { message?: string };
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
      try {
        message = JSON.parse(text);
      } catch {
        continue;
      }
      if (message.id !== undefined) {
        const waiting = this.waiting.get(message.id);
        if (!waiting) continue;
        if (message.error)
          waiting.reject(Error(message.error.message || 'browser error'));
        else waiting.resolve(message.result ?? {});
      } else if (message.method) {
        for (const listener of [...this.listeners])
          listener({
            method: message.method,
            params: message.params ?? {},
            ...(message.sessionId ? { sessionId: message.sessionId } : {}),
          });
      }
    }
  }
  send<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    options: CdpSendOptions = {},
  ): Promise<T> {
    if (this.ended) return Promise.reject(this.ended);
    const { signal } = options;
    if (signal?.aborted)
      return Promise.reject(signal.reason ?? Error('browser action stopped'));
    const id = ++this.next;
    const target =
      options.target ?? (sessionId ? `session ${sessionId}` : 'the browser');
    const timeout = options.timeout ?? this.timeout;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () =>
        settle(() => reject(signal!.reason ?? Error('browser action stopped')));
      const settle = (finish: () => void) => {
        if (!this.waiting.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        finish();
      };
      this.waiting.set(id, {
        method,
        sessionId,
        target,
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => settle(() => reject(error)),
      });
      if (Number.isFinite(timeout))
        timer = setTimeout(
          () =>
            settle(() =>
              reject(
                Error(
                  `the browser did not answer ${method} for ${target} in ${seconds(timeout)}`,
                ),
              ),
            ),
          timeout,
        );
      signal?.addEventListener('abort', abort, { once: true });
      this.input.write(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }) + '\0',
      );
    });
  }
  /**
   * Ends every command waiting on a session that will not answer: its target closed,
   * detached or crashed (`why`, as "crashed").
   */
  fail(sessionId: string, why: string) {
    for (const waiting of [...this.waiting.values()])
      if (waiting.sessionId === sessionId)
        waiting.reject(
          Error(
            `${waiting.target} ${why} before the browser answered ${waiting.method}`,
          ),
        );
  }
  /** The commands still waiting for an answer, oldest first: for diagnostics. */
  get pending(): { method: string; target: string }[] {
    return [...this.waiting.values()].map(({ method, target }) => ({
      method,
      target,
    }));
  }
  on(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(error = Error('the browser was closed')) {
    if (this.ended) return;
    this.ended = error;
    for (const waiting of [...this.waiting.values()]) waiting.reject(error);
    for (const listener of [...this.listeners])
      listener({ method: 'Circle.closed', params: { reason: error } });
  }
}

function seconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(ms < 1000 ? 2 : 1))} s`;
}
