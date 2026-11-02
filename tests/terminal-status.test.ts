import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { SessionApp } from '../src/tui/session_app.js';
import {
  BELL_AFTER_MS,
  OTTY_REPEAT_MS,
  PROGRESS,
  TerminalStatus,
} from '../src/tui/terminal_status.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import {
  emptyUsage,
  type ModelCompletion,
  type ModelRequest,
  type ModelResponse,
} from '../src/types.js';
import { cleanup, scratch, until } from './helpers.js';

// `otty` ends at once unless `held`: then each run ends when `end()` is called.
function recorded(
  env: NodeJS.ProcessEnv = {},
  otty: 'ends' | 'missing' | 'held' = 'ends',
) {
  const out: string[] = [];
  const runs: string[][] = [];
  const running: ((started: boolean) => void)[] = [];
  const status = new TerminalStatus({
    write: (text) => out.push(text),
    run: (command, args, done) => {
      runs.push([command, ...args]);
      if (otty === 'held') running.push(done);
      else done(otty === 'ends');
    },
    env,
    pid: 4242,
  });
  const bells = (): number => out.filter((text) => text === '\x07').length;
  const end = (): void => running.shift()!(true);
  return { status, out, runs, bells, end };
}

test('a change of state goes out once as OSC 9;4, and the same state again sends nothing', () => {
  const { status, out } = recorded();
  status.report('working', 's1');
  status.report('working', 's1');
  status.report('waiting', 's1');
  status.report('failed', 's1');
  status.report('idle', 's1');
  assert.deepEqual(out, [
    PROGRESS.working,
    PROGRESS.waiting,
    PROGRESS.failed,
    PROGRESS.idle,
  ]);
});

test('a card that waits 10 seconds rings the bell once, and one answered sooner does not', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { status, bells } = recorded();
  status.report('waiting', 's1');
  t.mock.timers.tick(BELL_AFTER_MS - 1);
  assert.equal(bells(), 0);
  t.mock.timers.tick(1);
  assert.equal(bells(), 1);
  t.mock.timers.tick(BELL_AFTER_MS * 3);
  assert.equal(bells(), 1);
  status.report('working', 's1');
  status.report('waiting', 's1');
  t.mock.timers.tick(BELL_AFTER_MS / 2);
  status.report('working', 's1');
  t.mock.timers.tick(BELL_AFTER_MS * 2);
  assert.equal(bells(), 1);
});

test('in an Otty pane the state goes to otty as an agent, again a while after the first report, with no bell', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { status, out, runs } = recorded({ OTTY_PANE_ID: 'p_test' });
  status.report('working', 's1');
  assert.deepEqual(runs, [
    [
      'otty',
      'state:circle',
      'state=processing',
      'agent-pid=4242',
      'session-id=s1',
      'label=Circle',
    ],
  ]);
  status.report('waiting', 's1');
  // Otty drops what comes before it has matched the process to its pane
  t.mock.timers.tick(OTTY_REPEAT_MS.at(-1)! + BELL_AFTER_MS);
  assert.deepEqual(
    runs.map((run) => run[2]),
    ['state=processing', 'state=awaiting', 'state=awaiting', 'state=awaiting'],
  );
  status.report('waiting', 's2');
  assert.equal(runs.at(-1)!.at(-2), 'session-id=s2');
  status.close();
  assert.equal(runs.at(-1)![2], 'state=idle');
  assert.deepEqual(out, []);
});

test('when otty cannot be started, the state goes out as OSC 9;4 from then on', () => {
  const { status, out, runs } = recorded({ OTTY_PANE_ID: 'p_test' }, 'missing');
  status.report('working', 's1');
  status.report('idle', 's1');
  assert.equal(runs.length, 1);
  assert.deepEqual(out, [PROGRESS.working, PROGRESS.idle]);
});

test('one otty runs at a time, so reports reach Otty in order, and what changed meanwhile goes after it, the newest only', () => {
  const { status, runs, end } = recorded({ OTTY_PANE_ID: 'p_test' }, 'held');
  status.report('working', 's1');
  status.report('waiting', 's1');
  status.report('idle', 's1');
  assert.deepEqual(
    runs.map((run) => run[2]),
    ['state=processing'],
  );
  end();
  assert.deepEqual(
    runs.map((run) => run[2]),
    ['state=processing', 'state=idle'],
  );
  end();
  status.close();
  assert.equal(runs.length, 3);
  status.report('working', 's1');
  end();
  assert.equal(runs.length, 3);
});

test('a lent screen takes the progress back and gets it again, and nothing is reported after close', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { status, out, bells } = recorded();
  status.pause();
  status.resume();
  assert.deepEqual(out, []);
  status.report('waiting', 's1');
  status.pause();
  t.mock.timers.tick(BELL_AFTER_MS * 2);
  status.report('working', 's1');
  status.resume();
  status.close();
  status.report('failed', 's1');
  assert.deepEqual(out, [
    PROGRESS.waiting,
    PROGRESS.idle,
    PROGRESS.working,
    PROGRESS.idle,
  ]);
  assert.equal(bells(), 0);
});

type Reply =
  Partial<ModelResponse> | ((request: ModelRequest) => Promise<ModelResponse>);
const answer = (content: string): Partial<ModelResponse> => ({
  message: { id: crypto.randomUUID(), role: 'assistant', content },
  usage: emptyUsage(),
});

