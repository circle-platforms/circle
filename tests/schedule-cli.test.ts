import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSchedule } from '../src/schedule_cli.js';
import {
  getSchedule,
  listSchedules,
  readHistory,
  updateSchedule,
} from '../src/schedule.js';
import type { Execute } from '../src/scheduler.js';
import { UsageError } from '../src/usage_error.js';
import { schedulesRoot } from '../src/paths.js';
import {
  defaultSettings,
  saveCredentials,
  saveSettings,
  trustFolder,
} from '../src/settings.js';
import { cleanup, scratch } from './helpers.js';

const base = new Date(2026, 9, 28, 10, 0).getTime();

/** The executor the in-process command tests use: it answers and writes a log. */
const answered: Execute = async (job) => {
  writeFileSync(job.logPath, 'the answer\n', 'utf8');
  return { status: 'ok', exit_code: 0 };
};
const alwaysFailed: Execute = async () => ({
  status: 'failed',
  exit_code: 1,
});

/** io for runSchedule, with the screen kept as text. */
function ioFor(
  home: string,
  workspace: string,
  execute: Execute,
  clock = base,
) {
  const screen = { text: '' };
  return {
    screen,
    io: {
      home,
      cwd: workspace,
      now: () => clock,
      execute,
      out: {
        write: (chunk: string) => {
          screen.text += chunk;
          return true;
        },
      },
    } satisfies NonNullable<Parameters<typeof runSchedule>[1]>,
    reset() {
      screen.text = '';
    },
  };
}

test('add, list, show, pause, resume, run and remove', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const h = ioFor(home, workspace, answered);
  assert.equal(
    await runSchedule(
      ['add', 'notes', 'summarize the day in NOTES.md', '--daily', '09:30'],
      h.io,
    ),
    0,
  );
  assert.match(h.screen.text, /added · notes · cron 30 9 \* \* \* · next/);
  assert.match(h.screen.text, /circle schedule start/);
  const record = getSchedule('notes', home);
  assert.equal(record.prompt, 'summarize the day in NOTES.md');
  assert.equal(record.workspace, workspace);
  // The next 09:30 after 10:00 is tomorrow's.
  assert.equal(record.next_run, new Date(2026, 9, 29, 9, 30).getTime());
  h.reset();
  assert.equal(await runSchedule(['list'], h.io), 0);
  assert.match(h.screen.text, /notes · cron 30 9 \* \* \* · next/);
  h.reset();
  assert.equal(await runSchedule(['list', '--json'], h.io), 0);
  assert.equal(JSON.parse(h.screen.text)[0]!.name, 'notes');
  h.reset();
  assert.equal(await runSchedule(['show', 'notes'], h.io), 0);
  assert.match(h.screen.text, /prompt +summarize the day in NOTES.md/);
  assert.match(h.screen.text, /state +on/);
  h.reset();
  assert.equal(await runSchedule(['pause', 'notes'], h.io), 0);
  assert.match(h.screen.text, /paused · notes/);
  h.reset();
  await runSchedule(['list'], h.io);
  assert.match(h.screen.text, /\(paused\)/);
  h.reset();
  assert.equal(await runSchedule(['resume', 'notes'], h.io), 0);
  assert.match(h.screen.text, /resumed · notes · next/);
  h.reset();
  const before = getSchedule('notes', home).next_run;
  assert.equal(await runSchedule(['run', 'notes'], h.io), 0);
  assert.match(h.screen.text, /notes · ok · 0s · log runs/);
  const after = getSchedule('notes', home);
  assert.equal(after.next_run, before, 'a manual run leaves the clock alone');
  assert.equal(after.last_run?.status, 'ok');
  assert.equal(
    readFileSync(
      join(schedulesRoot(home), 'notes', after.last_run!.log),
      'utf8',
    ).trim(),
    'the answer',
  );
  assert.equal(readHistory('notes', home).length, 1);
  h.reset();
  assert.equal(await runSchedule(['remove', 'notes'], h.io), 0);
  assert.match(h.screen.text, /removed · notes/);
  assert.equal(listSchedules(home).records.length, 0);
});

test('usage errors say what is wrong', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const h = ioFor(home, workspace, answered);
  await assert.rejects(runSchedule(['add', 'onlyname'], h.io), UsageError);
  await assert.rejects(
    runSchedule(
      ['add', 'a', 'prompt', '--every', '1h', '--daily', '09:00'],
      h.io,
    ),
    /exactly one/,
  );
  await assert.rejects(
    runSchedule(['add', 'a', 'prompt', '--cron', '30 9 * *'], h.io),
    /five fields/,
  );
  await assert.rejects(
    runSchedule(
      ['add', 'a', 'prompt', '--at', '09:00', '--every', '10m'],
      h.io,
    ),
    /exactly one/,
  );
  await assert.rejects(
    runSchedule(
      ['add', 'a', 'prompt', '--every', '1h', '-w', join(workspace, 'gone')],
      h.io,
    ),
    /no such folder/,
  );
  await assert.rejects(
    runSchedule(['add', 'a', 'prompt', '--bogus'], h.io),
    /unknown option/,
  );
  await assert.rejects(
    runSchedule(['nonsense'], h.io),
    /unknown schedule command/,
  );
  await assert.rejects(runSchedule(['run', 'nope'], h.io), /no schedule/);
  await assert.rejects(
    runSchedule(['show'], h.io),
    /circle schedule show NAME/,
  );
  // A once schedule whose run has happened cannot be resumed.
  await runSchedule(['add', 'single', 'hi', '--at', '18:00'], h.io);
  await runSchedule(['pause', 'single'], h.io);
  await runSchedule(['resume', 'single'], h.io);
  updateSchedule('single', home, (r) => {
    r.done = true;
  });
  await assert.rejects(runSchedule(['pause', 'single'], h.io), /has run/);
});

