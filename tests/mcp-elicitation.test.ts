import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { McpManager } from '../src/mcp_loader.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message, ModelResponse } from '../src/types.js';
import { cleanup, scratch, until } from './helpers.js';
import { mcpStub, type McpStub } from './mcp-stub.js';

// A server's question in the middle of a call (`elicitation/create`, form mode, #556)
const form = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name', minLength: 2 },
    count: { type: 'integer', title: 'How many', minimum: 1 },
    tier: {
      type: 'string',
      title: 'Tier',
      oneOf: [
        { const: 'gold', title: 'Gold' },
        { const: 'basic', title: 'Basic' },
      ],
    },
    gift: { type: 'boolean', title: 'Gift wrap', default: false },
    tags: {
      type: 'array',
      title: 'Tags',
      items: { type: 'string', enum: ['red', 'blue'] },
    },
  },
  required: ['name', 'count', 'tier'],
};
async function shop(
  t: Parameters<typeof scratch>[0],
  params: Record<string, unknown> = {
    message: 'Confirm the order',
    requestedSchema: form,
  },
): Promise<McpStub> {
  return mcpStub(t, {
    tools: [{ name: 'order', inputSchema: { type: 'object', properties: {} } }],
    serverRequest: () => ({ method: 'elicitation/create', params }),
  });
}
async function ordered(
  t: Parameters<typeof scratch>[0],
  stub: McpStub,
  ask?: (args: Record<string, unknown>) => Promise<string>,
): Promise<unknown> {
  const manager = new McpManager(scratch(t), undefined, undefined, {
    ...(ask ? { ask } : {}),
  });
  cleanup(t, () => manager.close());
  await manager.load([
    { name: 'shop', url: stub.url, transport: 'streamable_http' },
  ]);
  const text = String(
    await manager.tools[0]!.run(
      {},
      { sessionId: 'one', signal: new AbortController().signal },
    ),
  );
  return JSON.parse(/asked: (.*)$/m.exec(text)![1]!);
}

test('a form is asked field by field; answers that do not fit are asked again, and the server gets the answers as it asked', async (t) => {
  const stub = await shop(t);
  const asked: Record<string, any>[] = [];
  const replies = [
    ['A', 'two', 'Gold', '', ['red'], 'send'],
    ['Ada', '3', 'Gold', '', ['red', 'blue'], 'send'],
  ];
  const reply = await ordered(t, stub, async (args) => {
    asked.push(args);
    return JSON.stringify(replies.shift());
  });
  assert.deepEqual(reply, {
    jsonrpc: '2.0',
    id: 'server-1',
    result: {
      action: 'accept',
      content: {
        name: 'Ada',
        count: 3,
        tier: 'gold',
        gift: false,
        tags: ['red', 'blue'],
      },
    },
  });
  // The client said it takes forms, and only forms
  const start = stub.requests.find(
    (request) => request.message?.method === 'initialize',
  )!;
  assert.deepEqual(start.message!.params!.capabilities.elicitation, {
    form: {},
  });
  // Each round is one panel: the server's message, a question for each field, then whether to send
  assert.equal(asked.length, 2);
  const [first, second] = asked.map((args) => args.questions as any[]);
  assert.equal(first!.length, 6);
  assert.ok(first!.every((question) => question.header === 'shop'));
  assert.match(first![0].question, /^shop asks: Confirm the order\n\nName$/);
  assert.equal(first![1].question, 'How many');
  assert.deepEqual(
    first![2].options.map((option: { label: string }) => option.label),
    ['Gold', 'Basic'],
  );
  assert.equal(first![3].question, 'Gift wrap (optional)\nempty: false');
  assert.equal(first![4].multiple, true);
  assert.deepEqual(
    first![5].options.map((option: { label: string }) => option.label),
    ['send', 'decline'],
  );
  assert.match(
    second![0].question,
    /^Not sent: Name has at least 2 characters; How many is a number\n\nshop asks: Confirm the order/,
  );
});

test('a server is told when the person declines or closes the panel', async (t) => {
  const answer = (decision: string) => async () =>
    JSON.stringify(['Ada', '3', 'Gold', '', [], decision]);
  assert.deepEqual(
    ((await ordered(t, await shop(t), answer('decline'))) as any).result,
    { action: 'decline' },
  );
  assert.deepEqual(
    ((await ordered(t, await shop(t), async () => '')) as any).result,
    { action: 'cancel' },
  );
});

test('where no one can be asked the client does not take forms, and a server that asks anyway is told so', async (t) => {
  const stub = await shop(t);
  const reply = (await ordered(t, stub)) as any;
  assert.equal(reply.error.code, -32601);
  const start = stub.requests.find(
    (request) => request.message?.method === 'initialize',
  )!;
  assert.equal(start.message!.params!.capabilities.elicitation, undefined);
});

test('esc on the call closes the panel of a question the server sent on a stream of its own', async (t) => {
  const stub = await mcpStub(t, {
    tools: [{ name: 'order', inputSchema: { type: 'object', properties: {} } }],
    listChanged: true,
    serverRequestOnStream: true,
    serverRequest: () => ({
      method: 'elicitation/create',
      params: {
        message: 'Confirm',
        requestedSchema: { type: 'object', properties: {} },
      },
    }),
  });
  let panel: AbortSignal | undefined;
  const manager = new McpManager(scratch(t), undefined, undefined, {
    // The panel stays up until it is closed
    ask: (_args, signal) => {
      panel = signal;
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve(''), { once: true }),
      );
    },
  });
  cleanup(t, () => manager.close());
  await manager.load([
    { name: 'shop', url: stub.url, transport: 'streamable_http' },
  ]);
  const controller = new AbortController();
  const running = manager.tools[0]!.run(
    {},
    { sessionId: 'one', signal: controller.signal },
  );
  await until(() => panel !== undefined, { timeout: 10_000 });
  controller.abort(new Error('esc'));
  await assert.rejects(running);
  await until(() => panel!.aborted, { timeout: 10_000 });
});

test('a request to open a page is refused: the client takes forms only', async (t) => {
  let asked = false;
  const stub = await shop(t, {
    mode: 'url',
    message: 'Sign the contract',
    url: 'https://shop.example/sign',
    elicitationId: 'e-1',
  });
  const reply = (await ordered(t, stub, async () => {
    asked = true;
    return '';
  })) as any;
  assert.equal(reply.error.code, -32602);
  assert.equal(asked, false);
});

test("in a conversation the server's question goes to the question panel, and its answer back to the server", async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  const stub = await shop(t, {
    message: 'Ship it now?',
    requestedSchema: { type: 'object', properties: {} },
  });
  const settings = defaultSettings();
  settings.mcp_servers = [
    { name: 'shop', url: stub.url, transport: 'streamable_http' },
  ];
  const reply = (calls: Message['tool_calls'] = [], text = '') =>
    ({
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: text,
        tool_calls: calls,
      },
    }) as Partial<ModelResponse>;
  const asked: Record<string, any>[] = [];
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(root, 'user'),
    settings,
    model: new ScriptedModel([
      reply([{ id: 'call-1', name: 'shop_order', args: {} }]),
      reply([], 'done'),
    ]),
    question: async (args) => {
      asked.push(args);
      return JSON.stringify(['accept']);
    },
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('ship it');
  assert.deepEqual(
    asked.map((args) => args.questions.map((q: any) => q.question)),
    [['shop asks: Ship it now?']],
  );
  const result = runtime.harness.messages.find(
    (message) => message.tool_call_id === 'call-1',
  )!;
  assert.match(result.content, /"action":"accept","content":\{\}/);
});
