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
  settings.mcp_servers = [
    { name: 'stub', url: stub.url, transport: 'streamable_http' },
  ];
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
  assert.deepEqual(toolsOf(model, 'read it'), ['read_file', 'stub_echo']);
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
  assert.match(
    runtime.harness.tools.find((tool) => tool.name === 'task')!.description,
    /- plan: Read-only research before a plan/,
  );
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
