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
import {
  emptyUsage,
  type Message,
  type ModelRequest,
  type ModelResponse,
} from '../src/types.js';
import { readJournal } from '../src/workflows.js';
import { approvalRequest } from '../src/tui/approval_preview.js';
import {
  askedBy,
  cleanup,
  modelByAsker,
  scratch,
  until,
  type AskerReply,
} from './helpers.js';

// Workflows as the model starts them: each agent() a subagent on task's path, the result as a notice, the
// approval by mode, the limits, the stall restarts and the replay of a relaunched run

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
const structured = (id: string, args: Record<string, unknown>) =>
  reply('', [{ id, name: 'structured_output', args }]);
/** A reply that waits until `gate` opens, or until its request is stopped. */
const after =
  (gate: Promise<unknown>, response: ModelResponse): AskerReply =>
  (request) =>
    new Promise<ModelResponse>((resolve, reject) => {
      void gate.then(() => resolve(response));
      request.signal.addEventListener(
        'abort',
        () => reject(request.signal.reason ?? new Error('aborted')),
        { once: true },
      );
    });
/** A reply that never comes: the request waits until it is aborted. */
const hang: AskerReply = (request: ModelRequest) =>
  new Promise<ModelResponse>((_, reject) => {
    request.signal.addEventListener(
      'abort',
      () => reject(request.signal.reason ?? new Error('aborted')),
      { once: true },
    );
  });
function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
const META = (name: string, phases: string[] = []) =>
  `export const meta = { name: '${name}', description: 'Run ${name}', phases: ${JSON.stringify(phases.map((title) => ({ title })))} }\n`;

/** Home, workspace, user home and pack folder, none of them the person's own. */
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
  options: Partial<RuntimeOptions> & { yolo?: boolean } = {},
) {
  const { yolo = true, ...rest } = options;
  const runtime = new AgentRuntime({
    home: paths.home,
    workspace: paths.workspace,
    userHome: paths.userHome,
    localSkillsRoot: paths.packs,
    settings: defaultSettings(),
    model,
    ...rest,
  });
  cleanup(t, () => runtime.close());
  if (yolo) runtime.policy.setYolo(runtime.session.id, true);
  return runtime;
}
/** The result a session's tool call got. */
const resultOf = (runtime: AgentRuntime, id: string, sessionId?: string) =>
  runtime.store
    .messages(sessionId ?? runtime.session.id)
    .find((message) => message.tool_call_id === id)?.content ?? '';
/** The run a workflow call started, and its job, from the call's result. */
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
      `${job} to end: ${JSON.stringify(runtime.workflowRunViews()[0]?.agents)}`,
  });
  return runtime.jobs.get(job)!;
}
const requestsOf = (model: ScriptedModel, key: string) =>
  model.requests.filter((request) => askedBy(request, key));
