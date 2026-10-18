import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRuntime } from '../src/runtime.js';
import { GatewayModel } from '../src/model.js';
import {
  defaultSettings,
  saveCredentials,
  saveSettings,
  trustFolder,
} from '../src/settings.js';
import { TITLE_MAX_TOKENS } from '../src/session_title.js';
import { cleanup, scratch } from './helpers.js';

type Protocol = 'openai' | 'anthropic';
type Body = { model: string; max_tokens?: number; messages: any[] };

// What DashScope's OpenAI-compatible mode answers for a message without
// content (issue #153), and the same rule for Anthropic's Messages API.
const DASHSCOPE_REJECTION = {
  error: {
    code: 'invalid_parameter_error',
    param: null,
    message: 'The content field is a required field.',
    type: 'invalid_request_error',
  },
};
function nonEmpty(content: unknown): boolean {
  return (
    (typeof content === 'string' && content.trim() !== '') ||
    (Array.isArray(content) &&
      content.length > 0 &&
      content.every(
        (block) => block?.type !== 'text' || String(block.text).trim() !== '',
      ))
  );
}
// Every row carries non-empty content. An assistant row with tool calls may
// carry '' beside them, as DashScope's own examples send it, but never null.
function contentError(protocol: Protocol, body: Body): string | undefined {
  for (const [index, message] of body.messages.entries()) {
    if (
      protocol === 'openai' &&
      message.role === 'assistant' &&
      message.tool_calls?.length
    ) {
      if (typeof message.content !== 'string') return `messages.${index}`;
    } else if (!nonEmpty(message.content)) return `messages.${index}`;
  }
}

const todos = (...statuses: string[]) => ({
  todos: statuses.map((status, index) => ({
    content: `synthetic step ${index + 1}`,
    status,
  })),
});
// The turns a qwen-like model takes: plan, finish a step, think and be stopped,
// then delete the plan when asked and answer.
const script: (
  | { call: string; args: Record<string, unknown> }
  | { think: string }
  | { text: string }
)[] = [
  {
    call: 'write_todos',
    args: todos('in_progress', 'pending', 'pending'),
  },
  {
    call: 'write_todos',
    args: todos('completed', 'in_progress', 'pending'),
  },
  { think: 'synthetic reasoning before the next step' },
  { call: 'write_todos', args: { todos: [] } },
  { text: 'Plan deleted.' },
];

function openaiChunk(
  response: ServerResponse,
  model: string,
  delta: Record<string, unknown>,
  finish: string | null,
) {
  response.write(
    'data: ' +
      JSON.stringify({
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      }) +
      '\n\n',
  );
}
function anthropicEvent(response: ServerResponse, value: Record<string, any>) {
  response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}
function reply(
  protocol: Protocol,
  response: ServerResponse,
  body: Body,
  step: (typeof script)[number],
  id: string,
) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if (protocol === 'openai') {
    if ('call' in step) {
      // qwen streams an empty content delta beside its tool calls.
      openaiChunk(
        response,
        body.model,
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              index: 0,
              id,
              type: 'function',
              function: {
                name: step.call,
                arguments: JSON.stringify(step.args),
              },
            },
          ],
        },
        null,
      );
      openaiChunk(response, body.model, {}, 'tool_calls');
    } else if ('think' in step) {
      // Thinking, then nothing until the turn is stopped.
      openaiChunk(
        response,
        body.model,
        { reasoning_content: step.think },
        null,
      );
      return;
    } else {
      openaiChunk(response, body.model, { content: step.text }, null);
      openaiChunk(response, body.model, {}, 'stop');
    }
    response.end('data: [DONE]\n\n');
    return;
  }
  anthropicEvent(response, {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  if ('think' in step) {
    anthropicEvent(response, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    });
    anthropicEvent(response, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: step.think },
    });
    return;
  }
  anthropicEvent(response, {
    type: 'content_block_start',
    index: 0,
    content_block:
      'call' in step
        ? { type: 'tool_use', id, name: step.call, input: {} }
        : { type: 'text', text: '' },
  });
  anthropicEvent(response, {
    type: 'content_block_delta',
    index: 0,
    delta:
      'call' in step
        ? { type: 'input_json_delta', partial_json: JSON.stringify(step.args) }
        : { type: 'text_delta', text: step.text },
  });
  anthropicEvent(response, { type: 'content_block_stop', index: 0 });
  anthropicEvent(response, {
    type: 'message_delta',
    delta: {
      stop_reason: 'call' in step ? 'tool_use' : 'end_turn',
      stop_sequence: null,
    },
    usage: { output_tokens: 1 },
  });
  anthropicEvent(response, { type: 'message_stop' });
  response.end();
}

