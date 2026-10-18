import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ApprovalPolicy, ApprovalStore } from '../src/approvals.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { Harness } from '../src/harness.js';
import {
  HookRunner,
  hookNoticeText,
  loadHooks,
  matchHookPath,
  type HookDefinition,
} from '../src/hooks.js';
import { canonicalPath } from '../src/paths.js';
import { AgentRuntime } from '../src/runtime.js';
import { Sandbox } from '../src/sandbox.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { buildTools } from '../src/tools.js';
import { uiText } from '../src/locale.js';
import type { Message, ToolCall } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

const assistant = (
  content: string,
  calls: Message['tool_calls'] = [],
): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  content,
  tool_calls: calls,
});

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

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

test('path globs follow canonical paths and Windows or macOS case rules', (t) => {
  const { workspace } = layout(t);
  mkdirSync(join(workspace, 'real'), { recursive: true });
  writeFileSync(join(workspace, 'real', 'App.ts'), 'export {}\n');
  symlinkSync(join(workspace, 'real'), join(workspace, 'link'), 'dir');
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

test('project hooks load only for a trusted folder, and a skill can ship hooks', (t) => {
  const { home, workspace, userHome } = layout(t);
  writeJson(join(home, 'hooks.json'), {
    version: 1,
    hooks: {
      before_tool: [{ name: 'user guard', command: 'true', tools: 'execute' }],
    },
  });
  writeJson(join(workspace, '.circle', 'hooks.json'), {
    hooks: {
      before_tool: [
        {
          name: 'project guard',
          command: 'true',
          tools: ['write_file', 'edit_file'],
        },
        { command: '' },
      ],
      no_such_event: [{ command: 'true' }],
    },
  });
  const skill = join(workspace, '.circle', 'skills', 'lint');
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, 'SKILL.md'),
    '---\nname: lint\ndescription: Lint.\n---\n\nLint.\n',
  );
  writeJson(join(skill, 'hooks.json'), {
    hooks: {
      after_tool: [{ name: 'skill lint', command: 'true', paths: ['**/*.ts'] }],
    },
  });
  const ignored = loadHooks({
    workspace,
    home,
    trusted: false,
    userHome,
  });
  assert.equal(ignored.projectIgnored, true);
  assert.deepEqual(
    ignored.hooks.map((hook) => hook.name),
    ['user guard'],
  );
  const trusted = loadHooks({ workspace, home, trusted: true, userHome });
  assert.equal(trusted.projectIgnored, false);
  assert.deepEqual(
    trusted.hooks.map((hook) => `${hook.source}:${hook.name}`),
    ['user:user guard', 'project:project guard', 'skill:skill lint'],
  );
  assert.ok(trusted.errors.some((error) => error.message.includes('command')));
  assert.ok(
    trusted.errors.some((error) => error.message.includes('no_such_event')),
  );
  const many = Array.from({ length: 101 }, () => ({ command: 'true' }));
  writeJson(join(home, 'hooks.json'), {
    version: 2,
    hooks: { before_tool: many },
  });
  const unsupported = loadHooks({ workspace, home, trusted: true, userHome });
  assert.ok(
    unsupported.errors.some((error) => error.message.includes('not supported')),
  );
  assert.ok(!unsupported.hooks.some((hook) => hook.source === 'user'));
  writeJson(join(home, 'hooks.json'), { hooks: { before_tool: many } });
  const capped = loadHooks({ workspace, home, trusted: true, userHome });
  assert.equal(
    capped.hooks.filter((hook) => hook.source === 'user').length,
    100,
  );
  assert.ok(
    capped.errors.some((error) => error.message.includes('at most 100')),
  );
  writeFileSync(join(home, 'hooks.json'), '{');
  const broken = loadHooks({ workspace, home, trusted: true, userHome });
  assert.ok(broken.errors.some((error) => error.file.endsWith('hooks.json')));
  assert.ok(!broken.hooks.some((hook) => hook.source === 'user'));
});

