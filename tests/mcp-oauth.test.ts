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
  mergeScopes,
  parseBearerChallenge,
  reauthorizeServer,
  redirectPort,
  selectAuthorizationScope,
  startRedirect,
} from '../src/mcp_auth.js';
import {
  McpManager,
  REAUTHORIZATION_REQUIRED,
  SIGN_IN_WAITING,
  TOOLS_NOT_LISTED_AGAIN,
} from '../src/mcp_loader.js';
import { DEVICE_CODE_GRANT } from '../src/mcp_device.js';
import {
  ApprovalPolicy,
  ApprovalStore,
  DEFAULT_CREDENTIAL_FILES,
} from '../src/approvals.js';
import { cleanup, cleanupServer, scratch, until } from './helpers.js';

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
  /** Device authorization requests the server saw. */
  devices: URLSearchParams[];
  /** Set when a person approved the device code on the server's page. */
  approved: boolean;
}

async function oauthServer(
  t: Parameters<typeof scratch>[0],
  options: {
    refuse?: boolean;
    /** Offer the device code (RFC 8628); `noCode` refuses to give one, `deny` refuses the sign-in on the page. */
    device?: { noCode?: boolean; deny?: boolean };
    /** Say it sends `iss` with the code (RFC 9207), and send this one: its own issuer, or another's. */
    iss?: 'own' | 'other';
  } = {},
): Promise<OAuthServer> {
  const state: OAuthServer = {
    origin: '',
    clients: [],
    authorizations: [],
    exchanges: [],
    valid: new Set(),
    devices: [],
    approved: false,
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
        grant_types_supported: options.device
          ? ['authorization_code', DEVICE_CODE_GRANT]
          : ['authorization_code'],
        ...(options.device
          ? { device_authorization_endpoint: `${state.origin}/device` }
          : {}),
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        ...(options.iss
          ? { authorization_response_iss_parameter_supported: true }
          : {}),
      });
    if (url.pathname === '/device' && request.method === 'POST') {
      state.devices.push(new URLSearchParams(body));
      if (options.device?.noCode)
        return json(400, { error: 'unauthorized_client' });
      return json(200, {
        device_code: 'device-code-1',
        user_code: 'BCDF-GHJK',
        verification_uri: `${state.origin}/device`,
        verification_uri_complete: `${state.origin}/device?user_code=BCDF-GHJK`,
        expires_in: 600,
        interval: 1,
      });
    }
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
      if (options.iss)
        back.searchParams.set(
          'iss',
          options.iss === 'own' ? state.origin : 'https://issuer.example',
        );
      response.writeHead(302, { location: back.href }).end();
      return;
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(body);
      state.exchanges.push(form);
      if (form.get('grant_type') === DEVICE_CODE_GRANT) {
        if (form.get('device_code') !== 'device-code-1')
          return json(400, { error: 'invalid_grant' });
        if (options.device?.deny) return json(400, { error: 'access_denied' });
        if (!state.approved)
          return json(400, { error: 'authorization_pending' });
        const token = `token-${++issued}`;
        state.valid.add(token);
        return json(200, { access_token: token, token_type: 'Bearer' });
      }
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
  await manager.load({ remote: { url: `${server.origin}/mcp`, type: 'http' } });
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
    ['mcp__remote__echo'],
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
  await again.load({ remote: { url: `${server.origin}/mcp`, type: 'http' } });
  assert.equal(again.status[0]!.error, '', again.describe());
  assert.equal(opened.length, 1, 'no second sign-in');

  // A revoked token signs in again.
  server.valid.clear();
  const reconnected = change.next();
  await manager.load({ remote: { url: `${server.origin}/mcp`, type: 'http' } });
  assert.equal(manager.status[0]!.error, SIGN_IN_WAITING);
  await reconnected;
  assert.equal(manager.status[0]!.error, '', manager.describe());
  assert.equal(opened.length, 2);
  assert.equal(server.clients.length, 1, 'the registration is kept');
});

