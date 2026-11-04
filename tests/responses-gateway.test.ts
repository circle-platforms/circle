import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayModel } from '../src/model.js';
import {
  defaultSettings,
  saveCredentials,
  saveSettings,
  trustFolder,
} from '../src/settings.js';
import { normalizeBaseUrl, resolveEndpoint } from '../src/probe.js';
import { connectionModels } from '../src/connection_models.js';
import { pruneMessages } from '../src/middleware/tool_result_prune.js';
import { summaryMessages } from '../src/media.js';
import { messageTokenEstimate } from '../src/request_budget.js';
import { SetupCard, SetupFlow } from '../src/tui/setup_flow.js';
import type { Message, ModelRequest } from '../src/types.js';

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
) => void;
async function server(
  t: { after(fn: () => void | Promise<void>): void },
  handler: Handler,
): Promise<string> {
  const instance = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    handler(request, response, text ? JSON.parse(text) : {});
  });
  await new Promise<void>((resolve) =>
    instance.listen(0, '127.0.0.1', resolve),
  );
  t.after(() => {
    instance.closeAllConnections();
    return new Promise<void>((resolve) => instance.close(() => resolve()));
  });
  const address = instance.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}
function scratch(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'circle-responses-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
/** A Responses stream: every event is named and carries its own type. */
function stream(response: ServerResponse, events: Record<string, unknown>[]) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of events)
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}
const completed = (
  usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 4 },
  status: 'completed' | 'incomplete' = 'completed',
  reason?: string,
) => ({
  type: status === 'completed' ? 'response.completed' : 'response.incomplete',
  response: {
    id: 'resp_1',
    model: 'served-model',
    status,
    ...(reason ? { incomplete_details: { reason } } : {}),
    usage,
  },
});
function model(
  base: string,
  home: string,
  key = 'test-key',
  thinking = '',
): GatewayModel {
  const settings = defaultSettings();
  settings.auth = {
    ...settings.auth,
    protocol: 'responses',
    base_url: base + '/v1',
    model: 'gpt-test',
  };
  settings.default_thinking = thinking;
  saveCredentials({ api_key: key }, home);
  return new GatewayModel(settings, home);
}
function request(
  messages: Message[],
  extra: Partial<ModelRequest> = {},
): ModelRequest {
  return {
    system: 'you are circle',
    messages,
    tools: [],
    signal: new AbortController().signal,
    token: () => {},
    ...extra,
  };
}
const toolTurn = [
  {
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'reasoning', id: 'rs_1', summary: [] },
  },
  {
    type: 'response.reasoning_summary_part.added',
    output_index: 0,
    item_id: 'rs_1',
    summary_index: 0,
  },
  {
    type: 'response.reasoning_summary_text.delta',
    output_index: 0,
    item_id: 'rs_1',
    summary_index: 0,
    delta: 'look at the file',
  },
  {
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'look at the file' }],
      encrypted_content: 'sealed-1',
    },
  },
  {
    type: 'response.output_item.added',
    output_index: 1,
    item: {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'read_file',
      arguments: '',
    },
  },
  {
    type: 'response.function_call_arguments.delta',
    output_index: 1,
    item_id: 'fc_1',
    delta: '{"file_',
  },
  {
    type: 'response.function_call_arguments.delta',
    output_index: 1,
    item_id: 'fc_1',
    delta: 'path":"a.txt"}',
  },
  completed({
    input_tokens: 30,
    output_tokens: 7,
    input_tokens_details: { cached_tokens: 12 },
  }),
];

