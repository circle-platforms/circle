import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRpc } from '../src/rpc.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { Watch } from '../src/watch.js';
import { defaultSettings, saveCredentials } from '../src/settings.js';
import {
  scratch,
  cleanup,
  processGone,
  until,
  writtenPids,
} from './helpers.js';
import type { Message, ModelResponse } from '../src/types.js';
import { rpcMessage } from '../src/rpc_codec.js';
const answer = (content: string): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  content,
});
const waitFor = (predicate: () => boolean) =>
  until(predicate, { timeout: 3000, label: 'the expected RPC state' });
test('RPC reports queue, busy guards, persisted usage, model changes and exported HTML through the real runtime', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  saveCredentials({ api_key: 'fake' }, home);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new ScriptedModel([
    async (request) => {
      await new Promise<void>((resolve, reject) => {
        gate.then(resolve);
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        );
      });
      return {
        message: answer('first answer'),
        usage: { input_tokens: 12, output_tokens: 7, cache_read_tokens: 3 },
      };
    },
  ]);
  const settings = defaultSettings();
  settings.auth.base_url = 'http://127.0.0.1:1/v1';
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings,
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const input = new PassThrough();
  cleanup(t, () => {
    input.destroy();
  });
  const output: Record<string, unknown>[] = [];
  const runner = runRpc(runtime, {
    input,
    write: (text) => {
      output.push(JSON.parse(text));
    },
  });
  const send = (value: unknown): void => {
    input.write(JSON.stringify(value) + '\n');
  };
  const response = (id: string): Record<string, unknown> | undefined =>
    output.find((record) => record.id === id);
  send({ id: 'start', type: 'prompt', message: 'start' });
  await waitFor(() => model.requests.length === 1);
  send({ id: 'steer', type: 'steer', message: 'steer' });
  send({ id: 'follow', type: 'follow_up', message: 'follow' });
  send({ id: 'state', type: 'get_state' });
  send({ id: 'busy', type: 'set_model', modelId: 'new-model' });
  send({ id: 'clear', type: 'clear_queue' });
  await waitFor(() => Boolean(response('clear')));
  assert.equal(
    (response('state')!.data as { pendingMessageCount: number })
      .pendingMessageCount,
    2,
  );
  assert.equal(response('busy')!.success, false);
  assert.deepEqual(response('clear')!.data, {
    steering: ['steer'],
    followUp: ['follow'],
  });
  release();
  await waitFor(() => output.some((record) => record.type === 'agent_settled'));
  send({ id: 'stats', type: 'get_session_stats' });
  send({ id: 'export', type: 'export_html', outputPath: 'conversation.html' });
  send({ id: 'set', type: 'set_model', modelId: 'new-model' });
  send({ id: 'thinking', type: 'set_thinking_level', level: 'high' });
  send({ id: 'again', type: 'set_model', modelId: 'new-model' });
  send({ id: 'messages', type: 'get_messages' });
  send({ id: 'final', type: 'get_state' });
  await waitFor(() => Boolean(response('final')));
  const stats = response('stats')!.data as {
    tokens: Record<string, number>;
    userMessages: number;
    assistantMessages: number;
  };
  assert.deepEqual(stats.tokens, { input: 12, output: 7, total: 19 });
  assert.equal(stats.userMessages, 1);
  assert.equal(stats.assistantMessages, 1);
  assert.equal(runtime.stats().usage.cache_read_tokens, 3);
  assert.deepEqual(response('thinking')!.data, { thinkingLevel: 'high' });
  const wire = (
    response('messages')!.data as {
      messages: { type: string; data: { content: string } }[];
    }
  ).messages;
  assert.deepEqual(
    wire.map((message) => message.type),
    ['human', 'ai'],
  );
  assert.equal(wire[1]!.data.content, 'first answer');
  assert.ok(existsSync(join(workspace, 'conversation.html')));
  assert.match(
    readFileSync(join(workspace, 'conversation.html'), 'utf8'),
    /first answer/,
  );
  assert.equal(
    (response('final')!.data as { model: string; thinkingLevel: string }).model,
    'new-model',
  );
  assert.equal(
    (response('final')!.data as { thinkingLevel: string }).thinkingLevel,
    'high',
  );
  const id = runtime.session.id;
  input.end();
  assert.equal(await runner, 0);
  await runtime.close();
  const reopened = new AgentRuntime({
    home,
    workspace,
    settings,
    model: new ScriptedModel(),
    session: id,
    headless: true,
  });
  cleanup(t, () => reopened.close());
  assert.deepEqual(reopened.stats().usage, {
    input_tokens: 12,
    output_tokens: 7,
    cache_read_tokens: 3,
  });
});

