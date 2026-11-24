import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { ApprovalPolicy, ApprovalStore } from '../src/approvals.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { Harness } from '../src/harness.js';
import { compileMatcher, matcherMatches } from '../src/hook_config.js';
import {
  HookRunner,
  hookLaunch,
  loadHooks,
  matchHookPath,
  parseCondition,
} from '../src/hooks.js';
import { canonicalPath } from '../src/paths.js';
import { Sandbox } from '../src/sandbox.js';
import { ScriptedModel } from '../src/testing.js';
import { buildTools } from '../src/tools.js';
import type { Message, ToolCall } from '../src/types.js';
import { cleanup, scratch, until } from './helpers.js';

const assistant = (
  content: string,
  calls: Message['tool_calls'] = [],
): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  content,
  tool_calls: calls,
});

function layout(t: { after(fn: () => void | Promise<void>): void }) {
  const root = realpathSync(scratch(t));
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  const userHome = join(root, 'user');
  mkdirSync(home);
  mkdirSync(workspace);
  mkdirSync(userHome);
  return { root, home, workspace, userHome };
}

/** A hook script. Node runs it in exec form, the same on every system. */
function script(dir: string, name: string, body: string): string {
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, body);
  return path;
}
function handler(path: string, extra: Record<string, unknown> = {}) {
  return { type: 'command', command: process.execPath, args: [path], ...extra };
}
/** A script that keeps what it was given in `seen`, then prints `answer` and exits with `exit`. */
function answering(
  dir: string,
  name: string,
  answer: unknown,
  options: {
    seen?: string;
    exit?: number;
    stderr?: string;
    wait?: number;
  } = {},
): string {
  const text =
    answer === undefined
      ? ''
      : typeof answer === 'string'
        ? answer
        : JSON.stringify(answer);
  return script(
    dir,
    name,
    `import { appendFileSync, readFileSync } from 'node:fs';
const input = readFileSync(0, 'utf8');
${options.seen ? `appendFileSync(${JSON.stringify(options.seen)}, input.trim() + '\\n');` : ''}
${options.wait ? `await new Promise((resolve) => setTimeout(resolve, ${options.wait}));` : ''}
${options.stderr ? `process.stderr.write(${JSON.stringify(options.stderr)});` : ''}
process.stdout.write(${JSON.stringify(text)});
process.exitCode = ${options.exit ?? 0};
`,
  );
}
function seenInputs(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
/** Writes `hooks` into a settings file. */
function writeHooks(
  file: string,
  hooks: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...extra, hooks }, null, 2));
}
const group = (matcher: string | undefined, ...hooks: unknown[]) => ({
  ...(matcher === undefined ? {} : { matcher }),
  hooks,
});
function runnerFor(dirs: ReturnType<typeof layout>, trusted = true) {
  return new HookRunner(
    loadHooks({
      workspace: dirs.workspace,
      home: dirs.home,
      trusted,
      userHome: dirs.userHome,
    }),
    { workspace: dirs.workspace, home: dirs.home },
  );
}

async function turn(options: {
  t: { after(fn: () => void | Promise<void>): void };
  home: string;
  workspace: string;
  userHome: string;
  mode?: 'manual' | 'auto' | 'accept-edits';
  headless?: boolean;
  noApprove?: boolean;
  secrets?: Record<string, string>;
  replies: Message[];
  approve?: (call: ToolCall) => 'approve' | 'reject';
  prompt?: string;
}) {
  const store = new CheckpointStore(options.home);
  cleanup(options.t, () => store.close());
  const session = store.create(options.workspace, 'scripted');
  const policy = new ApprovalPolicy(
    new ApprovalStore(join(options.home, 'approvals')),
    options.workspace,
  );
  if (options.mode) policy.setMode(session.id, options.mode);
  const model = new ScriptedModel(
    options.replies.map((message) => ({ message })),
  );
  const asked: ToolCall[] = [];
  const harness = new Harness({
    model,
    tools: buildTools(new Sandbox(options.workspace)),
    store,
    session,
    policy,
    system: 'test',
    ...(options.headless ? { headless: true } : {}),
    ...(options.secrets ? { secrets: () => options.secrets ?? {} } : {}),
    hooks: new HookRunner(
      loadHooks({
        workspace: options.workspace,
        home: options.home,
        trusted: true,
        userHome: options.userHome,
      }),
      { workspace: options.workspace, home: options.home },
    ),
    ...(options.noApprove
      ? {}
      : {
          approve: async (call: ToolCall) => {
            asked.push(call);
            const answer = options.approve?.(call) ?? 'reject';
            return answer === 'approve' ? 'approve' : 'reject';
          },
        }),
  });
  await harness.run(options.prompt ?? 'go');
  return { model, asked, harness };
}
const toolResult = (model: ScriptedModel, id: string): string =>
  String(
    model.requests
      .flatMap((request) => request.messages)
      .find((message) => message.tool_call_id === id)?.content ?? '',
  );

