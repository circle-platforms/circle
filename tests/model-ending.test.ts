import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { GatewayModel } from '../src/model.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { defaultSettings, saveCredentials } from '../src/settings.js';
import type { ModelRequest, ModelNotice } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

type Context = Parameters<typeof scratch>[0];
async function gateway(
  t: Context,
  handle: (body: Record<string, any>, response: ServerResponse) => void,
) {
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    handle(JSON.parse(text), response);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanup(
    t,
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}
function model(
  t: Context,
  base: string,
  protocol: 'openai' | 'anthropic',
  name = 'claude-opus-5-5',
) {
  const home = scratch(t);
  saveCredentials({ api_key: 'synthetic' }, home);
  const settings = defaultSettings();
  settings.auth = { ...settings.auth, protocol, base_url: base, model: name };
  settings.default_thinking = 'high';
  return new GatewayModel(settings, home, undefined, { wait: async () => {} });
}
function request(
  notices: ModelNotice[] = [],
  tokens: [string, boolean][] = [],
): ModelRequest {
  return {
    system: 'synthetic system',
    messages: [{ id: 'user', role: 'user', content: 'synthetic question' }],
    tools: [],
    signal: new AbortController().signal,
    token: (text, thinking) => tokens.push([text, Boolean(thinking)]),
    notice: (notice) => notices.push(notice),
  };
}
function openai(
  response: ServerResponse,
  finish: string | null,
  delta: Record<string, unknown> = { content: 'partial' },
) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    'data: ' +
      JSON.stringify({
        model: 'served',
        choices: [{ index: 0, delta, finish_reason: finish }],
        usage: { prompt_tokens: 7, completion_tokens: 11 },
      }) +
      '\n\n',
  );
  response.end('data: [DONE]\n\n');
}
function event(response: ServerResponse, value: Record<string, unknown>) {
  response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}
function anthropic(
  response: ServerResponse,
  finish: string | null = 'end_turn',
  blocks: Record<string, any>[] = [{ type: 'text', text: 'answer' }],
  stop = true,
) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  event(response, {
    type: 'message_start',
    message: {
      id: 'synthetic',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 0 },
    },
  });
  for (const [index, block] of blocks.entries()) {
    const { partial_json, ...content } = block;
    if (block.type === 'text') {
      event(response, {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      event(response, {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });
    } else if (block.type === 'thinking') {
      event(response, {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      });
      event(response, {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: block.thinking },
      });
      event(response, {
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: block.signature },
      });
    } else {
      event(response, {
        type: 'content_block_start',
        index,
        content_block: content,
      });
      if (partial_json !== undefined)
        event(response, {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json },
        });
    }
    event(response, { type: 'content_block_stop', index });
  }
  if (finish)
    event(response, {
      type: 'message_delta',
      delta: { stop_reason: finish, stop_sequence: null },
      usage: { output_tokens: 11 },
    });
  if (stop) event(response, { type: 'message_stop' });
  response.end();
}

test('OpenAI endings preserve provider evidence and usage without retrying missing finish', async (t) => {
  for (const [finish, reason] of [
    ['stop', 'stop'],
    ['tool_calls', 'tool_calls'],
    ['length', 'length'],
    ['content_filter', 'filter'],
    ['future_reason', 'unknown'],
    ['constructor', 'unknown'],
    ['__proto__', 'unknown'],
    [null, 'missing'],
  ] as const) {
    let calls = 0;
    const base = await gateway(t, (_body, response) => {
      calls++;
      openai(response, finish, finish === null ? {} : { content: 'partial' });
    });
    const result = await model(t, base, 'openai', 'test-model').complete(
      request(),
    );
    assert.equal(calls, 1);
    assert.deepEqual(result.message.completion, {
      reason,
      ...(finish ? { provider_reason: finish } : {}),
    });
    assert.equal(result.usage.output_tokens, 11);
    assert.equal(
      result.message.truncated,
      finish === 'length' || finish === null ? true : undefined,
    );
  }
});

