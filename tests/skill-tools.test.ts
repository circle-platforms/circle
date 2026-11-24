import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentRuntime, type InteractionContext } from '../src/runtime.js';
import {
  CLAUDE_TOOL_NAMES,
  SkillScopes,
  resolveSkillTools,
  type SkillTools,
} from '../src/skill_tools.js';
import {
  discoverSkills,
  parseFrontmatter,
  splitToolList,
  type SkillInfo,
} from '../src/skills.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import {
  emptyUsage,
  type Effect,
  type Message,
  type ToolCall,
} from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

const assistant = (
  text: string,
  calls: Message['tool_calls'] = [],
): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  content: text,
  tool_calls: calls,
});
const call = (
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): NonNullable<Message['tool_calls']>[number] => ({ id, name, args });

// Use Node instead of POSIX `touch` so the test behaves identically across platforms.
const TOUCH_SCRIPT =
  "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], '');\n";
const touch = (file: string): string =>
  `"${process.execPath}" touch.mjs ${file}`;

function folders(t: Parameters<typeof scratch>[0]) {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const userHome = join(root, 'user');
  for (const path of [home, workspace, userHome])
    mkdirSync(path, { recursive: true });
  writeFileSync(join(workspace, 'touch.mjs'), TOUCH_SCRIPT);
  return { home, workspace, userHome };
}

