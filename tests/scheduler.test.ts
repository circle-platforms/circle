import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  MIN_EVERY_MS,
  addSchedule,
  getSchedule,
  listSchedules,
  readHistory,
  scheduleLogPath,
  updateSchedule,
  type ScheduleRecord,
  type Trigger,
} from '../src/schedule.js';
import {
  childLaunch,
  daemonLoop,
  daemonStatus,
  fireSchedule,
  isRunning,
  pickDue,
  runArguments,
  startDaemon,
  stopDaemon,
  tickOnce,
  type Execute,
  type Outcome,
} from '../src/scheduler.js';
import { schedulesRoot } from '../src/paths.js';
import { UsageError } from '../src/usage_error.js';
import { scratch } from './helpers.js';

const ok: Outcome = { status: 'ok', exit_code: 0 };
const failed: Outcome = { status: 'failed', exit_code: 1 };

/** An executor that writes a line to the log and answers with the given outcome. */
const writesLog =
  (outcome: Outcome = ok): Execute =>
  async (job) => {
    writeFileSync(job.logPath, `ran ${job.record.name}\n`, 'utf8');
    return outcome;
  };

/** A clock the test can move. */
const fakeNow = (start: number) => {
  const clock = { at: start };
  return { now: () => clock.at, set: (value: number) => (clock.at = value) };
};

function makeSchedule(
  home: string,
  name: string,
  trigger: Trigger,
  now: number,
): ScheduleRecord {
  return addSchedule({
    name,
    prompt: 'do the thing',
    workspace: home,
    trigger,
    home,
    now,
  });
}

/** tickOnce, and then the wait for the runs it started. */
async function tickAndWait(
  home: string,
  now: () => number,
  execute: Execute,
): Promise<string[]> {
  const inFlight = new Map<string, Promise<void>>();
  const started = await tickOnce({ home, now, execute, inFlight });
  await Promise.all(inFlight.values());
  return started;
}

test('runArguments: options before the prompt, so a dash stays a prompt', () => {
  const record = {
    prompt: '-not an option',
    workspace: 'D:/somewhere',
    model: 'gpt-x',
    yolo: true,
    extensions: true,
  } as ScheduleRecord;
  assert.deepEqual(runArguments(record), [
    '--trust',
    '-m',
    'gpt-x',
    '--yolo',
    '--extensions',
    '-p',
    '--',
    '-not an option',
    'D:/somewhere',
  ]);
});