test('a matcher is everything, a list of names or a regular expression, and if is one rule', () => {
  assert.deepEqual(compileMatcher(undefined), { kind: 'all' });
  assert.deepEqual(compileMatcher('*'), { kind: 'all' });
  assert.deepEqual(compileMatcher(''), { kind: 'all' });
  const listed = compileMatcher('write_file|edit_file');
  assert.deepEqual(listed, {
    kind: 'names',
    names: ['write_file', 'edit_file'],
  });
  assert.deepEqual(compileMatcher('write_file, edit_file'), listed);
  if (typeof listed === 'string') throw new Error(listed);
  assert.equal(matcherMatches(listed, 'edit_file'), true);
  assert.equal(matcherMatches(listed, 'write_files'), false);
  // Anything else is a regular expression, tested anywhere in the value
  const pattern = compileMatcher('^mcp__hub__.*');
  if (typeof pattern === 'string') throw new Error(pattern);
  assert.equal(pattern.kind, 'regex');
  assert.equal(matcherMatches(pattern, 'mcp__hub__dispatch'), true);
  assert.equal(matcherMatches(pattern, 'mcp__other__x'), false);
  // A pack's agent name has a colon, so it is a regular expression
  const agent = compileMatcher('kit:reviewer');
  if (typeof agent === 'string') throw new Error(agent);
  assert.equal(matcherMatches(agent, 'kit:reviewer'), true);
  assert.match(String(compileMatcher('(')), /not a regular expression/);
  assert.deepEqual(parseCondition('execute(git *)'), {
    text: 'execute(git *)',
    tool: 'execute',
    pattern: 'git *',
  });
  assert.deepEqual(parseCondition('write_file'), {
    text: 'write_file',
    tool: 'write_file',
  });
  assert.match(
    String(parseCondition('execute(a) || write_file')),
    /not a rule/,
  );
});

test("hooks load from your settings, the project's files, installed packs and skills; a project's wait for trust", (t) => {
  const dirs = layout(t);
  const ran = join(dirs.root, 'ran.mjs');
  writeFileSync(ran, '');
  const run = handler(ran);
  writeHooks(join(dirs.home, 'settings.json'), {
    PreToolUse: [group('write_file', run)],
    Setup: [group(undefined, run)],
    Nonsense: [],
  });
  writeHooks(join(dirs.workspace, '.circle', 'settings.json'), {
    Stop: [group(undefined, run)],
    PostToolUse: [group(undefined, { type: 'http', url: 'http://x' }, run)],
  });
  writeHooks(
    join(dirs.workspace, '.circle', 'settings.local.json'),
    { SessionStart: [group('startup', run)] },
    { model: 'x' },
  );
  // An installed pack, and a folder that only looks like one
  const pack = join(dirs.userHome, '.agents', 'skills', 'kit');
  mkdirSync(join(pack, 'hooks'), { recursive: true });
  writeFileSync(join(pack, 'pack.json'), '{}');
  writeFileSync(
    join(pack, 'SKILL.md'),
    '---\nname: kit\ndescription: A kit\n---\nKit.\n',
  );
  writeHooks(join(pack, 'hooks', 'hooks.json'), {
    PostToolUse: [group(undefined, run)],
  });
  const loose = join(dirs.userHome, '.agents', 'skills', 'loose');
  mkdirSync(join(loose, 'hooks'), { recursive: true });
  writeFileSync(
    join(loose, 'SKILL.md'),
    '---\nname: loose\ndescription: Not a pack\n---\nLoose.\n',
  );
  writeHooks(join(loose, 'hooks', 'hooks.json'), {
    PostToolUse: [group(undefined, run)],
  });
  // A skill of yours with hooks in its frontmatter, and a project skill
  const yaml = (event: string) =>
    `hooks:\n  ${event}:\n    - matcher: execute\n      hooks:\n        - type: command\n          command: ${JSON.stringify(process.execPath)}\n          args: [${JSON.stringify(ran)}]\n          once: true\n`;
  mkdirSync(join(dirs.home, 'skills', 'demo'), { recursive: true });
  writeFileSync(
    join(dirs.home, 'skills', 'demo', 'SKILL.md'),
    `---\nname: demo\ndescription: Demo\n${yaml('UserPromptSubmit')}---\nDemo.\n`,
  );
  mkdirSync(join(dirs.workspace, '.circle', 'skills', 'local'), {
    recursive: true,
  });
  writeFileSync(
    join(dirs.workspace, '.circle', 'skills', 'local', 'SKILL.md'),
    `---\nname: local\ndescription: Local\n${yaml('PreToolUse')}---\nLocal.\n`,
  );
  const trusted = loadHooks({ ...dirs, trusted: true });
  const where = trusted.hooks.map(
    (hook) => `${hook.sourceLabel} ${hook.event}`,
  );
  assert.deepEqual(where.sort(), [
    'local SessionStart',
    'pack:kit PostToolUse',
    'project PostToolUse',
    'project Stop',
    'skill:demo UserPromptSubmit',
    'skill:local PreToolUse',
    'user PreToolUse',
  ]);
  const skill = trusted.hooks.find((hook) => hook.skill === 'demo')!;
  assert.equal(skill.once, true);
  assert.equal(skill.skillDir, join(dirs.home, 'skills', 'demo'));
  const packed = trusted.hooks.find((hook) => hook.pack === 'kit')!;
  assert.equal(packed.skillDir, pack);
  assert.equal(packed.skillData, join(dirs.home, 'skill-data', 'kit'));
  // What cannot load is named, and the rest of its file still loads
  const errors = trusted.errors.map((error) => error.message).join('\n');
  assert.match(errors, /Setup hooks do not run in Circle/);
  assert.match(errors, /unknown hook event Nonsense/);
  assert.match(errors, /http hooks are not supported in Circle yet/);
  assert.match(errors, /model is not read from settings\.local\.json/);
  assert.equal(trusted.untrusted, false);
  // In a folder not trusted, only the project's own wait
  const held = loadHooks({ ...dirs, trusted: false });
  assert.deepEqual(held.hooks.map((hook) => hook.sourceLabel).sort(), [
    'pack:kit',
    'skill:demo',
    'user',
  ]);
  assert.equal(held.untrusted, true);
  // disableAllHooks turns them all off; the project's word comes after yours
  writeHooks(
    join(dirs.home, 'settings.json'),
    { PreToolUse: [group('write_file', run)] },
    { disableAllHooks: true },
  );
  assert.equal(loadHooks({ ...dirs, trusted: true }).disabled, true);
  writeHooks(
    join(dirs.workspace, '.circle', 'settings.json'),
    { Stop: [group(undefined, run)] },
    { disableAllHooks: false },
  );
  // The project's settings now hold one hook, and say hooks are on
  assert.equal(loadHooks({ ...dirs, trusted: true }).hooks.length, 6);
  // ...and an untrusted project cannot turn yours off
  assert.equal(loadHooks({ ...dirs, trusted: false }).disabled, true);
});