test('truncated OpenAI tool fragments retain partial text and usage even when identity is incomplete', async (t) => {
  const base = await gateway(t, (_body, response) =>
    openai(response, 'length', {
      content: 'before tool',
      tool_calls: [
        { index: 0, function: { arguments: '{"path":"unfinished' } },
      ],
    }),
  );
  const result = await model(t, base, 'openai', 'test-model').complete(
    request(),
  );
  assert.equal(result.message.content, 'before tool');
  assert.equal(result.usage.output_tokens, 11);
  assert.equal(result.message.completion?.reason, 'length');
  assert.equal(result.message.tool_calls?.[0]?.raw_args, '{"path":"unfinished');
  assert.match(
    result.message.tool_calls?.[0]?.argument_error ?? '',
    /incomplete/,
  );
  assert.ok(result.message.tool_calls?.[0]?.id);
  assert.equal(result.message.tool_calls?.[0]?.name, 'incomplete_tool_call');
});

test('Anthropic requests summarized display only for documented models and preserve effort and budget', async (t) => {
  const bodies: Record<string, any>[] = [];
  const base = await gateway(t, (body, response) => {
    bodies.push(body);
    anthropic(response);
  });
  for (const name of [
    'claude-opus-5-5',
    'provider/claude-opus-4-8',
    'claude-sonnet-4-5',
    'unknown-model',
  ]) {
    await model(t, base, 'anthropic', name).complete(request());
  }
  assert.deepEqual(bodies[0]!.thinking, {
    type: 'adaptive',
    display: 'summarized',
  });
  assert.equal(bodies[0]!.max_tokens, 32000);
  assert.deepEqual(bodies[0]!.output_config, { effort: 'high' });
  assert.equal(bodies[1]!.thinking.display, 'summarized');
  assert.equal(bodies[2]!.thinking.display, undefined);
  assert.equal(bodies[3]!.thinking, undefined);
});

test('explicit display rejection drops only thinking.display once and records the downgrade', async (t) => {
  const bodies: Record<string, any>[] = [];
  const base = await gateway(t, (body, response) => {
    bodies.push(body);
    if (bodies.length === 1) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            param: 'thinking',
            message: 'thinking.display: Extra inputs are not permitted',
          },
        }),
      );
    } else anthropic(response);
  });
  const instance = model(t, base, 'anthropic');
  const notices: ModelNotice[] = [];
  await instance.complete(request(notices));
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0]!.thinking, {
    type: 'adaptive',
    display: 'summarized',
  });
  assert.deepEqual(bodies[1]!.thinking, { type: 'adaptive' });
  assert.deepEqual(bodies[1]!.output_config, bodies[0]!.output_config);
  assert.equal(bodies[1]!.max_tokens, bodies[0]!.max_tokens);
  assert.ok(instance.downgrades['thinking.display']);
  assert.ok(
    notices.some(
      (notice) =>
        notice.event === 'param_dropped' && notice.param === 'thinking.display',
    ),
  );
});

test('display rejection is retried at most once and later requests retain the narrow downgrade', async (t) => {
  const bodies: Record<string, any>[] = [];
  const base = await gateway(t, (body, response) => {
    bodies.push(body);
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          param: 'thinking.display',
          message: 'unsupported thinking.display',
        },
      }),
    );
  });
  const instance = model(t, base, 'anthropic');
  await assert.rejects(instance.complete(request()), /thinking\.display/);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1]!.thinking, { type: 'adaptive' });
  await assert.rejects(instance.complete(request()), /thinking\.display/);
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies[2]!.thinking, { type: 'adaptive' });
  assert.deepEqual(Object.keys(instance.downgrades), ['thinking.display']);
});

