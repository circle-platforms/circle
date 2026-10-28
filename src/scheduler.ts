// The runner: it fires schedules when they are due. defaultExecute starts a headless
// Circle run in a child process; tickOnce starts whatever is due; daemonLoop calls it on
// a clock while the scheduler runs. `circle schedule` wires them to the command line.
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { circleHome, schedulesRoot } from './paths.js';
import { UsageError } from './usage_error.js';
import {
  FAILURE_PAUSE_AFTER,
  RUN_LIMIT_MS,
  acquireRunLock,
  advanceRun,
  appendHistory,
  clearDaemonFile,
  daemonFilePath,
  daemonLogPath,
  getSchedule,
  isProcessAlive,
  listSchedules,
  readDaemonFile,
  runId,
  runLockOwner,
  scheduleLogPath,
  updateSchedule,
  writeDaemonFile,
  type RunRecord,
  type ScheduleRecord,
} from './schedule.js';

/** What one run needs to know: the schedule, its id and where its log goes. */
export interface ExecJob {
  record: ScheduleRecord;
  id: string;
  logPath: string;
}
export interface Outcome {
  status: 'ok' | 'failed' | 'stopped';
  exit_code: number | null;
  error?: string;
}
export type Execute = (job: ExecJob, signal: AbortSignal) => Promise<Outcome>;

const nodeCommand = (env: NodeJS.ProcessEnv): string =>
  env.CIRCLE_SCHEDULE_NODE?.trim() || process.execPath;

/** The command that starts another copy of this same Circle program. */
export function childLaunch(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): { command: string; args: string[] } {
  const entry = (env.CIRCLE_SCHEDULE_CHILD || argv[1] || '').trim();
  if (!entry || !existsSync(entry))
    throw new UsageError(
      env.CIRCLE_SCHEDULE_CHILD
        ? `no such circle program: ${entry}`
        : 'cannot find the circle program to run; set CIRCLE_SCHEDULE_CHILD',
    );
  if (entry.endsWith('.js'))
    return { command: nodeCommand(env), args: [entry] };
  // A checkout run from source: the child needs the same loader as the parent.
  const loader = join(
    dirname(entry),
    '..',
    'node_modules',
    'tsx',
    'dist',
    'loader.mjs',
  );
  if (!existsSync(loader))
    throw new UsageError(
      `running a schedule from source needs tsx at ${loader}`,
    );
  return {
    command: nodeCommand(env),
    args: ['--import', pathToFileURL(loader).href, entry],
  };
}

/**
 * The words of one run. The options come first: after `-p --` every word is a
 * message, so a prompt that starts with a dash is still a prompt.
 */
export function runArguments(record: ScheduleRecord): string[] {
  const args: string[] = ['--trust'];
  if (record.model) args.push('-m', record.model);
  if (record.yolo) args.push('--yolo');
  if (record.extensions) args.push('--extensions');
  args.push('-p', '--', record.prompt, record.workspace);
  return args;
}

