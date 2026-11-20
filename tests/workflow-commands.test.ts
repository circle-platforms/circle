import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { AgentRuntime, type RuntimeOptions } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import type { ScriptedModel } from '../src/testing.js';
import { emptyUsage, type Message, type ModelResponse } from '../src/types.js';
import { readJournal, workflowSummary } from '../src/workflows.js';
import {
  cleanup,
  modelByAsker,
  scratch,
  until,
  type AskerReply,
} from './helpers.js';

// execute() in a workflow script: a command of the script's own, run as the conversation's execute call would be

const reply = (
  content: string,
  calls: Message['tool_calls'] = [],
): ModelResponse => ({
  message: {
    id: crypto.randomUUID(),
    role: 'assistant',
    content,
    ...(calls.length ? { tool_calls: calls } : {}),
  },
  usage: emptyUsage(),
});
const workflowCall = (id: string, args: Record<string, unknown>) =>
  reply('', [{ id, name: 'workflow', args }]);
function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
const META = (name: string, phases: string[] = []) =>
  `export const meta = { name: '${name}', description: 'Run ${name}', phases: ${JSON.stringify(phases.map((title) => ({ title })))} }\n`;
function folders(t: Parameters<typeof scratch>[0]) {
  const root = realpathSync(scratch(t));
  const paths = {
    root,
    home: join(root, 'home'),
    workspace: join(root, 'workspace'),
    userHome: join(root, 'user'),
    packs: join(root, 'packs'),
  };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  return paths;
}
function runtimeFor(
  t: Parameters<typeof scratch>[0],
  paths: ReturnType<typeof folders>,
  model: ScriptedModel,
  options: Partial<RuntimeOptions> = {},
) {
  const runtime = new AgentRuntime({
    home: paths.home,
    workspace: paths.workspace,
    userHome: paths.userHome,
    localSkillsRoot: paths.packs,
    settings: defaultSettings(),
    model,
    ...options,
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  return runtime;
}
const resultOf = (runtime: AgentRuntime, id: string) =>
  runtime.store
    .messages(runtime.session.id)
    .find((message) => message.tool_call_id === id)?.content ?? '';
function started(runtime: AgentRuntime, callId: string) {
  const text = resultOf(runtime, callId);
  const run = /as run (w[0-9a-f]{8})/.exec(text)?.[1];
  const job = /In background: (j\d+) /.exec(text)?.[1];
  assert.ok(run && job, text);
  return { run, job };
}
async function finished(runtime: AgentRuntime, job: string) {
  await until(() => runtime.jobs.get(job)?.status !== 'running', {
    timeout: 20_000,
    label: () =>
      `${job} to end: ${JSON.stringify(runtime.workflowRunViews()[0])}`,
  });
  return runtime.jobs.get(job)!;
}
function envFor(t: Parameters<typeof scratch>[0], name: string) {
  const saved = process.env[name];
  t.after(() => {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  });
  return (value: string): void => {
    process.env[name] = value;
  };
}
/** The result a run's end left for the conversation, read from its notice. */
const noticeResult = (notice: string): unknown => {
  const text = notice.slice(notice.indexOf('Result:\n') + 8);
  for (
    let end = text.indexOf('\n}');
    end >= 0;
    end = text.indexOf('\n}', end + 1)
  ) {
    try {
      return JSON.parse(text.slice(0, end + 2));
    } catch {
      /* A closing brace inside the value: the result ends further on. */
    }
  }
  throw new Error(`no result in ${notice}`);
};

test("a script's command gives it the exit code and what was printed, runs while every agent place is taken, and is not kept in the conversation", async (t) => {
  const paths = folders(t);
  // One agent at a time: the agent below holds the only place while the second command runs
  envFor(t, 'CIRCLE_WORKFLOW_MAX_CONCURRENT_AGENTS')('1');
  const script =
    META('book-keeping', ['Work']) +
    `phase('Work')
const first = await execute('printf %WORD%; exit 3')
const working = agent('do the work')
const second = await execute('printf two', { label: 'second', timeout: 30 })
log('second done')
const worked = await working
return { first, second, worked }
`;
  const gate = deferred();
  t.after(() => gate.open());
  const held: AskerReply = async () => {
    await gate.promise;
    return reply('worked');
  };
  let notice = '';
  const model = modelByAsker({
    go: [
      workflowCall('w1', { script }),
      reply('started'),
      (request) => {
        notice = request.messages.at(-1)!.content;
        return reply('read');
      },
    ],
    'do the work': [held],
  });
  const runtime = runtimeFor(t, paths, model, {
    settings: { ...defaultSettings(), variables: { WORD: 'one' } },
  });
  await runtime.initialize();
  await runtime.harness.run('go');
  const { run, job } = started(runtime, 'w1');
  const view = () => runtime.workflowRunViews()[0]!;
  // The second command ended while the agent still held the one place
  await until(() => view().logs.includes('second done'), { timeout: 20_000 });
  assert.equal(runtime.jobs.get(job)!.status, 'running');
  assert.deepEqual(
    view().agents.map((agent) => [
      agent.label,
      agent.command ?? false,
      agent.state,
    ]),
    [
      // A script written in the call had the value put in with the call's other arguments
      ['$ printf one; exit 3', true, 'done'],
      ['do the work', false, 'running'],
      ['second', true, 'done'],
    ],
  );
  // The strip counts agents: a command is the script's own step
  assert.equal(workflowSummary(view()), 'Work · 1 running');
  gate.open();
  assert.equal((await finished(runtime, job)).status, 'done');
  assert.equal(await runtime.runJobNotices(), 'read');
  // A value of the settings went in as it does for the conversation's own call; a failing command is a result
  assert.deepEqual(noticeResult(notice), {
    first: { code: 3, output: 'one' },
    second: { code: 0, output: 'two' },
    worked: 'worked',
  });
  // Nothing of the commands is in the conversation: no call, no result
  const kept = runtime.store.messages(runtime.session.id);
  assert.ok(!kept.some((message) => message.name === 'execute'));
  assert.ok(
    !kept.some((message) =>
      message.tool_calls?.some((call) => call.name === 'execute'),
    ),
  );
  // The journal has each command as it has each agent, with what it gave
  const journal = readJournal(
    join(runtime.workflowRunsFolder, run, 'journal.jsonl'),
  );
  assert.deepEqual(
    journal
      .filter((event) => event.t === 'end')
      .map((event) => [event.i, event.status, event.result]),
    [
      [0, 'done', { code: 3, output: 'one' }],
      [2, 'done', { code: 0, output: 'two' }],
      [1, 'done', 'worked'],
    ],
  );
});

test("a command is decided as the conversation's own call is: a hook that denies it gives the script the refusal and nothing runs, and options out of range are refused", async (t) => {
  const paths = folders(t);
  const deny = join(paths.root, 'deny.mjs');
  writeFileSync(
    deny,
    `import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
if (String(input.tool_input?.command ?? '').includes('forbidden'))
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no forbidden commands' } }));
`,
  );
  writeFileSync(
    join(paths.home, 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'execute',
            hooks: [
              {
                type: 'command',
                command: `${JSON.stringify(process.execPath)} ${JSON.stringify(deny)}`,
              },
            ],
          },
        ],
      },
    }),
  );
  const script =
    META('refused') +
    `const message = (call) => call.then(() => 'ran', (error) => error.message)
const denied = await message(execute('echo forbidden > marker.txt'))
const allowed = await execute('echo fine > allowed.txt')
const long = await message(execute('true', { timeout: 601 }))
const empty = await message(execute('  '))
const label = await message(execute('true', { label: 7 }))
return { denied, allowed, long, empty, label }
`;
  let notice = '';
  const model = modelByAsker({
    go: [
      workflowCall('w1', { script }),
      reply('started'),
      (request) => {
        notice = request.messages.at(-1)!.content;
        return reply('read');
      },
    ],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.initialize();
  await runtime.harness.run('go');
  const { job } = started(runtime, 'w1');
  assert.equal((await finished(runtime, job)).status, 'done');
  await runtime.runJobNotices();
  const result = noticeResult(notice) as Record<string, unknown>;
  assert.match(String(result.denied), /no forbidden commands/);
  assert.ok(!existsSync(join(paths.workspace, 'marker.txt')));
  assert.deepEqual(result.allowed, { code: 0, output: '' });
  assert.equal(
    readFileSync(join(paths.workspace, 'allowed.txt'), 'utf8'),
    'fine\n',
  );
  assert.equal(
    result.long,
    'execute() option timeout must be a whole number of seconds from 1 to 600',
  );
  assert.equal(
    result.empty,
    'execute() takes the command as its first argument, a string',
  );
  assert.equal(result.label, 'execute() option label must be a string');
  // A refused command is in the view as one that failed; the others are done
  assert.deepEqual(
    runtime.workflowRunViews()[0]!.agents.map((agent) => agent.state),
    ['failed', 'done'],
  );
});