test('a hook answers with its exit code and JSON: a failure lets the call go ahead unless it blocks on failure', async (t) => {
  const dirs = layout(t);
  const cases: [string, unknown, Record<string, unknown>?, object?][] = [
    [
      'json-deny',
      {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'no writes',
        },
      },
    ],
    ['exit-2', '', {}, { exit: 2, stderr: 'stop it\n' }],
    ['exit-1', '', {}, { exit: 1, stderr: 'boom\nmore\n' }],
    [
      'exit-1-blocks',
      '',
      { onFailure: 'block' },
      { exit: 1, stderr: 'boom\n' },
    ],
    ['slow', '', { timeout: 0.2 }, { wait: 5000 }],
    ['broken', '{not json'],
    ['plain', 'all good'],
    ['old-format', { decision: 'deny', reason: 'old style' }],
    [
      'wrong-event',
      {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          permissionDecision: 'deny',
        },
      },
    ],
    // Another exit with a JSON answer: the answer decides
    [
      'exit-1-json',
      {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'check this',
        },
      },
      {},
      { exit: 1 },
    ],
  ];
  writeHooks(join(dirs.home, 'settings.json'), {
    PreToolUse: cases.map(([name, answer, extra, options]) =>
      group(
        name,
        handler(answering(dirs.root, name, answer, options ?? {}), extra ?? {}),
      ),
    ),
  });
  const runner = runnerFor(dirs);
  const run = (tool: string) =>
    runner.run({
      event: 'PreToolUse',
      sessionId: 's',
      cwd: dirs.workspace,
      toolName: tool,
      toolInput: { file_path: 'a.txt' },
    });
  const denied = await run('json-deny');
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.reason, 'no writes');
  const exit2 = await run('exit-2');
  assert.equal(exit2.decision, 'deny');
  assert.equal(exit2.reason, 'stop it');
  const failed = await run('exit-1');
  assert.equal(failed.decision, 'none');
  assert.deepEqual(
    failed.notices.map((notice) => [notice.kind, notice.reason]),
    [['failed', 'exited 1: boom']],
  );
  const blocks = await run('exit-1-blocks');
  assert.equal(blocks.decision, 'deny');
  assert.match(
    blocks.reason,
    /failed; blocking because onFailure is "block": exited 1: boom/,
  );
  const slow = await run('slow');
  assert.equal(slow.decision, 'none');
  assert.match(String(slow.notices[0]?.reason), /^timed out after 0\.2s/);
  const broken = await run('broken');
  assert.equal(broken.decision, 'none');
  assert.match(String(broken.notices[0]?.reason), /output is not JSON/);
  const plain = await run('plain');
  assert.equal(plain.decision, 'none');
  assert.equal(plain.notices.length, 0);
  // A hook not yet rewritten keeps its effect, and is told once that its format is old
  const old = await run('old-format');
  assert.equal(old.decision, 'deny');
  assert.equal(old.reason, 'old style');
  assert.ok(
    old.notices.some((notice) =>
      /format before this one/.test(notice.reason ?? ''),
    ),
  );
  const again = await run('old-format');
  assert.ok(
    !again.notices.some((notice) =>
      /format before this one/.test(notice.reason ?? ''),
    ),
  );
  const wrong = await run('wrong-event');
  assert.equal(wrong.decision, 'none');
  assert.match(
    String(wrong.notices[0]?.reason),
    /hookEventName must be "PreToolUse"/,
  );
  const json = await run('exit-1-json');
  assert.equal(json.decision, 'ask');
  assert.equal(json.reason, 'check this');
});