test('a code the browser brings back from another issuer is not exchanged; one from its own is (RFC 9207)', async (t) => {
  for (const iss of ['other', 'own'] as const) {
    const server = await oauthServer(t, { iss });
    const change = changes();
    const manager = new McpManager(scratch(t), 5000, undefined, {
      home: scratch(t),
      openUrl: browser([]),
      onChange: change.onChange,
    });
    cleanup(t, () => manager.close());
    const settled = change.next();
    await manager.load({
      remote: { url: `${server.origin}/mcp`, type: 'http' },
    });
    assert.equal(manager.status[0]!.error, SIGN_IN_WAITING);
    await settled;
    if (iss === 'other') {
      assert.match(manager.status[0]!.error, /^sign-in failed: /);
      assert.deepEqual(server.exchanges, [], 'the code was never redeemed');
      assert.equal(manager.tools.length, 0);
    } else {
      assert.equal(manager.status[0]!.error, '', manager.describe());
      assert.equal(server.exchanges.length, 1);
      assert.equal(
        await manager.tools[0]!.run({}, context),
        'signed-in answer',
      );
    }
  }
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
  await withHeader.load({
    remote: {
      url: `${server.origin}/mcp`,
      type: 'http',
      headers: { Authorization: 'Bearer ${HUB}' },
    },
  });
  assert.notEqual(withHeader.status[0]!.error, '');
  assert.notEqual(withHeader.status[0]!.error, SIGN_IN_WAITING);
  assert.equal(withHeader.status[0]!.authorize, undefined);

  const homeless = new McpManager(scratch(t), 5000, undefined, {
    openUrl: browser(opened),
  });
  cleanup(t, () => homeless.close());
  await homeless.load({
    remote: { url: `${server.origin}/mcp`, type: 'http' },
  });
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
  await manager.load({
    remote: { url: `${refusing.origin}/mcp`, type: 'http' },
  });
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
  await idle.load({ remote: { url: `${server.origin}/mcp`, type: 'http' } });
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

test('parseBearerChallenge parses RFC challenges safely and mergeScopes deduplicates scope lists', () => {
  assert.deepEqual(parseBearerChallenge(null), {});
  assert.deepEqual(parseBearerChallenge('Basic realm="corp"'), {});
  assert.deepEqual(
    parseBearerChallenge(
      'Bearer error="insufficient_scope", error_description="needs scope=admin", scope="bot"',
    ),
    {
      scheme: 'bearer',
      error: 'insufficient_scope',
      errorDescription: 'needs scope=admin',
      scope: 'bot',
      resourceMetadataUrl: undefined,
    },
  );
  assert.deepEqual(
    parseBearerChallenge(
      'Bearer error="insufficient_scope", error_description="needs scope=admin"',
    ),
    {
      scheme: 'bearer',
      error: 'insufficient_scope',
      errorDescription: 'needs scope=admin',
      scope: undefined,
      resourceMetadataUrl: undefined,
    },
  );
  assert.deepEqual(
    parseBearerChallenge(
      'Basic realm="internal", BEARER ERROR="insufficient_scope", ERROR_DESCRIPTION="say \\"scope=wrong\\"", SCOPE=bot, RESOURCE_METADATA="https://example.test/.well-known/prm"',
    ),
    {
      scheme: 'bearer',
      error: 'insufficient_scope',
      errorDescription: 'say "scope=wrong"',
      scope: 'bot',
      resourceMetadataUrl: 'https://example.test/.well-known/prm',
    },
  );
  assert.deepEqual(
    parseBearerChallenge('Basic dXNlcjpwYXNz==, DPoP scope="bot extra"'),
    {
      scheme: 'dpop',
      error: undefined,
      errorDescription: undefined,
      scope: 'bot extra',
      resourceMetadataUrl: undefined,
    },
  );
  assert.deepEqual(
    parseBearerChallenge('Bearer error="invalid_token", Basic scope="wrong"'),
    {
      scheme: 'bearer',
      error: 'invalid_token',
      errorDescription: undefined,
      scope: undefined,
      resourceMetadataUrl: undefined,
    },
  );
  assert.deepEqual(
    parseBearerChallenge(
      'Basic scope="wrong", Bearer error="insufficient_scope", scope="bot"',
    ),
    {
      scheme: 'bearer',
      error: 'insufficient_scope',
      errorDescription: undefined,
      scope: 'bot',
      resourceMetadataUrl: undefined,
    },
  );
  assert.deepEqual(
    parseBearerChallenge('Bearer error="invalid_token", Bearer scope="wrong"'),
    {
      scheme: 'bearer',
      error: 'invalid_token',
      errorDescription: undefined,
      scope: undefined,
      resourceMetadataUrl: undefined,
    },
  );
  assert.equal(mergeScopes(undefined, '', '  '), undefined);
  assert.equal(
    mergeScopes('alpha  beta', 'beta gamma', ['gamma', 'bot']),
    'alpha beta gamma bot',
  );
});

test('authorization selects 401 WWW-Authenticate scope over scopes_supported and falls back to scopes_supported in device flow', async (t) => {
  assert.equal(
    selectAuthorizationScope({
      challengeScope: 'alpha beta',
      discovery: {
        authorizationServerUrl: 'https://as.example.test',
        resourceMetadata: {
          resource: 'https://rs.example.test/mcp',
          scopes_supported: ['gamma', 'delta'],
        },
      },
    }),
    'alpha beta',
  );
  assert.equal(
    selectAuthorizationScope({
      discovery: {
        authorizationServerUrl: 'https://as.example.test',
        resourceMetadata: {
          resource: 'https://rs.example.test/mcp',
          scopes_supported: ['gamma', 'delta'],
        },
      },
      requiredScope: 'bot',
    }),
    'gamma delta bot',
  );
  for (const mode of ['challenge', 'metadata'] as const) {
    let port = 0;
    const seenDeviceScopes: string[] = [];
    let tokenCount = 0;
    const issuedTokens = new Set<string>();
    const base = () => `http://127.0.0.1:${port}`;
    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', base());
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              resource: `${base()}/mcp`,
              authorization_servers: [base()],
              scopes_supported: ['gamma', 'delta'],
            }),
          );
          return;
        }
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
              device_authorization_endpoint: `${base()}/device_authorization`,
            }),
          );
          return;
        }
        if (url.pathname === '/register') {
          const parsed = JSON.parse(body) as { redirect_uris?: string[] };
          res.writeHead(201, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              client_id: 'cli-1',
              redirect_uris: parsed.redirect_uris ?? [],
              token_endpoint_auth_method: 'none',
            }),
          );
          return;
        }
        if (url.pathname === '/device_authorization') {
          const form = new URLSearchParams(body);
          seenDeviceScopes.push(form.get('scope') ?? '');
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              device_code: 'dc-1',
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
          const tok = `tok-${++tokenCount}`;
          issuedTokens.add(tok);
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ access_token: tok, token_type: 'Bearer' }));
          return;
        }
        if (url.pathname === '/mcp') {
          const authHeader = req.headers.authorization ?? '';
          const bearer = authHeader.replace(/^Bearer /i, '');
          if (!issuedTokens.has(bearer)) {
            const challenge =
              mode === 'challenge'
                ? `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource/mcp", scope="alpha beta"`
                : `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource/mcp"`;
            res.writeHead(401, { 'www-authenticate': challenge }).end();
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

    const home = scratch(t);
    const change = changes();
    const manager = new McpManager(scratch(t), 5000, undefined, {
      home,
      onChange: change.onChange,
      openUrl: async () => {},
    });
    cleanup(t, () => manager.close());

    const connected = change.next();
    await manager.load({ remote: { url: `${base()}/mcp`, type: 'http' } });
    await connected;
    while (manager.status[0]!.error) {
      await change.next();
    }
    assert.deepEqual(seenDeviceScopes, [
      mode === 'challenge' ? 'alpha beta' : 'gamma delta',
    ]);
    assert.equal(manager.status[0]!.error, '');
  }
});

