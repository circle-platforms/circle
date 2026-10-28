import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FAILURE_PAUSE_AFTER,
  HISTORY_KEEP,
  MIN_EVERY_MS,
  PROMPT_MAX,
  acquireRunLock,
  addSchedule,
  advanceRun,
  appendHistory,
  clearDaemonFile,
  daemonFilePath,
  describeTrigger,
  formatEvery,
  formatWhen,
  getSchedule,
  isProcessAlive,
  listSchedules,
  nextCronRun,
  nextRunFor,
  parseAt,
  parseCronSpec,
  parseDaily,
  parseEvery,
  readDaemonFile,
  readHistory,
  removeSchedule,
  runId,
  runLockOwner,
  scheduleSlug,
  triggerFromFlags,
  updateSchedule,
  writeDaemonFile,
} from '../src/schedule.js';
import { schedulesRoot } from '../src/paths.js';
import { UsageError } from '../src/usage_error.js';
import { scratch } from './helpers.js';

// Local times, so the checks mean the same thing on any machine.
const at = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

test('every: parses units and bounds', () => {
  assert.equal(parseEvery('75s'), 75_000);
  assert.equal(parseEvery('15m'), 900_000);
  assert.equal(parseEvery('3h'), 3 * 3_600_000);
  assert.equal(parseEvery('2d'), 2 * 86_400_000);
  assert.throws(() => parseEvery('45s'), UsageError); // below one minute
  assert.throws(() => parseEvery('10'), UsageError);
  assert.throws(() => parseEvery('1w'), UsageError);
  assert.throws(() => parseEvery('0m'), UsageError);
  assert.throws(() => parseEvery('400d'), UsageError);
  assert.equal(formatEvery(900_000), '15m');
  assert.equal(formatEvery(3 * 3_600_000), '3h');
  assert.equal(formatEvery(2 * 86_400_000), '2d');
});

test('daily and at: make the triggers they say', () => {
  assert.deepEqual(parseDaily('09:30'), { kind: 'cron', spec: '30 9 * * *' });
  assert.throws(() => parseDaily('24:00'), UsageError);
  assert.throws(() => parseDaily('9.30'), UsageError);
  const now = at(2026, 10, 28, 10, 0);
  assert.equal(parseAt('2026-10-29 09:00', now), at(2026, 10, 29, 9));
  assert.equal(
    parseAt('2026-10-29T09:00:15', now),
    at(2026, 10, 29, 9) + 15_000,
  );
  // A clock time alone is today, or tomorrow once it has passed.
  assert.equal(parseAt('18:00', now), at(2026, 10, 28, 18));
  assert.equal(parseAt('09:00', now), at(2026, 10, 29, 9));
  assert.throws(() => parseAt('2026-10-01 09:00', now), UsageError);
  assert.throws(() => parseAt('99:99', now), UsageError);
});

test('triggerFromFlags: wants exactly one', () => {
  const now = at(2026, 10, 28, 10, 0);
  assert.deepEqual(triggerFromFlags({ every: '1h', now }), {
    kind: 'every',
    every_ms: 3_600_000,
  });
  assert.deepEqual(triggerFromFlags({ daily: '07:05', now }), {
    kind: 'cron',
    spec: '5 7 * * *',
  });
  assert.deepEqual(triggerFromFlags({ at: '11:00', now }), {
    kind: 'once',
    at: at(2026, 10, 28, 11),
  });
  assert.throws(
    () => triggerFromFlags({ every: '1h', daily: '07:00', now }),
    UsageError,
  );
  assert.throws(() => triggerFromFlags({ now }), UsageError);
});

