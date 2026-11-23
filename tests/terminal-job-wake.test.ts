// A finished job's notice that waits for the person: after the limit of turns in a row that jobs started (twenty, or
// what `CIRCLE_JOB_WAKES` sets), and after a stop. The notice is the model's to read with the person's next message; what
// the person must not be left with is a conversation that has gone quiet with nothing to say why. And what holds back the
// turn that a finished job starts: a card, what the person typed and a list they choose from do; a list or a page that
// only shows the jobs does not. The real screen's session, runtime, job registry and store, with a scripted model; jobs
// are watches that end when the test says so.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SessionApp } from '../src/tui/session_app.js';
import type { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { Watch } from '../src/watch.js';
import { stripAnsi } from '../src/ink/string_width.js';
import type { Picker } from '../src/ink/components/picker.js';
import {
  emptyUsage,
  type Message,
  type ModelRequest,
  type ModelResponse,
} from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

const answer = (content: string) => ({
  message: { id: crypto.randomUUID(), role: 'assistant' as const, content },
});
type Reply =
  Partial<ModelResponse> | ((request: ModelRequest) => Promise<ModelResponse>);
// Counted by tries, not by the clock: the tests below move the clock by hand
async function eventually(predicate: () => boolean, label: string) {
  for (let tries = 0; tries < 500; tries++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * A full-screen session without a terminal: the real runtime and store, a scripted model with a number of plain answers
 * or the replies given. `approvals` is the person's own file of rules, for what may run without a card.
 */
async function session(
  t: TestContext,
  replies: number | Reply[],
  options: { approvals?: unknown } = {},
) {
  const home = scratch(t);
  const workspace = scratch(t);
  if (options.approvals !== undefined)
    writeFileSync(
      join(home, 'approvals.json'),
      JSON.stringify(options.approvals),
    );
  const settings = defaultSettings();
  const model = new ScriptedModel(
    typeof replies === 'number'
      ? Array.from({ length: replies }, (_, i) => answer(`turn ${i + 1}`))
      : replies,
  );
  const app = new SessionApp(workspace, home, settings);
  const ui = app as any;
  let rendered: string[] = [];
  ui.screen.render = (rows: string[]) => {
    rendered = rows;
  };
  app.terminal = {
    platform: 'darwin',
    write: () => {},
    input: () => {},
    kill: () => {},
  };
  await app.attach({ workspace, home, settings, model, headless: true });
  const runtime = app.runtime!;
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    ui.interactions.close();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    if (ui.animation) clearInterval(ui.animation);
    ui.input.close();
    await runtime.close();
  });
  const key = (name: string) =>
    ui.handle({
      type: 'key',
      key: name,
      char: Array.from(name).length === 1 ? name : '',
    });
  const type = (text: string) => {
    for (const char of text) key(char);
  };
  const screen = (): string => {
    ui.repaint();
    return rendered.map(stripAnsi).join('\n');
  };
  return { app, ui, runtime, model, workspace, key, type, screen };
}
/** A job the model started, as the conversation sees it, that ends when the returned function is called. */
function startJob(runtime: AgentRuntime, title: string): () => void {
  let ended = false;
  runtime.jobs.startWatch(
    new Watch(title, () => (ended ? 'ok' : null), { interval_s: 0.01 }),
    { sessionId: runtime.session.id, startedBy: 'model' },
  );
  return () => {
    ended = true;
  };
}
/** What the screen's clock does every 160 ms, after the second in which jobs that end together share a turn. */
async function lookAfterTheSecond(
  t: TestContext,
  ui: { jobWake: { check(): void } },
  runtime: AgentRuntime,
) {
  await eventually(
    () => runtime.jobs.hasNotices(runtime.session.id, true),
    'the job to end',
  );
  t.mock.timers.tick(1000);
  ui.jobWake.check();
}

test('after twenty turns in a row that finished jobs started, the twenty-first job to end waits for the next message, the conversation says so once, and the message gives the model the notice', async (t) => {
  const { app, ui, runtime, model, screen } = await session(t, 22);
  await app.submit('start pipeline');
  assert.equal(model.requests.length, 1);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let end = startJob(runtime, 'stage 1');
  // Each job's end starts a turn, in which the model starts the next job: twenty turns in a row
  for (let stage = 1; stage <= 20; stage++) {
    end();
    await lookAfterTheSecond(t, ui, runtime);
    await eventually(
      () => model.requests.length === stage + 1 && !runtime.busy,
      `the turn of job ${stage}`,
    );
    end = startJob(runtime, `stage ${stage + 1}`);
  }
  assert.equal(model.requests.length, 21);
  assert.deepEqual(
    app.state.notices.filter((note) => /waits for your message/.test(note)),
    [],
    'twenty turns started, nothing is held',
  );

  end();
  await lookAfterTheSecond(t, ui, runtime);
  assert.equal(runtime.busy, false);
  assert.equal(
    model.requests.length,
    21,
    'no turn starts for the twenty-first',
  );
  assert.equal(runtime.jobs.hasNotices(runtime.session.id, true), true);
  const held = () =>
    app.state.notices.filter((note) => note.startsWith('j21 '));
  assert.equal(held().length, 1);
  assert.match(
    held()[0]!,
    /^j21 done · stage 21 · \S+ · waits for your message after 20 turns in a row started by jobs$/,
  );
  assert.match(screen(), /j21 done · stage 21 · .*waits for your message/);
  // The clock looks again and again; the line is said once
  for (let looks = 0; looks < 5; looks++) {
    t.mock.timers.tick(160);
    ui.jobWake.check();
  }
  assert.equal(held().length, 1);
  assert.equal(model.requests.length, 21);

  // The person writes: the notice is read with the message, and turns may start by themselves again
  await app.submit('go on');
  const last = model.requests.at(-1)!;
  assert.ok(
    last.messages.some(
      (message) =>
        message.internal === 'job_notice' && /stage 21/.test(message.content),
    ),
    'the model reads the notice with the message',
  );
  assert.equal(runtime.jobs.hasNotices(runtime.session.id, true), false);
});

test('with a limit of one, the line counts one turn', async (t) => {
  const before = process.env.CIRCLE_JOB_WAKES;
  process.env.CIRCLE_JOB_WAKES = '1';
  t.after(() => {
    if (before === undefined) delete process.env.CIRCLE_JOB_WAKES;
    else process.env.CIRCLE_JOB_WAKES = before;
  });
  const { app, ui, runtime, model } = await session(t, 3);
  await app.submit('start pipeline');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let end = startJob(runtime, 'stage 1');
  end();
  await lookAfterTheSecond(t, ui, runtime);
  await eventually(
    () => model.requests.length === 2 && !runtime.busy,
    'the turn of job 1',
  );
  end = startJob(runtime, 'stage 2');
  end();
  await lookAfterTheSecond(t, ui, runtime);
  assert.equal(model.requests.length, 2, 'no turn starts for the second');
  const held = app.state.notices.filter((note) => note.startsWith('j2 '));
  assert.equal(held.length, 1);
  assert.match(
    held[0]!,
    /^j2 done · stage 2 · \S+ · waits for your message after 1 turn started by jobs$/,
  );
});

test('a job that ends after a stop waits for the next message, and the conversation says so without a number', async (t) => {
  const { app, ui, runtime, model, key } = await session(t, 3);
  await app.submit('start pipeline');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const end = startJob(runtime, 'build');
  // esc with nothing to stop and nothing typed
  key('escape');
  end();
  await lookAfterTheSecond(t, ui, runtime);
  assert.equal(runtime.busy, false);
  assert.equal(model.requests.length, 1, 'no turn starts for it');
  const lines = app.state.notices.filter((note) => note.startsWith('j1 '));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^j1 done · build · \S+ · waits for your message$/);
  await app.submit('go on');
  assert.ok(
    model.requests
      .at(-1)!
      .messages.some(
        (message) =>
          message.internal === 'job_notice' && /build/.test(message.content),
      ),
  );
});