test('explicit rejection of another parameter wins over incidental display text', async (t) => {
  const bodies: Record<string, any>[] = [];
  const base = await gateway(t, (body, response) => {
    bodies.push(body);
    if (bodies.length === 1) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            param: 'output_config',
            message: 'unsupported output_config; thinking.display is supported',
          },
        }),
      );
    } else anthropic(response);
  });
  const instance = model(t, base, 'anthropic');
  await instance.complete(request());
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1]!.thinking, {
    type: 'adaptive',
    display: 'summarized',
  });
  assert.equal(bodies[1]!.output_config, undefined);
  assert.deepEqual(Object.keys(instance.downgrades), ['output_config']);
});

test('unrelated client errors do not trigger the display downgrade', async (t) => {
  let calls = 0;
  const base = await gateway(t, (_body, response) => {
    calls++;
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'invalid messages: context is too long',
        },
      }),
    );
  });
  const instance = model(t, base, 'anthropic');
  await assert.rejects(instance.complete(request()), /context is too long/);
  assert.equal(calls, 1);
  assert.deepEqual(instance.downgrades, {});
});

test('Anthropic interleaved summary, text, and tools retain signatures and exact token order in the next request', async (t) => {
  const bodies: Record<string, any>[] = [];
  const blocks = [
    { type: 'thinking', thinking: 'summary one', signature: 'sig-one' },
    { type: 'text', text: 'before tool' },
    {
      type: 'tool_use',
      id: 'call',
      name: 'read',
      input: {},
      partial_json: '{"path":"file"}',
    },
    { type: 'thinking', thinking: '', signature: 'signature-only' },
    { type: 'thinking', thinking: 'summary two', signature: 'sig-two' },
    { type: 'text', text: 'after tool' },
  ];
  const base = await gateway(t, (body, response) => {
    bodies.push(body);
    anthropic(
      response,
      bodies.length === 1 ? 'tool_use' : 'end_turn',
      bodies.length === 1 ? blocks : undefined,
    );
  });
  const instance = model(t, base, 'anthropic');
  const tokens: [string, boolean][] = [];
  const first = await instance.complete(request([], tokens));
  assert.deepEqual(
    tokens.filter(([text]) => text),
    [
      ['summary one', true],
      ['before tool', false],
      ['summary two', true],
      ['after tool', false],
    ],
  );
  assert.equal(first.message.content, 'before toolafter tool');
  assert.equal(first.message.thinking, 'summary onesummary two');
  assert.equal(first.message.completion?.reason, 'tool_calls');
  assert.deepEqual(
    first.message.provider_content?.filter(
      (block: any) => block.type === 'thinking',
    ),
    blocks.filter((block) => block.type === 'thinking'),
  );
  const next = request();
  next.messages.push(first.message, {
    id: 'result',
    role: 'tool',
    tool_call_id: 'call',
    content: 'read result',
  });
  await instance.complete(next);
  assert.deepEqual(
    bodies[1]!.messages[1].content,
    first.message.provider_content,
  );
});

test('Anthropic stop categories, signature-only responses, and absent end markers retain evidence without replay', async (t) => {
  for (const [finish, reason, stop] of [
    ['end_turn', 'stop', true],
    ['max_tokens', 'length', true],
    ['model_context_window_exceeded', 'length', true],
    ['refusal', 'filter', true],
    ['pause_turn', 'pause', true],
    ['new_reason', 'unknown', true],
    ['constructor', 'unknown', true],
    [null, 'missing', true],
    [null, 'missing', false],
    ['end_turn', 'missing', false],
    ['tool_use', 'missing', false],
  ] as const) {
    let calls = 0;
    const base = await gateway(t, (_body, response) => {
      calls++;
      anthropic(
        response,
        finish,
        [{ type: 'thinking', thinking: '', signature: 'exact-signature' }],
        stop,
      );
    });
    const result = await model(t, base, 'anthropic').complete(request());
    assert.equal(calls, 1);
    assert.deepEqual(result.message.completion, {
      reason,
      ...(finish ? { provider_reason: finish } : {}),
      output_limit: 32000,
    });
    assert.deepEqual(result.message.provider_content, [
      { type: 'thinking', thinking: '', signature: 'exact-signature' },
    ]);
    assert.equal(result.usage.output_tokens, finish ? 11 : 0);
  }
});