test('cron: validates the five fields', () => {
  assert.equal(parseCronSpec(' 30   9 * * 1-5 '), '30 9 * * 1-5');
  assert.throws(() => parseCronSpec('30 9 * *'), UsageError);
  assert.throws(() => parseCronSpec('60 9 * * *'), UsageError);
  assert.throws(() => parseCronSpec('*/0 * * * *'), UsageError);
  assert.throws(() => parseCronSpec('a * * * *'), UsageError);
  assert.throws(() => parseCronSpec('90-10 * * * *'), UsageError);
  assert.throws(() => parseCronSpec('0 0 0 * *'), UsageError); // the day starts at 1
});

test('cron: finds the next minute that matches', () => {
  // 2026-10-28 is a Wednesday.
  const wed = at(2026, 10, 28, 10, 0);
  assert.equal(nextCronRun('30 9 * * *', wed), at(2026, 10, 29, 9, 30));
  assert.equal(nextCronRun('0 * * * *', wed), at(2026, 10, 28, 11));
  assert.equal(nextCronRun('*/15 * * * *', wed), at(2026, 10, 28, 10, 15));
  assert.equal(nextCronRun('0,30 8 * * *', wed), at(2026, 10, 29, 8));
  // Weekdays only: Friday afternoon runs into Monday.
  const fri = at(2026, 10, 30, 17, 0);
  assert.equal(nextCronRun('30 9 * * 1-5', fri), at(2026, 11, 2, 9, 30));
  // A step on a single value: 5/15 on the hour means 5, 20, 35, 50.
  assert.equal(nextCronRun('5/15 * * * *', wed), at(2026, 10, 28, 10, 5));
  // Sunday reads as 0 and as 7.
  assert.equal(nextCronRun('0 12 * * 7', wed), at(2026, 11, 1, 12));
  // Both day fields set: either one lets the day in, as cron does.
  assert.equal(nextCronRun('0 0 13 * 5', at(2026, 2, 1)), at(2026, 2, 6));
  // Year wrap.
  assert.equal(nextCronRun('0 0 1 1 *', wed), at(2027, 1, 1));
  // An impossible spec never fires.
  assert.equal(nextCronRun('0 0 30 2 *', wed), null);
});

test('advanceRun: keeps the cadence and skips missed runs', () => {
  const now = at(2026, 10, 28, 10, 0);
  const every = { kind: 'every', every_ms: 3_600_000 } as const;
  // A late run plans from what was planned, not from now.
  assert.equal(advanceRun(every, now, now - 3_600_000), now + 3_600_000);
  // A long stop does not queue up runs.
  assert.equal(advanceRun(every, now, now - 10 * 3_600_000), now + 3_600_000);
  assert.equal(advanceRun(every, now, null), now + 3_600_000);
  assert.equal(advanceRun({ kind: 'once', at: now }, now, null), null);
  assert.equal(
    advanceRun({ kind: 'cron', spec: '0 * * * *' }, now, null),
    at(2026, 10, 28, 11),
  );
});

test('nextRunFor: what a new schedule plans', () => {
  const now = at(2026, 10, 28, 10, 0);
  assert.equal(
    nextRunFor({ kind: 'every', every_ms: 60_000 }, now),
    now + 60_000,
  );
  assert.equal(
    nextRunFor({ kind: 'cron', spec: '0 * * * *' }, now),
    at(2026, 10, 28, 11),
  );
  assert.equal(nextRunFor({ kind: 'once', at: now + 1 }, now), now + 1);
  assert.equal(nextRunFor({ kind: 'once', at: now }, now), null);
});

test('describe and format: words the screen shows', () => {
  assert.equal(
    describeTrigger({ kind: 'every', every_ms: 900_000 }),
    'every 15m',
  );
  assert.equal(
    describeTrigger({ kind: 'cron', spec: '0 9 * * *' }),
    'cron 0 9 * * *',
  );
  assert.equal(
    describeTrigger({ kind: 'once', at: at(2026, 10, 29, 9) }),
    `once ${formatWhen(at(2026, 10, 29, 9))}`,
  );
  assert.equal(formatWhen(at(2026, 10, 29, 9, 5)), '2026-10-29 09:05');
  assert.equal(formatWhen(null), 'never');
  // A run id is its UTC time, then a short id.
  const when = at(2026, 10, 29, 9, 5);
  const stamp = new Date(when)
    .toISOString()
    .slice(0, 19)
    .replaceAll(':', '-')
    .replace('T', '-');
  assert.match(runId(when), new RegExp(`^${stamp}-[0-9a-f]{6}$`));
});

