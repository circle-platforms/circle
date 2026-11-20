import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AgentRuntime,
  BUILTIN_SUBAGENT_PROMPTS,
  builtinSubagentPrompt,
} from '../src/runtime.js';
import {
  discoverSubagents,
  readSubagentFolder,
} from '../src/subagent_files.js';
import { parseFrontmatter, splitFrontmatter } from '../src/skills.js';
import { skillFrontmatterHooks } from '../src/hook_config.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

// A run that is not headless: the subagent list reaches the `task` description with the
// integrations, which `circle -p` skips unless it asks for them.

const assistant = (
  text: string,
  calls: Message['tool_calls'] = [],
): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  content: text,
  tool_calls: calls,
});
const folders = (...paths: string[]): void => {
  for (const path of paths) mkdirSync(path, { recursive: true });
};
const agentFile = (dir: string, name: string, body: string): void => {
  folders(dir);
  writeFileSync(join(dir, name), body);
};
/** Write an extension into the data folder, as an install would. */
function extension(root: string, name: string, source: string): void {
  const path = join(root, name);
  folders(path);
  writeFileSync(join(path, 'extension.mjs'), source);
}
/** Home, workspace and user home, none of them the person's own. */
function harness(root: string): {
  home: string;
  workspace: string;
  userHome: string;
} {
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const userHome = join(root, 'user');
  folders(home, workspace, userHome);
  return { home, workspace, userHome };
}
/** One `task` call for a named subagent, then a child answer and a main answer. */
function taskModel(name: string): ScriptedModel {
  return new ScriptedModel([
    {
      message: assistant('', [
        {
          id: 'task',
          name: 'task',
          args: { description: 'look', subagent_type: name },
        },
      ]),
    },
    { message: assistant('child done') },
    { message: assistant('main done') },
  ]);
}

test('agent folders are read, a later folder replaces a name, and a bad file says why', (t) => {
  const root = scratch(t);
  const { home, workspace, userHome } = harness(root);
  agentFile(
    join(home, 'agents'),
    'inspector.md',
    '---\nname: inspector\ndescription: Reads the project.\n---\n\nuser prompt\n',
  );
  agentFile(
    join(workspace, '.circle/agents'),
    'inspector.md',
    '---\nname: inspector\ndescription: Reads the project from the folder.\nmodel: other-model\ntools: read_file, grep\n---\n\nproject prompt\n',
  );
  agentFile(
    join(workspace, '.circle/agents'),
    'notes.txt',
    'ignored: not markdown\n',
  );
  agentFile(
    join(workspace, '.circle/agents'),
    'spaced.md',
    '---\nname: not a name\ndescription: x\n---\n\nbody\n',
  );
  agentFile(
    join(workspace, '.circle/agents'),
    'nodesc.md',
    '---\nname: nodesc\n---\n\nbody\n',
  );
  agentFile(
    join(workspace, '.circle/agents'),
    'hollow.md',
    '---\nname: hollow\ndescription: nothing below\n---\n\n   \n',
  );
  agentFile(
    join(workspace, '.claude/agents'),
    'twin-a.md',
    '---\nname: twin\ndescription: first\n---\n\na\n',
  );
  agentFile(
    join(workspace, '.claude/agents'),
    'twin-b.md',
    '---\nname: twin\ndescription: second\n---\n\nb\n',
  );
  const found = discoverSubagents(workspace, home, userHome);
  assert.deepEqual(found.agents.map((agent) => agent.spec.name).sort(), [
    'inspector',
    'twin',
  ]);
  const inspector = found.agents.find(
    (agent) => agent.spec.name === 'inspector',
  )!;
  // The project's folder beats the data folder's, and carries the tools and model it names.
  assert.match(inspector.spec.system_prompt, /project prompt/);
  assert.equal(inspector.spec.model, 'other-model');
  assert.deepEqual(inspector.tools, ['read_file', 'grep']);
  assert.equal(inspector.source_label, 'Project Circle');
  // Nothing is passed over in silence: each unusable file is named with its reason.
  const problems = found.problems.join('\n');
  assert.match(problems, /spaced\.md: 'not a name' is not a name/);
  assert.match(problems, /nodesc\.md: no description/);
  assert.match(problems, /hollow\.md: no prompt after the --- lines/);
  assert.match(problems, /two files in .* claim 'twin'/);
  assert.equal(found.agents.length, 2, 'only the markdown files were read');
});

