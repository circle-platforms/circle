// Scheduled tasks: prompts that run on a clock. This module owns the files and
// the clock — it stores each schedule under the data folder, parses triggers,
// computes when the next run is due, and keeps the run records. The loop that
// fires them is in scheduler.ts; the `circle schedule` command is in schedule_cli.ts.
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { circleHome, ensureHome, schedulesRoot } from './paths.js';
import {
  isRecord,
  readJson,
  withPrivateJsonLock,
  writePrivateJson,
} from './settings.js';
import { UsageError } from './usage_error.js';

export const MIN_EVERY_MS = 60_000;
export const MAX_EVERY_MS = 365 * 24 * 60 * 60_000;
/** How long a prompt may be. A schedule is a short standing instruction, not a document. */
export const PROMPT_MAX = 8000;
/** A run that passes this is stopped. */
export const RUN_LIMIT_MS = 4 * 60 * 60_000;
/** Failures in a row before a schedule is paused and left for its owner to notice. */
export const FAILURE_PAUSE_AFTER = 3;
/** Run records kept in history.jsonl per schedule. */
export const HISTORY_KEEP = 50;
/** How far ahead a cron trigger is scanned before it is called impossible. */
const CRON_SCAN_DAYS = 1465;

export interface EveryTrigger {
  kind: 'every';
  every_ms: number;
}
export interface CronTrigger {
  kind: 'cron';
  spec: string;
}
export interface OnceTrigger {
  kind: 'once';
  at: number;
}
export type Trigger = EveryTrigger | CronTrigger | OnceTrigger;

export interface ScheduleRunning {
  id: string;
  started_at: number;
  log: string;
}
export interface RunRecord {
  id: string;
  kind: 'scheduled' | 'manual' | 'tick';
  started_at: number;
  ended_at: number;
  status: 'ok' | 'failed' | 'stopped';
  exit_code: number | null;
  log: string;
}
export interface ScheduleRecord {
  name: string;
  prompt: string;
  workspace: string;
  trigger: Trigger;
  model: string;
  yolo: boolean;
  extensions: boolean;
  paused: boolean;
  done: boolean;
  note: string;
  created_at: number;
  /** When the next run is due, in epoch ms. Null when nothing is due. */
  next_run: number | null;
  running: ScheduleRunning | null;
  last_run: RunRecord | null;
  failures: number;
}

// ── triggers ──

const UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
/** '45s', '10m', '3h', '2d' — the plain spacing between runs. */
export function parseEvery(text: string): number {
  const match = /^(\d+)([smhd])$/.exec(text.trim());
  if (!match)
    throw new UsageError('every: give a number and a unit, like 15m, 3h or 2d');
  const size = UNITS[match[2]!];
  if (size === undefined)
    throw new UsageError('every: give a number and a unit, like 15m, 3h or 2d');
  const ms = Number(match[1]) * size;
  if (ms < MIN_EVERY_MS) throw new UsageError('every: at least 1m');
  if (ms > MAX_EVERY_MS) throw new UsageError('every: at most 365d');
  return ms;
}
export function formatEvery(ms: number): string {
  const units: [string, number][] = [
    ['d', UNITS.d!],
    ['h', UNITS.h!],
    ['m', UNITS.m!],
    ['s', UNITS.s!],
  ];
  for (const [unit, size] of units)
    if (ms % size === 0) return String(ms / size) + unit;
  return String(ms);
}
/** '09:30' — every day at that local time, as a cron trigger. */
export function parseDaily(text: string): CronTrigger {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59)
    throw new UsageError('daily: give a time like 09:30');
  return {
    kind: 'cron',
    spec: `${Number(match[2])} ${Number(match[1])} * * *`,
  };
}
/** 'HH:MM', 'YYYY-MM-DD HH:MM' or 'YYYY-MM-DDTHH:MM' (seconds optional), in local time. */
export function parseAt(text: string, now: number): number {
  const trimmed = text.trim();
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (clock) {
    if (Number(clock[1]) > 23 || Number(clock[2]) > 59)
      throw new UsageError('at: unknown time: ' + trimmed);
    const at = new Date(now);
    at.setHours(Number(clock[1]), Number(clock[2]), Number(clock[3] || 0), 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return at.getTime();
  }
  const day =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!day || Number(day[5]) > 23 || Number(day[6] ?? 0) > 59)
    throw new UsageError('at: give a time like 2026-10-29 09:00');
  const at = new Date(
    Number(day[1]),
    Number(day[2]) - 1,
    Number(day[3]),
    Number(day[4]),
    Number(day[5]),
    Number(day[6] || 0),
    0,
  );
  if (at.getTime() <= now) throw new UsageError('at: that time has passed');
  return at.getTime();
}
/** One trigger out of the four flags; exactly one must be set. */
export function triggerFromFlags(flags: {
  every?: string;
  cron?: string;
  daily?: string;
  at?: string;
  now: number;
}): Trigger {
  const chosen = ['every', 'cron', 'daily', 'at'].filter(
    (name) => flags[name as 'every'] !== undefined,
  );
  if (chosen.length !== 1)
    throw new UsageError(
      'give exactly one of --every, --cron, --daily or --at',
    );
  if (flags.every !== undefined)
    return { kind: 'every', every_ms: parseEvery(flags.every) };
  if (flags.cron !== undefined)
    return { kind: 'cron', spec: parseCronSpec(flags.cron) };
  if (flags.daily !== undefined) return parseDaily(flags.daily);
  return { kind: 'once', at: parseAt(flags.at!, flags.now) };
}

