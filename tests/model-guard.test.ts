import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ModelGuard,
  BUDGETS,
  errorKind,
  retryAfterMs,
  backoffMs,
} from '../src/model_guard.js';
import { GatewayModel } from '../src/model.js';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { defaultSettings, saveCredentials } from '../src/settings.js';
import { RepetitionMonitor } from '../src/text_repetition.js';
import type { ModelRequest, ModelResponse, ModelNotice } from '../src/types.js';
import { scratch, cleanup } from './helpers.js';
const answer = (content: string): ModelResponse => ({
  message: { id: crypto.randomUUID(), role: 'assistant', content },
  usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 },
});
const request = (): ModelRequest => ({
  system: 'system',
  messages: [{ id: 'user', role: 'user', content: 'hello' }],
  tools: [],
  signal: new AbortController().signal,
  token: () => {},
});
const error = (
  status: number,
  message: string,
  extra: Record<string, unknown> = {},
): Error => Object.assign(new Error(message), { status, ...extra });
function chunk(
  response: ServerResponse,
  delta: Record<string, unknown>,
  finish: string | null = null,
): void {
  response.write(
    'data: ' +
      JSON.stringify({
        choices: [{ index: 0, delta, finish_reason: finish }],
      }) +
      '\n\n',
  );
}
async function gateway(
  t: Parameters<typeof scratch>[0],
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown>,
  ) => void,
): Promise<string> {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const data of request) body += data;
    handler(request, response, body ? JSON.parse(body) : {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(
    t,
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}/v1`;
}
function model(
  t: Parameters<typeof scratch>[0],
  base: string,
  wait?: (ms: number, signal: AbortSignal) => Promise<void>,
  stallMs?: number,
): GatewayModel {
  const home = scratch(t);
  const settings = defaultSettings();
  settings.auth.base_url = base;
  settings.auth.model = 'test-model';
  settings.default_thinking = 'high';
  saveCredentials({ api_key: 'fake-key' }, home);
  return new GatewayModel(settings, home, undefined, { wait, stallMs });
}
test('retry classification separates budgets and never retries exhausted quota or unrelated client errors', () => {
  assert.equal(errorKind(error(429, 'rate limit')), 'rate_limit');
  assert.equal(errorKind(error(503, 'busy')), 'server');
  assert.equal(
    errorKind(Object.assign(new Error('network'), { code: 'ECONNRESET' })),
    'network',
  );
  for (const failure of [
    error(402, 'quota'),
    error(429, 'quota', { error: { code: 'insufficient_quota' } }),
    error(401, 'key'),
    error(400, 'context too large'),
  ])
    assert.equal(errorKind(failure), undefined);
  assert.equal(
    retryAfterMs(
      error(429, 'slow', {
        headers: new Headers({ 'retry-after-ms': '7000' }),
      }),
    ),
    7000,
  );
  assert.equal(retryAfterMs(error(429, 'try again in 2 minutes')), 120000);
  assert.equal(backoffMs('network', 2), 12000);
});
test('independent retry budgets, endpoint hints and no retry after streaming output', async () => {
  const notices: ModelNotice[] = [];
  const waits: number[] = [];
  const guard = new ModelGuard(() => false, {
    wait: async (ms) => {
      waits.push(ms);
    },
    random: () => 0.5,
  });
  const input = request();
  input.notice = (event) => notices.push(event);
  let call = 0;
  const result = await guard.execute(input, async () => {
    if (call++ === 0)
      throw error(429, 'limited', {
        headers: new Headers({ 'retry-after': '7' }),
      });
    if (call === 2) throw error(503, 'server');
    return answer('done');
  });
  assert.equal(result.message.content, 'done');
  assert.deepEqual(waits, [7000, 2000]);
  assert.deepEqual(
    notices.map((event) => event.kind),
    ['rate_limit', 'server'],
  );
  let attempts = 0;
  await assert.rejects(
    guard.execute(request(), async (input) => {
      attempts++;
      input.token('partial');
      throw error(503, 'failure after output');
    }),
    /after output/,
  );
  assert.equal(attempts, 1);
  const network = new ModelGuard(() => false, { wait: async () => {} });
  let failures = 0;
  await assert.rejects(
    network.execute(request(), async () => {
      failures++;
      throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
    }),
  );
  assert.equal(failures, BUDGETS.network.maxRetries + 1);
});
test('real SDK retries, drops only rejected parameters and retains the downgrade on later calls', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const base = await gateway(t, (_request, response, body) => {
    bodies.push(body);
    if (bodies.length === 1) {
      response
        .writeHead(429, {
          'Content-Type': 'application/json',
          'retry-after-ms': '100',
        })
        .end(
          JSON.stringify({
            error: { message: 'limited', type: 'rate_limit_error' },
          }),
        );
      return;
    }
    if (body.reasoning_effort) {
      response.writeHead(400, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          error: {
            message:
              'Unsupported value: the reasoning_effort parameter is invalid',
            param: 'reasoning_effort',
          },
        }),
      );
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    chunk(response, { content: 'done' }, 'stop');
    response.end('data: [DONE]\n\n');
  });
  const waits: number[] = [];
  const instance = model(t, base, async (ms) => {
    waits.push(ms);
  });
  await instance.complete(request());
  await instance.complete(request());
  assert.equal(bodies.length, 4);
  assert.equal(bodies[0]!.reasoning_effort, 'high');
  assert.ok(!('reasoning_effort' in bodies[2]!));
  assert.ok(!('reasoning_effort' in bodies[3]!));
  assert.equal(
    instance.downgrades.reasoning_effort,
    'rejected by the endpoint (400)',
  );
  assert.deepEqual(waits, [100]);
});
test('cancellation interrupts an actual Retry-After wait and never sends the queued retry', async (t) => {
  let calls = 0;
  const base = await gateway(t, (_request, response) => {
    calls++;
    response
      .writeHead(429, {
        'Content-Type': 'application/json',
        'retry-after': '60',
      })
      .end(
        JSON.stringify({
          error: { message: 'limited', type: 'rate_limit_error' },
        }),
      );
  });
  const instance = model(t, base);
  const controller = new AbortController();
  const input = request();
  input.signal = controller.signal;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  input.notice = (event) => {
    if (event.event === 'retry') entered();
  };
  const running = instance.complete(input);
  const rejected = assert.rejects(running, /abort|Interrupted/i);
  await ready;
  controller.abort(new Error('Interrupted'));
  await rejected;
  await delay(20);
  assert.equal(calls, 1);
});
test('a stalled stream is a timeout: sent again up to 10 times, also after part of the answer came, which is not kept', async (t) => {
  let calls = 0;
  const base = await gateway(t, (request, response) => {
    calls++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (calls === 3) {
      chunk(response, { content: 'recovered' }, 'stop');
      response.end('data: [DONE]\n\n');
      return;
    }
    // the first stream sends only keep-alives, the second some text, then each goes quiet
    chunk(response, calls === 2 ? { content: 'already output' } : {});
    const interval = setInterval(() => chunk(response, {}), 10);
    response.on('close', () => clearInterval(interval));
  });
  const waits: number[] = [];
  const notices: ModelNotice[] = [];
  const input = request();
  input.notice = (event) => notices.push(event);
  const instance = model(
    t,
    base,
    async (ms) => {
      waits.push(ms);
    },
    50,
  );
  const result = await instance.complete(input);
  assert.equal(result.message.content, 'recovered');
  assert.equal(calls, 3);
  assert.deepEqual(
    notices.map((event) => [event.event, event.kind, event.attempt, event.max]),
    [
      ['retry', 'timeout', 1, 10],
      ['retry', 'timeout', 2, 10],
    ],
  );
  assert.equal(waits.length, 2);
  let stalls = 0;
  const silent = await gateway(t, (_request, response) => {
    stalls++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    chunk(response, { content: 'part' });
  });
  await assert.rejects(
    model(t, silent, async () => {}, 50).complete(request()),
    /^RetriesExhausted: no content from the model for 0s \(gave up after 10 retries\)$/,
  );
  assert.equal(stalls, 11);
});
test('timeouts are told apart from other failures, also through the SDKs, whose errors are all named Error', () => {
  for (const timedOut of [
    new OpenAI.APIConnectionTimeoutError(),
    new Anthropic.APIConnectionTimeoutError(),
    error(504, 'upstream timed out'),
    error(524, 'origin timed out'),
    error(408, 'request timeout'),
    Object.assign(new Error('connect'), { code: 'ETIMEDOUT' }),
    new TypeError('terminated', {
      cause: Object.assign(new Error('body'), { code: 'UND_ERR_BODY_TIMEOUT' }),
    }),
    new OpenAI.APIConnectionError({
      cause: Object.assign(new Error('fetch failed'), {
        cause: Object.assign(new Error('connect'), {
          code: 'UND_ERR_CONNECT_TIMEOUT',
        }),
      }),
    }),
  ])
    assert.equal(errorKind(timedOut), 'timeout', String(timedOut));
  assert.equal(errorKind(new OpenAI.APIConnectionError({})), 'network');
  assert.equal(
    errorKind(
      new TypeError('terminated', {
        cause: Object.assign(new Error('other side closed'), {
          code: 'UND_ERR_SOCKET',
        }),
      }),
    ),
    'network',
  );
  assert.equal(
    errorKind(
      new OpenAI.APIError(
        undefined,
        { message: 'overloaded' },
        'x',
        new Headers(),
      ),
    ),
    'inband',
  );
  assert.equal(errorKind(error(503, 'busy')), 'server');
  assert.equal(BUDGETS.timeout.maxRetries, 10);
});
test('each timeout doubles how long the next request waits for the answer to start, up to 8 times; a dropped connection is sent again after output too', async () => {
  const scales: (number | undefined)[] = [];
  const notices: ModelNotice[] = [];
  const guard = new ModelGuard(() => false, { wait: async () => {} });
  const input = request();
  input.notice = (event) => notices.push(event);
  await assert.rejects(
    guard.execute(input, async (current) => {
      scales.push(current.timeoutScale);
      throw new OpenAI.APIConnectionTimeoutError();
    }),
    /Request timed out\. \(gave up after 10 retries\)/,
  );
  assert.deepEqual(scales, [undefined, 2, 4, 8, 8, 8, 8, 8, 8, 8, 8]);
  assert.deepEqual(
    notices.map((event) => `${event.attempt}/${event.max}`),
    [
      '1/10',
      '2/10',
      '3/10',
      '4/10',
      '5/10',
      '6/10',
      '7/10',
      '8/10',
      '9/10',
      '10/10',
    ],
  );
  let attempts = 0;
  const result = await guard.execute(request(), async (current) => {
    if (attempts++) return answer('whole');
    current.token('half an ans');
    throw new TypeError('terminated', {
      cause: Object.assign(new Error('other side closed'), {
        code: 'UND_ERR_SOCKET',
      }),
    });
  });
  assert.equal(result.message.content, 'whole');
  assert.equal(attempts, 2);
});
test('a request that times out waits longer the next time, so a slow endpoint answers in the end', async (t) => {
  const before = process.env.CIRCLE_LLM_TIMEOUT;
  process.env.CIRCLE_LLM_TIMEOUT = '5';
  cleanup(t, () => {
    if (before === undefined) delete process.env.CIRCLE_LLM_TIMEOUT;
    else process.env.CIRCLE_LLM_TIMEOUT = before;
  });
  let calls = 0;
  // takes 6 s to start answering: more than 5 s, less than 10 s
  const base = await gateway(t, (_request, response) => {
    calls++;
    const timer = setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      chunk(response, { content: 'slow but here' }, 'stop');
      response.end('data: [DONE]\n\n');
    }, 6000);
    response.on('close', () => clearTimeout(timer));
  });
  const notices: ModelNotice[] = [];
  const input = request();
  input.notice = (event) => notices.push(event);
  const result = await model(t, base, async () => {}).complete(input);
  assert.equal(result.message.content, 'slow but here');
  assert.equal(calls, 2);
  assert.deepEqual(
    notices.map((event) => [event.kind, event.attempt]),
    [['timeout', 1]],
  );
});
test('empty missing-finish stream is retried once; partial output is retained and marked truncated', async (t) => {
  let calls = 0;
  const base = await gateway(t, (_request, response) => {
    calls++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (calls === 1) chunk(response, {});
    else chunk(response, { content: 'done' }, 'stop');
    response.end('data: [DONE]\n\n');
  });
  assert.equal(
    (await model(t, base).complete(request())).message.content,
    'done',
  );
  assert.equal(calls, 2);
  let partialCalls = 0;
  const partialBase = await gateway(t, (_request, response) => {
    partialCalls++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    chunk(response, { content: 'partial' });
    response.end('data: [DONE]\n\n');
  });
  const result = await model(t, partialBase).complete(request());
  assert.equal(result.message.content, 'partial');
  assert.equal(result.message.truncated, true);
  assert.equal(partialCalls, 1);
});
test('thinking repetition receives a bounded recovery reminder and varied text is left alone', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const base = await gateway(t, (_request, response, body) => {
    bodies.push(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (bodies.length === 1)
      chunk(response, {
        reasoning_content: 'one two three four five six seven eight '.repeat(
          40,
        ),
      });
    else chunk(response, { content: 'changed approach' }, 'stop');
    response.end('data: [DONE]\n\n');
  });
  const result = await model(t, base).complete(request());
  assert.equal(result.message.content, 'changed approach');
  assert.equal(bodies.length, 2);
  assert.match(JSON.stringify(bodies[1]!.messages), /different approach/);
  const monitor = new RepetitionMonitor();
  assert.equal(
    monitor.feed(
      Array.from({ length: 800 }, (_, index) => 'unique' + index).join(' ') +
        ' ',
    ),
    undefined,
  );
});
test('stream stall deadline starts after connection and does not replay a slow successful handshake', async (t) => {
  let calls = 0;
  const base = await gateway(t, (_request, response) => {
    calls++;
    setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      chunk(response, { content: 'one response' }, 'stop');
      response.end('data: [DONE]\n\n');
    }, 120);
  });
  const result = await model(t, base, undefined, 20).complete(request());
  assert.equal(result.message.content, 'one response');
  assert.equal(calls, 1);
});

test('an Anthropic tool call whose arguments stream for longer than the stall timeout is not taken for a stall', async (t) => {
  let calls = 0;
  const base = await gateway(t, (_request, response) => {
    calls++;
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
        model: 'claude-test',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    event('content_block_start', {
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'call',
        name: 'write_file',
        input: {},
      },
    });
    // the arguments come a piece every 50 ms for 600 ms, twelve times the stall timeout
    const pieces = [
      '{"file_path": "a.txt", "content": "',
      ...Array(10).fill('x'),
      '"}',
    ];
    let at = 0;
    const timer = setInterval(() => {
      event('content_block_delta', {
        index: 0,
        delta: { type: 'input_json_delta', partial_json: pieces[at++] },
      });
      if (at < pieces.length) return;
      clearInterval(timer);
      event('content_block_stop', { index: 0 });
      event('message_delta', {
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 20 },
      });
      event('message_stop', {});
      response.end();
    }, 50);
    response.on('close', () => clearInterval(timer));
  });
  const home = scratch(t);
  const settings = defaultSettings();
  settings.auth.protocol = 'anthropic';
  settings.auth.base_url = base.replace(/\/v1$/, '');
  settings.auth.model = 'claude-test';
  saveCredentials({ api_key: 'fake-key' }, home);
  const result = await new GatewayModel(settings, home, undefined, {
    wait: async () => {},
    stallMs: 120,
  }).complete(request());
  assert.deepEqual(result.message.tool_calls, [
    {
      id: 'call',
      name: 'write_file',
      args: { file_path: 'a.txt', content: 'xxxxxxxxxx' },
    },
  ]);
  assert.equal(calls, 1);
});
test('after a stall the next try waits twice as long for content', async () => {
  const waited: number[] = [];
  const guard = new ModelGuard(() => false, {
    wait: async () => {},
    stallMs: 100,
  });
  const result = await guard.execute(request(), async (current) => {
    if (waited.length === 2) return answer('done');
    current.progress?.('connected');
    const started = Date.now();
    await new Promise<void>((resolve) =>
      current.signal.addEventListener('abort', () => resolve()),
    );
    waited.push(Date.now() - started);
    throw current.signal.reason;
  });
  assert.equal(result.message.content, 'done');
  assert.ok(waited[0]! >= 90 && waited[0]! < 180, String(waited));
  assert.ok(waited[1]! >= 190, String(waited));
});
test('the wait for the answer to start grows up to the 5 minutes fetch allows, and a fractional CIRCLE_LLM_TIMEOUT is used as whole milliseconds', async (t) => {
  const before = process.env.CIRCLE_LLM_TIMEOUT;
  process.env.CIRCLE_LLM_TIMEOUT = '45.05';
  cleanup(t, () => {
    if (before === undefined) delete process.env.CIRCLE_LLM_TIMEOUT;
    else process.env.CIRCLE_LLM_TIMEOUT = before;
  });
  const instance = model(t, 'http://127.0.0.1:9/v1', async () => {});
  const timeouts: unknown[] = [];
  (instance as any).openai.chat.completions.create = async (
    _body: unknown,
    options: { timeout: unknown },
  ) => {
    timeouts.push(options.timeout);
    throw new Error('stop here');
  };
  for (const timeoutScale of [undefined, 2, 8]) {
    const input = request();
    input.timeoutScale = timeoutScale;
    await assert.rejects(instance.complete(input), /stop here/);
  }
  assert.deepEqual(timeouts, [45050, 90100, 300000]);
});
test('certificate and TLS failures are not retried: they fail the same way every time', () => {
  for (const code of [
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ERR_SSL_WRONG_VERSION_NUMBER',
  ])
    assert.equal(
      errorKind(
        new OpenAI.APIConnectionError({
          cause: Object.assign(new Error('fetch failed'), {
            cause: Object.assign(new Error('tls'), { code }),
          }),
        }),
      ),
      undefined,
      code,
    );
});