test('task chooses a file-defined agent, with its prompt, tools and the list the model sees', async (t) => {
  const root = scratch(t);
  const { home, workspace, userHome } = harness(root);
  agentFile(
    join(home, 'agents'),
    'inspector.md',
    '---\nname: inspector\ndescription: Reads the project and reports.\ntools: read_file, grep\n---\n\nfolder agent marker\n',
  );
  const model = taskModel('inspector');
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome,
    settings: defaultSettings(),
    model,
  });
  cleanup(t, () => runtime.close());
  const result = await runtime.harness.run('inspect the project');
  assert.equal(result.answer, 'main done');
  assert.match(model.requests[1]!.system, /folder agent marker/);
  assert.deepEqual(
    model.requests[1]!.tools.map((tool) => tool.name),
    ['read_file', 'grep'],
  );
  // The model is told it exists, once, with the file's description.
  const description = runtime.harness.tools.find(
    (tool) => tool.name === 'task',
  )!.description;
  assert.equal(description.split('- inspector:').length - 1, 1);
  assert.match(description, /inspector: Reads the project and reports\./);
  const listed = runtime.inspectSubagents();
  assert.deepEqual(
    listed.agents.map((agent) => [agent.name, agent.source]),
    [
      ['general-purpose', 'Circle'],
      ['explore', 'Circle'],
      ['plan', 'Circle'],
      ['inspector', 'Circle'],
    ],
  );
  assert.deepEqual(listed.problems, []);
  assert.match(listed.agents[3]!.path ?? '', /agents/);
});

test('a file may replace a built-in agent, and keeps the default tools', async (t) => {
  const root = scratch(t);
  const { home, workspace, userHome } = harness(root);
  agentFile(
    join(home, 'agents'),
    'explore.md',
    '---\nname: explore\ndescription: My own exploration agent.\n---\n\nfile explore marker\n',
  );
  const model = taskModel('explore');
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome,
    settings: defaultSettings(),
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('explore it');
  assert.match(model.requests[1]!.system, /file explore marker/);
  // Not the read-only set any more: replacing it means replacing the built-in.
  assert.ok(
    model.requests[1]!.tools.some((tool) => tool.name === 'write_file'),
    'the file-defined explore gets the default tools',
  );
  // and is not held read-only by the built-in's name
  assert.doesNotMatch(model.requests[1]!.system, /Read-only mode/);
  const listed = runtime.inspectSubagents();
  assert.deepEqual(
    listed.agents.map((agent) => [agent.name, agent.source]),
    [
      ['general-purpose', 'Circle'],
      ['explore', 'Circle'],
      ['plan', 'Circle'],
    ],
  );
});

test('an extension that claims a name wins over the file of that name', async (t) => {
  const root = scratch(t);
  const { home, workspace, userHome } = harness(root);
  agentFile(
    join(home, 'agents'),
    'referee.md',
    '---\nname: referee\ndescription: The file version.\n---\n\nfile marker\n',
  );
  extension(
    join(home, 'extensions'),
    'refs',
    'export function register(api){api.registerSubagent({name:"referee",description:"The extension version.",system_prompt:"extension marker"})}',
  );
  const model = taskModel('referee');
  // Not headless: an extension registers itself with the integrations, which a headless
  // run does not load.
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome,
    settings: defaultSettings(),
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('call the referee');
  assert.match(model.requests[1]!.system, /extension marker/);
  assert.doesNotMatch(model.requests[1]!.system, /file marker/);
  const referee = runtime
    .inspectSubagents()
    .agents.find((agent) => agent.name === 'referee')!;
  assert.equal(referee.source, 'Extension');
  assert.match(referee.description, /The extension version\./);
});