test('a job that the person stopped is no news: its notice never starts a turn and nothing is said of it', async (t) => {
  const { app, ui, runtime, model } = await session(t, 2);
  await app.submit('start pipeline');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  ui.jobWake.snooze();
  startJob(runtime, 'dev server');
  await runtime.jobs.stop(runtime.jobs.list()[0]!.id, 'user');
  t.mock.timers.tick(1000);
  ui.jobWake.check();
  assert.equal(runtime.jobs.hasNotices(runtime.session.id, true), false);
  assert.deepEqual(app.state.notices, []);
  assert.equal(model.requests.length, 1);
});

// What holds back the turn that a finished job starts: the terminal's occupied() answers for its screen. A list that
// follows the jobs (/jobs, /workflows, one run, one phase) and a job's page only show them; a list the person chooses
// from, a question a list asks, a card and a draft hold the turn back until they are over.

/** Whether a request to the model carries a finished job's notice, as the conversation reads it. */
const readsNotice = (request: { messages: Message[] }, text: RegExp): boolean =>
  request.messages.some(
    (message) =>
      message.internal === 'job_notice' && text.test(message.content),
  );
/** Whether a request is a workflow agent's: its task is the message it was given. */
const askedFor = (request: { messages: Message[] }, task: string): boolean =>
  request.messages.some(
    (message) => message.role === 'user' && message.content === task,
  );
