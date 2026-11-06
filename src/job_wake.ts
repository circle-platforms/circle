import type { AgentRuntime } from './runtime.js';

/** What a conversation tells its job wake. */
export interface JobWakeHost {
  /** A finished job's notice may start a turn. */
  hasNotice(): boolean;
  /** A turn or a card holds the conversation now. */
  occupied(): boolean;
  /** The conversation can no longer run a turn. */
  closed(): boolean;
  /** Starts the turn that reads the notices. */
  start(): Promise<unknown>;
}

// Notices that arrive within this of each other go in one turn. A turn or a card that
// holds the conversation is looked at again this often, for as long as a notice waits.
const SETTLE_MS = 1000;
const MOST_WAKES_IN_A_ROW = 10;

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
  }
  /** For a wake the front end ran itself, such as the last ones before leaving. */
  countWake(): void {
    this.wakes++;
  }
  check(): void {
    if (
      this.host.closed() ||
      this.held ||
      this.wakes >= MOST_WAKES_IN_A_ROW ||
      !this.host.hasNotice()
    )
      return;
    if (Date.now() < this.settleAt || this.host.occupied()) {
      this.look();
      return;
    }
    this.wakes++;
    void this.host.start().catch(() => {
      this.held = true;
    });
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
      if (wakes >= MOST_WAKES_IN_A_ROW) return;
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