test('an agent naming a tool that does not exist is not offered, and says why', async (t) => {
  const root = scratch(t);
  const { home, workspace, userHome } = harness(root);
  agentFile(
    join(home, 'agents'),
    'ghost.md',
    '---\nname: ghost\ndescription: Needs a tool that is not there.\ntools: read_file, no_such_tool\n---\n\nghost marker\n',
  );
  const model = taskModel('ghost');
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome,
    settings: defaultSettings(),
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('use the ghost');
  assert.match(
    runtime.harness.messages.find((message) => message.tool_call_id === 'task')!
      .content,
    /unknown subagent type/,
  );
  const listed = runtime.inspectSubagents();
  assert.ok(!listed.agents.some((agent) => agent.name === 'ghost'));
  assert.match(
    listed.problems.join('\n'),
    /ghost names tools that do not exist: no_such_tool · not offered/,
  );
});

test('general-purpose works from a prompt for general tasks, and a built-in without its prompt file says which file', async (t) => {
  const root = scratch(t);
  const { home, workspace, userHome } = harness(root);
  const model = taskModel('general-purpose');
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome,
    settings: defaultSettings(),
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('do it');
  // Not the prompt that writes agent configurations (#547)
  const system = model.requests[1]!.system;
  assert.match(system, /general-purpose agent/);
  assert.doesNotMatch(system, /agent architect|whenToUse|"identifier"/);
  // Every built-in has its own file; a missing one is named, not replaced by another
  assert.deepEqual(Object.keys(BUILTIN_SUBAGENT_PROMPTS).sort(), [
    'explore',
    'general-purpose',
    'plan',
  ]);
  assert.throws(
    () => builtinSubagentPrompt('general-purpose', join(root, 'no-prompts')),
    /general-purpose subagent has no prompt: prompts\/agent\/general-purpose\.md is missing/,
  );
});

test("a definition's effort is sent with its subagent's requests, the run's CIRCLE_REASONING_EFFORT wins, and a word that is no depth does not load", async (t) => {
  const root = scratch(t);
  const { home, workspace, userHome } = harness(root);
  agentFile(
    join(workspace, '.circle', 'agents'),
    'checker.md',
    '---\nname: checker\ndescription: Checks each line.\neffort: high\n---\n\nCheck it.\n',
  );
  agentFile(
    join(workspace, '.circle', 'agents'),
    'odd.md',
    '---\nname: odd\ndescription: Odd depth.\neffort: extreme\n---\n\nOdd.\n',
  );
  const settings = defaultSettings();
  settings.trusted_folders = [workspace];
  const run = async () => {
    const model = taskModel('checker');
    const runtime = new AgentRuntime({
      home,
      workspace,
      userHome,
      settings,
      model,
    });
    cleanup(t, () => runtime.close());
    await runtime.harness.run('check');
    return { model, runtime };
  };
  const saved = process.env.CIRCLE_REASONING_EFFORT;
  t.after(() => {
    if (saved === undefined) delete process.env.CIRCLE_REASONING_EFFORT;
    else process.env.CIRCLE_REASONING_EFFORT = saved;
  });
  delete process.env.CIRCLE_REASONING_EFFORT;
  const own = await run();
  // The conversation asks for no depth of its own; the subagent asks for its definition's
  assert.equal(own.model.requests[0]!.effort, undefined);
  assert.equal(own.model.requests[1]!.effort, 'high');
  const listed = own.runtime.inspectSubagents();
  assert.equal(
    listed.agents.find((agent) => agent.name === 'checker')?.effort,
    'high',
  );
  assert.ok(
    listed.problems.some((line) =>
      /odd\.md: effort 'extreme' is not one of minimal, low, medium, high, xhigh, max/.test(
        line,
      ),
    ),
  );
  process.env.CIRCLE_REASONING_EFFORT = 'low';
  const env = await run();
  assert.equal(env.model.requests[1]!.effort, 'low');
});