/** A reply that waits for the test: the turn it answers runs until `release` is called, or is stopped. */
function held(text: string) {
  let release: (() => void) | undefined;
  return {
    reply: (request: ModelRequest): Promise<ModelResponse> =>
      new Promise((resolve, reject) => {
        release = () => resolve({ ...answer(text), usage: emptyUsage() });
        request.signal.addEventListener(
          'abort',
          () => reject(new Error('stopped')),
          { once: true },
        );
      }),
    release: () => {
      if (!release) throw new Error('the model has not been asked yet');
      release();
    },
  };
}
type Session = Awaited<ReturnType<typeof session>>;

for (const [command, title] of [
  ['/jobs', 'Background jobs'],
  ['/workflows', 'Workflows'],
] as const)
  test(`with ${command} open, the job that ends starts the turn, the next model request carries its notice, and the list stays open`, async (t) => {
    const { app, ui, runtime, model, key, screen } = await session(t, 2);
    await app.submit('start the build');
    const end = startJob(runtime, 'build');
    await app.submit(command);
    const list = app.state.picker!;
    assert.equal(list.title, title);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    end();
    await lookAfterTheSecond(t, ui, runtime);
    await eventually(
      () => model.requests.length === 2 && !runtime.busy,
      'the turn of the job',
    );
    assert.ok(readsNotice(model.requests[1]!, /build/));
    assert.equal(
      model.requests[1]!.messages.at(-1)?.internal,
      'job_notice',
      'the turn opens with the notice, not with a message of the person',
    );
    assert.equal(app.state.picker, list, 'the list is still open');
    assert.deepEqual(
      app.state.notices.filter((note) => /waits for your message/.test(note)),
      [],
      'a turn started, so nothing waits',
    );
    // Closed, the conversation shows the turn that went on
    key('escape');
    assert.match(screen(), /◆ j1 done · build/);
  });

test('with the page of a job open, the job that ends starts the turn, the next model request carries its notice, and the page stays', async (t) => {
  const { app, ui, runtime, model, key, screen } = await session(t, 2);
  await app.submit('start the build');
  const end = startJob(runtime, 'build');
  await app.submit('/jobs');
  key('enter');
  await eventually(() => app.state.jobDetail?.id === 'j1', 'the job page');
  assert.equal(app.state.picker, undefined, 'a page, not a list');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  end();
  await lookAfterTheSecond(t, ui, runtime);
  await eventually(
    () => model.requests.length === 2 && !runtime.busy,
    'the turn of the job',
  );
  assert.ok(readsNotice(model.requests[1]!, /build/));
  assert.equal(app.state.jobDetail?.id, 'j1', 'the page is still open');
  assert.match(screen(), /j1 build\s+done/);
});