test('the matching hooks run side by side; deny comes before ask before allow, and different rewrites leave no form to run', async (t) => {
  const dirs = layout(t);
  const flag = join(dirs.root, 'flag');
  // `waiter` finishes only once `writer` has run: one after the other, it would time out
  const waiter = script(
    dirs.root,
    'waiter',
    `import { existsSync, readFileSync } from 'node:fs';
readFileSync(0);
const end = Date.now() + 5000;
while (!existsSync(${JSON.stringify(flag)})) {
  if (Date.now() > end) process.exit(1);
  await new Promise((resolve) => setTimeout(resolve, 20));
}
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }));
`,
  );
  const writer = script(
    dirs.root,
    'writer',
    `import { readFileSync, writeFileSync } from 'node:fs';
readFileSync(0);
writeFileSync(${JSON.stringify(flag)}, 'x');
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'look' } }));
`,
  );
  const decide = (name: string, decision: string, reason: string) =>
    handler(
      answering(dirs.root, name, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision,
          permissionDecisionReason: reason,
        },
      }),
    );
  const rewrite = (name: string, command: string) =>
    handler(
      answering(dirs.root, name, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { command },
        },
      }),
    );
  writeHooks(join(dirs.home, 'settings.json'), {
    PreToolUse: [
      group('together', handler(waiter, { timeout: 10 }), handler(writer)),
      group(
        'ranked',
        decide('allows', 'allow', 'fine'),
        decide('asks', 'ask', 'sure?'),
        decide('denies', 'deny', 'no'),
      ),
      group(
        'one-form',
        rewrite('first', 'ls -la'),
        rewrite('second', 'ls -la'),
      ),
      group(
        'two-forms',
        rewrite('third', 'ls -la'),
        rewrite('fourth', 'ls -1'),
      ),
    ],
  });
  const runner = runnerFor(dirs);
  const run = (tool: string) =>
    runner.run({
      event: 'PreToolUse',
      sessionId: 's',
      cwd: dirs.workspace,
      toolName: tool,
      toolInput: { command: 'ls' },
    });
  const together = await run('together');
  assert.equal(together.decision, 'ask');
  assert.equal(together.notices.filter((n) => n.kind === 'failed').length, 0);
  const ranked = await run('ranked');
  assert.equal(ranked.decision, 'deny');
  assert.equal(ranked.reason, 'no');
  const one = await run('one-form');
  assert.deepEqual(one.updatedInput, { command: 'ls -la' });
  assert.deepEqual(one.conflict, []);
  const two = await run('two-forms');
  assert.equal(two.updatedInput, undefined);
  assert.equal(two.conflict.length, 2);
});

test('if narrows a hook to the calls that match its one rule', async (t) => {
  const dirs = layout(t);
  const seen = join(dirs.root, 'seen');
  const record = handler(answering(dirs.root, 'record', '', { seen }));
  writeHooks(join(dirs.home, 'settings.json'), {
    PreToolUse: [
      group('execute', { ...record, if: 'execute(git *)' }),
      group('write_file', { ...record, if: 'write_file(src/**)' }),
    ],
    Stop: [group(undefined, { ...record, if: 'execute(git *)' })],
  });
  const runner = runnerFor(dirs);
  const call = async (toolName: string, toolInput: Record<string, unknown>) => {
    const before = seenInputs(seen).length;
    await runner.run({
      event: 'PreToolUse',
      sessionId: 's',
      cwd: dirs.workspace,
      toolName,
      toolInput,
      paths:
        typeof toolInput.file_path === 'string' ? [toolInput.file_path] : [],
    });
    return seenInputs(seen).length > before;
  };
  assert.equal(
    await call('execute', { command: 'npm test && git push' }),
    true,
  );
  assert.equal(await call('execute', { command: 'FOO=1 git status' }), true);
  assert.equal(await call('execute', { command: 'ls' }), false);
  // What runs in a substitution cannot be told apart: the hook runs
  assert.equal(await call('execute', { command: 'echo $(rm -rf x)' }), true);
  assert.equal(await call('write_file', { file_path: 'src/a.ts' }), true);
  assert.equal(await call('write_file', { file_path: 'docs/a.md' }), false);
  // `if` on an event about no tool: the hook never runs
  await runner.run({ event: 'Stop', sessionId: 's', cwd: dirs.workspace });
  assert.equal(seenInputs(seen).length, 4);
});

test("the same handler in two settings files runs once; a pack's copy runs on its own", async (t) => {
  const dirs = layout(t);
  const seen = join(dirs.root, 'seen');
  const record = handler(answering(dirs.root, 'record', '', { seen }));
  writeHooks(join(dirs.home, 'settings.json'), {
    PostToolUse: [group(undefined, record)],
  });
  writeHooks(join(dirs.workspace, '.circle', 'settings.json'), {
    PostToolUse: [group('read_file', record)],
  });
  const pack = join(dirs.userHome, '.agents', 'skills', 'kit');
  mkdirSync(join(pack, 'hooks'), { recursive: true });
  writeFileSync(join(pack, 'pack.json'), '{}');
  writeHooks(join(pack, 'hooks', 'hooks.json'), {
    PostToolUse: [group(undefined, record)],
  });
  const runner = new HookRunner(loadHooks({ ...dirs, trusted: true }), {
    workspace: dirs.workspace,
    home: dirs.home,
    // The pack's files check out
    verifyPack: async () => undefined,
  });
  await runner.run({
    event: 'PostToolUse',
    sessionId: 's',
    cwd: dirs.workspace,
    toolName: 'read_file',
    toolInput: {},
  });
  assert.equal(seenInputs(seen).length, 2);
  // A pack whose files do not check out runs none of its hooks
  const tampered = new HookRunner(loadHooks({ ...dirs, trusted: true }), {
    workspace: dirs.workspace,
    home: dirs.home,
    verifyPack: async () => 'a file changed',
  });
  const batch = await tampered.run({
    event: 'PostToolUse',
    sessionId: 's',
    cwd: dirs.workspace,
    toolName: 'read_file',
    toolInput: {},
  });
  assert.equal(seenInputs(seen).length, 3);
  assert.ok(
    batch.notices.some(
      (notice) =>
        notice.name === 'pack kit' && notice.reason === 'a file changed',
    ),
  );
});

