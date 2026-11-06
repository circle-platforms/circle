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
 * the model was told to end its turn and wait for the notice. The rules are the
 * terminal's: see docs/background-jobs.md.
 */
export class JobWake {
  private timer?: ReturnType<typeof setTimeout>;
  private wakes = 0;
  private snoozed = false;
  constructor(private readonly host: JobWakeHost) {}
  jobEnded(): void {
    this.look();
  }
  /** The person stopped a turn or went back in the conversation: wait for their next message. */
  snooze(): void {
    this.snoozed = true;
  }
  /** A message of the person's starts a turn: finished jobs may start turns again. */
  personSent(): void {
    this.snoozed = false;
    this.wakes = 0;
  }
  private look(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.check(), SETTLE_MS);
    this.timer.unref?.();
  }
  private check(): void {
    if (
      this.host.closed() ||
      this.snoozed ||
      this.wakes >= MOST_WAKES_IN_A_ROW ||
      !this.host.hasNotice()
    )
      return;
    if (this.host.occupied()) {
      this.look();
      return;
    }
    this.wakes++;
    void this.host.start().catch(() => {
      this.snoozed = true;
    });
  }
}