test('a hook reads JSON on stdin and a deny, ask or allow is the strictest decision', async (t) => {
  const { home, workspace, userHome } = layout(t);
  const seen = join(workspace, 'seen.json');
  const script = join(workspace, 'decide.mjs');
  writeFileSync(
    script,
    `
import { readFileSync, writeFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
writeFileSync(${JSON.stringify(seen)}, JSON.stringify(input));
if (input.tool_name === 'delete') {
  process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'no delete' }));
} else if (input.tool_name === 'execute') {
  process.stdout.write(JSON.stringify({ decision: 'ask', reason: 'check the command' }));
} else if (input.tool_name === 'write_file') {
  process.stdout.write(JSON.stringify({ decision: 'allow', reason: 'format later' }));
} else {
  process.exit(2);
}
`,
  );
  writeJson(join(workspace, '.circle', 'hooks.json'), {
    hooks: {
      before_tool: [
        { name: 'decide', command: nodeCommand(script), tools: '*' },
        {
          name: 'also allow',
          command: nodeCommand(join(workspace, 'allow.mjs')),
          tools: 'write_file',
        },
      ],
    },
  });
  writeFileSync(
    join(workspace, 'allow.mjs'),
    `process.stdout.write(JSON.stringify({ decision: 'allow' }));`,
  );
  const runner = new HookRunner(
    loadHooks({ workspace, home, trusted: true, userHome }),
    { workspace, home },
  );
  const deny = await runner.run({
    event: 'before_tool',
    sessionId: 's',
    cwd: workspace,
    toolName: 'delete',
    toolInput: { file_path: 'a.txt', content: 'SECRET_BODY' },
    paths: ['a.txt'],
  });
  assert.equal(deny.decision, 'deny');
  assert.match(deny.reason, /no delete/);
  const input = JSON.parse(readFileSync(seen, 'utf8')) as { tool_name: string };
  assert.equal(input.tool_name, 'delete');
  const ask = await runner.run({
    event: 'before_tool',
    sessionId: 's',
    cwd: workspace,
    toolName: 'execute',
    toolInput: { command: 'ls' },
    paths: [],
  });
  assert.equal(ask.decision, 'ask');
  const allow = await runner.run({
    event: 'before_tool',
    sessionId: 's',
    cwd: workspace,
    toolName: 'write_file',
    toolInput: { file_path: 'a.txt' },
    paths: ['a.txt'],
  });
  assert.equal(allow.decision, 'allow');
  const log = readFileSync(join(home, 'hooks.log'), 'utf8');
  assert.match(log, /"decision":"deny"/);
  assert.doesNotMatch(log, /SECRET_BODY/);
  assert.equal(
    hookNoticeText({ kind: 'denied', tool: 'delete', reason: 'no delete' }),
    'hook denied delete · no delete',
  );
  assert.equal(
    uiText('hook denied delete · no delete', 'zh-CN'),
    '钩子拒绝了 delete · no delete',
  );
  assert.equal(
    uiText('project hooks need trust', 'zh-CN'),
    '项目钩子需要先信任文件夹',
  );
  assert.equal(
    uiText('Hook denied this call: no delete', 'zh-CN'),
    '钩子拒绝了此次调用： no delete',
  );
});

