/** A native action can finish after selection changed, including a background approval. */
export class SessionActionError extends Error {
  constructor(
    message: string,
    readonly sessionId: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'SessionActionError';
  }
}
