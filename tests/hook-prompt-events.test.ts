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
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message, ModelResponse } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

// The person's words for hooks, and what hooks say to a subagent (#557)
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
function setup(
  t: Parameters<typeof scratch>[0],
  replies: Partial<ModelResponse>[],
) {
  const root = realpathSync(scratch(t));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  // Keeps each input, and answers with what the next request should carry
  const script = join(root, 'scope.mjs');
  const log = join(root, 'seen.jsonl');
  writeFileSync(
    script,
    `import { appendFileSync, readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(${JSON.stringify(log)}, JSON.stringify(input) + '\\n');
const context = input.event === 'user_prompt' ? 'Scope: ' + input.prompt : 'Inherited scope for ' + input.agent_type;
process.stdout.write(JSON.stringify({ context }));
`,
  );
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
  writeFileSync(
    join(home, 'hooks.json'),
    JSON.stringify({
      hooks: {
        user_prompt: [{ name: 'scope', command }],
        subagent_start: [{ name: 'inherit', command }],
      },
    }),
  );
  const model = new ScriptedModel(replies);
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(root, 'user'),
    settings: defaultSettings(),
    model,
  });
  cleanup(t, () => runtime.close());
  const seen = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  return { runtime, model, seen };
}

test("a user_prompt hook gets the person's message as written, and what it says goes to the model with that message", async (t) => {
  const prompt = 'Only touch a.txt — leave b.txt alone.';
  const { runtime, model, seen } = setup(t, [reply('ok')]);
  await runtime.initialize();
  await runtime.harness.run(prompt);
  const [input] = seen();
  assert.equal(input.event, 'user_prompt');
  assert.equal(input.prompt, prompt);
  assert.equal(input.session_id, runtime.session.id);
  // In the request, after the person's message
  const messages = model.requests[0]!.messages;
  const asked = messages.findIndex((message) => message.content === prompt);
  const told = messages.findIndex((message) =>
    String(message.content).includes(
      `Hook user_prompt output, for this message:\nScope: ${prompt}`,
    ),
  );
  assert.ok(asked >= 0 && told > asked, JSON.stringify(messages));
  // On screen, one line of it
  assert.ok(
    runtime.harness.messages.some(
      (message) =>
        message.internal === 'hook_notice' &&
        message.display === `hook scope · Scope: ${prompt}`,
    ),
  );
});

test("a subagent_start hook gets the subagent's identity and task, and what it says is in the subagent's system prompt", async (t) => {
  const { runtime, model, seen } = setup(t, [
    reply('', [
      {
        id: 'task-1',
        name: 'task',
        args: { description: 'edit a.txt', subagent_type: 'general-purpose' },
      },
    ]),
    reply('edited'),
    reply('done'),
  ]);
  await runtime.initialize();
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('Only a.txt');
  const inputs = seen();
  // user_prompt ran for the person's message only, not for the task the model wrote
  assert.deepEqual(
    inputs.map((input) => input.event),
    ['user_prompt', 'subagent_start'],
  );
  const start = inputs[1];
  assert.equal(start.session_id, runtime.session.id);
  assert.equal(start.agent_type, 'general-purpose');
  assert.equal(start.description, 'edit a.txt');
  assert.equal(
    runtime.store.get(start.agent_id)?.parent_id,
    runtime.session.id,
  );
  // The subagent's first request carries it in its system prompt, where a compaction leaves it
  assert.match(
    model.requests[1]!.system,
    /Hook subagent_start output:\nInherited scope for general-purpose/,
  );
  assert.doesNotMatch(model.requests[0]!.system, /Inherited scope/);
});

test('a new session starts with nothing a hook said in the one before', async (t) => {
  const { runtime, model } = setup(t, [reply('one'), reply('two')]);
  await runtime.initialize();
  await runtime.harness.run('Only a.txt');
  await runtime.newSession();
  await runtime.harness.run('hello');
  const second = JSON.stringify(model.requests[1]!.messages);
  assert.match(second, /Scope: hello/);
  assert.doesNotMatch(second, /Scope: Only a\.txt/);
});

test('a turn started with no message of its own, as after a compaction, gives user_prompt hooks nothing', async (t) => {
  const { runtime, seen } = setup(t, [reply('ok')]);
  await runtime.initialize();
  await runtime.harness.run('');
  assert.deepEqual(seen(), []);
});