test('tick fires what is due; status tells the tale; the daemon ends on its signal', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const h = ioFor(home, workspace, answered);
  await runSchedule(
    ['add', 'sweep', 'clean the build folder', '--every', '1h'],
    h.io,
  );
  h.reset();
  assert.equal(await runSchedule(['tick'], h.io), 0);
  assert.match(h.screen.text, /nothing due/);
  h.reset();
  const due = base + 60 * 60_000;
  h.io.now = () => due;
  assert.equal(await runSchedule(['tick'], h.io), 0);
  assert.match(h.screen.text, /tick · 1 started · 0 not ok/);
  assert.equal(getSchedule('sweep', home).last_run?.kind, 'tick');
  assert.ok((getSchedule('sweep', home).next_run ?? 0) > due);
  // A failing tick ends 1.
  const bad = ioFor(home, workspace, alwaysFailed, base + 5 * 3_600_000);
  updateSchedule('sweep', home, (r) => {
    r.next_run = base + 2 * 3_600_000;
  });
  bad.reset();
  assert.equal(await runSchedule(['tick'], bad.io), 1);
  assert.match(bad.screen.text, /1 not ok/);
  h.reset();
  assert.equal(await runSchedule(['status'], h.io), 0);
  assert.match(h.screen.text, /scheduler · not running/);
  assert.match(h.screen.text, /schedules · 1 · 1 on · 0 paused · 0 done/);
  // The daemon loop: an already-ended signal leaves it straight away.
  const controller = new AbortController();
  controller.abort();
  const lines = ioFor(home, workspace, answered);
  assert.equal(
    await runSchedule(['daemon'], { ...lines.io, signal: controller.signal }),
    0,
  );
  assert.match(lines.screen.text, /scheduler started · pid/);
  assert.match(lines.screen.text, /scheduler stopped/);
  assert.equal(listSchedules(home).records.length, 1);
});

// ── the real command line ──

const TSX_LOADER = pathToFileURL(
  join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs'),
).href;
const CLI = join(process.cwd(), 'src', 'cli.ts');
const NETWORK_VARIABLES = new Set([
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
]);

async function circle(
  args: string[],
  home: string,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', TSX_LOADER, CLI, ...args],
      {
        cwd: process.cwd(),
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([name]) => !NETWORK_VARIABLES.has(name),
            ),
          ),
          CIRCLE_HOME: home,
          CIRCLE_NO_TUI: '1',
          CIRCLE_NO_MODELS_REFRESH: '1',
          CIRCLE_JOB_WAIT: '0',
          CIRCLE_NO_UPDATE_CHECK: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (out += chunk));
    child.stderr.on('data', (chunk: string) => (err += chunk));
    child.once('error', reject);
    child.once('close', (code) => done({ code, out, err }));
  });
}

test('the circle schedule command end to end, with a scripted model', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  // A local endpoint that answers every request with one line.
  let requests = 0;
  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      for await (const _chunk of request) void _chunk;
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'gateway' }] }));
        return;
      }
      requests++;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(
        'data: ' +
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: { content: 'all done' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 40, completion_tokens: 3 },
          }) +
          '\n\ndata: [DONE]\n\n',
      );
      response.end();
    },
  );
  await new Promise<void>((ready) =>
    server.listen(0, '127.0.0.1', () => ready()),
  );
  cleanup(t, async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  let settings = defaultSettings();
  settings.initialized = true;
  settings.auth.base_url = `http://127.0.0.1:${address.port}/v1`;
  settings.auth.model = 'gateway';
  settings = trustFolder(settings, workspace);
  saveSettings(settings, home);
  saveCredentials({ api_key: 'test-key' }, home);

  const add = await circle(
    [
      'schedule',
      'add',
      'notes',
      'summarize the day',
      '--daily',
      '09:30',
      '-w',
      workspace,
    ],
    home,
  );
  assert.equal(add.code, 0, add.out + add.err);
  assert.match(add.out, /added · notes · cron 30 9 \* \* \*/);
  assert.match(add.out, /circle schedule start/);

  const listed = await circle(['schedule', 'list'], home);
  assert.match(listed.out, /notes · cron 30 9 \* \* \* · next/);

  const run = await circle(['schedule', 'run', 'notes'], home);
  assert.equal(run.code, 0, run.out + run.err);
  assert.match(run.out, /notes · ok/);
  assert.ok(requests > 0, 'the model was asked');
  const record = getSchedule('notes', home);
  assert.equal(record.last_run?.status, 'ok');
  assert.equal(record.last_run?.kind, 'manual');
  const log = readFileSync(
    join(schedulesRoot(home), 'notes', record.last_run!.log),
    'utf8',
  );
  assert.match(log, /# schedule notes/);
  assert.match(log, /all done/);

  // The background scheduler starts, reports itself, and stops again.
  const start = await circle(['schedule', 'start'], home);
  assert.equal(start.code, 0, start.out + start.err);
  assert.match(start.out, /scheduler started · pid (\d+)/);
  const status = await circle(['schedule', 'status'], home);
  assert.match(status.out, /scheduler · running · pid/);
  const stop = await circle(['schedule', 'stop'], home);
  assert.equal(stop.code, 0, stop.out + stop.err);
  assert.match(stop.out, /scheduler stopped/);
  const after = await circle(['schedule', 'status'], home);
  assert.match(after.out, /scheduler · not running/);

  const remove = await circle(['schedule', 'remove', 'notes'], home);
  assert.equal(remove.code, 0, remove.out + remove.err);
  const help = await circle(['schedule'], home);
  assert.equal(help.code, 0, help.out + help.err);
  assert.match(help.out, /usage: circle schedule/);
});
