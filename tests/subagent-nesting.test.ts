import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentRuntime,
  maxConcurrentSubagents,
  maxSubagentDepth,
} from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import type { ScriptedModel } from '../src/testing.js';
import { emptyUsage, type Message, type ModelResponse } from '../src/types.js';
import { askedBy, cleanup, modelByAsker, scratch, until } from './helpers.js';

// Subagents that start subagents of their own, the limits on how deep and how many, and who each layer is

const reply = (
  content: string,
  calls: Message['tool_calls'] = [],
  usage = emptyUsage(),
): ModelResponse => ({
  message: {
    id: crypto.randomUUID(),
    role: 'assistant',
    content,
    ...(calls.length ? { tool_calls: calls } : {}),
  },
  usage,
});
const task = (
  id: string,
  description: string,
  subagent_type = 'general-purpose',
  extra: Record<string, unknown> = {},
) => ({
  id,
  name: 'task',
  args: { description, subagent_type, ...extra },
});
/** Home, workspace and user home, none of them the person's own. */
function folders(t: Parameters<typeof scratch>[0]) {
  const root = realpathSync(scratch(t));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const userHome = join(root, 'user');
  for (const path of [home, workspace, userHome])
    mkdirSync(path, { recursive: true });
  return { root, home, workspace, userHome };
}
function runtimeFor(
  t: Parameters<typeof scratch>[0],
  paths: ReturnType<typeof folders>,
  model: ScriptedModel,
) {
  const runtime = new AgentRuntime({
    home: paths.home,
    workspace: paths.workspace,
    userHome: paths.userHome,
    settings: defaultSettings(),
    model,
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  return runtime;
}
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
/** A script that appends one JSON line per run of what it was told, in any system shell. */
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
const toolsOf = (model: ScriptedModel, key: string): string[] =>
  model.requests
    .find((request) => askedBy(request, key))!
    .tools.map((tool) => tool.name);
/** The result a session's tool call got. */
const resultIn = (runtime: AgentRuntime, sessionId: string, id: string) =>
  runtime.store
    .messages(sessionId)
    .find((message) => message.tool_call_id === id)?.content ?? '';

test('the limits read their variables, and a value that is no positive whole number keeps the default', () => {
  assert.equal(maxSubagentDepth({}), 3);
  assert.equal(maxSubagentDepth({ CIRCLE_MAX_SUBAGENT_SPAWN_DEPTH: '1' }), 1);
  assert.equal(maxSubagentDepth({ CIRCLE_MAX_SUBAGENT_SPAWN_DEPTH: '0' }), 3);
  assert.equal(maxSubagentDepth({ CIRCLE_MAX_SUBAGENT_SPAWN_DEPTH: 'x' }), 3);
  assert.equal(maxConcurrentSubagents({}), 20);
  assert.equal(
    maxConcurrentSubagents({ CIRCLE_MAX_CONCURRENT_SUBAGENTS: '7' }),
    7,
  );
  assert.equal(
    maxConcurrentSubagents({ CIRCLE_MAX_CONCURRENT_SUBAGENTS: '2.5' }),
    20,
  );
});

test('a subagent starts subagents of its own three layers deep, each layer works for the conversation, and only the top report comes back', async (t) => {
  const paths = folders(t);
  const { root, home } = paths;
  // The conversation's hooks hear every layer: tool calls and starts
  const heard = recorder(
    root,
    'hook',
    `{ event: input.hook_event_name, tool: input.tool_name ?? null, session_id: input.session_id, agent_id: input.agent_id ?? null, agent_type: input.agent_type ?? null, env: process.env.CIRCLE_AGENT_ID ?? null }`,
  );
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'execute',
            hooks: [{ type: 'command', command: heard }],
          },
        ],
        SubagentStart: [{ hooks: [{ type: 'command', command: heard }] }],
      },
    }),
  );
  const command = recorder(
    root,
    'command',
    `[process.env.CIRCLE_SESSION_ID ?? null, process.env.CIRCLE_AGENT_ID ?? null]`,
  );
  const usage = { ...emptyUsage(), input_tokens: 700, output_tokens: 7 };
  const model = modelByAsker({
    go: [reply('', [task('t1', 'layer one')]), reply('all done')],
    'layer one': [reply('', [task('t2', 'layer two')]), reply('one done')],
    'layer two': [reply('', [task('t3', 'layer three')]), reply('two done')],
    'layer three': [
      reply('', [{ id: 'cmd', name: 'execute', args: { command } }]),
      reply('three done', [], usage),
    ],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.initialize();
  const result = await runtime.harness.run('go');
  assert.equal(result.answer, 'all done');

  // What each layer was offered: task above the limit, not at it, and never the conversation's own tools
  const main = toolsOf(model, 'go');
  assert.ok(main.includes('task') && main.includes('question'));
  for (const layer of ['layer one', 'layer two', 'layer three']) {
    const offered = toolsOf(model, layer);
    for (const tool of [
      'question',
      'plan_enter',
      'plan_exit',
      'compact_conversation',
    ])
      assert.ok(!offered.includes(tool), `${layer} has no ${tool}`);
    assert.equal(offered.includes('task'), layer !== 'layer three', layer);
  }
  // A subagent's own task runs what it starts in the foreground: it is not offered background
  const nested = model.requests
    .find((request) => askedBy(request, 'layer one'))!
    .tools.find((tool) => tool.name === 'task')!;
  assert.ok(
    !Object.hasOwn(
      (nested.parameters as { properties: object }).properties,
      'background',
    ),
  );
  const top = model.requests
    .find((request) => askedBy(request, 'go'))!
    .tools.find((tool) => tool.name === 'task')!;
  assert.ok(
    Object.hasOwn(
      (top.parameters as { properties: object }).properties,
      'background',
    ),
  );

  // Each layer is a session under the one that started it, listed by it
  const conversation = runtime.session.id;
  const [one] = runtime.store.children(conversation);
  const [two] = runtime.store.children(one!.id);
  const [three] = runtime.store.children(two!.id);
  assert.ok(one && two && three);
  assert.deepEqual(runtime.store.contextState(one.id).subagentSessionIds, [
    two.id,
  ]);
  // Each spawner got the report of the one it started; the conversation only the top one
  assert.match(resultIn(runtime, two.id, 't3'), /three done/);
  assert.match(resultIn(runtime, one.id, 't2'), /two done/);
  assert.equal(resultIn(runtime, conversation, 't1'), 'one done');
  assert.doesNotMatch(
    JSON.stringify(runtime.store.messages(conversation)),
    /three done|two done/,
  );

  // Hooks hear the conversation's session at every depth, with the layer's own as the agent
  const hooks = lines(root, 'hook');
  assert.deepEqual(
    hooks
      .filter((line) => line.event === 'SubagentStart')
      .map((line) => [line.session_id, line.agent_id, line.agent_type]),
    [
      [conversation, one.id, 'general-purpose'],
      [conversation, two.id, 'general-purpose'],
      [conversation, three.id, 'general-purpose'],
    ],
  );
  assert.deepEqual(
    hooks.filter((line) => line.event === 'PreToolUse'),
    [
      {
        event: 'PreToolUse',
        tool: 'execute',
        session_id: conversation,
        agent_id: three.id,
        agent_type: 'general-purpose',
        env: three.id,
      },
    ],
  );
  // And so is the command the deepest layer ran
  assert.deepEqual(lines(root, 'command'), [[conversation, three.id]]);
  // What the deepest layer cost counts in the conversation's total
  assert.equal(runtime.stats().usage.input_tokens, 700);
});

