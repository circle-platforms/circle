import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message, ModelResponse } from '../src/types.js';
import { cleanup, scratch, until } from './helpers.js';

// The hook events about a conversation rather than a tool call, as the runtime runs them
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
/**
 * A runtime with one hook script for every event given. The script keeps each input in a log and answers with
 * what `answer` (a function body over `input`) returns.
 */
function setup(
  t: Parameters<typeof scratch>[0],
  events: Record<string, string | undefined>,
  answer: string,
  replies: Partial<ModelResponse>[],
  options: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {},
) {
  const root = realpathSync(scratch(t));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  const log = join(root, 'seen.jsonl');
  const count = join(root, 'count');
  const script = join(root, 'hook.mjs');
  writeFileSync(
    script,
    `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(${JSON.stringify(log)}, JSON.stringify(input) + '\\n');
const n = existsSync(${JSON.stringify(count)}) ? Number(readFileSync(${JSON.stringify(count)}, 'utf8')) : 0;
writeFileSync(${JSON.stringify(count)}, String(n + 1));
const said = ((input, n) => { ${answer} })(input, n);
if (said !== undefined) process.stdout.write(typeof said === 'string' ? said : JSON.stringify(said));
`,
  );
  const hooks = Object.fromEntries(
    Object.entries(events).map(([event, matcher]) => [
      event,
      [
        {
          ...(matcher ? { matcher } : {}),
          hooks: [
            {
              type: 'command',
              command: process.execPath,
              args: [script],
              name: 'probe',
            },
          ],
        },
      ],
    ]),
  );
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ hooks }));
  const model = new ScriptedModel(replies);
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(root, 'user'),
    settings: defaultSettings(),
    model,
    ...options,
  });
  cleanup(t, () => runtime.close());
  const seen = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  return { root, home, workspace, model, runtime, seen };
}
const text = (message: Message) => String(message.content);

test('UserPromptSubmit gives its words to the model after the message, and a block keeps the message from the model', async (t) => {
  const { model, runtime, seen } = setup(
    t,
    { UserPromptSubmit: undefined },
    `if (input.prompt.includes('secret')) return { decision: 'block', reason: 'not that', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: input.prompt.includes('quiet') } };
return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Scope: ' + input.prompt } };`,
    [reply('fixed'), reply('fine')],
  );
  await runtime.harness.run('fix a.txt');
  const first = model.requests[0]!.messages.map(text);
  const asked = first.indexOf('fix a.txt');
  assert.ok(asked >= 0);
  assert.match(
    first[asked + 1]!,
    /UserPromptSubmit hook additional context:\nScope: fix a\.txt/,
  );
  assert.equal(seen()[0]!.prompt, 'fix a.txt');
  assert.equal(seen()[0]!.hook_event_name, 'UserPromptSubmit');
  // Blocked: the model is not asked, and the person reads why with what they wrote
  await runtime.harness.run('show the secret');
  await runtime.harness.run('quiet secret');
  assert.equal(model.requests.length, 1);
  const notices = runtime.harness.messages
    .filter((message) => message.hook?.kind === 'blocked')
    .map((message) => message.display);
  assert.deepEqual(notices, [
    'hook blocked prompt · not that\nOriginal prompt: show the secret',
    'hook blocked prompt · not that',
  ]);
  await runtime.harness.run('carry on');
  const later = model.requests[1]!.messages.map(text).join('\n');
  assert.doesNotMatch(later, /show the secret|not that/);
  assert.match(later, /carry on/);
});

