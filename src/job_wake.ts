import type { AgentRuntime } from './runtime.js';
import type { JobHold } from './job_notice_words.js';

export {
  turnsStartedByJobs,
  waitingSentence,
  type JobHold,
} from './job_notice_words.js';

export interface JobWakeHost {
  hasNotice(): boolean;
  occupied(): boolean;
  closed(): boolean;
  start(owed: boolean): Promise<unknown>;
  holding?(hold: JobHold): void;
}

const SETTLE_MS = 1000;
// Bounded at 20 so multi-stage job chains complete without allowing runaway wake loops.
const MOST_WAKES_IN_A_ROW = 20;
export function mostWakesInARow(
  env: Record<string, string | undefined> = process.env,
): number {
  const configured = Number(env.CIRCLE_JOB_WAKES);
  return Number.isInteger(configured) && configured >= 1
    ? configured
    : MOST_WAKES_IN_A_ROW;
}
const RETRY_AFTER_MS = [15_000, 60_000, 240_000];

export class JobWake {
  private timer?: ReturnType<typeof setTimeout>;
  private settleAt = 0;
  private wakes = 0;
  private held = false;
  private failures = 0;
  private retryAt = 0;
  private owed = false;
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
  snooze(): void {
    this.held = true;
  }
  personSent(): void {
    this.held = false;
    this.wakes = 0;
    this.failures = 0;
    this.retryAt = 0;
    this.owed = false;
    this.told = false;
  }
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
          if (this.host.holding) this.look();
          return;
        }
        // Failed wake turns do not count toward the consecutive wake cap.
        this.wakes--;
        this.owed = true;
        this.retryAt = Date.now() + wait;
        this.look();
      },
    );
  }
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

export function unsaidNotices(
  runtime: Pick<AgentRuntime, 'jobs' | 'session'>,
  said: Set<string>,
): { id: string; line: string }[] {
  const waiting = runtime.jobs.waitingNotices(runtime.session.id);
  for (const id of said)
    if (!waiting.some((notice) => notice.id === id)) said.delete(id);
  const news = waiting.filter((notice) => !said.has(notice.id));
  for (const notice of news) said.add(notice.id);
  return news;
}

export async function answerJobsBeforeLeaving(
  runtime: Pick<AgentRuntime, 'jobs' | 'session'>,
  options: {
    delay: (ms: number) => Promise<unknown>;
    wake: () => Promise<void>;
    carryOn?: () => boolean;
    wakesSoFar?: number;
  },
): Promise<JobHold | undefined> {
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
      const most = mostWakesInARow();
      if (wakes >= most) return { why: 'limit', most };
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