test('a Responses connection sends the conversation statelessly and reads reasoning, calls and usage from the stream', async (t) => {
  const seen: { url?: string; auth?: string; body: Record<string, unknown> }[] =
    [];
  const base = await server(t, (req, res, body) => {
    seen.push({ url: req.url, auth: req.headers.authorization, body });
    stream(res, toolTurn);
  });
  const home = scratch(t);
  const gateway = model(base, home, 'test-key', 'high');
  const tokens: [string, boolean][] = [];
  const result = await gateway.complete(
    request(
      [
        { id: 'u1', role: 'user', content: 'read a.txt' },
        { id: 's1', role: 'system', content: 'plan mode is off' },
      ],
      {
        tools: [
          {
            name: 'read_file',
            description: 'read a file',
            parameters: { type: 'object', properties: {} },
          } as unknown as ModelRequest['tools'][number],
        ],
        maxTokens: 900,
        token: (text, thinking) => tokens.push([text, Boolean(thinking)]),
      },
    ),
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, '/v1/responses');
  assert.equal(seen[0]!.auth, 'Bearer test-key');
  const body = seen[0]!.body;
  assert.equal(body.model, 'gpt-test');
  assert.equal(body.instructions, 'you are circle');
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' });
  assert.equal(body.max_output_tokens, 900);
  assert.deepEqual(body.tools, [
    {
      type: 'function',
      name: 'read_file',
      description: 'read a file',
      parameters: { type: 'object', properties: {} },
      strict: false,
    },
  ]);
  assert.deepEqual(body.input, [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'read a.txt' }],
    },
    {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'plan mode is off' }],
    },
  ]);
  assert.deepEqual(result.message.tool_calls, [
    { id: 'call_1', name: 'read_file', args: { file_path: 'a.txt' } },
  ]);
  assert.equal(result.message.thinking, 'look at the file');
  assert.deepEqual(tokens, [['look at the file', true]]);
  assert.equal(result.message.model, 'served-model');
  assert.equal(result.message.completion?.reason, 'tool_calls');
  assert.equal(result.message.completion?.provider_reason, 'completed');
  assert.equal(result.message.truncated, undefined);
  assert.deepEqual(result.message.reasoning_items, [
    {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'look at the file' }],
      encrypted_content: 'sealed-1',
    },
  ]);
  assert.ok(result.message.thinking_scope);
  assert.equal(result.message.provider_content, undefined);
  assert.deepEqual(result.usage, {
    input_tokens: 30,
    output_tokens: 7,
    cache_read_tokens: 12,
  });
});

test('the next request replays encrypted reasoning before its call, and tool pictures stay in the tool result', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const base = await server(t, (_req, res, body) => {
    bodies.push(body);
    stream(
      res,
      bodies.length === 1
        ? toolTurn
        : [
            {
              type: 'response.output_text.delta',
              output_index: 0,
              item_id: 'msg_1',
              delta: 'done',
            },
            completed(),
          ],
    );
  });
  const home = scratch(t);
  const gateway = model(base, home);
  const user: Message = { id: 'u1', role: 'user', content: 'read a.txt' };
  const first = await gateway.complete(request([user]));
  const result: Message = {
    id: 't1',
    role: 'tool',
    tool_call_id: 'call_1',
    content: 'a picture',
    attachments: [
      {
        kind: 'image',
        mime_type: 'image/png',
        filename: 'a.png',
        data: 'iVBORw0KGgo=',
        sha256: createHash('sha256')
          .update(Buffer.from('iVBORw0KGgo=', 'base64'))
          .digest('hex'),
      },
    ],
  };
  const second = await gateway.complete(request([user, first.message, result]));
  assert.equal(second.message.content, 'done');
  assert.equal(second.message.completion?.reason, 'stop');
  assert.deepEqual((bodies[1]!.input as unknown[]).slice(1), [
    {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'look at the file' }],
      encrypted_content: 'sealed-1',
    },
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'read_file',
      arguments: '{"file_path":"a.txt"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call_1',
      output: [
        { type: 'input_text', text: 'a picture' },
        {
          type: 'input_image',
          image_url: 'data:image/png;base64,iVBORw0KGgo=',
          detail: 'auto',
        },
      ],
    },
  ]);
});

test('reasoning is never replayed to another key, nor from a stopped thinking-only turn', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const base = await server(t, (_req, res, body) => {
    bodies.push(body);
    stream(res, bodies.length === 1 ? toolTurn : [completed()]);
  });
  const home = scratch(t);
  const user: Message = { id: 'u1', role: 'user', content: 'read a.txt' };
  const first = await model(base, home, 'key-one').complete(request([user]));
  // The same endpoint and model under another key is another account.
  await model(base, home, 'key-two').complete(
    request([user, first.message, { ...tool, id: 't1' }]),
  );
  const types = (input: unknown) =>
    (input as { type: string }[]).map((item) => item.type);
  assert.deepEqual(types(bodies[1]!.input), [
    'message',
    'function_call',
    'function_call_output',
  ]);
  // A turn stopped while thinking has nothing after its reasoning to send.
  const stopped: Message = {
    ...first.message,
    content: '',
    tool_calls: [],
    interrupted: true,
  };
  await model(base, home, 'key-one').complete(
    request([user, stopped, { id: 'u2', role: 'user', content: 'go on' }]),
  );
  assert.deepEqual(types(bodies[2]!.input), ['message', 'message']);
});
const tool: Message = {
  id: 't1',
  role: 'tool',
  tool_call_id: 'call_1',
  content: 'text',
};

