import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayModel } from '../src/model.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings, saveCredentials } from '../src/settings.js';
import { validateMessages } from '../src/session_graph.js';
import type { Message } from '../src/types.js';

// A stand-in for Gemini's OpenAI-compatible route as Google documents it and as the
// endpoint streams it: each call arrives whole in one delta without `index`, only the
// first call of a step carries `extra_content.google.thought_signature`, and a request
// whose current turn has a step without its signature is refused with a 400.
const GEMINI_400 = {
  error: {
    code: 400,
    message:
      'Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance.',
    status: 'INVALID_ARGUMENT',
  },
};
type Body = Record<string, unknown>;
type WireCall = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
  extra_content?: unknown;
};
type WireMessage = { role: string; content?: unknown; tool_calls?: WireCall[] };

async function server(
  t: { after(fn: () => void | Promise<void>): void },
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    body: Body,
  ) => void,
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
  const root = mkdtempSync(join(tmpdir(), 'circle-gemini-signature-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function sse(response: ServerResponse, data: unknown): void {
  response.write('data: ' + JSON.stringify(data) + '\n\n');
}
function signature(call: WireCall | undefined): unknown {
  const extra = call?.extra_content as
    { google?: { thought_signature?: unknown } } | undefined;
  return extra?.google?.thought_signature;
}
/** Google's rule: in the current turn, the first call of every step carries its signature. */
function missingSignature(body: Body): boolean {
  const messages = body.messages as WireMessage[];
  let start = 0;
  messages.forEach((message, index) => {
    if (message.role === 'user') start = index;
  });
  return messages
    .slice(start)
    .some(
      (message) =>
        message.role === 'assistant' &&
        message.tool_calls?.length &&
        typeof signature(message.tool_calls[0]) !== 'string',
    );
}
// The session title is asked for beside the turn; it is not part of the tool loop.
function titleRequest(body: Body, response: ServerResponse): boolean {
  const first = (body.messages as WireMessage[] | undefined)?.find(
    (message) => message.role === 'user',
  );
  if (!String(first?.content).startsWith('<conversation>')) return false;
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  sse(response, {
    choices: [{ index: 0, delta: { content: 'title' }, finish_reason: 'stop' }],
  });
  response.end('data: [DONE]\n\n');
  return true;
}
function refuse(response: ServerResponse): void {
  response.writeHead(400, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(GEMINI_400));
}
function geminiSettings(base: string, model = 'gemini-4-hydrogen') {
  const settings = defaultSettings();
  settings.auth = {
    ...settings.auth,
    base_url: base + '/v1beta/openai',
    model,
  };
  return settings;
}

test('a Gemini tool step keeps its thought signature, so the next request of the turn is accepted', async (t) => {
  const bodies: Body[] = [];
  const base = await server(t, (_request, response, body) => {
    if (titleRequest(body, response)) return;
    bodies.push(body);
    if (missingSignature(body)) return refuse(response);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const step = bodies.length;
    sse(response, {
      choices: [
        {
          index: 0,
          delta:
            step === 1
              ? {
                  role: 'assistant',
                  tool_calls: [
                    {
                      extra_content: { google: { thought_signature: 'SIG_A' } },
                      function: {
                        name: 'read_file',
                        arguments: JSON.stringify({ file_path: 'one.txt' }),
                      },
                      id: 'call_one',
                      type: 'function',
                    },
                  ],
                }
              : { role: 'assistant', content: 'read it' },
          finish_reason: step === 1 ? 'tool_calls' : 'stop',
        },
      ],
    });
    response.end('data: [DONE]\n\n');
  });
  const root = scratch(t);
  const home = join(root, 'home');
  writeFileSync(join(root, 'one.txt'), 'first file');
  const settings = geminiSettings(base);
  saveCredentials({ api_key: 'test-key' }, home);
  const runtime = new AgentRuntime({
    workspace: root,
    home,
    userHome: root,
    localContext: true,
    headless: true,
    model: new GatewayModel(settings, home),
    settings,
  });
  let stored: Message[];
  try {
    assert.equal((await runtime.harness.run('read one.txt')).answer, 'read it');
    stored = runtime.store.messages(runtime.session.id);
  } finally {
    await runtime.close();
  }
  assert.equal(bodies.length, 2);
  const assistant = (bodies[1]!.messages as WireMessage[]).find(
    (message) => message.role === 'assistant',
  );
  assert.deepEqual(assistant?.tool_calls, [
    {
      id: 'call_one',
      type: 'function',
      function: {
        name: 'read_file',
        arguments: JSON.stringify({ file_path: 'one.txt' }),
      },
      extra_content: { google: { thought_signature: 'SIG_A' } },
    },
  ]);
  // Saved with the call, so a resumed session or a restarted step still sends it.
  const saved = stored.find((message) => message.tool_calls?.length);
  assert.deepEqual(saved?.tool_calls?.[0]?.extra_content, {
    google: { thought_signature: 'SIG_A' },
  });

  // A new client on the same connection, as after a restart, replays it from history.
  const replayed: Body[] = [];
  const next = await server(t, (_request, response, body) => {
    replayed.push(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(response, {
      choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
    });
    response.end('data: [DONE]\n\n');
  });
  const history: Message[] = [
    ...stored.filter((message) => message.role !== 'system'),
    { id: 'again', role: 'user', content: 'again' },
  ];
  const send = (model: GatewayModel) =>
    model.complete({
      system: 'system',
      messages: history,
      tools: [],
      signal: new AbortController().signal,
      token: () => {},
    });
  const sameConnection = geminiSettings(base);
  await send(new GatewayModel(sameConnection, home));
  assert.equal(bodies.length, 3);
  assert.equal(
    signature(
      (bodies[2]!.messages as WireMessage[]).find(
        (message) => message.tool_calls?.length,
      )?.tool_calls?.[0],
    ),
    'SIG_A',
  );
  // Another endpoint, or another model on this one, never receives it.
  await send(new GatewayModel(geminiSettings(next), home));
  await send(new GatewayModel(geminiSettings(base, 'gemini-3.5-flash'), home));
  for (const body of [replayed[0]!, bodies[3]!]) {
    const call = (body.messages as WireMessage[]).find(
      (message) => message.tool_calls?.length,
    )?.tool_calls?.[0];
    assert.equal(call?.id, 'call_one');
    assert.equal('extra_content' in (call ?? {}), false);
  }
});

test('index-less parallel Gemini calls stay separate and only the signed call sends its signature back', async (t) => {
  const bodies: Body[] = [];
  const base = await server(t, (_request, response, body) => {
    if (titleRequest(body, response)) return;
    bodies.push(body);
    if (missingSignature(body)) return refuse(response);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (bodies.length > 1) {
      sse(response, {
        choices: [
          { index: 0, delta: { content: 'both read' }, finish_reason: 'stop' },
        ],
      });
      response.end('data: [DONE]\n\n');
      return;
    }
    // The signature and the start of the arguments may come before the call's identity.
    sse(response, {
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                extra_content: { google: { thought_signature: 'SIG_B' } },
                function: { arguments: '{"file_path":' },
              },
            ],
          },
        },
      ],
    });
    sse(response, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                function: { name: 'read_file', arguments: '"one.txt"}' },
                id: 'call_one',
                type: 'function',
              },
            ],
          },
        },
      ],
    });
    // The next call may start the same way, after a call that is already whole.
    sse(response, {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ function: { arguments: '{"file_path":' } }] },
        },
      ],
    });
    sse(response, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                function: { name: 'read_file', arguments: '"two.txt"}' },
                id: 'call_two',
                type: 'function',
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    response.end('data: [DONE]\n\n');
  });
  const root = scratch(t);
  const home = join(root, 'home');
  writeFileSync(join(root, 'one.txt'), 'first file');
  writeFileSync(join(root, 'two.txt'), 'second file');
  const settings = geminiSettings(base);
  saveCredentials({ api_key: 'test-key' }, home);
  const runtime = new AgentRuntime({
    workspace: root,
    home,
    userHome: root,
    localContext: true,
    headless: true,
    model: new GatewayModel(settings, home),
    settings,
  });
  try {
    assert.equal(
      (await runtime.harness.run('read both files')).answer,
      'both read',
    );
  } finally {
    await runtime.close();
  }
  assert.equal(bodies.length, 2);
  const messages = bodies[1]!.messages as WireMessage[];
  const assistant = messages.find((message) => message.role === 'assistant');
  assert.deepEqual(assistant?.tool_calls, [
    {
      id: 'call_one',
      type: 'function',
      function: {
        name: 'read_file',
        arguments: JSON.stringify({ file_path: 'one.txt' }),
      },
      extra_content: { google: { thought_signature: 'SIG_B' } },
    },
    {
      id: 'call_two',
      type: 'function',
      function: {
        name: 'read_file',
        arguments: JSON.stringify({ file_path: 'two.txt' }),
      },
    },
  ]);
  const results = messages.filter((message) => message.role === 'tool');
  assert.equal(results.length, 2);
  assert.match(String(results[0]!.content), /first file/);
  assert.match(String(results[1]!.content), /second file/);
});