test("a relaunch hands back a command's saved result without running it again, and runs a changed command", async (t) => {
  const paths = folders(t);
  // The relaunch runs the script from its file: a %NAME% in a command there gets its value when the command runs
  const script = (word: string) =>
    META('once') +
    `const first = await execute('echo ran >> runs.txt; printf first')
const second = await execute('echo ${word} >> runs.txt; printf ${word}')
return { first, second }
`;
  let notice = '';
  const model = modelByAsker({
    go: [
      workflowCall('r1', { script: script('second') }),
      reply('started'),
      (request) => {
        const run = /as run (w[0-9a-f]{8})/.exec(
          request.messages.find((message) => message.tool_call_id === 'r1')!
            .content,
        )![1]!;
        // The run's own script, with its second command changed
        writeFileSync(
          join(runtime.workflowRunsFolder, run, 'script.js'),
          script('%WORD%'),
        );
        return workflowCall('r2', {
          script_path: `/workflow_runs/${run}/script.js`,
          resume_from_run_id: run,
        });
      },
      reply('relaunched'),
      (request) => {
        notice = request.messages.at(-1)!.content;
        return reply('read');
      },
    ],
  });
  const runtime = runtimeFor(t, paths, model, {
    settings: { ...defaultSettings(), variables: { WORD: 'changed' } },
  });
  await runtime.initialize();
  await runtime.harness.run('go');
  assert.equal(
    (await finished(runtime, started(runtime, 'r1').job)).status,
    'done',
  );
  await runtime.runJobNotices();
  const second = started(runtime, 'r2');
  assert.equal((await finished(runtime, second.job)).status, 'done');
  await runtime.runJobNotices();
  assert.deepEqual(noticeResult(notice), {
    first: { code: 0, output: 'first' },
    second: { code: 0, output: 'changed' },
  });
  // The first command ran once, in the first run; the changed one ran in the relaunch
  assert.equal(
    readFileSync(join(paths.workspace, 'runs.txt'), 'utf8'),
    'ran\nsecond\nchanged\n',
  );
  assert.deepEqual(
    runtime
      .workflowRunViews()
      .find((view) => view.id === second.run)!
      .agents.map((agent) => agent.state),
    ['cached', 'done'],
  );
});

