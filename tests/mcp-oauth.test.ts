// The MCP authorization: a server on loopback that answers 401 with its resource metadata, registers clients, approves
// at once (as a person would on its page) and checks PKCE when it exchanges the code. A scripted browser follows the
// sign-in page to Circle's loopback redirect. Real effects are checked: what the server received, the tokens kept in
// the Circle home and their file mode, the tools offered after the sign-in, and a second start that needs no sign-in.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  McpAuthProvider,
  keptFor,
  mcpAuthPath,
  redirectPort,
  startRedirect,
} from '../src/mcp_auth.js';
import { McpManager, SIGN_IN_WAITING } from '../src/mcp_loader.js';
import {
  ApprovalPolicy,
  ApprovalStore,
  DEFAULT_CREDENTIAL_FILES,
} from '../src/approvals.js';
import { cleanup, cleanupServer, scratch } from './helpers.js';

interface Rpc {
  id?: number;
  method: string;
  params?: { protocolVersion?: string };
}

interface OAuthServer {
  origin: string;
  /** The clients that registered: their metadata. */
  clients: Record<string, unknown>[];
  /** Authorization requests the server saw. */
  authorizations: URLSearchParams[];
  /** Token requests the server saw. */
  exchanges: URLSearchParams[];
  /** Bearer tokens /mcp accepts; a test can revoke one. */
  valid: Set<string>;
}

async function oauthServer(
  t: Parameters<typeof scratch>[0],
  options: { refuse?: boolean } = {},
): Promise<OAuthServer> {
  const state: OAuthServer = {
    origin: '',
    clients: [],
    authorizations: [],
    exchanges: [],
    valid: new Set(),
  };
  const challenges = new Map<string, { challenge: string; redirect: string }>();
  let issued = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', state.origin);
    let body = '';
    for await (const chunk of request) body += chunk;
    const json = (status: number, value: unknown, headers = {}) =>
      response
        .writeHead(status, { 'content-type': 'application/json', ...headers })
        .end(JSON.stringify(value));
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp')
      return json(200, {
        resource: `${state.origin}/mcp`,
        authorization_servers: [state.origin],
      });
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json(200, {
        issuer: state.origin,
        authorization_endpoint: `${state.origin}/authorize`,
        token_endpoint: `${state.origin}/token`,
        registration_endpoint: `${state.origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    if (url.pathname === '/register') {
      const metadata = JSON.parse(body) as Record<string, unknown>;
      state.clients.push(metadata);
      return json(201, {
        ...metadata,
        client_id: `client-${state.clients.length}`,
        token_endpoint_auth_method: 'none',
      });
    }
    if (url.pathname === '/authorize') {
      state.authorizations.push(url.searchParams);
      const redirect = url.searchParams.get('redirect_uri')!;
      const back = new URL(redirect);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      if (options.refuse) back.searchParams.set('error', 'access_denied');
      else {
        const code = `code-${state.authorizations.length}`;
        challenges.set(code, {
          challenge: url.searchParams.get('code_challenge')!,
          redirect,
        });
        back.searchParams.set('code', code);
      }
      response.writeHead(302, { location: back.href }).end();
      return;
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(body);
      state.exchanges.push(form);
      const kept = challenges.get(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      if (
        !kept ||
        createHash('sha256').update(verifier).digest('base64url') !==
          kept.challenge ||
        form.get('redirect_uri') !== kept.redirect
      )
        return json(400, { error: 'invalid_grant' });
      challenges.delete(form.get('code')!);
      const token = `token-${++issued}`;
      state.valid.add(token);
      return json(200, { access_token: token, token_type: 'Bearer' });
    }
    if (url.pathname === '/mcp' && request.method === 'POST') {
      const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? '');
      if (!bearer || !state.valid.has(bearer[1]!))
        return json(
          401,
          { error: 'unauthorized' },
          {
            'www-authenticate': `Bearer resource_metadata="${state.origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        );
      const rpc = JSON.parse(body) as Rpc;
      if (rpc.id === undefined) return response.writeHead(202).end();
      const result =
        rpc.method === 'initialize'
          ? {
              protocolVersion: rpc.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'oauth-fixture', version: '1' },
            }
          : rpc.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'echo',
                    description: 'Answers after a sign-in.',
                    inputSchema: { type: 'object', properties: {} },
                  },
                ],
              }
            : rpc.method === 'tools/call'
              ? { content: [{ type: 'text', text: 'signed-in answer' }] }
              : {};
      return json(200, { jsonrpc: '2.0', id: rpc.id, result });
    }
    response.writeHead(404).end();
  });
  cleanupServer(t, server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  state.origin = `http://127.0.0.1:${address.port}`;
  return state;
}