function skillFile(
  workspace: string,
  name: string,
  frontmatter: string,
  body = `Follow ${name}.`,
): void {
  const directory = join(workspace, '.circle', 'skills', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: The ${name} skill.\n${frontmatter}\n---\n${body}\n`,
  );
}

function session(
  t: Parameters<typeof scratch>[0],
  replies: ConstructorParameters<typeof ScriptedModel>[0],
  options: {
    answer?: (call: ToolCall) => 'approve' | 'reject';
    unattended?: boolean;
    prepare?: (dirs: ReturnType<typeof folders>) => void;
  } = {},
) {
  const dirs = folders(t);
  options.prepare?.(dirs);
  const model = new ScriptedModel(replies);
  const asked: { name: string; origin?: InteractionContext }[] = [];
  const runtime = new AgentRuntime({
    ...dirs,
    settings: defaultSettings(),
    model,
    headless: true,
    ...(options.unattended
      ? {}
      : {
          approve: async (
            toolCall: ToolCall,
            _signal: AbortSignal,
            origin?: InteractionContext,
          ) => {
            asked.push({ name: toolCall.name, origin });
            return options.answer?.(toolCall) ?? 'approve';
          },
        }),
  });
  cleanup(t, () => runtime.close());
  return { ...dirs, model, asked, runtime };
}

const names = (tools: { name: string }[]): string[] =>
  tools.map((tool) => tool.name);
const resultOf = (runtime: AgentRuntime, id: string): string =>
  String(
    runtime.harness.messages.find((message) => message.tool_call_id === id)
      ?.content,
  );

test('a tool list is read from a string, a YAML list and a flow list, and a parenthesis stays whole', () => {
  assert.deepEqual(
    splitToolList('Bash(git add *) Bash(git commit *), Read  Grep'),
    ['Bash(git add *)', 'Bash(git commit *)', 'Read', 'Grep'],
  );
  assert.deepEqual(splitToolList('Read,Read Read'), ['Read']);
  assert.deepEqual(splitToolList(''), []);
  assert.deepEqual(splitToolList('Read Bash(git add *'), [
    'Read',
    'Bash(git add *',
  ]);

  const block = parseFrontmatter(
    '---\nname: x\nallowed-tools:\n  - Read\n  - "Bash(git add:*)"\n  - Grep # kept\ndescription: after the list\n---\nbody\n',
  );
  assert.deepEqual(block.lists['allowed-tools'], [
    'Read',
    'Bash(git add:*)',
    'Grep',
  ]);
  assert.deepEqual(Object.keys(block.meta), [
    'name',
    'allowed-tools',
    'description',
  ]);
  assert.equal(block.meta.description, 'after the list');
  assert.equal(block.body, 'body\n');

  assert.deepEqual(
    parseFrontmatter('---\ntools:\n- a\n- b\nname: x\n---\n').lists.tools,
    ['a', 'b'],
  );
  const flow = parseFrontmatter(
    '---\nallowed-tools: [Read, "Bash(git add *)", Grep]\n---\n',
  );
  assert.deepEqual(flow.lists['allowed-tools'], [
    'Read',
    'Bash(git add *)',
    'Grep',
  ]);
  assert.equal(
    flow.meta['allowed-tools'],
    '[Read, "Bash(git add *)", Grep]',
    'meta keeps the text it always had',
  );
  const windows = parseFrontmatter(
    '---\r\nname: x\r\ndescription: hello there\r\nallowed-tools:\r\n  - Read\r\n  - Grep\r\ndisallowed-tools: Bash question\r\n---\r\nbody\r\n',
  );
  assert.equal(windows.meta.name, 'x');
  assert.equal(windows.meta.description, 'hello there');
  assert.deepEqual(windows.lists['allowed-tools'], ['Read', 'Grep']);
  assert.equal(windows.meta['disallowed-tools'], 'Bash question');
  const scalars = parseFrontmatter(
    '---\nname: x\ndescription: >\n  folded\n  text\nallowed-tools: Read Grep\nempty:\n---\n',
  );
  assert.deepEqual(scalars.lists, {});
  assert.equal(scalars.meta.description, 'folded text');
  assert.equal(scalars.meta['allowed-tools'], 'Read Grep');
  assert.equal(scalars.meta.empty, '');
});

test('the catalog carries both fields as written, whatever form the file used', (t) => {
  const { home, workspace, userHome } = folders(t);
  skillFile(
    workspace,
    'spaced',
    'allowed-tools: Bash(git add *) Bash(git commit *) Read\ndisallowed-tools: AskUserQuestion',
  );
  skillFile(
    workspace,
    'commas',
    'allowed-tools: Read, Grep, Bash(git status:*)',
  );
  skillFile(
    workspace,
    'listed',
    'allowed-tools:\n  - Read\n  - Edit\ndisallowed-tools:\n  - Bash',
  );
  skillFile(workspace, 'flowed', 'disallowed-tools: [execute, "question"]');
  skillFile(workspace, 'plain', '');
  const found = new Map(
    discoverSkills(workspace, home, userHome, false).map((skill) => [
      skill.name,
      skill,
    ]),
  );
  assert.deepEqual(found.get('spaced')!.allowed_tools, [
    'Bash(git add *)',
    'Bash(git commit *)',
    'Read',
  ]);
  assert.deepEqual(found.get('spaced')!.disallowed_tools, ['AskUserQuestion']);
  assert.deepEqual(found.get('commas')!.allowed_tools, [
    'Read',
    'Grep',
    'Bash(git status:*)',
  ]);
  assert.deepEqual(found.get('listed')!.allowed_tools, ['Read', 'Edit']);
  assert.deepEqual(found.get('listed')!.disallowed_tools, ['Bash']);
  assert.deepEqual(found.get('flowed')!.disallowed_tools, [
    'execute',
    'question',
  ]);
  assert.deepEqual(Object.keys(found.get('plain')!).sort(), [
    'description',
    'name',
    'path',
    'source_label',
  ]);
});

const KNOWN = new Map<string, Effect>([
  ['execute', 'execute'],
  ['read_file', 'read'],
  ['write_file', 'write'],
  ['edit_file', 'write'],
  ['grep', 'read'],
  ['question', 'read'],
  ['webfetch', 'read'],
  ['compact_conversation', 'read'],
  ['github_pr', 'unknown'],
]);
const resolve = (
  allowed: string[] | undefined,
  disallowed?: string[],
): SkillTools =>
  resolveSkillTools(
    {
      name: 'demo',
      ...(allowed ? { allowed_tools: allowed } : {}),
      ...(disallowed ? { disallowed_tools: disallowed } : {}),
    },
    KNOWN,
  );

test("Claude Code's tool names mean Circle's tools, and a command pattern limits execute only", () => {
  const tools = resolve(
    ['Read', 'Edit', 'Bash(git add *)', 'Bash(git status:*)', 'github_pr'],
    ['AskUserQuestion', 'WebFetch'],
  );
  assert.deepEqual(tools.allowed, [
    { tool: 'read_file' },
    { tool: 'edit_file' },
    {
      tool: 'execute',
      patterns: ['git add *', 'git status', 'git status *'],
    },
    { tool: 'github_pr' },
  ]);
  assert.deepEqual(tools.withheld, ['question', 'webfetch']);
  assert.deepEqual(tools.problems, []);
  assert.deepEqual(resolve(['Bash(ls *)', 'Bash']).allowed, [
    { tool: 'execute' },
  ]);
  assert.deepEqual(resolve(['Bash', 'Bash(ls *)']).allowed, [
    { tool: 'execute' },
  ]);
  assert.deepEqual(resolve(['execute(ls *)']).allowed, [
    { tool: 'execute', patterns: ['ls *'] },
  ]);
  for (const target of Object.values(CLAUDE_TOOL_NAMES))
    assert.match(target, /^[a-z_]+$/);
});

test('a name that is no tool is reported with its field, and the rest of the fields still apply', () => {
  const tools = resolve(
    [
      'Read',
      'no_such_tool',
      'Write(src/**)',
      'Read(./src/**)',
      'WebFetch(domain:example.com)',
      'Bash(git',
      'Bash()',
      'NotebookEdit',
    ],
    ['Ghost', 'Bash(rm *)', 'compact_conversation', 'question'],
  );
  assert.deepEqual(tools.allowed, [{ tool: 'read_file' }]);
  assert.deepEqual(tools.withheld, ['question']);
  assert.deepEqual(tools.problems, [
    'demo allowed-tools Write(src/**): only execute takes a pattern · not applied',
    'demo allowed-tools Bash(git: not a tool name · not applied',
    'demo allowed-tools Bash(): not a tool name · not applied',
    'demo names tools that do not exist in allowed-tools: no_such_tool, NotebookEdit · not applied',
    'demo disallowed-tools Bash(rm *): a whole tool is withheld, never part of its calls · not applied',
    'demo disallowed-tools compact_conversation: always offered · not applied',
    'demo names tools that do not exist in disallowed-tools: Ghost · not applied',
  ]);
  assert.deepEqual(resolve(['toString', 'constructor']).allowed, []);
});

test('a skill the model loads applies at once, one the person loads with their next message, and each ends with the message after', () => {
  const scopes = new SkillScopes('/work');
  const write = resolve(['write_file']);
  const quiet = { ...resolve(undefined, ['question']), skill: 'quiet' };
  assert.equal(scopes.allows('main', 'write_file', {}), false);
  scopes.load('main', write, 'now');
  scopes.load('main', quiet, 'now');
  assert.equal(scopes.allows('main', 'write_file', {}), true);
  assert.equal(scopes.allows('main', 'execute', { command: 'ls' }), false);
  assert.deepEqual([...scopes.withheld('main')!], ['question']);
  assert.equal(scopes.allows('child', 'write_file', {}), false);
  assert.equal(scopes.withheld('child'), undefined);
  scopes.message('main');
  assert.equal(scopes.allows('main', 'write_file', {}), false);
  assert.equal(scopes.withheld('main'), undefined);

  scopes.load('main', write, 'next');
  scopes.load('main', quiet, 'next');
  assert.deepEqual(scopes.state('main'), {
    now: [],
    next: ['demo', 'quiet'],
  });
  assert.equal(
    scopes.allows('main', 'write_file', {}),
    false,
    'not before the message that carries the skill',
  );
  assert.equal(scopes.withheld('main'), undefined);
  scopes.message('main');
  assert.equal(scopes.allows('main', 'write_file', {}), true);
  assert.deepEqual([...scopes.withheld('main')!], ['question']);
  scopes.message('main');
  assert.equal(scopes.allows('main', 'write_file', {}), false);
  assert.deepEqual(scopes.state('main'), { now: [], next: [] });

  scopes.load('main', write, 'now');
  scopes.load('main', { ...write, allowed: [] }, 'now');
  assert.equal(scopes.allows('main', 'write_file', {}), false);
  scopes.load('main', write, 'now');
  scopes.drop('main');
  assert.equal(scopes.allows('main', 'write_file', {}), false);
  scopes.load('main', write, 'now');
  scopes.clear();
  assert.equal(scopes.allows('main', 'write_file', {}), false);
});

test('an execute grant covers the commands its patterns cover, every part of a command, and no other tool', () => {
  const scopes = new SkillScopes('/work');
  scopes.load(
    'main',
    resolve(['Bash(git add *)', 'Bash(git status:*)']),
    'now',
  );
  const runs = (command: unknown): boolean =>
    scopes.allows('main', 'execute', { command });
  assert.equal(runs('git add a.txt'), true);
  assert.equal(runs('git status'), true);
  assert.equal(runs('git status -s'), true);
  assert.equal(runs('git add a.txt && git status'), true);
  assert.equal(runs('git commit -m x'), false);
  assert.equal(runs('git add a.txt && git push'), false);
  assert.equal(runs('git add a.txt; rm -rf .'), false);
  assert.equal(runs('cd /work && git status'), true, 'the workspace cd');
  assert.equal(runs('git add "unterminated'), false);
  assert.equal(runs(undefined), false);
  assert.equal(scopes.allows('main', 'write_file', { file_path: 'a' }), false);
});

test('allowed-tools skips the card for the named tool in the turn that loads the skill, and the next message asks again', async (t) => {
  const { runtime, asked, model, workspace } = session(
    t,
    [
      { message: assistant('', [call('s', 'skill', { name: 'scribe' })]) },
      {
        message: assistant('', [
          call('w1', 'write_file', { file_path: 'one.txt', content: '1' }),
          call('e1', 'execute', { command: touch('two.txt') }),
        ]),
      },
      { message: assistant('first done') },
      {
        message: assistant('', [
          call('w2', 'write_file', { file_path: 'three.txt', content: '3' }),
        ]),
      },
      { message: assistant('second done') },
    ],
    {
      prepare: ({ workspace }) =>
        skillFile(workspace, 'scribe', 'allowed-tools: write_file'),
    },
  );
  await runtime.harness.run('first');
  assert.equal(readFileSync(join(workspace, 'one.txt'), 'utf8'), '1');
  assert.deepEqual(
    asked.map((entry) => entry.name),
    ['execute'],
  );
  assert.ok(existsSync(join(workspace, 'two.txt')));
  assert.ok(names(model.requests[1]!.tools).includes('write_file'));
  assert.doesNotMatch(resultOf(runtime, 's'), /did not apply/);

  await runtime.harness.run('second');
  assert.deepEqual(
    asked.map((entry) => entry.name),
    ['execute', 'write_file'],
    'the grant ended with the person’s next message',
  );
  assert.equal(readFileSync(join(workspace, 'three.txt'), 'utf8'), '3');
});

test('where nobody can answer a card, the named tool runs and a call that would ask is not run', async (t) => {
  const { runtime, workspace } = session(
    t,
    [
      { message: assistant('', [call('s', 'skill', { name: 'scribe' })]) },
      {
        message: assistant('', [
          call('w', 'write_file', { file_path: 'one.txt', content: '1' }),
          call('e', 'execute', { command: touch('two.txt') }),
        ]),
      },
      { message: assistant('done') },
    ],
    {
      unattended: true,
      prepare: ({ workspace }) =>
        skillFile(workspace, 'scribe', 'allowed-tools: write_file'),
    },
  );
  await runtime.harness.run('go');
  assert.equal(readFileSync(join(workspace, 'one.txt'), 'utf8'), '1');
  assert.equal(existsSync(join(workspace, 'two.txt')), false);
  assert.match(resultOf(runtime, 'e'), /needs --yolo or approval/);
});

test('a command pattern pre-approves the commands it covers and no others', async (t) => {
  const { runtime, asked, workspace } = session(
    t,
    [
      { message: assistant('', [call('s', 'skill', { name: 'touchy' })]) },
      {
        message: assistant('', [
          call('a', 'execute', { command: touch('covered.txt') }),
          call('b', 'execute', { command: touch('other.dat') }),
          call('c', 'execute', {
            command: `${touch('covered.txt')} && ${touch('x.dat')}`,
          }),
        ]),
      },
      { message: assistant('done') },
    ],
    {
      prepare: ({ workspace }) =>
        skillFile(
          workspace,
          'touchy',
          'allowed-tools: Bash(* touch.mjs *.txt)',
        ),
    },
  );
  await runtime.harness.run('go');
  assert.ok(existsSync(join(workspace, 'covered.txt')));
  assert.ok(existsSync(join(workspace, 'other.dat')));
  assert.ok(existsSync(join(workspace, 'x.dat')));
  assert.equal(asked.length, 2);
  assert.deepEqual(
    runtime.harness.messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.tool_call_id),
    ['s', 'a', 'b', 'c'],
  );
});

test('a pre-approval does not widen what always asks, what is refused, or read-only mode', async (t) => {
  const { runtime, asked, workspace } = session(
    t,
    [
      { message: assistant('', [call('s', 'skill', { name: 'broad' })]) },
      {
        message: assistant('', [
          call('rm', 'execute', { command: 'rm -rf build' }),
          call('sudo', 'execute', { command: 'sudo true' }),
          call('del', 'delete', { file_path: 'keep.txt' }),
          call('ok', 'execute', { command: touch('fine.txt') }),
        ]),
      },
      { message: assistant('done') },
    ],
    {
      answer: () => 'reject',
      prepare: ({ workspace }) => {
        skillFile(workspace, 'broad', 'allowed-tools: Bash delete');
        mkdirSync(join(workspace, 'build'));
        writeFileSync(join(workspace, 'keep.txt'), 'kept');
      },
    },
  );
  await runtime.harness.run('go');
  assert.deepEqual(
    asked.map((entry) => entry.name),
    ['execute', 'delete'],
  );
  assert.ok(existsSync(join(workspace, 'fine.txt')));
  assert.ok(existsSync(join(workspace, 'build')));
  assert.equal(readFileSync(join(workspace, 'keep.txt'), 'utf8'), 'kept');
  assert.match(resultOf(runtime, 'sudo'), /sudo|Denied|refused/i);
  assert.match(resultOf(runtime, 'rm'), /rejected/);
});

test('read-only mode still refuses a write the skill pre-approved', async (t) => {
  const { runtime, asked, workspace } = session(
    t,
    [
      { message: assistant('', [call('s', 'skill', { name: 'scribe' })]) },
      {
        message: assistant('', [
          call('w', 'write_file', { file_path: 'plan.txt', content: 'x' }),
        ]),
      },
      { message: assistant('done') },
    ],
    {
      prepare: ({ workspace }) =>
        skillFile(workspace, 'scribe', 'allowed-tools: write_file'),
    },
  );
  runtime.harness.planMode = true;
  await runtime.harness.run('plan it');
  assert.equal(existsSync(join(workspace, 'plan.txt')), false);
  assert.match(resultOf(runtime, 'w'), /read-only/);
  assert.equal(asked.length, 0);
});

test('a hook that asks still gets its card for a pre-approved tool', async (t) => {
  const { runtime, asked, workspace } = session(
    t,
    [
      { message: assistant('', [call('s', 'skill', { name: 'scribe' })]) },
      {
        message: assistant('', [
          call('w', 'write_file', { file_path: 'a.txt', content: 'x' }),
        ]),
      },
      { message: assistant('done') },
    ],
    {
      prepare: ({ home, workspace }) => {
        skillFile(workspace, 'scribe', 'allowed-tools: write_file');
        const script = join(home, 'ask.mjs');
        writeFileSync(
          script,
          "process.stdout.write(JSON.stringify({ decision: 'ask', reason: 'look first' }));",
        );
        writeFileSync(
          join(home, 'hooks.json'),
          JSON.stringify({
            version: 1,
            hooks: {
              before_tool: [
                {
                  name: 'ask',
                  command: `"${process.execPath}" "${script}"`,
                  tools: 'write_file',
                },
              ],
            },
          }),
        );
      },
    },
  );
  await runtime.harness.run('go');
  assert.deepEqual(
    asked.map((entry) => entry.name),
    ['write_file'],
  );
  assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'x');
});

test('a steering message or a queued follow-up ends the grant like any message', async (t) => {
  for (const kind of ['steer', 'followUp'] as const) {
    let runtime!: AgentRuntime;
    const dirs = folders(t);
    skillFile(dirs.workspace, 'scribe', 'allowed-tools: write_file');
    const write = (id: string, file: string) =>
      assistant('', [call(id, 'write_file', { file_path: file, content: id })]);
    const model = new ScriptedModel([
      { message: assistant('', [call('s', 'skill', { name: 'scribe' })]) },
      async () => {
        runtime.harness.queue('change course', kind);
        return { message: write('w1', `${kind}-1.txt`), usage: emptyUsage() };
      },
      ...(kind === 'steer'
        ? [
            { message: write('w2', `${kind}-2.txt`) },
            { message: assistant('done') },
          ]
        : [
            { message: assistant('first turn done') },
            { message: write('w2', `${kind}-2.txt`) },
            { message: assistant('and done') },
          ]),
    ]);
    const asked: string[] = [];
    runtime = new AgentRuntime({
      ...dirs,
      settings: defaultSettings(),
      model,
      headless: true,
      approve: async (toolCall) => {
        asked.push(String(toolCall.args.file_path));
        return 'approve';
      },
    });
    cleanup(t, () => runtime.close());
    await runtime.harness.run('go');
    assert.deepEqual(
      asked,
      [`${kind}-2.txt`],
      `${kind}: the first write was covered, the one after the message was not`,
    );
    assert.ok(existsSync(join(dirs.workspace, `${kind}-1.txt`)));
    assert.ok(existsSync(join(dirs.workspace, `${kind}-2.txt`)));
  }
});

test('disallowed-tools keeps a tool from the model until the person’s next message, and a call to it fails', async (t) => {
  const { runtime, model, workspace } = session(
    t,
    [
      { message: assistant('', [call('s', 'skill', { name: 'quiet' })]) },
      {
        message: assistant('', [
          call('q', 'question', { questions: [{ question: 'sure?' }] }),
          call('x', 'execute', { command: 'touch no.txt' }),
        ]),
      },
      { message: assistant('first done') },
      { message: assistant('second done') },
    ],
    {
      prepare: ({ workspace }) =>
        skillFile(
          workspace,
          'quiet',
          'disallowed-tools: AskUserQuestion, Bash',
        ),
    },
  );
  await runtime.harness.run('first');
  assert.ok(names(model.requests[0]!.tools).includes('question'));
  assert.ok(names(model.requests[0]!.tools).includes('execute'));
  assert.ok(!names(model.requests[1]!.tools).includes('question'));
  assert.ok(!names(model.requests[1]!.tools).includes('execute'));
  assert.ok(names(model.requests[1]!.tools).includes('read_file'));
  assert.match(resultOf(runtime, 'q'), /tool is not available: question/);
  assert.match(resultOf(runtime, 'x'), /tool is not available: execute/);
  assert.equal(existsSync(join(workspace, 'no.txt')), false);
  await runtime.harness.run('second');
  assert.ok(names(model.requests[3]!.tools).includes('question'));
  assert.ok(names(model.requests[3]!.tools).includes('execute'));
});

test('a skill the person loads applies to the turn their next message starts, and to no other', async (t) => {
  const { runtime, model, asked, workspace } = session(t, [
    {
      message: assistant('', [
        call('w1', 'write_file', { file_path: 'a.txt', content: 'a' }),
      ]),
    },
    { message: assistant('one') },
    {
      message: assistant('', [
        call('w2', 'write_file', { file_path: 'b.txt', content: 'b' }),
      ]),
    },
    { message: assistant('two') },
  ]);
  skillFile(workspace, 'scribe', 'allowed-tools: write_file');
  skillFile(workspace, 'quiet', 'disallowed-tools: question');
  const catalog = discoverSkills(
    workspace,
    runtime.options.home,
    runtime.options.userHome,
    false,
  );
  const scribe = catalog.find((skill) => skill.name === 'scribe')!;
  const quiet = catalog.find((skill) => skill.name === 'quiet')!;
  const loaded = runtime.applySkillTools(scribe, 'person');
  assert.deepEqual(loaded.lines, [
    'pre-approved for your next message: write_file',
  ]);
  assert.deepEqual(runtime.applySkillTools(quiet, 'person').lines, [
    'not offered for your next message: question',
  ]);
  await runtime.harness.run('first');
  assert.equal(asked.length, 0, 'covered in the turn the next message started');
  assert.ok(!names(model.requests[0]!.tools).includes('question'));
  await runtime.harness.run('second');
  assert.deepEqual(
    asked.map((entry) => entry.name),
    ['write_file'],
  );
  assert.ok(names(model.requests[2]!.tools).includes('question'));
  assert.equal(readFileSync(join(workspace, 'b.txt'), 'utf8'), 'b');
});

test('a skill that names what is not a tool still loads, applies the rest and says what it did not', async (t) => {
  const { runtime, asked, workspace } = session(
    t,
    [
      { message: assistant('', [call('s', 'skill', { name: 'typo' })]) },
      {
        message: assistant('', [
          call('w', 'write_file', { file_path: 'a.txt', content: 'a' }),
        ]),
      },
      { message: assistant('done') },
    ],
    {
      prepare: ({ workspace }) =>
        skillFile(
          workspace,
          'typo',
          'allowed-tools: write_file, writ_file\ndisallowed-tools: Read(x)',
        ),
    },
  );
  await runtime.harness.run('go');
  assert.equal(asked.length, 0);
  assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'a');
  const told = resultOf(runtime, 's');
  assert.match(told, /^<skill_content name="typo">/);
  assert.match(
    told,
    /Circle did not apply:\n- typo names tools that do not exist in allowed-tools: writ_file · not applied\n- typo disallowed-tools Read\(x\): a whole tool is withheld, never part of its calls · not applied$/,
  );
});

test('a subagent started while a skill keeps a tool from the model is kept from it too, and it is not given the pre-approvals', async (t) => {
  const { runtime, model, asked, workspace } = session(
    t,
    [
      { message: assistant('', [call('s', 'skill', { name: 'strict' })]) },
      {
        message: assistant('', [
          call('t', 'task', {
            description: 'write it',
            subagent_type: 'general-purpose',
          }),
        ]),
      },
      {
        message: assistant('', [
          call('cw', 'write_file', { file_path: 'child.txt', content: 'c' }),
        ]),
      },
      { message: assistant('child done') },
      { message: assistant('first done') },
      {
        message: assistant('', [
          call('t2', 'task', {
            description: 'look',
            subagent_type: 'general-purpose',
          }),
        ]),
      },
      { message: assistant('second child done') },
      { message: assistant('second done') },
    ],
    {
      prepare: ({ workspace }) =>
        skillFile(
          workspace,
          'strict',
          'allowed-tools: write_file\ndisallowed-tools: webfetch, websearch',
        ),
    },
  );
  await runtime.harness.run('first');
  const first = names(model.requests[2]!.tools);
  assert.ok(first.includes('write_file'));
  assert.ok(!first.includes('webfetch'), first.join());
  assert.ok(!first.includes('websearch'));
  assert.deepEqual(
    asked.map((entry) => entry.name),
    ['write_file'],
  );
  assert.ok(asked[0]!.origin?.agent, 'the card is the subagent’s');
  assert.equal(readFileSync(join(workspace, 'child.txt'), 'utf8'), 'c');
  await runtime.harness.run('second');
  assert.ok(names(model.requests[6]!.tools).includes('webfetch'));
});

test('a subagent that loads a skill gets that skill’s fields for itself only', async (t) => {
  const { runtime, model, asked } = session(
    t,
    [
      {
        message: assistant('', [
          call('t', 'task', {
            description: 'use the skill',
            subagent_type: 'general-purpose',
          }),
        ]),
      },
      { message: assistant('', [call('cs', 'skill', { name: 'scribe' })]) },
      {
        message: assistant('', [
          call('cw', 'write_file', { file_path: 'c.txt', content: 'c' }),
        ]),
      },
      { message: assistant('child done') },
      {
        message: assistant('', [
          call('w', 'write_file', { file_path: 'm.txt', content: 'm' }),
        ]),
      },
      { message: assistant('done') },
    ],
    {
      prepare: ({ workspace }) =>
        skillFile(workspace, 'scribe', 'allowed-tools: write_file'),
    },
  );
  await runtime.harness.run('go');
  assert.equal(model.requests.length, 6);
  assert.deepEqual(
    asked.map((entry) => [entry.name, entry.origin?.agent === undefined]),
    [['write_file', true]],
  );
});

test('a skill file’s fields are listed by the runtime against the tools it has', (t) => {
  const { runtime, workspace } = session(t, []);
  skillFile(
    workspace,
    'mixed',
    'allowed-tools: Read, nothing_here\ndisallowed-tools: AskUserQuestion',
  );
  const skill: SkillInfo = discoverSkills(
    workspace,
    runtime.options.home,
    runtime.options.userHome,
    false,
  ).find((found) => found.name === 'mixed')!;
  const tools = runtime.skillTools(skill);
  assert.deepEqual(tools.allowed, [{ tool: 'read_file' }]);
  assert.deepEqual(tools.withheld, ['question']);
  assert.deepEqual(tools.problems, [
    'mixed names tools that do not exist in allowed-tools: nothing_here · not applied',
  ]);
});