test('RPC message DTOs match frozen serialization samples without loading a framework', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/rpc-messages.json', import.meta.url),
      'utf8',
    ),
  ) as { cases: { native: Message; expected: unknown }[] };
  for (const item of fixture.cases)
    assert.deepEqual(rpcMessage(item.native), item.expected);
});

test('RPC finishes when its input was already destroyed', async (t) => {
  const root = scratch(t);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model: new ScriptedModel(),
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const input = new PassThrough();
  const closed = once(input, 'close');
  input.destroy();
  await closed;
  const output: any[] = [];
  assert.equal(
    await runRpc(runtime, {
      input,
      write: (text) => output.push(JSON.parse(text)),
    }),
    0,
  );
  assert.deepEqual(output.at(-1), { type: 'jobs_stopped', count: 0 });
  assert.equal(input.listenerCount('close'), 0);
});

test('destroying RPC input lets an active scripted turn finish and saves its result', async (t) => {
  const root = scratch(t);
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new ScriptedModel([
    async () => {
      enter();
      await released;
      return {
        message: answer('stored after disconnect'),
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 },
      };
    },
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const input = new PassThrough();
  const output: any[] = [];
  const runner = runRpc(runtime, {
    input,
    write: (text) => output.push(JSON.parse(text)),
  });
  input.write(
    JSON.stringify({ type: 'prompt', message: 'finish this turn' }) + '\n',
  );
  await entered;
  const closed = once(input, 'close');
  input.destroy();
  await closed;
  release();
  assert.equal(await runner, 0);
  assert.equal(model.requests.length, 1);
  assert.equal(
    runtime.store.messages(runtime.session.id).at(-1)!.content,
    'stored after disconnect',
  );
  assert.ok(output.some((record) => record.type === 'agent_settled'));
  assert.deepEqual(output.at(-1), { type: 'jobs_stopped', count: 0 });
  assert.equal(input.listenerCount('close'), 0);
});

test('RPC list_jobs and jobId stop the real process before reporting the settled job', async (t) => {
  const root = scratch(t);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model: new ScriptedModel(),
    headless: true,
  });
  cleanup(t, () => runtime.close());
  writeFileSync(
    join(root, 'job.cjs'),
    "require('node:fs').writeFileSync('ready', process.pid + '\\n'); setTimeout(() => require('node:fs').writeFileSync('late', 'bad'), 2000); setTimeout(() => {}, 60000);",
  );
  const input = new PassThrough();
  const output: any[] = [];
  const runner = runRpc(runtime, {
    input,
    write: (text) => output.push(JSON.parse(text)),
  });
  cleanup(t, async () => {
    input.destroy();
    await runtime.cancel();
    await runner;
  });
  const job = await runtime.jobs.startShell(
    `"${process.execPath}" "${join(root, 'job.cjs')}"`,
    { sessionId: runtime.session.id, startedBy: 'user' },
  );
  await waitFor(() => writtenPids(join(root, 'ready')) !== undefined);
  const [pid] = writtenPids(join(root, 'ready'))!;
  input.write(JSON.stringify({ id: 'list', type: 'list_jobs' }) + '\n');
  input.write(
    JSON.stringify({ id: 'stop', type: 'stop_job', jobId: job.id }) + '\n',
  );
  await waitFor(() => output.some((record) => record.id === 'stop'));
  const listed = output.find((record) => record.id === 'list').data.jobs[0];
  assert.equal(listed.output, job.virtualPath);
  assert.equal(listed.startedBy, 'user');
  assert.equal(typeof listed.elapsed, 'number');
  assert.equal(listed.exitCode, null);
  assert.equal(
    output.find((record) => record.id === 'stop').data.job.status,
    'stopped',
  );
  input.write(
    JSON.stringify({ id: 'again', type: 'stop_job', jobId: job.id }) + '\n',
  );
  input.end();
  assert.equal(await runner, 0);
  assert.equal(output.find((record) => record.id === 'again').success, false);
  // The job would live a minute; once it is gone it can write nothing late.
  await until(() => processGone(pid!), { label: 'the stopped job to end' });
  assert.equal(existsSync(join(root, 'late')), false);
  assert.ok(
    output.some(
      (record) =>
        record.type === 'job' &&
        record.event === 'ended' &&
        record.job.id === job.id,
    ),
  );
  assert.equal(output.at(-1).type, 'jobs_stopped');
});