/** A script that appends one JSON line per run of what it was told. */
function recorder(dir: string, name: string, line: string): string {
  const script = join(dir, `${name}.mjs`);
  writeFileSync(
    script,
    `import { appendFileSync, readFileSync } from 'node:fs';
const input = (() => { try { return JSON.parse(readFileSync(0, 'utf8')); } catch { return {}; } })();
appendFileSync(${JSON.stringify(join(dir, `${name}.jsonl`))}, JSON.stringify(${line}) + '\\n');
`,
  );
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
}
const lines = (dir: string, name: string) =>
  readFileSync(join(dir, `${name}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
/** An environment variable a test sets as it goes, and leaves as it found it. */
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

test('a workflow starts in the background, its agents run as subagents on the path task takes, and its result reaches the next model request', async (t) => {
  const paths = folders(t);
  // The conversation's hooks hear each agent start, with its type
  const heard = recorder(
    paths.root,
    'hook',
    `{ event: input.hook_event_name, agent_type: input.agent_type ?? null, session_id: input.session_id }`,
  );
  writeFileSync(
    join(paths.home, 'settings.json'),
    JSON.stringify({
      hooks: {
        SubagentStart: [{ hooks: [{ type: 'command', command: heard }] }],
      },
    }),
  );
  const script =
    META('two-readers', ['Read']) +
    `phase('Read')
const [first, second] = await parallel([
  () => agent('read the first file'),
  () => agent('read the second file', { agentType: 'explore', label: 'second' }),
])
log('both read')
return { first, second }
`;
  const gate = deferred();
  const model = modelByAsker({
    go: [
      workflowCall('w1', { script }),
      reply('It runs in the background.'),
      (request) => {
        // The notice the run's end left is in front of the model, with the result whole
        const notice = request.messages.at(-1)!.content;
        assert.match(notice, /^<system-reminder data-source="circle-jobs">/);
        assert.match(notice, /workflow two-readers/);
        assert.match(
          notice,
          /Result:\n\{\n {2}"first": "first read",\n {2}"second": "second read"\n\}/,
        );
        return reply('Both files were read.');
      },
    ],
    'read the first file': [after(gate.promise, reply('first read'))],
    'read the second file': [after(gate.promise, reply('second read'))],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.initialize();
  // The tool is offered to the conversation with its words and the API
  const offered = model;
  const result = await runtime.harness.run('go');
  assert.equal(result.answer, 'It runs in the background.');
  const { run, job } = started(runtime, 'w1');
  // The call came back while its agents still worked
  assert.equal(runtime.jobs.get(job)!.status, 'running');
  assert.match(
    resultOf(runtime, 'w1'),
    new RegExp(
      `^Workflow two-readers started as run ${run}\\. Phases: Read\\.\\nScript: /workflow_runs/${run}/script\\.js\\.`,
    ),
  );
  const tool = offered.requests[0]!.tools.find(
    (item) => item.name === 'workflow',
  )!;
  assert.match(tool.description, /^Run a workflow: a JavaScript script/);
  gate.open();
  const ended = await finished(runtime, job);
  assert.equal(ended.status, 'done');
  assert.deepEqual(ended.workflow?.name, 'two-readers');

  // Each agent was a subagent of the conversation: a session of its own, its prompt its first message
  const conversation = runtime.session.id;
  const children = runtime.store.children(conversation);
  assert.deepEqual(children.map((child) => child.title).sort(), [
    'explore: read the second file',
    'workflow: read the first file',
  ]);
  const first = requestsOf(model, 'read the first file')[0]!;
  assert.match(first.system, /^You are a workflow agent: a script started you/);
  const firstTools = first.tools.map((item) => item.name);
  // It may start subagents of its own, and never a workflow or a question
  assert.ok(firstTools.includes('task'));
  for (const name of [
    'workflow',
    'question',
    'plan_enter',
    'structured_output',
  ])
    assert.ok(!firstTools.includes(name), name);
  // agentType gives the subagent that type's prompt and tools, as task does
  const second = requestsOf(model, 'read the second file')[0]!;
  assert.doesNotMatch(second.system, /^You are a workflow agent/);
  assert.ok(!second.tools.some((item) => item.name === 'write_file'));
  assert.deepEqual(
    lines(paths.root, 'hook')
      .map(
        (line) =>
          `${line.event} ${line.agent_type} ${line.session_id === conversation}`,
      )
      .sort(),
    ['SubagentStart explore true', 'SubagentStart workflow true'],
  );

  // The run's folder keeps its script and its journal; the view says how it went
  const folder = join(runtime.workflowRunsFolder, run);
  assert.equal(readFileSync(join(folder, 'script.js'), 'utf8'), script);
  // Both started before either ended, as the gate held them
  const journal = readJournal(join(folder, 'journal.jsonl')).map(
    (event) => `${event.t} ${event.i}`,
  );
  assert.deepEqual(journal.slice(0, 2), ['start 0', 'start 1']);
  assert.deepEqual(journal.slice(2).sort(), ['end 0', 'end 1']);
  const [view] = runtime.workflowRunViews();
  assert.equal(view!.status, 'done');
  assert.deepEqual(view!.logs, ['both read']);
  assert.deepEqual(
    view!.agents.map((agent) => [agent.label, agent.phase, agent.state]),
    [
      ['read the first file', 'Read', 'done'],
      ['second', 'Read', 'done'],
    ],
  );

  // The notice starts the next turn, and the model reads the result there
  assert.equal(await runtime.runJobNotices(), 'Both files were read.');
});

test('a schema is met through structured_output within five tries, a contradictory one fails before any agent starts, and five misses fail the call', async (t) => {
  const paths = folders(t);
  const schema = {
    type: 'object',
    required: ['count'],
    properties: { count: { type: 'integer' } },
  };
  const script =
    META('counts') +
    `const counted = await agent('count the files', { schema: ${JSON.stringify(schema)} })
let contradiction = ''
try {
  await agent('never asked', { schema: { type: 'object', required: ['a'], additionalProperties: false, properties: {} } })
} catch (error) { contradiction = error.message }
let missed = ''
try { await agent('miss every time', { schema: ${JSON.stringify(schema)} }) } catch (error) { missed = error.message }
return { counted, contradiction, missed }
`;
  const model = modelByAsker({
    go: [workflowCall('w1', { script }), reply('started')],
    // A miss, an end without the call, then a value that fits: the value comes back, with no request after it
    'count the files': [
      structured('s1', { count: 'many' }),
      reply('I counted them.'),
      structured('s2', { count: 12 }),
    ],
    'miss every time': Array.from({ length: 5 }, (_, at) =>
      structured(`m${at}`, { count: 'none' }),
    ),
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.initialize();
  await runtime.harness.run('go');
  const { job } = started(runtime, 'w1');
  assert.equal((await finished(runtime, job)).status, 'done');
  const [view] = runtime.workflowRunViews();
  const result = JSON.parse(
    readFileSync(
      join(runtime.workflowRunsFolder, view!.id, 'result.txt'),
      'utf8',
    ),
  );
  assert.deepEqual(result.counted, { count: 12 });
  assert.equal(
    result.contradiction,
    "schema: 'a' is required, and additionalProperties: false rules it out",
  );
  assert.match(
    result.missed,
    /^the agent's output did not fit its schema after 5 tries: structured_output was called with invalid arguments: \/count: must be integer/,
  );
  assert.equal(requestsOf(model, 'count the files').length, 3);
  assert.equal(requestsOf(model, 'miss every time').length, 5);
  // The schema is the tool's own, and the agent is told how its value goes back
  const asked = requestsOf(model, 'count the files')[0]!;
  const tool = asked.tools.find((item) => item.name === 'structured_output')!;
  assert.deepEqual(tool.parameters, schema);
  assert.match(asked.system, /call structured_output once/);
  // The contradiction started nothing
  assert.equal(
    runtime.store
      .children(runtime.session.id)
      .filter((child) => child.title.includes('never asked')).length,
    0,
  );
  assert.equal(view!.agents.length, 2);
});

test('an agent whose model goes silent starts over from its prompt, five times at most, and then fails its call', async (t) => {
  const paths = folders(t);
  // The stall window's clock is the test's: a window ends when the test says so
  const timers: { ms: number; fire: () => void; live: boolean }[] = [];
  const workflowStallTimer = (ms: number, fire: () => void) => {
    const timer = { ms, fire, live: true };
    timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  const script =
    META('slow') +
    `const late = await agent('answer late', { stallMs: 1234 })
const never = await parallel([() => agent('never answer')])
let direct = ''
try { await agent('never answer either') } catch (error) { direct = error.message }
return { late, never, direct }
`;
  const model = modelByAsker({
    go: [workflowCall('w1', { script }), reply('started')],
    'answer late': [hang, hang, reply('at last')],
    'never answer': Array.from({ length: 6 }, () => hang),
    'never answer either': Array.from({ length: 6 }, () => hang),
  });
  const runtime = runtimeFor(t, paths, model, { workflowStallTimer });
  await runtime.initialize();
  await runtime.harness.run('go');
  const { job } = started(runtime, 'w1');
  // Each silent attempt: its window runs while its model request is out, and the test ends it
  const stall = async (prompt: string, attempt: number) => {
    await until(
      () =>
        requestsOf(model, prompt).length === attempt &&
        timers.some((timer) => timer.live),
      { label: `${prompt} attempt ${attempt}` },
    );
    timers.find((timer) => timer.live)!.fire();
  };
  await stall('answer late', 1);
  await stall('answer late', 2);
  for (let attempt = 1; attempt <= 6; attempt++)
    await stall('never answer', attempt);
  for (let attempt = 1; attempt <= 6; attempt++)
    await stall('never answer either', attempt);
  assert.equal((await finished(runtime, job)).status, 'done');
  assert.ok(timers.slice(0, 3).every((timer) => timer.ms === 1234));
  const [view] = runtime.workflowRunViews();
  const result = JSON.parse(
    readFileSync(
      join(runtime.workflowRunsFolder, view!.id, 'result.txt'),
      'utf8',
    ),
  );
  assert.deepEqual(result, {
    late: 'at last',
    never: [null],
    direct: 'agent stalled on all 6 attempts',
  });
  const late = view!.agents[0]!;
  assert.equal(late.attempt, 3);
  assert.deepEqual(late.endings, ['stalled', 'stalled']);
  // Each attempt started without the one before it: a session of its own, with the same prompt first
  const sessions = runtime.store
    .children(runtime.session.id)
    .filter((child) => child.title === 'workflow: answer late');
  assert.equal(sessions.length, 3);
  for (const request of requestsOf(model, 'answer late'))
    assert.deepEqual(
      request.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content),
      ['answer late'],
    );
  assert.equal(requestsOf(model, 'never answer').length, 6);
  assert.equal(view!.agents[1]!.error, 'agent stalled on all 6 attempts');
});

test('at most so many agents of a run work at once, and the rest wait their turn', async (t) => {
  const paths = folders(t);
  envFor(t, 'CIRCLE_WORKFLOW_MAX_CONCURRENT_AGENTS')('3');
  let working = 0;
  let most = 0;
  const gate = deferred();
  const busy: AskerReply = async () => {
    working++;
    most = Math.max(most, working);
    await gate.promise;
    working--;
    return reply('done');
  };
  const prompts = Array.from({ length: 7 }, (_, at) => `item ${at}`);
  const script =
    META('fan') +
    `const results = await pipeline(${JSON.stringify(prompts)}, (prompt) => agent(prompt))
return results.length`;
  const model = modelByAsker({
    go: [workflowCall('w1', { script }), reply('started')],
    ...Object.fromEntries(prompts.map((prompt) => [prompt, [busy]])),
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.initialize();
  await runtime.harness.run('go');
  const { job } = started(runtime, 'w1');
  await until(() => working === 3);
  // The others wait for a place; none has asked its model yet
  const view = () => runtime.workflowRunViews()[0]!;
  assert.deepEqual(
    view().agents.map((agent) => agent.state),
    ['running', 'running', 'running', 'queued', 'queued', 'queued', 'queued'],
  );
  gate.open();
  assert.equal((await finished(runtime, job)).status, 'done');
  assert.equal(most, 3);
  assert.equal(
    view().agents.filter((agent) => agent.state === 'done').length,
    7,
  );
});

test('a subagent cannot start a workflow: it is not offered one, and a call it makes anyway is refused', async (t) => {
  const paths = folders(t);
  const model = modelByAsker({
    go: [
      reply('', [
        {
          id: 't1',
          name: 'task',
          args: {
            description: 'try a workflow',
            subagent_type: 'general-purpose',
          },
        },
      ]),
      reply('done'),
    ],
    'try a workflow': [
      workflowCall('inner', { script: META('inner') + 'return 1' }),
      reply('could not'),
    ],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.initialize();
  await runtime.harness.run('go');
  const child = runtime.store.children(runtime.session.id)[0]!;
  assert.ok(
    !requestsOf(model, 'try a workflow')[0]!.tools.some(
      (tool) => tool.name === 'workflow',
    ),
  );
  assert.match(
    resultOf(runtime, 'inner', child.id),
    /tool is not available: workflow/,
  );
  assert.equal(runtime.jobs.list().length, 0);
});

test('manual and accept-edits ask before every run, auto starts it at once, and the card shows the phases and the script', async (t) => {
  const paths = folders(t);
  const script =
    META('checked', ['Find', 'Check']) + `phase('Find')\nreturn 'ok'\n`;
  const { ScriptedModel } = await import('../src/testing.js');
  const model = new ScriptedModel([
    workflowCall('a1', { script }),
    reply('not run'),
    workflowCall('a2', { script }),
    reply('started'),
    workflowCall('a3', { script }),
    reply('started'),
    workflowCall('a4', { script }),
    reply('started'),
    workflowCall('a5', { script }),
    reply('started'),
  ]);
  const asked: import('../src/types.js').ToolCall[] = [];
  const answers = ['reject', 'approve', 'approve'];
  const runtime = runtimeFor(t, paths, model, {
    yolo: false,
    approve: async (call) => {
      asked.push(call);
      return answers.shift() as 'approve' | 'reject';
    },
  });
  await runtime.initialize();
  const id = runtime.session.id;
  // Manual: a no stops it, a yes starts it
  await runtime.harness.run('first');
  assert.match(resultOf(runtime, 'a1'), /^The user rejected this tool call\./);
  assert.equal(runtime.jobs.list().length, 0);
  await runtime.harness.run('second');
  assert.match(resultOf(runtime, 'a2'), /^Workflow checked started as run w/);
  // Accept-edits asks as well
  runtime.policy.setMode(id, 'accept-edits');
  await runtime.harness.run('third');
  assert.equal(asked.length, 3);
  // Auto: no card, the first run or any other
  runtime.policy.setMode(id, 'auto');
  await runtime.harness.run('fourth');
  await runtime.harness.run('fifth');
  assert.equal(asked.length, 3);
  assert.match(resultOf(runtime, 'a4'), /^Workflow checked started as run w/);
  assert.match(resultOf(runtime, 'a5'), /^Workflow checked started as run w/);
  // The card: what the script's meta says, the script itself, and no yes to keep for a script written in the call
  const card = approvalRequest(
    asked[0]!,
    runtime.policy.review('workflow', asked[0]!.args),
  );
  assert.equal(card.tool, 'workflow');
  assert.match(card.body, /^checked · Run checked\nphases: Find, Check\n/);
  assert.equal(card.scope, '');
  assert.deepEqual(
    card.preview!.map((row) => row.text),
    [
      'script, 3 lines',
      `  1  ${script.split('\n')[0]}`,
      "  2  phase('Find')",
      "  3  return 'ok'",
    ],
  );
});

test('a workflow run by its name can be allowed for the rest of the conversation, and a script written in the call cannot', async (t) => {
  const paths = folders(t);
  mkdirSync(join(paths.workspace, '.circle', 'workflows'), { recursive: true });
  writeFileSync(
    join(paths.workspace, '.circle', 'workflows', 'saved.js'),
    META('saved-one') + 'return 1',
  );
  const inline = META('inline') + 'return 2';
  const { ScriptedModel } = await import('../src/testing.js');
  const model = new ScriptedModel(
    [
      workflowCall('s1', { name: 'saved-one' }),
      workflowCall('s2', { name: 'saved-one' }),
      workflowCall('s3', { script: inline }),
      workflowCall('s4', { script: inline }),
    ].flatMap((call) => [call, reply('ok')]),
  );
  const asked: import('../src/types.js').ToolCall[] = [];
  const answers = ['always', 'approve', 'approve'];
  const runtime = runtimeFor(t, paths, model, {
    yolo: false,
    approve: async (call) => {
      asked.push(call);
      return answers.shift() as 'always' | 'approve';
    },
  });
  await runtime.initialize();
  // The card for a saved workflow offers to allow it for the session, by its name
  const named = approvalRequest(
    { id: 'x', name: 'workflow', args: { name: 'saved-one' } },
    runtime.policy.review('workflow', { name: 'saved-one' }),
  );
  assert.equal(named.scope, 'the workflow saved-one');
  // Allowed for the session, the next run of it starts without a card
  await runtime.harness.run('one');
  await runtime.harness.run('two');
  assert.equal(asked.length, 1);
  assert.match(resultOf(runtime, 's2'), /^Workflow saved-one started/);
  // A script written in the call is new each time: its card offers no yes to keep, and every run asks
  assert.equal(
    approvalRequest(
      { id: 'y', name: 'workflow', args: { script: inline } },
      runtime.policy.review('workflow', { script: inline }),
    ).scope,
    '',
  );
  await runtime.harness.run('three');
  await runtime.harness.run('four');
  assert.equal(asked.length, 3);
  assert.match(resultOf(runtime, 's4'), /^Workflow inline started/);
  for (const run of runtime.workflowRunViews())
    if (run.job) await finished(runtime, run.job);
});

test('in read-only mode a workflow asks in every mode and starts only on a yes or a rule, never on a hook alone, and its agents change nothing', async (t) => {
  const paths = folders(t);
  const script =
    META('reader') +
    `const wrote = await agent('write notes.md')\nreturn wrote\n`;
  const write = reply('', [
    {
      id: 'wf-write',
      name: 'write_file',
      args: { file_path: 'notes.md', content: 'notes' },
    },
  ]);
  const model = modelByAsker({
    go: [
      workflowCall('r1', { script }),
      reply('ok'),
      workflowCall('r2', { script }),
      reply('ok'),
      workflowCall('r3', { script }),
      reply('ok'),
      // The turn the run's notice starts
      reply('noted'),
    ],
    'write notes.md': [
      write,
      (request) => {
        // The agent's write was refused, as the conversation's would be
        const result = request.messages.at(-1)!;
        assert.equal(result.tool_call_id, 'wf-write');
        assert.match(result.content, /read-only mode: this tool cannot run/);
        return reply('could not write');
      },
    ],
  });
  const asked: import('../src/types.js').ToolCall[] = [];
  const runtime = runtimeFor(t, paths, model, {
    approve: async (call) => {
      asked.push(call);
      return 'reject';
    },
  });
  await runtime.initialize();
  // Auto mode, and read-only on top of it
  runtime.setPlanMode(true);
  // A PreToolUse hook that allows every workflow does not start one here: the card asks
  const allow = join(paths.root, 'allow.mjs');
  writeFileSync(
    allow,
    `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }))`,
  );
  writeFileSync(
    join(paths.home, 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'workflow',
            hooks: [
              {
                type: 'command',
                command: `${JSON.stringify(process.execPath)} ${JSON.stringify(allow)}`,
              },
            ],
          },
        ],
      },
    }),
  );
  await runtime.reloadIntegrations();
  for (const prompt of ['go', 'go']) await runtime.harness.run(prompt);
  assert.equal(asked.length, 2);
  assert.match(resultOf(runtime, 'r1'), /^The user rejected this tool call\./);
  assert.match(resultOf(runtime, 'r2'), /^The user rejected this tool call\./);
  assert.equal(runtime.jobs.list().length, 0);
  // A rule in the person's file starts it without a card, and its agent works in read-only mode
  writeFileSync(
    join(paths.home, 'approvals.json'),
    JSON.stringify({
      rules: [{ tool: 'workflow', pattern: '*', effect: 'allow' }],
    }),
  );
  await runtime.harness.run('go');
  assert.equal(asked.length, 2);
  const { job } = started(runtime, 'r3');
  await finished(runtime, job);
  assert.equal(existsSync(join(paths.workspace, 'notes.md')), false);
  const run = runtime.workflowRunViews().find((view) => view.job === job)!;
  assert.equal(
    readFileSync(
      join(runtime.workflowRunsFolder, run.id, 'result.txt'),
      'utf8',
    ),
    'could not write',
  );
});

test('without anyone to ask, a run needs an allow rule, a hook that allows it or --yolo, and a deny rule refuses it in every mode', async (t) => {
  const paths = folders(t);
  mkdirSync(join(paths.workspace, '.circle', 'workflows'), { recursive: true });
  writeFileSync(
    join(paths.workspace, '.circle', 'workflows', 'saved.js'),
    META('saved-one') + 'return args',
  );
  const inline = META('inline') + 'return 1';
  const { ScriptedModel } = await import('../src/testing.js');
  const model = new ScriptedModel(
    [
      workflowCall('n1', { script: inline }),
      workflowCall('n2', { script: inline }),
      workflowCall('n3', { name: 'saved-one', args: ['x'] }),
      workflowCall('n4', { script: inline }),
      workflowCall('n5', { script: inline }),
      workflowCall('n6', { script: inline }),
      workflowCall('n7', { script: inline }),
    ].flatMap((call) => [call, reply('ok')]),
  );
  const runtime = runtimeFor(t, paths, model, { yolo: false, headless: true });
  await runtime.initialize();
  const rules = (list: unknown[]) =>
    writeFileSync(
      join(paths.home, 'approvals.json'),
      JSON.stringify({ rules: list }),
    );
  // Nothing allows it: not run
  await runtime.harness.run('one');
  assert.equal(resultOf(runtime, 'n1'), 'not run: needs --yolo or approval');
  // A rule for every workflow
  rules([{ tool: 'workflow', pattern: '*', effect: 'allow' }]);
  await runtime.harness.run('two');
  assert.match(resultOf(runtime, 'n2'), /^Workflow inline started/);
  // A rule for one saved workflow, by its name, allows that one and no script written for the task
  rules([{ tool: 'workflow', pattern: 'saved-one', effect: 'allow' }]);
  await runtime.harness.run('three');
  assert.match(resultOf(runtime, 'n3'), /^Workflow saved-one started/);
  await runtime.harness.run('four');
  assert.equal(resultOf(runtime, 'n4'), 'not run: needs --yolo or approval');
  // A PreToolUse hook's allow is the person's host saying yes
  rules([]);
  const allow = join(paths.root, 'allow.mjs');
  writeFileSync(
    allow,
    `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }))`,
  );
  writeFileSync(
    join(paths.home, 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'workflow',
            hooks: [
              {
                type: 'command',
                command: `${JSON.stringify(process.execPath)} ${JSON.stringify(allow)}`,
              },
            ],
          },
        ],
      },
    }),
  );
  await runtime.reloadIntegrations();
  await runtime.harness.run('five');
  assert.match(resultOf(runtime, 'n5'), /^Workflow inline started/);
  writeFileSync(join(paths.home, 'settings.json'), JSON.stringify({}));
  await runtime.reloadIntegrations();
  // --yolo
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('six');
  assert.match(resultOf(runtime, 'n6'), /^Workflow inline started/);
  // A deny holds in auto mode too
  rules([{ tool: 'workflow', pattern: '*', effect: 'deny' }]);
  await runtime.harness.run('seven');
  assert.equal(
    resultOf(runtime, 'n7'),
    'refused by your approvals.json: workflow "*" is denied',
  );
  const runs = runtime.workflowRunViews();
  assert.deepEqual(runs.map((run) => run.name).sort(), [
    'inline',
    'inline',
    'inline',
    'saved-one',
  ]);
  for (const run of runs) if (run.job) await finished(runtime, run.job);
  const saved = runtime
    .workflowRunViews()
    .find((run) => run.name === 'saved-one')!;
  assert.equal(
    readFileSync(
      join(runtime.workflowRunsFolder, saved.id, 'result.txt'),
      'utf8',
    ),
    '[\n  "x"\n]',
  );
});

test('a relaunch hands back saved results up to the first agent that failed or changed, and runs it and every one after it again', async (t) => {
  const paths = folders(t);
  const script =
    META('three') +
    `const a = await agent('one')