// A workflow whose model started it in the first turn and went quiet, as the model is told to when it waits for the
// notice. Its one agent ends when `finishAgent` is called; the turn that the notice starts runs until `woken.release`.
async function workflowSession(t: TestContext) {
  const script = `export const meta = { name: 'pair', description: 'One agent', phases: [{ title: 'Work' }] }
phase('Work')
return await agent('the task', { label: 'worker' })
`;
  let finishAgent!: () => void;
  const agentMayEnd = new Promise<void>((resolve) => {
    finishAgent = resolve;
  });
  const woken = held('went on');
  let conversation = 0;
  const route = (request: ModelRequest): Promise<ModelResponse> => {
    if (askedFor(request, 'the task'))
      return new Promise((resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => reject(new Error('stopped')),
          { once: true },
        );
        void agentMayEnd.then(() =>
          resolve({ ...answer('task done'), usage: emptyUsage() }),
        );
      });
    conversation++;
    if (conversation === 3) return woken.reply(request);
    return Promise.resolve(
      conversation === 1
        ? {
            message: {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'wf', name: 'workflow', args: { script } }],
            },
            usage: emptyUsage(),
          }
        : { ...answer('it runs'), usage: emptyUsage() },
    );
  };
  const s = await session(
    t,
    Array.from({ length: 6 }, () => route),
    {
      approvals: {
        rules: [{ tool: 'workflow', pattern: '*', effect: 'allow' }],
      },
    },
  );
  await s.app.submit('go');
  await eventually(
    () => !s.runtime.busy && s.runtime.workflowRunViews().length === 1,
    'the workflow to run',
  );
  await eventually(
    () => s.runtime.workflowRunViews()[0]?.agents[0]?.state === 'running',
    'its agent to start',
  );
  return { ...s, finishAgent, woken, conversations: () => conversation };
}
/** The workflow ends under the list that shows it: the turn its notice starts runs under the list, which keeps its keys. */
async function endsUnderTheList(
  t: TestContext,
  s: Awaited<ReturnType<typeof workflowSession>>,
  list: Picker,
) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  s.finishAgent();
  await lookAfterTheSecond(t, s.ui, s.runtime);
  await eventually(
    () => s.conversations() === 3,
    'the turn that the end of the workflow starts',
  );
  assert.equal(s.runtime.busy, true);
  const request = s.model.requests
    .filter((one) => !askedFor(one, 'the task'))
    .at(-1)!;
  assert.ok(
    readsNotice(request, /workflow pair/),
    'the next request carries the notice',
  );
  assert.equal(request.messages.at(-1)?.internal, 'job_notice');
  assert.equal(s.app.state.picker, list, 'the list stays open');
  // Under the running turn every key still goes to the list: typed, it is the search
  s.type('w');
  assert.equal(list.query, 'w');
  s.key('escape');
  assert.equal(list.query, '');
  assert.equal(s.app.state.picker, list);
  s.woken.release();
  await eventually(() => !s.runtime.busy, 'the turn to end');
  assert.equal(s.app.state.picker, list);
  assert.ok(
    list.items.every((item) => !/running/.test(item.meta ?? '')),
    'the list took the end of the workflow',
  );
}

test('with the run of a workflow open in /workflows, its end starts the turn, the next model request carries its notice, and the list keeps its keys under the turn', async (t) => {
  const s = await workflowSession(t);
  await s.app.submit('/workflows');
  const list = s.app.state.picker!;
  assert.equal(list.title, 'pair · One agent');
  assert.deepEqual(
    list.items.map((item) => item.key),
    ['run', 'phase:Work', 'agent:0'],
  );
  await endsUnderTheList(t, s, list);
});

test('with one phase of a workflow open in /workflows, its end starts the turn as well', async (t) => {
  const s = await workflowSession(t);
  await s.app.submit('/workflows');
  s.app.state.picker!.focus = 1;
  s.key('enter');
  await eventually(
    () => s.app.state.picker?.title === 'pair · Work',
    'the phase on its own',
  );
  const list = s.app.state.picker!;
  assert.deepEqual(
    list.items.map((item) => item.key),
    ['agent:0'],
  );
  await endsUnderTheList(t, s, list);
});