test("an extension's subagent can carry an effort too, and one that is no depth is refused", async (t) => {
  const root = scratch(t);
  const { home, workspace, userHome } = harness(root);
  extension(
    join(home, 'extensions'),
    'deep',
    'export function register(api){api.registerSubagent({name:"deep",description:"Thinks hard.",system_prompt:"deep marker",effort:"max"})}',
  );
  extension(
    join(home, 'extensions'),
    'odd',
    'export function register(api){api.registerSubagent({name:"odd",description:"Odd.",system_prompt:"odd",effort:"extreme"})}',
  );
  const saved = process.env.CIRCLE_REASONING_EFFORT;
  delete process.env.CIRCLE_REASONING_EFFORT;
  t.after(() => {
    if (saved !== undefined) process.env.CIRCLE_REASONING_EFFORT = saved;
  });
  const model = taskModel('deep');
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome,
    settings: defaultSettings(),
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('think');
  assert.equal(model.requests[1]!.effort, 'max');
  assert.equal(
    runtime.inspectSubagents().agents.some((agent) => agent.name === 'odd'),
    false,
  );
});

/** One definition with these keys between its name, description and prompt. */
const definition = (folder: string, name: string, keys: string): void => {
  folders(folder);
  writeFileSync(
    join(folder, `${name}.md`),
    `---\nname: ${name}\ndescription: The ${name} agent.\n${keys}---\nYou are ${name}.\n`,
  );
};