/** A browser that opens the sign-in page and follows its redirect to Circle's loopback address. */
const browser = (opened: string[]) => async (url: string) => {
  opened.push(url);
  const page = await fetch(url, { redirect: 'manual' });
  const location = page.headers.get('location');
  if (location) await fetch(location);
};

/** The manager's next change (a server connected or failed after its sign-in). */
function changes(): { onChange: () => void; next: () => Promise<void> } {
  let waiting: (() => void) | undefined;
  return {
    onChange: () => waiting?.(),
    next: () => new Promise<void>((resolve) => (waiting = resolve)),
  };
}

const context = { sessionId: 'test', signal: new AbortController().signal };

test('a server that asks for a sign-in is signed in through the browser, and the next start needs none', async (t) => {
  const server = await oauthServer(t);
  const home = scratch(t);
  const opened: string[] = [];
  const change = changes();
  const manager = new McpManager(scratch(t), 5000, undefined, {
    home,
    openUrl: browser(opened),
    onChange: change.onChange,
  });
  cleanup(t, () => manager.close());
  const connected = change.next();
  await manager.load([
    {
      name: 'remote',
      url: `${server.origin}/mcp`,
      transport: 'streamable_http',
    },
  ]);
  // The start is not held up: the server waits for its sign-in, its page named in /mcp.
  assert.equal(manager.status[0]!.error, SIGN_IN_WAITING);
  assert.match(
    manager.status[0]!.authorize!,
    /^http:\/\/127\.0\.0\.1:\d+\/authorize\?/,
  );
  assert.match(
    manager.describe(),
    /waiting for sign-in in the browser: http:\/\/127\.0\.0\.1/,
  );
  assert.equal(manager.tools.length, 0);
  await connected;
  assert.equal(manager.status[0]!.error, '', manager.describe());
  assert.equal(manager.status[0]!.authorize, undefined);
  assert.deepEqual(
    manager.tools.map((tool) => tool.name),
    ['remote_echo'],
  );
  assert.equal(await manager.tools[0]!.run({}, context), 'signed-in answer');

  // What the server saw: a public client on a loopback redirect, PKCE S256 and the resource.
  assert.equal(opened.length, 1);
  const [client] = server.clients;
  assert.match(String(client!.client_name), /^Circle/);
  assert.deepEqual(client!.redirect_uris, [
    `http://127.0.0.1:${new URL(String((client!.redirect_uris as string[])[0])).port}/callback`,
  ]);
  const [authorization] = server.authorizations;
  assert.equal(authorization!.get('code_challenge_method'), 'S256');
  assert.equal(authorization!.get('resource'), `${server.origin}/mcp`);

  // The tokens are kept in the Circle home, readable by the owner only.
  const kept = keptFor(home, `${server.origin}/mcp`);
  assert.equal(kept.tokens?.access_token, 'token-1');
  assert.equal(kept.client?.client_id, 'client-1');
  if (process.platform !== 'win32')
    assert.equal(statSync(mcpAuthPath(home)).mode & 0o777, 0o600);
  // The model's tools may not read it by name, as they may not read secrets.json.
  assert.ok(DEFAULT_CREDENTIAL_FILES.includes('mcp-auth.json'));
  const policy = new ApprovalPolicy(new ApprovalStore(scratch(t)), home);
  assert.equal(
    policy.review('execute', { command: 'cat ~/.circle/mcp-auth.json' })
      .verdict,
    'DENY',
  );

  // A second start with the same home connects at once.
  const again = new McpManager(scratch(t), 5000, undefined, {
    home,
    openUrl: browser(opened),
  });
  cleanup(t, () => again.close());
  await again.load([
    {
      name: 'remote',
      url: `${server.origin}/mcp`,
      transport: 'streamable_http',
    },
  ]);
  assert.equal(again.status[0]!.error, '', again.describe());
  assert.equal(opened.length, 1, 'no second sign-in');

  // A revoked token signs in again.
  server.valid.clear();
  const reconnected = change.next();
  await manager.load([
    {
      name: 'remote',
      url: `${server.origin}/mcp`,
      transport: 'streamable_http',
    },
  ]);
  assert.equal(manager.status[0]!.error, SIGN_IN_WAITING);
  await reconnected;
  assert.equal(manager.status[0]!.error, '', manager.describe());
  assert.equal(opened.length, 2);
  assert.equal(server.clients.length, 1, 'the registration is kept');
});