test('Stop hooks send the turn back to work a few times in a row at most, and continue: false lets it end', async (t) => {
  const previous = process.env.CIRCLE_STOP_HOOK_BLOCK_CAP;
  process.env.CIRCLE_STOP_HOOK_BLOCK_CAP = '2';
  t.after(() => {
    if (previous === undefined) delete process.env.CIRCLE_STOP_HOOK_BLOCK_CAP;
    else process.env.CIRCLE_STOP_HOOK_BLOCK_CAP = previous;
  });
  const { model, runtime, seen } = setup(
    t,
    { Stop: undefined },
    `if (input.last_assistant_message === 'stop now') return { continue: false, stopReason: 'all done' };
return { decision: 'block', reason: 'run the tests first' };`,
    [reply('done 1'), reply('done 2'), reply('done 3'), reply('stop now')],
  );
  await runtime.harness.run('go');
  // The first answer and two continuations, then the cap lets the turn end
  assert.equal(model.requests.length, 3);
  assert.match(
    model.requests[1]!.messages.map(text).join('\n'),
    /A hook blocked the end of this turn: run the tests first/,
  );
  assert.deepEqual(
    seen().map((input) => [
      input.stop_hook_active,
      input.last_assistant_message,
    ]),
    [
      [false, 'done 1'],
      [true, 'done 2'],
      [true, 'done 3'],
    ],
  );
  assert.ok(
    runtime.harness.messages.some((message) => message.hook?.kind === 'limit'),
  );
  // `continue: false` comes before any block
  await runtime.harness.run('again');
  assert.equal(model.requests.length, 4);
  assert.ok(
    runtime.harness.messages.some(
      (message) =>
        message.hook?.kind === 'stopped' && message.hook.reason === 'all done',
    ),
  );
});

test("SessionStart's words open the conversation before the first prompt, not in the system prompt, and return after a compaction", async (t) => {
  const { model, runtime, seen } = setup(
    t,
    { SessionStart: undefined, PreCompact: undefined, PostCompact: undefined },
    `if (input.hook_event_name === 'PreCompact') return 'Keep the list of changed files.';
if (input.hook_event_name === 'PostCompact') return undefined;
return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Branch: main (' + input.source + ')' } };`,
    [reply('hello back'), reply('the summary')],
  );
  await runtime.harness.run('hello');
  const request = model.requests[0]!;
  assert.doesNotMatch(request.system, /Branch: main/);
  const messages = request.messages.map(text);
  const opening = messages.findIndex((message) =>
    /Branch: main \(startup\)/.test(message),
  );
  assert.ok(opening >= 0 && opening < messages.indexOf('hello'));
  // A compaction: PreCompact adds to what the summary keeps, PostCompact hears the summary, SessionStart runs again
  for (let index = 0; index < 8; index++)
    runtime.store.append(runtime.session.id, [
      {
        id: 'old-' + index,
        role: index % 2 ? 'assistant' : 'user',
        content: 'history ' + index,
      },
    ]);
  await runtime.compact('', new AbortController().signal);
  assert.match(
    model.requests[1]!.messages.map(text).join('\n') +
      model.requests[1]!.system,
    /Keep the list of changed files\./,
  );
  const events = seen().map((input) => [
    input.hook_event_name,
    input.source ?? input.trigger,
  ]);
  assert.deepEqual(events, [
    ['SessionStart', 'startup'],
    ['PreCompact', 'auto'],
    ['PostCompact', 'auto'],
    ['SessionStart', 'compact'],
  ]);
  assert.equal(seen()[2]!.compact_summary, 'the summary');
  assert.ok(
    runtime.harness.messages.some((message) =>
      /Branch: main \(compact\)/.test(text(message)),
    ),
  );
});

test('a PreCompact block keeps the conversation as it is', async (t) => {
  const { model, runtime } = setup(
    t,
    { PreCompact: 'manual' },
    `process.stderr.write('not now'); process.exit(2);`,
    [reply('unused')],
  );
  for (let index = 0; index < 8; index++)
    runtime.store.append(runtime.session.id, [
      {
        id: 'old-' + index,
        role: index % 2 ? 'assistant' : 'user',
        content: 'history ' + index,
      },
    ]);
  // A model's compaction is `auto`: this hook is for a person's
  assert.match(await runtime.compact('', new AbortController().signal), /./);
  const asked = model.requests.length;
  const compacted = runtime.store.contextState(runtime.session.id).summary;
  assert.ok(compacted);
  for (let index = 8; index < 16; index++)
    runtime.store.append(runtime.session.id, [
      {
        id: 'old-' + index,
        role: index % 2 ? 'assistant' : 'user',
        content: 'history ' + index,
      },
    ]);
  assert.equal(
    await runtime.compact('keep it short'),
    'Compaction blocked by a hook: not now',
  );
  assert.equal(model.requests.length, asked);
  assert.equal(
    runtime.store.contextState(runtime.session.id).summary?.cutoffMessageId,
    compacted.cutoffMessageId,
  );
});