test('the new keys are read from YAML, and a value a key does not take keeps the file from being offered', (t) => {
  const root = realpathSync(scratch(t));
  const folder = join(root, 'agents');
  definition(
    folder,
    'full',
    [
      'tools:',
      '  - read_file',
      '  - task(worker, researcher)',
      '  - mcp__github__*',
      'disallowedTools: execute(git push *), write_file',
      'permissionMode: manual',
      'maxTurns: 4',
      'skills: [conventions, errors, conventions]',
      'mcpServers:',
      '  - github',
      'hooks:',
      '  PreToolUse:',
      '    - matcher: execute',
      '      hooks:',
      '        - type: command',
      '          command: check',
      '  Stop:',
      '    - matcher: ignored',
      '      hooks:',
      '        - type: command',
      '          command: done',
      '          once: true',
      'memory: project',
      'isolation: worktree',
      'color: red',
      'background: true',
      'sessionPrompt: false',
      '',
    ].join('\n'),
  );
  // A description with a colon is no YAML: name, description, model and effort still read one line each
  writeFileSync(
    join(folder, 'plain.md'),
    '---\nname: plain\ndescription: Checks: everything\nmodel: other-model\neffort: high\n---\nPlain.\n',
  );
  for (const [name, keys] of [
    ['mode', 'permissionMode: sometimes\n'],
    ['turns', 'maxTurns: 0\n'],
    ['colour', 'color: magenta\n'],
    ['isolated', 'isolation: container\n'],
    ['remembers', 'memory: everywhere\n'],
    ['later', 'background: maybe\n'],
    ['noisy', 'sessionPrompt: sometimes\n'],
    ['none', 'tools: []\n'],
    [
      'inline',
      'mcpServers:\n  - playwright:\n      type: stdio\n      command: npx\n',
    ],
    ['badhook', 'hooks:\n  PreToolUse:\n    - hooks:\n        - type: http\n'],
  ] as const)
    definition(folder, name, keys);
  writeFileSync(
    join(folder, 'notyaml.md'),
    '---\nname: notyaml\ndescription: Hooks: under a line that is no YAML\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: x\n---\nNo.\n',
  );
  const { agents, problems } = readSubagentFolder(folder, 'Circle');
  const full = agents.find((item) => item.spec.name === 'full')!;
  assert.deepEqual(full.tools, ['read_file', 'task', 'mcp__github__*']);
  assert.deepEqual(full.disallowedTools, ['execute', 'write_file']);
  assert.equal(full.permissionMode, 'default');
  assert.equal(full.maxTurns, 4);
  assert.deepEqual(full.skills, ['conventions', 'errors']);
  assert.deepEqual(full.mcpServers, ['github']);
  // A subagent's Stop is its SubagentStop, matching every type; `once` is a skill's alone
  assert.deepEqual(
    full.hooks!.map((hook) => [hook.event, hook.matcher.kind, hook.once]),
    [
      ['PreToolUse', 'names', false],
      ['SubagentStop', 'all', false],
    ],
  );
  assert.equal(full.hooks![0]!.sourceLabel, 'agent:full');
  assert.deepEqual(
    [
      full.memory,
      full.isolation,
      full.color,
      full.background,
      full.sessionPrompt,
    ],
    ['project', 'worktree', 'red', true, false],
  );
  const plain = agents.find((item) => item.spec.name === 'plain')!;
  assert.deepEqual(
    [plain.spec.description, plain.spec.model, plain.spec.effort],
    ['Checks: everything', 'other-model', 'high'],
  );
  assert.deepEqual(agents.map((item) => item.spec.name).sort(), [
    'full',
    'plain',
  ]);
  const said = problems.join('\n');
  for (const reason of [
    /mode\.md: permissionMode 'sometimes' is not one of default, acceptEdits, auto, dontAsk, bypassPermissions, plan/,
    /turns\.md: maxTurns must be a whole number from 1, not 0/,
    /colour\.md: color 'magenta' is not one of red, blue, green, yellow, purple, orange, pink, cyan/,
    /isolated\.md: isolation 'container' is not one of worktree/,
    /remembers\.md: memory 'everywhere' is not one of user, project, local/,
    /later\.md: background must be true or false/,
    /noisy\.md: sessionPrompt must be true or false, not "sometimes"/,
    /none\.md: tools lists no tool/,
    /inline\.md: mcpServers: playwright is defined inline, which Circle does not support yet/,
    /badhook\.md: hooks: .*http hooks are not supported in Circle yet/,
    /notyaml\.md: the frontmatter is not YAML \(.+\), so hooks cannot be read/,
  ])
    assert.match(said, reason);
});

test("a pack's definition gets no hooks, MCP servers or permission mode of its own, and says it ignored them", (t) => {
  const root = realpathSync(scratch(t));
  const folder = join(root, 'agents');
  definition(
    folder,
    'reviewer',
    'permissionMode: acceptEdits\nmcpServers: [github]\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: x\nmaxTurns: 3\n',
  );
  const { agents, problems } = readSubagentFolder(folder, 'Pack kit', true);
  assert.deepEqual(problems, []);
  const [reviewer] = agents;
  assert.deepEqual(reviewer!.ignored, [
    'hooks',
    'mcpServers',
    'permissionMode',
  ]);
  assert.equal(reviewer!.hooks, undefined);
  assert.equal(reviewer!.mcpServers, undefined);
  assert.equal(reviewer!.permissionMode, undefined);
  assert.equal(reviewer!.maxTurns, 3);
});