test("a skill's once hook runs once, and a background hook neither holds the call up nor decides it", async (t) => {
  const dirs = layout(t);
  const seen = join(dirs.root, 'seen');
  const skill = join(dirs.home, 'skills', 'demo');
  mkdirSync(skill, { recursive: true });
  const once = answering(dirs.root, 'once', '', { seen });
  writeFileSync(
    join(skill, 'SKILL.md'),
    `---\nname: demo\ndescription: Demo\nhooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: ${JSON.stringify(process.execPath)}\n          args: [${JSON.stringify(once)}]\n          once: true\n---\nDemo.\n`,
  );
  const late = answering(
    dirs.root,
    'late',
    {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        additionalContext: 'checked later',
      },
    },
    { wait: 200 },
  );
  writeHooks(join(dirs.home, 'settings.json'), {
    PreToolUse: [group(undefined, handler(late, { async: true }))],
  });
  const runner = runnerFor(dirs);
  const run = () =>
    runner.run({
      event: 'PreToolUse',
      sessionId: 's',
      cwd: dirs.workspace,
      toolName: 'ls',
      toolInput: {},
    });
  // Not loaded yet: the skill's hook does not run
  await run();
  assert.equal(seenInputs(seen).length, 0);
  runner.activateSkill('demo');
  const first = await run();
  await run();
  assert.equal(seenInputs(seen).length, 1);
  // The background hook's deny decides nothing; what it says reaches the model's next request
  assert.equal(first.decision, 'none');
  const delivered: { context: string }[] = [];
  await until(
    () => {
      delivered.push(...runner.takeDelivered('s'));
      return delivered.length > 0;
    },
    { label: "the background hook's answer" },
  );
  assert.equal(delivered[0]!.context, 'checked later');
  runner.close();
});

test('a hook gets the event as documented, saved secrets as %NAME%, and its folders as variables', async (t) => {
  const dirs = layout(t);
  const seen = join(dirs.root, 'seen');
  const env = join(dirs.root, 'env');
  const hook = script(
    dirs.root,
    'look',
    `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(seen)}, readFileSync(0, 'utf8').trim() + '\\n');
writeFileSync(${JSON.stringify(env)}, JSON.stringify({ project: process.env.CIRCLE_PROJECT_DIR ?? null, session: process.env.CIRCLE_SESSION_ID ?? null, skill: process.env.CIRCLE_SKILL_DIR ?? null, arg: process.argv[2] ?? null }));
`,
  );
  writeHooks(join(dirs.home, 'settings.json'), {
    PreToolUse: [
      group(undefined, {
        type: 'command',
        command: process.execPath,
        args: [hook, '${CIRCLE_PROJECT_DIR}/x'],
      }),
    ],
  });
  const runner = runnerFor(dirs);
  await runner.run({
    event: 'PreToolUse',
    sessionId: 'session-1',
    cwd: dirs.workspace,
    permissionMode: 'acceptEdits',
    toolName: 'execute',
    toolInput: { command: 'curl -H "token: sekret-value" x' },
    toolUseId: 'call-1',
    secrets: { TOKEN: 'sekret-value' },
  });
  const [input] = seenInputs(seen);
  assert.equal(input!.session_id, 'session-1');
  assert.equal(input!.cwd, dirs.workspace);
  assert.equal(input!.hook_event_name, 'PreToolUse');
  assert.equal(input!.permission_mode, 'acceptEdits');
  assert.equal(input!.tool_name, 'execute');
  assert.equal(input!.tool_use_id, 'call-1');
  assert.deepEqual(input!.tool_input, {
    command: 'curl -H "token: %TOKEN%" x',
  });
  assert.deepEqual(JSON.parse(readFileSync(env, 'utf8')), {
    project: dirs.workspace,
    session: 'session-1',
    skill: null,
    arg: `${dirs.workspace}/x`,
  });
  assert.doesNotMatch(
    readFileSync(join(dirs.home, 'hooks.log'), 'utf8'),
    /sekret-value/,
  );
});

