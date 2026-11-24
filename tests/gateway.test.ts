import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { GatewayModel } from '../src/model.js';
import { AgentRuntime } from '../src/runtime.js';
import {
  defaultSettings,
  saveSettings,
  saveCredentials,
  trustFolder,
} from '../src/settings.js';
async function server(
  t: { after(fn: () => void | Promise<void>): void },
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown>,
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
  const root = mkdtempSync(join(tmpdir(), 'circle-gateway-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function sse(response: ServerResponse, data: unknown): void {
  response.write('data: ' + JSON.stringify(data) + '\n\n');
}
test('OpenAI streaming joins split tool arguments and records usage from the final empty chunk', async (t) => {
  let requestBody: Record<string, unknown> = {};
  const base = await server(t, (request, response, body) => {
    assert.equal(request.url, '/v1/chat/completions');
    requestBody = body;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(response, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call',
                function: { name: 'read_file', arguments: '{"file_' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    sse(response, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: 'path":"file.txt"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    sse(response, {
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 2 },
      },
    });
    response.end('data: [DONE]\n\n');
  });
  const home = scratch(t);
  const settings = defaultSettings();
  settings.auth = {
    ...settings.auth,
    base_url: base + '/v1',
    model: 'gateway',
  };
  saveCredentials({ api_key: 'test-key' }, home);
  const model = new GatewayModel(settings, home);
  const result = await model.complete({
    system: 'system',
    messages: [{ id: 'one', role: 'user', content: 'read' }],
    tools: [],
    signal: new AbortController().signal,
    token: () => {},
  });
  assert.deepEqual(result.message.tool_calls, [
    { id: 'call', name: 'read_file', args: { file_path: 'file.txt' } },
  ]);
  assert.deepEqual(result.usage, {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 2,
  });
  assert.equal(result.message.cache_reported, undefined);
  assert.equal(requestBody.model, 'gateway');
});
test('a gateway that requires typed enums accepts the knowledge tools on the first request', async (t) => {
  const fields = [
    ['knowledge_search', 'status'],
    ['memory_write', 'state'],
  ] as const;
  const base = await server(t, (_request, response, body) => {
    const tools = body.tools as {
      function: {
        name: string;
        parameters: { properties: Record<string, { type?: string }> };
      };
    }[];
    const invalid = fields.filter(([name, property]) => {
      const tool = tools?.find((entry) => entry.function.name === name);
      return tool?.function.parameters.properties[property]?.type !== 'string';
    });
    if (invalid.length) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            message: invalid
              .map(
                ([name, property]) =>
                  `${name}.properties.${property}: expected type string`,
              )
              .join(', '),
          },
        }),
      );
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(response, {
      choices: [
        { index: 0, delta: { content: 'accepted' }, finish_reason: 'stop' },
      ],
    });
    response.end('data: [DONE]\n\n');
  });
  const root = scratch(t);
  const home = join(root, 'home');
  const settings = defaultSettings();
  settings.auth = {
    ...settings.auth,
    base_url: base + '/v1',
    model: 'gateway',
  };
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
    assert.equal((await runtime.harness.run('hello')).answer, 'accepted');
  } finally {
    await runtime.close();
  }
});
test('Anthropic streaming preserves thinking signatures and tool payloads for the next request', async (t) => {
  const base = await server(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type: string, body: unknown) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify(body)}\n\n`);
    event('message_start', {
      type: 'message_start',
      message: {
        id: 'msg',
        type: 'message',
        role: 'assistant',
        model: 'gateway',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 0 },
      },
    });
    event('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    });
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'reason' },
    });
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'preserved-signature' },
    });
    event('content_block_stop', { type: 'content_block_stop', index: 0 });
    event('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    });
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'answer' },
    });
    event('content_block_stop', { type: 'content_block_stop', index: 1 });
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    });
    event('message_stop', { type: 'message_stop' });
    response.end();
  });
  const home = scratch(t);
  const settings = defaultSettings();
  settings.auth = {
    ...settings.auth,
    base_url: base,
    model: 'gateway',
    protocol: 'anthropic',
  };
  saveCredentials({ api_key: 'test-key' }, home);
  const model = new GatewayModel(settings, home);
  const tokens: string[] = [];
  const result = await model.complete({
    system: 'system',
    messages: [{ id: 'one', role: 'user', content: 'question' }],
    tools: [],
    signal: new AbortController().signal,
    token: (text) => tokens.push(text),
  });
  assert.equal(result.message.content, 'answer');
  assert.equal(result.message.thinking, 'reason');
  assert.equal(result.message.cache_reported, false);
  assert.equal(
    (result.message.provider_content?.[0] as { signature: string }).signature,
    'preserved-signature',
  );
  assert.deepEqual(tokens, ['reason', 'answer']);
});
test('CLI runs two real HTTP requests with a file side effect and resumes persisted history in a new process', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  let requests = 0;
  const bodies: Record<string, unknown>[] = [];
  const base = await server(t, (_request, response, body) => {
    bodies.push(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const first = requests++ === 0;
    sse(response, {
      choices: [
        {
          index: 0,
          delta: first
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: JSON.stringify({
                        file_path: 'actual.txt',
                        content: 'actual side effect',
                      }),
                    },
                  },
                ],
              }
            : { content: 'done' },
          finish_reason: first ? 'tool_calls' : 'stop',
        },
      ],
    });
    response.end('data: [DONE]\n\n');
  });
  let settings = defaultSettings();
  settings.initialized = true;
  settings.auth = {
    ...settings.auth,
    base_url: base + '/v1',
    model: 'gateway',
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
      child.stdout.on('data', (data) => {
        stdout += data;
      });
      child.stderr.on('data', (data) => {
        stderr += data;
      });
      child.once('error', reject);
      child.once('close', (code) => resolveRun({ code, stdout, stderr }));
      child.stdin.end();
    });
  const first = await run(['-p', 'write', workspace, '--yolo']);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, 'done\n');
  assert.ok(existsSync(join(workspace, 'actual.txt')));
  assert.equal(
    readFileSync(join(workspace, 'actual.txt'), 'utf8'),
    'actual side effect',
  );
  const next = await run(['-p', 'next', workspace, '-c']);
  assert.equal(next.code, 0, next.stderr);
  assert.equal(next.stdout, 'done\n');
  const messages = bodies[2]!.messages as { role: string; content: string }[];
  assert.ok(
    messages.some(
      (message) => message.role === 'tool' && message.content.includes('Wrote'),
    ),
  );
  assert.equal(messages.at(-1)!.content, 'next');
});
test('OpenAI Chat Completions folds internal reminders instead of emitting synthetic user turns', async (t) => {
  let requestBody: Record<string, unknown> = {};
  const base = await server(t, (_request, response, body) => {
    requestBody = body;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(response, {
      choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
    });
    response.end('data: [DONE]\n\n');
  });
  const home = scratch(t);
  const settings = defaultSettings();
  settings.auth = {
    ...settings.auth,
    base_url: base + '/v1',
    model: 'gateway',
  };
  saveCredentials({ api_key: 'test-key' }, home);
  const model = new GatewayModel(settings, home);
  await model.complete({
    system: 'system',
    messages: [
      {
        id: 'h0',
        role: 'user',
        content: '<session-hook>rules</session-hook>',
        internal: 'hook_context',
      },
      { id: 'u1', role: 'user', content: 'fix bug' },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', name: 'read_file', args: { file_path: 'a.ts' } },
        ],
      },
      {
        id: 't1',
        role: 'tool',
        tool_call_id: 'c1',
        content: 'const x = 1;',
      },
      {
        id: 'lg',
        role: 'user',
        content:
          '<system-reminder data-source="loop-guard">note</system-reminder>',
        internal: 'loop-guard',
      },
      {
        id: 'pr',
        role: 'user',
        content:
          '<system-reminder data-source="circle-plan">todo</system-reminder>',
        internal: 'plan-reminder',
      },
      {
        id: 'hn',
        role: 'user',
        content: '<hook-notice>allowed</hook-notice>',
        internal: 'hook_notice',
      },
      {
        id: 'mr',
        role: 'user',
        content: '<system-reminder>\nstop repeating\n</system-reminder>',
        internal: 'model-retry',
      },
    ],
    tools: [],
    signal: new AbortController().signal,
    token: () => {},
  });
  const sent = requestBody.messages as { role: string; content: string }[];
  const userMessages = sent.filter((message) => message.role === 'user');
  assert.equal(userMessages.length, 1);
  assert.match(userMessages[0]!.content, /<session-hook>rules<\/session-hook>/);
  assert.match(userMessages[0]!.content, /fix bug/);
  const toolMessage = sent.find((message) => message.role === 'tool');
  assert.ok(toolMessage);
  assert.match(toolMessage.content, /const x = 1;/);
  assert.match(toolMessage.content, /data-source="loop-guard"/);
  assert.match(toolMessage.content, /data-source="circle-plan"/);
  assert.match(toolMessage.content, /<hook-notice>allowed<\/hook-notice>/);
  assert.match(toolMessage.content, /stop repeating/);
});
