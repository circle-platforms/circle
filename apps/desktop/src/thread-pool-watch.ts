/** How often the watch looks at its probe. */
export const THREAD_POOL_WATCH_INTERVAL_MS = 10_000;
/** How long the probe may go unanswered before a check counts it as overdue. */
export const THREAD_POOL_STALL_MS = 30_000;

export interface ThreadPoolStall {
  /** How long the probe had waited when the second overdue check saw it. */
  waitedMs: number;
}

/**
 * libuv runs file system, DNS and crypto work on a pool of four threads. When the pool stops
 * taking work, as when macOS loses the wake-ups of the condition variable its threads sleep on
 * (docs/known-issues.md), every such operation in the process waits for ever while the rest of
 * the process runs on. The watch keeps one cheap pool operation in flight and reports a stall
 * when the same probe is overdue at two checks in a row. The second check comes a full interval
 * after the first, once the event loop has delivered whatever finished meanwhile, so a process
 * that was suspended or busy for a while is not taken for a stopped pool. The clock is the
 * monotonic one, which does not run while the computer sleeps.
 */
export class ThreadPoolWatch {
  private timer?: ReturnType<typeof setInterval>;
  private outstanding?: { startedAt: number; overdue: number };
  /** Set once a stall is reported or the watch is stopped: it does not start again. */
  private ended = false;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      /** Starts one pool operation and calls `done` when it has finished, however it ended. */
      probe: (done: () => void) => void;
      onStall: (stall: ThreadPoolStall) => void;
      intervalMs?: number;
      stallMs?: number;
      now?: () => number;
    },
  ) {
    this.now = options.now ?? (() => performance.now());
  }

  start(): void {
    if (this.timer || this.ended) return;
    this.check();
    this.timer = setInterval(
      () => this.check(),
      this.options.intervalMs ?? THREAD_POOL_WATCH_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  stop(): void {
    this.ended = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.outstanding = undefined;
  }

  /** One look: start a probe when none is in flight, or judge the one that is. */
  check(): void {
    if (this.ended) return;
    const now = this.now();
    const probe = this.outstanding;
    if (!probe) {
      const next = { startedAt: now, overdue: 0 };
      this.outstanding = next;
      try {
        this.options.probe(() => {
          if (this.outstanding === next) this.outstanding = undefined;
        });
      } catch {
        // A probe that cannot even be started says nothing about the pool.
        this.outstanding = undefined;
      }
      return;
    }
    if (now - probe.startedAt < (this.options.stallMs ?? THREAD_POOL_STALL_MS))
      return;
    probe.overdue += 1;
    if (probe.overdue < 2) return;
    this.stop();
    this.options.onStall({ waitedMs: Math.round(now - probe.startedAt) });
  }
}

/** What the process is waiting on, by kind and count: names only, never paths or values. */
export function pendingResources(
  resources: readonly string[] = process.getActiveResourcesInfo(),
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const kind of resources)
    if (/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(kind))
      counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}
