import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { GatewayModel } from '../src/model.js';
import { defaultSettings, saveCredentials } from '../src/settings.js';
import {
  requestBudget,
  providerInputEstimate,
  RecoveryBudget,
} from '../src/request_budget.js';
import { ModelCompletionFailure } from '../src/model_completion.js';
import type { ModelRequest } from '../src/types.js';
import { scratch, cleanupServer } from './helpers.js';
import { cleanup } from './helpers.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { ContextManager } from '../src/context_middleware.js';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Message } from '../src/types.js';

function answer(
  response: ServerResponse,
  protocol: 'openai' | 'anthropic',
  usage = true,
) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if (protocol === 'openai') {
    response.end(
      'data: ' +
        JSON.stringify({
          choices: [
            { index: 0, delta: { content: 'summary' }, finish_reason: 'stop' },
          ],
          ...(usage
            ? { usage: { prompt_tokens: 100, completion_tokens: 5 } }
            : {}),
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  } else {
    const event = (item: Record<string, unknown>) =>
      response.write(`event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`);
    event({
      type: 'message_start',
      message: {
        id: 'fixture',
        type: 'message',
        role: 'assistant',
        model: 'fixture',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    });
    event({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    event({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'summary' },
    });
    event({ type: 'content_block_stop', index: 0 });
    event({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    });
    event({ type: 'message_stop' });
    response.end();
  }
}
async function fixture(
  t: Parameters<typeof scratch>[0],
  protocol: 'openai' | 'anthropic',
  handle?: (
    body: Record<string, any>,
    response: ServerResponse,
    count: number,
  ) => void,
) {
  const home = scratch(t);
  const bodies: Record<string, any>[] = [];
  const server = createServer(async (request, response) => {
    let data = '';
    for await (const chunk of request) data += chunk;
    const body = JSON.parse(data);
    bodies.push(body);
    if (handle) handle(body, response, bodies.length);
    else answer(response, protocol);
  });
  cleanupServer(t, server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  saveCredentials({ api_key: 'synthetic-only' }, home);
  const settings = defaultSettings();
  settings.auth = {
    ...settings.auth,
    protocol,
    base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    model: 'fixture',
  };
  settings.default_thinking = 'medium';
  settings.models.fixture = {
    context_window: 8192,
    input_limit: 4000,
    output_limit: 2048,
  };
  const model = new GatewayModel(settings, home, undefined, {
    wait: async () => {},
  });
  return { model, bodies, settings, home };
}
function request(): ModelRequest {
  return {
    system: 'Summarize synthetic data.',
    messages: [{ id: 'prompt', role: 'user', content: 'synthetic prompt' }],
    tools: [],
    signal: new AbortController().signal,
    token: () => {},
    enforceBudget: true,
    maxTokens: 2000,
  };
}
for (const protocol of ['openai', 'anthropic'] as const) {
  for (const window of [8192, 32000, 128000, 200000, 1000000]) {
    test(`${protocol} compacts and sends the next real request within a ${window} context`, async (t) => {
      const f = await fixture(t, protocol);
      f.settings.models.fixture = {
        context_window: window,
        input_limit: Math.floor(window * 0.8),
        output_limit: 4096,
      };
      const store = new CheckpointStore(f.home);
      cleanup(t, () => store.close());
      const session = store.create(f.home, 'matrix', 'synthetic matrix');
      store.claimSession(session.id);
      const messages: Message[] = [
        {
          id: 'goal',
          role: 'user',
          content: 'Preserve the full synthetic history.',
        },
        {
          id: 'history',
          role: 'assistant',
          content:
            'SOURCE_BEGIN ' +
            'history '.repeat(Math.ceil(window / 2)) +
            ' SOURCE_END',
        },
        {
          id: 'current',
          role: 'user',
          content: '原样保留这条最新指令 — no tools should run.',
        },
      ];
      const checksum = (value: unknown) =>
        createHash('sha256').update(JSON.stringify(value)).digest('hex');
      store.append(session.id, messages);
      const original = checksum(store.messages(session.id));
      const context = new ContextManager(store, join(f.home, 'data'));
      await context.compact(session.id, f.model, new AbortController().signal);
      const operation = store.compactions.operations(session.id).at(-1)!;
      assert.equal(operation.snapshot.status, 'succeeded');
      assert.equal(operation.snapshot.covered, operation.snapshot.sourceSize);
      assert.ok(
        f.bodies.length > 1,
        'the oversized history uses bounded parts',
      );
      const next = await f.model.complete({
        ...request(),
        messages: context.project(session.id),
        maxTokens: undefined,
      });
      assert.equal(next.message.request_budget!.fits, true);
      assert.equal(next.message.request_budget!.window, window);
      for (const body of f.bodies) {
        const estimate = providerInputEstimate({
          system: body.system,
          messages: body.messages,
          tools: body.tools,
        });
        const output = body.max_completion_tokens ?? body.max_tokens;
        assert.equal(
          typeof output,
          'number',
          'the reserved output cap is sent to the gateway',
        );
        const margin = Math.min(
          16384,
          Math.max(256, Math.ceil(window * 0.8 * 0.1)),
        );
        assert.ok(
          Math.ceil(estimate * 1.5) + margin <= Math.floor(window * 0.8),
        );
        assert.ok(Math.ceil(estimate * 1.5) + output + margin <= window);
      }
      assert.equal(checksum(store.messages(session.id)), original);
      assert.equal(
        context.project(session.id).at(-1)!.content,
        messages.at(-1)!.content,
      );
      assert.match(
        JSON.stringify(f.bodies.at(-1)!.messages),
        /原样保留这条最新指令/,
      );
      assert.equal(
        store.compactions.attempts(operation.snapshot.operationId).length,
        f.bodies.length - 1,
      );
    });
  }
  test(`${protocol} measures the same provider frame it sends and records the actual output cap`, async (t) => {
    const f = await fixture(t, protocol);
    const response = await f.model.complete(request());
    const body = f.bodies[0]!;
    assert.equal(response.message.completion!.output_limit, 2000);
    assert.equal(
      response.message.request_budget!.estimate,
      providerInputEstimate({
        system: body.system,
        messages: body.messages,
        tools: body.tools,
      }),
    );
    assert.equal(response.message.request_budget!.inputLimit, 4000);
    f.settings.models.fixture = {
      context_window: 4096,
      input_limit: 1000,
      output_limit: 1024,
    };
    assert.equal(
      requestBudget(f.model, { ...request(), maxTokens: 1024 }).window,
      4096,
    );
    await assert.rejects(
      f.model.complete({
        ...request(),
        maxTokens: 1024,
        system: 'x'.repeat(30000),
      }),
      /context budget/,
    );
    assert.equal(f.bodies.length, 1, 'local budget failure sends no request');
  });
}
for (const field of ['max_tokens', 'max_completion_tokens'] as const)
  test(`ordinary OpenAI requests send their reserved output using ${field}`, async (t) => {
    const f = await fixture(t, 'openai');
    f.settings.models.fixture!.output_parameter = field;
    const result = await f.model.complete({
      ...request(),
      maxTokens: undefined,
    });
    assert.equal(f.bodies[0]![field], f.model.outputBudget);
    assert.equal(result.message.request_budget!.output, f.bodies[0]![field]);
    assert.equal(result.message.completion!.output_limit, f.bodies[0]![field]);
  });

test('a nested provider limit error constrains only this connection and keeps raw error evidence', async (t) => {
  const f = await fixture(t, 'anthropic', (_body, response) => {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        type: 'error',
        error: {
          code: 'context_length_exceeded',
          message: 'too large',
          max_context_tokens: 4096,
        },
      }),
    );
  });
  await assert.rejects(f.model.complete(request()), (error) => {
    assert.ok(error instanceof ModelCompletionFailure);
    assert.equal(error.code, 'context_limit');
    assert.equal(error.providerError?.contextLimit, 4096);
    return true;
  });
  assert.equal(f.model.contextWindow, 4096);
  assert.equal(f.bodies.length, 1);
  const other = await fixture(t, 'anthropic');
  assert.equal(other.model.contextWindow, 8192);
});

test('a wrong large catalog window recovers to the gateway limits and the next request uses those limits', async (t) => {
  const f = await fixture(t, 'anthropic', (body, response) => {
    const input = Math.ceil(
      providerInputEstimate({
        system: body.system,
        messages: body.messages,
        tools: body.tools,
      }) * 1.5,
    );
    if (input > 5400 || body.max_tokens > 1024) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            code: 'context_length_exceeded',
            message: 'synthetic endpoint has a smaller context',
            max_context_tokens: 8192,
            max_input_tokens: 6000,
            max_output_tokens: 1024,
          },
        }),
      );
    } else answer(response, 'anthropic');
  });
  f.settings.models.fixture = {
    context_window: 200000,
    input_limit: 200000,
    output_limit: 32000,
  };
  const store = new CheckpointStore(f.home);
  cleanup(t, () => store.close());
  const session = store.create(
    f.home,
    'wrong-catalog',
    'synthetic catalog mismatch',
  );
  store.claimSession(session.id);
  store.append(session.id, [
    { id: 'old', role: 'user', content: 'history '.repeat(12000) },
    { id: 'answer', role: 'assistant', content: 'The old task is complete.' },
    { id: 'current', role: 'user', content: 'Continue with this exact input.' },
  ]);
  const context = new ContextManager(store, join(f.home, 'data'));
  await context.compact(session.id, f.model, new AbortController().signal);
  const operation = store.compactions.operations(session.id).at(-1)!;
  assert.equal(operation.snapshot.status, 'succeeded');
  assert.ok(
    operation.snapshot.recoveries > 0 && operation.snapshot.recoveries <= 8,
  );
  assert.equal(operation.snapshot.budget!.window, 8192);
  assert.equal(operation.snapshot.budget!.inputLimit, 6000);
  assert.equal(operation.snapshot.budget!.outputLimit, 1024);
  assert.equal(
    f.settings.models.fixture.context_window,
    200000,
    'observations never rewrite saved configuration',
  );
  const failed = store.compactions
    .attempts(operation.snapshot.operationId)
    .filter((attempt) => attempt.status === 'failed');
  assert.ok(failed.length > 0);
  assert.ok(
    failed.every((attempt) => attempt.providerError?.contextLimit === 8192),
  );
  const next = await f.model.complete({
    ...request(),
    messages: context.project(session.id),
    maxTokens: undefined,
  });
  assert.equal(next.message.request_budget!.fits, true);
  assert.equal(f.bodies.at(-1)!.max_tokens, 1024);
});