test('closing RPC input waits for a model job and delivers its actual result in a notice turn', async (t) => {
  const root = scratch(t);
  writeFileSync(
    join(root, 'job.cjs'),
    "setTimeout(() => { require('node:fs').writeFileSync('receipt', 'completed'); console.log('actual result'); }, 250);",
  );
  const model = new ScriptedModel([
    {
      message: {
        id: 'start',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'background',
            name: 'execute',
            args: {
              command: `"${process.execPath}" "${join(root, 'job.cjs')}"`,
              background: true,
            },
          },
        ],
      },
    },
    { message: answer('started') },
    { message: answer('noticed') },
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  runtime.policy.setYolo(runtime.session.id, true);
  cleanup(t, () => runtime.close());
  const input = new PassThrough();
  const output: any[] = [];
  const runner = runRpc(runtime, {
    input,
    write: (text) => output.push(JSON.parse(text)),
  });
  cleanup(t, async () => {
    input.destroy();
    await runtime.cancel();
    await runner;
  });
  input.end(
    JSON.stringify({
      id: 'prompt',
      type: 'prompt',
      message: 'start background work',
    }) + '\n',
  );
  assert.equal(await runner, 0);
  assert.equal(readFileSync(join(root, 'receipt'), 'utf8'), 'completed');
  assert.equal(model.requests.length, 3);
  assert.ok(
    model.requests[2]!.messages.some(
      (message) =>
        message.internal === 'job_notice' &&
        message.content.includes('actual result'),
    ),
  );
  assert.equal(
    runtime.jobs.list().some((job) => job.status === 'running'),
    false,
  );
  assert.deepEqual(output.at(-1), { type: 'jobs_stopped', count: 0 });
});

