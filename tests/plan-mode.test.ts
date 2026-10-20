import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { PLAN_CHOICES, planAnswer } from '../src/plan_file.js';
import { emptyUsage, type Message, type ModelRequest } from '../src/types.js';
import { scratch, cleanup } from './helpers.js';

const reply = (
  id: string,
  content: string,
  calls: Message['tool_calls'] = [],
): Message => ({ id, role: 'assistant', content, tool_calls: calls });
// The model writes the plan file the system prompt names, then asks with plan_exit.
const writePlan = (text: string) => async (request: ModelRequest) => ({
  message: reply('write', '', [
    {
      id: 'plan-write',
      name: 'write_file',
      args: {
        file_path: /`(\/session_plans\/[\w-]+\.md)`/.exec(request.system)![1]!,
        content: text,
      },
    },
  ]),
  usage: emptyUsage(),
});
const exit = {
  message: reply('exit', '', [{ id: 'exit', name: 'plan_exit', args: {} }]),
};

function planning(t: Parameters<typeof scratch>[0], answer: unknown) {
  const home = scratch(t);
  const workspace = scratch(t);
  const asked: Record<string, unknown>[] = [];
  const model = new ScriptedModel([
    writePlan('# Plan\n\n1. change calc\n'),
    exit,
    { message: reply('done', 'ok') },
  ]);
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings: defaultSettings(),
    model,
    headless: true,
    question: async (args) => {
      asked.push(args);
      return JSON.stringify(answer);
    },
  });
  cleanup(t, () => runtime.close());
  runtime.setMode('plan');
  const result = () =>
    String(
      model.requests[2]!.messages.find(
        (message) => message.tool_call_id === 'exit',
      )!.content,
    );
  return { runtime, model, asked, result };
}

test('plan mode tells the model where its plan file is and to call plan_exit, and the plan tools are described', async (t) => {
  const { runtime, model } = planning(t, [[PLAN_CHOICES.keep]]);
  await runtime.harness.run('plan the change');
  const { system, tools } = model.requests[0]!;
  assert.match(system, /Plan mode is on\. Research and design/);
  assert.ok(system.includes('`' + runtime.planFile.file + '`'));
  assert.match(system, /Call `plan_exit`/);
  for (const name of ['plan_enter', 'plan_exit']) {
    const description = tools.find((tool) => tool.name === name)!.description;
    assert.notEqual(description, name);
    assert.doesNotMatch(description, /plan agent|build agent/);
  }
  assert.match(
    tools.find((tool) => tool.name === 'plan_exit')!.description,
    /save the plan only/,
  );
  // Out of plan mode the model is not told to plan
  runtime.setMode('manual');
  assert.doesNotMatch(runtime.harness.system, /Plan mode is on/);
});

test('plan_exit offers the four choices beside the plan, and implementing leaves plan mode for auto or manual approval', async (t) => {
  for (const [choice, mode] of [
    [PLAN_CHOICES.auto, 'auto'],
    [PLAN_CHOICES.manual, 'manual'],
  ] as const) {
    const { runtime, asked, result } = planning(t, [[choice]]);
    await runtime.harness.run('plan the change');
    const [question] = (asked[0]!.questions as Record<string, unknown>[])!;
    assert.deepEqual(
      (question!.options as { label: string }[]).map((option) => option.label),
      [
        'implement in auto mode',
        'implement with manual approval',
        'change the plan',
        'save the plan only',
      ],
    );
    assert.equal(question!.custom, true);
    assert.deepEqual(asked[0]!.plan, { file: runtime.planFile.file });
    assert.match(String(question!.question), /The plan is ready: /);
    assert.equal(runtime.mode, mode);
    assert.equal(runtime.harness.planMode, false);
    assert.match(
      result(),
      new RegExp(`Implement the plan in ${runtime.planFile.file} now`),
    );
  }
});

test('a change request reaches the model in the words written, and saving the plan changes nothing', async (t) => {
  const cases: [unknown, RegExp][] = [
    // The desktop sends the choice and what was written; the terminal, typed words alone
    [
      [[PLAN_CHOICES.change, 'do the migration first']],
      /plan changed before it is implemented\. They said: do the migration first\nRevise \/session_plans\/[\w-]+\.md, then call plan_exit again/,
    ],
    [[['do the migration first']], /They said: do the migration first/],
    [[[PLAN_CHOICES.change]], /did not say how\. Ask what to change/],
    [
      [[PLAN_CHOICES.keep]],
      /keeping the plan in \/session_plans\/[\w-]+\.md and does not want it implemented now\. Plan mode stays on\. Change nothing/,
    ],
    [[''], /closed the question without choosing\. Plan mode stays on/],
    [null, /closed the question without choosing/],
  ];
  for (const [answer, expected] of cases) {
    const { runtime, result } = planning(t, answer);
    await runtime.harness.run('plan the change');
    assert.match(result(), expected);
    assert.equal(runtime.mode, 'plan');
    assert.equal(
      readFileSync(runtime.planFile.path, 'utf8'),
      '# Plan\n\n1. change calc\n',
    );
  }
  assert.deepEqual(planAnswer('not json'), { choice: undefined, words: '' });
});

test('the plan is read again only when it changes, and goes with the conversation it belongs to', async (t) => {
  const { runtime } = planning(t, [[PLAN_CHOICES.keep]]);
  assert.equal(runtime.plan(), undefined);
  await runtime.harness.run('plan the change');
  const first = runtime.plan()!;
  assert.equal(first.file, runtime.planFile.file);
  assert.equal(first.text, '# Plan\n\n1. change calc\n');
  writeFileSync(runtime.planFile.path, '# Plan\n\n1. change calc\n2. test\n');
  assert.equal(runtime.plan()!.text, '# Plan\n\n1. change calc\n2. test\n');
  const { path } = runtime.planFile;
  await runtime.deleteSession();
  assert.equal(existsSync(path), false);
});

test('a fork starts with a copy of the plan its history wrote, and keeps its own from then on', async (t) => {
  const { runtime } = planning(t, [[PLAN_CHOICES.keep]]);
  await runtime.harness.run('plan the change');
  const source = runtime.planFile.path;
  const fork = runtime.store.fork(
    runtime.session.id,
    runtime.options.workspace,
  );
  const home = runtime.options.home;
  const workspace = runtime.options.workspace;
  await runtime.close();
  const forked = new AgentRuntime({
    home,
    workspace,
    session: fork.id,
    settings: defaultSettings(),
    model: new ScriptedModel([]),
    headless: true,
  });
  cleanup(t, () => forked.close());
  assert.notEqual(forked.planFile.path, source);
  assert.equal(forked.plan()!.text, '# Plan\n\n1. change calc\n');
  writeFileSync(forked.planFile.path, '# Forked\n');
  assert.equal(readFileSync(source, 'utf8'), '# Plan\n\n1. change calc\n');
});
