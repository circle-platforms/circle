export interface BrowserFixturePhase {
  phase: string;
  action?: string;
  method?: string;
  session?: string;
}

export interface BrowserFixtureRecord extends BrowserFixturePhase {
  status: string;
  elapsed: number;
  state: Record<string, unknown>;
}

export class BrowserFixtureDeadline extends Error {
  constructor(
    readonly fixturePhase: BrowserFixtureRecord,
    readonly limitMs: number,
  ) {
    super(
      `browser fixture deadline after ${limitMs}ms (${fixturePhase.phase})`,
    );
  }
}

/** A test's owned browser and metadata only; page contents never enter records. */
export class BrowserFixture {
  private controller = new AbortController();
  private started = Date.now();
  private active: BrowserFixturePhase = { phase: 'fixture' };
  private failure?: { error: unknown };
  private closing?: Promise<void>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly signal = this.controller.signal;

  constructor(
    private options: {
      budgetMs: number;
      state: () => Record<string, unknown>;
      close: () => Promise<void>;
      report: (record: BrowserFixtureRecord) => void;
    },
  ) {
    this.timer = setTimeout(
      () => this.expire(options.budgetMs),
      options.budgetMs,
    );
  }

  private record(status: string): BrowserFixtureRecord {
    const record = {
      ...this.active,
      status,
      elapsed: Date.now() - this.started,
      state: this.options.state(),
    };
    this.options.report(record);
    return record;
  }

  private expire(limitMs: number) {
    if (this.failure || this.closing) return;
    const error = new BrowserFixtureDeadline(this.record('timeout'), limitMs);
    this.failure = { error };
    this.controller.abort(error);
    // Chrome.close retains its production 2s response + 3s exit bounds.
    void this.close().catch(() => {});
  }

  async run<T>(
    phase: BrowserFixturePhase,
    operation: () => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    this.signal.throwIfAborted();
    this.active = phase;
    this.record('before');
    const remaining = this.options.budgetMs - (Date.now() - this.started);
    if (remaining <= 0) this.expire(this.options.budgetMs);
    this.signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined)
      timer = setTimeout(
        () => this.expire(timeoutMs),
        Math.min(timeoutMs, remaining),
      );
    let aborted!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(this.signal.reason);
      this.signal.addEventListener('abort', aborted, { once: true });
    });
    const pending = Promise.resolve().then(operation);
    // Observed even if a later deadline wins the phase's race.
    pending.catch(() => {
      if (this.failure) this.record('late-rejection');
    });
    try {
      const result = await Promise.race([pending, stopped]);
      this.signal.throwIfAborted();
      this.record('after');
      return result;
    } catch (error) {
      this.failure ??= { error };
      this.record('error');
      await this.close();
      throw this.failure.error;
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener('abort', aborted);
    }
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      clearTimeout(this.timer);
      this.controller.abort(this.failure?.error ?? Error('fixture closed'));
      this.record('cleanup-before');
      try {
        await this.options.close();
        this.record('cleanup-after');
      } catch (error) {
        this.record('cleanup-error');
        if (!this.failure) throw error;
      }
    })());
  }
}
