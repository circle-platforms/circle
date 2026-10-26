import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApprovalDecision } from '../src/harness.js';
import { AgentRuntime } from '../src/runtime.js';
import { saveSecret } from '../src/secrets.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { approvalRequest } from '../src/tui/approval_preview.js';
import type { Message, ModelResponse, ToolCall } from '../src/types.js';
import { scratch, cleanup } from './helpers.js';
import { mcpStub, type StubTool } from './mcp-stub.js';

const TOKEN = 'token-value-6e2b91';
// Tools their server says only read: one takes a file in a parameter that is not named
// like a path, one takes text
const TOOLS: StubTool[] = [
  {
    name: 'read_document',
    inputSchema: {
      type: 'object',
      properties: {
        document: { type: 'string', contentEncoding: 'base64' },
        question: { type: 'string' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'lookup',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    annotations: { readOnlyHint: true },
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

async function setup(t: TestContext, hooks?: unknown) {
  const root = realpathSync.native(scratch(t));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  saveSecret(home, 'FILES_TOKEN', TOKEN);
  if (hooks) writeFileSync(join(home, 'hooks.json'), JSON.stringify(hooks));
  writeFileSync(join(workspace, 'notes.txt'), 'meeting notes');
  writeFileSync(join(workspace, 'secret-notes.txt'), 'the launch code is 0000');
  const stub = await mcpStub(t, { tools: TOOLS });
  const settings = defaultSettings();
  settings.mcp_servers = [
    { name: 'files-server', url: stub.url, transport: 'streamable_http' },
  ];
  const replies: Partial<ModelResponse>[] = [];
  const asked: ToolCall[] = [];
  const answers: ApprovalDecision[] = [];
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings,
    model: new ScriptedModel(replies),
    userHome: join(root, 'user'),
    approve: async (call) => {
      asked.push(structuredClone(call));
      return answers.shift() ?? 'reject';
    },
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  assert.equal(runtime.mcp.status[0]?.error, '', runtime.mcp.describe());
  let count = 0;
  // One call, and what the model read of it
  const call = async (tool: string, args: Record<string, unknown>) => {
    const id = `call-${++count}`;
    replies.push(
      assistant('', [{ id, name: `files-server_${tool}`, args }]),
      assistant('done'),
    );
    await runtime.harness.run(`call ${tool}`);
    return runtime.harness.messages.find(
      (message) => message.tool_call_id === id,
    )!;
  };
  // What reached the server, as it arrived
  const received = () =>
    stub.calls().map((request) => request.message?.params?.arguments);
  return { root, workspace, stub, runtime, asked, answers, call, received };
}

test('a tool its server marks read-only asks before a call sends a local file or a secret, and runs without a card otherwise', async (t) => {
  const { runtime, asked, answers, call, received } = await setup(t);
  // Neither a file nor a secret: no card, as before
  assert.match(
    (await call('read_document', { question: 'any?' })).content,
    /ran read_document/,
  );
  assert.match((await call('lookup', { q: 'plain' })).content, /ran lookup/);
  assert.equal(asked.length, 0);
  // A file: the card, and nothing is sent when the person says no
  const refused = await call('read_document', { document: 'notes.txt' });
  assert.match(refused.content, /rejected/);
  assert.equal(asked.length, 1);
  assert.match(String(asked[0]!.args.document), /^notes\.txt \(13 bytes/);
  const card = approvalRequest(
    asked[0]!,
    runtime.policy.review(asked[0]!.name, asked[0]!.args),
  );
  assert.equal(
    card.policy,
    'its MCP server says it only reads; the call sends it a local file or a secret',
  );
  // A secret's value: the card shows its name, and the value goes only once allowed
  answers.push('approve');
  assert.match(
    (await call('lookup', { q: 'key %FILES_TOKEN%' })).content,
    /ran lookup/,
  );
  assert.equal(asked.length, 2);
  assert.equal(asked[1]!.args.q, 'key %FILES_TOKEN%');
  assert.deepEqual(received(), [
    { question: 'any?' },
    { q: 'plain' },
    { q: `key ${TOKEN}` },
  ]);
  // "Allow for this session" covers the tool's later calls that send
  answers.push('always');
  await call('read_document', { document: 'notes.txt' });
  await call('read_document', { document: 'notes.txt', question: 'again' });
  assert.equal(asked.length, 3);
  assert.equal(received().length, 5);
});

test('read-only mode refuses a call of a read-only tool that sends a local file or a secret, before anything is read or sent', async (t) => {
  const { runtime, asked, call, received } = await setup(t);
  runtime.harness.planMode = true;
  for (const [tool, args] of [
    ['read_document', { document: 'notes.txt' }],
    ['lookup', { q: '%FILES_TOKEN%' }],
  ] as const) {
    const result = await call(tool, args);
    assert.equal(result.status, 'error');
    assert.match(result.content, /read-only mode: this tool cannot run/);
  }
  // A call that sends neither still runs there
  assert.match((await call('lookup', { q: 'plain' })).content, /ran lookup/);
  assert.equal(asked.length, 0);
  assert.deepEqual(received(), [{ q: 'plain' }]);
});

test("hook path globs see the path an MCP tool's file parameter names, whatever the parameter is called", async (t) => {
  const root = realpathSync.native(scratch(t));
  const script = join(root, 'deny.mjs');
  writeFileSync(
    script,
    "process.stderr.write('names a secret file');\nprocess.exit(2);\n",
  );
  const { asked, call, received } = await setup(t, {
    hooks: {
      before_tool: [
        {
          name: 'no secrets',
          command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
          tools: '*',
          paths: ['**/*secret*'],
        },
      ],
    },
  });
  const denied = await call('read_document', { document: 'secret-notes.txt' });
  assert.equal(denied.status, 'error');
  assert.match(denied.content, /^Hook denied this call: names a secret file/);
  // A file the globs do not match goes on to its card
  await call('read_document', { document: 'notes.txt' });
  assert.equal(asked.length, 1);
  assert.deepEqual(received(), []);
});