// A full-screen session without a terminal: the real runtime, store and key handling, with
// ScriptedModel for the endpoint and what is written to the terminal recorded. `started` is
// set as start() sets it once the screen is the terminal's; tests do not run start().
async function session(
  t: TestContext,
  replies: Reply[],
  env: Record<string, string | undefined> = { OTTY_PANE_ID: undefined },
) {
  const saved = Object.fromEntries(
    Object.keys(env).map((name) => [name, process.env[name]]),
  );
  const put = (values: Record<string, string | undefined>): void => {
    for (const [name, value] of Object.entries(values))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  };
  put(env);
  const home = scratch(t);
  const workspace = scratch(t);
  const settings = defaultSettings();
  const app = new SessionApp(workspace, home, settings);
  const ui = app as any;
  ui.screen.render = () => {};
  const writes: string[] = [];
  app.terminal = {
    platform: 'darwin',
    write: (text) => {
      writes.push(text);
    },
    input: () => {},
    kill: () => {},
  };
  await app.attach({
    workspace,
    home,
    settings,
    model: new ScriptedModel(replies),
    headless: true,
  });
  ui.started = true;
  const runtime = app.runtime!;
  cleanup(t, async () => {
    ui.terminalStatus.close();
    put(saved);
    ui.off?.();
    ui.offSignals?.();
    ui.interactions.close();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    if (ui.animation) clearInterval(ui.animation);
    ui.input.close();
    await runtime.close();
  });
  const key = (
    name: string,
    char = Array.from(name).length === 1 ? name : '',
  ) => ui.handle({ type: 'key', key: name, char });
  // The progress reports written so far, in order
  const progress = (): string[] => {
    ui.repaint();
    return writes.filter((text) => text.startsWith('\x1b]9;4;'));
  };
  return { app, ui, runtime, workspace, writes, key, progress };
}

test('a turn shows as working while it runs and is cleared when it ends', async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const s = await session(t, [
    async () => {
      await held;
      return answer('done') as ModelResponse;
    },
  ]);
  const run = s.runtime.harness.run('go');
  await until(() => s.progress().includes(PROGRESS.working));
  assert.equal(s.progress().at(-1), PROGRESS.working);
  release();
  await run;
  await until(() => s.progress().at(-1) === PROGRESS.idle);
  const reports = s.progress();
  assert.deepEqual(reports.slice(reports.indexOf(PROGRESS.working)), [
    PROGRESS.working,
    PROGRESS.idle,
  ]);
});

test('an approval card shows as waiting until it is answered', async (t) => {
  const s = await session(t, [
    {
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'w1',
            name: 'write_file',
            args: { file_path: 'note.txt', content: 'hello' },
          },
        ],
      },
      usage: emptyUsage(),
    },
    answer('written'),
  ]);
  const run = s.runtime.harness.run('write it');
  await until(() => Boolean(s.app.state.dialog));
  assert.equal(s.progress().at(-1), PROGRESS.waiting);
  s.key('y');
  assert.equal((await run).answer, 'written');
  assert.equal(readFileSync(join(s.workspace, 'note.txt'), 'utf8'), 'hello');
  await until(() => s.progress().at(-1) === PROGRESS.idle);
  const reports = s.progress();
  assert.ok(
    reports.indexOf(PROGRESS.working, reports.indexOf(PROGRESS.waiting)) > 0,
    'working again once the card is answered',
  );
});

test('a turn that fails shows as failed until the next turn, and a stop is not a failure', async (t) => {
  const cut: ModelCompletion = {
    reason: 'length',
    provider_reason: 'length',
    output_limit: 32000,
  };
  const s = await session(t, [
    {
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'partial',
        completion: cut,
      },
      usage: emptyUsage(),
    },
    answer('fine'),
    (request) =>
      new Promise<ModelResponse>((_, reject) => {
        request.signal?.addEventListener('abort', () =>
          reject(request.signal!.reason),
        );
      }),
  ]);
  await assert.rejects(s.runtime.harness.run('go'));
  await until(() => s.progress().at(-1) === PROGRESS.failed);
  await s.runtime.harness.run('again');
  await until(() => s.progress().at(-1) === PROGRESS.idle);
  const stopped = s.runtime.harness.run('hold');
  await until(() => s.progress().at(-1) === PROGRESS.working);
  await s.runtime.cancel();
  await stopped.catch(() => undefined);
  await until(() => s.progress().at(-1) === PROGRESS.idle);
  assert.equal(
    s.progress().filter((text) => text === PROGRESS.failed).length,
    1,
  );
});

test(
  'in an Otty pane the turn reaches otty as an agent state, not as OSC 9;4',
  {
    skip: process.platform === 'win32' && 'the stand-in otty is a shell script',
  },
  async (t) => {
    const bin = scratch(t);
    const calls = join(bin, 'calls.txt');
    writeFileSync(
      join(bin, 'otty'),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$OTTY_STANDIN_CALLS"\n',
    );
    chmodSync(join(bin, 'otty'), 0o755);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const s = await session(
      t,
      [
        async () => {
          await held;
          return answer('done') as ModelResponse;
        },
      ],
      {
        OTTY_PANE_ID: 'p_test',
        OTTY_STANDIN_CALLS: calls,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      },
    );
    const lines = (): string[] =>
      existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
    const states = (): string[] => lines().map((line) => line.split(' ')[1]!);
    const run = s.runtime.harness.run('go');
    const id = s.runtime.session.id;
    await until(() => {
      s.ui.repaint();
      return states().includes('state=processing');
    });
    assert.ok(
      lines().includes(
        `state:circle state=processing agent-pid=${process.pid} session-id=${id} label=Circle`,
      ),
      lines().join('\n'),
    );
    release();
    await run;
    await until(() => {
      s.ui.repaint();
      return states().at(-1) === 'state=idle';
    });
    assert.deepEqual(
      s.writes.filter((text) => text.startsWith('\x1b]9;4;')),
      [],
    );
  },
);
