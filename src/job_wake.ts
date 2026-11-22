import type { AgentRuntime } from './runtime.js';

/** Why a notice waits for the person's next message instead of starting a turn. */
export type JobHold =
  /** Finished jobs have started `most` turns in a row. */
  | { why: 'limit'; most: number }
  /** The person stopped a turn or went back in the conversation, or a turn that kept failing was given up. */
  | { why: 'stopped' };

/** What a conversation tells its job wake. */
export interface JobWakeHost {
  /** A finished job's notice may start a turn. */
  hasNotice(): boolean;
  /** A turn or a card holds the conversation now. */
  occupied(): boolean;
  /** The conversation can no longer run a turn. */
  closed(): boolean;
  /** Starts the turn that reads the notices; `owed` runs it with none left, for a turn that failed after reading them. */
  start(owed: boolean): Promise<unknown>;
  /**
   * A notice waits and no turn will start for it until the person writes, so the conversation has to say so: it is
   * called once for the jobs that ended, when nothing runs and nobody is typing. A front end that does not say
   * so leaves it out, and is not looked at again for it.
   */
  holding?(hold: JobHold): void;
}

// Notices that arrive within this of each other go in one turn. A turn or a card that
// holds the conversation is looked at again this often, for as long as a notice waits.
const SETTLE_MS = 1000;
export function mostWakesInARow(
  env: Record<string, string | undefined> = process.env,
): number {
  const configured = Number(env.CIRCLE_JOB_WAKES);
  return Number.isInteger(configured) && configured >= 1 ? configured : 10;
}
const RETRY_AFTER_MS = [15_000, 60_000, 240_000];

/**
 * Starts a turn when a background job of one conversation ends and nothing runs, because
 * the model was told to end its turn and wait for the notice. Every front end holds one
 * per conversation; see docs/background-jobs.md for the rules.
 *
 * It looks again by itself, unless the front end has a clock of its own and calls `check`.
 */
export class JobWake {
  private timer?: ReturnType<typeof setTimeout>;
  private settleAt = 0;
  private wakes = 0;
  private held = false;
  private failures = 0;
  private retryAt = 0;
  private owed = false;
  /** Whether the host was told that the notices wait, since a job last ended. */
  private told = false;
  private readonly most = mostWakesInARow();
  constructor(
    private readonly host: JobWakeHost,
    private readonly options: { timed: boolean } = { timed: true },
  ) {}
  get snoozed(): boolean {
    return this.held;
  }
  get wakesInARow(): number {
    return this.wakes;
  }
  jobEnded(): void {
    this.settleAt = Date.now() + SETTLE_MS;
    this.told = false;
    this.look();
  }
  /** The person stopped a turn or went back in the conversation: wait for their next message. */
  snooze(): void {
    this.held = true;
  }
  /** A message of the person's starts a turn: finished jobs may start turns again. */
  personSent(): void {
    this.held = false;
    this.wakes = 0;
    this.failures = 0;
    this.retryAt = 0;
    this.owed = false;
    this.told = false;
  }
  /** For a wake the front end ran itself, such as the last ones before leaving. */
  countWake(): void {
    this.wakes++;
  }
  check(): void {
    if (this.host.closed()) return;
    if (this.held || this.wakes >= this.most) {
      if (this.host.hasNotice()) this.hold();
      return;
    }
    if (!this.host.hasNotice() && !this.owed) return;
    const now = Date.now();
    if (now < this.settleAt || now < this.retryAt || this.host.occupied()) {
      this.look();
      return;
    }
    this.wakes++;
    void this.host.start(this.owed).then(
      () => {
        this.failures = 0;
        this.owed = false;
      },
      () => {
        const wait = RETRY_AFTER_MS[this.failures++];
        if (wait === undefined) {
          this.held = true;
          this.owed = false;
          return;
        }
        // A turn that failed is not one of the turns in a row
        this.wakes--;
        this.owed = true;
        this.retryAt = Date.now() + wait;
        this.look();
      },
    );
  }
  /** A notice that may start a turn waits for the person: said once the turn or card that held the conversation is over. */
  private hold(): void {
    if (!this.host.holding || this.told) return;
    if (Date.now() < this.settleAt || this.host.occupied()) {
      this.look();
      return;
    }
    this.told = true;
    this.host.holding(
      this.held ? { why: 'stopped' } : { why: 'limit', most: this.most },
    );
  }
  private look(): void {
    if (!this.options.timed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.check(), SETTLE_MS);
    this.timer.unref?.();
  }
}

/**
 * After the last prompt, with no one left to write: stops what commands left running,
 * then lets the model answer as its jobs end, for as long as CIRCLE_JOB_WAIT allows.
 */
export async function answerJobsBeforeLeaving(
  runtime: Pick<AgentRuntime, 'jobs' | 'session'>,
  options: {
    delay: (ms: number) => Promise<unknown>;
    /** Runs the turn that reads the notices. */
    wake: () => Promise<void>;
    /** False, or a throw, ends the wait. */
    carryOn?: () => boolean;
    wakesSoFar?: number;
  },
): Promise<void> {
  const carryOn = options.carryOn ?? (() => true);
  const configured = Number(process.env.CIRCLE_JOB_WAIT ?? 1800);
  const deadline =
    Date.now() +
    (Number.isFinite(configured) && configured >= 0 ? configured : 1800) * 1000;
  for (const job of runtime.jobs
    .list()
    .filter((job) => job.kind === 'adopted' && job.status === 'running'))
    await runtime.jobs.stop(job.id, 'exit');
  let wakes = options.wakesSoFar ?? 0;
  while (Date.now() < deadline && carryOn()) {
    if (runtime.jobs.hasNotices(runtime.session.id, true)) {
      if (wakes >= mostWakesInARow()) return;
      await options.delay(SETTLE_MS);
      if (!carryOn()) return;
      wakes++;
      await options.wake();
    } else if (
      runtime.jobs
        .list(runtime.session.id)
        .some((job) => job.status === 'running' && job.startedBy !== 'user')
    )
      await options.delay(50);
    else return;
  }
}