const b = await agent('two')
const c = await agent('three')
return [a, b, c]
`;
  let relaunched = '';
  const model = modelByAsker({
    go: [
      workflowCall('r1', { script }),
      reply('started'),
      // The same script again, from its run's own copy
      (request) =>
        workflowCall('r2', {
          resume_from_run_id: /as run (w[0-9a-f]{8})/.exec(
            request.messages.find((message) => message.tool_call_id === 'r1')!
              .content,
          )![1],
        }),
      reply('relaunched'),
      (request) => {
        relaunched = /as run (w[0-9a-f]{8})/.exec(
          request.messages.find((message) => message.tool_call_id === 'r2')!
            .content,
        )![1]!;
        return workflowCall('r3', {
          script_path: `/workflow_runs/${relaunched}/script.js`,
          resume_from_run_id: relaunched,
        });
      },
      reply('relaunched after the edit'),
      workflowCall('r4', { resume_from_run_id: 'w00000000' }),
      reply('nothing'),
    ],
    one: [reply('A1')],
    two: [
      () => {
        throw Object.assign(new Error('the endpoint failed'), { status: 400 });
      },
      reply('B2'),
    ],
    three: [reply('C1'), reply('C2')],
    'three, again': [reply('C3')],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.initialize();
  const result = (run: string) =>
    JSON.parse(
      readFileSync(join(runtime.workflowRunsFolder, run, 'result.txt'), 'utf8'),
    );
  await runtime.harness.run('go');
  const first = started(runtime, 'r1');
  await finished(runtime, first.job);
  // The agent whose model failed gave null, and the run went on
  assert.deepEqual(result(first.run), ['A1', null, 'C1']);
  assert.equal(runtime.workflowRunViews()[0]!.agents[1]!.state, 'failed');
  // Unedited: one comes back saved; two failed, so it and three run again
  await runtime.harness.run('go on');
  const second = started(runtime, 'r2');
  await finished(runtime, second.job);
  assert.deepEqual(result(second.run), ['A1', 'B2', 'C2']);
  assert.equal(requestsOf(model, 'one').length, 1);
  assert.equal(requestsOf(model, 'three').length, 2);
  assert.deepEqual(
    runtime
      .workflowRunViews()
      .find((run) => run.id === second.run)!
      .agents.map((agent) => agent.state),
    ['cached', 'done', 'done'],
  );
  // Edited: the agents before the change come back saved, and the changed one runs
  const copy = join(runtime.workflowRunsFolder, second.run, 'script.js');
  writeFileSync(
    copy,
    readFileSync(copy, 'utf8').replace(
      "agent('three')",
      "agent('three, again')",
    ),
  );
  await runtime.harness.run('edit');
  const third = started(runtime, 'r3');
  await finished(runtime, third.job);
  assert.equal(relaunched, second.run);
  assert.deepEqual(result(third.run), ['A1', 'B2', 'C3']);
  assert.equal(requestsOf(model, 'one').length, 1);
  assert.equal(requestsOf(model, 'two').length, 2);
  // A run this conversation does not have
  await runtime.harness.run('again');
  assert.equal(
    resultOf(runtime, 'r4'),
    'nothing to resume: this conversation has no workflow run w00000000',
  );
});

test('an unedited relaunch hands back every saved result even when agents ended in another order than they started', async (t) => {
  const paths = folders(t);
  // The scenario needs two agents working at once: the first stage of one item is
  // still running while the other item goes through both of its stages. A machine
  // whose workflow limit works out to one could never show that order.
  envFor(t, 'CIRCLE_WORKFLOW_MAX_CONCURRENT_AGENTS')('2');
  const script =
    META('two-stages') +
    `return await pipeline(['a', 'b'],
  (item) => agent('first ' + item),
  (previous, item) => agent('second ' + item + ' after ' + previous))
