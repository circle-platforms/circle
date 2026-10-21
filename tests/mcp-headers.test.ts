import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  McpManager,
  buildMcpConnections,
  replaceLongest,
  resolveHeaders,
} from '../src/mcp_loader.js';
import { AgentRuntime } from '../src/runtime.js';
import { saveSecret } from '../src/secrets.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message } from '../src/types.js';
import { scratch, cleanup } from './helpers.js';
import { mcpStub } from './mcp-stub.js';

const TOKEN = 'mcp-token-5d1c9a';
const TEAM = 'team-value-7f3e2a';
const assistant = (
  text: string,
  calls: Message['tool_calls'] = [],
): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  content: text,
  tool_calls: calls,
});
interface Request {
  id?: number;
  method: string;
  params?: { protocolVersion?: string };
}
function result(request: Request): unknown {
  if (request.method === 'initialize')
    return {
      protocolVersion: request.params?.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'header-fixture', version: '1' },
    };
  if (request.method === 'tools/list')
    return {
      tools: [
        {
          name: 'whoami',
          description: 'Says who asked.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    };
  if (request.method === 'tools/call')
    return { content: [{ type: 'text', text: 'authorized' }] };
  return {};
}

test('header values fill in environment variables and refuse what cannot be sent', () => {
  assert.deepEqual(
    resolveHeaders(
      { Authorization: 'Bearer ${env:DOCS_TOKEN}', 'X-Team': 'lab' },
      { DOCS_TOKEN: TOKEN },
    ),
    { Authorization: `Bearer ${TOKEN}`, 'X-Team': 'lab' },
  );
  assert.throws(
    () => resolveHeaders({ Authorization: 'Bearer ${env:MISSING}' }, {}),
    /header Authorization needs the environment variable MISSING/,
  );
  assert.throws(
    () => resolveHeaders({ 'Bad Name': 'x' }, {}),
    /invalid header name/,
  );
  assert.throws(
    () => resolveHeaders({ 'X-A': '${env:V}' }, { V: 'a\r\nInjected: 1' }),
    /line break/,
  );
  const { connections } = buildMcpConnections([
    { name: 'docs', url: 'https://x.test/mcp', headers: { 'X-Team': 'lab' } },
  ]);
  assert.deepEqual(connections[0]!.headers, { 'X-Team': 'lab' });
});

test('streamable HTTP and SSE servers receive the configured headers on every request, and websocket refuses them', async (t) => {
  const seen: (string | undefined)[] = [];
  let sse: ServerResponse | undefined;
  const server = createServer(async (request, response) => {
    seen.push(request.headers.authorization);
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.url === '/sse' && request.method === 'GET') {
      sse = response;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('event: endpoint\ndata: /messages\n\n');
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let text = '';
    for await (const chunk of request) text += chunk;
    const parsed = JSON.parse(text) as Request;
    if (parsed.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const body = { jsonrpc: '2.0', id: parsed.id, result: result(parsed) };
    if (request.url === '/messages') {
      sse!.write('event: message\ndata: ' + JSON.stringify(body) + '\n\n');
      response.writeHead(202).end();
    } else
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(
    t,
    () =>
      new Promise<void>((resolve) => {
        sse?.end();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  process.env.CIRCLE_TEST_MCP_TOKEN = TOKEN;
  cleanup(t, () => {
    delete process.env.CIRCLE_TEST_MCP_TOKEN;
  });
  const headers = { Authorization: 'Bearer ${env:CIRCLE_TEST_MCP_TOKEN}' };
  const manager = new McpManager(scratch(t));
  cleanup(t, () => manager.close());
  for (const [transport, url] of [
    ['streamable_http', `${base}/mcp`],
    ['sse', `${base}/sse`],
  ]) {
    seen.length = 0;
    await manager.load([{ name: 'docs', url, transport, headers }]);
    assert.equal(
      manager.status[0]?.error,
      '',
      `${transport}: ${manager.describe()}`,
    );
    assert.equal(
      await manager.tools[0]!.run(
        {},
        { sessionId: 'test', signal: new AbortController().signal },
      ),
      'authorized',
    );
    assert.ok(seen.length >= 2);
    assert.ok(
      seen.every((value) => value === `Bearer ${TOKEN}`),
      transport,
    );
  }
  // Without the header the same server turns the connection down.
  await manager.load([
    { name: 'docs', url: `${base}/mcp`, transport: 'streamable_http' },
  ]);
  assert.notEqual(manager.status[0]?.error, '');
  await manager.load([
    {
      name: 'docs',
      url: 'ws://127.0.0.1:1/socket',
      transport: 'websocket',
      headers,
    },
  ]);
  assert.match(
    manager.status[0]!.error,
    /websocket server cannot be sent headers/,
  );
  assert.ok(!manager.describe().includes(TOKEN));
});

test('header values fill in saved secrets, and a missing secret is named without any value', () => {
  assert.deepEqual(
    resolveHeaders(
      {
        Authorization: 'Bearer ${secret:FILES_TOKEN}',
        'X-Pair': '${env:TEAM}/${secret:REGION}',
      },
      { TEAM: 'lab' },
      { FILES_TOKEN: TOKEN, REGION: 'north' },
    ),
    { Authorization: `Bearer ${TOKEN}`, 'X-Pair': 'lab/north' },
  );
  assert.throws(
    () =>
      resolveHeaders(
        { Authorization: 'Bearer ${secret:NOT_SAVED}' },
        {},
        { FILES_TOKEN: TOKEN },
      ),
    (error: Error) =>
      /header Authorization needs the secret NOT_SAVED, which is not saved/.test(
        error.message,
      ) && !error.message.includes(TOKEN),
  );
  // Each form reads its own store: a variable is not a secret, nor a secret a variable
  assert.throws(
    () => resolveHeaders({ 'X-A': '${secret:TEAM}' }, { TEAM: 'lab' }, {}),
    /needs the secret TEAM/,
  );
  assert.throws(
    () =>
      resolveHeaders(
        { 'X-A': '${env:FILES_TOKEN}' },
        {},
        { FILES_TOKEN: TOKEN },
      ),
    /needs the environment variable FILES_TOKEN/,
  );
  assert.throws(
    () => resolveHeaders({ 'X-A': '${secret:constructor}' }, {}, {}),
    /needs the secret constructor/,
  );
  // A name of what every object has is no variable of the environment either
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__'])
    for (const env of [{}, process.env])
      assert.throws(
        () => resolveHeaders({ 'X-A': `\${env:${name}}` }, env),
        new RegExp(`needs the environment variable ${name}, which is not set`),
      );
});

test('a saved secret reaches the server in a header, and what the model reads, the transcript and /mcp show its reference only', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  mkdirSync(home);
  saveSecret(home, 'FILES_TOKEN', TOKEN);
  process.env.CIRCLE_TEST_FILES_TEAM_TOKEN = TEAM;
  cleanup(t, () => {
    delete process.env.CIRCLE_TEST_FILES_TEAM_TOKEN;
  });
  const stub = await mcpStub(t, {
    tools: [
      { name: 'whoami', inputSchema: { type: 'object', properties: {} } },
      { name: 'refuse', inputSchema: { type: 'object', properties: {} } },
    ],
    refuse: (request) =>
      request.headers.authorization === `Bearer ${TOKEN}`
        ? undefined
        : { status: 401, body: 'no token' },
    // The server quotes what it was sent, as an echo or an error page can
    call: (request) => {
      const token = String(request.headers.authorization).slice(7);
      return request.message?.params?.name === 'whoami'
        ? {
            content: [
              {
                type: 'text',
                text: `you sent ${token} for ${String(request.headers['x-team'])}`,
              },
            ],
          }
        : { isError: true, content: [{ type: 'text', text: `no ${token}` }] };
    },
  });
  const settings = defaultSettings();
  settings.mcp_servers = [
    {
      name: 'files-server',
      url: stub.url,
      transport: 'streamable_http',
      headers: {
        Authorization: 'Bearer ${secret:FILES_TOKEN}',
        'X-Team': '${env:CIRCLE_TEST_FILES_TEAM_TOKEN}',
      },
    },
  ];
  const model = new ScriptedModel([
    {
      message: assistant('', [
        { id: 'who', name: 'files-server_whoami', args: {} },
        { id: 'no', name: 'files-server_refuse', args: {} },
      ]),
    },
    { message: assistant('done') },
  ]);
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings,
    model,
    userHome: join(root, 'user'),
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.initialize();
  assert.equal(runtime.mcp.status[0]?.error, '', runtime.mcp.describe());
  await runtime.harness.run('who am I');
  // On the wire: every request carried the values
  assert.ok(stub.requests.length >= 4);
  for (const request of stub.requests) {
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(request.headers['x-team'], TEAM);
  }
  assert.equal(stub.calls().length, 2);
  // Circle's side: the references, never the values
  const results = model.requests[1]!.messages.filter(
    (message) => message.role === 'tool',
  );
  assert.equal(
    results.find((message) => message.tool_call_id === 'who')!.content,
    'you sent %FILES_TOKEN% for ${env:CIRCLE_TEST_FILES_TEAM_TOKEN}',
  );
  assert.match(
    results.find((message) => message.tool_call_id === 'no')!.content,
    /^no %FILES_TOKEN%$/,
  );
  for (const shown of [
    JSON.stringify(model.requests),
    JSON.stringify(runtime.harness.messages),
    runtime.mcp.describe(),
  ]) {
    assert.ok(!shown.includes(TOKEN));
    assert.ok(!shown.includes(TEAM));
  }
  assert.match(runtime.mcp.describe(), /headers: Authorization, X-Team/);
});

test('values are replaced longest first, never inside a longer one or inside what replaced it', () => {
  assert.equal(
    replaceLongest('a ab abc', [
      ['ab', 'X'],
      ['abc', 'Y'],
      ['a', 'Z'],
    ]),
    'Z X Y',
  );
  // A secret that holds a file's base64 is hidden whole, and a label is not searched again
  assert.equal(
    replaceLongest('token xyzQUJDabc', [
      ['QUJD', 'f.bin (3 bytes)'],
      ['xyzQUJDabc', '%FILES_TOKEN%'],
    ]),
    'token %FILES_TOKEN%',
  );
  assert.equal(
    replaceLongest('12', [
      ['12', 'one2'],
      ['2', 'two'],
    ]),
    'one2',
  );
  assert.equal(replaceLongest('text', []), 'text');
  assert.equal(replaceLongest('text', [['', 'x']]), 'text');
});

test('only a secret, or a variable whose own or header name looks secret, is hidden where a server quotes it; other values stay as written', async (t) => {
  const values: Record<string, string> = {
    CIRCLE_TEST_API_VERSION: '2',
    CIRCLE_TEST_REGION: 'us',
    CIRCLE_TEST_FILES_KEY: 'key-value-31c8e0',
    CIRCLE_TEST_FILES_PAT: 'pat-value-9b2d47',
  };
  Object.assign(process.env, values);
  cleanup(t, () => {
    for (const name of Object.keys(values)) delete process.env[name];
  });
  const description =
    'List the users of a project and their status. Found 12 files in 2026.';
  const stub = await mcpStub(t, {
    instructions: () =>
      // A value cut by a control character is whole again once that is taken out
      'Use version 2 in region us. Send session-value-c4a1\u0007f2 with each call.',
    tools: [
      {
        name: 'list_users',
        description,
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    call: (request) => ({
      content: [
        {
          type: 'text',
          text: `Found 12 files and 2 folders in 2026 for the users of us-east; key ${String(request.headers['x-files-key'])}, ${String(request.headers.authorization)}, session ${String(request.headers['x-session'])}`,
        },
      ],
    }),
  });
  const manager = new McpManager(scratch(t), 30_000, undefined, {
    secrets: () => ({ FILES_SESSION: 'session-value-c4a1f2' }),
  });
  cleanup(t, () => manager.close());
  await manager.load([
    {
      name: 'files-server',
      url: stub.url,
      transport: 'streamable_http',
      headers: {
        'X-Api-Version': '${env:CIRCLE_TEST_API_VERSION}',
        'X-Region': '${env:CIRCLE_TEST_REGION}',
        // KEY in the variable's name, a header of credentials, a saved secret
        'X-Files-Key': '${env:CIRCLE_TEST_FILES_KEY}',
        Authorization: 'Bearer ${env:CIRCLE_TEST_FILES_PAT}',
        'X-Session': '${secret:FILES_SESSION}',
      },
    },
  ]);
  assert.equal(manager.status[0]!.error, '', manager.describe());
  assert.equal(stub.requests[0]!.headers['x-api-version'], '2');
  assert.equal(stub.requests[0]!.headers['x-region'], 'us');
  const tool = manager.tools[0]!;
  assert.equal(tool.description, description);
  assert.equal(
    await tool.run(
      {},
      { sessionId: 'one', signal: new AbortController().signal },
    ),
    'Found 12 files and 2 folders in 2026 for the users of us-east; key ${env:CIRCLE_TEST_FILES_KEY}, Bearer ${env:CIRCLE_TEST_FILES_PAT}, session %FILES_SESSION%',
  );
  assert.deepEqual(manager.instructions(), [
    {
      server: 'files-server',
      text: 'Use version 2 in region us. Send %FILES_SESSION% with each call.',
    },
  ]);
});

test('a missing secret stops that server before any request, and an error the server quotes back shows the reference', async (t) => {
  const quoting = await mcpStub(t, {
    refuse: (request) => ({
      status: 401,
      body: `rejected ${String(request.headers.authorization)}`,
    }),
  });
  const manager = new McpManager(scratch(t), 30_000, undefined, {
    secrets: () => ({ FILES_TOKEN: TOKEN }),
  });
  cleanup(t, () => manager.close());
  await manager.load([
    {
      name: 'missing',
      url: quoting.url,
      transport: 'streamable_http',
      headers: { Authorization: 'Bearer ${secret:NOT_SAVED}' },
    },
  ]);
  assert.match(
    manager.status[0]!.error,
    /header Authorization needs the secret NOT_SAVED, which is not saved/,
  );
  assert.equal(quoting.requests.length, 0);
  await manager.load([
    {
      name: 'quoting',
      url: quoting.url,
      transport: 'streamable_http',
      headers: { Authorization: 'Bearer ${secret:FILES_TOKEN}' },
    },
  ]);
  assert.equal(quoting.requests[0]!.headers.authorization, `Bearer ${TOKEN}`);
  assert.match(manager.status[0]!.error, /rejected Bearer %FILES_TOKEN%/);
  assert.ok(!manager.describe().includes(TOKEN));
  assert.match(manager.describe(), /headers: Authorization/);
  // Without a harness in between, the tool's own result and error hide the value too
  const echo = await mcpStub(t, {
    tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }],
    call: (request) => ({
      isError: request.message?.params?.arguments?.fail === true,
      content: [
        { type: 'text', text: `got ${String(request.headers.authorization)}` },
      ],
    }),
  });
  await manager.load([
    {
      name: 'echo',
      url: echo.url,
      transport: 'streamable_http',
      headers: { Authorization: 'Bearer ${secret:FILES_TOKEN}' },
    },
  ]);
  const context = { sessionId: 'one', signal: new AbortController().signal };
  assert.equal(
    await manager.tools[0]!.run({}, context),
    'got Bearer %FILES_TOKEN%',
  );
  await assert.rejects(
    manager.tools[0]!.run({ fail: true }, context),
    (error: Error) => error.message === 'got Bearer %FILES_TOKEN%',
  );
  assert.equal(echo.calls()[0]!.headers.authorization, `Bearer ${TOKEN}`);
});
