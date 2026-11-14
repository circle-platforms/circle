import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message, ModelResponse } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

// Subagents a skill ships in its own `agents` folder (#552)
const reply = (
  text: string,
  calls: Message['tool_calls'] = [],
): Partial<ModelResponse> => ({
  message: {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: text,
    tool_calls: calls,
  },
});
const definition = (name: string, tools?: string) =>
  `---\nname: ${name}\ndescription: Reviews a change\n${tools ? `tools: ${tools}\n` : ''}---\nYou are the ${name} of the kit.\n`;
function kit(t: Parameters<typeof scratch>[0]) {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const user = join(root, 'user');
  const folder = join(user, '.agents', 'skills', 'kit');
  mkdirSync(home);
  mkdirSync(workspace);
  mkdirSync(join(folder, 'agents'), { recursive: true });
  writeFileSync(
    join(folder, 'SKILL.md'),
    '---\nname: kit\ndescription: A kit with reviewers\n---\nUse the reviewer.\n',
  );
  writeFileSync(
    join(folder, 'agents', 'reviewer.md'),
    definition('reviewer', 'read_file'),
  );
  writeFileSync(
    join(folder, 'agents', 'broken.md'),
    definition('broken', 'read_file, no_such_tool'),
  );
  return { home, workspace, user, folder };
}
function runtimeFor(
  t: Parameters<typeof scratch>[0],
  paths: ReturnType<typeof kit>,
  replies: Partial<ModelResponse>[],
) {
  const model = new ScriptedModel(replies);
  const runtime = new AgentRuntime({
    home: paths.home,
    workspace: paths.workspace,
    userHome: paths.user,
    settings: defaultSettings(),
    model,
  });
  cleanup(t, () => runtime.close());
  return { runtime, model };
}
const resultOf = (runtime: AgentRuntime, id: string) =>
  runtime.harness.messages.find((message) => message.tool_call_id === id)!
    .content;
const taskDescription = (request: ScriptedModel['requests'][number]) =>
  request.tools.find((tool) => tool.name === 'task')!.description;

test("a loaded skill's subagents join task's list, run by name, and the model is told which are not offered and why", async (t) => {
  const paths = kit(t);
  const { runtime, model } = runtimeFor(t, paths, [
    reply('', [{ id: 'load', name: 'skill', args: { name: 'kit' } }]),
    reply('', [
      {
        id: 'run',
        name: 'task',
        args: { description: 'review', subagent_type: 'reviewer' },
      },
    ]),
    reply('reviewed'),
    reply('done'),
  ]);
  await runtime.initialize();
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('use the kit');

  // Before the skill loads, task does not offer them
  assert.doesNotMatch(taskDescription(model.requests[0]!), /reviewer/);
  const loaded = resultOf(runtime, 'load');
  assert.match(
    loaded,
    /Subagents the skill kit brings, for task from the next request: reviewer\./,
  );
  assert.match(
    loaded,
    /not offered: broken from the skill kit names tools that do not exist: no_such_tool · not offered/,
  );
  // The next request lists it, and task runs it with its own prompt
  assert.match(
    taskDescription(model.requests[1]!),
    /- reviewer: Reviews a change/,
  );
  assert.doesNotMatch(taskDescription(model.requests[1]!), /- broken:/);
  assert.match(model.requests[2]!.system, /^You are the reviewer of the kit\./);
  assert.match(resultOf(runtime, 'run'), /reviewed/);
  // /agents shows where it came from
  const shown = runtime.inspectSubagents();
  assert.equal(
    shown.agents.find((agent) => agent.name === 'reviewer')?.source,
    'Skill kit',
  );
  assert.ok(
    shown.problems.some((line) => line.startsWith('broken from the skill kit')),
  );
});

test('a pack replaced with a renamed subagent: the old name is unknown, the new one runs', async (t) => {
  const paths = kit(t);
  const { runtime } = runtimeFor(t, paths, [
    reply('', [{ id: 'load', name: 'skill', args: { name: 'kit' } }]),
    reply('', [
      {
        id: 'old',
        name: 'task',
        args: { description: 'review', subagent_type: 'reviewer' },
      },
    ]),
    reply('', [
      {
        id: 'new',
        name: 'task',
        args: { description: 'check', subagent_type: 'checker' },
      },
    ]),
    reply('checked'),
    reply('done'),
  ]);
  await runtime.initialize();
  runtime.policy.setYolo(runtime.session.id, true);
  // The new version renames it, as an upgrade would, once the skill has loaded
  runtime.bus.subscribe((event) => {
    if (event.kind !== 'tool_result' || event.payload.id !== 'load') return;
    renameSync(
      join(paths.folder, 'agents', 'reviewer.md'),
      join(paths.folder, 'agents', 'checker.md'),
    );
    writeFileSync(
      join(paths.folder, 'agents', 'checker.md'),
      definition('checker', 'read_file'),
    );
  });
  await runtime.harness.run('use the kit');
  assert.match(resultOf(runtime, 'old'), /unknown subagent type/);
  assert.match(resultOf(runtime, 'new'), /checked/);
});

test("a skill's subagent with a name already given is not offered: the existing definition stays", async (t) => {
  const paths = kit(t);
  mkdirSync(join(paths.user, '.agents', 'agents'), { recursive: true });
  writeFileSync(
    join(paths.user, '.agents', 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: Your own reviewer\n---\nYou are my reviewer.\n',
  );
  const { runtime } = runtimeFor(t, paths, [
    reply('', [{ id: 'load', name: 'skill', args: { name: 'kit' } }]),
    reply('done'),
  ]);
  await runtime.initialize();
  await runtime.harness.run('use the kit');
  assert.match(
    resultOf(runtime, 'load'),
    /reviewer from the skill kit has a name Agents gives a subagent already · not offered/,
  );
  assert.equal(
    runtime.inspectSubagents().agents.find((agent) => agent.name === 'reviewer')
      ?.description,
    'Your own reviewer',
  );
});