test('Anthropic truncated tool JSON retains raw arguments and usage', async (t) => {
  const base = await gateway(t, (_body, response) =>
    anthropic(response, 'max_tokens', [
      {
        type: 'tool_use',
        id: 'call',
        name: 'write',
        input: {},
        partial_json: '{"path":"unfinished',
      },
    ]),
  );
  const result = await model(t, base, 'anthropic').complete(request());
  assert.equal(result.message.completion?.reason, 'length');
  assert.equal(result.message.tool_calls?.[0]?.raw_args, '{"path":"unfinished');
  assert.ok(result.message.tool_calls?.[0]?.argument_error);
  assert.equal(result.usage.output_tokens, 11);
});

test('malformed Anthropic tool JSON cannot discard later stop evidence and usage', async (t) => {
  const raw = '{"path":"\\q"}';
  const base = await gateway(t, (_body, response) =>
    anthropic(response, 'max_tokens', [
      { type: 'text', text: 'partial answer' },
      {
        type: 'tool_use',
        id: 'call',
        name: 'write',
        input: {},
        partial_json: raw,
      },
    ]),
  );
  const result = await model(t, base, 'anthropic').complete(request());
  assert.equal(result.message.content, 'partial answer');
  assert.equal(result.message.completion?.reason, 'length');
  assert.equal(result.message.tool_calls?.[0]?.raw_args, raw);
  assert.ok(result.message.tool_calls?.[0]?.argument_error);
  assert.equal(result.usage.output_tokens, 11);
});

test('raw Anthropic accumulation preserves initial content, signatures, citations, server blocks and cumulative cache usage', async (t) => {
  const base = await gateway(t, (_body, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    event(response, {
      type: 'message_start',
      message: {
        id: 'message',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'prefix' }],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 7,
          output_tokens: 1,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 3,
        },
      },
    });
    event(response, {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'thinking',
        thinking: 'summary',
        signature: '',
      },
    });
    event(response, {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'thinking_delta', thinking: ' tail' },
    });
    event(response, {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'signature_delta', signature: 'sig-tail' },
    });
    event(response, { type: 'content_block_stop', index: 1 });
    event(response, {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'text', text: 'hello' },
    });
    event(response, {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'text_delta', text: ' world' },
    });
    event(response, {
      type: 'content_block_delta',
      index: 2,
      delta: {
        type: 'citations_delta',
        citation: {
          type: 'char_location',
          cited_text: 'source',
          document_index: 0,
          document_title: 'title',
          start_char_index: 0,
          end_char_index: 6,
        },
      },
    });
    event(response, { type: 'content_block_stop', index: 2 });
    event(response, {
      type: 'content_block_start',
      index: 3,
      content_block: { type: 'redacted_thinking', data: 'encrypted-block' },
    });
    event(response, { type: 'content_block_stop', index: 3 });
    event(response, {
      type: 'content_block_start',
      index: 4,
      content_block: {
        type: 'server_tool_use',
        id: 'server',
        name: 'web_search',
        input: {},
      },
    });
    event(response, {
      type: 'content_block_delta',
      index: 4,
      delta: {
        type: 'input_json_delta',
        partial_json: '{"query":"synthetic"}',
      },
    });
    event(response, { type: 'content_block_stop', index: 4 });
    event(response, {
      type: 'content_block_start',
      index: 5,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: 'server',
        content: [],
      },
    });
    event(response, { type: 'content_block_stop', index: 5 });
    event(response, {
      type: 'message_delta',
      delta: {
        stop_reason: 'end_turn',
        stop_sequence: null,
        container: { id: 'container', expires_at: '2099-01-01T00:00:00Z' },
      },
      usage: {
        input_tokens: 8,
        output_tokens: 11,
        cache_read_input_tokens: 21,
        cache_creation_input_tokens: 5,
        cache_creation: {
          ephemeral_1h_input_tokens: 2,
          ephemeral_5m_input_tokens: 3,
        },
      },
    });
    event(response, { type: 'message_stop' });
    response.end();
  });
  const tokens: [string, boolean][] = [];
  const result = await model(t, base, 'anthropic').complete(
    request([], tokens),
  );
  assert.deepEqual(tokens, [
    ['prefix', false],
    ['summary', true],
    [' tail', true],
    ['hello', false],
    [' world', false],
  ]);
  assert.equal(result.message.content, 'prefixhello world');
  const blocks = result.message.provider_content as Record<string, any>[];
  assert.deepEqual(blocks[1], {
    type: 'thinking',
    thinking: 'summary tail',
    signature: 'sig-tail',
  });
  assert.equal(blocks[2]!.citations[0].cited_text, 'source');
  assert.deepEqual(blocks[3], {
    type: 'redacted_thinking',
    data: 'encrypted-block',
  });
  assert.deepEqual(blocks[4], {
    type: 'server_tool_use',
    id: 'server',
    name: 'web_search',
    input: { query: 'synthetic' },
  });
  assert.deepEqual(blocks[5], {
    type: 'web_search_tool_result',
    tool_use_id: 'server',
    content: [],
  });
  assert.deepEqual(result.usage, {
    input_tokens: 34,
    output_tokens: 11,
    cache_read_tokens: 21,
    cache_write_tokens: 5,
    cache_write_1h_tokens: 2,
  });
});

