import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRuntime } from '../src/runtime.js';
import {
  defaultSettings,
  loadSettings,
  saveSettings,
} from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { cleanup, scratch, until } from './helpers.js';
import { mcpStub } from './mcp-stub.js';

test('one MCP server connects again and lists its tools again, and the others are left as they are', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  const schema = { type: 'object', properties: {} };
  // The stub lists `tools` again at each tools/list
  const served = { tools: [{ name: 'old', inputSchema: schema }] };
  const one = await mcpStub(t, served);
  const other = await mcpStub(t, {
    tools: [{ name: 'echo', inputSchema: schema }],
  });
  const settings = defaultSettings();
  settings.mcpServers = {
    one: { url: one.url, type: 'http' },
    other: { url: other.url, type: 'http' },
  };
  saveSettings(settings, home);
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(root, 'user'),
    settings,
    model: new ScriptedModel([]),
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  const names = () => runtime.harness.tools.map((tool) => tool.name);
  const starts = (stub: typeof one) =>
    stub.requests.filter((request) => request.message?.method === 'initialize')
      .length;
  assert.ok(names().includes('mcp__one__old'));
  const otherBefore = starts(other);

  // The server changed its tools and does not say so: connecting it alone again finds them
  served.tools = [{ name: 'new', inputSchema: schema }];
  await runtime.reloadMcpServer('one');
  assert.ok(names().includes('mcp__one__new'));
  assert.ok(!names().includes('mcp__one__old'));
  assert.ok(names().includes('mcp__other__echo'));
  assert.equal(
    starts(other),
    otherBefore,
    'the other server is not reached again',
  );
  assert.equal(starts(one), 2);

  // A name no server has is refused, and so is a reload while a turn runs
  await assert.rejects(
    runtime.reloadMcpServer('nobody'),
    /no MCP server named nobody/,
  );
});

async function runtimeWith(
  t: Parameters<typeof scratch>[0],
  servers: Record<string, Record<string, unknown>>,
  model = new ScriptedModel([]),
) {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  const settings = defaultSettings();
  settings.mcpServers = servers;
  saveSettings(settings, home);
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(root, 'user'),
    settings,
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  return { runtime, home };
}

test('a server is connected again under its name in mcpServers, not taken away', async (t) => {
  const stub = await mcpStub(t, {
    tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }],
  });
  const { runtime } = await runtimeWith(t, {
    docs: { type: 'http', url: stub.url },
  });
  const names = () => runtime.harness.tools.map((tool) => tool.name);
  assert.ok(names().includes('mcp__docs__echo'));
  await runtime.reloadMcpServer('docs');
  assert.ok(names().includes('mcp__docs__echo'));
  assert.equal(
    stub.requests.filter((request) => request.message?.method === 'initialize')
      .length,
    2,
  );
});

test('an extension saving a server while a turn runs is refused, and nothing is saved', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { runtime, home } = await runtimeWith(
    t,
    {},
    new ScriptedModel([
      async () => {
        await gate;
        return {
          message: {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: 'done',
          },
          usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 },
        } as never;
      },
    ]),
  );
  const turn = runtime.harness.run('wait');
  await until(() => runtime.busy);
  await assert.rejects(
    runtime.saveMcpServer('later', {
      type: 'http',
      url: 'http://127.0.0.1:9/mcp',
    }),
    /a turn is running: nothing was saved/,
  );
  assert.ok(!Object.hasOwn(loadSettings(home).mcpServers, 'later'));
  release();
  await turn;
});

