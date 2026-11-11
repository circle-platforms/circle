import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { join } from 'node:path';
import { GatewayModel } from '../src/model.js';
import { Harness } from '../src/harness.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { ApprovalPolicy, ApprovalStore } from '../src/approvals.js';
import {
  defaultSettings,
  loadSettingsFromDict,
  saveCredentials,
  type CircleSettings,
} from '../src/settings.js';
import type { Message, ModelNotice, ModelRequest, Tool } from '../src/types.js';
import { cleanup, cleanupServer, scratch } from './helpers.js';

type Body = Record<string, unknown>;
type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  body: Body,
) => void;
async function gateway(t: TestContext, handler: Handler): Promise<string> {
  const instance = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    handler(request, response, text ? JSON.parse(text) : {});
  });
  cleanupServer(t, instance);
  await new Promise<void>((resolve) =>
    instance.listen(0, '127.0.0.1', resolve),
  );
  const address = instance.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}
type Reply =
  | { text: string }
  | { tool: { id: string; name: string; input: Record<string, unknown> } };
/** An Anthropic stream of one text or one tool call, with the usage the endpoint reports. */
function anthropic(
  response: ServerResponse,
  reply: Reply,
  usage: Record<string, number> = { input_tokens: 8 },
): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const event = (type: string, body: Record<string, unknown>) =>
    response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`,
    );
  event('message_start', {
    message: {
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'gateway',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { output_tokens: 0, ...usage },
    },
  });
  if ('text' in reply) {
    event('content_block_start', {
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    event('content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text: reply.text },
    });
  } else {
    event('content_block_start', {
      index: 0,
      content_block: {
        type: 'tool_use',
        id: reply.tool.id,
        name: reply.tool.name,
        input: {},
      },
    });
    event('content_block_delta', {
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(reply.tool.input),
      },
    });
  }
  event('content_block_stop', { index: 0 });
  event('message_delta', {
    delta: {
      stop_reason: 'text' in reply ? 'end_turn' : 'tool_use',
      stop_sequence: null,
    },
    usage: { output_tokens: 4 },
  });
  event('message_stop', {});
  response.end();
}
function refuse(response: ServerResponse, message: string): void {
  response.writeHead(400, { 'Content-Type': 'application/json' });
  response.end(
    JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message },
    }),
  );
}
interface Connection {
  protocol?: string;
  name?: string;
  settings?: Partial<CircleSettings>;
}
function model(
  t: TestContext,
  base: string,
  { protocol = 'anthropic', name = 'gateway', settings = {} }: Connection = {},
): GatewayModel {
  const home = scratch(t);
  saveCredentials({ api_key: 'test-key' }, home);
  const all = { ...defaultSettings(), ...settings };
  all.auth = {
    ...all.auth,
    protocol,
    base_url: protocol === 'anthropic' ? base : base + '/v1',
    model: name,
  };
  return new GatewayModel(all, home);
}
function request(
  messages: Message[],
  extra: Partial<ModelRequest> = {},
): ModelRequest {
  return {
    system: 'the system prompt',
    messages,
    tools: [],
    signal: new AbortController().signal,
    token: () => {},
    ...extra,
  };
}
/** Every breakpoint in a request, by its place: `system.0`, `messages.2.content.1`. */
function breakpoints(body: Body): Record<string, unknown> {
  const found: Record<string, unknown> = {};
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value))
      value.forEach((item, index) => walk(item, `${path}.${index}`));
    else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value))
        if (key === 'cache_control') found[path] = item;
        else walk(item, path ? `${path}.${key}` : key);
  };
  walk(body, '');
  return found;
}
/** The request as the endpoint reads its prompt: breakpoints say where to cache, not what. */
function unmarked<T>(value: T): T {
  if (Array.isArray(value)) return value.map(unmarked) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'cache_control')
      .map(([key, item]) => [key, unmarked(item)]),
  ) as T;
}
const history: Message[] = [
  { id: 'u1', role: 'user', content: 'read the file' },
  {
    id: 'a1',
    role: 'assistant',
    content: 'reading',
    tool_calls: [{ id: 'call-1', name: 'read_file', args: { path: 'a.txt' } }],
    provider_content: [
      { type: 'thinking', thinking: 'which file', signature: 'signed' },
      { type: 'text', text: 'reading' },
      {
        type: 'tool_use',
        id: 'call-1',
        name: 'read_file',
        input: { path: 'a.txt' },
      },
    ],
  },
  {
    id: 't1',
    role: 'tool',
    tool_call_id: 'call-1',
    name: 'read_file',
    content: 'the contents',
  },
];

test('an Anthropic request marks the end of the system prompt and the end of the conversation for caching', async (t) => {
  const bodies: Body[] = [];
  const base = await gateway(t, (_request, response, body) => {
    bodies.push(body);
    anthropic(response, { text: 'done' });
  });
  const stored = structuredClone(history);
  await model(t, base).complete(request(stored));
  const [body] = bodies;
  assert.deepEqual(body!.system, [
    {
      type: 'text',
      text: 'the system prompt',
      cache_control: { type: 'ephemeral' },
    },
  ]);
  // The tool result is the last block of the last message; nothing else is marked, and
  // the two breakpoints leave two of the endpoint's four unused.
  assert.deepEqual(breakpoints(body!), {
    'system.0': { type: 'ephemeral' },
    'messages.2.content.0': { type: 'ephemeral' },
  });
  assert.equal(
    (body!.messages as { content: { type: string }[] }[])[2]!.content[0]!.type,
    'tool_result',
  );
  // The request's copy carries the breakpoint. The stored blocks go back unmarked, so the
  // next request sends the same bytes the endpoint cached.
  assert.deepEqual(stored, history);
});

test('a conversation that ends in thinking is marked on the block before it', async (t) => {
  const bodies: Body[] = [];
  const base = await gateway(t, (_request, response, body) => {
    bodies.push(body);
    anthropic(response, { text: 'done' });
  });
  await model(t, base).complete(
    request([
      { id: 'u1', role: 'user', content: 'think about it' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'so far',
        provider_content: [
          { type: 'text', text: 'so far' },
          { type: 'thinking', thinking: 'and then', signature: 'signed' },
        ],
      },
    ]),
  );
  assert.deepEqual(Object.keys(breakpoints(bodies[0]!)), [
    'system.0',
    'messages.1.content.0',
  ]);
});

test('each step of a turn sends the last request back unchanged and moves the breakpoint to its end', async (t) => {
  const bodies: Body[] = [];
  const base = await gateway(t, (_request, response, body) => {
    // The conversation's own steps carry tools; its title request does not.
    if (!body.tools) return anthropic(response, { text: 'a title' });
    bodies.push(body);
    if (bodies.length === 1)
      anthropic(
        response,
        { tool: { id: 'call-1', name: 'probe', input: { what: 'x' } } },
        { input_tokens: 40, cache_creation_input_tokens: 2000 },
      );
    else
      anthropic(
        response,
        { text: 'done' },
        {
          input_tokens: 5,
          cache_read_input_tokens: 2040,
          cache_creation_input_tokens: 60,
        },
      );
  });
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const gatewayModel = model(t, base);
  const session = store.create(root, gatewayModel.model);
  const probe: Tool = {
    name: 'probe',
    description: 'look at something',
    parameters: { type: 'object', properties: { what: { type: 'string' } } },
    effect: 'read',
    run: async () => 'seen',
  };
  const harness = new Harness({
    model: gatewayModel,
    store,
    session,
    tools: [probe],
    system: 'the system prompt',
    policy: new ApprovalPolicy(
      new ApprovalStore(join(root, 'approvals')),
      root,
    ),
  });
  await harness.run('look at x');
  assert.equal(bodies.length, 2);
  const [first, second] = bodies.map(unmarked) as [Body, Body];
  // The cache is a prefix match on tools, system, then messages: byte for byte.
  assert.equal(JSON.stringify(second.tools), JSON.stringify(first.tools));
  assert.equal(JSON.stringify(second.system), JSON.stringify(first.system));
  const sent = first.messages as unknown[];
  assert.equal(
    JSON.stringify((second.messages as unknown[]).slice(0, sent.length)),
    JSON.stringify(sent),
  );
  assert.deepEqual(Object.keys(breakpoints(bodies[0]!)), [
    'system.0',
    'messages.0.content.0',
  ]);
  // The step's call and its result came after: the breakpoint is on the result now.
  assert.deepEqual(Object.keys(breakpoints(bodies[1]!)), [
    'system.0',
    'messages.2.content.0',
  ]);
  const answer = store
    .messages(session.id)
    .filter((message) => message.role === 'assistant')
    .at(-1)!;
  assert.deepEqual(answer.usage, {
    input_tokens: 2105,
    output_tokens: 4,
    cache_read_tokens: 2040,
    cache_write_tokens: 60,
  });
});

for (const [name, refusal, refused] of [
  [
    'names the breakpoint',
    'system.0.cache_control: Extra inputs are not permitted',
    (body: Body) => JSON.stringify(body).includes('cache_control'),
  ],
  [
    'reads the system prompt only as a string',
    'system: Input should be a valid string',
    (body: Body) => Array.isArray(body.system),
  ],
] as const)
  test(`an endpoint that ${name} gets the request again without breakpoints, and none after`, async (t) => {
    const bodies: Body[] = [];
    const base = await gateway(t, (_request, response, body) => {
      bodies.push(body);
      if (refused(body)) refuse(response, refusal);
      else anthropic(response, { text: 'done' });
    });
    const instance = model(t, base);
    const notices: ModelNotice[] = [];
    const result = await instance.complete(
      request(structuredClone(history), {
        notice: (event) => notices.push(event),
      }),
    );
    assert.equal(result.message.content, 'done');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1]!.system, 'the system prompt');
    assert.deepEqual(breakpoints(bodies[1]!), {});
    // Only the breakpoints went: the prompt the endpoint reads is the one first sent.
    assert.deepEqual(
      { ...unmarked(bodies[0]!), system: 'the system prompt' },
      bodies[1],
    );
    assert.deepEqual(notices, [
      { event: 'param_dropped', param: 'cache_control', status: 400 },
    ]);
    assert.deepEqual(Object.keys(instance.downgrades), ['cache_control']);
    await instance.complete(request(structuredClone(history)));
    assert.equal(bodies.length, 3);
    assert.deepEqual(bodies[2], bodies[1]);
  });

test('the prompt_cache setting asks for the hour on every breakpoint, or sends none', async (t) => {
  const bodies: Body[] = [];
  const base = await gateway(t, (_request, response, body) => {
    bodies.push(body);
    anthropic(response, { text: 'done' });
  });
  await model(t, base, { settings: { prompt_cache: '1h' } }).complete(
    request(structuredClone(history)),
  );
  // One lifetime on both: the endpoint refuses a longer one after a shorter one.
  assert.deepEqual(breakpoints(bodies[0]!), {
    'system.0': { type: 'ephemeral', ttl: '1h' },
    'messages.2.content.0': { type: 'ephemeral', ttl: '1h' },
  });
  await model(t, base, { settings: { prompt_cache: 'off' } }).complete(
    request(structuredClone(history)),
  );
  assert.equal(bodies[1]!.system, 'the system prompt');
  assert.deepEqual(breakpoints(bodies[1]!), {});
  assert.equal(loadSettingsFromDict({}).prompt_cache, '5m');
  assert.equal(
    loadSettingsFromDict({ prompt_cache: '1H ' }).prompt_cache,
    '1h',
  );
  assert.equal(
    loadSettingsFromDict({ prompt_cache: false }).prompt_cache,
    'off',
  );
  assert.equal(
    loadSettingsFromDict({ prompt_cache: 'never' }).prompt_cache,
    '5m',
  );
});

/** A Chat Completions stream of one text or one tool call, then the usage chunk. */
function chat(response: ServerResponse, reply: Reply): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (data: unknown) =>
    response.write('data: ' + JSON.stringify(data) + '\n\n');
  send({
    choices: [
      'text' in reply
        ? { index: 0, delta: { content: reply.text }, finish_reason: 'stop' }
        : {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: reply.tool.id,
                  function: {
                    name: reply.tool.name,
                    arguments: JSON.stringify(reply.tool.input),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
    ],
  });
  send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } });
  response.end('data: [DONE]\n\n');
}
/** OpenAI's refusal of a request field it does not take. */
function refuseField(response: ServerResponse, message: string): void {
  response.writeHead(400, { 'Content-Type': 'application/json' });
  response.end(
    JSON.stringify({
      error: { message, type: 'invalid_request_error', param: null },
    }),
  );
}
const turn: Message[] = [
  { id: 'u1', role: 'user', content: 'read the file' },
  {
    id: 'a1',
    role: 'assistant',
    content: 'reading',
    tool_calls: [{ id: 'call-1', name: 'read_file', args: { path: 'a.txt' } }],
  },
  {
    id: 't1',
    role: 'tool',
    tool_call_id: 'call-1',
    name: 'read_file',
    content: 'the contents',
  },
];

test('a conversation names itself to an OpenAI endpoint on every step, in both of its formats', async (t) => {
  const bodies: Body[] = [];
  const responses: Body[] = [];
  const base = await gateway(t, (request, response, body) => {
    if (request.url === '/v1/responses') {
      responses.push(body);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of [
        {
          type: 'response.output_text.delta',
          output_index: 0,
          item_id: 'msg_1',
          delta: 'done',
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp_1',
            model: 'gateway',
            status: 'completed',
            usage: { input_tokens: 10, output_tokens: 4 },
          },
        },
      ])
        response.write(
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      response.end();
      return;
    }
    // The conversation's own steps carry tools; its title request does not.
    if (!body.tools) return chat(response, { text: 'a title' });
    bodies.push(body);
    if (bodies.length === 1)
      chat(response, { tool: { id: 'call-1', name: 'probe', input: {} } });
    else chat(response, { text: 'done' });
  });
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const gatewayModel = model(t, base, { protocol: 'openai' });
  const session = store.create(root, gatewayModel.model);
  const harness = new Harness({
    model: gatewayModel,
    store,
    session,
    tools: [
      {
        name: 'probe',
        description: 'look at something',
        parameters: { type: 'object', properties: {} },
        effect: 'read',
        run: async () => 'seen',
      },
    ],
    system: 'the system prompt',
    policy: new ApprovalPolicy(
      new ApprovalStore(join(root, 'approvals')),
      root,
    ),
  });
  await harness.run('look at x');
  // The endpoint caches by itself; the key keeps both steps on the machine that did.
  assert.deepEqual(
    bodies.map((body) => body.prompt_cache_key),
    [session.id, session.id],
  );
  // Any other model than Claude gets no breakpoint: the endpoint would not know the field.
  assert.deepEqual(bodies.map(breakpoints), [{}, {}]);
  await model(t, base, { protocol: 'responses' }).complete(
    request(structuredClone(turn), { cacheKey: 'circle-12345678' }),
  );
  assert.equal(responses[0]!.prompt_cache_key, 'circle-12345678');
  // A title or another side request belongs to no conversation and sends no key.
  await model(t, base, { protocol: 'responses' }).complete(
    request(structuredClone(turn)),
  );
  assert.equal('prompt_cache_key' in responses[1]!, false);
});

test('an endpoint that refuses the conversation key gets the request again without it', async (t) => {
  const bodies: Body[] = [];
  const base = await gateway(t, (_request, response, body) => {
    bodies.push(body);
    if ('prompt_cache_key' in body)
      refuseField(
        response,
        'Unrecognized request argument supplied: prompt_cache_key',
      );
    else chat(response, { text: 'done' });
  });
  const instance = model(t, base, { protocol: 'openai' });
  const notices: ModelNotice[] = [];
  const result = await instance.complete(
    request(structuredClone(turn), {
      cacheKey: 'circle-12345678',
      notice: (event) => notices.push(event),
    }),
  );
  assert.equal(result.message.content, 'done');
  assert.equal(bodies.length, 2);
  const { prompt_cache_key: key, ...rest } = bodies[0]!;
  assert.equal(key, 'circle-12345678');
  assert.deepEqual(bodies[1], rest);
  assert.deepEqual(notices, [
    { event: 'param_dropped', param: 'prompt_cache_key', status: 400 },
  ]);
});

test('a Claude model behind an OpenAI-format endpoint gets breakpoints in that format', async (t) => {
  const bodies: Body[] = [];
  const base = await gateway(t, (_request, response, body) => {
    bodies.push(body);
    chat(response, { text: 'done' });
  });
  await model(t, base, {
    protocol: 'openai',
    name: 'anthropic/claude-sonnet-5',
  }).complete(request(structuredClone(turn)));
  const [body] = bodies;
  // The system prompt and the last user message carry one on their text; the one at the
  // top is the endpoint's to place after the tool result that ends the conversation.
  assert.deepEqual(breakpoints(body!), {
    '': { type: 'ephemeral' },
    'messages.0.content.0': { type: 'ephemeral' },
    'messages.1.content.0': { type: 'ephemeral' },
  });
  const messages = body!.messages as { role: string; content: unknown }[];
  assert.deepEqual(unmarked(messages[0]), {
    role: 'system',
    content: [{ type: 'text', text: 'the system prompt' }],
  });
  assert.deepEqual(unmarked(messages[1]), {
    role: 'user',
    content: [{ type: 'text', text: 'read the file' }],
  });
  assert.deepEqual(messages[3], {
    role: 'tool',
    content: 'the contents',
    tool_call_id: 'call-1',
  });
});

test('an OpenAI-format endpoint that refuses breakpoints gets the plain request again', async (t) => {
  const bodies: Body[] = [];
  const base = await gateway(t, (_request, response, body) => {
    bodies.push(body);
    if (JSON.stringify(body).includes('cache_control'))
      refuseField(
        response,
        "Unknown parameter: 'messages[0].content[0].cache_control'.",
      );
    else chat(response, { text: 'done' });
  });
  const instance = model(t, base, { protocol: 'openai', name: 'claude-opus' });
  const result = await instance.complete(request(structuredClone(turn)));
  assert.equal(result.message.content, 'done');
  assert.equal(bodies.length, 2);
  assert.deepEqual(breakpoints(bodies[1]!), {});
  const messages = bodies[1]!.messages as { content: unknown }[];
  assert.equal(messages[0]!.content, 'the system prompt');
  assert.equal(messages[1]!.content, 'read the file');
  assert.deepEqual(Object.keys(instance.downgrades), ['cache_control']);
});