`;
  // a's first stage ends only after b's item has gone through both stages
  const b = deferred();
  const model = modelByAsker({
    go: [
      workflowCall('p1', { script }),
      reply('started'),
      (request) =>
        workflowCall('p2', {
          resume_from_run_id: /as run (w[0-9a-f]{8})/.exec(
            request.messages.find((message) => message.tool_call_id === 'p1')!
              .content,
          )![1],
        }),
      reply('relaunched'),
    ],
    'first a': [after(b.promise, reply('A'))],
    'first b': [reply('B')],
    'second b after B': [reply('BB')],
    'second a after A': [reply('AA')],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.initialize();
  await runtime.harness.run('go');
  const first = started(runtime, 'p1');
  await until(() => runtime.workflowRunViews()[0]?.agents[2]?.state === 'done');
  b.open();
  await finished(runtime, first.job);
  const journal = readJournal(
    join(runtime.workflowRunsFolder, first.run, 'journal.jsonl'),
  );
  assert.deepEqual(
    journal.map((event) => `${event.t} ${event.i}`),
    [
      'start 0',
      'start 1',
      'end 1',
      'start 2',
      'end 2',
      'end 0',
      'start 3',
      'end 3',
    ],
  );
  await runtime.harness.run('again');
  const second = started(runtime, 'p2');
  await finished(runtime, second.job);
  // No agent asked its model again: every one came back saved, in the order it came then
  for (const prompt of [
    'first a',
    'first b',
    'second b after B',
    'second a after A',
  ])
    assert.equal(requestsOf(model, prompt).length, 1, prompt);
  assert.equal(
    readFileSync(
      join(runtime.workflowRunsFolder, second.run, 'result.txt'),
      'utf8',
    ),
    '[\n  "AA",\n  "BB"\n]',
  );
  assert.deepEqual(
    readJournal(
      join(runtime.workflowRunsFolder, second.run, 'journal.jsonl'),
    ).map((event) => `${event.t} ${event.i}`),
    journal.map((event) => `${event.t} ${event.i}`),
  );
});

test('a stopped run stops its agents; a relaunch waits until it has ended, then starts over the agent that was still running', async (t) => {
  const paths = folders(t);
  const script =
    META('stoppable') +
    `const a = await agent('quick')