test('childLaunch: finds this circle program, with tsx for source', (t) => {
  const home = scratch(t);
  const jsFile = join(home, 'cli.js');
  writeFileSync(jsFile, '', 'utf8');
  const launched = childLaunch({ CIRCLE_SCHEDULE_CHILD: jsFile }, []);
  assert.equal(launched.command, process.execPath);
  assert.deepEqual(launched.args, [jsFile]);
  // A source entry gets the loader, looked up beside the checkout.
  mkdirSync(join(home, 'node_modules', 'tsx', 'dist'), { recursive: true });
  mkdirSync(join(home, 'src'), { recursive: true });
  const entry = join(home, 'src', 'cli.ts');
  const loader = join(home, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  writeFileSync(entry, '', 'utf8');
  writeFileSync(loader, '', 'utf8');
  const fromSource = childLaunch({ CIRCLE_SCHEDULE_CHILD: entry }, []);
  assert.deepEqual(fromSource.args, [
    '--import',
    pathToFileURL(loader).href,
    entry,
  ]);
  // A node override travels with it.
  assert.equal(
    childLaunch(
      { CIRCLE_SCHEDULE_CHILD: jsFile, CIRCLE_SCHEDULE_NODE: 'x' },
      [],
    ).command,
    'x',
  );
  assert.throws(() => childLaunch({}, ['/nowhere/cli.js']), UsageError);
  assert.throws(
    () => childLaunch({ CIRCLE_SCHEDULE_CHILD: join(home, 'gone.js') }, []),
    UsageError,
  );
});

test('manual run keeps the clock, blocks a second, and records', async (t) => {
  const home = scratch(t);
  const at = 1_767_000_000_000;
  const record = makeSchedule(
    home,
    'manual',
    { kind: 'every', every_ms: 10 * MIN_EVERY_MS },
    at,
  );
  let finishRun: ((value: Outcome) => void) | undefined;
  const execute: Execute = () =>
    new Promise<Outcome>((done) => (finishRun = done));
  const running = fireSchedule('manual', { home, now: () => at, execute });
  // The lock and the running field go in before the first await.
  assert.ok(getSchedule('manual', home).running);
  await assert.rejects(
    fireSchedule('manual', { home, now: () => at, execute }),
    /running already/,
  );
  await delay(0);
  assert.ok(finishRun, 'the executor was called');
  finishRun!(ok);
  const run = await running;
  assert.equal(run.status, 'ok');
  assert.equal(run.kind, 'manual');
  const after = getSchedule('manual', home);
  assert.equal(after.running, null);
  assert.equal(
    after.next_run,
    record.next_run,
    'manual runs do not move the clock',
  );
  assert.equal(after.failures, 0);
  assert.equal(readHistory(after.name, home).length, 1);
  assert.equal(
    existsSync(join(schedulesRoot(home), 'manual', 'running.lock')),
    false,
  );
});

test('a manual run writes its log and leaves the note', async (t) => {
  const home = scratch(t);
  const at = 1_767_000_000_000;
  makeSchedule(
    home,
    'logged',
    { kind: 'every', every_ms: 10 * MIN_EVERY_MS },
    at,
  );
  const run = await fireSchedule('logged', {
    home,
    now: () => at + 5_000,
    execute: writesLog(),
  });
  const after = getSchedule('logged', home);
  assert.equal(after.last_run?.status, 'ok');
  assert.equal(
    readFileSync(scheduleLogPath(after.name, home, run.log), 'utf8').trim(),
    'ran logged',
  );
});

test('a failed manual run does not count toward the pause', async (t) => {
  const home = scratch(t);
  const at = 1_767_000_000_000;
  makeSchedule(
    home,
    'flaky',
    { kind: 'every', every_ms: 10 * MIN_EVERY_MS },
    at,
  );
  for (let n = 0; n < 3; n++)
    await fireSchedule('flaky', {
      home,
      now: () => at,
      execute: writesLog(failed),
    });
  const after = getSchedule('flaky', home);
  assert.equal(after.failures, 0);
  assert.equal(after.paused, false);
  assert.equal(after.last_run?.status, 'failed');
});

test('scheduled runs advance the clock and skip the missed ones', async (t) => {
  const home = scratch(t);
  const at = 1_767_000_000_000;
  const clock = fakeNow(at);
  const record = makeSchedule(
    home,
    'watch',
    { kind: 'every', every_ms: 10 * MIN_EVERY_MS },
    at,
  );
  const planned = record.next_run!; // at + 10m
  clock.set(planned + 25 * MIN_EVERY_MS); // the daemon was off for hours
  const started = await tickAndWait(home, clock.now, writesLog());
  assert.deepEqual(started, ['watch']);
  const after = getSchedule('watch', home);
  assert.equal(after.failures, 0);
  assert.equal(after.last_run?.kind, 'scheduled');
  assert.ok((after.next_run ?? 0) > clock.now());
  assert.equal(
    ((after.next_run ?? 0) - planned) % (10 * MIN_EVERY_MS),
    0,
    'the next run stays on the cadence',
  );
});

test('cron runs plan the next match, and a good run clears failures', async (t) => {
  const home = scratch(t);
  const at = new Date(2026, 9, 28, 10, 0).getTime();
  const clock = fakeNow(at + 1);
  makeSchedule(home, 'daily', { kind: 'cron', spec: '30 9 * * *' }, at);
  updateSchedule('daily', home, (r) => {
    r.failures = 2;
    r.next_run = clock.now(); // fire now, whatever the plan was
  });
  const started = await tickAndWait(home, clock.now, writesLog());
  assert.deepEqual(started, ['daily']);
  const daily = getSchedule('daily', home);
  assert.equal(daily.failures, 0);
  assert.equal(daily.done, false);
  const day = new Date(daily.next_run!);
  assert.equal(day.getHours(), 9);
  assert.equal(day.getMinutes(), 30);
  assert.ok(day.getTime() > clock.now());
});

test('a once run finishes when it answers', async (t) => {
  const home = scratch(t);
  const at = 1_767_000_000_000;
  makeSchedule(home, 'later', { kind: 'once', at: at + 60_000 }, at);
  const clock = fakeNow(at + 61_000);
  const started = await tickAndWait(home, clock.now, writesLog());
  assert.deepEqual(started, ['later']);
  const after = getSchedule('later', home);
  assert.equal(after.done, true);
  assert.equal(after.next_run, null);
  assert.equal(after.paused, false);
  assert.deepEqual(
    await tickAndWait(home, () => at + 120_000, writesLog()),
    [],
  );
});

test('a failed once run pauses with a word why instead of retrying', async (t) => {
  const home = scratch(t);
  const at = 1_767_000_000_000;
  makeSchedule(home, 'single', { kind: 'once', at: at + 60_000 }, at);
  const started = await tickAndWait(home, () => at + 61_000, writesLog(failed));
  assert.deepEqual(started, ['single']);
  const after = getSchedule('single', home);
  assert.equal(after.paused, true);
  assert.match(after.note, /resume it/);
  assert.equal(after.done, false);
  assert.deepEqual(
    await tickAndWait(home, () => at + 120_000, writesLog()),
    [],
  );
});

test('three failed scheduled runs pause a schedule; a good one clears', async (t) => {
  const home = scratch(t);
  const at = 1_767_000_000_000;
  const clock = fakeNow(at);
  makeSchedule(
    home,
    'bad',
    { kind: 'every', every_ms: MIN_EVERY_MS },
    at - MIN_EVERY_MS,
  );
  makeSchedule(
    home,
    'mixed',
    { kind: 'every', every_ms: MIN_EVERY_MS },
    at - MIN_EVERY_MS,
  );
  // Outcomes per schedule, per tick: bad fails every time; mixed fails twice,
  // answers, then fails once — three in a row is what pauses.
  const rounds: Record<string, Outcome>[] = [
    { bad: failed, mixed: failed },
    { bad: failed, mixed: failed },
    { bad: failed, mixed: ok },
    { bad: failed, mixed: failed },
  ];
  for (let round = 0; round < 3; round++) {
    const results = rounds[round]!;
    await tickAndWait(home, clock.now, (job) =>
      Promise.resolve(results[job.record.name] === ok ? ok : failed),
    );
    clock.set(clock.now() + MIN_EVERY_MS);
  }
  const bad = getSchedule('bad', home);
  assert.equal(bad.failures, 3);
  assert.equal(bad.paused, true);
  assert.match(bad.note, /3 runs that failed/);
  assert.equal(getSchedule('mixed', home).failures, 0);
  const fourth = await tickAndWait(home, clock.now, (job) =>
    Promise.resolve(rounds[3]![job.record.name] === ok ? ok : failed),
  );
  assert.deepEqual(fourth, ['mixed'], 'the paused schedule is left alone');
  const mixed = getSchedule('mixed', home);
  assert.equal(mixed.failures, 1);
  assert.equal(mixed.paused, false);
});

test('tick starts at most the allowed number at once', async (t) => {
  const home = scratch(t);
  const at = 1_767_000_000_000;
  for (const name of ['a', 'b', 'c'])
    makeSchedule(
      home,
      name,
      { kind: 'every', every_ms: MIN_EVERY_MS },
      at - 2 * MIN_EVERY_MS,
    );
  let release: (() => void) | undefined;
  const gate = new Promise<void>((done) => (release = done));
  const execute: Execute = async () => {
    await gate;
    return ok;
  };
  const inFlight = new Map<string, Promise<void>>();
  const started = await tickOnce({
    home,
    now: () => at,
    execute,
    concurrency: 2,
    inFlight,
  });
  assert.equal(started.length, 2);
  const second = await tickOnce({
    home,
    now: () => at,
    execute,
    concurrency: 2,
    inFlight,
  });
  assert.deepEqual(second, [], 'the cap leaves no room');
  release!();
  await Promise.all(inFlight.values());
  assert.equal(inFlight.size, 0);
  const third = await tickOnce({
    home,
    now: () => at,
    execute: writesLog(),
    concurrency: 2,
    inFlight,
  });
  assert.equal(third.length, 1, 'the last one goes next');
  await Promise.all(inFlight.values());
  assert.equal(
    listSchedules(home).records.filter((r) => !r.next_run).length,
    0,
  );
});

test('a run that goes over its limit is stopped', async (t) => {
  const home = scratch(t);
  const at = 1_767_000_000_000;
  makeSchedule(home, 'slow', { kind: 'every', every_ms: MIN_EVERY_MS }, at);
  const execute: Execute = (job, signal) =>
    new Promise<Outcome>((_done, reject) => {
      signal.addEventListener('abort', () => {
        writeFileSync(job.logPath, 'stopped on the signal\n', 'utf8');
        reject(new Error('killed'));
      });
    });
  const run = await fireSchedule('slow', {
    home,
    now: () => at,
    execute,
    limitMs: 40,
  });
  assert.equal(run.status, 'stopped');
  const after = getSchedule('slow', home);
  assert.equal(after.running, null);
  const text = readFileSync(scheduleLogPath(after.name, home, run.log), 'utf8');
  assert.match(text, /stopped on the signal/);
});

test('pickDue reads the clock without starting anything', (t) => {
  const home = scratch(t);
  const at = 1_767_000_000_000;
  makeSchedule(
    home,
    'due',
    { kind: 'every', every_ms: MIN_EVERY_MS },
    at - MIN_EVERY_MS,
  );
  makeSchedule(home, 'later', { kind: 'every', every_ms: MIN_EVERY_MS }, at);
  updateSchedule('later', home, (r) => {
    r.paused = true;
  });
  assert.deepEqual(
    pickDue(home, at).map((r) => r.name),
    ['due'],
  );
});

test('the daemon loop starts, fires, and clears its file', async (t) => {
  const home = scratch(t);
  const at = 1_767_000_000_000;
  makeSchedule(
    home,
    'tick-tock',
    { kind: 'every', every_ms: MIN_EVERY_MS },
    at - MIN_EVERY_MS,
  );
  const lines: string[] = [];
  const controller = new AbortController();
  const loop = daemonLoop({
    home,
    now: () => at,
    execute: writesLog(),
    tickMs: 20,
    log: (line) => lines.push(line),
    signal: controller.signal,
  });
  // Wait until the run is on record, then end the loop.
  for (;;) {
    if (readHistory('tick-tock', home).length > 0) break;
    await delay(10);
  }
  assert.equal(daemonStatus(home).running, true);
  controller.abort();
  await loop;
  assert.equal(daemonStatus(home).running, false);
  assert.match(lines[0]!, /scheduler started · pid/);
  assert.match(lines.join('\n'), /tick-tock · ok/);
  assert.match(lines.at(-1)!, /scheduler stopped/);
});

test('start waits for the daemon file, stop ends a real process', async (t) => {
  const home = scratch(t);
  const result = await startDaemon({
    home,
    spawnDaemon: () =>
      writeFileSync(
        join(schedulesRoot(home), 'daemon.json'),
        JSON.stringify({ pid: process.pid, started_at: Date.now() }) + '\n',
      ),
    waitMs: 2000,
  });
  assert.equal(result.started, true);
  const again = await startDaemon({ home, spawnDaemon: () => {}, waitMs: 100 });
  assert.equal(again.started, false);
  assert.match(again.message, /already running/);
  // Now a real child, so stop can end it.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  assert.ok(child.pid);
  writeFileSync(
    join(schedulesRoot(home), 'daemon.json'),
    JSON.stringify({ pid: child.pid, started_at: Date.now() }) + '\n',
  );
  const exited = new Promise<void>((res) => child.once('exit', () => res()));
  const stopped = await stopDaemon({ home, waitMs: 10_000 });
  assert.equal(stopped.stopped, true, stopped.message);
  await exited;
  const afterStop = await stopDaemon({ home });
  assert.match(afterStop.message, /not running/);
  // A file naming a dead pid is cleared without a signal.
  writeFileSync(
    join(schedulesRoot(home), 'daemon.json'),
    JSON.stringify({ pid: 2_000_000_000, started_at: 1 }) + '\n',
  );
  assert.equal(daemonStatus(home).running, false);
  assert.equal(existsSync(join(schedulesRoot(home), 'daemon.json')), false);
});
