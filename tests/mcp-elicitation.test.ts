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
import { McpManager } from '../src/mcp_loader.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings, saveSettings, trustFolder } from '../src/settings.js';
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
  await manager.load({ shop: { url: stub.url, type: 'http' } });
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
  // The client said it takes forms and pages to open
  const start = stub.requests.find(
    (request) => request.message?.method === 'initialize',
  )!;
  assert.deepEqual(start.message!.params!.capabilities.elicitation, {
    form: {},
    url: {},
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

test('where no one can be asked a question is cancelled, a form or a page alike', async (t) => {
  const form = await shop(t);
  assert.deepEqual(((await ordered(t, form)) as any).result, {
    action: 'cancel',
  });
  const page = await shop(t, {
    mode: 'url',
    message: 'Sign the contract',
    url: 'https://shop.example/sign',
    elicitationId: 'e-1',
  });
  assert.deepEqual(((await ordered(t, page)) as any).result, {
    action: 'cancel',
  });
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
  await manager.load({ shop: { url: stub.url, type: 'http' } });
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

test('a page a server asks to open is asked about first, and opened only when the person says so', async (t) => {
  const page = {
    mode: 'url',
    message: 'Sign the contract',
    url: 'https://shop.example/sign',
    elicitationId: 'e-1',
  };
  for (const [answer, action, opened] of [
    [['open'], 'accept', ['https://shop.example/sign']],
    [['decline'], 'decline', []],
    [null, 'cancel', []],
  ] as const) {
    const stub = await shop(t, page);
    const asked: Record<string, any>[] = [];
    const opens: string[] = [];
    const manager = new McpManager(scratch(t), undefined, undefined, {
      ask: async (args) => {
        asked.push(args);
        return JSON.stringify(answer);
      },
      openUrl: async (url) => {
        opens.push(url);
      },
    });
    cleanup(t, () => manager.close());
    await manager.load({ shop: { url: stub.url, type: 'http' } });
    const text = String(
      await manager.tools[0]!.run(
        {},
        { sessionId: 'one', signal: new AbortController().signal },
      ),
    );
    assert.deepEqual(JSON.parse(/asked: (.*)$/m.exec(text)![1]!).result, {
      action,
    });
    assert.deepEqual(opens, opened);
    assert.match(
      asked[0]!.questions[0].question,
      /^shop asks you to open a page: Sign the contract\nhttps:\/\/shop\.example\/sign\nOpen it in the browser\?$/,
    );
  }
  // An address that is not a web page is declined without asking
  const local = await shop(t, { ...page, url: 'file:///etc/passwd' });
  let asked = false;
  const reply = (await ordered(t, local, async () => {
    asked = true;
    return JSON.stringify(['open']);
  })) as any;
  assert.deepEqual(reply.result, { action: 'decline' });
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
  settings.mcpServers = { shop: { url: stub.url, type: 'http' } };
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
      reply([{ id: 'call-1', name: 'mcp__shop__order', args: {} }]),
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

/** A conversation whose model calls the shop's tool once, with hooks in the settings of a trusted folder. */
async function conversation(
  t: Parameters<typeof scratch>[0],
  stub: McpStub,
  hooks: Record<string, unknown>,
  answer = JSON.stringify(['Ada', '3', 'Gold', '', [], 'send']),
) {
  const root = realpathSync.native(scratch(t));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  const settings = trustFolder(defaultSettings(), workspace);
  settings.mcpServers = { shop: { url: stub.url, type: 'http' } };
  settings.hooks = hooks;
  saveSettings(settings, home);
  const asked: Record<string, any>[] = [];
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(root, 'user'),
    settings,
    model: new ScriptedModel([
      {
        message: {
          id: 'call',
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call-1', name: 'mcp__shop__order', args: {} }],
        },
      },
      { message: { id: 'done', role: 'assistant', content: 'done' } },
    ]),
    question: async (args) => {
      asked.push(args);
      return answer;
    },
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('order');
  const text = runtime.harness.messages.find(
    (message) => message.tool_call_id === 'call-1',
  )!.content;
  return {
    root,
    asked,
    got: JSON.parse(/asked: (.*)$/m.exec(text)![1]!).result,
  };
}
/** A hook that keeps its input in `file` and prints `output`, or exits with `exit`. */
function hookScript(
  root: string,
  name: string,
  output: unknown,
  exit = 0,
): { type: string; command: string; args: string[] } {
  const script = join(root, `${name}.mjs`);
  const print =
    output === undefined
      ? ''
      : `process.stdout.write(${JSON.stringify(JSON.stringify(output))});`;
  writeFileSync(
    script,
    [
      "import fs from 'node:fs';",
      "let input = '';",
      'process.stdin.on("data", (chunk) => (input += chunk));',
      'process.stdin.on("end", () => {',
      `  fs.writeFileSync(${JSON.stringify(join(root, `${name}.json`))}, input);`,
      `  ${print}`,
      `  process.exit(${exit});`,
      '});',
    ].join('\n'),
  );
  return { type: 'command', command: process.execPath, args: [script] };
}

test("an Elicitation hook answers a form in the person's place, told the server, the message and the form", async (t) => {
  const stub = await shop(t);
  const root = realpathSync.native(scratch(t));
  const { asked, got } = await conversation(t, stub, {
    Elicitation: [
      {
        matcher: 'shop',
        hooks: [
          hookScript(root, 'answer', {
            hookSpecificOutput: {
              hookEventName: 'Elicitation',
              action: 'accept',
              content: { name: 'Hook', count: 2, tier: 'basic' },
            },
          }),
        ],
      },
    ],
  });
  assert.deepEqual(got, {
    action: 'accept',
    content: { name: 'Hook', count: 2, tier: 'basic' },
  });
  assert.equal(asked.length, 0);
  const input = JSON.parse(readFileSync(join(root, 'answer.json'), 'utf8'));
  assert.equal(input.hook_event_name, 'Elicitation');
  assert.equal(input.mcp_server_name, 'shop');
  assert.equal(input.message, 'Confirm the order');
  assert.equal(input.mode, 'form');
  assert.deepEqual(input.requested_schema, form);
});

test('an Elicitation hook that exits 2 declines without asking, and one for another server does not run', async (t) => {
  const stub = await shop(t);
  const root = realpathSync.native(scratch(t));
  const { asked, got } = await conversation(t, stub, {
    Elicitation: [
      { matcher: 'shop', hooks: [hookScript(root, 'refuse', undefined, 2)] },
      {
        matcher: 'other',
        hooks: [
          hookScript(root, 'elsewhere', {
            hookSpecificOutput: {
              hookEventName: 'Elicitation',
              action: 'accept',
              content: {},
            },
          }),
        ],
      },
    ],
  });
  assert.deepEqual(got, { action: 'decline' });
  assert.equal(asked.length, 0);
  assert.ok(!existsSync(join(root, 'elsewhere.json')));
});

test("an ElicitationResult hook sees the person's answer and can change it or block it before the server gets it", async (t) => {
  const root = realpathSync.native(scratch(t));
  const changed = await conversation(t, await shop(t), {
    ElicitationResult: [
      {
        hooks: [
          hookScript(root, 'change', {
            hookSpecificOutput: {
              hookEventName: 'ElicitationResult',
              action: 'accept',
              content: { name: 'Ada Lovelace', count: 3, tier: 'gold' },
            },
          }),
        ],
      },
    ],
  });
  assert.equal(changed.asked.length, 1);
  assert.deepEqual(changed.got, {
    action: 'accept',
    content: { name: 'Ada Lovelace', count: 3, tier: 'gold' },
  });
  const input = JSON.parse(readFileSync(join(root, 'change.json'), 'utf8'));
  assert.equal(input.hook_event_name, 'ElicitationResult');
  assert.equal(input.action, 'accept');
  assert.equal(input.mode, 'form');
  assert.deepEqual(input.content, {
    name: 'Ada',
    count: 3,
    tier: 'gold',
    gift: false,
  });
  const blocked = await conversation(t, await shop(t), {
    ElicitationResult: [
      {
        hooks: [hookScript(root, 'block', { decision: 'block', reason: 'no' })],
      },
    ],
  });
  assert.deepEqual(blocked.got, { action: 'decline' });
});
