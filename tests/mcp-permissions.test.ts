import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { criticalPath, criticalRemoval } from '../src/approvals.js';
import type { ApprovalDecision } from '../src/harness.js';
import { mcpToolName } from '../src/mcp_loader.js';
import { AgentRuntime } from '../src/runtime.js';
import {
  defaultSettings,
  loadSettingsFromDict,
  saveSettings,
  trustFolder,
} from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message, ModelResponse, ToolCall } from '../src/types.js';
import { scratch, cleanup } from './helpers.js';
import { mcpStub, type StubOptions, type StubTool } from './mcp-stub.js';

const object = { type: 'object', properties: {} };
const TOOLS: StubTool[] = [
  {
    name: 'list_files',
    inputSchema: object,
    annotations: { readOnlyHint: true },
  },
  { name: 'save_note', inputSchema: object },
  {
    name: 'remove_file',
    inputSchema: object,
    annotations: { destructiveHint: true },
  },
  {
    name: 'grant_access',
    inputSchema: object,
    _meta: { 'circle/requiresUserInteraction': true },
  },
];
const assistant = (
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
const calling = (...tools: string[]): Partial<ModelResponse> =>
  assistant(
    '',
    tools.map((tool) => ({
      id: crypto.randomUUID(),
      name: `mcp__files-server__${tool}`,
      args: {},
    })),
  );

async function setup(
  t: TestContext,
  options: {
    rules?: Record<string, unknown>[];
    headless?: boolean;
    hooks?: unknown;
    stub?: StubOptions;
  } = {},
) {
  const root = realpathSync.native(scratch(t));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  if (options.rules)
    writeFileSync(
      join(home, 'approvals.json'),
      JSON.stringify({ rules: options.rules }),
    );
  const stub = await mcpStub(t, { tools: TOOLS, ...options.stub });
  const settings = trustFolder(defaultSettings(), workspace);
  settings.mcpServers = { 'files-server': { type: 'http', url: stub.url } };
  if (options.hooks) settings.hooks = options.hooks;
  // Hooks are read from the settings in the data folder
  saveSettings(settings, home);
  const replies: Partial<ModelResponse>[] = [];
  const model = new ScriptedModel(replies);
  // The cards the person was shown, and the answers given to them
  const asked: ToolCall[] = [];
  const answers: ApprovalDecision[] = [];
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings,
    model,
    userHome: join(root, 'user'),
    ...(options.headless
      ? { headless: true, integrations: true }
      : {
          approve: async (call: ToolCall) => {
            asked.push(call);
            return answers.shift() ?? 'reject';
          },
        }),
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  assert.equal(runtime.mcp.status[0]?.error, '', runtime.mcp.describe());
  // The tools the server ran, by name
  const ran = () =>
    stub.calls().map((call) => String(call.message?.params?.name));
  const results = () =>
    runtime.harness.messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.content);
  return {
    home,
    workspace,
    stub,
    runtime,
    replies,
    asked,
    answers,
    ran,
    results,
  };
}

test('MCP tools are offered as mcp__<server>__<tool>', async (t) => {
  const { runtime } = await setup(t);
  assert.deepEqual(
    runtime.mcp.tools.map((tool) => tool.name),
    [
      'mcp__files-server__list_files',
      'mcp__files-server__save_note',
      'mcp__files-server__remove_file',
      'mcp__files-server__grant_access',
    ],
  );
  assert.equal(mcpToolName('my.server', 'a tool'), 'mcp__my_server__a_tool');
});

test('what a server says of its tools does not decide: in manual mode a read-only and a destructive tool ask as any other, and the card offers allow for this session', async (t) => {
  const { runtime, replies, asked, answers, ran } = await setup(t);
  replies.push(
    calling('list_files', 'save_note', 'remove_file'),
    assistant('done'),
  );
  answers.push('approve', 'always', 'reject');
  await runtime.harness.run('use the tools');
  assert.deepEqual(
    asked.map((call) => call.name),
    [
      'mcp__files-server__list_files',
      'mcp__files-server__save_note',
      'mcp__files-server__remove_file',
    ],
  );
  assert.deepEqual(ran(), ['list_files', 'save_note']);
  for (const call of asked) {
    const review = runtime.policy.review(call.name, call.args);
    assert.equal(review.verdict, 'ASK');
    assert.equal(review.pattern, '*');
  }
  // The session rule kept from the card covers the tool's next call
  replies.push(calling('save_note'), assistant('done'));
  await runtime.harness.run('again');
  assert.equal(asked.length, 3);
  assert.deepEqual(ran(), ['list_files', 'save_note', 'save_note']);
});

