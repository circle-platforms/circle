// Print mode after its last prompt: it answers the jobs the model started as they end, up to the limit of turns in a
// row that jobs may start (CIRCLE_JOB_WAKES). A notice that the limit left unread has nobody to read it, so print mode
// says which on standard error, and standard output stays the last answer. The real runtime with a scripted model; the
// model starts a job in each turn, a watch that has ended by the time anything looks.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { AgentRuntime } from '../src/runtime.js';
import { HeadlessProgress, runPrint } from '../src/headless.js';
import { ScriptedModel } from '../src/testing.js';
import { Watch } from '../src/watch.js';
import { defaultSettings } from '../src/settings.js';
import { emptyUsage } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

/** `jobs` is what the model starts in each turn: a title, or nothing for a turn that only answers. */
async function printRun(
  t: TestContext,
  jobs: (string | null)[],
  options: { json?: boolean } = {},
) {
  const root = scratch(t);
  let runtime: AgentRuntime | undefined;
  const model = new ScriptedModel(
    jobs.map((title, index) => async () => {
      if (title !== null)
        runtime!.jobs.startWatch(
          new Watch(title, () => 'ok', { interval_s: 0.01 }),
          { sessionId: runtime!.session.id, startedBy: 'model' },
        );
      return {
        message: {
          id: crypto.randomUUID(),
          role: 'assistant' as const,
          content: `turn ${index + 1}`,
        },
        usage: emptyUsage(),
      };
    }),
  );
  runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime!.close());
  const stderr: string[] = [];
  const stdout: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', ((
    chunk: unknown,
    ...rest: never[]
  ) => {
    // What the test runner itself writes is not a string
    if (typeof chunk !== 'string') return realWrite(chunk as never, ...rest);
    stdout.push(chunk);
    return true;
  }) as never);
  const code = await runPrint(runtime, ['start the pipeline'], {
    ...options,
    progress: new HeadlessProgress(false, false, (line) => stderr.push(line)),
  });
  return { runtime, model, stdout, stderr, code };
}

test('print mode says which notices the limit of turns in a row left unread, and standard output is the last answer as before', async (t) => {
  const before = process.env.CIRCLE_JOB_WAKES;
  process.env.CIRCLE_JOB_WAKES = '1';
  t.after(() => {
    if (before === undefined) delete process.env.CIRCLE_JOB_WAKES;
    else process.env.CIRCLE_JOB_WAKES = before;
  });
  // The prompt's turn starts the first job; its end starts the one turn in a row, which starts the second; its end
  // finds the limit used up
  const { runtime, model, stdout, stderr, code } = await printRun(t, [
    'stage 1',
    'stage 2',
  ]);
  assert.equal(code, 0);
  assert.equal(model.requests.length, 2, 'no third turn starts for the second');
  assert.deepEqual(stdout, ['turn 2\n']);
  assert.deepEqual(stderr, [
    'Notices not read after 1 turn started by jobs (CIRCLE_JOB_WAKES sets the limit): j2.',
  ]);
  assert.equal(runtime.jobs.hasNotices(runtime.session.id, true), true);
});

test('print mode says the same on standard error with --mode json, and writes no more to standard output', async (t) => {
  const before = process.env.CIRCLE_JOB_WAKES;
  process.env.CIRCLE_JOB_WAKES = '1';
  t.after(() => {
    if (before === undefined) delete process.env.CIRCLE_JOB_WAKES;
    else process.env.CIRCLE_JOB_WAKES = before;
  });
  const { stdout, stderr } = await printRun(t, ['stage 1', 'stage 2'], {
    json: true,
  });
  assert.deepEqual(stderr, [
    'Notices not read after 1 turn started by jobs (CIRCLE_JOB_WAKES sets the limit): j2.',
  ]);
  // Records, each a line of JSON, and none of them is the words above
  for (const line of stdout) assert.doesNotThrow(() => JSON.parse(line), line);
  assert.doesNotMatch(stdout.join(''), /Notices not read/);
});

test('print mode that read every notice within the limit says nothing more', async (t) => {
  const { model, stdout, stderr, code } = await printRun(t, ['stage 1', null]);
  assert.equal(code, 0);
  assert.equal(model.requests.length, 2);
  assert.ok(
    model.requests[1]!.messages.some(
      (message) =>
        message.internal === 'job_notice' && /stage 1/.test(message.content),
    ),
    'the model read the notice',
  );
  assert.deepEqual(stdout, ['turn 2\n']);
  assert.deepEqual(stderr, []);
});
