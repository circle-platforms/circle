import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AgentRuntime,
  BUILTIN_SUBAGENT_PROMPTS,
  builtinSubagentPrompt,
} from '../src/runtime.js';
import { discoverSubagents } from '../src/subagent_files.js';
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
      ['inspector', 'Circle'],
    ],
  );
  assert.deepEqual(listed.problems, []);
  assert.match(listed.agents[2]!.path ?? '', /agents/);
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
  const listed = runtime.inspectSubagents();
  assert.deepEqual(
    listed.agents.map((agent) => [agent.name, agent.source]),
    [
      ['general-purpose', 'Circle'],
      ['explore', 'Circle'],
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