test('an allow rule naming the tool or the whole server runs its calls without a card; an allow glob not anchored to a server allows nothing', async (t) => {
  const one = await setup(t, {
    rules: [{ tool: 'mcp__files-server__list_files', effect: 'allow' }],
  });
  one.replies.push(calling('list_files', 'save_note'), assistant('done'));
  await one.runtime.harness.run('use them');
  assert.deepEqual(
    one.asked.map((call) => call.name),
    ['mcp__files-server__save_note'],
  );
  const all = await setup(t, {
    rules: [
      { tool: 'mcp__files-server__*', pattern: '*', effect: 'allow' },
      { tool: 'mcp__*', effect: 'allow' },
    ],
  });
  all.replies.push(calling('list_files', 'remove_file'), assistant('done'));
  await all.runtime.harness.run('use them');
  assert.equal(all.asked.length, 0);
  assert.deepEqual(all.ran(), ['list_files', 'remove_file']);
  const loose = await setup(t, {
    rules: [{ tool: 'mcp__*', effect: 'allow' }],
  });
  loose.replies.push(calling('list_files'), assistant('done'));
  await loose.runtime.harness.run('use it');
  assert.equal(loose.asked.length, 1);
});

test('a tool its server marks circle/requiresUserInteraction asks in every mode, over an allow rule and a hook allow, offers no session option, and a run that cannot ask does not run it even with --yolo', async (t) => {
  const allowAll = `${JSON.stringify(process.execPath)} -e "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}))"`;
  const { runtime, replies, asked, answers, ran } = await setup(t, {
    rules: [{ tool: 'mcp__files-server__*', effect: 'allow' }],
    hooks: {
      PreToolUse: [
        {
          matcher: 'mcp__files-server__grant_access',
          hooks: [{ type: 'command', command: allowAll }],
        },
      ],
    },
  });
  runtime.policy.setYolo(runtime.session.id, true);
  replies.push(calling('grant_access', 'list_files'), assistant('done'));
  answers.push('approve');
  await runtime.harness.run('grant');
  assert.deepEqual(
    asked.map((call) => call.name),
    ['mcp__files-server__grant_access'],
  );
  assert.deepEqual(ran(), ['grant_access', 'list_files']);
  const review = runtime.policy.review('mcp__files-server__grant_access', {});
  assert.equal(review.verdict, 'ASK_FORCED');
  assert.equal(review.always, true);
  // Allowing it for the session keeps no rule: the next call asks again
  replies.push(calling('grant_access'), assistant('done'));
  answers.push('always');
  await runtime.harness.run('grant again');
  replies.push(calling('grant_access'), assistant('done'));
  await runtime.harness.run('and again');
  assert.equal(asked.length, 3);
  // Print, line and RPC mode: not run, also with --yolo
  const headless = await setup(t, { headless: true });
  headless.runtime.policy.setYolo(headless.runtime.session.id, true);
  headless.replies.push(
    calling('grant_access', 'save_note'),
    assistant('done'),
  );
  await headless.runtime.harness.run('grant');
  assert.deepEqual(headless.ran(), ['save_note']);
  assert.match(headless.results()[0]!, /not run: this operation always asks/);
});

test('an ask rule asks in auto mode and over an allow rule, a deny rule refuses in auto mode, and a run that cannot ask does not run what an ask rule names', async (t) => {
  const rules = [
    { tool: 'mcp__files-server__*', effect: 'allow' },
    { tool: 'mcp__files-server__save_note', effect: 'ask' },
    { tool: 'mcp__files-server__remove_file', effect: 'deny' },
  ];
  const { runtime, replies, asked, answers, ran, results } = await setup(t, {
    rules,
  });
  runtime.policy.setYolo(runtime.session.id, true);
  replies.push(
    calling('save_note', 'remove_file', 'list_files'),
    assistant('done'),
  );
  answers.push('approve');
  await runtime.harness.run('use them');
  assert.deepEqual(
    asked.map((call) => call.name),
    ['mcp__files-server__save_note'],
  );
  assert.deepEqual(ran(), ['save_note', 'list_files']);
  assert.match(results()[1]!, /remove_file "\*" is denied/);
  assert.match(
    runtime.policy.review('mcp__files-server__save_note', {}).reason,
    /asked by your approvals\.json: mcp__files-server__save_note "\*" always asks/,
  );
  const headless = await setup(t, { rules, headless: true });
  headless.runtime.policy.setYolo(headless.runtime.session.id, true);
  headless.replies.push(calling('save_note', 'list_files'), assistant('done'));
  await headless.runtime.harness.run('use them');
  assert.deepEqual(headless.ran(), ['list_files']);
});

test('plan mode asks before an MCP tool runs, also over auto, and an allow rule runs it there', async (t) => {
  const { runtime, replies, asked, ran } = await setup(t, {
    rules: [{ tool: 'mcp__files-server__list_files', effect: 'allow' }],
  });
  runtime.policy.setYolo(runtime.session.id, true);
  runtime.harness.planMode = true;
  replies.push(calling('save_note', 'list_files'), assistant('done'));
  await runtime.harness.run('look around');
  assert.deepEqual(
    asked.map((call) => call.name),
    ['mcp__files-server__save_note'],
  );
  assert.deepEqual(ran(), ['list_files']);
});