test('a step Circle rewrites for privacy is not replayed with its thought, and stays valid', async (t) => {
  const bodies: Body[] = [];
  const secret = 'Password=Syn9theticRejectedValue';
  const base = await server(t, (_request, response, body) => {
    if (titleRequest(body, response)) return;
    bodies.push(body);
    if (missingSignature(body)) return refuse(response);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(response, {
      choices: [
        {
          index: 0,
          delta:
            bodies.length === 1
              ? {
                  // Gemini signs the step on its first call; the secret is in the second.
                  tool_calls: [
                    {
                      extra_content: { google: { thought_signature: 'SIG_C' } },
                      function: {
                        name: 'read_file',
                        arguments: JSON.stringify({ file_path: 'one.txt' }),
                      },
                      id: 'call_read',
                      type: 'function',
                    },
                    {
                      function: {
                        name: 'memory_write',
                        arguments: JSON.stringify({ content: secret }),
                      },
                      id: 'call_secret',
                      type: 'function',
                    },
                  ],
                }
              : { content: 'not saved' },
          finish_reason: bodies.length === 1 ? 'tool_calls' : 'stop',
        },
      ],
    });
    response.end('data: [DONE]\n\n');
  });
  const root = scratch(t);
  const home = join(root, 'home');
  writeFileSync(join(root, 'one.txt'), 'first file');
  const settings = geminiSettings(base);
  saveCredentials({ api_key: 'test-key' }, home);
  const runtime = new AgentRuntime({
    workspace: root,
    home,
    userHome: root,
    localContext: true,
    headless: true,
    model: new GatewayModel(settings, home),
    settings,
  });
  let stored: Message[];
  try {
    assert.equal(
      (await runtime.harness.run('remember my password')).answer,
      'not saved',
    );
    stored = runtime.store.messages(runtime.session.id);
  } finally {
    await runtime.close();
  }
  assert.equal(bodies.length, 2);
  const [read, write] = (bodies[1]!.messages as WireMessage[]).find(
    (message) => message.tool_calls?.length,
  )!.tool_calls!;
  assert.equal(read?.id, 'call_read');
  assert.equal(signature(read), 'skip_thought_signature_validator');
  assert.equal(write?.id, 'call_secret');
  assert.deepEqual(JSON.parse(write!.function!.arguments!), { rejected: true });
  assert.equal('extra_content' in write!, false);
  assert.doesNotMatch(JSON.stringify(bodies[1]), /SIG_C|Syn9thetic/);
  assert.doesNotMatch(JSON.stringify(stored), /SIG_C|Syn9thetic/);
});