/** A job ends under the list `open` opens: no turn starts while it is open, and its notice starts one once it is closed. */
async function waitsForTheListToClose(
  t: TestContext,
  title: string,
  open: (s: Session) => unknown,
) {
  const s = await session(t, 2);
  const { app, ui, runtime, model, key } = s;
  await app.submit('start the build');
  const end = startJob(runtime, 'build');
  await open(s);
  await eventually(
    () => app.state.picker?.title === title,
    `the ${title} list`,
  );
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  end();
  await lookAfterTheSecond(t, ui, runtime);
  for (let looks = 0; looks < 3; looks++) {
    t.mock.timers.tick(160);
    ui.jobWake.check();
  }
  assert.equal(runtime.busy, false);
  assert.equal(model.requests.length, 1, 'no turn starts under the list');
  assert.equal(
    runtime.jobs.hasNotices(runtime.session.id, true),
    true,
    'the notice waits',
  );
  key('escape');
  assert.equal(app.state.picker, undefined);
  t.mock.timers.tick(160);
  ui.jobWake.check();
  await eventually(
    () => model.requests.length === 2 && !runtime.busy,
    'the turn of the job',
  );
  assert.ok(readsNotice(model.requests[1]!, /build/));
}

test('with the model list open, the job that ends starts no turn until the list is closed, and then its notice starts one', async (t) => {
  await waitsForTheListToClose(t, 'Model', ({ ui, key }) => {
    ui.loadModels = async () => ({
      protocol: 'openai',
      models: ['scripted', 'other'],
      inferred: false,
      base_url: '',
      status: 'discovered',
      detail: '',
    });
    key('alt+l');
  });
});

test('a list that follows the jobs, closed for another list before the screen looked again, does not make that one a list that only shows the jobs', async (t) => {
  const { app, ui, runtime, model, key } = await session(t, 2);
  await app.submit('start the build');
  const end = startJob(runtime, 'build');
  await app.submit('/jobs');
  const followed = app.state.picker;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  end();
  await eventually(
    () => runtime.jobs.hasNotices(runtime.session.id, true),
    'the job to end',
  );
  key('escape');
  ui.picker('Pick one', [{ key: 'a', label: 'a' }], () => {});
  assert.equal(
    ui.jobsList.list,
    followed,
    'the screen still remembers the list it followed, which is not the open one',
  );
  t.mock.timers.tick(1000);
  ui.jobWake.check();
  assert.equal(runtime.busy, false);
  assert.equal(model.requests.length, 1, 'no turn starts under the new list');
  key('escape');
  t.mock.timers.tick(160);
  ui.jobWake.check();
  await eventually(
    () => model.requests.length === 2 && !runtime.busy,
    'the turn of the job',
  );
  assert.ok(readsNotice(model.requests[1]!, /build/));
});

for (const [command, title] of [
  ['/terminals', 'Device terminals'],
  ['/resume', 'Sessions · this folder'],
  ['/settings', 'Settings'],
] as const)
  test(`with ${command} open, the job that ends starts no turn until the list is closed`, async (t) => {
    await waitsForTheListToClose(t, title, ({ app }) => app.submit(command));
  });

test('with /tree open, the job that ends starts no turn, and none after the list is closed: opening it already made finished jobs wait for the next message', async (t) => {
  const { app, ui, runtime, model, key } = await session(t, 3);
  await app.submit('start the build');
  const end = startJob(runtime, 'build');
  await app.submit('/tree');
  assert.equal(app.state.picker?.title, 'Session tree');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  end();
  await lookAfterTheSecond(t, ui, runtime);
  assert.equal(model.requests.length, 1);
  assert.deepEqual(
    app.state.notices.filter((note) => note.startsWith('j1 ')),
    [],
    'nothing is said while the list is open',
  );
  key('escape');
  assert.equal(app.state.picker, undefined);
  t.mock.timers.tick(160);
  ui.jobWake.check();
  assert.equal(runtime.busy, false);
  assert.equal(model.requests.length, 1, 'no turn starts when it is closed');
  const lines = app.state.notices.filter((note) => note.startsWith('j1 '));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^j1 done · build · \S+ · waits for your message$/);
  await app.submit('go on');
  assert.ok(readsNotice(model.requests.at(-1)!, /build/));
});