test('a gating hook that times out or exits badly denies, and the secret environment is removed', async (t) => {
  const { home, workspace, userHome } = layout(t);
  const previous = process.env.API_TOKEN;
  process.env.API_TOKEN = 'super-secret-value';
  t.after(() => {
    if (previous === undefined) delete process.env.API_TOKEN;
    else process.env.API_TOKEN = previous;
  });
  const script = join(workspace, 'env.mjs');
  writeFileSync(
    script,
    `process.stdout.write(process.env.API_TOKEN || 'hidden'); process.exit(1);`,
  );
  writeJson(join(home, 'hooks.json'), {
    hooks: {
      before_tool: [
        {
          name: 'slow',
          command: nodeCommand(join(workspace, 'slow.mjs')),
          timeout_ms: 200,
        },
        { name: 'env', command: nodeCommand(script), tools: 'execute' },
      ],
    },
  });
  writeFileSync(
    join(workspace, 'slow.mjs'),
    `setInterval(() => {}, 1000000);\n`,
  );
  const runner = new HookRunner(
    loadHooks({ workspace, home, trusted: false, userHome }),
    { workspace, home },
  );
  const started = Date.now();
  const slow = await runner.run({
    event: 'before_tool',
    sessionId: 's',
    cwd: workspace,
    toolName: 'write_file',
    toolInput: { file_path: 'a.txt' },
    paths: ['a.txt'],
  });
  assert.ok(Date.now() - started < 5000, 'the timeout stops the hook');
  assert.equal(slow.decision, 'deny');
  assert.match(slow.reason, /timed out/);
  const leaked = await runner.run({
    event: 'before_tool',
    sessionId: 's',
    cwd: workspace,
    toolName: 'execute',
    toolInput: { command: 'true' },
    paths: [],
  });
  assert.equal(leaked.decision, 'deny');
  assert.doesNotMatch(leaked.reason, /super-secret-value/);
  assert.match(leaked.reason, /hidden/);
});