test('every reader finds the same frontmatter, keys in any case, and a guard that needs YAML is never dropped quietly', (t) => {
  const root = realpathSync(scratch(t));
  const folder = join(root, 'agents');
  folders(folder);
  const files: Record<string, string> = {
    // A closing line that says more, or has a dash more, still closes it
    'comment.md':
      '---\nname: comment\ndescription: Reads.\ntools: read_file, grep\npermissionMode: plan\nhooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: check\n--- # end\nPrompt.\n',
    'dashes.md':
      '---\nname: dashes\ndescription: Reads.\ntools: read_file\ndisallowedTools: execute\n----\nPrompt.\n',
    'cased.md':
      '---\nName: cased\nDescription: Reads.\nTools: read_file, grep\nPermissionMode: dontAsk\nMaxTurns: 3\n---\nPrompt.\n',
    'windows.md':
      '---\r\nname: windows\r\ndescription: Reads.\r\ntools:\r\n  - read_file\r\n  - grep\r\npermissionMode: plan\r\n---\r\nPrompt.\r\n',
    // Not YAML, with keys that need it: refused with the reason, whatever case they are in
    'colon.md':
      '---\nname: colon\ndescription: Reviewer: reads only\ndisallowedTools: [execute, write_file]\n---\nPrompt.\n',
    'twice.md':
      '---\nname: twice\ndescription: x\ntools: read_file\ntools: execute\n---\nPrompt.\n',
    'twocases.md':
      '---\nname: twocases\ndescription: x\ntools: read_file\nTools: execute\n---\nPrompt.\n',
    'true.md':
      '---\nname: true\ndescription: x\nmaxTurns: true\n---\nPrompt.\n',
    'list.md': '---\nname: list\ndescription: x\nmaxTurns: [5]\n---\nPrompt.\n',
    'hex.md':
      '---\nname: hex\ndescription: x\nmaxTurns: "0x10"\n---\nPrompt.\n',
    'quoted.md':
      '---\nname: quoted\ndescription: x\nmaxTurns: "7"\n---\nPrompt.\n',
  };
  for (const [file, text] of Object.entries(files))
    writeFileSync(join(folder, file), text);
  const { agents, problems } = readSubagentFolder(folder, 'Circle');
  const one = (name: string) => agents.find((item) => item.spec.name === name)!;
  assert.deepEqual(one('comment').tools, ['read_file', 'grep']);
  assert.equal(one('comment').permissionMode, 'plan');
  assert.equal(one('comment').hooks?.length, 1);
  assert.equal(one('comment').spec.system_prompt, 'Prompt.');
  assert.deepEqual(one('dashes').disallowedTools, ['execute']);
  assert.deepEqual(
    [one('cased').tools, one('cased').permissionMode, one('cased').maxTurns],
    [['read_file', 'grep'], 'dontAsk', 3],
  );
  assert.deepEqual(one('windows').tools, ['read_file', 'grep']);
  assert.equal(one('windows').permissionMode, 'plan');
  assert.equal(one('quoted').maxTurns, 7);
  assert.deepEqual(agents.map((item) => item.spec.name).sort(), [
    'cased',
    'comment',
    'dashes',
    'quoted',
    'windows',
  ]);
  const said = problems.join('\n');
  for (const reason of [
    /colon\.md: the frontmatter is not YAML \(.+\), so disallowedTools cannot be read/,
    /twice\.md: the frontmatter is not YAML \(Map keys must be unique.*\), so tools cannot be read/,
    /twocases\.md: Tools is written twice, in different cases/,
    /true\.md: maxTurns must be a whole number from 1, not true/,
    /list\.md: maxTurns must be a whole number from 1, not \[5\]/,
    /hex\.md: maxTurns must be a whole number from 1, not "0x10"/,
  ])
    assert.match(said, reason);
  // The plain reader, a skill's hooks and a hooks move find the same lines
  const skill =
    '---\nname: guarded\ndescription: x\nHooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: check\n--- # end\nBody.\n';
  assert.deepEqual(parseFrontmatter(skill).meta.name, 'guarded');
  assert.equal(parseFrontmatter(skill).body, 'Body.\n');
  assert.deepEqual(Object.keys(skillFrontmatterHooks(skill) as object), [
    'PreToolUse',
  ]);
  assert.equal(splitFrontmatter('no frontmatter\n').block, undefined);
});