const b = await agent('stuck')
return [a, b]
`;
  let runId = '';
  const model = modelByAsker({
    go: [
      workflowCall('s1', { script }),
      reply('started'),
      () => workflowCall('s2', { resume_from_run_id: runId }),
      reply('not yet'),
      () => workflowCall('s3', { resume_from_run_id: runId }),
      reply('relaunched'),
    ],
    quick: [reply('Q')],
    stuck: [hang, reply('S')],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.initialize();
  await runtime.harness.run('go');
  const first = started(runtime, 's1');
  runId = first.run;
  await until(() => requestsOf(model, 'stuck').length === 1);
  await runtime.harness.run('relaunch now');
  assert.match(
    resultOf(runtime, 's2'),
    /^run w[0-9a-f]{8} is still running, or its agents have not exited yet/,
  );
  assert.equal(await runtime.stopWorkflow(first.run), true);
  const stopped = await finished(runtime, first.job);
  assert.equal(stopped.status, 'stopped');
  const view = runtime.workflowRunViews().find((run) => run.id === first.run)!;
  assert.equal(view.status, 'stopped');
  assert.deepEqual(
    view.agents.map((agent) => agent.state),
    ['done', 'stopped'],
  );
  await runtime.harness.run('relaunch');
  const second = started(runtime, 's3');
  await finished(runtime, second.job);
  assert.equal(
    readFileSync(
      join(runtime.workflowRunsFolder, second.run, 'result.txt'),
      'utf8',
    ),
    '[\n  "Q",\n  "S"\n]',
  );
  assert.equal(requestsOf(model, 'quick').length, 1);
  assert.equal(requestsOf(model, 'stuck').length, 2);
});

test('saved workflows come from the project, the data folder and installed packs, by name, and the tool lists them', async (t) => {
  const paths = folders(t);
  const write = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  };
  write(
    join(paths.home, 'workflows', 'audit.js'),
    `export const meta = { name: 'audit', description: 'mine' }\nreturn 'mine'`,
  );
  write(
    join(paths.workspace, '.circle', 'workflows', 'audit.js'),
    `export const meta = { name: 'audit', description: 'the project audit', whenToUse: 'before a release' }\nreturn 'project'`,
  );
  write(
    join(paths.home, 'workflows', 'extra.js'),
    `export const meta = { name: 'extra', description: 'one more' }\nreturn 1`,
  );
  write(join(paths.home, 'workflows', 'broken.js'), `return 'no meta'`);
  write(
    join(paths.packs, 'acme', 'pack.json'),
    JSON.stringify({ name: 'acme' }),
  );
  write(
    join(paths.packs, 'acme', 'workflows', 'release.js'),
    `export const meta = { name: 'release', description: 'release checks' }\nreturn { asked: args }`,
  );
  // A folder without pack.json is no pack
  write(
    join(paths.packs, 'loose', 'workflows', 'x.js'),
    `export const meta = { name: 'x', description: 'no pack' }\nreturn 1`,
  );
  const model = modelByAsker({
    go: [
      workflowCall('d1', { name: 'acme:release', args: { version: '1.18.0' } }),
      reply('started'),
    ],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.initialize();
  const found = runtime.savedWorkflows();
  assert.deepEqual(
    found.workflows.map((workflow) => [
      workflow.name,
      workflow.source_label,
      workflow.meta.description,
    ]),
    [
      ['acme:release', 'Pack acme', 'release checks'],
      ['audit', 'Project Circle', 'the project audit'],
      ['extra', 'Circle', 'one more'],
    ],
  );
  assert.equal(found.problems.length, 1);
  assert.match(
    found.problems[0]!,
    /broken\.js: a workflow script begins with export const meta/,
  );
  await runtime.harness.run('go');
  const description = model.requests[0]!.tools.find(
    (tool) => tool.name === 'workflow',
  )!.description;
  assert.match(
    description,
    /\n\nSaved workflows:\n- acme:release: release checks\n- audit: the project audit Use when: before a release\n- extra: one more$/,
  );
  const { run, job } = started(runtime, 'd1');
  await finished(runtime, job);
  assert.equal(
    readFileSync(join(runtime.workflowRunsFolder, run, 'result.txt'), 'utf8'),
    '{\n  "asked": {\n    "version": "1.18.0"\n  }\n}',
  );
  // The run keeps the script it ran, and a missing name says what there is
  assert.ok(existsSync(join(runtime.workflowRunsFolder, run, 'script.js')));
});

test('a run is a job of the conversation: its call shows as in background, send_to_job refuses it, and Stop hooks hear it as a workflow', async (t) => {
  const paths = folders(t);
  const heard = recorder(paths.root, 'stop', `input.background_tasks`);
  writeFileSync(
    join(paths.home, 'settings.json'),
    JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: heard }] }] },
    }),
  );
  const gate = deferred();
  const model = modelByAsker({
    go: [
      workflowCall('w1', {
        script: META('held') + `return await agent('wait here')`,
      }),
      reply('', [
        {
          id: 'send',
          name: 'send_to_job',
          args: { job_id: 'j1', message: 'hurry' },
        },
      ]),
      reply('started'),
    ],
    'wait here': [after(gate.promise, reply('done waiting'))],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.initialize();
  await runtime.harness.run('go');
  const { job } = started(runtime, 'w1');
  assert.equal(job, 'j1');
  const { backgroundJob } = await import('../src/tui/tool_rows.js');
  const message = runtime.store
    .messages(runtime.session.id)
    .find((item) => item.tool_call_id === 'w1')!;
  assert.deepEqual(backgroundJob(message), {
    id: 'j1',
    how: 'started',
    text: '',
  });
  assert.equal(
    resultOf(runtime, 'send'),
    'j1 is a workflow run: a message is for a subagent',
  );
  assert.deepEqual(lines(paths.root, 'stop'), [
    [
      {
        id: 'j1',
        type: 'workflow',
        status: 'running',
        description: 'workflow held',
        name: 'held',
      },
    ],
  ]);
  gate.open();
  assert.equal((await finished(runtime, job)).status, 'done');
});

test('an agent whose reply the model layer gave up on starts over as one that stalled does', async (t) => {
  const paths = folders(t);
  const lost = () => {
    throw Object.assign(new Error('no content from the model for 180s'), {
      name: 'StreamStalled',
    });
  };
  const model = modelByAsker({
    go: [
      workflowCall('w1', {
        script: META('lossy') + `return await agent('reply once')`,
      }),
      reply('started'),
    ],
    'reply once': [lost, reply('here it is')],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.initialize();
  await runtime.harness.run('go');
  const { run, job } = started(runtime, 'w1');
  assert.equal((await finished(runtime, job)).status, 'done');
  assert.equal(
    readFileSync(join(runtime.workflowRunsFolder, run, 'result.txt'), 'utf8'),
    'here it is',
  );
  const [agent] = runtime.workflowRunViews()[0]!.agents;
  assert.equal(agent!.attempt, 2);
  assert.deepEqual(agent!.endings, ['lost its reply']);
});

test('an agent of a workflow takes the skills its definition names, not those the conversation has loaded', async (t) => {
  const paths = folders(t);
  for (const [name, text] of [
    ['loaded', 'Follow the loaded checklist.'],
    ['named', 'Follow the named checklist.'],
  ] as const) {
    const dir = join(paths.home, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Skill ${name}\n---\n${text}\n`,
    );
  }
  mkdirSync(join(paths.home, 'agents'), { recursive: true });
  writeFileSync(
    join(paths.home, 'agents', 'checker.md'),
    '---\nname: checker\ndescription: The checker agent.\nskills:\n  - named\n---\nYou are checker.\n',
  );
  const model = modelByAsker({
    go: [
      reply('', [{ id: 'load', name: 'skill', args: { name: 'loaded' } }]),
      workflowCall('w1', {
        script:
          META('one-check') +
          `return await agent('check it', { agentType: 'checker' })`,
      }),
      reply('started'),
    ],
    'check it': [reply('checked')],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.initialize();
  await runtime.harness.run('go');
  const { job } = started(runtime, 'w1');
  assert.equal((await finished(runtime, job)).status, 'done');
  const users = requestsOf(model, 'check it')[0]!
    .messages.filter((message) => message.role === 'user')
    .map((message) => message.content);
  assert.ok(users.some((text) => text.includes('Follow the named checklist.')));
  assert.ok(
    !users.some((text) => text.includes('Follow the loaded checklist.')),
    'the conversation’s skill is not carried to each agent of a run',
  );
});