test("SubagentStart's words open the subagent's conversation, and SubagentStop can send it back to work", async (t) => {
  const { model, runtime, seen } = setup(
    t,
    { SubagentStart: 'general-purpose', SubagentStop: undefined },
    `if (input.hook_event_name === 'SubagentStart') return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: 'Inherited scope: only a.txt' } };
if (!input.stop_hook_active) return { decision: 'block', reason: 'check your work' };`,
    [
      reply('', [
        {
          id: 'job',
          name: 'task',
          args: {
            description: 'look at a.txt',
            subagent_type: 'general-purpose',
          },
        },
      ]),
      reply('child answer 1'),
      reply('child answer 2'),
      reply('done'),
    ],
  );
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('delegate');
  // The subagent's first request opens with the hook's words, before its task
  const child = model.requests[1]!.messages.map(text);
  const scope = child.findIndex((message) =>
    /Inherited scope: only a\.txt/.test(message),
  );
  assert.ok(scope >= 0 && scope < child.indexOf('look at a.txt'));
  // SubagentStop sent it back once, with its reason as the next instruction
  assert.match(
    model.requests[2]!.messages.map(text).join('\n'),
    /check your work/,
  );
  const result = model.requests[3]!.messages.find(
    (message) => message.tool_call_id === 'job',
  );
  assert.match(String(result?.content), /child answer 2/);
  const events = seen().map((input) => [
    input.hook_event_name,
    input.agent_type,
    input.stop_hook_active,
  ]);
  assert.deepEqual(events, [
    ['SubagentStart', 'general-purpose', undefined],
    ['SubagentStop', 'general-purpose', false],
    ['SubagentStop', 'general-purpose', true],
  ]);
  assert.equal(seen()[1]!.last_assistant_message, 'child answer 1');
});

test('SessionEnd hooks hear why a conversation ends, and the next one starts as cleared', async (t) => {
  const { runtime, seen } = setup(
    t,
    { SessionStart: undefined, SessionEnd: undefined },
    `return undefined;`,
    [reply('one'), reply('two')],
  );
  await runtime.harness.run('first');
  const first = runtime.session.id;
  await runtime.newSession();
  await runtime.harness.run('second');
  await runtime.close();
  assert.deepEqual(
    seen().map((input) => [
      input.hook_event_name,
      input.source ?? input.reason,
      input.session_id === first,
    ]),
    [
      ['SessionStart', 'startup', true],
      ['SessionEnd', 'clear', true],
      ['SessionStart', 'clear', false],
      ['SessionEnd', 'other', false],
    ],
  );
});

test('Notification hooks hear of an approval card that waits and of a finished turn nobody answers', async (t) => {
  let release = () => {};
  const waiting = new Promise<void>((resolve) => (release = resolve));
  const { runtime, seen } = setup(
    t,
    { Notification: undefined },
    `return undefined;`,
    [
      reply('', [{ id: 'x', name: 'execute', args: { command: 'echo hi' } }]),
      reply('done'),
    ],
    {
      notificationDelays: { permission: 20, idle: 20 },
      approve: async () => {
        await waiting;
        return 'approve';
      },
    },
  );
  const turn = runtime.harness.run('go');
  await until(
    () =>
      seen().some((input) => input.notification_type === 'permission_prompt'),
    {
      label: 'a permission_prompt notification',
    },
  );
  release();
  await turn;
  await until(
    () => seen().some((input) => input.notification_type === 'idle_prompt'),
    {
      label: 'an idle_prompt notification',
    },
  );
  const permission = seen().find(
    (input) => input.notification_type === 'permission_prompt',
  )!;
  assert.equal(
    permission.message,
    'Circle needs your permission to use execute',
  );
  assert.equal(permission.hook_event_name, 'Notification');
});