test('a credential header, or no home to keep a sign-in in, leaves the 401 a plain failure', async (t) => {
  const server = await oauthServer(t);
  const opened: string[] = [];
  const withHeader = new McpManager(scratch(t), 5000, undefined, {
    home: scratch(t),
    openUrl: browser(opened),
    secrets: () => ({ HUB: 'not-a-valid-token' }),
  });
  cleanup(t, () => withHeader.close());
  await withHeader.load([
    {
      name: 'remote',
      url: `${server.origin}/mcp`,
      transport: 'streamable_http',
      headers: { Authorization: 'Bearer ${secret:HUB}' },
    },
  ]);
  assert.notEqual(withHeader.status[0]!.error, '');
  assert.notEqual(withHeader.status[0]!.error, SIGN_IN_WAITING);
  assert.equal(withHeader.status[0]!.authorize, undefined);

  const homeless = new McpManager(scratch(t), 5000, undefined, {
    openUrl: browser(opened),
  });
  cleanup(t, () => homeless.close());
  await homeless.load([
    {
      name: 'remote',
      url: `${server.origin}/mcp`,
      transport: 'streamable_http',
    },
  ]);
  assert.notEqual(homeless.status[0]!.error, '');
  assert.equal(homeless.status[0]!.authorize, undefined);
  assert.deepEqual(opened, [], 'no browser opened');
  assert.deepEqual(server.clients, [], 'nobody registered');
});

test('a refused sign-in says so; closing the manager stops a sign-in under way', async (t) => {
  const refusing = await oauthServer(t, { refuse: true });
  const change = changes();
  const manager = new McpManager(scratch(t), 5000, undefined, {
    home: scratch(t),
    openUrl: browser([]),
    onChange: change.onChange,
  });
  cleanup(t, () => manager.close());
  const failed = change.next();
  await manager.load([
    {
      name: 'remote',
      url: `${refusing.origin}/mcp`,
      transport: 'streamable_http',
    },
  ]);
  await failed;
  assert.equal(
    manager.status[0]!.error,
    'sign-in failed: the server refused the sign-in (access_denied)',
  );
  assert.equal(manager.status[0]!.authorize, undefined);

  const server = await oauthServer(t);
  const home = scratch(t);
  const idle = new McpManager(scratch(t), 5000, undefined, {
    home,
    openUrl: async () => {},
  });
  await idle.load([
    {
      name: 'remote',
      url: `${server.origin}/mcp`,
      transport: 'streamable_http',
    },
  ]);
  assert.equal(idle.status[0]!.error, SIGN_IN_WAITING);
  const port = keptFor(home, `${server.origin}/mcp`).port!;
  await idle.close();
  // The loopback port is free again once the wait ended.
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
  });
});

test('the redirect port is kept per server, and a new port drops the registration made for the old', async (t) => {
  const home = scratch(t);
  const first = await redirectPort(home, 'http://192.0.2.10/mcp');
  assert.equal(await redirectPort(home, 'http://192.0.2.10/mcp'), first);
  const provider = new McpAuthProvider(home, 'http://192.0.2.10/mcp', first);
  provider.saveClientInformation({
    client_id: 'c',
    redirect_uris: [provider.redirectUrl],
  });
  assert.equal(keptFor(home, 'http://192.0.2.10/mcp').client?.client_id, 'c');
  // The kept port is taken: another is chosen, and the client registered for the old one is dropped.
  const blocker = createServer();
  await new Promise<void>((resolve) =>
    blocker.listen(first, '127.0.0.1', resolve),
  );
  cleanup(
    t,
    () => new Promise<void>((resolve) => blocker.close(() => resolve())),
  );
  const second = await redirectPort(home, 'http://192.0.2.10/mcp');
  assert.notEqual(second, first);
  assert.equal(keptFor(home, 'http://192.0.2.10/mcp').client, undefined);
  assert.equal(
    keptFor(home, 'http://192.0.2.20/mcp').port,
    undefined,
    'servers are kept apart',
  );
});

test('the redirect listener takes only its own state and answers anything else with a page', async (t) => {
  const port = await redirectPort(scratch(t), 'http://192.0.2.10/mcp');
  const controller = new AbortController();
  cleanup(t, () => controller.abort());
  const redirect = startRedirect(port, () => 'expected', controller.signal);
  await redirect.ready;
  const foreign = await fetch(
    `http://127.0.0.1:${port}/callback?code=x&state=other`,
  );
  assert.equal(foreign.status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status, 404);
  const ours = await fetch(
    `http://127.0.0.1:${port}/callback?code=the-code&state=expected`,
  );
  assert.equal(ours.status, 200);
  assert.match(await ours.text(), /Circle is signed in/);
  assert.equal(await redirect.code, 'the-code');
});
