// A finished job's notice that waits for the person: after the limit of turns in a row that jobs started (twenty, or
// what `CIRCLE_JOB_WAKES` sets), and after a stop. The notice is the model's to read with the person's next message; what
// the person must not be left with is a conversation that has gone quiet with nothing to say why. The real screen's
// session, runtime, job registry and store, with a scripted model; jobs are watches that end when the test says so.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { SessionApp } from '../src/tui/session_app.js';
import type { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { Watch } from '../src/watch.js';
import { stripAnsi } from '../src/ink/string_width.js';
import { cleanup, scratch } from './helpers.js';

const answer = (content: string) => ({
  message: { id: crypto.randomUUID(), role: 'assistant' as const, content },
});
// Counted by tries, not by the clock: the tests below move the clock by hand
async function eventually(predicate: () => boolean, label: string) {
  for (let tries = 0; tries < 500; tries++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A full-screen session without a terminal: the real runtime and store, a scripted model. */
async function session(t: TestContext, replies: number) {
  const home = scratch(t);
  const workspace = scratch(t);
  const settings = defaultSettings();
  const model = new ScriptedModel(
    Array.from({ length: replies }, (_, i) => answer(`turn ${i + 1}`)),
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
  const key = (name: string) => ui.handle({ type: 'key', key: name, char: '' });
  const screen = (): string => {
    ui.repaint();
    return rendered.map(stripAnsi).join('\n');
  };
  return { app, ui, runtime, model, key, screen };
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