test('reauthorizeServer preserves tokens while merging scope, and sends passed scope when cached discovery lacks scopes_supported', async (t) => {
  for (const flow of ['browser', 'device'] as const) {
    let port = 0;
    const base = () => `http://127.0.0.1:${port}`;
    const validTokens = new Set<string>(['tok-old']);
    const seenAuthScopes: string[] = [];
    const seenDeviceScopes: string[] = [];
    let codeSeq = 0;

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
              grant_types_supported:
                flow === 'device'
                  ? [
                      'authorization_code',
                      'urn:ietf:params:oauth:grant-type:device_code',
                    ]
                  : ['authorization_code'],
              ...(flow === 'device'
                ? {
                    device_authorization_endpoint: `${base()}/device_authorization`,
                  }
                : {}),
            }),
          );
          return;
        }
        if (url.pathname === '/device_authorization') {
          const form = new URLSearchParams(body);
          seenDeviceScopes.push(form.get('scope') ?? '');
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              device_code: 'dc-1',
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
          const tok = `tok-new-${++codeSeq}`;
          validTokens.add(tok);
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              access_token: tok,
              token_type: 'Bearer',
              scope: 'bot',
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

    const home = scratch(t);
    const serverKey = `${base()}/mcp`;
    const portUsed = await redirectPort(home, serverKey);
    const seed = new McpAuthProvider(home, serverKey, portUsed);
    seed.saveClientInformation({
      client_id: 'cli-old',
      redirect_uris: [seed.redirectUrl],
    });
    seed.saveTokens({ access_token: 'tok-old', token_type: 'Bearer' });
    seed.saveDiscoveryState({
      authorizationServerUrl: base(),
      resourceMetadata: {
        resource: serverKey,
        authorization_servers: [base()],
      },
      authorizationServerMetadata: {
        issuer: base(),
        authorization_endpoint: `${base()}/authorize`,
        token_endpoint: `${base()}/token`,
        registration_endpoint: `${base()}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported:
          flow === 'device'
            ? [
                'authorization_code',
                'urn:ietf:params:oauth:grant-type:device_code',
              ]
            : ['authorization_code'],
        ...(flow === 'device'
          ? { device_authorization_endpoint: `${base()}/device_authorization` }
          : {}),
      },
    });

    reauthorizeServer(home, serverKey, 'bot');
    assert.equal(keptFor(home, serverKey).tokens?.access_token, 'tok-old');
    assert.equal(keptFor(home, serverKey).required_scope, 'bot');

    const change = changes();
    const manager = new McpManager(scratch(t), 5000, undefined, {
      home,
      onChange: change.onChange,
      openUrl: async (target) => {
        const parsed = new URL(target);
        seenAuthScopes.push(parsed.searchParams.get('scope') ?? '');
        if (flow !== 'browser') return;
        const redirect = new URL(parsed.searchParams.get('redirect_uri')!);
        redirect.searchParams.set('code', 'code-1');
        redirect.searchParams.set('state', parsed.searchParams.get('state')!);
        redirect.searchParams.set('iss', base());
        await fetch(redirect);
      },
    });
    cleanup(t, () => manager.close());

    const entry = { remote: { url: serverKey, type: 'http' as const } };
    await manager.load(entry);
    assert.equal(manager.status[0]!.error, '');

    await manager.reauthorizeServer('remote', entry, { scope: 'bot' });
    await until(
      () =>
        manager.status[0]!.error === '' &&
        keptFor(home, serverKey).tokens?.access_token === 'tok-new-1',
    );
    assert.equal(manager.status[0]!.error, '');
    assert.equal(keptFor(home, serverKey).tokens?.access_token, 'tok-new-1');
    assert.equal(keptFor(home, serverKey).required_scope, undefined);
    assert.equal(keptFor(home, serverKey).client?.client_id, 'cli-old');
    if (flow === 'browser') {
      assert.deepEqual(seenAuthScopes, ['bot']);
    } else {
      assert.deepEqual(seenDeviceScopes, ['bot']);
    }
  }
});

test('403 insufficient_scope on StreamableHTTP and SSE preserves tokens and live connection until re-authorization finishes, ignores discovery/registration 403, and keeps ordinary 401 unchanged', async (t) => {
  for (const transport of ['http', 'sse'] as const) {
    let port = 0;
    const base = () => `http://127.0.0.1:${port}`;
    const validInitial = new Set<string>(['tok-initial']);
    const validUpgraded = new Set<string>();
    const revoked: string[] = [];
    let clientSeq = 0;
    let codeSeq = 0;
    const registeredIds: string[] = [];
    const authRequests: URL[] = [];
    const sseStreams = new Set<import('node:http').ServerResponse>();
    let allowApprove = true;
    let rejectConnectUntilUpgraded = false;
    let listUnauthorized = false;
    let rejectCall401 = false;
    let slowStarted: (() => void) | undefined;
    let releaseSlow: (() => void) | undefined;

    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', base());
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              resource: `${base()}/${transport === 'http' ? 'mcp' : 'sse'}`,
              authorization_servers: [base()],
              scopes_supported: ['bot'],
            }),
          );
          return;
        }
        if (url.pathname === '/.well-known/oauth-authorization-server') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              issuer: base(),
              authorization_endpoint: `${base()}/authorize`,
              token_endpoint: `${base()}/token`,
              registration_endpoint: `${base()}/register`,
              revocation_endpoint: `${base()}/revoke`,
              response_types_supported: ['code'],
              code_challenge_methods_supported: ['S256'],
              grant_types_supported: ['authorization_code'],
            }),
          );
          return;
        }
        if (url.pathname === '/register') {
          const parsed = JSON.parse(body) as { redirect_uris?: string[] };
          const id = `cli-${++clientSeq}`;
          registeredIds.push(id);
          res.writeHead(201, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              client_id: id,
              redirect_uris: parsed.redirect_uris ?? [],
              token_endpoint_auth_method: 'none',
            }),
          );
          return;
        }
        if (url.pathname === '/revoke') {
          const params = new URLSearchParams(body);
          revoked.push(params.get('token') ?? '');
          res.writeHead(200).end();
          return;
        }
        if (url.pathname === '/token') {
          const tok = `tok-upgraded-${++codeSeq}`;
          validUpgraded.add(tok);
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              access_token: tok,
              token_type: 'Bearer',
              scope: 'bot',
            }),
          );
          return;
        }

        const bearer = (req.headers.authorization ?? '').replace(
          /^Bearer /i,
          '',
        );
        if (!validInitial.has(bearer) && !validUpgraded.has(bearer)) {
          res
            .writeHead(401, {
              'www-authenticate': `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource"`,
            })
            .end();
          return;
        }

        const replyRpc = (rpc: { id?: unknown }, result: unknown) => {
          if (transport === 'sse') {
            if (rpc.id !== undefined) {
              for (const stream of sseStreams) {
                stream.write(
                  `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`,
                );
              }
            }
            res.writeHead(202).end();
          } else {
            res
              .writeHead(200, { 'content-type': 'application/json' })
              .end(
                rpc.id === undefined
                  ? ''
                  : JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }),
              );
          }
        };

        if (
          transport === 'sse' &&
          url.pathname === '/sse' &&
          req.method === 'GET'
        ) {
          if (rejectConnectUntilUpgraded && !validUpgraded.has(bearer)) {
            res
              .writeHead(403, {
                'www-authenticate':
                  'Bearer error="insufficient_scope", scope="bot"',
                'content-type': 'application/json',
              })
              .end(JSON.stringify({ error: 'insufficient_scope' }));
            return;
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          });
          res.write('event: endpoint\ndata: /messages\n\n');
          sseStreams.add(res);
          res.on('close', () => sseStreams.delete(res));
          return;
        }

        if (
          (transport === 'http' && url.pathname === '/mcp') ||
          (transport === 'sse' && url.pathname === '/messages')
        ) {
          const rpc = JSON.parse(body) as {
            id?: unknown;
            method?: string;
            params?: { arguments?: { slow?: boolean } };
          };
          if (rpc.method === 'initialize') {
            if (rejectConnectUntilUpgraded && !validUpgraded.has(bearer)) {
              res
                .writeHead(403, {
                  'www-authenticate':
                    'Bearer error="insufficient_scope", scope="bot"',
                  'content-type': 'application/json',
                })
                .end(JSON.stringify({ error: 'insufficient_scope' }));
              return;
            }
            replyRpc(rpc, {
              protocolVersion: '2025-03-26',
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: 'srv', version: '1.0.0' },
            });
            return;
          }
          if (rpc.method === 'tools/list') {
            if (listUnauthorized) {
              res
                .writeHead(401, {
                  'www-authenticate': `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource"`,
                })
                .end();
              return;
            }
            replyRpc(rpc, {
              tools: [
                {
                  name: 'ping',
                  description: 'ping',
                  inputSchema: {
                    type: 'object',
                    properties: { slow: { type: 'boolean' } },
                  },
                },
              ],
            });
            return;
          }
          if (rpc.method === 'tools/call') {
            if (rpc.params?.arguments?.slow) {
              slowStarted?.();
              releaseSlow = () =>
                replyRpc(rpc, { content: [{ type: 'text', text: 'slow-ok' }] });
              return;
            }
            if (rejectCall401) {
              res
                .writeHead(401, {
                  'www-authenticate': `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource"`,
                })
                .end();
              return;
            }
            if (!validUpgraded.has(bearer)) {
              res
                .writeHead(403, {
                  'www-authenticate':
                    'Bearer error="insufficient_scope", scope="bot"',
                  'content-type': 'application/json',
                })
                .end(JSON.stringify({ error: 'insufficient_scope' }));
              return;
            }
            replyRpc(rpc, { content: [{ type: 'text', text: 'pong' }] });
            return;
          }
          replyRpc(rpc, {});
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    port = (srv.address() as { port: number }).port;
    cleanup(t, () => {
      for (const s of sseStreams) s.end();
      srv.closeAllConnections?.();
      return new Promise<void>((resolve) => srv.close(() => resolve()));
    });

    const home = scratch(t);
    const serverKey = `${base()}/${transport === 'http' ? 'mcp' : 'sse'}`;
    const portUsed = await redirectPort(home, serverKey);
    const seedProvider = new McpAuthProvider(home, serverKey, portUsed);
    seedProvider.saveClientInformation({
      client_id: 'cli-seed',
      redirect_uris: [seedProvider.redirectUrl],
    });
    seedProvider.saveTokens({
      access_token: 'tok-initial',
      token_type: 'Bearer',
    });

    const change = changes();
    const manager = new McpManager(scratch(t), 5000, undefined, {
      home,
      onChange: change.onChange,
      openUrl: async (target) => {
        const parsed = new URL(target);
        authRequests.push(parsed);
        if (!allowApprove) return;
        const redirect = new URL(parsed.searchParams.get('redirect_uri')!);
        redirect.searchParams.set('code', `code-${codeSeq + 1}`);
        redirect.searchParams.set('state', parsed.searchParams.get('state')!);
        redirect.searchParams.set('iss', base());
        await fetch(redirect);
      },
    });
    cleanup(t, () => manager.close());

    const entry = { remote: { url: serverKey, type: transport } };
    await manager.load(entry);
    assert.equal(manager.status[0]!.error, '');

    // Retracted out-of-scope ordinary 401 checks: neither tool call nor tools/list disconnects or clears tools.
    rejectCall401 = true;
    await assert.rejects(() => manager.tools[0]!.run({}, context));
    assert.equal(manager.tools.length, 1);
    assert.equal(manager.status[0]!.authorize, undefined);
    rejectCall401 = false;

    listUnauthorized = true;
    for (const stream of sseStreams) {
      stream.write(
        'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n',
      );
    }
    if (transport === 'sse') {
      await until(() => manager.status[0]!.error === TOOLS_NOT_LISTED_AGAIN);
      assert.equal(manager.status[0]!.authorize, undefined);
      assert.equal(manager.tools.length, 1);
    }
    listUnauthorized = false;

    // 403 insufficient_scope on tool call keeps live connection & tokens while concurrent call completes.
    allowApprove = false;
    const waitSlow = new Promise<void>((resolve) => {
      slowStarted = resolve;
    });
    const slowPromise = manager.tools[0]!.run({ slow: true }, context);
    await waitSlow;
    await assert.rejects(
      () => manager.tools[0]!.run({}, context),
      (err: unknown) =>
        transport === 'sse' ||
        (err instanceof Error && err.name === 'InsufficientScopeError'),
    );
    assert.equal(manager.status[0]!.error, REAUTHORIZATION_REQUIRED);
    assert.equal(manager.status[0]!.authorize, undefined);
    assert.equal(manager.tools.length, 1);
    assert.deepEqual(manager.status[0]!.tools, ['mcp__remote__ping']);
    assert.equal(keptFor(home, serverKey).tokens?.access_token, 'tok-initial');
    assert.equal(keptFor(home, serverKey).required_scope, 'bot');
    assert.equal(keptFor(home, serverKey).client?.client_id, 'cli-seed');
    releaseSlow!();
    assert.equal(await slowPromise, 'slow-ok');

    // Initiating reauthorizeServer keeps tok-initial & live tools until sign-in finishes, and never calls /revoke.
    await manager.reauthorizeServer('remote', entry);
    assert.equal(manager.status[0]!.error, SIGN_IN_WAITING);
    assert.ok(manager.status[0]!.authorize);
    assert.equal(keptFor(home, serverKey).tokens?.access_token, 'tok-initial');
    assert.equal(manager.tools.length, 1);
    assert.equal(revoked.length, 0);

    allowApprove = true;
    await manager.reauthorizeServer('remote', entry);
    while (manager.status[0]!.error) await change.next();
    assert.equal(manager.status[0]!.error, '');
    assert.equal(keptFor(home, serverKey).client?.client_id, 'cli-seed');
    assert.equal(
      keptFor(home, serverKey).tokens?.access_token,
      'tok-upgraded-1',
    );
    assert.equal(keptFor(home, serverKey).required_scope, undefined);
    assert.equal(registeredIds.length, 0);
    assert.equal(revoked.length, 0);
    assert.equal(authRequests.at(-1)?.searchParams.get('scope'), 'bot');
    assert.equal(await manager.tools[0]!.run({}, context), 'pong');

    // Connect-time 403 insufficient_scope (on initialize / GET /sse) also marks re-authorization without dropping tokens.
    const home2 = scratch(t);
    const port2 = await redirectPort(home2, serverKey);
    const seed2 = new McpAuthProvider(home2, serverKey, port2);
    seed2.saveClientInformation({
      client_id: 'cli-connect-seed',
      redirect_uris: [seed2.redirectUrl],
    });
    seed2.saveTokens({ access_token: 'tok-initial', token_type: 'Bearer' });
    const manager2 = new McpManager(scratch(t), 5000, undefined, {
      home: home2,
      openUrl: async () => {},
    });
    cleanup(t, () => manager2.close());
    rejectConnectUntilUpgraded = true;
    allowApprove = false;
    await manager2.load(entry);
    assert.equal(manager2.status[0]!.error, REAUTHORIZATION_REQUIRED);
    assert.equal(manager2.status[0]!.authorize, undefined);
    assert.equal(keptFor(home2, serverKey).tokens?.access_token, 'tok-initial');
    assert.equal(keptFor(home2, serverKey).required_scope, 'bot');
    assert.equal(
      keptFor(home2, serverKey).client?.client_id,
      'cli-connect-seed',
    );
    rejectConnectUntilUpgraded = false;
  }

  // 403 on discovery or client registration must not record required_scope or REAUTHORIZATION_REQUIRED.
  for (const failAt of ['discovery', 'register'] as const) {
    let port = 0;
    const base = () => `http://127.0.0.1:${port}`;
    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', base());
      req.resume();
      req.on('end', () => {
        if (url.pathname === '/mcp') {
          res
            .writeHead(401, {
              'www-authenticate': `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource/mcp"`,
            })
            .end();
          return;
        }
        if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
          if (failAt === 'discovery') {
            res
              .writeHead(403, {
                'www-authenticate':
                  'Bearer error="insufficient_scope", scope="admin"',
              })
              .end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              resource: `${base()}/mcp`,
              authorization_servers: [base()],
            }),
          );
          return;
        }
        if (url.pathname === '/.well-known/oauth-authorization-server') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              issuer: base(),
              authorization_endpoint: `${base()}/authorize`,
              token_endpoint: `${base()}/token`,
              registration_endpoint: `${base()}/register`,
              response_types_supported: ['code'],
              code_challenge_methods_supported: ['S256'],
              grant_types_supported: ['authorization_code'],
            }),
          );
          return;
        }
        if (url.pathname === '/register') {
          res
            .writeHead(403, {
              'www-authenticate':
                'Bearer error="insufficient_scope", scope="admin"',
            })
            .end();
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
    const home = scratch(t);
    const serverKey = `${base()}/mcp`;
    const manager = new McpManager(scratch(t), 5000, undefined, {
      home,
      openUrl: async () => {},
    });
    cleanup(t, () => manager.close());
    await manager.load({ remote: { url: serverKey, type: 'http' } });
    assert.notEqual(manager.status[0]!.error, REAUTHORIZATION_REQUIRED);
    assert.equal(keptFor(home, serverKey).required_scope, undefined);
  }
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

