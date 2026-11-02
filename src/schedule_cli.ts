// `circle schedule`: the command line for scheduled tasks. It keeps the store
// (schedule.ts) and the runner (scheduler.ts) apart from the words on screen.
import { existsSync, statSync } from 'node:fs';
import { circleHome, expandUser, normalizeWorkspace } from './paths.js';
import { UsageError } from './usage_error.js';
import {
  addSchedule,
  advanceRun,
  daemonFilePath,
  describeTrigger,
  formatWhen,
  getSchedule,
  listSchedules,
  readDaemonFile,
  readHistory,
  removeSchedule,
  scheduleSlug,
  triggerFromFlags,
  updateSchedule,
  type ScheduleRecord,
} from './schedule.js';
import {
  daemonLoop,
  daemonStatus,
  defaultExecute,
  fireSchedule,
  pickDue,
  startDaemon,
  stopDaemon,
  type Execute,
} from './scheduler.js';

export interface ScheduleIo {
  home?: string;
  cwd?: string;
  now?: () => number;
  out?: { write(text: string): unknown };
  execute?: Execute;
  /** What `schedule daemon` runs on; tests hand in a script model instead. */
  signal?: AbortSignal;
}

const USAGE = [
  'usage: circle schedule <command> [name] [options]',
  '',
  'run prompts on a clock. each schedule works in one folder and prints',
  'its answer to a log under schedules/<name>/ in the data folder.',
  '',
  '  add NAME PROMPT --every 15m | --daily 09:30 | --cron "30 9 * * 1-5" | --at "2026-10-29 09:00"',
  '      [-w FOLDER] [-m MODEL] [--yolo] [--extensions]   make a schedule',
  '  list [--json]                       every schedule, its clock, its next run',
  '  show NAME                           one schedule and its last runs',
  '  pause NAME / resume NAME            hold a schedule; let it go again',
  '  remove NAME                         delete a schedule and its logs',
  '  run NAME                            run it now, apart from its clock',
  '  tick                                run what is due now and exit',
  '  status                              the scheduler and what comes next',
  '  start / stop                        the background scheduler',
  '  daemon                              run the scheduler in this terminal',
  '',
  '--every: 45s up to 365d. --cron: five fields — minute hour day-of-month',
  'month day-of-week, in local time; a missed time while nothing runs is',
  'skipped, the next one waits.',
].join('\n');

