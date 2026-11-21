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
import { AgentRuntime, subagentApproval } from '../src/runtime.js';
import { defaultSettings, type CircleSettings } from '../src/settings.js';
import { discoverSubagents } from '../src/subagent_files.js';
import type { ScriptedModel } from '../src/testing.js';
import { emptyUsage, type Message, type ModelResponse } from '../src/types.js';
import { askedBy, cleanup, modelByAsker, scratch } from './helpers.js';
import { mcpStub } from './mcp-stub.js';

// The keys of a subagent definition beyond its name, description, tools, model and effort

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
const task = (id: string, description: string, subagent_type: string) => ({
  id,
  name: 'task',
  args: { description, subagent_type },
});
const write = (id: string, file_path: string) => ({
  id,
  name: 'write_file',
  args: { file_path, content: 'x' },
});
function folders(t: Parameters<typeof scratch>[0]) {
  const root = realpathSync(scratch(t));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const userHome = join(root, 'user');
  for (const path of [home, workspace, userHome, join(home, 'agents')])
    mkdirSync(path, { recursive: true });
  return { root, home, workspace, userHome };
}
const agent = (
  folder: string,
  name: string,
  keys: string,
  prompt = `You are ${name}.`,
): void => {
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, `${name}.md`),
    `---\nname: ${name}\ndescription: The ${name} agent.\n${keys}---\n${prompt}\n`,
  );
};
function runtimeFor(
  t: Parameters<typeof scratch>[0],
  paths: ReturnType<typeof folders>,
  model: ScriptedModel,
  options: {
    settings?: CircleSettings;
    approve?: () => Promise<'approve'>;
  } = {},
) {
  const runtime = new AgentRuntime({
    home: paths.home,
    workspace: paths.workspace,
    userHome: paths.userHome,
    settings: options.settings ?? defaultSettings(),
    model,
    ...(options.approve ? { approve: options.approve } : {}),
  });
  cleanup(t, () => runtime.close());
  return runtime;
}
const toolsOf = (model: ScriptedModel, key: string): string[] =>
  model.requests
    .find((request) => askedBy(request, key))!
    .tools.map((tool) => tool.name);
const resultIn = (runtime: AgentRuntime, sessionId: string, id: string) =>
  runtime.store
    .messages(sessionId)
    .find((message) => message.tool_call_id === id)?.content ?? '';
/** The session a subagent of this type ran in. */
const sessionOf = (runtime: AgentRuntime, type: string): string =>
  runtime.store
    .children(runtime.session.id)
    .find((child) => child.title.startsWith(`${type}:`))!.id;