async function turn(options: {
  t: { after(fn: () => void | Promise<void>): void };
  home: string;
  workspace: string;
  userHome: string;
  trusted: boolean;
  mode?: 'manual' | 'auto' | 'accept-edits';
  replies: Message[];
  approve?: (call: ToolCall) => 'approve' | 'reject';
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
  const asked: string[] = [];
  const harness = new Harness({
    model,
    tools: buildTools(new Sandbox(options.workspace)),
    store,
    session,
    policy,
    system: 'test',
    hooks: new HookRunner(
      loadHooks({
        workspace: options.workspace,
        home: options.home,
        trusted: options.trusted,
        userHome: options.userHome,
      }),
      { workspace: options.workspace, home: options.home },
    ),
    approve: async (call) => {
      asked.push(call.name);
      const answer = options.approve?.(call) ?? 'reject';
      return answer === 'approve' ? 'approve' : 'reject';
    },
  });
  await harness.run('go');
  return { model, asked, harness };
}

test('a hook deny overrides auto and accept-edits, and an allow cannot pass a hard refusal', async (t) => {
  const dirs = layout(t);
  const marker = join(dirs.workspace, 'hook-ran');
  const script = join(dirs.workspace, 'deny.mjs');
  // Denies writes and allows everything else, including the command a hard
  // refusal must still block before any hook starts.
  writeFileSync(
    script,
    `
import { readFileSync, writeFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
writeFileSync(${JSON.stringify(marker)}, input.tool_name);
if (input.tool_name === 'write_file') {
  process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'no writes' }));
} else {
  process.stdout.write(JSON.stringify({ decision: 'allow', reason: 'go' }));
}
`,
  );
  writeJson(join(dirs.workspace, '.circle', 'hooks.json'), {
    hooks: {
      before_tool: [{ name: 'gate', command: nodeCommand(script) }],
    },
  });
  const denied = await turn({
    ...dirs,
    t,
    trusted: true,
    mode: 'auto',
    replies: [
      assistant('', [
        {
          id: 'w',
          name: 'write_file',
          args: { file_path: 'note.txt', content: 'hello' },
        },
      ]),
      assistant('stopped'),
    ],
  });
  assert.equal(denied.asked.length, 0);
  assert.equal(readFileSync(marker, 'utf8'), 'write_file');
  let missing = false;
  try {
    readFileSync(join(dirs.workspace, 'note.txt'), 'utf8');
  } catch {
    missing = true;
  }
  assert.equal(missing, true);
  assert.match(
    String(
      denied.model.requests[1]!.messages.find(
        (message) => message.role === 'tool',
      )?.content,
    ),
    /Hook denied this call: no writes/,
  );
  assert.ok(
    denied.harness.messages.some((message) => message.hook?.kind === 'denied'),
  );

  writeFileSync(marker, '');
  const forced = await turn({
    ...dirs,
    t,
    trusted: true,
    mode: 'auto',
    replies: [
      assistant('', [
        { id: 's', name: 'execute', args: { command: 'sudo true' } },
      ]),
      assistant('stopped'),
    ],
  });
  assert.equal(readFileSync(marker, 'utf8'), '');
  assert.match(
    String(forced.model.requests[1]!.messages.at(-1)?.content),
    /sudo|Denied by approval policy/,
  );
});

test('an allow skips the card and an ask forces one even in auto', async (t) => {
  const dirs = layout(t);
  const script = join(dirs.workspace, 'choose.mjs');
  writeFileSync(
    script,
    `
import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const decision = input.tool_input.file_path === 'ask.txt' ? 'ask' : 'allow';
const reason = decision === 'ask' ? 'look first' : 'safe';
process.stdout.write(JSON.stringify({ decision, reason }));
`,
  );
  writeJson(join(dirs.home, 'hooks.json'), {
    hooks: {
      before_tool: [
        { name: 'choose', command: nodeCommand(script), tools: 'write_file' },
      ],
    },
  });
  const allowed = await turn({
    ...dirs,
    t,
    trusted: false,
    mode: 'manual',
    replies: [
      assistant('', [
        {
          id: 'w',
          name: 'write_file',
          args: { file_path: 'ok.txt', content: 'yes' },
        },
      ]),
      assistant('done'),
    ],
    approve: () => {
      throw new Error('the card should not show');
    },
  });
  assert.equal(readFileSync(join(dirs.workspace, 'ok.txt'), 'utf8'), 'yes');
  assert.match(
    String(
      allowed.model.requests[1]!.messages.find(
        (message) => message.role === 'tool',
      )?.content,
    ),
    /Hook allowed this call/,
  );

  const asked = await turn({
    ...dirs,
    t,
    trusted: false,
    mode: 'auto',
    replies: [
      assistant('', [
        {
          id: 'w',
          name: 'write_file',
          args: { file_path: 'ask.txt', content: 'no' },
        },
      ]),
      assistant('done'),
    ],
    approve: () => 'reject',
  });
  assert.deepEqual(asked.asked, ['write_file']);
  let missing = false;
  try {
    readFileSync(join(dirs.workspace, 'ask.txt'));
  } catch {
    missing = true;
  }
  assert.equal(missing, true);
  assert.match(
    String(
      asked.model.requests[1]!.messages.find(
        (message) => message.role === 'tool',
      )?.content,
    ),
    /hook asked: look first/,
  );
});

test('after a tool the hook output is fed back, and a stop hook blocks until its limit', async (t) => {
  const dirs = layout(t);
  const format = join(dirs.workspace, 'format.mjs');
  writeFileSync(format, `process.stdout.write('formatted the file');`);
  const stop = join(dirs.workspace, 'stop.mjs');
  const count = join(dirs.workspace, 'stops');
  writeFileSync(
    stop,
    `
import { readFileSync, writeFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
writeFileSync(${JSON.stringify(count)}, String(input.stop_attempt));
process.stderr.write('tests failed');
process.exit(2);
`,
  );
  writeJson(join(dirs.workspace, '.circle', 'hooks.json'), {
    hooks: {
      after_tool: [
        {
          name: 'format',
          command: nodeCommand(format),
          tools: 'write_file',
          paths: ['**/*.txt'],
        },
      ],
      before_stop: [
        { name: 'tests', command: nodeCommand(stop), loop_limit: 1 },
      ],
      session_start: [
        {
          name: 'hello',
          command: nodeCommand(join(dirs.workspace, 'hello.mjs')),
        },
      ],
    },
  });
  writeFileSync(
    join(dirs.workspace, 'hello.mjs'),
    `process.stdout.write('hello from hook');`,
  );
  const result = await turn({
    ...dirs,
    t,
    trusted: true,
    mode: 'auto',
    replies: [
      assistant('', [
        {
          id: 'w',
          name: 'write_file',
          args: { file_path: 'note.txt', content: 'body' },
        },
        {
          id: 'm',
          name: 'write_file',
          args: { file_path: 'note.md', content: 'md' },
        },
      ]),
      assistant('first stop'),
      assistant('second stop'),
    ],
  });
  const toolText = result.model.requests[1]!.messages.filter(
    (message) => message.role === 'tool',
  )
    .map((message) => String(message.content))
    .join('\n');
  assert.match(toolText, /formatted the file/);
  assert.match(toolText, /Hook output \(format\)/);
  assert.equal((toolText.match(/formatted the file/g) ?? []).length, 1);
  assert.match(result.model.requests[0]!.system, /hello from hook/);
  assert.match(
    result.model.requests[2]!.messages.map((message) => message.content).join(
      '\n',
    ),
    /A hook blocked the end of this turn: tests failed/,
  );
  assert.equal(readFileSync(count, 'utf8'), '1');
  assert.equal(result.model.requests.length, 3);
  assert.ok(
    result.harness.messages.some((message) => message.hook?.kind === 'limit'),
  );
  assert.ok(
    result.harness.messages.some((message) => message.hook?.kind === 'active'),
  );
});

test('the runtime runs project hooks only after the folder is trusted', async (t) => {
  const dirs = layout(t);
  const script = join(dirs.workspace, 'deny.mjs');
  writeFileSync(
    script,
    `process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'project gate' }));`,
  );
  writeJson(join(dirs.workspace, '.circle', 'hooks.json'), {
    hooks: {
      before_tool: [
        { name: 'project', command: nodeCommand(script), tools: 'write_file' },
      ],
    },
  });
  const settings = defaultSettings();
  settings.trusted_folders = [dirs.workspace];
  const model = new ScriptedModel([
    {
      message: assistant('', [
        {
          id: 'w',
          name: 'write_file',
          args: { file_path: 'a.txt', content: 'x' },
        },
      ]),
    },
    { message: assistant('done') },
  ]);
  const runtime = new AgentRuntime({
    workspace: dirs.workspace,
    home: dirs.home,
    userHome: dirs.userHome,
    settings,
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.setMode('auto');
  assert.equal(
    runtime.hookCatalog.hooks.some(
      (hook: HookDefinition) => hook.name === 'project',
    ),
    true,
  );
  await runtime.harness.run('go');
  let missing = false;
  try {
    readFileSync(join(dirs.workspace, 'a.txt'));
  } catch {
    missing = true;
  }
  assert.equal(missing, true);

  const untrustedSettings = defaultSettings();
  const open = new ScriptedModel([
    {
      message: assistant('', [
        {
          id: 'w',
          name: 'write_file',
          args: { file_path: 'b.txt', content: 'y' },
        },
      ]),
    },
    { message: assistant('done') },
  ]);
  const untrusted = new AgentRuntime({
    workspace: dirs.workspace,
    home: dirs.home,
    userHome: dirs.userHome,
    settings: untrustedSettings,
    model: open,
    headless: true,
  });
  cleanup(t, () => untrusted.close());
  untrusted.setMode('auto');
  assert.equal(untrusted.hookCatalog.projectIgnored, true);
  assert.equal(untrusted.hookCatalog.hooks.length, 0);
  await untrusted.harness.run('go');
  assert.equal(readFileSync(join(dirs.workspace, 'b.txt'), 'utf8'), 'y');
  assert.ok(
    untrusted.harness.messages.some(
      (message) => message.hook?.kind === 'untrusted',
    ),
  );
});