test('an RPC conversation runs again the turn a finished job started when the model service broke off after it took the notice', async (t) => {
  const root = scratch(t);
  writeFileSync(
    join(root, 'job.cjs'),
    "setTimeout(() => console.log('job result'), 250);",
  );
  const model = new ScriptedModel([
    {
      message: {
        id: 'start',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'background',
            name: 'execute',
            args: {
              command: `"${process.execPath}" "${join(root, 'job.cjs')}"`,
              background: true,
            },
          },
        ],
      },
    },
    { message: answer('started') },
    async () => {
      throw new Error('the model service broke off');
    },
    { message: answer('noticed at last') },
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  runtime.policy.setYolo(runtime.session.id, true);
  cleanup(t, () => runtime.close());
  const input = new PassThrough();
  const output: Record<string, unknown>[] = [];
  const runner = runRpc(runtime, {
    input,
    write: (text) => output.push(JSON.parse(text)),
  });
  cleanup(t, async () => {
    input.destroy();
    await runtime.cancel();
    await runner;
  });
  // Counted by tries, not by the clock, which is moved below
  const settled = async (count: number) => {
    for (let tries = 0; tries < 500; tries++) {
      if (
        output.filter((record) => record.type === 'agent_settled').length >=
        count
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no ${count} settled turns: ${JSON.stringify(output)}`);
  };
  input.write(
    JSON.stringify({ id: 'prompt', type: 'prompt', message: 'start' }) + '\n',
  );
  await settled(2);
  assert.equal(model.requests.length, 3);
  assert.equal(runtime.jobs.hasNotices(runtime.session.id, true), false);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 16_000 });
  await settled(3);
  t.mock.timers.reset();
  input.end();
  assert.equal(await runner, 0);
  assert.equal(model.requests.length, 4);
  assert.ok(
    model.requests[3]!.messages.some(
      (message) =>
        message.internal === 'job_notice' &&
        message.content.includes('job result'),
    ),
  );
});

// A finished job's notice that no turn starts for waits for the next prompt: after the limit of turns in a row that
// jobs started (CIRCLE_JOB_WAKES) and after an abort. RPC says so once for each job, as the terminal does in a line.
async function waitingSession(t: TestContext, replies: number) {
  const root = scratch(t);
  const model = new ScriptedModel(
    Array.from({ length: replies }, (_, i) => ({
      message: answer(`turn ${i + 1}`),
    })),
  );
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const input = new PassThrough();
  const output: Record<string, unknown>[] = [];
  const runner = runRpc(runtime, {
    input,
    write: (text) => output.push(JSON.parse(text)),
  });
  cleanup(t, async () => {
    input.destroy();
    await runtime.cancel();
    await runner;
  });
  const send = (value: unknown): void => {
    input.write(JSON.stringify(value) + '\n');
  };
  // A ceiling, not a clock: a job that ended is looked at a second later
  const patience = { timeout: 15_000 };
  const settled = (count: number) =>
    until(
      () =>
        output.filter((record) => record.type === 'agent_settled').length >=
        count,
      { ...patience, label: `${count} settled turns` },
    );
  const waiting = () =>
    output.filter((record) => record.type === 'job_notice_waiting');
  const waitingCount = (count: number) =>
    until(() => waiting().length >= count, {
      ...patience,
      label: () => `${count} waiting notices: ${JSON.stringify(output)}`,
    });
  return {
    runtime,
    model,
    input,
    runner,
    output,
    send,
    settled,
    waiting,
    waitingCount,
  };
}
/** A job of the model's that ends when the returned function is called: a watch, as the terminal's tests use. */
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
const noticesIn = (request: { messages: Message[] }) =>
  request.messages.filter((message) => message.internal === 'job_notice');

test('RPC writes one record for each finished job whose notice waits after the limit of turns in a row, and the next prompt gives the model the notices', async (t) => {
  const before = process.env.CIRCLE_JOB_WAKES;
  process.env.CIRCLE_JOB_WAKES = '1';
  t.after(() => {
    if (before === undefined) delete process.env.CIRCLE_JOB_WAKES;
    else process.env.CIRCLE_JOB_WAKES = before;
  });
  const {
    runtime,
    model,
    input,
    runner,
    send,
    settled,
    waiting,
    waitingCount,
  } = await waitingSession(t, 3);
  send({ type: 'prompt', message: 'start pipeline' });
  await settled(1);
  // The end of the first job starts a turn: one turn in a row, which is the limit
  startJob(runtime, 'stage 1')();
  await settled(2);
  assert.equal(model.requests.length, 2);
  assert.deepEqual(waiting(), [], 'a turn started, nothing waits');

  // The second job's notice waits: its record says which job, its line, and why
  startJob(runtime, 'stage 2')();
  await waitingCount(1);
  const { line, ...second } = waiting()[0] as {
    line: string;
    [key: string]: unknown;
  };
  assert.deepEqual(second, {
    type: 'job_notice_waiting',
    jobId: 'j2',
    why: 'limit',
    most: 1,
  });
  assert.match(line, /^j2 done · stage 2 · \S+$/);
  assert.equal(model.requests.length, 2, 'no turn starts for it');
  assert.equal(runtime.jobs.hasNotices(runtime.session.id, true), true);

  // A job that ends while the first still waits is one record more; the first is not said again
  startJob(runtime, 'stage 3')();
  await waitingCount(2);
  assert.deepEqual(
    waiting().map((record) => record.jobId),
    ['j2', 'j3'],
  );
  assert.equal(model.requests.length, 2);

  // The prompt: the model reads both notices with it, and nothing waits any more
  send({ type: 'prompt', message: 'go on' });
  await settled(3);
  // The first job's notice was read by the turn it started; the others come now, in one message
  const notices = noticesIn(model.requests.at(-1)!);
  assert.equal(notices.length, 2);
  assert.match(notices[0]!.content, /stage 1/);
  assert.match(notices[1]!.content, /stage 2[\s\S]*stage 3/);
  assert.equal(runtime.jobs.hasNotices(runtime.session.id, true), false);
  assert.equal(waiting().length, 2, 'the prompt said nothing more');
  input.end();
  assert.equal(await runner, 0);
});

test('after abort, RPC writes a record for a finished job whose notice waits, without a number, and none for a job the person stopped', async (t) => {
  const {
    runtime,
    model,
    input,
    runner,
    output,
    send,
    settled,
    waiting,
    waitingCount,
  } = await waitingSession(t, 2);
  send({ type: 'prompt', message: 'start pipeline' });
  await settled(1);
  send({ id: 'stop', type: 'abort' });
  await until(() => output.some((record) => record.id === 'stop'), {
    label: 'the abort answered',
  });
  // A job the person stops is no news: it never starts a turn, so nothing waits for it
  startJob(runtime, 'dev server');
  send({ type: 'stop_job', jobId: 'j1' });
  await until(
    () =>
      output.some(
        (record) =>
          record.type === 'job' &&
          (record.job as { id: string; status: string }).id === 'j1' &&
          (record.job as { status: string }).status === 'stopped',
      ),
    { label: 'the job stopped' },
  );
  const end = startJob(runtime, 'build');
  end();
  await waitingCount(1);
  const { line, ...record } = waiting()[0] as {
    line: string;
    [key: string]: unknown;
  };
  assert.deepEqual(record, {
    type: 'job_notice_waiting',
    jobId: 'j2',
    why: 'stopped',
  });
  assert.match(line, /^j2 done · build · \S+$/);
  assert.equal(waiting().length, 1, 'nothing for the job that was stopped');
  assert.equal(model.requests.length, 1, 'no turn starts for it');

  send({ type: 'prompt', message: 'go on' });
  await settled(2);
  const notices = noticesIn(model.requests.at(-1)!);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.content, /build/);
  input.end();
  assert.equal(await runner, 0);
});

test('when its input ends at the limit of turns in a row, RPC writes a record for the notice a job left unread, before jobs_stopped', async (t) => {
  const before = process.env.CIRCLE_JOB_WAKES;
  process.env.CIRCLE_JOB_WAKES = '1';
  t.after(() => {
    if (before === undefined) delete process.env.CIRCLE_JOB_WAKES;
    else process.env.CIRCLE_JOB_WAKES = before;
  });
  const { runtime, model, input, runner, output, send, settled, waiting } =
    await waitingSession(t, 2);
  send({ type: 'prompt', message: 'start pipeline' });
  await settled(1);
  // The end of the first job starts the one turn in a row there is
  startJob(runtime, 'stage 1')();
  await settled(2);
  // The second job runs while the input ends: nobody is left to send a prompt that would read its notice
  const end = startJob(runtime, 'stage 2');
  input.end();
  end();
  assert.equal(await runner, 0);
  assert.equal(model.requests.length, 2, 'no third turn starts for it');
  const { line, ...record } = waiting()[0] as {
    line: string;
    [key: string]: unknown;
  };
  assert.deepEqual(record, {
    type: 'job_notice_waiting',
    jobId: 'j2',
    why: 'limit',
    most: 1,
  });
  assert.match(line, /^j2 done · stage 2 · \S+$/);
  assert.equal(waiting().length, 1);
  const types = output.map((item) => item.type);
  assert.ok(
    types.lastIndexOf('job_notice_waiting') < types.lastIndexOf('jobs_stopped'),
  );
  assert.deepEqual(output.at(-1), { type: 'jobs_stopped', count: 0 });
});

test('when its input ends with a notice already said to wait, RPC does not say it again', async (t) => {
  const before = process.env.CIRCLE_JOB_WAKES;
  process.env.CIRCLE_JOB_WAKES = '1';
  t.after(() => {
    if (before === undefined) delete process.env.CIRCLE_JOB_WAKES;
    else process.env.CIRCLE_JOB_WAKES = before;
  });
  const { runtime, input, runner, send, settled, waiting, waitingCount } =
    await waitingSession(t, 2);
  send({ type: 'prompt', message: 'start pipeline' });
  await settled(1);
  startJob(runtime, 'stage 1')();
  await settled(2);
  // The second notice waits and the input is still open: the record is written then
  startJob(runtime, 'stage 2')();
  await waitingCount(1);
  input.end();
  assert.equal(await runner, 0);
  assert.deepEqual(
    waiting().map((record) => record.jobId),
    ['j2'],
    'once, not again as the input ends',
  );
});

test('when its input ends after the notices were read, RPC says nothing about waiting', async (t) => {
  const { runtime, input, runner, send, settled, waiting } =
    await waitingSession(t, 2);
  send({ type: 'prompt', message: 'start pipeline' });
  await settled(1);
  startJob(runtime, 'stage 1')();
  await settled(2);
  input.end();
  assert.equal(await runner, 0);
  assert.deepEqual(waiting(), []);
});

async function requestModels(
  runtime: AgentRuntime,
): Promise<Record<string, unknown>> {
  const input = new PassThrough();
  const output: Record<string, unknown>[] = [];
  const runner = runRpc(runtime, {
    input,
    write: (text) => output.push(JSON.parse(text)),
  });
  input.end(
    JSON.stringify({ id: 'models', type: 'get_available_models' }) + '\n',
  );
  assert.equal(await runner, 0);
  const reply = output.find((record) => record.id === 'models');
  assert.ok(reply);
  return reply;
}

test('RPC returns provider presets without contacting the endpoint', async (t) => {
  const root = scratch(t);
  const settings = defaultSettings();
  settings.auth = {
    ...settings.auth,
    provider: 'bailian',
    base_url: 'http://127.0.0.1:1/compatible-mode/v1',
    model: 'qwen3.8-flash',
  };
  saveCredentials({ api_key: 'fake' }, root);
  const runtime = new AgentRuntime({
    home: root,
    workspace: root,
    settings,
    model: new ScriptedModel(),
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const reply = await requestModels(runtime);
  assert.equal(reply.success, true);
  assert.deepEqual((reply.data as { models: string[] }).models, [
    'qwen3.8-max',
    'qwen3.8-flash',
    'qwen3.7-plus',
    'qwen3-coder-flash',
  ]);
});

test('RPC keeps custom model discovery failures explicit', async (t) => {
  const root = scratch(t);
  const server = createServer((request, response) => {
    response.writeHead(404).end();
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  cleanup(t, async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const settings = defaultSettings();
  settings.auth = {
    ...settings.auth,
    provider: 'custom',
    base_url: `http://127.0.0.1:${address.port}/v1`,
    model: 'manual',
  };
  saveCredentials({ api_key: 'fake' }, root);
  const runtime = new AgentRuntime({
    home: root,
    workspace: root,
    settings,
    model: new ScriptedModel(),
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const reply = await requestModels(runtime);
  assert.equal(reply.success, false);
  assert.equal(reply.error, 'http 404');
});