test('streams without an index: empty ids, an indexed call continued without one, a later part of a signed call', async (t) => {
  const streams: unknown[][] = [
    // Two whole calls whose ids are empty stay two calls.
    [
      {
        tool_calls: [
          {
            id: '',
            function: { name: 'read_file', arguments: '{"file_path":"a"}' },
          },
        ],
      },
      {
        tool_calls: [
          {
            id: '',
            function: { name: 'read_file', arguments: '{"file_path":"b"}' },
          },
        ],
      },
    ],
    // A part without an index continues the indexed call before it.
    [
      {
        tool_calls: [
          {
            index: 0,
            id: 'a',
            function: { name: 'read_file', arguments: '{"file_p' },
          },
        ],
      },
      { tool_calls: [{ function: { arguments: 'ath":"x"}' } }] },
    ],
    // A later part's `extra_content` without the signature keeps it.
    [
      {
        tool_calls: [
          {
            id: 's',
            extra_content: { google: { thought_signature: 'S' } },
            function: { name: 'read_file', arguments: '{"file_path":' },
          },
        ],
      },
      {
        tool_calls: [
          {
            id: 's',
            extra_content: { google: {}, other: 1 },
            function: { arguments: '"x"}' },
          },
        ],
      },
    ],
  ];
  let next = 0;
  const base = await server(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const delta of streams[next++]!)
      sse(response, { choices: [{ index: 0, delta }] });
    sse(response, {
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    });
    response.end('data: [DONE]\n\n');
  });
  const home = scratch(t);
  saveCredentials({ api_key: 'test-key' }, home);
  const model = new GatewayModel(geminiSettings(base), home);
  const calls = async () =>
    (
      await model.complete({
        system: 'system',
        messages: [{ id: 'u', role: 'user', content: 'read' }],
        tools: [],
        signal: new AbortController().signal,
        token: () => {},
      })
    ).message.tool_calls!;
  assert.deepEqual(
    (await calls()).map((call) => [call.name, call.raw_args]),
    [
      ['read_file', '{"file_path":"a"}'],
      ['read_file', '{"file_path":"b"}'],
    ],
  );
  assert.deepEqual(await calls(), [
    { id: 'a', name: 'read_file', args: { file_path: 'x' } },
  ]);
  assert.deepEqual(await calls(), [
    {
      id: 's',
      name: 'read_file',
      args: { file_path: 'x' },
      extra_content: { google: { thought_signature: 'S' }, other: 1 },
    },
  ]);
});