test('hooks files of the format before this one move into settings once and keep doing what they did', async (t) => {
  const root = realpathSync(scratch(t));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const userHome = join(root, 'user');
  mkdirSync(home);
  mkdirSync(workspace);
  const deny = join(root, 'deny.mjs');
  writeFileSync(
    deny,
    `process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'old deny' }));`,
  );
  const crash = join(root, 'crash.mjs');
  writeFileSync(crash, `process.exit(1);`);
  const command = (file: string) =>
    `${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`;
  writeFileSync(
    join(home, 'hooks.json'),
    JSON.stringify({
      version: 1,
      hooks: {
        before_tool: [
          {
            name: 'no writes',
            command: command(deny),
            tools: 'write_file',
            timeout_ms: 5000,
          },
          // It failed closed before: it still does
          { name: 'crashes', command: command(crash), tools: ['execute'] },
          {
            name: 'guard',
            command: command(deny),
            paths: ['secret/**'],
            loop_limit: 3,
          },
        ],
      },
    }),
  );
  mkdirSync(join(workspace, '.circle'), { recursive: true });
  writeFileSync(
    join(workspace, '.circle', 'hooks.json'),
    JSON.stringify({ hooks: { session_start: [{ command: command(crash) }] } }),
  );
  const skill = join(home, 'skills', 'demo');
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, 'SKILL.md'),
    '---\nname: demo\ndescription: Demo\n---\nDemo.\n',
  );
  writeFileSync(
    join(skill, 'hooks.json'),
    JSON.stringify({
      hooks: { after_tool: [{ name: 'log', command: command(crash) }] },
    }),
  );
  const pack = join(userHome, '.agents', 'skills', 'kit');
  mkdirSync(pack, { recursive: true });
  writeFileSync(join(pack, 'pack.json'), '{}');
  writeFileSync(
    join(pack, 'SKILL.md'),
    '---\nname: kit\ndescription: Kit\n---\nKit.\n',
  );
  writeFileSync(join(pack, 'hooks.json'), '{"hooks":{}}');
  const model = new ScriptedModel([
    reply('', [
      {
        id: 'w',
        name: 'write_file',
        args: { file_path: 'a.txt', content: 'x' },
      },
      { id: 'x', name: 'execute', args: { command: 'echo hi' } },
    ]),
    reply('done'),
  ]);
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome,
    settings: trustFolder(defaultSettings(), workspace),
    model,
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('go');
  const result = (id: string) =>
    String(
      model.requests[1]!.messages.find((message) => message.tool_call_id === id)
        ?.content,
    );
  assert.match(result('w'), /Hook denied this call: old deny/);
  assert.match(
    result('x'),
    /Hook denied this call: hook crashes failed; blocking because onFailure is "block"/,
  );
  const settings = JSON.parse(
    readFileSync(join(home, 'settings.json'), 'utf8'),
  );
  assert.deepEqual(
    settings.hooks.PreToolUse.map(
      (group: { matcher?: string }) => group.matcher,
    ),
    ['write_file', 'execute', undefined],
  );
  const guard = settings.hooks.PreToolUse[2].hooks;
  assert.ok(
    guard.some((hook: { if?: string }) => hook.if === 'write_file(secret/**)'),
  );
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].timeout, 5);
  assert.equal(settings.hooks.PreToolUse[1].hooks[0].onFailure, 'block');
  assert.equal(existsSync(join(home, 'hooks.json')), false);
  assert.equal(existsSync(join(home, 'hooks.json.migrated')), true);
  const project = JSON.parse(
    readFileSync(join(workspace, '.circle', 'settings.json'), 'utf8'),
  );
  assert.ok(Array.isArray(project.hooks.SessionStart));
  assert.match(
    readFileSync(join(skill, 'SKILL.md'), 'utf8'),
    /^---\nname: demo\ndescription: Demo\nhooks:\n  PostToolUse:/,
  );
  assert.equal(existsSync(join(skill, 'hooks.json.migrated')), true);
  // An installed pack is the pack's to change: left as it is, and named
  assert.equal(existsSync(join(pack, 'hooks.json')), true);
  const notes = runtime.harness.messages
    .map((message) => message.display ?? '')
    .join('\n');
  assert.match(
    notes,
    /your hooks\.json: moved into .*settings\.json under hooks/,
  );
  assert.match(notes, /the paths of guard now apply to Circle's file tools/);
  assert.match(notes, /pack kit has hooks in the old format/);
  // Each moved hook keeps what it was written for until it is rewritten
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].legacy, true);
  // Once: nothing is left to move the next time
  assert.equal(
    existsSync(join(dirname(join(home, 'hooks.json')), 'hooks.json')),
    false,
  );
});