test('Anthropic cancellation aborts the raw stream without another request', async (t) => {
  let calls = 0;
  const base = await gateway(t, (_body, response) => {
    calls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    event(response, {
      type: 'message_start',
      message: {
        id: 'message',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    event(response, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    event(response, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'partial' },
    });
  });
  const controller = new AbortController();
  const input = request();
  input.signal = controller.signal;
  input.token = () => controller.abort(new Error('cancel synthetic stream'));
  await assert.rejects(
    model(t, base, 'anthropic').complete(input),
    /cancel synthetic stream|abort/i,
  );
  assert.equal(calls, 1);
});

test('Anthropic repetition stops the raw stream with client evidence and no replay', async (t) => {
  let calls = 0;
  const base = await gateway(t, (_body, response) => {
    calls++;
    anthropic(response, 'end_turn', [
      {
        type: 'text',
        text: 'one two three four five six seven eight '.repeat(1000),
      },
    ]);
  });
  const result = await model(t, base, 'anthropic').complete(request());
  assert.equal(calls, 1);
  assert.equal(result.message.truncated, true);
  assert.equal(result.message.completion?.client_stop, 'repetition');
  assert.ok(result.message.content);
});

test('an empty successful Anthropic stream becomes missing evidence without retry', async (t) => {
  let calls = 0;
  const base = await gateway(t, (_body, response) => {
    calls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end();
  });
  const result = await model(t, base, 'anthropic').complete(request());
  assert.equal(calls, 1);
  assert.equal(result.message.completion?.reason, 'missing');
  assert.equal(result.message.truncated, true);
  assert.equal(result.usage.output_tokens, 0);
});

test('Anthropic null usage deltas retain known input and cache counters', async (t) => {
  const base = await gateway(t, (_body, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    event(response, {
      type: 'message_start',
      message: {
        id: 'message',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'answer' }],
        stop_reason: null,
        usage: {
          input_tokens: 7,
          output_tokens: 0,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
          cache_creation: {
            ephemeral_1h_input_tokens: 2,
            ephemeral_5m_input_tokens: 3,
          },
        },
      },
    });
    event(response, {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: {
        output_tokens: 11,
        input_tokens: null,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        cache_creation: null,
      },
    });
    event(response, { type: 'message_stop' });
    response.end();
  });
  const result = await model(t, base, 'anthropic').complete(request());
  assert.deepEqual(result.usage, {
    input_tokens: 32,
    output_tokens: 11,
    cache_read_tokens: 20,
    cache_write_tokens: 5,
    cache_write_1h_tokens: 2,
  });
});

