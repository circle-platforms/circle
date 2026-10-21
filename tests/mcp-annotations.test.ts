import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMcpConnections } from '../src/mcp_loader.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { approvalRequest } from '../src/tui/approval_preview.js';
import type { ApprovalDecision } from '../src/harness.js';
import type { Message, ModelResponse, ToolCall } from '../src/types.js';
import { scratch, cleanup } from './helpers.js';
import { mcpStub, type StubTool } from './mcp-stub.js';

const object = { type: 'object', properties: {} };
const TOOLS: StubTool[] = [
  {
    name: 'list_files',
    description: 'List the files.',
    inputSchema: object,
    annotations: { readOnlyHint: true },
  },
  { name: 'save_note', description: 'Save a note.', inputSchema: object },
  {
    name: 'remove_file',
    description: 'Remove a file.',
    inputSchema: object,
    annotations: { destructiveHint: true },
  },
  {
    name: 'odd',
    description: 'Says it is both.',
    inputSchema: object,
    annotations: { readOnlyHint: true, destructiveHint: true },
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
      name: `files-server_${tool}`,
      args: {},
    })),
  );

async function setup(
  t: TestContext,
  trust?: unknown,
  options: { hooks?: unknown; headless?: boolean } = {},
) {
  const root = scratch(t);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  if (options.hooks) {
    mkdirSync(join(root, 'home'));
    writeFileSync(
      join(root, 'home', 'hooks.json'),
      JSON.stringify(options.hooks),
    );
  }
  const stub = await mcpStub(t, { tools: TOOLS });
  const settings = defaultSettings();
  settings.mcp_servers = [
    {
      name: 'files-server',
      url: stub.url,
      transport: 'streamable_http',
      ...(trust === undefined ? {} : { trust_annotations: trust }),
    },
  ];
  const replies: Partial<ModelResponse>[] = [];
  const model = new ScriptedModel(replies);
  // The cards the person was shown, and the answers given to them
  const asked: ToolCall[] = [];
  const answers: ApprovalDecision[] = [];
  const runtime = new AgentRuntime({
    home: join(root, 'home'),
    workspace,
    settings,
    model,
    userHome: join(root, 'user'),
    // Print, line and RPC mode: no card can be shown, and servers load with --extensions
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
  return { runtime, replies, asked, answers, ran, results };
}

test('trust_annotations trusts a server only when it is left out or true', () => {
  const { connections } = buildMcpConnections(
    [undefined, true, false, 'false', 0].map((trust, index) => ({
      name: `s${index}`,
      url: 'http://127.0.0.1:1/mcp',
      ...(trust === undefined ? {} : { trust_annotations: trust }),
    })),
  );
  assert.deepEqual(
    connections.map((connection) => connection.trustAnnotations !== false),
    [true, true, false, false, false],
  );
});

test('a tool its server marks read-only runs without a card and in plan mode; one without annotations asks and is refused there', async (t) => {
  const { runtime, replies, asked, answers, ran, results } = await setup(t);
  const tools = Object.fromEntries(
    runtime.mcp.tools.map((tool) => [tool.name, tool.effect]),
  );
  assert.deepEqual(tools, {
    'files-server_list_files': 'read',
    'files-server_save_note': 'unknown',
    'files-server_remove_file': 'unknown',
    'files-server_odd': 'unknown',
  });
  replies.push(calling('list_files'), assistant('listed'));
  await runtime.harness.run('list');
  assert.equal(asked.length, 0);
  assert.deepEqual(ran(), ['list_files']);
  // Plan mode keeps reads and refuses the rest before anything reaches the server
  runtime.harness.planMode = true;
  replies.push(calling('list_files', 'save_note', 'odd'), assistant('planned'));
  await runtime.harness.run('plan');
  assert.equal(asked.length, 0);
  assert.deepEqual(ran(), ['list_files', 'list_files']);
  assert.equal(
    results().filter((text) => /read-only mode/.test(text)).length,
    2,
  );
  // Out of plan mode a tool with no annotations asks, as before, and a session rule covers it
  runtime.harness.planMode = false;
  answers.push('always');
  replies.push(calling('save_note'), calling('save_note'), assistant('saved'));
  await runtime.harness.run('save twice');
  assert.deepEqual(
    asked.map((call) => call.name),
    ['files-server_save_note'],
  );
  assert.deepEqual(ran(), [
    'list_files',
    'list_files',
    'save_note',
    'save_note',
  ]);
});

test('a tool its server marks destructive asks on every call, with no session option, whatever rule was kept for it', async (t) => {
  const { runtime, replies, asked, answers, ran } = await setup(t);
  const tool = 'files-server_remove_file';
  const review = runtime.policy.review(tool, {});
  // As Circle's own deletes: always asks, and the reason is the same words for every tool,
  // which the card heads with the tool's name
  assert.equal(review.verdict, 'ASK_FORCED');
  assert.equal(review.pattern, '');
  assert.equal(review.warn_delete, true);
  assert.equal(
    review.reason,
    'its MCP server says it can delete or overwrite data',
  );
  assert.equal(
    runtime.policy.review('files-server_save_note', {}).reason,
    'can change state',
  );
  // The terminal card offers no "for this session", and warns
  const card = approvalRequest(
    { id: 'c', name: tool, args: {} },
    runtime.policy.review(tool, {}),
  );
  assert.equal(card.scope, '');
  assert.equal(card.warnDelete, true);
  // A rule kept from before the server said so covers nothing
  runtime.policy.store.record(
    runtime.session.id,
    'always',
    tool,
    '*',
    `every ${tool} call`,
  );
  answers.push('approve', 'approve', 'approve');
  replies.push(
    calling('remove_file'),
    calling('remove_file'),
    calling('odd'),
    assistant('removed'),
  );
  await runtime.harness.run('remove');
  assert.deepEqual(
    asked.map((call) => call.name),
    [tool, tool, 'files-server_odd'],
  );
  assert.deepEqual(ran(), ['remove_file', 'remove_file', 'odd']);
  // A choice the card does not offer keeps nothing and runs nothing
  answers.push('always');
  replies.push(calling('remove_file'), assistant('stopped'));
  await runtime.harness.run('remove again');
  assert.equal(asked.length, 4);
  assert.deepEqual(ran(), ['remove_file', 'remove_file', 'odd']);
  // In auto mode it runs without a card, as every call does there
  runtime.policy.setYolo(runtime.session.id, true);
  replies.push(calling('remove_file'), assistant('removed in auto'));
  await runtime.harness.run('remove in auto');
  assert.equal(asked.length, 4);
  assert.deepEqual(ran(), ['remove_file', 'remove_file', 'odd', 'remove_file']);
});

test('trust_annotations false brings back unknown tools for that server', async (t) => {
  const { runtime, replies, asked, answers, ran, results } = await setup(
    t,
    false,
  );
  assert.ok(runtime.mcp.tools.every((tool) => tool.effect === 'unknown'));
  assert.equal(
    runtime.policy.review('files-server_remove_file', {}).pattern,
    '*',
  );
  runtime.harness.planMode = true;
  replies.push(calling('list_files'), assistant('planned'));
  await runtime.harness.run('plan');
  assert.deepEqual(ran(), []);
  assert.match(results().at(-1)!, /read-only mode/);
  runtime.harness.planMode = false;
  answers.push('approve');
  replies.push(calling('list_files'), assistant('listed'));
  await runtime.harness.run('list');
  assert.deepEqual(
    asked.map((call) => call.name),
    ['files-server_list_files'],
  );
  assert.deepEqual(ran(), ['list_files']);
});

test("a hook's allow does not skip a destructive tool's card, and print mode does not run one even with --yolo, as Circle's own deletes", async (t) => {
  const root = scratch(t);
  const script = join(root, 'allow.mjs');
  writeFileSync(
    script,
    "process.stdout.write(JSON.stringify({ decision: 'allow', reason: 'go' }));\n",
  );
  const hooks = {
    hooks: {
      before_tool: [
        {
          name: 'allow all',
          command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
        },
      ],
    },
  };
  const allowed = await setup(t, undefined, { hooks });
  allowed.answers.push('approve');
  allowed.replies.push(calling('save_note', 'remove_file'), assistant('done'));
  await allowed.runtime.harness.run('save and remove');
  // The hook's allow skips the ordinary card; the destructive one is still asked
  assert.deepEqual(
    allowed.asked.map((call) => call.name),
    ['files-server_remove_file'],
  );
  assert.deepEqual(allowed.ran(), ['save_note', 'remove_file']);
  assert.match(allowed.results()[0]!, /^Hook allowed this call\./);
  const headless = await setup(t, undefined, { headless: true });
  headless.runtime.policy.setYolo(headless.runtime.session.id, true);
  headless.replies.push(calling('save_note', 'remove_file'), assistant('done'));
  await headless.runtime.harness.run('save and remove');
  assert.deepEqual(headless.ran(), ['save_note']);
  assert.match(headless.results()[1]!, /not run: this operation always asks/);
});