async function strictGateway(
  t: Parameters<typeof scratch>[0],
  protocol: Protocol,
) {
  const requests: { body: Body; rejected?: string }[] = [];
  let turn = 0;
  let thinking: (() => void) | undefined;
  const thinkingSent = new Promise<void>((done) => (thinking = done));
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    if (!text) {
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    const body = JSON.parse(text) as Body;
    const rejected = contentError(protocol, body);
    requests.push({ body, rejected });
    if (rejected) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          protocol === 'openai'
            ? { ...DASHSCOPE_REJECTION, id: 'chatcmpl-synthetic' }
            : {
                type: 'error',
                error: {
                  type: 'invalid_request_error',
                  message: `${rejected}: all messages must have non-empty content`,
                },
              },
        ),
      );
      return;
    }
    if (body.max_tokens === TITLE_MAX_TOKENS) {
      reply(protocol, response, body, { text: 'Synthetic title' }, 'title');
      return;
    }
    const step = script[turn++];
    if (!step) throw new Error('the script has no more turns');
    reply(protocol, response, body, step, `call-${turn}`);
    if ('think' in step) thinking!();
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
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('no address');
  return {
    base: `http://127.0.0.1:${address.port}${protocol === 'openai' ? '/v1' : ''}`,
    requests,
    turns: () =>
      requests.filter(
        (request) => request.body.max_tokens !== TITLE_MAX_TOKENS,
      ),
    thinkingSent,
  };
}

for (const protocol of ['openai', 'anthropic'] as const)
  test(`${protocol}: deleting a plan after a stopped turn sends every row with content to a strict gateway`, async (t) => {
    const root = scratch(t);
    const workspace = join(root, 'workspace'),
      home = join(root, 'home');
    mkdirSync(workspace);
    mkdirSync(home);
    const gateway = await strictGateway(t, protocol);
    const settings = trustFolder(defaultSettings(), workspace);
    settings.initialized = true;
    settings.update_check = false;
    settings.default_thinking = '';
    settings.auth = {
      ...settings.auth,
      protocol,
      base_url: gateway.base,
      model: 'qwen-synthetic',
    };
    saveCredentials({ api_key: 'synthetic' }, home);
    saveSettings(settings, home);
    const runtime = new AgentRuntime({
      home,
      workspace,
      settings,
      model: new GatewayModel(settings, home),
      headless: true,
    });
    cleanup(t, () => runtime.close());

    // Plan, finish a step, then stop the turn while the model is thinking.
    const thinkingSeen = new Promise<void>((done) => {
      const stop = runtime.bus.subscribe((event) => {
        if (event.kind === 'llm_token' && event.payload.thinking) {
          stop();
          done();
        }
      });
    });
    const first = runtime.harness.run('make a three step plan and start it');
    await gateway.thinkingSent;
    await thinkingSeen;
    await runtime.cancel();
    await assert.rejects(first);
    assert.deepEqual(
      runtime.todos.map((todo) => todo.status),
      ['completed', 'in_progress', 'pending'],
    );
    const stored = structuredClone(runtime.store.messages(runtime.session.id));
    const partial = stored.at(-1)!;
    assert.equal(partial.role, 'assistant');
    assert.equal(partial.interrupted, true);
    assert.equal(partial.content, '');
    assert.equal(partial.thinking, 'synthetic reasoning before the next step');

    // Ask for the plan to be deleted.
    const second = await runtime.harness.run('删除当前计划');
    assert.equal(second.answer, 'Plan deleted.');
    assert.deepEqual(runtime.todos, []);
    assert.deepEqual(
      gateway.requests.filter((request) => request.rejected),
      [],
      'the strict gateway accepted every request',
    );
    const turns = gateway.turns();
    assert.equal(turns.length, 5);
    const deletion = turns[3]!.body.messages;
    const roles = deletion.map((message: any) => message.role);
    if (protocol === 'openai') {
      assert.deepEqual(roles, [
        'system',
        'user',
        'assistant',
        'tool',
        'assistant',
        'tool',
        'user',
      ]);
      for (const message of deletion.filter(
        (message: any) => message.tool_calls,
      ))
        assert.equal(
          message.content,
          '',
          'tool-call rows carry an empty string',
        );
    } else
      assert.deepEqual(roles, [
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
      ]);
    assert.ok(
      !JSON.stringify(deletion).includes('synthetic reasoning'),
      'the stopped thinking is not sent',
    );
    assert.match(JSON.stringify(deletion.at(-1)), /删除当前计划/);

    // Stored history keeps the stopped partial and everything before it.
    const after = runtime.store.messages(runtime.session.id);
    assert.deepEqual(after.slice(0, stored.length), stored);
    assert.ok(after.some((message) => message.interrupted === true));
  });