test('summary output remains bounded with unknown output capability, small output caps and legacy thinking', async (t) => {
  for (const kind of ['unknown', 'small', 'thinking'] as const) {
    const f = await fixture(t, 'anthropic');
    const name = kind === 'thinking' ? 'claude-sonnet-4-5' : 'fixture';
    f.settings.models[name] = {
      context_window: kind === 'unknown' ? 32000 : 8192,
      ...(kind === 'unknown'
        ? {}
        : { output_limit: kind === 'small' ? 64 : 1536 }),
    };
    const model = new GatewayModel(f.settings, f.home, name, {
      wait: async () => {},
    });
    model.effort = 'high';
    const identity = model.budgetIdentity;
    const store = new CheckpointStore(f.home);
    cleanup(t, () => store.close());
    const session = store.create(f.home, kind, 'synthetic output capability');
    store.claimSession(session.id);
    store.append(session.id, [
      { id: 'old', role: 'user', content: 'data '.repeat(10000) },
      { id: 'current', role: 'user', content: 'Keep this latest input.' },
    ]);
    const context = new ContextManager(store, join(f.home, 'data'));
    await context.compact(session.id, model, new AbortController().signal);
    assert.ok(f.bodies.length > 0);
    if (kind === 'unknown') {
      assert.equal(model.outputLimit, undefined);
      assert.equal(f.bodies[0]!.max_tokens, 4096);
    }
    for (const body of f.bodies) {
      assert.ok(
        body.max_tokens <=
          (kind === 'unknown' ? 4096 : kind === 'small' ? 64 : 1536),
      );
      if (kind === 'thinking') {
        assert.equal(body.thinking.type, 'enabled');
        assert.ok(
          body.thinking.budget_tokens >= 1024 &&
            body.thinking.budget_tokens < body.max_tokens,
        );
      }
    }
    model.effort = '';
    assert.notEqual(model.budgetIdentity, identity);
    const next = await model.complete({
      ...request(),
      messages: context.project(session.id),
      maxTokens: undefined,
      effort: '',
    });
    assert.equal(next.message.request_budget!.fits, true);
    assert.deepEqual(f.bodies.at(-1)!.thinking, { type: 'disabled' });
    assert.equal(f.settings.default_thinking, 'medium');
  }
});
for (const protocol of ['openai', 'anthropic'] as const)
  test(`a smaller provider output limit also constrains the next ordinary ${protocol} request`, async (t) => {
    const f = await fixture(t, protocol, (body, response) => {
      if (body.max_tokens > 1024) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              param: 'max_tokens',
              message: 'requested output too large',
              max_output_tokens: 1024,
            },
          }),
        );
      } else answer(response, protocol);
    });
    await assert.rejects(
      f.model.complete(request()),
      (error) =>
        error instanceof ModelCompletionFailure &&
        error.code === 'output_limit',
    );
    assert.equal(f.model.outputLimit, 1024);
    const result = await f.model.complete({
      ...request(),
      maxTokens: undefined,
    });
    assert.equal(result.message.completion?.output_limit, 1024);
    assert.equal(f.bodies[1]!.max_tokens, 1024);
    assert.equal(f.bodies.length, 2);
  });