test('a list that follows the jobs holds the turn back while it asks whether to stop a job, and lets it start when the question is answered', async (t) => {
  const { app, ui, runtime, model, key } = await session(t, 2);
  await app.submit('start the build');
  const endBuild = startJob(runtime, 'build');
  startJob(runtime, 'server');
  await app.submit('/jobs');
  const list = app.state.picker!;
  list.focus = list.items.findIndex((item) => /server/.test(item.label));
  key('ctrl+k');
  await eventually(() => list.asking, 'the list to ask whether to stop it');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  endBuild();
  await lookAfterTheSecond(t, ui, runtime);
  assert.equal(runtime.busy, false);
  assert.equal(model.requests.length, 1, 'no turn starts under the question');
  // esc keeps the server running; the list is open still, and only shows the jobs again
  key('escape');
  assert.ok(!list.asking);
  assert.equal(app.state.picker, list);
  t.mock.timers.tick(160);
  ui.jobWake.check();
  await eventually(
    () => model.requests.length === 2 && !runtime.busy,
    'the turn of the job',
  );
  assert.ok(readsNotice(model.requests[1]!, /build/));
  assert.equal(runtime.jobs.get('j2')?.status, 'running');
});

test('what the person typed holds the turn back until the box is empty, and then the notice starts it', async (t) => {
  const { app, ui, runtime, model, key, type } = await session(t, 2);
  await app.submit('start the build');
  const end = startJob(runtime, 'build');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  type('wait');
  assert.equal(app.state.draft, 'wait');
  end();
  await lookAfterTheSecond(t, ui, runtime);
  for (let looks = 0; looks < 3; looks++) {
    t.mock.timers.tick(160);
    ui.jobWake.check();
  }
  assert.equal(runtime.busy, false);
  assert.equal(model.requests.length, 1, 'no turn starts under a draft');
  assert.equal(runtime.jobs.hasNotices(runtime.session.id, true), true);
  for (let letters = 0; letters < 4; letters++) key('backspace');
  assert.equal(app.state.draft, '');
  t.mock.timers.tick(160);
  ui.jobWake.check();
  await eventually(
    () => model.requests.length === 2 && !runtime.busy,
    'the turn of the job',
  );
  assert.ok(readsNotice(model.requests[1]!, /build/));
});

test('a card that the turn a job started asks is not hidden by the list under it: it takes the keys, and the list comes back when it is answered', async (t) => {
  const write = {
    message: {
      id: crypto.randomUUID(),
      role: 'assistant' as const,
      content: '',
      tool_calls: [
        {
          id: 'w1',
          name: 'write_file',
          args: { file_path: 'made.txt', content: 'by the woken turn\n' },
        },
      ],
    },
  };
  const { app, ui, runtime, model, workspace, key, type, screen } =
    await session(t, [answer('turn 1'), write, answer('turn 3')]);
  await app.submit('start the build');
  const end = startJob(runtime, 'build');
  await app.submit('/jobs');
  const list = app.state.picker!;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  end();
  await lookAfterTheSecond(t, ui, runtime);
  await eventually(() => Boolean(app.state.dialog), 'the card');
  assert.equal(app.state.picker, undefined, 'the list is put aside');
  assert.match(screen(), /needs your permission/);
  // A key goes to the card: it moves the card's focus, and a letter is swallowed instead of searching the list
  key('down');
  assert.equal(app.state.dialog!.focus, 1);
  type('x');
  assert.equal(list.query, '');
  assert.ok(app.state.dialog, 'a letter does not answer the card');
  key('1');
  await eventually(
    () => model.requests.length === 3 && !runtime.busy,
    'the turn to end',
  );
  assert.equal(app.state.picker, list, 'the list is back');
  assert.equal(app.state.dialog, undefined);
  assert.equal(
    readFileSync(join(workspace, 'made.txt'), 'utf8'),
    'by the woken turn\n',
    'the file the card allowed was written',
  );
  assert.ok(
    model.requests[2]!.messages.some(
      (message) => message.role === 'tool' && message.tool_call_id === 'w1',
    ),
    'the model read what the call gave',
  );
});

test('the line that says a notice waits for the next message is said under a list that only shows the jobs', async (t) => {
  const { app, ui, runtime, model } = await session(t, 1);
  await app.submit('start the build');
  const end = startJob(runtime, 'build');
  await app.submit('/jobs');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  // A stop: finished jobs wait for the next message
  ui.jobWake.snooze();
  end();
  await lookAfterTheSecond(t, ui, runtime);
  assert.equal(model.requests.length, 1);
  const lines = app.state.notices.filter((note) => note.startsWith('j1 '));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^j1 done · build · \S+ · waits for your message$/);
});
