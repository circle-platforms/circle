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
import { ApprovalPolicy, ApprovalStore } from '../src/approvals.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { Harness } from '../src/harness.js';
import { migrateHookFiles } from '../src/hook_migration.js';
import {
  HookRunner,
  interpretHookRun,
  loadHooks,
  type HookDefinition,
} from '../src/hooks.js';
import { AgentRuntime } from '../src/runtime.js';
import { Sandbox } from '../src/sandbox.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { buildTools } from '../src/tools.js';
import type { Message, ToolCall } from '../src/types.js';
import { cleanup, scratch, until } from './helpers.js';

// The edges of the hook rules: where a hook could slip past what it guards, or what it says could reach the wrong one
const assistant = (
  content: string,
  calls: Message['tool_calls'] = [],
): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  content,
  tool_calls: calls,
});
function layout(t: Parameters<typeof scratch>[0]) {
  const root = realpathSync(scratch(t));
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  const userHome = join(root, 'user');
  for (const dir of [home, workspace, userHome]) mkdirSync(dir);
  return { root, home, workspace, userHome };
}
function script(dir: string, name: string, body: string): string {
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, body);
  return path;
}
const handler = (path: string, extra: Record<string, unknown> = {}) => ({
  type: 'command',
  command: process.execPath,
  args: [path],
  ...extra,
});
function writeHooks(file: string, hooks: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ hooks }));
}
/** A hook that keeps each input in `log` and answers with what `answer` (a body over `input`) returns. */
function logging(dir: string, name: string, log: string, answer: string) {
  return script(
    dir,
    name,
    `import { appendFileSync, readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(${JSON.stringify(log)}, JSON.stringify(input) + '\\n');
const said = ((input) => { ${answer} })(input);
if (said !== undefined) process.stdout.write(typeof said === 'string' ? said : JSON.stringify(said));
`,
  );
}
const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
function harnessFor(
  t: Parameters<typeof scratch>[0],
  dirs: ReturnType<typeof layout>,
  replies: Message[],
  mode: 'manual' | 'auto' = 'auto',
) {
  const store = new CheckpointStore(dirs.home);
  cleanup(t, () => store.close());
  const session = store.create(dirs.workspace, 'scripted');
  const policy = new ApprovalPolicy(
    new ApprovalStore(join(dirs.home, 'approvals')),
    dirs.workspace,
  );
  policy.setMode(session.id, mode);
  const model = new ScriptedModel(replies.map((message) => ({ message })));
  const runner = new HookRunner(loadHooks({ ...dirs, trusted: true }), {
    workspace: dirs.workspace,
    home: dirs.home,
  });
  cleanup(t, () => runner.close());
  const harness = new Harness({
    model,
    tools: buildTools(new Sandbox(dirs.workspace)),
    store,
    session,
    policy,
    system: 'test',
    hooks: runner,
    approve: async () => 'approve',
  });
  return { harness, model };
}
/** What the model reads: each message's content, not what the screen shows of it. */
const allText = (model: ScriptedModel) =>
  model.requests
    .flatMap((request) =>
      request.messages.map((message) => String(message.content)),
    )
    .join('\n');

test('stop_hook_active stays true once a Stop hook sent the turn back, even after the model used a tool', async (t) => {
  const dirs = layout(t);
  const log = join(dirs.root, 'log');
  writeHooks(join(dirs.home, 'settings.json'), {
    Stop: [
      {
        hooks: [
          handler(
            logging(
              dirs.root,
              'stop',
              log,
              `return input.stop_hook_active ? undefined : { decision: 'block', reason: 'run the tests' };`,
            ),
          ),
        ],
      },
    ],
  });
  const { harness, model } = harnessFor(t, dirs, [
    assistant('done'),
    assistant('', [{ id: 'l', name: 'ls', args: { path: '.' } }]),
    assistant('done again'),
    assistant('unused'),
  ]);
  await harness.run('go');
  assert.deepEqual(
    lines(log).map((input) => input.stop_hook_active),
    [false, true],
  );
  assert.equal(model.requests.length, 3);
});