test('scheduleSlug: a name becomes one folder', () => {
  assert.equal(scheduleSlug(' Nightly Triage '), 'Nightly-Triage');
  assert.equal(scheduleSlug('a/../b'), 'a-..-b');
  assert.equal(scheduleSlug('..'), '');
  assert.equal(scheduleSlug('   '), '');
  assert.equal(scheduleSlug('x'.repeat(60)).length, 48);
});

test('add, list, pause, resume and remove work on real files', (t) => {
  const home = scratch(t);
  const now = at(2026, 10, 28, 10, 0);
  const record = addSchedule({
    name: 'nightly triage',
    prompt: 'summarize the day in NOTES.md',
    workspace: home,
    trigger: { kind: 'cron', spec: '30 9 * * *' },
    home,
    now,
  });
  assert.equal(record.name, 'nightly-triage');
  assert.equal(record.next_run, at(2026, 10, 29, 9, 30));
  assert.ok(
    existsSync(join(schedulesRoot(home), 'nightly-triage', 'schedule.json')),
  );
  assert.ok(existsSync(join(schedulesRoot(home), 'nightly-triage', 'runs')));
  assert.throws(
    () =>
      addSchedule({
        name: 'nightly triage',
        prompt: 'again',
        workspace: home,
        trigger: { kind: 'every', every_ms: MIN_EVERY_MS },
        home,
        now,
      }),
    UsageError,
  );
  assert.throws(
    () =>
      addSchedule({
        name: 'empty',
        prompt: '   ',
        workspace: home,
        trigger: { kind: 'every', every_ms: MIN_EVERY_MS },
        home,
        now,
      }),
    UsageError,
  );
  assert.throws(
    () =>
      addSchedule({
        name: 'long',
        prompt: 'x'.repeat(PROMPT_MAX + 1),
        workspace: home,
        trigger: { kind: 'every', every_ms: MIN_EVERY_MS },
        home,
        now,
      }),
    UsageError,
  );
  const listed = listSchedules(home);
  assert.deepEqual(listed.problems, []);
  assert.equal(listed.records.length, 1);
  assert.equal(getSchedule('nightly triage', home).prompt, record.prompt);
  const paused = updateSchedule('nightly-triage', home, (r) => {
    r.paused = true;
    r.note = 'paused by hand';
  });
  assert.equal(paused.paused, true);
  assert.equal(paused.note, 'paused by hand');
  const resumed = updateSchedule('nightly-triage', home, (r) => {
    r.paused = false;
    r.note = '';
    if (r.next_run !== null && r.next_run <= now)
      r.next_run = advanceRun(r.trigger, now, null);
  });
  assert.equal(resumed.paused, false);
  assert.equal(resumed.next_run, at(2026, 10, 29, 9, 30));
  // An every schedule plans from now.
  const every = addSchedule({
    name: 'watch',
    prompt: 'check the build',
    workspace: home,
    trigger: { kind: 'every', every_ms: 10 * MIN_EVERY_MS },
    home,
    now,
  });
  assert.equal(every.next_run, now + 10 * MIN_EVERY_MS);
  assert.equal(removeSchedule('watch', home), true);
  assert.equal(removeSchedule('watch', home), false);
  assert.equal(listSchedules(home).records.length, 1);
});