const quoted = (word: string): string =>
  /[\s"]/.test(word) ? `"${word.replaceAll('"', '\\"')}"` : word;

/** One headless `circle -p`, its output going straight to the run's log. */
export const defaultExecute: Execute = (job, signal) =>
  new Promise<Outcome>((done) => {
    const launch = childLaunch();
    const args = [...launch.args, ...runArguments(job.record)];
    const fd = openSync(job.logPath, 'a');
    try {
      writeSync(
        fd,
        [
          `# schedule ${job.record.name} · run ${job.id}\n`,
          `# workspace ${job.record.workspace}\n`,
          `# ${launch.command} ${args.map(quoted).join(' ')}\n\n`,
        ].join(''),
      );
    } catch {
      /* the header is a courtesy; the run is what matters */
    }
    let settled = false;
    const finish = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', terminate);
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
      done(outcome);
    };
    const child = spawn(launch.command, args, {
      cwd: existsSync(job.record.workspace)
        ? job.record.workspace
        : schedulesRoot(circleHome()),
      env: { ...process.env, CIRCLE_NO_TUI: '1' },
      stdio: ['ignore', fd, fd],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    child.on('error', (error) =>
      finish({ status: 'failed', exit_code: null, error: String(error) }),
    );
    child.on('close', (code, killed) => {
      if (signal.aborted) finish({ status: 'stopped', exit_code: code });
      else
        finish({
          status: killed || code !== 0 ? 'failed' : 'ok',
          exit_code: code,
        });
    });
    function terminate(): void {
      try {
        child.kill('SIGTERM');
      } catch {
        /* it has ended */
      }
    }
    signal.addEventListener('abort', terminate, { once: true });
  });

export interface SchedulerOptions {
  home?: string;
  now?: () => number;
  execute?: Execute;
  /** A run past this is stopped. */
  limitMs?: number;
  /** How many schedules may run at once. */
  concurrency?: number;
  log?: (line: string) => void;
}

/** True while a live process is running this schedule. */
export function isRunning(record: ScheduleRecord, home: string): boolean {
  if (!record.running) return false;
  const owner = runLockOwner(record.name, home);
  return owner !== null && isProcessAlive(owner.pid);
}

/**
 * Fire one schedule once. `kind` says why: a scheduled or ticked run moves the
 * clock forward and counts failures; a manual run leaves both alone.
 */
export async function fireSchedule(
  name: string,
  options: SchedulerOptions & {
    kind?: 'manual' | 'scheduled' | 'tick';
    planned?: number | null;
  } = {},
): Promise<RunRecord> {
  const home = options.home ?? circleHome();
  const now = options.now ?? Date.now;
  const execute = options.execute ?? defaultExecute;
  const limitMs = options.limitMs ?? RUN_LIMIT_MS;
  const kind = options.kind ?? 'manual';
  const record = getSchedule(name, home);
  if (isRunning(record, home))
    throw new UsageError(`schedule ${record.name} is running already`);
  const lock = acquireRunLock(record.name, home);
  if (!lock) throw new UsageError(`schedule ${record.name} is running already`);
  const id = runId(now());
  const log = `runs/${id}.log`;
  const logPath = scheduleLogPath(record.name, home, log);
  const job: ExecJob = { record, id, logPath };
  try {
    updateSchedule(record.name, home, (r) => {
      r.running = { id, started_at: now(), log };
    });
    const started_at = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limitMs);
    let outcome: Outcome;
    try {
      const run = Promise.resolve()
        .then(() => execute(job, controller.signal))
        .catch((error): Outcome => {
          // A run that dies on the stop button stopped; any other throw failed.
          const message =
            error instanceof Error ? error.message : String(error);
          if (controller.signal.aborted)
            return { status: 'stopped', exit_code: null, error: message };
          return { status: 'failed', exit_code: null, error: message };
        });
      const stopped = new Promise<Outcome>((res) => {
        const onAbort = (): void =>
          res({ status: 'stopped', exit_code: null, error: 'time limit' });
        if (controller.signal.aborted) onAbort();
        else
          controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      outcome = await Promise.race([run, stopped]);
    } catch (error) {
      outcome = {
        status: 'failed',
        exit_code: null,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
    if (outcome.error) {
      try {
        appendFileSync(logPath, `\n[error] ${outcome.error}\n`);
      } catch {
        /* the log folder may be gone; the record holds the reason */
      }
    }
    const run: RunRecord = {
      id,
      kind,
      started_at,
      ended_at: now(),
      status: outcome.status,
      exit_code: outcome.exit_code,
      log,
    };
    const planned = options.planned ?? record.next_run;
    const fired = updateSchedule(record.name, home, (r) => {
      r.running = null;
      r.last_run = run;
      if (kind !== 'manual') {
        r.failures = run.status === 'ok' ? 0 : r.failures + 1;
        r.next_run = advanceRun(r.trigger, now(), planned);
        if (r.trigger.kind === 'once' && r.next_run === null) {
          if (run.status === 'ok') {
            r.done = true;
            r.note = '';
          } else {
            r.paused = true;
            r.note = 'paused after a failed run; resume it to try again';
          }
        }
        if (r.failures >= FAILURE_PAUSE_AFTER && !r.paused) {
          r.paused = true;
          r.note = `paused after ${r.failures} runs that failed`;
        }
      }
    });
    appendHistory(fired.name, home, run);
    const seconds = Math.round((run.ended_at - run.started_at) / 1000);
    options.log?.(
      `${fired.name} · ${run.status} · ${seconds}s · log ${log}` +
        (fired.paused && !record.paused ? ` · ${fired.note}` : ''),
    );
    return run;
  } finally {
    lock.release();
  }
}

export interface Tick extends SchedulerOptions {
  /** The runs in flight, by schedule name. The daemon keeps one of these. */
  inFlight: Map<string, Promise<void>>;
}

/** Every enabled schedule that is due at `now`, soonest first, none running. */
export function pickDue(home: string, now: number): ScheduleRecord[] {
  const { records } = listSchedules(home);
  const due = records.filter(
    (r) =>
      !r.paused &&
      !r.done &&
      r.next_run !== null &&
      r.next_run <= now &&
      !isRunning(r, home),
  );
  due.sort((a, b) => (a.next_run ?? 0) - (b.next_run ?? 0));
  return due;
}
/** Start every schedule that is due. Returns the names it started. */
export async function tickOnce(options: Tick): Promise<string[]> {
  const home = options.home ?? circleHome();
  const now = options.now ?? Date.now;
  const due = pickDue(home, now()).filter((r) => !options.inFlight.has(r.name));
  const room = Math.max(0, (options.concurrency ?? 3) - options.inFlight.size);
  const started: string[] = [];
  for (const record of due.slice(0, room)) {
    started.push(record.name);
    const running: Promise<void> = fireSchedule(record.name, {
      ...options,
      kind: 'scheduled',
      planned: record.next_run,
    })
      .then(() => undefined)
      .catch((error) => {
        void error;
        options.log?.(
          `${record.name} · ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    options.inFlight.set(
      record.name,
      running.finally(() => options.inFlight.delete(record.name)),
    );
  }
  return started;
}

/** The scheduler loop: it ticks until `signal` ends it. */
export async function daemonLoop(
  options: SchedulerOptions & { signal: AbortSignal; tickMs?: number },
): Promise<void> {
  const home = options.home ?? circleHome();
  const tickMs = options.tickMs ?? 15_000;
  const log =
    options.log ?? ((line: string) => process.stdout.write(line + '\n'));
  const inFlight = new Map<string, Promise<void>>();
  writeDaemonFile(home, {
    pid: process.pid,
    started_at: (options.now ?? Date.now)(),
  });
  log(`scheduler started · pid ${process.pid}`);
  try {
    while (!options.signal.aborted) {
      try {
        await tickOnce({ ...options, inFlight });
      } catch (error) {
        log(
          `scheduler · ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (options.signal.aborted) break;
      try {
        await delay(tickMs, undefined, { signal: options.signal });
      } catch {
        /* the wait ended because the signal did */
      }
    }
    log('scheduler stopped');
  } finally {
    clearDaemonFile(home, process.pid);
  }
}

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  started_at?: number;
}
/** What the daemon file says, with a dead scheduler cleared away. */
export function daemonStatus(home = circleHome()): DaemonStatus {
  const known = readDaemonFile(home);
  if (!known) return { running: false };
  if (!isProcessAlive(known.pid)) {
    clearDaemonFile(home, known.pid);
    return { running: false };
  }
  return { running: true, pid: known.pid, started_at: known.started_at };
}

export interface StartOptions extends SchedulerOptions {
  /** What really starts the child; tests replace it. */
  spawnDaemon?: () => void;
  waitMs?: number;
}
/** Start the background scheduler and wait until its file says it is alive. */
export async function startDaemon(
  options: StartOptions = {},
): Promise<{ started: boolean; pid?: number; message: string }> {
  const home = options.home ?? circleHome();
  const known = daemonStatus(home);
  if (known.running)
    return {
      started: false,
      pid: known.pid,
      message: `the scheduler is already running · pid ${known.pid}`,
    };
  mkdirSync(schedulesRoot(home), { recursive: true });
  const spawnDaemon =
    options.spawnDaemon ??
    (() => {
      mkdirSync(schedulesRoot(home), { recursive: true });
      const fd = openSync(daemonLogPath(home), 'a');
      const launch = childLaunch();
      const child = spawn(
        launch.command,
        [...launch.args, 'schedule', 'daemon'],
        {
          detached: true,
          stdio: ['ignore', fd, fd],
          windowsHide: true,
        },
      );
      child.unref();
      // The child holds its own copy of the log descriptor now.
      closeSync(fd);
    });
  spawnDaemon();
  const deadline = Date.now() + (options.waitMs ?? 5000);
  for (;;) {
    const after = daemonStatus(home);
    if (after.running)
      return {
        started: true,
        pid: after.pid,
        message: `scheduler started · pid ${after.pid}`,
      };
    if (Date.now() >= deadline)
      return {
        started: false,
        message: `the scheduler did not start · see ${daemonLogPath(home)}`,
      };
    await delay(100);
  }
}

/** Stop the background scheduler, gently. Runs that started keep writing their logs. */
export async function stopDaemon(
  options: { home?: string; waitMs?: number } = {},
): Promise<{ stopped: boolean; message: string }> {
  const home = options.home ?? circleHome();
  const known = readDaemonFile(home);
  if (!known || !isProcessAlive(known.pid)) {
    if (known) rmSync(daemonFilePath(home), { force: true });
    return { stopped: false, message: 'the scheduler is not running' };
  }
  try {
    process.kill(known.pid);
  } catch {
    /* it ended between the check and now */
  }
  const deadline = Date.now() + (options.waitMs ?? 5000);
  while (Date.now() < deadline) {
    if (!isProcessAlive(known.pid)) {
      clearDaemonFile(home, known.pid);
      return { stopped: true, message: 'scheduler stopped' };
    }
    await delay(100);
  }
  return {
    stopped: false,
    message: `the scheduler would not stop · pid ${known.pid}`,
  };
}