test('a shell-form hook runs in sh, in Git Bash on Windows, or in PowerShell without it or when asked', (t) => {
  const dirs = layout(t);
  assert.deepEqual(hookLaunch({ command: 'echo hi' }, {}, 'linux'), {
    file: '/bin/sh',
    args: ['-c', 'echo hi'],
  });
  const bash = join(dirs.root, 'bash.exe');
  writeFileSync(bash, '');
  assert.deepEqual(
    hookLaunch({ command: 'echo hi' }, { CIRCLE_GIT_BASH_PATH: bash }, 'win32'),
    { file: bash, args: ['-c', 'echo hi'] },
  );
  const powershell = hookLaunch(
    { command: '& "${CIRCLE_PROJECT_DIR}\\check.ps1"', shell: 'powershell' },
    { CIRCLE_GIT_BASH_PATH: bash, PATH: '' },
    'win32',
  );
  assert.equal(powershell.file, 'powershell.exe');
  const encoded =
    powershell.args[powershell.args.indexOf('-EncodedCommand') + 1]!;
  // A program's exit code is the hook's: PowerShell would give 1 for any failure
  assert.equal(
    Buffer.from(encoded, 'base64').toString('utf16le'),
    '& "${env:CIRCLE_PROJECT_DIR}\\check.ps1"\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }',
  );
  // PowerShell standing in for a missing Git Bash, and cmd.exe for a hook moved from the format before this one
  assert.equal(
    hookLaunch({ command: 'x' }, { PATH: '' }, 'win32').fallback,
    true,
  );
  const cmd = hookLaunch(
    { command: 'node "${CIRCLE_SKILL_DIR}/a.mjs"', legacy: true },
    { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    'win32',
  );
  assert.deepEqual(cmd, {
    file: 'C:\\Windows\\system32\\cmd.exe',
    args: ['/d', '/s', '/c', '"node "%CIRCLE_SKILL_DIR%/a.mjs""'],
    verbatim: true,
  });
  // Exec form: no shell, the placeholders put in as text
  assert.deepEqual(
    hookLaunch(
      { command: 'node', args: ['${CIRCLE_SKILL_DIR}/a.js', "it's"] },
      { CIRCLE_SKILL_DIR: '/skills/kit' },
      'win32',
    ),
    { file: 'node', args: ['/skills/kit/a.js', "it's"] },
  );
});

test('a PreToolUse deny stands in auto, an allow skips the card, an ask brings it back, and a hard refusal reaches no hook', async (t) => {
  const dirs = layout(t);
  const seen = join(dirs.root, 'seen');
  const gate = script(
    dirs.root,
    'gate',
    `import { appendFileSync, readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(${JSON.stringify(seen)}, JSON.stringify(input) + '\\n');
const decide =
  input.tool_name === 'write_file' ? ['deny', 'no writes']
  : input.tool_input.command === 'echo asked' ? ['ask', 'look first']
  : input.tool_name === 'execute' ? ['allow', 'fine'] : undefined;
if (decide) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decide[0], permissionDecisionReason: decide[1] } }));
`,
  );
  writeHooks(join(dirs.workspace, '.circle', 'settings.json'), {
    PreToolUse: [group(undefined, handler(gate))],
  });
  const auto = await turn({
    ...dirs,
    t,
    mode: 'auto',
    approve: () => 'approve',
    replies: [
      assistant('', [
        {
          id: 'w',
          name: 'write_file',
          args: { file_path: 'note.txt', content: 'hello' },
        },
        { id: 'e', name: 'execute', args: { command: 'echo asked' } },
        { id: 's', name: 'execute', args: { command: 'sudo true' } },
      ]),
      assistant('done'),
    ],
  });
  assert.equal(existsSync(join(dirs.workspace, 'note.txt')), false);
  assert.match(toolResult(auto.model, 'w'), /Hook denied this call: no writes/);
  // An ask brings the card back even in auto
  assert.deepEqual(
    auto.asked.map((call) => call.args.command),
    ['echo asked'],
  );
  assert.match(
    toolResult(auto.model, 'e'),
    /Hook asked before this call: look first/,
  );
  // The hard refusal is decided before any hook
  assert.deepEqual(
    seenInputs(seen).map((input) => input.tool_name),
    ['write_file', 'execute'],
  );
  assert.match(toolResult(auto.model, 's'), /sudo|Denied by approval policy/);
  // In manual mode an allow skips the card the command would get
  const manual = await turn({
    ...dirs,
    t,
    mode: 'manual',
    replies: [
      assistant('', [
        { id: 'x', name: 'execute', args: { command: 'echo allowed' } },
      ]),
      assistant('done'),
    ],
  });
  assert.equal(manual.asked.length, 0);
  assert.match(toolResult(manual.model, 'x'), /allowed/);
  assert.equal(seenInputs(seen).at(-1)!.permission_mode, 'default');
});

test('a rewrite runs in place of the call after the same checks, and one that brings in a secret shows the card', async (t) => {
  const dirs = layout(t);
  const rewrite = script(
    dirs.root,
    'rewrite',
    `import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const to = { 'echo one': 'echo two', 'echo secret': 'echo %TOKEN%' }[input.tool_input.command];
if (to) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: to } } }));
`,
  );
  writeHooks(join(dirs.home, 'settings.json'), {
    PreToolUse: [group('execute', handler(rewrite, { name: 'canon' }))],
  });
  const run = await turn({
    ...dirs,
    t,
    mode: 'manual',
    secrets: { TOKEN: 'v4lue-of-token' },
    approve: () => 'reject',
    replies: [
      assistant('', [
        { id: 'a', name: 'execute', args: { command: 'echo one' } },
        { id: 'b', name: 'execute', args: { command: 'echo secret' } },
      ]),
      assistant('done'),
    ],
  });
  const first = toolResult(run.model, 'a');
  assert.match(
    first,
    /^Hook changed this call's input \(canon\):\ncommand = "echo two"/,
  );
  assert.match(first, /\btwo\b/);
  // The rewrite named a secret the call did not carry: the card shows it, and the person said no
  assert.deepEqual(
    run.asked.map((call) => call.args.command),
    ['echo %TOKEN%'],
  );
  assert.match(toolResult(run.model, 'b'), /The user rejected this tool call/);
});

test('PermissionRequest answers the card: an allow runs the call, a deny refuses it, and an allow in another form leaves the card to you', async (t) => {
  const dirs = layout(t);
  const seen = join(dirs.root, 'seen');
  const answer = script(
    dirs.root,
    'answer',
    `import { appendFileSync, readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(${JSON.stringify(seen)}, JSON.stringify(input) + '\\n');
const decision = {
  'echo allowed': { behavior: 'allow' },
  'echo denied': { behavior: 'deny', message: 'not this one' },
  'echo other': { behavior: 'allow', updatedInput: { command: 'echo changed' } },
}[input.tool_input.command];
if (decision) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
`,
  );
  writeHooks(join(dirs.home, 'settings.json'), {
    PermissionRequest: [group('execute', handler(answer))],
  });
  const run = await turn({
    ...dirs,
    t,
    mode: 'manual',
    approve: () => 'reject',
    replies: [
      assistant('', [
        { id: 'a', name: 'execute', args: { command: 'echo allowed' } },
        { id: 'd', name: 'execute', args: { command: 'echo denied' } },
        { id: 'o', name: 'execute', args: { command: 'echo other' } },
      ]),
      assistant('done'),
    ],
  });
  assert.match(toolResult(run.model, 'a'), /allowed/);
  assert.match(
    toolResult(run.model, 'd'),
    /Hook denied this call: not this one/,
  );
  assert.deepEqual(
    run.asked.map((call) => call.args.command),
    ['echo other'],
  );
  assert.match(toolResult(run.model, 'o'), /The user rejected this tool call/);
  // A permission request is about a call, not a tool use: it has no id
  assert.ok(seenInputs(seen).every((input) => !('tool_use_id' in input)));
});

test('PostToolUse puts its words and a block reason beside the result and can replace what the model reads; PostToolUseFailure hears a tool that failed', async (t) => {
  const dirs = layout(t);
  const seen = join(dirs.root, 'seen');
  const failures = join(dirs.root, 'failures');
  writeFileSync(join(dirs.workspace, 'a.txt'), 'original a');
  writeFileSync(join(dirs.workspace, 'b.txt'), 'original b');
  const after = script(
    dirs.root,
    'after',
    `import { appendFileSync, readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(${JSON.stringify(seen)}, JSON.stringify(input) + '\\n');
const path = input.tool_input.file_path ?? input.tool_input.path;
if (path === 'a.txt') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'a.txt is generated', updatedToolOutput: 'replaced text' } }));
else if (path === 'b.txt') process.stdout.write(JSON.stringify({ decision: 'block', reason: 'b.txt is stale' }));
else process.stdout.write('plain words nobody reads');
`,
  );
  const failed = answering(
    dirs.root,
    'failed',
    {
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        additionalContext: 'try a path that exists',
      },
    },
    { seen: failures },
  );
  writeHooks(join(dirs.home, 'settings.json'), {
    PostToolUse: [group(undefined, handler(after, { name: 'after' }))],
    PostToolUseFailure: [
      group('read_file', handler(failed, { name: 'failed' })),
    ],
  });
  const run = await turn({
    ...dirs,
    t,
    mode: 'auto',
    replies: [
      assistant('', [
        { id: 'a', name: 'read_file', args: { file_path: 'a.txt' } },
        { id: 'b', name: 'read_file', args: { file_path: 'b.txt' } },
        { id: 'l', name: 'ls', args: { path: '.' } },
        { id: 'm', name: 'read_file', args: { file_path: 'missing.txt' } },
      ]),
      assistant('done'),
    ],
  });
  const a = toolResult(run.model, 'a');
  assert.match(a, /^replaced text/);
  assert.doesNotMatch(a, /original a/);
  assert.match(a, /Hook output \(after\):\na\.txt is generated/);
  const b = toolResult(run.model, 'b');
  assert.match(b, /original b/);
  assert.match(b, /b\.txt is stale/);
  assert.doesNotMatch(toolResult(run.model, 'l'), /plain words/);
  assert.match(
    readFileSync(join(dirs.home, 'hooks.log'), 'utf8'),
    /plain words nobody reads/,
  );
  const [input] = seenInputs(seen);
  assert.equal(input!.hook_event_name, 'PostToolUse');
  assert.match(String(input!.tool_response), /original a/);
  assert.equal(typeof input!.duration_ms, 'number');
  // The tool itself failed: its hooks hear the error, and their words go beside it
  assert.match(toolResult(run.model, 'm'), /try a path that exists/);
  const [failure] = seenInputs(failures);
  assert.equal(failure!.tool_name, 'read_file');
  assert.equal(failure!.is_interrupt, false);
  assert.match(String(failure!.error), /missing\.txt|no such file|ENOENT/i);
  // A call refused before it ran is no tool failure
  assert.equal(seenInputs(failures).length, 1);
});