test('a broken schedule is a problem, not a crash', (t) => {
  const home = scratch(t);
  addSchedule({
    name: 'good',
    prompt: 'hi',
    workspace: home,
    trigger: { kind: 'every', every_ms: MIN_EVERY_MS },
    home,
    now: Date.now(),
  });
  const bad = join(schedulesRoot(home), 'bad');
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, 'schedule.json'), '{ not json', 'utf8');
  const { records, problems } = listSchedules(home);
  assert.equal(records.length, 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /bad/);
});

test('history appends and stops at the kept count', (t) => {
  const home = scratch(t);
  const record = addSchedule({
    name: 'hist',
    prompt: 'hi',
    workspace: home,
    trigger: { kind: 'every', every_ms: MIN_EVERY_MS },
    home,
    now: Date.now(),
  });
  for (let n = 0; n < HISTORY_KEEP + 2; n++)
    appendHistory(record.name, home, {
      id: `r${n}`,
      kind: 'scheduled',
      started_at: n,
      ended_at: n + 1,
      status: n % 7 ? 'ok' : 'failed',
      exit_code: n % 7 ? 0 : 1,
      log: `runs/r${n}.log`,
    });
  const runs = readHistory(record.name, home);
  assert.equal(runs.length, HISTORY_KEEP);
  assert.equal(runs.at(-1)!.id, `r${HISTORY_KEEP + 1}`);
  assert.equal(runs[0]!.id, 'r2');
});

test('the run lock lets one holder in and sweeps a dead one', (t) => {
  const home = scratch(t);
  const record = addSchedule({
    name: 'locked',
    prompt: 'hi',
    workspace: home,
    trigger: { kind: 'every', every_ms: MIN_EVERY_MS },
    home,
    now: Date.now(),
  });
  const name = record.name;
  const first = acquireRunLock(name, home);
  assert.ok(first);
  assert.equal(runLockOwner(name, home)!.pid, process.pid);
  assert.equal(acquireRunLock(name, home), null);
  first!.release();
  assert.equal(runLockOwner(name, home), null);
  // A lock left by a dead pid does not keep the schedule shut.
  const dir = join(schedulesRoot(home), name, 'running.lock');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'owner.json'),
    JSON.stringify({ pid: 2_000_000_000, started_at: 1 }),
    'utf8',
  );
  assert.equal(isProcessAlive(2_000_000_000), false);
  assert.equal(isProcessAlive(process.pid), true);
  const swept = acquireRunLock(name, home);
  assert.ok(swept);
  swept!.release();
});

test('the daemon file names one scheduler', (t) => {
  const home = scratch(t);
  assert.equal(readDaemonFile(home), null);
  writeDaemonFile(home, { pid: process.pid, started_at: 123 });
  assert.deepEqual(readDaemonFile(home), { pid: process.pid, started_at: 123 });
  clearDaemonFile(home, process.pid + 1); // another pid may not clear it
  assert.ok(readDaemonFile(home));
  clearDaemonFile(home, process.pid);
  assert.equal(readDaemonFile(home), null);
  assert.equal(daemonFilePath(home), join(schedulesRoot(home), 'daemon.json'));
  // A half-written file reads as no daemon, and a live one as alive.
  mkdirSync(schedulesRoot(home), { recursive: true });
  writeFileSync(daemonFilePath(home), '{', 'utf8');
  assert.equal(readDaemonFile(home), null);
});

test('a failure count that reaches the limit pauses the schedule', (t) => {
  const home = scratch(t);
  const record = addSchedule({
    name: 'failing',
    prompt: 'hi',
    workspace: home,
    trigger: { kind: 'every', every_ms: MIN_EVERY_MS },
    home,
    now: Date.now(),
  });
  const after = updateSchedule(record.name, home, (r) => {
    r.failures = FAILURE_PAUSE_AFTER;
    if (r.failures >= FAILURE_PAUSE_AFTER && !r.paused) {
      r.paused = true;
      r.note = `paused after ${r.failures} runs that failed`;
    }
  });
  assert.equal(after.paused, true);
  assert.match(after.note, /3 runs that failed/);
});