test('Anthropic signature deltas replace prior signatures and replay unchanged', async (t) => {
  const bodies: Record<string, any>[] = [];
  const base = await gateway(t, (body, response) => {
    bodies.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    event(response, {
      type: 'message_start',
      message: {
        id: 'message',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 7, output_tokens: 0 },
      },
    });
    event(response, {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'thinking',
        thinking: 'summary',
        signature: 'initial-signature',
      },
    });
    for (let repeat = 0; repeat < 2; repeat++)
      event(response, {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'signature_delta',
          signature: 'authoritative-signature',
        },
      });
    event(response, { type: 'content_block_stop', index: 0 });
    event(response, {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 11 },
    });
    event(response, { type: 'message_stop' });
    response.end();
  });
  const instance = model(t, base, 'anthropic');
  const first = await instance.complete(request());
  assert.deepEqual(first.message.provider_content, [
    {
      type: 'thinking',
      thinking: 'summary',
      signature: 'authoritative-signature',
    },
  ]);
  const next = request();
  next.messages.push(first.message, {
    id: 'followup',
    role: 'user',
    content: 'continue',
  });
  await instance.complete(next);
  assert.deepEqual(
    bodies[1]!.messages[1].content,
    first.message.provider_content,
  );
});

test('OpenAI resumed history omits thinking-only assistant turns but retains tool batches', async (t) => {
  const messages: import('../src/types.js').Message[] = [
    { id: 'u1', role: 'user', content: 'inspect synthetic workspace' },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      thinking: 'private reasoning',
      tool_calls: [
        { id: 'call1', name: 'execute', args: { command: 'false' } },
      ],
    },
    {
      id: 't1',
      role: 'tool',
      content: 'synthetic command failed',
      tool_call_id: 'call1',
    },
    {
      id: 'a2',
      role: 'assistant',
      content: '',
      thinking: 'unfinished private reasoning',
    },
    { id: 'u2', role: 'user', content: 'continue after restarting' },
  ];
  const original = structuredClone(messages);
  const historyHome = scratch(t);
  const store = new CheckpointStore(historyHome);
  const session = store.create(historyHome, 'synthetic-chat');
  store.append(session.id, messages);
  store.close();
  const restored = new CheckpointStore(historyHome);
  cleanup(t, () => restored.close());
  const resumed = restored.messages(session.id);
  assert.deepEqual(resumed, messages);
  let received: Record<string, any> | undefined;
  const base = await gateway(t, (body, response) => {
    received = body;
    const invalid = body.messages.some(
      (item: any) =>
        item.role === 'assistant' &&
        item.content == null &&
        !item.tool_calls?.length,
    );
    if (invalid) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            message: 'content field required',
            type: 'invalid_request_error',
          },
        }),
      );
    } else openai(response, 'stop', { content: 'continued' });
  });
  const result = await model(t, base, 'openai', 'synthetic-chat').complete({
    ...request(),
    messages: resumed,
  });
  assert.equal(result.message.content, 'continued');
  assert.deepEqual(messages, original, 'history and thinking remain intact');
  assert.deepEqual(
    restored.messages(session.id),
    original,
    'request projection never mutates stored history',
  );
  assert.deepEqual(
    received?.messages.map((item: any) => item.role),
    ['system', 'user', 'assistant', 'tool', 'user'],
  );
  assert.equal(received?.messages[2].content, null);
  assert.equal(received?.messages[2].tool_calls[0].id, 'call1');
  assert.equal(received?.messages[3].tool_call_id, 'call1');
  assert.equal(received?.messages[3].content, 'synthetic command failed');
  assert.ok(!JSON.stringify(received).includes('private reasoning'));
});