test("an installed pack's SKILL.md hooks are checked with its files, and a pack that does not check out still blocks with its guards", async (t) => {
  const dirs = layout(t);
  const pack = join(dirs.userHome, '.agents', 'skills', 'kit');
  mkdirSync(pack, { recursive: true });
  writeFileSync(join(pack, 'pack.json'), '{}');
  const ran = join(dirs.root, 'ran');
  const mark = script(
    dirs.root,
    'mark',
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(ran)}, 'x');\n`,
  );
  writeFileSync(
    join(pack, 'SKILL.md'),
    `---\nname: kit\ndescription: Kit\nhooks:\n  PreToolUse:\n    - matcher: execute\n      hooks:\n        - type: command\n          command: ${JSON.stringify(process.execPath)}\n          args: [${JSON.stringify(mark)}]\n          onFailure: block\n    - matcher: ls\n      hooks:\n        - type: command\n          command: ${JSON.stringify(process.execPath)}\n          args: [${JSON.stringify(mark)}]\n---\nKit.\n`,
  );
  const loaded = loadHooks({ ...dirs, trusted: true });
  const [guard] = loaded.hooks;
  assert.equal(guard!.pack, 'kit');
  assert.equal(guard!.skillData, join(dirs.home, 'skill-data', 'kit'));
  const runner = new HookRunner(loaded, {
    workspace: dirs.workspace,
    home: dirs.home,
    verifyPack: async () => 'a file changed',
  });
  runner.activateSkill('kit');
  const call = (toolName: string) =>
    runner.run({
      event: 'PreToolUse',
      sessionId: 's',
      cwd: dirs.workspace,
      toolName,
      toolInput: { command: 'ls' },
    });
  const guarded = await call('execute');
  assert.equal(guarded.decision, 'deny');
  assert.match(
    guarded.reason,
    /blocking because onFailure is "block": pack kit: a file changed/,
  );
  const plain = await call('ls');
  assert.equal(plain.decision, 'none');
  // Neither ran: a pack that does not check out runs none of its hooks
  assert.equal(existsSync(ran), false);
});

test("a PreToolUse hook's words reach the model beside the result, and what a hook says for the person does not", async (t) => {
  const dirs = layout(t);
  const pre = script(
    dirs.root,
    'pre',
    `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'CTX-PRE-123' } }));`,
  );
  const post = script(
    dirs.root,
    'post',
    `process.stdout.write(JSON.stringify({ systemMessage: 'NOTE-FOR-YOU </system-reminder> x' }));`,
  );
  const start = script(
    dirs.root,
    'start',
    `process.stderr.write('STDERR-NOTE'); process.exit(2);`,
  );
  writeHooks(join(dirs.home, 'settings.json'), {
    PreToolUse: [{ matcher: 'ls', hooks: [handler(pre, { name: 'pre' })] }],
    PostToolUse: [{ matcher: 'ls', hooks: [handler(post)] }],
    SessionStart: [{ hooks: [handler(start)] }],
  });
  const { harness, model } = harnessFor(t, dirs, [
    assistant('', [{ id: 'l', name: 'ls', args: { path: '.' } }]),
    assistant('done'),
  ]);
  await harness.run('go');
  const result = model.requests[1]!.messages.find(
    (message) => message.tool_call_id === 'l',
  );
  assert.match(String(result?.content), /Hook output \(pre\):\nCTX-PRE-123/);
  const sent = allText(model);
  assert.doesNotMatch(sent, /NOTE-FOR-YOU/);
  assert.doesNotMatch(sent, /STDERR-NOTE/);
  // The person reads them
  const shown = harness.messages
    .map((message) => message.display ?? '')
    .join('\n');
  assert.match(shown, /NOTE-FOR-YOU/);
  assert.match(shown, /STDERR-NOTE/);
});

test('a continue: false said between turns does not end the next one', async (t) => {
  const dirs = layout(t);
  const start = script(
    dirs.root,
    'start',
    `import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