test('a command that exits non-zero is a failed call that PostToolUseFailure hears, and its output reads as that of one that exits 0', async (t) => {
  const dirs = layout(t);
  const posted = join(dirs.root, 'posted');
  const failures = join(dirs.root, 'failures');
  const emit = script(
    dirs.root,
    'emit',
    "const words = process.argv.slice(2);\nprocess.stdout.write(words.slice(0, -1).join(' '));\nprocess.exit(Number(words.at(-1)));\n",
  );
  writeHooks(join(dirs.home, 'settings.json'), {
    PostToolUse: [
      group(
        'execute',
        handler(answering(dirs.root, 'post', undefined, { seen: posted })),
      ),
    ],
    PostToolUseFailure: [
      group(
        'execute',
        handler(answering(dirs.root, 'failed', undefined, { seen: failures })),
      ),
    ],
  });
  const command = (code: number) =>
    `${JSON.stringify(process.execPath)} ${JSON.stringify(emit)} token=abc1234567 %LAB_SECRET% ${code}`;
  const run = await turn({
    ...dirs,
    t,
    mode: 'auto',
    secrets: { LAB_SECRET: 'q9z8x7w6v5' },
    replies: [
      assistant('', [
        { id: 'bad', name: 'execute', args: { command: command(1) } },
        { id: 'good', name: 'execute', args: { command: command(0) } },
      ]),
      assistant('done'),
    ],
  });
  const result = (id: string) =>
    run.model.requests[1]!.messages.find(
      (message) => message.tool_call_id === id,
    )!;
  assert.equal(result('bad').status, 'error');
  assert.equal(
    result('bad').content,
    'token=abc1234567 %LAB_SECRET%\nExit code: 1',
  );
  assert.equal(result('good').status, 'success');
  assert.equal(
    result('good').content,
    'token=abc1234567 %LAB_SECRET%\nExit code: 0',
  );
  assert.deepEqual(
    seenInputs(failures).map((input) => input.error),
    ['token=abc1234567 %LAB_SECRET%\nExit code: 1'],
  );
  assert.deepEqual(
    seenInputs(posted).map((input) => input.tool_response),
    ['token=abc1234567 %LAB_SECRET%\nExit code: 0'],
  );
});