test('transport retries share the operation recovery allowance', async (t) => {
  const f = await fixture(t, 'openai', (_body, response) => {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ error: { message: 'synthetic temporary failure' } }),
    );
  });
  const recovery = new RecoveryBudget(2);
  await assert.rejects(
    f.model.complete({ ...request(), recovery }),
    /recovery budget exhausted/,
  );
  assert.equal(f.bodies.length, 3);
  assert.equal(recovery.used, 2);
});
test('missing usage is unknown, not a fabricated zero receipt', async (t) => {
  const f = await fixture(t, 'openai', (_body, response) =>
    answer(response, 'openai', false),
  );
  const observed: Parameters<NonNullable<ModelRequest['observeAttempt']>>[0][] =
    [];
  const response = await f.model.complete({
    ...request(),
    observeAttempt: (e) => observed.push(e),
  });
  assert.equal(response.usageReported, false);
  assert.equal(observed.at(-1)?.usage, undefined);
});

test('cancelling after a provider input receipt retains that usage as incomplete', async (t) => {
  const f = await fixture(t, 'anthropic', (_body, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(
      'event: message_start\ndata: ' +
        JSON.stringify({
          type: 'message_start',
          message: {
            id: 'held',
            type: 'message',
            role: 'assistant',
            model: 'fixture',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 37, output_tokens: 0 },
          },
        }) +
        '\n\n',
    );
  });
  const store = new CheckpointStore(f.home);
  cleanup(t, () => store.close());
  const session = store.create(f.home, 'fixture');
  store.claimSession(session.id);
  store.append(session.id, [
    { id: 'old', role: 'user', content: 'past '.repeat(1400) },
    { id: 'answer', role: 'assistant', content: 'done' },
    { id: 'current', role: 'user', content: 'continue' },
  ]);
  let observed!: () => void;
  const receipt = new Promise<void>((resolve) => (observed = resolve));
  const manager = new ContextManager(store, join(f.home, 'data'), {
    progress: (event) => {
      if (event.snapshot?.usage.input_tokens === 37) observed();
    },
  });
  const controller = new AbortController();
  const running = manager.compact(session.id, f.model, controller.signal);
  const rejected = assert.rejects(running);
  await receipt;
  controller.abort(new Error('stopped by the fixture'));
  await rejected;
  const state = manager.compactor.snapshot(session.id)!;
  assert.equal(state.status, 'cancelled');
  assert.equal(state.usage.input_tokens, 37);
  assert.equal(state.unknownCalls, 1);
  const attempt = store.compactions.attempts(state.operationId)[0]!;
  assert.equal(attempt.usage?.input_tokens, 37);
  assert.notEqual(attempt.usageComplete, true);
  assert.equal(f.bodies.length, 1);
});

test('an explicit in-stream context rejection is never retried with the same request by the transport guard', async (t) => {
  const f = await fixture(t, 'openai', (_body, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      'data: ' +
        JSON.stringify({
          error: {
            code: 'context_length_exceeded',
            message: 'prompt is too long',
            max_context_tokens: 4096,
          },
        }) +
        '\n\n',
    );
  });
  await assert.rejects(
    f.model.complete(request()),
    (error) =>
      error instanceof ModelCompletionFailure && error.code === 'context_limit',
  );
  assert.equal(f.bodies.length, 1);
});