/** A script for a hook: what it was told goes to a file, one JSON line a run; `exit` ends it with that code. */
function hookScript(
  dir: string,
  name: string,
  line: string,
  exit?: { code: number; stderr: string },
): string {
  const script = join(dir, `${name}.mjs`);
  writeFileSync(
    script,
    `import { appendFileSync, readFileSync } from 'node:fs';
const input = (() => { try { return JSON.parse(readFileSync(0, 'utf8')); } catch { return {}; } })();
appendFileSync(${JSON.stringify(join(dir, `${name}.jsonl`))}, JSON.stringify(${line}) + '\\n');
${exit ? `process.stderr.write(${JSON.stringify(exit.stderr)}); process.exit(${exit.code});` : ''}
`,
  );
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
}
const lines = (dir: string, name: string) =>
  existsSync(join(dir, `${name}.jsonl`))
    ? readFileSync(join(dir, `${name}.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];

test('disallowedTools takes tools out of what a subagent is offered, after tools, and an entry with a pattern takes the whole tool', async (t) => {
  const paths = folders(t);
  const agents = join(paths.home, 'agents');
  agent(agents, 'nopush', 'disallowedTools: execute(git push *), write_file\n');
  agent(
    agents,
    'narrow',
    'tools: read_file, grep, write_file\ndisallowedTools: write_file\n',
  );
  const model = modelByAsker({
    go: [
      reply('', [
        task('a', 'no push', 'nopush'),
        task('b', 'narrow', 'narrow'),
      ]),
      reply('done'),
    ],
    'no push': [reply('ok')],
    narrow: [reply('ok')],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.harness.run('go');
  const nopush = toolsOf(model, 'no push');
  assert.ok(nopush.includes('read_file') && nopush.includes('task'));
  assert.ok(!nopush.includes('execute') && !nopush.includes('write_file'));
  assert.deepEqual(toolsOf(model, 'narrow'), ['read_file', 'grep']);
});

test('permissionMode decides a subagent’s calls under a manual conversation, and the conversation’s auto holds whatever it says', async (t) => {
  // The rule as a table first
  assert.deepEqual(subagentApproval('manual', 'acceptEdits'), {
    mode: 'accept-edits',
    readOnly: false,
    dontAsk: false,
  });
  assert.deepEqual(subagentApproval('manual', 'bypassPermissions'), {
    mode: 'manual',
    readOnly: false,
    dontAsk: false,
  });
  assert.deepEqual(subagentApproval('accept-edits', 'plan'), {
    mode: 'accept-edits',
    readOnly: false,
    dontAsk: false,
  });
  const paths = folders(t);
  const agents = join(paths.home, 'agents');
  agent(agents, 'editor', 'permissionMode: acceptEdits\n');
  agent(agents, 'planner', 'permissionMode: plan\n');
  agent(agents, 'quiet', 'permissionMode: dontAsk\n');
  agent(agents, 'asker', '');
  // What hooks are told of each one's mode
  const heard = hookScript(
    paths.root,
    'mode',
    `[input.agent_type, input.permission_mode]`,
  );
  writeFileSync(
    join(paths.home, 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'write_file',
            hooks: [{ type: 'command', command: heard }],
          },
        ],
      },
    }),
  );
  const asked: string[] = [];
  const model = modelByAsker({
    go: [
      reply('', [
        task('e', 'edit', 'editor'),
        task('p', 'plan it', 'planner'),
        task('q', 'stay quiet', 'quiet'),
        task('a', 'ask first', 'asker'),
      ]),
      reply('done'),
    ],
    edit: [reply('', [write('w1', 'edit.md')]), reply('edited')],
    'plan it': [reply('', [write('w2', 'plan.md')]), reply('planned')],
    'stay quiet': [reply('', [write('w3', 'quiet.md')]), reply('quiet')],
    'ask first': [reply('', [write('w4', 'ask.md')]), reply('asked')],
  });
  const runtime = runtimeFor(t, paths, model, {
    approve: async () => {
      asked.push('card');
      return 'approve';
    },
  });
  await runtime.harness.run('go');
  const at = (file: string) => existsSync(join(paths.workspace, file));
  // acceptEdits: the edit in the workspace runs without a card
  assert.ok(at('edit.md'));
  assert.doesNotMatch(
    resultIn(runtime, sessionOf(runtime, 'editor'), 'w1'),
    /rejected|not run/,
  );
  // plan: read-only
  assert.ok(!at('plan.md'));
  assert.match(
    resultIn(runtime, sessionOf(runtime, 'planner'), 'w2'),
    /read-only mode/,
  );
  // dontAsk: what would ask does not run, and no card shows
  assert.ok(!at('quiet.md'));
  assert.match(
    resultIn(runtime, sessionOf(runtime, 'quiet'), 'w3'),
    /does not ask \(permissionMode dontAsk\)/,
  );
  // none: the conversation's manual mode asks
  assert.ok(at('ask.md'));
  assert.deepEqual(asked, ['card']);
  assert.deepEqual(
    lines(paths.root, 'mode').sort(),
    [
      ['asker', 'default'],
      ['editor', 'acceptEdits'],
      ['quiet', 'dontAsk'],
    ].sort(),
  );

  // Under the conversation's auto, a subagent's plan does not hold it back
  const other = folders(t);
  agent(join(other.home, 'agents'), 'planner', 'permissionMode: plan\n');
  const auto = modelByAsker({
    go: [reply('', [task('p', 'plan it', 'planner')]), reply('done')],
    'plan it': [reply('', [write('w', 'auto.md')]), reply('wrote')],
  });
  const yolo = runtimeFor(t, other, auto);
  yolo.policy.setYolo(yolo.session.id, true);
  await yolo.harness.run('go');
  assert.ok(existsSync(join(other.workspace, 'auto.md')));
});

test('maxTurns stops a subagent with what it has, marked partial, after that many requests', async (t) => {
  const paths = folders(t);
  agent(join(paths.home, 'agents'), 'stepper', 'maxTurns: 2\n');
  const step = (n: number) =>
    reply(`step ${n}`, [{ id: `ls${n}`, name: 'ls', args: { path: '.' } }]);
  const model = modelByAsker({
    go: [reply('', [task('s', 'keep going', 'stepper')]), reply('done')],
    'keep going': [step(1), step(2), step(3)],
  });
  const runtime = runtimeFor(t, paths, model);
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('go');
  assert.equal(
    model.requests.filter((request) => askedBy(request, 'keep going')).length,
    2,
  );
  assert.equal(
    resultIn(runtime, runtime.session.id, 's'),
    'Partial result: this subagent used its 2 turns (maxTurns) before it finished.\n\nstep 2',
  );
  // Both of its calls ran: the limit counts requests, and the second one's call is done before it stops
  assert.deepEqual(
    runtime.store
      .messages(sessionOf(runtime, 'stepper'))
      .filter((message) => message.role === 'tool')
      .map((message) => message.tool_call_id),
    ['ls1', 'ls2'],
  );
});

test('a subagent is told once how many requests it has left, with a fifth of its maxTurns to go', async (t) => {
  const paths = folders(t);
  agent(join(paths.home, 'agents'), 'reader', 'maxTurns: 10\n');
  agent(join(paths.home, 'agents'), 'brief', 'maxTurns: 5\n');
  const step = (n: number) =>
    reply(`step ${n}`, [{ id: `ls${n}`, name: 'ls', args: { path: '.' } }]);
  const model = modelByAsker({
    go: [
      reply('', [task('r', 'read on', 'reader')]),
      reply('', [task('b', 'be brief', 'brief')]),
      reply('done'),
    ],
    'read on': Array.from({ length: 12 }, (_, n) => step(n + 1)),
    'be brief': Array.from({ length: 6 }, (_, n) => step(n + 1)),
  });
  const runtime = runtimeFor(t, paths, model);
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('go');
  const reminders = (name: string) =>
    runtime.store
      .messages(sessionOf(runtime, name))
      .filter((message) => message.internal === 'turn_limit')
      .map((message) => String(message.content));
  assert.deepEqual(reminders('reader'), [
    '<system-reminder data-source="turn-limit">\nThis session can make 2 more model requests of its 10. When they are spent it ends with what it has written to files and said by then, and anything learned and not written down is lost. Write the result the task asks for now; use the requests that remain to check and correct it.\n</system-reminder>',
  ]);
  // It is in the ninth request, the first of the two that are left, and not before
  const asked = model.requests.filter((request) => askedBy(request, 'read on'));
  assert.equal(asked.length, 10);
  const told = (request: (typeof asked)[number]) =>
    JSON.stringify(request.messages).includes('data-source=\\"turn-limit\\"');
  assert.deepEqual(asked.map(told), [false, false, false, false, false, false, false, false, true, true]);
  // A limit of a few requests gets none
  assert.deepEqual(reminders('brief'), []);
});

test('sessionPrompt: false gives a subagent its own prompt with where it runs and the variables, and not what the conversation is told', async (t) => {
  const paths = folders(t);
  agent(
    join(paths.home, 'agents'),
    'narrow',
    'sessionPrompt: false\n',
    'You only count lines.',
  );
  agent(join(paths.home, 'agents'), 'wide', '', 'You do anything.');
  const model = modelByAsker({
    go: [
      reply('', [
        task('n', 'count the lines', 'narrow'),
        task('w', 'do the rest', 'wide'),
      ]),
      reply('done'),
    ],
    'count the lines': [reply('three')],
    'do the rest': [reply('finished')],
  });
  const runtime = runtimeFor(t, paths, model, {
    settings: { ...defaultSettings(), variables: { REGION: 'north' } },
  });
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('go');
  const systemOf = (key: string): string =>
    model.requests.find((request) => askedBy(request, key))!.system;
  const narrow = systemOf('count the lines');
  const wide = systemOf('do the rest');
  // Its own prompt, then the facts: how paths are read, where it runs, the variables
  assert.ok(narrow.startsWith('You only count lines.\n'), narrow.slice(0, 80));
  assert.match(narrow, /# Paths \(Circle\)/);
  assert.ok(
    narrow.includes(`<env>\n  Working directory: ${paths.workspace}\n`),
  );
  assert.match(
    narrow,
    /<variables>[\s\S]*- REGION = north[\s\S]*<\/variables>/,
  );
  // Nothing of what the conversation is told about talking and working, which the other subagent carries whole
  const conversation = runtime.harness.system;
  assert.ok(conversation.length > 4000);
  assert.ok(wide.includes(conversation));
  assert.ok(!narrow.includes(conversation));
  for (const part of ['# Tone and style', '# Doing tasks'])
    assert.ok(conversation.includes(part) && !narrow.includes(part), part);
  assert.ok(
    narrow.length * 3 < wide.length,
    `${narrow.length} of ${wide.length}`,
  );
  // Both are still told what a subagent is told of itself, after what differs
  assert.equal(
    narrow.slice(narrow.lastIndexOf('</variables>') + '</variables>'.length),
    wide.slice(wide.indexOf(conversation) + conversation.length),
  );
});

test('the skills a definition names are in its conversation before its task, and one not installed is left out and named', async (t) => {
  const paths = folders(t);
  const skill = join(paths.home, 'skills', 'conventions');
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, 'SKILL.md'),
    '---\nname: conventions\ndescription: Team conventions\n---\nName tests after behaviour.\n',
  );
  agent(
    join(paths.home, 'agents'),
    'tester',
    'skills:\n  - conventions\n  - missing-one\n',
  );
  const model = modelByAsker({
    go: [reply('', [task('t', 'write the tests', 'tester')]), reply('done')],
    'write the tests': [reply('tests written')],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.harness.run('go');
  const first = model.requests.find((request) =>
    askedBy(request, 'write the tests'),
  )!;
  const users = first.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content);
  const loaded = users.findIndex((text) =>
    text.includes('<skill_content name="conventions">'),
  );
  assert.ok(loaded >= 0, 'the skill was preloaded');
  assert.match(users[loaded]!, /Name tests after behaviour\./);
  assert.ok(loaded < users.indexOf('write the tests'), 'before the task');
  assert.ok(!users.some((text) => text.includes('missing-one')));
  const listed = runtime
    .inspectSubagents()
    .agents.find((item) => item.name === 'tester')!;
  assert.deepEqual(listed.skills, ['conventions', 'missing-one']);
  assert.deepEqual(listed.missingSkills, ['missing-one']);
});

test('mcpServers gives a subagent the tools of a configured server beside its own list, and a server the session does not have keeps it from being offered', async (t) => {
  const paths = folders(t);
  const stub = await mcpStub(t, {
    tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }],
  });
  const settings = defaultSettings();
  settings.mcpServers = { stub: { type: 'http', url: stub.url } };
  const agents = join(paths.home, 'agents');
  agent(agents, 'reader', 'tools: read_file\nmcpServers: [stub]\n');
  agent(agents, 'lost', 'mcpServers: [nowhere]\n');
  const model = modelByAsker({
    go: [reply('', [task('r', 'read it', 'reader')]), reply('done')],
    'read it': [reply('read')],
  });
  const runtime = runtimeFor(t, paths, model, { settings });
  await runtime.initialize();
  await runtime.harness.run('go');
  assert.deepEqual(toolsOf(model, 'read it'), ['read_file', 'mcp__stub__echo']);
  const { agents: listed, problems } = runtime.inspectSubagents();
  assert.deepEqual(listed.find((item) => item.name === 'reader')?.mcpServers, [
    'stub',
  ]);
  assert.ok(!listed.some((item) => item.name === 'lost'));
  assert.ok(
    problems.some((line) =>
      line.startsWith(
        'lost names MCP servers this session does not have: nowhere',
      ),
    ),
  );
});

test("a definition's hooks run for its own calls and its stop only, while it runs; a project's wait for the folder to be trusted", async (t) => {
  const paths = folders(t);
  const block = hookScript(paths.root, 'blocked', `input.tool_name`, {
    code: 2,
    stderr: 'blocked by the agent',
  });
  const stopped = hookScript(
    paths.root,
    'stopped',
    `[input.hook_event_name, input.agent_type, input.session_id]`,
  );
  const hooks = (command: string) =>
    [
      'hooks:',
      '  PreToolUse:',
      '    - matcher: execute',
      '      hooks:',
      '        - type: command',
      `          command: ${JSON.stringify(command)}`,
      '  Stop:',
      '    - hooks:',
      '        - type: command',
      `          command: ${JSON.stringify(stopped)}`,
      '',
    ].join('\n');
  agent(join(paths.home, 'agents'), 'guarded', hooks(block));
  agent(join(paths.workspace, '.circle', 'agents'), 'local', hooks(block));
  const ran = hookScript(paths.root, 'ran', `process.argv.length`);
  const run = (id: string) => ({
    id,
    name: 'execute',
    args: { command: ran },
  });
  const model = modelByAsker({
    go: [
      reply('', [task('g', 'guard', 'guarded')]),
      reply('', [run('mine')]),
      reply('', [task('l', 'local', 'local')]),
      reply('done'),
    ],
    guard: [reply('', [run('theirs')]), reply('guarded done')],
    local: [reply('', [run('project')]), reply('local done')],
  });
  const runtime = runtimeFor(t, paths, model);
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('go');
  // Its PreToolUse hook blocked its own call
  assert.match(
    resultIn(runtime, sessionOf(runtime, 'guarded'), 'theirs'),
    /blocked by the agent/,
  );
  // Its Stop hook ran as SubagentStop when it finished, with the conversation's session
  assert.deepEqual(lines(paths.root, 'stopped'), [
    ['SubagentStop', 'guarded', runtime.session.id],
  ]);
  // The conversation's own call, after it, ran: the hook was the subagent's
  assert.doesNotMatch(resultIn(runtime, runtime.session.id, 'mine'), /blocked/);
  // A project's definition in a folder not trusted runs without its hooks
  assert.doesNotMatch(
    resultIn(runtime, sessionOf(runtime, 'local'), 'project'),
    /blocked/,
  );
  assert.deepEqual(lines(paths.root, 'blocked'), ['execute']);
  assert.equal(lines(paths.root, 'ran').length, 2);
  const listed = runtime.inspectSubagents().agents;
  assert.equal(
    listed.find((item) => item.name === 'local')?.hooksHeld,
    'this folder is not trusted',
  );
  assert.deepEqual(listed.find((item) => item.name === 'guarded')?.hooks, [
    'PreToolUse',
    'SubagentStop',
  ]);
});

test('the built-in plan researches read-only from a prompt of its own', async (t) => {
  const paths = folders(t);
  const model = modelByAsker({
    go: [reply('', [task('p', 'study the loader', 'plan')]), reply('done')],
    'study the loader': [
      reply('', [write('w', 'plan-notes.md')]),
      reply('studied'),
    ],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.initialize();
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('go');
  const first = model.requests.find((request) =>
    askedBy(request, 'study the loader'),
  )!;
  assert.match(first.system, /^You are a research agent for a plan/);
  // It runs read-only, as explore does
  assert.match(first.system, /Read-only mode: inspect and plan/);
  const offered = first.tools.map((tool) => tool.name);
  assert.ok(offered.includes('read_file') && offered.includes('grep'));
  for (const tool of ['write_file', 'edit_file', 'execute', 'task'])
    assert.ok(!offered.includes(tool), tool);
  assert.match(
    resultIn(runtime, sessionOf(runtime, 'plan'), 'w'),
    /not available: write_file/,
  );
  assert.ok(!existsSync(join(paths.workspace, 'plan-notes.md')));
  const description = runtime.harness.tools.find(
    (tool) => tool.name === 'task',
  )!.description;
  assert.match(description, /- plan: Read-only research before a plan/);
  // Only the built-ins are said to read only: a file can replace either
  assert.match(description, /The built-in\s+explore and plan only read/);
});

test('memory, isolation and color are read and offered, and /agents says they are not supported yet', async (t) => {
  const paths = folders(t);
  agent(
    join(paths.home, 'agents'),
    'keeper',
    'memory: project\nisolation: worktree\ncolor: red\n',
  );
  const model = modelByAsker({
    go: [reply('', [task('k', 'keep it', 'keeper')]), reply('done')],
    'keep it': [reply('kept')],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.harness.run('go');
  assert.equal(resultIn(runtime, runtime.session.id, 'k'), 'kept');
  assert.deepEqual(
    runtime.inspectSubagents().agents.find((item) => item.name === 'keeper')
      ?.unsupported,
    ['memory project', 'isolation worktree', 'color red'],
  );
  // The file is read where Circle reads definitions
  assert.equal(
    discoverSubagents(paths.workspace, paths.home, paths.userHome).agents[0]
      ?.memory,
    'project',
  );
});

test('an entry in disallowedTools that names no tool keeps the definition from being offered, as one in tools does', async (t) => {
  const paths = folders(t);
  // Another program's tool names, in the folder Circle reads for it: they withhold nothing in Circle
  agent(
    join(paths.userHome, '.claude', 'agents'),
    'no-writes',
    'disallowedTools: Write, Edit\n',
  );
  const model = modelByAsker({
    go: [
      reply('', [task('a', 'no writes please', 'no-writes')]),
      reply('done'),
    ],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.harness.run('go');
  assert.match(
    resultIn(runtime, runtime.session.id, 'a'),
    /unknown subagent type/,
  );
  assert.ok(
    !model.requests.some((request) => askedBy(request, 'no writes please')),
  );
  const { agents, problems } = runtime.inspectSubagents();
  assert.ok(!agents.some((item) => item.name === 'no-writes'));
  assert.ok(
    problems.some((line) =>
      line.startsWith(
        'no-writes withholds tools that do not exist: Write, Edit · not offered',
      ),
    ),
  );
});

test("the mcp__ forms find a server's tools by the server's name, whatever its tools are called", async (t) => {
  const paths = folders(t);
  const stub = await mcpStub(t, {
    tools: [
      { name: 'echo', inputSchema: { type: 'object', properties: {} } },
      { name: 'ping', inputSchema: { type: 'object', properties: {} } },
    ],
  });
  const settings = defaultSettings();
  settings.mcpServers = { stub: { type: 'http', url: stub.url } };
  const agents = join(paths.home, 'agents');
  agent(agents, 'local-only', 'disallowedTools: mcp__stub\n');
  agent(agents, 'no-mcp', 'disallowedTools: mcp__*\n');
  agent(agents, 'no-echo', 'disallowedTools: mcp__stub__echo\n');
  agent(agents, 'only-stub', 'tools: read_file, mcp__stub__*\n');
  agent(agents, 'ghost', 'disallowedTools: mcp__nowhere\n');
  const model = modelByAsker({
    go: [
      reply('', [
        task('a', 'local only', 'local-only'),
        task('b', 'no mcp', 'no-mcp'),
        task('c', 'no echo', 'no-echo'),
        task('d', 'only stub', 'only-stub'),
      ]),
      reply('done'),
    ],
    'local only': [reply('ok')],
    'no mcp': [reply('ok')],
    'no echo': [reply('ok')],
    'only stub': [reply('ok')],
  });
  const runtime = runtimeFor(t, paths, model, { settings });
  await runtime.initialize();
  await runtime.harness.run('go');
  const stubTools = (key: string) =>
    toolsOf(model, key).filter((name) => name.startsWith('mcp__stub__'));
  assert.deepEqual(stubTools('local only'), []);
  assert.deepEqual(stubTools('no mcp'), []);
  assert.deepEqual(stubTools('no echo'), ['mcp__stub__ping']);
  assert.ok(toolsOf(model, 'local only').includes('read_file'));
  assert.deepEqual(toolsOf(model, 'only stub'), [
    'read_file',
    'mcp__stub__echo',
    'mcp__stub__ping',
  ]);
  assert.ok(
    runtime
      .inspectSubagents()
      .problems.some((line) =>
        line.startsWith(
          'ghost withholds tools that do not exist: mcp__nowhere',
        ),
      ),
  );
});

test('a frontmatter whose closing line says more still gives the subagent its keys, written in any case', async (t) => {
  const paths = folders(t);
  writeFileSync(
    join(paths.home, 'agents', 'reader.md'),
    '---\nname: reader\ndescription: Reads.\nTools: read_file, grep\nPermissionMode: plan\n--- # end of frontmatter\nYou read.\n',
  );
  const model = modelByAsker({
    go: [reply('', [task('r', 'read it', 'reader')]), reply('done')],
    'read it': [reply('read')],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.harness.run('go');
  const first = model.requests.find((request) => askedBy(request, 'read it'))!;
  assert.deepEqual(
    first.tools.map((tool) => tool.name),
    ['read_file', 'grep'],
  );
  assert.match(first.system, /^You read\./);
  assert.match(first.system, /Read-only mode: inspect and plan/);
});

test("a project's definition cannot make Circle ask less: its acceptEdits is not applied and /agents says why, while yours applies", async (t) => {
  const paths = folders(t);
  const project = join(paths.workspace, '.circle', 'agents');
  agent(project, 'editor', 'permissionMode: acceptEdits\n');
  agent(project, 'quiet', 'permissionMode: dontAsk\n');
  agent(join(paths.home, 'agents'), 'mine', 'permissionMode: acceptEdits\n');
  const asked: string[] = [];
  const model = modelByAsker({
    go: [
      reply('', [
        task('e', 'edit here', 'editor'),
        task('q', 'stay quiet', 'quiet'),
        task('m', 'mine edits', 'mine'),
      ]),
      reply('done'),
    ],
    'edit here': [reply('', [write('w1', 'edit.md')]), reply('edited')],
    'stay quiet': [reply('', [write('w2', 'quiet.md')]), reply('quiet')],
    'mine edits': [reply('', [write('w3', 'mine.md')]), reply('mine')],
  });
  const runtime = runtimeFor(t, paths, model, {
    approve: async () => {
      asked.push('card');
      return 'approve';
    },
  });
  await runtime.harness.run('go');
  const at = (file: string) => existsSync(join(paths.workspace, file));
  // The project's acceptEdits did not apply: its edit asked, as the conversation's manual mode does
  assert.deepEqual(asked, ['card']);
  assert.ok(at('edit.md') && at('mine.md'));
  // Its dontAsk, which only tightens, did
  assert.ok(!at('quiet.md'));
  const listed = runtime.inspectSubagents().agents;
  const editor = listed.find((item) => item.name === 'editor')!;
  assert.equal(editor.permissionMode, undefined);
  assert.deepEqual(editor.notApplied, [
    "permissionMode acceptEdits: a project's definition cannot loosen approvals",
  ]);
  assert.equal(
    listed.find((item) => item.name === 'quiet')?.permissionMode,
    'dontAsk',
  );
});

test('SubagentStart and SubagentStop hooks hear the subagent’s own mode', async (t) => {
  const paths = folders(t);
  const heard = hookScript(
    paths.root,
    'modes',
    `[input.hook_event_name, input.agent_type, input.permission_mode]`,
  );
  writeFileSync(
    join(paths.home, 'settings.json'),
    JSON.stringify({
      hooks: {
        SubagentStart: [{ hooks: [{ type: 'command', command: heard }] }],
        SubagentStop: [{ hooks: [{ type: 'command', command: heard }] }],
      },
    }),
  );
  const agents = join(paths.home, 'agents');
  agent(agents, 'quiet', 'permissionMode: dontAsk\n');
  agent(agents, 'planner', 'permissionMode: plan\n');
  agent(agents, 'plain', '');
  const model = modelByAsker({
    go: [
      reply('', [
        task('q', 'be quiet', 'quiet'),
        task('p', 'plan it', 'planner'),
        task('n', 'just do it', 'plain'),
      ]),
      reply('done'),
    ],
    'be quiet': [reply('ok')],
    'plan it': [reply('ok')],
    'just do it': [reply('ok')],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.harness.run('go');
  const sorted = (rows: string[][]) => rows.map((row) => row.join(' ')).sort();
  assert.deepEqual(
    sorted(lines(paths.root, 'modes')),
    sorted([
      ['SubagentStart', 'quiet', 'dontAsk'],
      ['SubagentStart', 'planner', 'plan'],
      ['SubagentStart', 'plain', 'default'],
      ['SubagentStop', 'quiet', 'dontAsk'],
      ['SubagentStop', 'planner', 'plan'],
      ['SubagentStop', 'plain', 'default'],
    ]),
  );
});

test('a subagent started by a dontAsk subagent works in its own mode, or the conversation’s', async (t) => {
  const paths = folders(t);
  agent(join(paths.home, 'agents'), 'quiet', 'permissionMode: dontAsk\n');
  const asked: string[] = [];
  const model = modelByAsker({
    go: [reply('', [task('q', 'stay quiet', 'quiet')]), reply('done')],
    'stay quiet': [
      reply('', [
        write('w0', 'own.md'),
        task('n', 'nested write', 'general-purpose'),
      ]),
      reply('quiet done'),
    ],
    'nested write': [reply('', [write('w1', 'nested.md')]), reply('nested')],
  });
  const runtime = runtimeFor(t, paths, model, {
    approve: async () => {
      asked.push('card');
      return 'approve';
    },
  });
  await runtime.harness.run('go');
  // Its own write does not ask and does not run; the subagent it started asks, as the conversation does
  assert.ok(!existsSync(join(paths.workspace, 'own.md')));
  assert.ok(existsSync(join(paths.workspace, 'nested.md')));
  assert.deepEqual(asked, ['card']);
});

test('a subagent starts with the skills the one that started it has loaded, after those its definition names, and not a sibling’s', async (t) => {
  const paths = folders(t);
  for (const [name, text] of [
    ['workflow', 'Follow workflow checklist.'],
    ['extra', 'Verify edge cases before reporting.'],
    ['child-only', 'Internal child guideline.'],
  ] as const) {
    const dir = join(paths.home, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Skill ${name}\n---\n${text}\n`,
    );
  }
  agent(join(paths.home, 'agents'), 'checker', 'skills:\n  - extra\n');
  const model = modelByAsker({
    go: [
      reply('', [{ id: 'load-wf', name: 'skill', args: { name: 'workflow' } }]),
      reply('', [task('t1', 'first child task', 'checker')]),
      reply('', [task('t2', 'second sibling task', 'explore')]),
      reply('done'),
    ],
    'first child task': [
      reply('', [
        { id: 'load-co', name: 'skill', args: { name: 'child-only' } },
      ]),
      reply('', [task('g1', 'grandchild task', 'explore')]),
      reply('first done'),
    ],
    'grandchild task': [reply('grandchild done')],
    'second sibling task': [reply('second done')],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.harness.run('go');
  const usersOf = (key: string): string[] =>
    model.requests
      .find((request) => askedBy(request, key))!
      .messages.filter((message) => message.role === 'user')
      .map((message) => message.content);
  const has = (users: string[], text: string): boolean =>
    users.some((item) => item.includes(text));
  const first = usersOf('first child task');
  assert.ok(has(first, 'Follow workflow checklist.'), 'the loaded skill');
  assert.ok(has(first, 'Verify edge cases before reporting.'), 'its own');
  assert.ok(
    first.findIndex((item) => item.includes('Verify edge cases')) <
      first.findIndex((item) => item.includes('Follow workflow checklist.')),
    'the definition names come first',
  );
  assert.ok(
    first.findIndex((item) => item.includes('Follow workflow checklist.')) <
      first.indexOf('first child task'),
    'before its task',
  );
  const grandchild = usersOf('grandchild task');
  for (const text of [
    'Follow workflow checklist.',
    'Verify edge cases before reporting.',
    'Internal child guideline.',
  ])
    assert.ok(has(grandchild, text), `a subagent's subagent has: ${text}`);
  const second = usersOf('second sibling task');
  assert.ok(has(second, 'Follow workflow checklist.'), 'the loaded skill');
  assert.ok(!has(second, 'Internal child guideline.'), 'not a sibling’s');
  assert.ok(!has(second, 'Verify edge cases before reporting.'), 'not theirs');
});

