import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message, ModelResponse } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

// Subagents an installed pack defines in its `agents` folder (#552): there from the start, named `<pack>:<name>`
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
/** An installed pack `kit` with a reviewer and a broken definition, and a skill of your own with an agents folder. */
function packs(t: Parameters<typeof scratch>[0]) {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const user = join(root, 'user');
  const folder = join(user, '.agents', 'skills', 'kit');
  mkdirSync(home);
  mkdirSync(workspace);
  mkdirSync(join(folder, 'agents'), { recursive: true });
  writeFileSync(join(folder, 'pack.json'), '{}');
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
  // Not a pack: no pack.json
  const own = join(user, '.agents', 'skills', 'mine');
  mkdirSync(join(own, 'agents'), { recursive: true });
  writeFileSync(
    join(own, 'SKILL.md'),
    '---\nname: mine\ndescription: A skill of your own\n---\nMine.\n',
  );
  writeFileSync(join(own, 'agents', 'helper.md'), definition('helper'));
  return { home, workspace, user, folder };
}
function runtimeFor(
  t: Parameters<typeof scratch>[0],
  paths: ReturnType<typeof packs>,
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

test("an installed pack's subagents are in task's list from the first request, named <pack>:<name>, and run by that name", async (t) => {
  const paths = packs(t);
  const { runtime, model } = runtimeFor(t, paths, [
    reply('', [
      {
        id: 'run',
        name: 'task',
        args: { description: 'review', subagent_type: 'kit:reviewer' },
      },
    ]),
    reply('reviewed'),
    reply('done'),
  ]);
  await runtime.initialize();
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('review it');

  // No skill was loaded: the pack's subagent is there from the start, under its pack's name
  assert.match(
    taskDescription(model.requests[0]!),
    /- kit:reviewer: Reviews a change/,
  );
  assert.doesNotMatch(taskDescription(model.requests[0]!), /- kit:broken:/);
  // A skill folder that is not a pack brings none
  assert.doesNotMatch(taskDescription(model.requests[0]!), /helper/);
  assert.match(model.requests[1]!.system, /^You are the reviewer of the kit\./);
  assert.match(resultOf(runtime, 'run'), /reviewed/);
  // /agents shows where it came from, and why the other is not offered
  const shown = runtime.inspectSubagents();
  assert.equal(
    shown.agents.find((agent) => agent.name === 'kit:reviewer')?.source,
    'Pack kit',
  );
  assert.ok(
    shown.problems.some((line) =>
      line.startsWith(
        'kit:broken from the pack kit names tools that do not exist: no_such_tool',
      ),
    ),
  );
});

test('a pack replaced with a renamed subagent: the old name is unknown, the new one runs', async (t) => {
  const paths = packs(t);
  const { runtime } = runtimeFor(t, paths, [
    reply('', [
      {
        id: 'old',
        name: 'task',
        args: { description: 'review', subagent_type: 'kit:reviewer' },
      },
    ]),
    reply('', [
      {
        id: 'new',
        name: 'task',
        args: { description: 'check', subagent_type: 'kit:checker' },
      },
    ]),
    reply('checked'),
    reply('done'),
  ]);
  await runtime.initialize();
  runtime.policy.setYolo(runtime.session.id, true);
  // The new version renames it, as an upgrade would
  renameSync(
    join(paths.folder, 'agents', 'reviewer.md'),
    join(paths.folder, 'agents', 'checker.md'),
  );
  writeFileSync(
    join(paths.folder, 'agents', 'checker.md'),
    definition('checker', 'read_file'),
  );
  await runtime.harness.run('use the kit');
  assert.match(resultOf(runtime, 'old'), /unknown subagent type/);
  assert.match(resultOf(runtime, 'new'), /checked/);
});
