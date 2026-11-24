/** A native action can finish after selection changed, including a background approval. */
export class SessionActionError extends Error {
  readonly status?: number;
  readonly code?: string;
  constructor(
    message: string,
    readonly sessionId: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'SessionActionError';
    if (cause && typeof cause === 'object') {
      const meta = cause as { status?: unknown; code?: unknown };
      if (typeof meta.status === 'number') this.status = meta.status;
      if (typeof meta.code === 'string') this.code = meta.code;
    }
  }
}
