import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import {
  McpManager,
  buildMcpConnections,
  resolveHeaders,
} from '../src/mcp_loader.js';
import { scratch, cleanup } from './helpers.js';

const TOKEN = 'mcp-token-5d1c9a';
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