test('Gemini refusing an unsigned step from elsewhere gets it once more with the skip value, and from then on', async (t) => {
  const bodies: Body[] = [];
  const base = await server(t, (_request, response, body) => {
    bodies.push(body);
    if (missingSignature(body)) return refuse(response);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(response, {
      choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
    });
    response.end('data: [DONE]\n\n');
  });
  const home = scratch(t);
  saveCredentials({ api_key: 'test-key' }, home);
  const model = new GatewayModel(geminiSettings(base), home);
  // A turn retried after the step was written by another model or key, or before
  // Circle kept signatures: the step has none this connection can send.
  const messages: Message[] = [
    { id: 'u', role: 'user', content: 'read' },
    {
      id: 'a',
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'one', name: 'read_file', args: { file_path: 'one.txt' } },
        { id: 'two', name: 'read_file', args: { file_path: 'two.txt' } },
      ],
    },
    { id: 'r1', role: 'tool', tool_call_id: 'one', content: 'first' },
    { id: 'r2', role: 'tool', tool_call_id: 'two', content: 'second' },
  ];
  const notices: string[] = [];
  const send = () =>
    model.complete({
      system: 'system',
      messages,
      tools: [],
      signal: new AbortController().signal,
      token: () => {},
      notice: (event) => notices.push(String(event.event)),
    });
  assert.equal((await send()).message.content, 'ok');
  assert.equal(bodies.length, 2);
  assert.deepEqual(notices, ['thinking_signature_retry']);
  const step = (body: Body) =>
    (body.messages as WireMessage[]).find((message) => message.tool_calls)!
      .tool_calls!;
  assert.equal(signature(step(bodies[0]!)[0]), undefined);
  assert.equal(
    signature(step(bodies[1]!)[0]),
    'skip_thought_signature_validator',
  );
  // Only the first call of a step is signed.
  assert.equal('extra_content' in step(bodies[1]!)[1]!, false);
  assert.equal((await send()).message.content, 'ok');
  assert.equal(bodies.length, 3);
});

test('an endpoint that refuses extra_content back gets the request once more without it, and from then on', async (t) => {
  const bodies: Body[] = [];
  const base = await server(t, (_request, response, body) => {
    bodies.push(body);
    const messages = body.messages as WireMessage[];
    if (
      messages.some((message) =>
        message.tool_calls?.some((call) => 'extra_content' in call),
      )
    ) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            message:
              'Invalid JSON payload received. Unknown name "extra_content" at \'messages[2].tool_calls[0]\': Cannot find field.',
          },
        }),
      );
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(response, {
      choices: [
        {
          index: 0,
          delta:
            bodies.length === 1
              ? {
                  tool_calls: [
                    {
                      extra_content: { relay: { trace: 'T' } },
                      function: {
                        name: 'read_file',
                        arguments: JSON.stringify({ file_path: 'one.txt' }),
                      },
                      id: 'one',
                      type: 'function',
                    },
                  ],
                }
              : { content: 'ok' },
          finish_reason: bodies.length === 1 ? 'tool_calls' : 'stop',
        },
      ],
    });
    response.end('data: [DONE]\n\n');
  });
  const home = scratch(t);
  saveCredentials({ api_key: 'test-key' }, home);
  const model = new GatewayModel(geminiSettings(base), home);
  const send = (messages: Message[]) =>
    model.complete({
      system: 'system',
      messages,
      tools: [],
      signal: new AbortController().signal,
      token: () => {},
    });
  const user: Message = { id: 'u', role: 'user', content: 'read' };
  const step = (await send([user])).message;
  assert.deepEqual(step.tool_calls?.[0]?.extra_content, {
    relay: { trace: 'T' },
  });
  const history: Message[] = [
    user,
    step,
    { id: 'r', role: 'tool', tool_call_id: 'one', content: 'first' },
  ];
  assert.equal((await send(history)).message.content, 'ok');
  assert.equal(bodies.length, 3);
  assert.equal((await send(history)).message.content, 'ok');
  assert.equal(bodies.length, 4);
});

test('a saved session refuses a tool call whose extra_content is not an object', () => {
  const step = (extra: unknown): Message[] => [
    { id: 'u', role: 'user', content: 'read' },
    {
      id: 'a',
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'one',
          name: 'read_file',
          args: {},
          extra_content: extra as Record<string, unknown>,
        },
      ],
    },
    { id: 'r', role: 'tool', tool_call_id: 'one', content: 'first' },
  ];
  validateMessages(step({ google: { thought_signature: 'S' } }));
  validateMessages(step(undefined));
  for (const bad of ['S', ['S'], null])
    assert.throws(
      () => validateMessages(step(bad)),
      /invalid or duplicate tool call/,
    );
});
