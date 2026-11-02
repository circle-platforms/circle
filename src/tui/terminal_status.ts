import { spawn } from 'node:child_process';
import { shellEnvironment } from '../sandbox.js';

// What the terminal is told about the conversation, beside the screen, as the lamp says it
// on screen: a turn runs, a card waits for you, the last turn failed, or none of these.
export type TerminalState = 'idle' | 'working' | 'waiting' | 'failed';

// OSC 9;4, the progress report Windows Terminal, Ghostty and others show on the tab or the
// taskbar: indeterminate, paused, error, cleared. A terminal that does not know it ignores it.
export const PROGRESS: Record<TerminalState, string> = {
  idle: '\x1b]9;4;0\x07',
  working: '\x1b]9;4;3\x07',
  waiting: '\x1b]9;4;4\x07',
  failed: '\x1b]9;4;2\x07',
};

// The states of Otty's protocol for agents it has no adapter for (`otty state:<name>`).
const OTTY_STATE: Record<TerminalState, string> = {
  idle: 'idle',
  working: 'processing',
  waiting: 'awaiting',
  failed: 'error',
};

/** A card that waits this long for you rings the bell, once. */
export const BELL_AFTER_MS = 10_000;
// Otty drops a report from a process it has not matched to a pane yet, as it has not right
// after Circle starts: the state is sent again this long after the first report.
export const OTTY_REPEAT_MS = [3_000, 10_000];
// An otty that has not ended after this long is left to itself, so the next report can go.
const REPORT_TIMEOUT_MS = 5_000;

export interface TerminalStatusIO {
  write(text: string): void;
  /** Starts a program and calls `done` once it has ended, or with false if it cannot start. */
  run(command: string, args: string[], done: (started: boolean) => void): void;
  env?: NodeJS.ProcessEnv;
  pid?: number;
}

export function runInBackground(
  command: string,
  args: string[],
  done: (started: boolean) => void,
): void {
  let settled = false;
  const settle = (started: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    done(started);
  };
  const timer = setTimeout(() => settle(true), REPORT_TIMEOUT_MS);
  timer.unref?.();
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: shellEnvironment(),
    });
    child.once('error', () => settle(false));
    child.once('exit', () => settle(true));
    child.unref();
  } catch {
    settle(false);
  }
}

export class TerminalStatus {
  private state: TerminalState = 'idle';
  private session = '';
  private reported = false;
  private paused = false;
  private closed = false;
  private otty: boolean;
  // An otty report is on its way; the state changed again while it was.
  private sending = false;
  private again = false;
  private bell?: NodeJS.Timeout;
  private repeats: NodeJS.Timeout[] = [];
  constructor(private io: TerminalStatusIO) {
    this.otty = Boolean((io.env ?? process.env).OTTY_PANE_ID);
  }
  /** Reports the state when it changes, or the conversation it belongs to does. */
  report(state: TerminalState, session: string): void {
    if (this.closed) return;
    if (this.reported && state === this.state && session === this.session)
      return;
    const changed = !this.reported || state !== this.state;
    const first = !this.reported;
    this.state = state;
    this.session = session;
    this.reported = true;
    if (changed) this.armBell();
    this.send();
    if (first && this.otty)
      this.repeats = OTTY_REPEAT_MS.map((ms) => {
        const timer = setTimeout(() => this.send(), ms);
        timer.unref?.();
        return timer;
      });
  }
  /** The screen is lent out (ctrl+z, an editor): the progress report is taken back. */
  pause(): void {
    if (this.paused || this.closed) return;
    this.paused = true;
    this.stopBell();
    if (this.reported && !this.otty) this.io.write(PROGRESS.idle);
  }
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (!this.reported || this.closed) return;
    this.send();
    this.armBell();
  }
  /** Circle leaves: the terminal is told it is idle, and nothing is reported after. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.paused = false;
    this.stopBell();
    for (const timer of this.repeats) clearTimeout(timer);
    this.repeats = [];
    if (!this.reported) return;
    this.state = 'idle';
    this.deliver();
  }
  private send(): void {
    if (!this.paused && !this.closed) this.deliver();
  }
  // Each report to Otty is a program of its own, and two started together can end in either
  // order: one goes at a time, and a state that changed meanwhile follows it, the newest only.
  private deliver(): void {
    if (!this.otty) {
      this.io.write(PROGRESS[this.state]);
      return;
    }
    if (this.sending) {
      this.again = true;
      return;
    }
    this.sending = true;
    this.io.run(
      'otty',
      [
        'state:circle',
        `state=${OTTY_STATE[this.state]}`,
        `agent-pid=${this.io.pid ?? process.pid}`,
        ...(this.session ? [`session-id=${this.session}`] : []),
        'label=Circle',
      ],
      (started) => {
        this.sending = false;
        const again = this.again;
        this.again = false;
        if (!started) {
          // No otty to run: the progress report is understood there too.
          this.otty = false;
          if (!this.paused) this.deliver();
          this.armBell();
        } else if (again && !this.paused) this.deliver();
      },
    );
  }
  private armBell(): void {
    this.stopBell();
    if (this.state !== 'waiting' || this.otty || this.paused || this.closed)
      return;
    this.bell = setTimeout(() => {
      this.bell = undefined;
      if (
        this.state === 'waiting' &&
        !this.paused &&
        !this.closed &&
        !this.otty
      )
        this.io.write('\x07');
    }, BELL_AFTER_MS);
    this.bell.unref?.();
  }
  private stopBell(): void {
    if (this.bell) clearTimeout(this.bell);
    this.bell = undefined;
  }
}