interface Parsed {
  flags: Record<string, string>;
  booleans: Set<string>;
  words: string[];
}
function parseArgs(
  argv: string[],
  values: Record<string, string>,
  booleans: Record<string, true>,
): Parsed {
  const flags: Record<string, string> = {};
  const done = new Set<string>();
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === '--') {
      words.push(...argv.slice(i + 1));
      break;
    }
    const valueKey = values[raw];
    if (valueKey) {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${raw} needs a value`);
      flags[valueKey] = value;
      continue;
    }
    const boolean = booleans[raw];
    if (boolean) {
      if (done.has(raw)) throw new UsageError(`${raw} given twice`);
      done.add(raw);
      continue;
    }
    if (raw.startsWith('-')) throw new UsageError(`unknown option: ${raw}`);
    words.push(raw);
  }
  return { flags, booleans: done, words };
}

const ADD_VALUES: Record<string, string> = {
  '--every': 'every',
  '--cron': 'cron',
  '--daily': 'daily',
  '--at': 'at',
  '-w': 'workspace',
  '--workspace': 'workspace',
  '-m': 'model',
  '--model': 'model',
};
const ADD_BOOLEANS: Record<string, true> = {
  '--yolo': true,
  '--extensions': true,
};

function oneName(words: string[], command: string): string {
  const name = words.find((word) => !word.startsWith('-'));
  if (!name) throw new UsageError(`circle schedule ${command} NAME`);
  return name;
}

export async function runSchedule(
  argv: string[],
  io: ScheduleIo = {},
): Promise<number> {
  const home = io.home ?? circleHome();
  const now = io.now ?? Date.now;
  const out = io.out ?? process.stdout;
  const say = (text: string): void => {
    out.write(text + '\n');
  };
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      say(USAGE);
      return 0;
    case 'add': {
      const parsed = parseArgs(rest, ADD_VALUES, ADD_BOOLEANS);
      if (parsed.words.length < 2)
        throw new UsageError(
          'circle schedule add NAME PROMPT --every 15m | --daily 09:30 | --cron "30 9 * * *" | --at "2026-10-29 09:00"',
        );
      const [name, ...promptWords] = parsed.words;
      const workspaceRaw = parsed.flags.workspace ?? io.cwd ?? process.cwd();
      const workspace = normalizeWorkspace(expandUser(workspaceRaw));
      if (!existsSync(workspace) || !statSync(workspace).isDirectory())
        throw new UsageError(`no such folder: ${workspaceRaw}`);
      const trigger = triggerFromFlags({
        every: parsed.flags.every,
        cron: parsed.flags.cron,
        daily: parsed.flags.daily,
        at: parsed.flags.at,
        now: now(),
      });
      const record = addSchedule({
        name: name!,
        prompt: promptWords.join(' '),
        workspace,
        trigger,
        model: parsed.flags.model,
        yolo: parsed.booleans.has('--yolo'),
        extensions: parsed.booleans.has('--extensions'),
        home,
        now: now(),
      });
      say(
        `added · ${record.name} · ${describeTrigger(record.trigger)} · next ${formatWhen(record.next_run)} · ${record.workspace}`,
      );
      const running = daemonStatus(home);
      if (!running.running && !record.done && record.next_run !== null)
        say(
          'the scheduler is not running · circle schedule start · or call circle schedule tick from your own cron',
        );
      return 0;
    }
    case 'list': {
      const json = rest.includes('--json');
      const { records, problems } = listSchedules(home);
      for (const problem of problems) say(`problem · ${problem}`);
      if (json) {
        out.write(JSON.stringify(records, null, 2) + '\n');
        return problems.length ? 1 : 0;
      }
      if (!records.length) {
        say('nothing scheduled · circle schedule add NAME "prompt" --every 1h');
        return 0;
      }
      for (const record of records) say(describeLine(record));
      return problems.length ? 1 : 0;
    }
    case 'show': {
      const record = getSchedule(oneName(rest, 'show'), home);
      say(describeLine(record));
      const row = (key: string, value: string): void =>
        say('  ' + key.padEnd(10, ' ') + value);
      row('prompt', record.prompt);
      row('workspace', record.workspace);
      if (record.model) row('model', record.model);
      const on = [
        record.yolo ? 'yolo' : '',
        record.extensions ? 'extensions' : '',
      ].filter(Boolean);
      if (on.length) row('runs with', on.join(' · '));
      row('created', formatWhen(record.created_at));
      row(
        'state',
        record.done
          ? 'done'
          : record.paused
            ? 'paused' + (record.note ? ` · ${record.note}` : '')
            : record.running
              ? `running since ${formatWhen(record.running.started_at)}`
              : 'on',
      );
      row('next', formatWhen(record.next_run));
      if (record.last_run) {
        const run = record.last_run;
        row(
          'last',
          `${run.status} · ${formatWhen(run.ended_at)} · ${run.kind} · log ${run.log}`,
        );
      }
      const history = readHistory(record.name, home).slice(-5);
      if (history.length) {
        say('  recent runs');
        for (const run of history)
          say(
            `    ${formatWhen(run.ended_at)} · ${run.status} · ${Math.round((run.ended_at - run.started_at) / 1000)}s · ${run.kind} · ${run.log}`,
          );
      }
      return 0;
    }
    case 'pause': {
      const record = updateSchedule(oneName(rest, 'pause'), home, (r) => {
        if (r.done)
          throw new UsageError(`schedule ${r.name} has run; add it again`);
        r.paused = true;
        r.note = 'paused by hand';
      });
      say(`paused · ${record.name}`);
      return 0;
    }
    case 'resume': {
      const at = now();
      const record = updateSchedule(oneName(rest, 'resume'), home, (r) => {
        if (r.done)
          throw new UsageError(`schedule ${r.name} has run; add it again`);
        if (r.trigger.kind === 'once' && (!r.next_run || r.next_run <= at))
          throw new UsageError('that time has passed; add the schedule again');
        r.paused = false;
        r.note = '';
        r.failures = 0;
        if (r.next_run === null || r.next_run <= at)
          r.next_run = advanceRun(r.trigger, at, null);
      });
      say(`resumed · ${record.name} · next ${formatWhen(record.next_run)}`);
      return 0;
    }
    case 'remove': {
      const name = oneName(rest, 'remove');
      if (!removeSchedule(name, home))
        throw new UsageError(`no schedule: ${scheduleSlug(name)}`);
      say(`removed · ${scheduleSlug(name)} (with its logs)`);
      return 0;
    }
    case 'run': {
      const run = await fireSchedule(oneName(rest, 'run'), {
        home,
        now,
        execute: io.execute ?? defaultExecute,
        log: say,
      });
      return run.status === 'ok' ? 0 : 1;
    }
    case 'tick': {
      const due = pickDue(home, now());
      if (!due.length) {
        say('nothing due');
        return 0;
      }
      let failed = 0;
      const runs = await Promise.all(
        due.map((record) =>
          fireSchedule(record.name, {
            home,
            now,
            execute: io.execute ?? defaultExecute,
            log: say,
            kind: 'tick',
            planned: record.next_run,
          }).catch((error) => {
            say(
              `${record.name} · ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
          }),
        ),
      );
      for (const run of runs) if (!run || run.status !== 'ok') failed++;
      say(`tick · ${due.length} started · ${failed} not ok`);
      return failed ? 1 : 0;
    }
    case 'status': {
      const daemon = daemonStatus(home);
      say(
        daemon.running
          ? `scheduler · running · pid ${daemon.pid} · since ${formatWhen(daemon.started_at ?? null)}`
          : `scheduler · not running · circle schedule start · ${daemonFilePath(home)}`,
      );
      const { records, problems } = listSchedules(home);
      for (const problem of problems) say(`problem · ${problem}`);
      const paused = records.filter((r) => r.paused).length;
      const done = records.filter((r) => r.done).length;
      say(
        `schedules · ${records.length} · ${records.length - paused - done} on · ${paused} paused · ${done} done`,
      );
      const upcoming = records
        .filter((r) => !r.paused && !r.done && r.next_run !== null)
        .sort((a, b) => (a.next_run ?? 0) - (b.next_run ?? 0))
        .slice(0, 3);
      for (const r of upcoming)
        say(`next · ${r.name} · ${formatWhen(r.next_run)}`);
      return problems.length ? 1 : 0;
    }
    case 'start': {
      const result = await startDaemon({ home, log: say });
      say(result.message);
      return result.started || (result.pid ?? 0) > 0 ? 0 : 1;
    }
    case 'stop': {
      const result = await stopDaemon({ home });
      say(result.message);
      return result.stopped || result.message.includes('not running') ? 0 : 1;
    }
    case 'daemon': {
      const known = readDaemonFile(home);
      if (known && known.pid !== process.pid && daemonStatus(home).running) {
        say(`the scheduler is already running · pid ${known.pid}`);
        return 1;
      }
      const signal = io.signal ?? terminateSignal();
      await daemonLoop({
        home,
        now,
        execute: io.execute ?? defaultExecute,
        log: say,
        signal,
      });
      return 0;
    }
    default:
      throw new UsageError(
        `unknown schedule command: ${command} · circle schedule --help`,
      );
  }
}

function describeLine(record: ScheduleRecord): string {
  const tags = [
    record.done ? 'done' : '',
    record.paused ? 'paused' : '',
    record.running ? 'running' : '',
  ].filter(Boolean);
  return (
    `${record.name} · ${describeTrigger(record.trigger)} · next ${formatWhen(record.next_run)}` +
    (tags.length ? ` (${tags.join(', ')})` : '') +
    (record.last_run ? ` · last ${record.last_run.status}` : '')
  );
}

/** A signal that ends `circle schedule daemon` on ctrl+c or a stop request. */
function terminateSignal(): AbortSignal {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return controller.signal;
}
