import { ChildProcess } from 'node:child_process';
import { loopbackEvidence, type LoopbackEvidence } from './browser-port.mjs';

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
  /** On a timeout or an error: what the test's loopback servers saw of the browser. */
  loopback?: LoopbackEvidence[];
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

/** Test-only emergency disposal; a successful signal is not an exit verdict. */
async function disposeOwnedRoot(child: ChildProcess): Promise<void> {
  const exited = () =>
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null;
  if (exited()) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (result: { ok: true } | { ok: false; error: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', stopped);
      child.off('error', failed);
      if (result.ok) resolve();
      else reject(result.error);
    };
    const stopped = () => {
      if (exited()) finish({ ok: true });
    };
    const failed = (error: unknown) => finish({ ok: false, error });
    // The production close bounds remain unchanged. This is a separate last-resort
    // test disposal after a failure that will still be reported as a failure.
    const timer = setTimeout(
      () =>
        failed(
          Error(
            'the owned fixture browser did not exit during emergency disposal',
          ),
        ),
      3000,
    );
    child.on('exit', stopped);
    child.once('error', failed);
    try {
      child.kill('SIGKILL');
      if (exited()) finish({ ok: true });
    } catch (error) {
      failed(error);
    }
  });
}

async function disposeAfterFailure(
  error: unknown,
  roots: ChildProcess[],
): Promise<unknown> {
  const results = await Promise.allSettled(roots.map(disposeOwnedRoot));
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  return errors.length
    ? new AggregateError(
        [error, ...errors],
        'browser fixture close and emergency disposal failed',
      )
    : error;
}

function preservePhaseFailure(phase: unknown, cleanup: unknown): unknown {
  if (
    phase instanceof Error &&
    Reflect.defineProperty(phase, 'browserFixtureCleanup', {
      value: cleanup,
      enumerable: true,
      configurable: true,
    })
  )
    return phase;
  return new AggregateError(
    [phase, cleanup],
    'browser fixture phase and cleanup failed',
  );
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
      ownedRoots?: () => Iterable<ChildProcess | undefined>;
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
      ...(status === 'timeout' || status === 'error'
        ? { loopback: loopbackEvidence() }
        : {}),
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
      // Capture objects before production cleanup changes its current connection.
      const roots = [...new Set(this.options.ownedRoots?.() ?? [])].filter(
        (child): child is ChildProcess => child instanceof ChildProcess,
      );
      try {
        await this.options.close();
        this.record('cleanup-after');
      } catch (error) {
        this.record('cleanup-error');
        const cleanup = await disposeAfterFailure(error, roots);
        throw this.failure
          ? preservePhaseFailure(this.failure.error, cleanup)
          : cleanup;
      }
    })());
  }
}