test('a skill loaded before a resume still reaches a subagent after another is loaded', async (t) => {
  const paths = folders(t);
  for (const [name, text] of [
    ['early', 'Follow the early checklist.'],
    ['late', 'Follow the late checklist.'],
  ] as const) {
    const dir = join(paths.home, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Skill ${name}\n---\n${text}\n`,
    );
  }
  const before = new AgentRuntime({
    home: paths.home,
    workspace: paths.workspace,
    userHome: paths.userHome,
    settings: defaultSettings(),
    model: modelByAsker({
      go: [
        reply('', [
          { id: 'load-early', name: 'skill', args: { name: 'early' } },
        ]),
        reply('loaded'),
      ],
    }),
  });
  await before.harness.run('go');
  const earlier = before.session.id;
  await before.close();
  const model = modelByAsker({
    again: [
      reply('', [{ id: 'load-late', name: 'skill', args: { name: 'late' } }]),
      reply('', [task('t', 'child after resume', 'explore')]),
      reply('done'),
    ],
    'child after resume': [reply('ok')],
  });
  const runtime = runtimeFor(t, paths, model);
  await runtime.switchSession(earlier);
  await runtime.harness.run('again');
  const users = model.requests
    .find((request) => askedBy(request, 'child after resume'))!
    .messages.filter((message) => message.role === 'user')
    .map((message) => message.content);
  for (const text of [
    'Follow the early checklist.',
    'Follow the late checklist.',
  ])
    assert.ok(
      users.some((item) => item.includes(text)),
      text,
    );
});

test('subagents receive active plan file path, deny rules, and guard hook boundaries while bare runs omit them', async (t) => {
  const barePaths = folders(t);
  const bareModel = modelByAsker({
    go: [reply('', [task('b', 'bare look', 'explore')]), reply('done')],
    'bare look': [reply('ok')],
  });
  const bareRuntime = runtimeFor(t, barePaths, bareModel);
  await bareRuntime.harness.run('go');
  const bareSystem = bareModel.requests.find((request) =>
    askedBy(request, 'bare look'),
  )!.system;
  assert.ok(
    !bareSystem.includes('<subagent_context>'),
    'bare general workspace should not emit subagent_context',
  );

  const guardedPaths = folders(t);
  mkdirSync(join(guardedPaths.workspace, '.circle'), { recursive: true });
  writeFileSync(
    join(guardedPaths.workspace, '.circle', 'approvals.json'),
    JSON.stringify({
      rules: [
        {
          tool: 'execute',
          pattern: 'git push *',
          effect: 'deny',
          label: 'no push',
        },
        {
          tool: 'write_file',
          pattern: '.env*',
          effect: 'deny',
        },
      ],
    }),
  );
  const hookScriptPath = join(guardedPaths.root, 'guard-secret-hook-name.mjs');
  writeFileSync(hookScriptPath, 'process.exit(0);\n');
  writeFileSync(
    join(guardedPaths.home, 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'execute',
            hooks: [
              {
                type: 'command',
                command: `${process.execPath} ${hookScriptPath}`,
              },
            ],
          },
        ],
      },
    }),
  );
  const guardedModel = modelByAsker({
    go: [
      reply('', [task('g', 'guarded work', 'general-purpose')]),
      reply('done'),
    ],
    'guarded work': [reply('ok')],
  });
  const guardedRuntime = runtimeFor(t, guardedPaths, guardedModel);
  guardedRuntime.harness.planMode = true;
  const planPath = guardedRuntime.planFile.file;
  await guardedRuntime.harness.run('go');
  const guardedSystem = guardedModel.requests.find((request) =>
    askedBy(request, 'guarded work'),
  )!.system;
  assert.match(guardedSystem, /<subagent_context>/);
  assert.ok(
    guardedSystem.includes(planPath),
    'subagent sees active session plan file path',
  );
  assert.match(guardedSystem, /git push \*/);
  assert.match(guardedSystem, /\.env\*/);
  assert.match(guardedSystem, /PreToolUse guard active for matcher "execute"/);
  assert.ok(
    !guardedSystem.includes('guard-secret-hook-name.mjs'),
    'guard hook summary must not expose raw hook command path',
  );
  assert.match(guardedSystem, /Read-only constraint:/);
});