test('AgentRuntime.reauthorizeMcpServer forwards dynamic scope while keeping stored tokens until re-login completes', async (t) => {
  const { createServer } = await import('node:http');
  const { McpAuthProvider, keptFor, redirectPort } =
    await import('../src/mcp_auth.js');
  let port = 0;
  const base = () => `http://127.0.0.1:${port}`;
  const seenDeviceScopes: string[] = [];
  let tokenSeq = 0;
  const validTokens = new Set(['tok-before']);
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? '/', base());
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            issuer: base(),
            authorization_endpoint: `${base()}/authorize`,
            token_endpoint: `${base()}/token`,
            registration_endpoint: `${base()}/register`,
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
            grant_types_supported: [
              'authorization_code',
              'urn:ietf:params:oauth:grant-type:device_code',
            ],
            device_authorization_endpoint: `${base()}/device`,
          }),
        );
        return;
      }
      if (url.pathname === '/device') {
        seenDeviceScopes.push(new URLSearchParams(body).get('scope') ?? '');
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            device_code: 'dc-rt',
            user_code: 'BCDF-GHJK',
            verification_uri: `${base()}/verify`,
            verification_uri_complete: `${base()}/verify?user_code=BCDF-GHJK`,
            expires_in: 600,
            interval: 1,
          }),
        );
        return;
      }
      if (url.pathname === '/token') {
        const tok = `tok-rt-${++tokenSeq}`;
        validTokens.add(tok);
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            access_token: tok,
            token_type: 'Bearer',
            scope: 'custom-bot',
          }),
        );
        return;
      }
      if (url.pathname === '/mcp') {
        const bearer = (req.headers.authorization ?? '').replace(
          /^Bearer /i,
          '',
        );
        if (!validTokens.has(bearer)) {
          res.writeHead(401).end();
          return;
        }
        const rpc = JSON.parse(body) as { id?: unknown; method?: string };
        const result =
          rpc.method === 'initialize'
            ? {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'srv', version: '1.0.0' },
              }
            : rpc.method === 'tools/list'
              ? { tools: [] }
              : {};
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(
            rpc.id === undefined
              ? ''
              : JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }),
          );
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  port = (srv.address() as { port: number }).port;
  cleanup(t, () => {
    srv.closeAllConnections?.();
    return new Promise<void>((resolve) => srv.close(() => resolve()));
  });

  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(workspace);
  const serverKey = `${base()}/mcp`;
  const portUsed = await redirectPort(home, serverKey);
  const seed = new McpAuthProvider(home, serverKey, portUsed);
  seed.saveClientInformation({
    client_id: 'cli-rt',
    redirect_uris: [seed.redirectUrl],
  });
  seed.saveTokens({ access_token: 'tok-before', token_type: 'Bearer' });
  seed.saveDiscoveryState({
    authorizationServerUrl: base(),
    resourceMetadata: { resource: serverKey, authorization_servers: [base()] },
    authorizationServerMetadata: {
      issuer: base(),
      authorization_endpoint: `${base()}/authorize`,
      token_endpoint: `${base()}/token`,
      registration_endpoint: `${base()}/register`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: [
        'authorization_code',
        'urn:ietf:params:oauth:grant-type:device_code',
      ],
      device_authorization_endpoint: `${base()}/device`,
    },
  });

  const settings = defaultSettings();
  settings.mcpServers = { remote: { type: 'http', url: serverKey } };
  saveSettings(settings, home);
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(root, 'user'),
    settings,
    model: new ScriptedModel([]),
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  await runtime.reauthorizeMcpServer('remote', 'custom-bot');
  await until(
    () => keptFor(home, serverKey).tokens?.access_token === 'tok-rt-1',
  );
  assert.deepEqual(seenDeviceScopes, ['custom-bot']);
  assert.equal(keptFor(home, serverKey).required_scope, undefined);
});

test('C3-M1: invalid header config records error on row without throwing across reloadMcpServer, reconnectMcpServers, and saveMcpServer', async (t) => {
  const { createServer } = await import('node:http');
  let allowRecover = false;
  let port = 0;
  const base = () => `http://127.0.0.1:${port}/mcp`;
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (!allowRecover) {
        res.writeHead(500).end('unavailable');
        return;
      }
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id?: unknown;
        method?: string;
      };
      const result =
        rpc.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'recoverable', version: '1.0.0' },
            }
          : rpc.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'pong',
                    description: 'pong',
                    inputSchema: { type: 'object', properties: {} },
                  },
                ],
              }
            : {};
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          rpc.id === undefined
            ? ''
            : JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }),
        );
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  port = (srv.address() as { port: number }).port;
  t.after(() => {
    srv.closeAllConnections?.();
    return new Promise<void>((resolve) => srv.close(() => resolve()));
  });

  const { runtime } = await runtimeWith(t, {
    bad: {
      type: 'http',
      url: 'https://mcp.example.test/mcp',
      headers: { 'Bad Name': 'v' },
    },
    recoverable: {
      type: 'http',
      url: base(),
    },
  });

  const badBefore = runtime.mcp.status.find((s) => s.name === 'bad');
  assert.match(badBefore?.error ?? '', /invalid header name 'Bad Name'/);

  await assert.doesNotReject(() => runtime.reloadMcpServer('bad'));
  const badAfterReload = runtime.mcp.status.find((s) => s.name === 'bad');
  assert.match(badAfterReload?.error ?? '', /invalid header name 'Bad Name'/);
  assert.deepEqual(badAfterReload?.tools, []);

  allowRecover = true;
  const retried = await runtime.reconnectMcpServers();
  assert.deepEqual(retried, ['bad', 'recoverable']);
  assert.match(
    runtime.mcp.status.find((s) => s.name === 'bad')?.error ?? '',
    /invalid header name 'Bad Name'/,
  );
  const recovered = runtime.mcp.status.find((s) => s.name === 'recoverable');
  assert.equal(recovered?.error, '');
  assert.deepEqual(recovered?.tools, ['mcp__recoverable__pong']);

  const saved = await runtime.saveMcpServer('bad-saved', {
    type: 'http',
    url: 'https://mcp.example.test/mcp',
    headers: { 'Bad Name': 'v' },
  });
  assert.equal(saved.state, 'failed');
  assert.match(saved.error ?? '', /invalid header name 'Bad Name'/);
  assert.equal(saved.tools, 0);
});