test('an endpoint that cannot read the replayed reasoning gets the turn once more without it', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const base = await server(t, (_req, res, body) => {
    bodies.push(body);
    if (bodies.length === 1) return stream(res, toolTurn);
    if (bodies.length === 2) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          error: {
            type: 'invalid_request_error',
            code: 'invalid_encrypted_content',
            message: 'The encrypted content could not be verified.',
          },
        }),
      );
    }
    stream(res, [completed()]);
  });
  const home = scratch(t);
  const gateway = model(base, home);
  const user: Message = { id: 'u1', role: 'user', content: 'read a.txt' };
  const first = await gateway.complete(request([user]));
  const notices: string[] = [];
  await gateway.complete(
    request([user, first.message, tool], {
      notice: (event) => notices.push(event.event),
    }),
  );
  assert.equal(bodies.length, 3);
  const types = (input: unknown) =>
    (input as { type: string }[]).map((item) => item.type);
  assert.ok(types(bodies[1]!.input).includes('reasoning'));
  assert.ok(!types(bodies[2]!.input).includes('reasoning'));
  assert.deepEqual(notices, ['thinking_signature_retry']);
  // The rejection is remembered: later requests leave that reasoning out at once.
  await gateway.complete(request([user, first.message, tool]));
  assert.ok(!types(bodies[3]!.input).includes('reasoning'));
});

test('a cut-off answer is truncated, text that arrives whole is read, and a failed response is an error', async (t) => {
  let turn = 0;
  const base = await server(t, (_req, res) => {
    turn++;
    if (turn === 1)
      return stream(res, [
        {
          type: 'response.output_text.delta',
          output_index: 0,
          item_id: 'msg_1',
          delta: 'half an ans',
        },
        completed(
          { input_tokens: 5, output_tokens: 50 },
          'incomplete',
          'max_output_tokens',
        ),
      ]);
    if (turn === 2)
      return stream(res, [
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: 'msg_2',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'whole', annotations: [] }],
          },
        },
        completed(),
      ]);
    stream(res, [
      {
        type: 'response.failed',
        response: {
          id: 'resp_3',
          status: 'failed',
          error: { code: 'invalid_prompt', message: 'the prompt was refused' },
        },
      },
    ]);
  });
  const home = scratch(t);
  const gateway = model(base, home);
  const ask = (messages: Message[]) => gateway.complete(request(messages));
  const user: Message = { id: 'u1', role: 'user', content: 'hi' };
  const cut = await ask([user]);
  assert.equal(cut.message.content, 'half an ans');
  assert.equal(cut.message.completion?.reason, 'length');
  assert.equal(cut.message.completion?.provider_reason, 'max_output_tokens');
  assert.equal(cut.message.truncated, true);
  const whole = await ask([user]);
  assert.equal(whole.message.content, 'whole');
  await assert.rejects(
    new GatewayModel(gateway.settings, home, undefined, {
      wait: async () => {},
    }).complete(request([user])),
    /the prompt was refused/,
  );
});

test('a Responses endpoint that refuses include is asked again without it', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  const base = await server(t, (_req, res, body) => {
    bodies.push(body);
    if (bodies.length === 1) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          error: {
            type: 'invalid_request_error',
            param: 'include',
            message: "Unsupported parameter: 'include'.",
          },
        }),
      );
    }
    stream(res, [completed()]);
  });
  const home = scratch(t);
  await model(base, home).complete(
    request([{ id: 'u1', role: 'user', content: 'hi' }]),
  );
  assert.equal(bodies.length, 2);
  assert.ok('include' in bodies[0]!);
  assert.ok(!('include' in bodies[1]!));
  assert.equal(bodies[1]!.store, false);
});

test('Responses connections list models like OpenAI ones and setup can choose them', async (t) => {
  const base = await server(t, (req, res) => {
    assert.equal(req.url, '/v1/models');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'gpt-test' }] }));
  });
  assert.equal(normalizeBaseUrl(base + '/v1/', 'responses'), base + '/v1');
  assert.throws(() => normalizeBaseUrl(base, 'gopher'), /responses/);
  const found = await resolveEndpoint(base + '/v1', 'key', {
    protocol: 'responses',
  });
  assert.equal(found.protocol, 'responses');
  assert.deepEqual(found.models, ['gpt-test']);
  const preset = await connectionModels(
    base + '/v1',
    'key',
    'openai-responses',
  );
  assert.equal(preset.protocol, 'responses');
  const flow = new SetupFlow(scratch(t));
  flow.baseUrl = base + '/v1';
  flow.chooseProtocol(2);
  assert.equal(flow.protocol, 'responses');
  flow.use('gpt-test');
  assert.equal(flow.auth().protocol, 'responses');
  // The first-run card offers the same three kinds, by arrow or by number.
  const card = new SetupCard(new SetupFlow(scratch(t)));
  card.flow.baseUrl = base + '/v1';
  card.flow.step = 'protocol';
  assert.deepEqual(card.state().options, [
    'OpenAI-style API',
    'Anthropic-style API',
    'OpenAI Responses API',
  ]);
  card.handle('up', '');
  assert.equal(card.flow.focus, 2);
  card.handle('enter', '');
  assert.equal(card.flow.protocol, 'responses');
  const byNumber = new SetupCard(new SetupFlow(scratch(t)));
  byNumber.flow.baseUrl = base + '/v1';
  byNumber.flow.step = 'protocol';
  byNumber.handle('3', '3');
  assert.equal(byNumber.flow.protocol, 'responses');
});