interface CronField {
  values: Set<number>;
  any: boolean;
}
interface CronParsed {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}
/** Five fields: minute hour day-of-month month day-of-week. */
export function parseCronSpec(text: string): string {
  const fields = text.trim().split(/\s+/);
  if (fields.length !== 5)
    throw new UsageError(
      'cron: needs five fields — minute hour day month weekday',
    );
  parseCronFields(text);
  return fields.join(' ');
}
function parseCronField(
  text: string,
  min: number,
  max: number,
  name: string,
): CronField {
  const values = new Set<number>();
  let any = false;
  for (const term of text.split(',')) {
    const match = /^([^/]+)(?:\/(\d+))?$/.exec(term);
    if (!match) throw new UsageError(`cron: ${name} has a bad part: ${term}`);
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isInteger(step) || step <= 0)
      throw new UsageError(`cron: ${name} has a bad step: ${term}`);
    let from = min;
    let to = max;
    const body = match[1]!;
    if (body === '*') any = true;
    else if (body.includes('-')) {
      const [a, b] = body.split('-', 2);
      from = Number(a);
      to = Number(b);
      if (!Number.isInteger(from) || !Number.isInteger(to))
        throw new UsageError(`cron: ${name} has a bad range: ${term}`);
    } else if (/^\d+$/.test(body)) {
      from = Number(body);
      to = step > 1 ? max : from;
    } else throw new UsageError(`cron: ${name} has a bad part: ${term}`);
    const low = name === 'day' ? 1 : 0;
    if (from < low || to > max || from > to)
      throw new UsageError(`cron: ${name} is out of range: ${term}`);
    for (let v = from; v <= to; v += step) values.add(v);
  }
  if (!values.size) throw new UsageError(`cron: ${name} matches nothing`);
  return { values, any };
}
function parseCronFields(spec: string): CronParsed {
  const fields = spec.trim().split(/\s+/);
  const dow = parseCronField(fields[4]!, 0, 7, 'weekday');
  // 7 is Sunday, like 0.
  if (dow.values.has(7)) {
    dow.values.delete(7);
    dow.values.add(0);
  }
  return {
    minute: parseCronField(fields[0]!, 0, 59, 'minute'),
    hour: parseCronField(fields[1]!, 0, 23, 'hour'),
    dom: parseCronField(fields[2]!, 1, 31, 'day'),
    month: parseCronField(fields[3]!, 1, 12, 'month'),
    dow,
  };
}
function cronMatchesDay(d: Date, c: CronParsed): boolean {
  const byDate = c.dom.values.has(d.getDate());
  const byWeekday = c.dow.values.has(d.getDay());
  // Both day fields restricted: either one lets the day in, as cron does.
  if (!c.dom.any && !c.dow.any) return byDate || byWeekday;
  return byDate && byWeekday;
}
/** The first minute after `from`, in local time, that the spec matches. */
export function nextCronRun(spec: string, from: number): number | null {
  const c = parseCronFields(spec);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const stop = from + CRON_SCAN_DAYS * 86_400_000;
  while (d.getTime() <= stop) {
    if (!c.month.values.has(d.getMonth() + 1) || !cronMatchesDay(d, c)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (c.hour.values.has(d.getHours()) && c.minute.values.has(d.getMinutes()))
      return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** When the run after the one that just fired is due. `fired` is its planned time. */
export function advanceRun(
  trigger: Trigger,
  now: number,
  fired: number | null,
): number | null {
  if (trigger.kind === 'once') return null;
  if (trigger.kind === 'cron') return nextCronRun(trigger.spec, now);
  let next = (fired ?? now) + trigger.every_ms;
  while (next <= now) next += trigger.every_ms;
  return next;
}

export function describeTrigger(t: Trigger): string {
  if (t.kind === 'every') return `every ${formatEvery(t.every_ms)}`;
  if (t.kind === 'cron') return `cron ${t.spec}`;
  return `once ${formatWhen(t.at)}`;
}

// ── the files ──

export function scheduleSlug(name: string): string {
  return name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48);
}
export function scheduleDir(name: string, home = circleHome()): string {
  const slug = scheduleSlug(name);
  if (!slug) throw new UsageError('name needs letters or digits');
  return join(schedulesRoot(ensureHome(home)), slug);
}
const scheduleFile = (name: string, home: string): string =>
  join(scheduleDir(name, home), 'schedule.json');
const historyFile = (name: string, home: string): string =>
  join(scheduleDir(name, home), 'history.jsonl');
export const runsDir = (name: string, home: string): string =>
  join(scheduleDir(name, home), 'runs');

/** The name of one run's log: its time, then a short id. */
export function runId(now: number): string {
  return (
    new Date(now)
      .toISOString()
      .slice(0, 19)
      .replaceAll(':', '-')
      .replace('T', '-') +
    '-' +
    randomUUID().slice(0, 6)
  );
}

function triggerFromDict(raw: unknown): Trigger {
  if (!isRecord(raw)) throw new Error('bad trigger');
  if (raw.kind === 'every' && Number(raw.every_ms) > 0)
    return { kind: 'every', every_ms: Number(raw.every_ms) };
  if (raw.kind === 'cron' && typeof raw.spec === 'string')
    return { kind: 'cron', spec: raw.spec };
  if (raw.kind === 'once' && Number(raw.at) > 0)
    return { kind: 'once', at: Number(raw.at) };
  throw new Error('bad trigger');
}
const bool = (value: unknown): boolean => value === true;
const numOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function runFromDict(raw: unknown): RunRecord {
  if (!isRecord(raw) || typeof raw.id !== 'string')
    throw new Error('bad run record');
  const status = raw.status;
  if (status !== 'ok' && status !== 'failed' && status !== 'stopped')
    throw new Error('bad run record');
  const kind = raw.kind;
  return {
    id: raw.id,
    kind:
      kind === 'manual' || kind === 'tick' || kind === 'scheduled'
        ? kind
        : 'scheduled',
    started_at: Number(raw.started_at) || 0,
    ended_at: Number(raw.ended_at) || 0,
    status,
    exit_code: numOrNull(raw.exit_code),
    log: typeof raw.log === 'string' ? raw.log : '',
  };
}
export function parseSchedule(raw: unknown, name: string): ScheduleRecord {
  if (!isRecord(raw) || typeof raw.prompt !== 'string' || !raw.prompt.trim())
    throw new Error(`schedule ${name} has no prompt`);
  if (typeof raw.workspace !== 'string' || !raw.workspace)
    throw new Error(`schedule ${name} has no workspace`);
  let trigger: Trigger;
  try {
    trigger = triggerFromDict(raw.trigger);
  } catch {
    throw new Error(`schedule ${name} has a bad trigger`);
  }
  const running = isRecord(raw.running) ? raw.running : null;
  return {
    name: typeof raw.name === 'string' && raw.name ? raw.name : name,
    prompt: raw.prompt,
    workspace: raw.workspace,
    trigger,
    model: typeof raw.model === 'string' ? raw.model : '',
    yolo: bool(raw.yolo),
    extensions: bool(raw.extensions),
    paused: bool(raw.paused),
    done: bool(raw.done),
    note: typeof raw.note === 'string' ? raw.note : '',
    created_at: Number(raw.created_at) || 0,
    next_run: numOrNull(raw.next_run),
    running:
      running && typeof running.id === 'string'
        ? {
            id: running.id,
            started_at: Number(running.started_at) || 0,
            log: typeof running.log === 'string' ? running.log : '',
          }
        : null,
    last_run: raw.last_run ? runFromDict(raw.last_run) : null,
    failures: Number(raw.failures) || 0,
  };
}

/** The next due time for a trigger a schedule was just made with. */
export const nextRunFor = (trigger: Trigger, now: number): number | null =>
  trigger.kind === 'every'
    ? now + trigger.every_ms
    : trigger.kind === 'cron'
      ? nextCronRun(trigger.spec, now)
      : trigger.at > now
        ? trigger.at
        : null;

export interface AddInput {
  name: string;
  prompt: string;
  workspace: string;
  trigger: Trigger;
  model?: string;
  yolo?: boolean;
  extensions?: boolean;
  home?: string;
  now?: number;
}
export function addSchedule(input: AddInput): ScheduleRecord {
  const home = input.home ?? circleHome();
  const now = input.now ?? Date.now();
  const prompt = input.prompt.trim();
  if (!prompt) throw new UsageError('the schedule needs a prompt');
  if (prompt.length > PROMPT_MAX)
    throw new UsageError(
      `the prompt is too long (max ${PROMPT_MAX} characters)`,
    );
  const file = scheduleFile(input.name, home);
  if (existsSync(file))
    throw new UsageError(`schedule ${scheduleSlug(input.name)} already exists`);
  const record: ScheduleRecord = {
    name: scheduleSlug(input.name),
    prompt,
    workspace: input.workspace,
    trigger: input.trigger,
    model: (input.model || '').trim(),
    yolo: input.yolo === true,
    extensions: input.extensions === true,
    paused: false,
    done: false,
    note: '',
    created_at: now,
    next_run: nextRunFor(input.trigger, now),
    running: null,
    last_run: null,
    failures: 0,
  };
  mkdirSync(runsDir(record.name, home), { recursive: true });
  writePrivateJson(file, record);
  return record;
}
export function loadSchedule(
  name: string,
  home = circleHome(),
): ScheduleRecord | undefined {
  const file = scheduleFile(name, home);
  if (!existsSync(file)) return undefined;
  return parseSchedule(readJson(file), scheduleSlug(name));
}
export function getSchedule(name: string, home = circleHome()): ScheduleRecord {
  const record = loadSchedule(name, home);
  if (!record) throw new UsageError(`no schedule: ${scheduleSlug(name)}`);
  return record;
}
export function listSchedules(home = circleHome()): {
  records: ScheduleRecord[];
  problems: string[];
} {
  const records: ScheduleRecord[] = [];
  const problems: string[] = [];
  let names: string[];
  try {
    names = readdirSync(schedulesRoot(home), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { records, problems };
  }
  for (const name of names.sort()) {
    const file = join(schedulesRoot(home), name, 'schedule.json');
    if (!existsSync(file)) continue;
    try {
      records.push(parseSchedule(readJson(file), name));
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      problems.push(`${why} (${file})`);
    }
  }
  return { records, problems };
}
/** Read the record, change it, write it back. The lock holds other copies off. */
export function updateSchedule(
  name: string,
  home: string,
  mutate: (record: ScheduleRecord) => void,
): ScheduleRecord {
  const file = scheduleFile(name, home);
  return withPrivateJsonLock(file, () => {
    if (!existsSync(file))
      throw new UsageError(`no schedule: ${scheduleSlug(name)}`);
    const record = parseSchedule(readJson(file), scheduleSlug(name));
    mutate(record);
    writePrivateJson(file, record);
    return record;
  });
}
export function removeSchedule(name: string, home = circleHome()): boolean {
  const dir = scheduleDir(name, home);
  if (!existsSync(join(dir, 'schedule.json'))) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
/** One run's log file, named as the record keeps it: runs/<id>.log */
export const scheduleLogPath = (
  name: string,
  home: string,
  log: string,
): string => join(scheduleDir(name, home), log);

export function appendHistory(
  name: string,
  home: string,
  entry: RunRecord,
): void {
  const path = historyFile(name, home);
  let lines: string[] = [];
  try {
    lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch {
    /* the first run */
  }
  lines.push(JSON.stringify(entry));
  writeFileSync(path, lines.slice(-HISTORY_KEEP).join('\n') + '\n');
}
export function readHistory(name: string, home: string): RunRecord[] {
  let lines: string[] = [];
  try {
    lines = readFileSync(historyFile(name, home), 'utf8')
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
  const runs: RunRecord[] = [];
  for (const line of lines) {
    try {
      runs.push(runFromDict(JSON.parse(line)));
    } catch {
      /* a half-written line is not a run */
    }
  }
  return runs;
}

// ── the run lock: one run of a schedule at a time, across processes ──

export interface RunLock {
  release(): void;
}
const lockDir = (name: string, home: string): string =>
  join(scheduleDir(name, home), 'running.lock');
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is somebody else's.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
export function runLockOwner(
  name: string,
  home: string,
): { pid: number; started_at: number } | null {
  try {
    const raw = readJson(join(lockDir(name, home), 'owner.json'));
    if (!isRecord(raw)) return null;
    return {
      pid: Number(raw.pid) || 0,
      started_at: Number(raw.started_at) || 0,
    };
  } catch {
    return null;
  }
}
/** Takes the lock, or null when a live process holds it. A lock left by a dead one is swept. */
export function acquireRunLock(name: string, home: string): RunLock | null {
  const dir = lockDir(name, home);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir, { recursive: false });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = runLockOwner(name, home);
      if (owner && isProcessAlive(owner.pid)) return null;
      // A crash leaves a lock with no live owner behind. Take it once and retry.
      rmSync(dir, { recursive: true, force: true });
      if (attempt === 1) return null;
    }
  }
  writePrivateJson(join(dir, 'owner.json'), {
    pid: process.pid,
    started_at: Date.now(),
  });
  return {
    release: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ── the daemon file: the one scheduler process per data folder ──

export const daemonFilePath = (home = circleHome()): string =>
  join(schedulesRoot(home), 'daemon.json');
export const daemonLogPath = (home = circleHome()): string =>
  join(schedulesRoot(home), 'daemon.log');
export function readDaemonFile(
  home = circleHome(),
): { pid: number; started_at: number } | null {
  try {
    const raw = readJson(daemonFilePath(home));
    if (!isRecord(raw)) return null;
    return {
      pid: Number(raw.pid) || 0,
      started_at: Number(raw.started_at) || 0,
    };
  } catch {
    return null;
  }
}
export function writeDaemonFile(
  home: string,
  value: { pid: number; started_at: number },
): void {
  mkdirSync(schedulesRoot(home), { recursive: true });
  writePrivateJson(daemonFilePath(home), value);
}
export function clearDaemonFile(home: string, pid: number): void {
  const known = readDaemonFile(home);
  if (known && known.pid === pid) rmSync(daemonFilePath(home), { force: true });
}

// ── words ──

const two = (n: number): string => String(n).padStart(2, '0');
/** '2026-10-29 09:30', in local time. No time reads 'never'. */
export function formatWhen(ms: number | null): string {
  if (!ms) return 'never';
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