test('args a model wrote as JSON text reach the script as the list or object they spell, and other text stays text', async (t) => {
  const paths = folders(t);
  const script =
    META('reads-args') +
    `return { kind: Array.isArray(args) ? 'list' : typeof args, word: args.word ?? null, first: args[0] ?? null, text: typeof args === 'string' ? args : null }`;
  const notices: string[] = [];
  const read: AskerReply = (request) => {
    notices.push(request.messages.at(-1)!.content);
    return reply('read');
  };
  const model = modelByAsker({
    go: [
      workflowCall('a1', { script, args: '{"word": "object as text"}' }),
      workflowCall('a2', { script, args: ' ["list as text"] ' }),
      workflowCall('a3', { script, args: 'just words {not json}' }),
      workflowCall('a4', { script, args: { word: 'an object' } }),
      reply('started'),
      read,
      read,
      read,
      read,
    ],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.initialize();
  await runtime.harness.run('go');
  for (const id of ['a1', 'a2', 'a3', 'a4'])
    assert.equal(
      (await finished(runtime, started(runtime, id).job)).status,
      'done',
    );
  while (notices.length < 4 && (await runtime.runJobNotices()) !== undefined);
  // The four results may come in one notice: each is the JSON after its job's "Result:"
  const results = notices
    .flatMap((notice) => [...notice.matchAll(/Result:\n(\{\n[\s\S]*?\n\})/g)])
    .map((found) => JSON.parse(found[1]!) as Record<string, unknown>);
  assert.equal(results.length, 4, JSON.stringify(notices).slice(0, 600));
  assert.deepEqual(
    results
      .map((result) => [result.kind, result.word, result.first, result.text])
      .sort(),
    [
      ['list', null, 'list as text', null],
      ['object', 'an object', null, null],
      ['object', 'object as text', null, null],
      ['string', null, 'j', 'just words {not json}'],
    ].sort(),
  );
});