test('CIRCLE_MAX_SUBAGENT_SPAWN_DEPTH sets how many layers there are, and 1 turns nesting off', async (t) => {
  const depth = envFor(t, 'CIRCLE_MAX_SUBAGENT_SPAWN_DEPTH');
  for (const [limit, deepest] of [
    ['2', 'layer two'],
    ['1', 'layer one'],
  ] as const) {
    depth(limit);
    const paths = folders(t);
    const model = modelByAsker({
      go: [reply('', [task('t1', 'layer one')]), reply('all done')],
      'layer one':
        deepest === 'layer one'
          ? [reply('one done')]
          : [reply('', [task('t2', 'layer two')]), reply('one done')],
      'layer two': [reply('two done')],
    });
    const runtime = runtimeFor(t, paths, model);
    await runtime.harness.run('go');
    for (const layer of ['layer one', 'layer two'])
      if (model.requests.some((request) => askedBy(request, layer)))
        assert.equal(
          toolsOf(model, layer).includes('task'),
          layer !== deepest,
          `${layer} with ${limit} layers`,
        );
    assert.equal(
      model.requests.some((request) => askedBy(request, 'layer two')),
      deepest === 'layer two',
    );
  }
});

test('a definition that always runs in the background does so when the conversation starts it, and in the foreground under a subagent', async (t) => {
  const paths = folders(t);
  mkdirSync(join(paths.home, 'agents'));
  writeFileSync(
    join(paths.home, 'agents', 'watcher.md'),
    '---\nname: watcher\ndescription: Watches.\nbackground: true\ntools: read_file\n---\nWatch.\n',
  );
  const model = modelByAsker({
    go: [
      reply('', [
        task('bg', 'watch alone', 'watcher'),
        task('fg', 'layer one'),
      ]),
      reply('started'),
    ],
    'watch alone': [reply('watched alone')],
    'layer one': [
      reply('', [task('inner', 'watch here', 'watcher')]),
      reply('one done'),
    ],
    'watch here': [reply('watched here')],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.harness.run('go');
  const conversation = runtime.session.id;
  // From the conversation it is a job, though the call did not ask for one
  assert.match(resultIn(runtime, conversation, 'bg'), /^In background: j\d+/);
  // A subagent waits for it: its report is the call's result
  const one = runtime.store
    .children(conversation)
    .find((child) => child.title.startsWith('general-purpose'))!;
  assert.equal(resultIn(runtime, one.id, 'inner'), 'watched here');
  await until(() =>
    runtime.jobs.list().every((job) => job.status !== 'running'),
  );
});

test('at the concurrent limit a task call fails and says not to retry; past four background subagents is no limit of its own, and a place frees when one ends', async (t) => {
  envFor(t, 'CIRCLE_MAX_CONCURRENT_SUBAGENTS')('5');
  const paths = folders(t);
  let open = false;
  const held: (() => void)[] = [];
  const release = (): void => {
    open = true;
    for (const go of held.splice(0)) go();
  };
  cleanup(t, release);
  const waiting = async (text: string): Promise<ModelResponse> => {
    if (!open) await new Promise<void>((go) => held.push(go));
    return reply(text);
  };
  const background = [1, 2, 3, 4, 5].map((index) =>
    task(`bg${index}`, `background ${index}`, 'general-purpose', {
      background: true,
    }),
  );
  const model = modelByAsker({
    go: [
      reply('', background),
      reply('', [task('sixth', 'one more')]),
      reply('waiting'),
      reply('', [task('later', 'once there is room')]),
      reply('done'),
    ],
    ...Object.fromEntries(
      [1, 2, 3, 4, 5].map((index) => [
        `background ${index}`,
        [() => waiting(`background ${index} done`)],
      ]),
    ),
    'once there is room': [reply('room')],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.harness.run('go');
  const conversation = runtime.session.id;
  for (const index of [1, 2, 3, 4, 5])
    assert.match(
      resultIn(runtime, conversation, `bg${index}`),
      /^In background: j\d+/,
    );
  const refused = resultIn(runtime, conversation, 'sixth');
  assert.match(refused, /Concurrent subagent limit reached/);
  assert.match(refused, /Do not retry/);
  // The refused one never started
  assert.ok(!model.requests.some((request) => askedBy(request, 'one more')));
  release();
  await until(() =>
    runtime.jobs.list().every((job) => job.status !== 'running'),
  );
  await runtime.harness.run('and again');
  assert.equal(resultIn(runtime, conversation, 'later'), 'room');
});

test("a subagent's card waits under the background job it works for, also the card of one it started", async (t) => {
  const paths = folders(t);
  const origins: (string | undefined)[] = [];
  const model = modelByAsker({
    go: [
      reply('', [
        task('bg', 'layer one', 'general-purpose', { background: true }),
      ]),
      reply('started'),
    ],
    'layer one': [reply('', [task('inner', 'layer two')]), reply('one done')],
    'layer two': [
      reply('', [
        {
          id: 'write',
          name: 'write_file',
          args: { file_path: 'notes.md', content: 'x' },
        },
      ]),
      reply('two done'),
    ],
  });
  const runtime = new AgentRuntime({
    home: paths.home,
    workspace: paths.workspace,
    userHome: paths.userHome,
    settings: defaultSettings(),
    model,
    approve: async (_call, _signal, origin) => {
      origins.push(origin?.jobId);
      return 'approve';
    },
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('go');
  await until(() => runtime.jobs.list()[0]?.status === 'done');
  const job = runtime.jobs.list()[0]!;
  assert.deepEqual(origins, [job.id]);
  assert.equal(
    readFileSync(join(paths.workspace, 'notes.md'), 'utf8'),
    'x',
    'the approved write ran',
  );
});

test("a subagent started under a background job is that job's work: every event it sends carries the job's id", async (t) => {
  const paths = folders(t);
  const model = modelByAsker({
    go: [
      reply('', [
        task('bg', 'layer one', 'general-purpose', { background: true }),
      ]),
      reply('started'),
    ],
    'layer one': [reply('', [task('inner', 'layer two')]), reply('one done')],
    'layer two': [
      reply('', [{ id: 'ls', name: 'ls', args: { path: '.' } }]),
      reply('two done'),
    ],
  });
  const runtime = runtimeFor(t, paths, model);
  const seen: { subagent: string; job: unknown }[] = [];
  runtime.bus.subscribe((event) => {
    if (event.tags.subagent)
      seen.push({
        subagent: String(event.tags.subagent),
        job: event.tags.job_id,
      });
  });
  await runtime.harness.run('go');
  await until(() => runtime.jobs.list()[0]?.status === 'done');
  const job = runtime.jobs.list()[0]!;
  const [one] = runtime.store.children(runtime.session.id);
  const [two] = runtime.store.children(one!.id);
  const of = (id: string) => seen.filter((event) => event.subagent === id);
  assert.ok(of(two!.id).length > 0, 'the nested subagent sent events');
  // So the terminal counts its work in the job's row, not in the person's turn
  assert.deepEqual(
    [...new Set(of(two!.id).map((event) => event.job))],
    [job.id],
  );
  assert.deepEqual(
    [...new Set(of(one!.id).map((event) => event.job))],
    [job.id],
  );
});