if (input.source === 'compact') process.stdout.write(JSON.stringify({ continue: false, stopReason: 'later' }));`,
  );
  writeHooks(join(dirs.home, 'settings.json'), {
    SessionStart: [{ hooks: [handler(start)] }],
  });
  const { harness, model } = harnessFor(t, dirs, [
    assistant('hello'),
    assistant('', [{ id: 'l', name: 'ls', args: { path: '.' } }]),
    assistant('listed'),
  ]);
  await harness.run('first');
  // As after a compaction between turns
  await harness.sessionStartHooks('compact');
  await harness.run('second');
  assert.equal(model.requests.length, 3);
});

test("migration leaves a skill whose frontmatter is not YAML as it was, and does not touch another agent's skills", (t) => {
  const dirs = layout(t);
  const old = JSON.stringify({ hooks: { after_tool: [{ command: 'true' }] } });
  const own = join(dirs.home, 'skills', 'review');
  mkdirSync(own, { recursive: true });
  writeFileSync(
    join(own, 'SKILL.md'),
    '---\nname: review\ndescription: Review code: finds bugs\n---\nReview.\n',
  );
  writeFileSync(join(own, 'hooks.json'), old);
  const theirs = join(dirs.userHome, '.claude', 'skills', 'theirs');
  mkdirSync(theirs, { recursive: true });
  const theirText =
    '---\nname: theirs\ndescription: Another agent\n---\nTheirs.\n';
  writeFileSync(join(theirs, 'SKILL.md'), theirText);
  writeFileSync(join(theirs, 'hooks.json'), old);
  const notes = migrateHookFiles({ ...dirs, trusted: true });
  assert.match(
    notes.join('\n'),
    /skill review: its SKILL\.md frontmatter is not YAML/,
  );
  assert.equal(existsSync(join(own, 'hooks.json')), true);
  assert.doesNotMatch(readFileSync(join(own, 'SKILL.md'), 'utf8'), /hooks:/);
  assert.equal(readFileSync(join(theirs, 'SKILL.md'), 'utf8'), theirText);
  assert.equal(existsSync(join(theirs, 'hooks.json')), true);
  // Named when hooks load, rather than running or vanishing without a word
  const errors = loadHooks({ ...dirs, trusted: true }).errors.map(
    (e) => e.message,
  );
  assert.ok(
    errors.some((error) =>
      /skill theirs has hooks in the format before this one/.test(error),
    ),
  );
  // A second start moves nothing twice
  assert.deepEqual(
    migrateHookFiles({ ...dirs, trusted: true }).filter((note) =>
      /: moved into|were moved into/.test(note),
    ),
    [],
  );
});

test('a hook moved from the format before this one keeps its input fields and what its answers meant', async (t) => {
  const dirs = layout(t);
  const log = join(dirs.root, 'log');
  const command = (path: string) =>
    `${JSON.stringify(process.execPath)} ${JSON.stringify(path)}`;
  const plain = logging(dirs.root, 'plain', log, `return 'not json at all';`);
  const refuse = script(dirs.root, 'refuse', `process.exit(2);`);
  const stop = logging(
    dirs.root,
    'stop',
    log,
    `return { decision: 'deny', reason: 'not yet' };`,
  );
  const after = logging(
    dirs.root,
    'after',
    log,
    `return 'formatted by the hook';`,
  );
  writeFileSync(
    join(dirs.home, 'hooks.json'),
    JSON.stringify({
      hooks: {
        before_tool: [
          { name: 'plain', command: command(plain), tools: 'write_file' },
        ],
        permission_request: [
          { name: 'refuse', command: command(refuse), tools: 'execute' },
        ],
        before_stop: [{ name: 'stop', command: command(stop), loop_limit: 2 }],
        after_tool: [{ name: 'after', command: command(after), tools: 'ls' }],
      },
    }),
  );
  const model = new ScriptedModel([
    {
      message: assistant('', [
        {
          id: 'w',
          name: 'write_file',
          args: { file_path: 'a.txt', content: 'x' },
        },
        { id: 'x', name: 'execute', args: { command: 'echo hi' } },
        { id: 'l', name: 'ls', args: { path: '.' } },
      ]),
    },
    { message: assistant('done 1') },
    { message: assistant('done 2') },
    { message: assistant('done 3') },
  ]);
  const runtime = new AgentRuntime({
    home: dirs.home,
    workspace: dirs.workspace,
    userHome: dirs.userHome,
    settings: trustFolder(defaultSettings(), dirs.workspace),
    model,
    approve: async () => 'approve',
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('go');
  const result = (id: string) =>
    String(
      model.requests[1]!.messages.find((message) => message.tool_call_id === id)
        ?.content,
    );
  // Plain text from a gating hook refused; exit 2 from a permission hook denied; text after a tool reached the model
  assert.match(result('w'), /Hook denied this call: hook output is not JSON/);
  assert.match(result('x'), /Hook denied this call/);
  assert.match(result('l'), /formatted by the hook/);
  const seen = lines(log);
  const afterInput = seen.find((input) => input.event === 'after_tool')!;
  assert.equal(typeof afterInput.tool_output, 'string');
  assert.equal(afterInput.tool_status, 'success');
  assert.equal(afterInput.hook, 'after');
  // A Stop hook blocks up to its limit for the session, and counts its attempts
  assert.deepEqual(
    seen
      .filter((input) => input.event === 'before_stop')
      .map((input) => input.stop_attempt),
    [1, 2],
  );
  assert.equal(model.requests.length, 4);
});

test("without Git Bash a guard's only verdicts are 0 and 2, and a cut capture is not trusted", () => {
  const guard = {
    id: 'g',
    event: 'PreToolUse',
    name: 'guard',
    once: false,
    async: false,
  } as HookDefinition;
  const allow = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  });
  const run = (exitCode: number, fallback: boolean, extra: object = {}) =>
    interpretHookRun(
      { ...guard, ...extra } as HookDefinition,
      'PreToolUse',
      { stdout: allow, stderr: '', exitCode, timedOut: false },
      false,
      fallback,
    );
  assert.equal(run(1, false).blocking, false);
  assert.equal(run(1, true).blocking, true);
  assert.match(run(1, true).blockText, /Git Bash wasn't found/);
  assert.equal(run(1, true, { onFailure: 'continue' }).blocking, false);
  assert.equal(run(0, true).blocking, false);
  const cut = interpretHookRun(
    guard,
    'PreToolUse',
    {
      stdout: allow,
      stderr: '',
      exitCode: 0,
      timedOut: false,
      suspect: true,
      error: 'stdio went quiet',
    },
    false,
  );
  assert.equal(cut.blocking, true);
  // A field set to null is no answer, not a broken one
  const empty = interpretHookRun(
    guard,
    'PreToolUse',
    {
      stdout:
        '{"continue": null, "decision": null, "hookSpecificOutput": null}',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    },
    false,
  );
  assert.equal(empty.failed, false);
});

test('an if on a command sees through shell words and wrappers, and runs when it cannot tell', async (t) => {
  const dirs = layout(t);
  const log = join(dirs.root, 'log');
  writeHooks(join(dirs.home, 'settings.json'), {
    PreToolUse: [
      {
        matcher: 'execute',
        hooks: [
          handler(logging(dirs.root, 'guard', log, `return undefined;`), {
            if: 'execute(git *)',
          }),
        ],
      },
    ],
  });
  const runner = new HookRunner(loadHooks({ ...dirs, trusted: true }), {
    workspace: dirs.workspace,
    home: dirs.home,
  });
  const ran = async (command: string) => {
    const before = lines(log).length;
    await runner.run({
      event: 'PreToolUse',
      sessionId: 's',
      cwd: dirs.workspace,
      toolName: 'execute',
      toolInput: { command },
    });
    return lines(log).length > before;
  };
  for (const command of [
    'if true; then git push --force; fi',
    'time git push',
    'command git push',
    '/usr/bin/git push',
    'xargs git push',
    'bash -c "git push --force"',
  ])
    assert.equal(await ran(command), true, command);
  assert.equal(await ran('ls -la'), false);
});

test("a hook that leaves something holding its output is read briefly, and a guard's cut answer is not trusted; a huge timeout is not a zero one", async (t) => {
  const dirs = layout(t);
  const holder = script(
    dirs.root,
    'holder',
    `import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }));