test('a hook that says continue: false ends the turn once the calls under way are done', async (t) => {
  const dirs = layout(t);
  const stop = answering(dirs.root, 'stop', {
    continue: false,
    stopReason: 'enough for today',
  });
  writeHooks(join(dirs.home, 'settings.json'), {
    PostToolUse: [group('ls', handler(stop))],
  });
  const run = await turn({
    ...dirs,
    t,
    mode: 'auto',
    replies: [
      assistant('', [{ id: 'l', name: 'ls', args: { path: '.' } }]),
      assistant('more work', [{ id: 'k', name: 'ls', args: { path: '.' } }]),
      assistant('done'),
    ],
  });
  assert.equal(run.model.requests.length, 1);
  assert.ok(
    run.harness.messages.some(
      (message) =>
        message.hook?.kind === 'stopped' &&
        message.hook.reason === 'enough for today',
    ),
  );
});

test('path globs follow canonical paths and Windows or macOS case rules', (t) => {
  const { workspace } = layout(t);
  mkdirSync(join(workspace, 'real'), { recursive: true });
  writeFileSync(join(workspace, 'real', 'App.ts'), 'export {}\n');
  // A Windows junction needs no symlink privilege and canonicalizes the same way.
  symlinkSync(
    join(workspace, 'real'),
    join(workspace, 'link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const linked = join(workspace, 'link', 'App.ts');
  assert.equal(
    canonicalPath(linked),
    canonicalPath(join(workspace, 'real', 'App.ts')),
  );
  assert.equal(
    matchHookPath(linked, 'real/**/*.ts', { workspace }),
    true,
    'a symlink matches the glob of its target',
  );
  assert.equal(matchHookPath(linked, 'link/**/*.ts', { workspace }), false);

  const windows = {
    workspace: 'C:\\Repo',
    platform: 'win32' as const,
    canonicalize: (path: string) => path,
  };
  assert.equal(
    matchHookPath('C:\\Repo\\Src\\App.TS', 'src/**/*.ts', windows),
    true,
  );
  assert.equal(
    matchHookPath('C:/Repo/Src/App.ts', 'src\\**\\*.ts', windows),
    true,
  );
  assert.equal(
    matchHookPath('C:\\Other\\Src\\App.ts', 'src/**/*.ts', windows),
    false,
  );
  assert.equal(
    matchHookPath('D:\\Repo\\Src\\App.ts', 'C:\\Repo\\**\\*.ts', windows),
    false,
  );

  const mac = {
    workspace: '/Repo',
    platform: 'darwin' as const,
    canonicalize: (path: string) => path,
  };
  assert.equal(matchHookPath('/Repo/Src/App.ts', 'Src/**/*.ts', mac), true);
  assert.equal(matchHookPath('/Repo/Src/App.ts', 'src/**/*.ts', mac), false);
  assert.equal(matchHookPath('/Repo/Src/App.ts', 'Src/**/*.TS', mac), false);
  assert.equal(matchHookPath('/Repo/Src/App.ts', '/Repo/Src/*.ts', mac), true);
});