test('the calls of a reply to tools their server marks read-only run side by side', async (t) => {
  let running = 0;
  let most = 0;
  let release!: () => void;
  const both = new Promise<void>((resolve) => (release = resolve));
  const { runtime, replies, ran } = await setup(t, {
    rules: [{ tool: 'mcp__files-server__*', effect: 'allow' }],
    stub: {
      call: async () => {
        running++;
        most = Math.max(most, running);
        if (running === 2) release();
        // Called one after the other, the first would wait here alone: it gives up after a while, and `most` says so
        await Promise.race([both, delay(10_000)]);
        running--;
        return { content: [{ type: 'text', text: 'listed' }] };
      },
    },
  });
  replies.push(calling('list_files', 'list_files'), assistant('done'));
  await runtime.harness.run('list twice');
  assert.deepEqual(ran(), ['list_files', 'list_files']);
  assert.equal(most, 2);
});

test('deleting the root, your home or the workspace is a critical path; a delete under the workspace is not', () => {
  const workspace = '/work/project';
  const home = '/users/me';
  for (const command of [
    'rm -rf /',
    'rm -rf /usr',
    'rm -rf ~',
    'rm -rf ~/',
    'rm -rf $HOME',
    'rm -rf .',
    'rm -rf ..',
    'rm -rf *',
    'rm -rf ./*',
    'rm -rf /work/project',
    'rm -rf /work',
    'rm -rf "$DIR"/*',
    'rm -rf $(pwd)',
    'sudo true; bash -c "rm -rf ~"',
    'echo $(rm -rf /)',
  ])
    assert.ok(
      criticalRemoval(command, workspace, home, 'linux') !== undefined,
      command,
    );
  for (const command of [
    'rm -rf node_modules',
    'rm -rf ./build/*',
    'rm notes.txt',
    'rm -rf /work/project/dist',
    'ls /',
  ])
    assert.equal(
      criticalRemoval(command, workspace, home, 'linux'),
      undefined,
      command,
    );
  assert.equal(criticalPath('/users/me', workspace, home), true);
  assert.equal(criticalPath('src', workspace, home), false);
});

test('a delete of the workspace asks in auto mode and over allowed_commands, and a run that cannot ask does not run it', async (t) => {
  const { runtime, workspace, replies, asked } = await setup(t);
  runtime.policy.setYolo(runtime.session.id, true);
  runtime.policy.setAllowedCommands(['rm *']);
  const command = `rm -rf ${JSON.stringify(workspace)}`;
  replies.push(
    assistant('', [{ id: 'gone', name: 'execute', args: { command } }]),
    assistant('done'),
  );
  await runtime.harness.run('clean up');
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.name, 'execute');
  assert.ok(existsSync(workspace));
  const headless = await setup(t, { headless: true });
  headless.runtime.policy.setYolo(headless.runtime.session.id, true);
  headless.replies.push(
    assistant('', [
      {
        id: 'gone',
        name: 'execute',
        args: { command: `rm -rf ${JSON.stringify(headless.workspace)}` },
      },
    ]),
    assistant('done'),
  );
  await headless.runtime.harness.run('clean up');
  assert.ok(existsSync(headless.workspace));
  assert.match(headless.results()[0]!, /not run/);
});

test('rules written with the MCP tool names before mcp__ are rewritten once, a copy kept, and allow the same calls', async (t) => {
  const rules = [
    {
      tool: 'files-server_list_files',
      pattern: '*',
      effect: 'allow',
      label: 'kept',
    },
    { tool: 'execute', pattern: 'ls *', effect: 'allow', label: 'ls' },
  ];
  const { home, runtime, replies, asked, ran } = await setup(t, { rules });
  const saved = JSON.parse(readFileSync(join(home, 'approvals.json'), 'utf8'));
  assert.deepEqual(
    saved.rules.map((rule: { tool: string }) => rule.tool),
    ['mcp__files-server__list_files', 'execute'],
  );
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(home, 'approvals.json.mcp-names.migrated'), 'utf8'),
    ).rules,
    rules,
  );
  assert.match(runtime.mcp.describe(), /1 rule now name MCP tools as mcp__/);
  replies.push(calling('list_files'), assistant('done'));
  await runtime.harness.run('list');
  assert.equal(asked.length, 0);
  assert.deepEqual(ran(), ['list_files']);
});

test('default_mode takes the documented names of the modes', () => {
  assert.equal(
    loadSettingsFromDict({ default_mode: 'bypassPermissions' }).default_mode,
    'auto',
  );
  assert.equal(
    loadSettingsFromDict({ default_mode: 'acceptEdits' }).default_mode,
    'accept-edits',
  );
  assert.equal(
    loadSettingsFromDict({ default_mode: 'default' }).default_mode,
    'manual',
  );
  assert.equal(
    loadSettingsFromDict({ default_mode: 'plan' }).default_mode,
    'plan',
  );
});
