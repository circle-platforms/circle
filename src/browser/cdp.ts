import type { Readable, Writable } from 'node:stream';

/** An event from the browser or from one of its attached targets (by `sessionId`). */
export interface CdpEvent {
  method: string;
  // The protocol's own shapes; each handler reads the fields it knows
  params: Record<string, any>;
  sessionId?: string;
}

/**
 * Chrome's DevTools protocol over `--remote-debugging-pipe`: JSON messages, each ended by a
 * NUL byte, written to the browser's fd 3 and read from its fd 4. No port is opened, so no
 * other program on the machine can reach the browser.
 */
export class CdpPipe {
  private next = 0;
  private waiting = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  private listeners = new Set<(event: CdpEvent) => void>();
  private buffer = Buffer.alloc(0);
  private ended?: Error;
  constructor(
    private input: Writable,
    output: Readable,
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
        this.waiting.delete(message.id);
        if (message.error)
          waiting.reject(Error(message.error.message || 'browser error'));
        else waiting.resolve(message.result ?? {});
      } else if (message.method)
        for (const listener of [...this.listeners])
          listener({
            method: message.method,
            params: message.params ?? {},
            ...(message.sessionId ? { sessionId: message.sessionId } : {}),
          });
    }
  }
  send<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    if (this.ended) return Promise.reject(this.ended);
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
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
  on(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(error = Error('the browser was closed')) {
    if (this.ended) return;
    this.ended = error;
    for (const waiting of this.waiting.values()) waiting.reject(error);
    this.waiting.clear();
    for (const listener of [...this.listeners])
      listener({ method: 'Circle.closed', params: { reason: error } });
  }
}