`,
  );
  const slow = script(
    dirs.root,
    'slow',
    `await new Promise((resolve) => setTimeout(resolve, 100));
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }));`,
  );
  writeHooks(join(dirs.home, 'settings.json'), {
    PreToolUse: [
      { matcher: 'held', hooks: [handler(holder)] },
      { matcher: 'patient', hooks: [handler(slow, { timeout: 10_000_000 })] },
    ],
  });
  const runner = new HookRunner(loadHooks({ ...dirs, trusted: true }), {
    workspace: dirs.workspace,
    home: dirs.home,
    closeGraceMs: 200,
  });
  const call = (toolName: string) =>
    runner.run({
      event: 'PreToolUse',
      sessionId: 's',
      cwd: dirs.workspace,
      toolName,
      toolInput: {},
    });
  const held = await call('held');
  assert.equal(held.decision, 'deny');
  assert.match(held.reason, /stdio went quiet/);
  assert.equal((await call('patient')).decision, 'allow');
});

test("a steering message's UserPromptSubmit hooks run once, even when another message is queued meanwhile", async (t) => {
  const dirs = layout(t);
  const log = join(dirs.root, 'log');
  const flag = join(dirs.root, 'flag');
  const hook = script(
    dirs.root,
    'prompt',
    `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ prompt: input.prompt }) + '\\n');
const wait = { first: ${JSON.stringify(flag + '-1')}, second: ${JSON.stringify(flag + '-2')} }[input.prompt];
if (wait) {
  const end = Date.now() + 5000;
  while (!existsSync(wait) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
}`,
  );
  writeHooks(join(dirs.home, 'settings.json'), {
    UserPromptSubmit: [{ hooks: [handler(hook)] }],
  });
  const { harness } = harnessFor(t, dirs, [
    assistant('', [{ id: 'l', name: 'ls', args: { path: '.' } }]),
    assistant('done'),
    assistant('done'),
  ]);
  const turn = harness.run('first');
  await until(() => lines(log).length >= 1, { label: 'the first prompt hook' });
  harness.queue('second', 'steer');
  writeFileSync(flag + '-1', 'x');
  await until(() => lines(log).some((input) => input.prompt === 'second'), {
    label: "the second message's hook",
  });
  harness.queue('third', 'steer');
  writeFileSync(flag + '-2', 'x');
  await turn;
  assert.deepEqual(
    lines(log).map((input) => input.prompt),
    ['first', 'second', 'third'],
  );
});