test('stripped thinking, summaries and the budget handle encrypted reasoning', () => {
  const message: Message = {
    id: 'a1',
    role: 'assistant',
    content: 'answer',
    thinking: 'why',
    reasoning_items: [
      {
        type: 'reasoning',
        id: 'rs',
        summary: [],
        encrypted_content: 'x'.repeat(4000),
      },
    ],
  };
  const [stripped] = pruneMessages([message], {
    prunedIds: [],
    stripThinkingIds: ['a1'],
  } as never);
  assert.equal(stripped!.reasoning_items, undefined);
  assert.equal(stripped!.thinking, undefined);
  assert.ok(!('reasoning_items' in (summaryMessages([message])[0] as object)));
  assert.ok(
    messageTokenEstimate([message]) >
      messageTokenEstimate([{ ...message, reasoning_items: undefined }]) + 500,
  );
});

test('CLI on a Responses connection writes a file, stores the reasoning and replays it after a restart', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const bodies: Record<string, unknown>[] = [];
  const base = await server(t, (_req, res, body) => {
    bodies.push(body);
    if (bodies.length === 1)
      return stream(res, [
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'reasoning',
            id: 'rs_cli',
            summary: [{ type: 'summary_text', text: 'write it' }],
            encrypted_content: 'sealed-cli',
          },
        },
        {
          type: 'response.output_item.done',
          output_index: 1,
          item: {
            type: 'function_call',
            id: 'fc_cli',
            call_id: 'call_cli',
            name: 'write_file',
            arguments: JSON.stringify({
              file_path: 'actual.txt',
              content: 'actual side effect',
            }),
          },
        },
        completed(),
      ]);
    stream(res, [
      {
        type: 'response.output_text.delta',
        output_index: 0,
        item_id: 'msg',
        delta: 'done',
      },
      completed(),
    ]);
  });
  let settings = defaultSettings();
  settings.initialized = true;
  settings.auth = {
    ...settings.auth,
    protocol: 'responses',
    base_url: base + '/v1',
    model: 'gpt-test',
  };
  settings = trustFolder(settings, workspace);
  saveSettings(settings, home);
  saveCredentials({ api_key: 'test-key' }, home);
  const run = (
    args: string[],
  ): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolveRun, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/cli.ts', ...args],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            CIRCLE_HOME: home,
            CIRCLE_NO_MODELS_REFRESH: '1',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => (stdout += data));
      child.stderr.on('data', (data) => (stderr += data));
      child.once('error', reject);
      child.once('close', (code) => resolveRun({ code, stdout, stderr }));
      child.stdin.end();
    });
  const first = await run(['-p', 'write', workspace, '--yolo']);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, 'done\n');
  assert.equal(
    readFileSync(join(workspace, 'actual.txt'), 'utf8'),
    'actual side effect',
  );
  const types = (input: unknown) =>
    (input as { type: string }[]).map((item) => item.type);
  // Within the turn: reasoning, the call and its result go back.
  assert.deepEqual(types(bodies[1]!.input).slice(-3), [
    'reasoning',
    'function_call',
    'function_call_output',
  ]);
  const next = await run(['-p', 'next', workspace, '-c']);
  assert.equal(next.code, 0, next.stderr);
  const input = bodies[2]!.input as Record<string, unknown>[];
  const reasoning = input.find((item) => item.type === 'reasoning');
  assert.equal(reasoning?.encrypted_content, 'sealed-cli');
  const output = input.find((item) => item.type === 'function_call_output');
  assert.match(String(output?.output), /Wrote/);
  assert.deepEqual(input.at(-1), {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'next' }],
  });
  // Stored history (the checkpoint database) holds the sealed reasoning, never the key.
  const db = new DatabaseSync(join(home, 'circle.sqlite'), { readOnly: true });
  t.after(() => db.close());
  const stored = (
    db.prepare('SELECT * FROM sqlite_master').all() as {
      name: string;
      type: string;
    }[]
  )
    .filter((row) => row.type === 'table')
    .flatMap((row) => db.prepare(`SELECT * FROM "${row.name}"`).all())
    .map((row) => JSON.stringify(row))
    .join('\n');
  assert.match(stored, /sealed-cli/);
  assert.doesNotMatch(stored, /test-key/);
});