test('a server whose authorization server offers the device code shows a code, and connects once it is approved', async (t) => {
  const server = await oauthServer(t, { device: {} });
  const opened: string[] = [];
  const change = changes();
  const home = scratch(t);
  const manager = new McpManager(scratch(t), 5000, undefined, {
    home,
    openUrl: async (url) => void opened.push(url),
    onChange: change.onChange,
  });
  cleanup(t, () => manager.close());
  const shown = change.next();
  await manager.load({ remote: { url: `${server.origin}/mcp`, type: 'http' } });
  await shown;
  const waiting = manager.status[0]!;
  assert.equal(waiting.error, 'enter the code BCDF-GHJK on the sign-in page');
  assert.equal(waiting.code, 'BCDF-GHJK');
  assert.equal(
    waiting.authorize,
    `${server.origin}/device?user_code=BCDF-GHJK`,
  );
  assert.match(
    manager.describe(),
    /enter the code BCDF-GHJK on the sign-in page: http:\/\/127\.0\.0\.1:\d+\/device\?user_code=BCDF-GHJK/,
  );
  assert.deepEqual(
    opened,
    [waiting.authorize],
    'the page opens with the code filled in',
  );
  // Registered asking for the device code, since the server offers it; no browser sign-in was started
  assert.deepEqual(server.clients[0]!.grant_types, [
    'authorization_code',
    'refresh_token',
    DEVICE_CODE_GRANT,
  ]);
  assert.equal(server.devices[0]!.get('client_id'), 'client-1');
  assert.equal(server.devices[0]!.get('resource'), `${server.origin}/mcp`);
  assert.deepEqual(server.authorizations, []);

  // Until a person approves, the server answers authorization_pending and Circle keeps polling
  const polled = () =>
    server.exchanges.filter(
      (form) => form.get('grant_type') === DEVICE_CODE_GRANT,
    ).length;
  for (const deadline = Date.now() + 10_000; polled() === 0;) {
    assert.ok(Date.now() < deadline, 'a first poll');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(manager.status[0]!.code, 'BCDF-GHJK', 'still waiting');
  // A person approves on the page: the next poll gets the token and the server connects with it
  const connected = change.next();
  server.approved = true;
  await connected;
  assert.equal(manager.status[0]!.error, '');
  assert.equal(manager.status[0]!.code, undefined);
  assert.equal(manager.status[0]!.authorize, undefined);
  assert.deepEqual(manager.status[0]!.tools, ['mcp__remote__echo']);
  const polls = server.exchanges.filter(
    (form) => form.get('grant_type') === DEVICE_CODE_GRANT,
  );
  assert.ok(polls.length >= 2, 'it polled until the approval');
  assert.ok(polls.every((form) => form.get('client_id') === 'client-1'));
  const kept = keptFor(home, `${server.origin}/mcp`);
  assert.ok(
    kept.tokens?.access_token && server.valid.has(kept.tokens.access_token),
  );
  assert.ok(kept.grant_id, 'the tokens are a new grant');
  if (process.platform !== 'win32')
    assert.equal(statSync(mcpAuthPath(home)).mode & 0o777, 0o600);
});

test('a server that gives no device code is signed in through the browser instead', async (t) => {
  const server = await oauthServer(t, { device: { noCode: true } });
  const opened: string[] = [];
  const change = changes();
  const manager = new McpManager(scratch(t), 5000, undefined, {
    home: scratch(t),
    openUrl: browser(opened),
    onChange: change.onChange,
  });
  cleanup(t, () => manager.close());
  const connected = change.next();
  await manager.load({ remote: { url: `${server.origin}/mcp`, type: 'http' } });
  await connected;
  assert.equal(server.devices.length, 1, 'it asked for a code first');
  assert.equal(
    server.authorizations.length,
    1,
    'then signed in through the browser',
  );
  assert.equal(opened.length, 1);
  assert.match(opened[0]!, /\/authorize\?/);
  assert.equal(manager.status[0]!.error, '');
  assert.deepEqual(manager.status[0]!.tools, ['mcp__remote__echo']);
});

test('a device sign-in refused on the page says so and leaves no code shown', async (t) => {
  const server = await oauthServer(t, { device: { deny: true } });
  const change = changes();
  const manager = new McpManager(scratch(t), 5000, undefined, {
    home: scratch(t),
    openUrl: async () => {},
    onChange: change.onChange,
  });
  cleanup(t, () => manager.close());
  const shown = change.next();
  await manager.load({ remote: { url: `${server.origin}/mcp`, type: 'http' } });
  await shown;
  const failed = change.next();
  await failed;
  assert.equal(
    manager.status[0]!.error,
    'sign-in failed: the sign-in was refused',
  );
  assert.equal(manager.status[0]!.code, undefined);
  assert.equal(manager.status[0]!.authorize, undefined);
  assert.deepEqual(manager.status[0]!.tools, []);
});
