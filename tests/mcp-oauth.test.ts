// The MCP authorization: a server on loopback that answers 401 with its resource metadata, registers clients, approves
// at once (as a person would on its page) and checks PKCE when it exchanges the code. A scripted browser follows the
// sign-in page to Circle's loopback redirect. Real effects are checked: what the server received, the tokens kept in
// the Circle home and their file mode, the tools offered after the sign-in, and a second start that needs no sign-in.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  McpAuthProvider,
  keptFor,
  mcpAuthPath,
  mergeScopes,
  parseBearerChallenge,
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

    assert.equal(keptFor(home, serverKey).tokens?.access_token, 'tok-old');

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
    assert.equal(
      'required_scope' in (keptFor(home, serverKey) as Record<string, unknown>),
      false,
    );
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
    assert.equal(
      'required_scope' in (keptFor(home, serverKey) as Record<string, unknown>),
      false,
    );
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
    const pendingAuthUrl = new URL(manager.status[0]!.authorize!);
    const pendingRedirect = new URL(
      pendingAuthUrl.searchParams.get('redirect_uri')!,
    );
    pendingRedirect.searchParams.set('code', `code-${codeSeq + 1}`);
    pendingRedirect.searchParams.set(
      'state',
      pendingAuthUrl.searchParams.get('state')!,
    );
    pendingRedirect.searchParams.set('iss', base());
    await fetch(pendingRedirect);
    while (manager.status[0]!.error) await change.next();
    assert.equal(manager.status[0]!.error, '');
    assert.equal(keptFor(home, serverKey).client?.client_id, 'cli-seed');
    assert.equal(
      keptFor(home, serverKey).tokens?.access_token,
      'tok-upgraded-1',
    );
    assert.equal(
      'required_scope' in (keptFor(home, serverKey) as Record<string, unknown>),
      false,
    );
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
    assert.equal(
      'required_scope' in
        (keptFor(home2, serverKey) as Record<string, unknown>),
      false,
    );
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
    assert.equal(
      'required_scope' in (keptFor(home, serverKey) as Record<string, unknown>),
      false,
    );
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

test('C4-M1: reconnecting while initial sign-in is waiting preserves device code (as on main) and browser URL (reusing the waiting redirect port so client registration stays valid)', async (t) => {
  for (const flow of ['device', 'browser'] as const) {
    const server = await oauthServer(
      t,
      flow === 'device' ? { device: {} } : {},
    );
    const opened: string[] = [];
    const change = changes();
    const manager = new McpManager(scratch(t), 5000, undefined, {
      home: scratch(t),
      onChange: change.onChange,
      openUrl: async (url) => {
        opened.push(url);
      },
    });
    cleanup(t, () => manager.close());

    const entry = {
      remote: { type: 'http' as const, url: `${server.origin}/mcp` },
    };
    const loadWait =
      flow === 'device'
        ? until(() => Boolean(manager.status[0]?.code))
        : Promise.resolve();
    await manager.load(entry);
    await loadWait;
    if (flow === 'browser') await until(() => opened.length === 1);

    const authorizeBefore = manager.status[0]!.authorize;
    const codeBefore = manager.status[0]!.code;
    const errorBefore = manager.status[0]!.error;
    const devicesBefore = server.devices.length;
    const clientsBefore = server.clients.length;

    await manager.reloadServer('remote', entry);

    assert.equal(manager.status[0]!.authorize, authorizeBefore);
    assert.equal(manager.status[0]!.code, codeBefore);
    assert.equal(manager.status[0]!.error, errorBefore);
    assert.equal(opened.length, 1);
    assert.equal(server.devices.length, devicesBefore);
    assert.equal(server.clients.length, clientsBefore);

    if (flow === 'device') {
      const connected = change.next();
      server.approved = true;
      await connected;
    } else {
      const page = await fetch(authorizeBefore!, { redirect: 'manual' });
      const location = page.headers.get('location');
      assert.ok(location);
      const response = await fetch(location);
      assert.equal(response.status, 200);
      await until(() => manager.status[0]?.error === '');
    }
    assert.equal(manager.status[0]!.error, '');
    assert.deepEqual(manager.status[0]!.tools, ['mcp__remote__echo']);
  }
});

test('C4-S1/C4-M1: required scope lives only in McpManager memory, isolates sibling managers, survives post-sign-in connect 403, and tolerates null mcp-auth entries', async (t) => {
  let port = 0;
  const base = () => `http://127.0.0.1:${port}`;
  const validTokens = new Set(['tok-1']);
  const tokensNeedingScope = new Set<string>();
  const authRequests: URL[] = [];
  let tokenSeq = 1;
  let toolMode: 'ok' | 'scope_x' = 'ok';
  let connect403ForToken = false;
  let callbackMode: 'hold' | 'invalid_scope' | 'approve' | 'approve_no_scope' =
    'approve';

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
            grant_types_supported: ['authorization_code'],
          }),
        );
        return;
      }
      if (url.pathname === '/token') {
        const tok = `tok-${++tokenSeq}`;
        validTokens.add(tok);
        if (connect403ForToken) tokensNeedingScope.add(tok);
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            access_token: tok,
            token_type: 'Bearer',
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
        if (
          (rpc.method === 'initialize' && tokensNeedingScope.has(bearer)) ||
          (rpc.method === 'tools/call' && toolMode === 'scope_x')
        ) {
          res
            .writeHead(403, {
              'www-authenticate':
                'Bearer error="insufficient_scope", scope="x"',
            })
            .end();
          return;
        }
        const result =
          rpc.method === 'initialize'
            ? {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'remote', version: '1.0.0' },
              }
            : rpc.method === 'tools/list'
              ? {
                  tools: [
                    {
                      name: 'ping',
                      description: 'ping',
                      inputSchema: { type: 'object', properties: {} },
                    },
                  ],
                }
              : { content: [{ type: 'text', text: 'pong' }] };
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
  cleanupServer(t, srv);

  const home = scratch(t);
  const serverKey = `${base()}/mcp`;
  const portUsed = await redirectPort(home, serverKey);
  const seed = new McpAuthProvider(home, serverKey, portUsed);
  seed.saveClientInformation({
    client_id: 'cli-s1',
    redirect_uris: [seed.redirectUrl],
  });
  seed.saveTokens({ access_token: 'tok-1', token_type: 'Bearer' });

  // Null entry in mcp-auth.json must not throw on load().
  const rawAuth = JSON.parse(readFileSync(mcpAuthPath(home), 'utf8')) as {
    servers: Record<string, unknown>;
  };
  rawAuth.servers.x = null;
  writeFileSync(mcpAuthPath(home), JSON.stringify(rawAuth, null, 2));

  const change = changes();
  const manager = new McpManager(scratch(t), 5000, undefined, {
    home,
    onChange: change.onChange,
    openUrl: async (target) => {
      const parsed = new URL(target);
      authRequests.push(parsed);
      if (callbackMode === 'hold') return;
      const redirect = new URL(parsed.searchParams.get('redirect_uri')!);
      redirect.searchParams.set('state', parsed.searchParams.get('state')!);
      if (callbackMode === 'invalid_scope') {
        redirect.searchParams.set('error', 'invalid_scope');
      } else {
        redirect.searchParams.set('code', `code-${authRequests.length}`);
        redirect.searchParams.set('iss', base());
      }
      await fetch(redirect);
    },
  });
  cleanup(t, () => manager.close());

  const entry = { remote: { type: 'http' as const, url: serverKey } };
  await manager.load(entry);
  assert.equal(manager.isConnected('remote'), true);

  const context = {
    sessionId: 's-1',
    signal: new AbortController().signal,
    approve: async () => 'once' as const,
    log: () => {},
  } as never;

  // 1) 403 insufficient_scope stays only in manager memory (never written to mcp-auth.json);
  //    when AS rejects invalid_scope, memory is cleared so next ordinary 401 sign-in has no "x".
  toolMode = 'scope_x';
  await assert.rejects(() => manager.tools[0]!.run({}, context));
  assert.equal(manager.status[0]!.error, REAUTHORIZATION_REQUIRED);
  assert.equal(
    'required_scope' in (keptFor(home, serverKey) as Record<string, unknown>),
    false,
  );

  // Sibling McpManager sharing the same home loading cleanly must not erase manager's in-memory mark/scope.
  toolMode = 'ok';
  const sibling = new McpManager(scratch(t), 5000, undefined, {
    home,
    openUrl: async () => {},
  });
  cleanup(t, () => sibling.close());
  await sibling.load(entry);
  assert.equal(sibling.isConnected('remote'), true);

  callbackMode = 'invalid_scope';
  await manager.reloadServer('remote', entry);
  await until(() => authRequests.length === 1);
  assert.equal(authRequests[0]!.searchParams.get('scope'), 'x');
  await until(() => manager.status[0]!.error.startsWith('sign-in failed:'));
  assert.match(manager.status[0]!.error, /invalid_scope/);
  assert.equal(manager.isConnected('remote'), true);

  validTokens.clear();
  callbackMode = 'approve';
  await manager.reloadServer('remote', entry);
  await until(() => manager.status[0]!.error === '');
  assert.equal(authRequests.length, 2);
  assert.equal(authRequests[1]!.searchParams.get('scope'), null);
  assert.equal(manager.isConnected('remote'), true);

  // 2) An interactive sign-in completes without scope, then connectAgain gets connect-time 403 scope="x":
  //    the connect-time 403 mark and scope survive signIn's .finally(), and subsequent reload sends "x".
  validTokens.clear();
  connect403ForToken = true;
  callbackMode = 'approve_no_scope';
  await manager.reloadServer('remote', entry);
  await until(() => manager.status[0]!.error === REAUTHORIZATION_REQUIRED);
  assert.equal(authRequests.length, 3);
  connect403ForToken = false;
  tokensNeedingScope.clear();
  callbackMode = 'approve';
  await manager.reloadServer('remote', entry);
  await until(() => manager.status[0]!.error === '');
  assert.equal(authRequests.length, 4);
  assert.equal(authRequests[3]!.searchParams.get('scope'), 'x');

  // 3) Waiting re-authorization sign-in is preserved by reloadServer (no cancel), whereas reauthorizeServer cancels it.
  toolMode = 'scope_x';
  await assert.rejects(() => manager.tools[0]!.run({}, context));
  toolMode = 'ok';
  callbackMode = 'hold';
  await manager.reloadServer('remote', entry);
  await until(() => authRequests.length === 5);
  const firstReauthUrl = manager.status[0]!.authorize;
  assert.ok(firstReauthUrl);
  await manager.reloadServer('remote', entry);
  assert.equal(authRequests.length, 5);
  assert.equal(manager.status[0]!.authorize, firstReauthUrl);

  callbackMode = 'approve';
  await manager.reauthorizeServer('remote', entry, { scope: 'y' });
  await until(() => manager.status[0]!.error === '');
  assert.equal(authRequests.length, 6);
  assert.equal(authRequests[5]!.searchParams.get('scope'), 'y');

  // 4) Restart (fresh McpManager on same home) has empty in-memory scope so reloadServer is a plain reconnect.
  toolMode = 'scope_x';
  await assert.rejects(() => manager.tools[0]!.run({}, context));
  await manager.close();
  toolMode = 'ok';
  const authAfterRestart: URL[] = [];
  const restarted = new McpManager(scratch(t), 5000, undefined, {
    home,
    openUrl: async (target) => {
      authAfterRestart.push(new URL(target));
    },
  });
  cleanup(t, () => restarted.close());
  await restarted.load(entry);
  await restarted.reloadServer('remote', entry);
  assert.equal(authAfterRestart.length, 0);
  assert.equal(restarted.status[0]!.error, '');
  assert.equal(restarted.isConnected('remote'), true);
});

test('C3-S4 Hypothesis 3: abandoned device sign-in that expires overwrites mark with sign-in failed while preserving live MCP connection', async (t) => {
  let port = 0;
  const base = () => `http://127.0.0.1:${port}`;
  const validTokens = new Set(['tok-live']);
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
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            device_code: 'dc-expire',
            user_code: 'EXPD-1234',
            verification_uri: `${base()}/verify`,
            expires_in: 1,
            interval: 1,
          }),
        );
        return;
      }
      if (url.pathname === '/token') {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'expired_token' }));
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
                serverInfo: { name: 'remote', version: '1.0.0' },
              }
            : rpc.method === 'tools/list'
              ? {
                  tools: [
                    {
                      name: 'ping',
                      description: 'ping',
                      inputSchema: { type: 'object', properties: {} },
                    },
                  ],
                }
              : { content: [{ type: 'text', text: 'pong' }] };
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
  cleanupServer(t, srv);

  const home = scratch(t);
  const serverKey = `${base()}/mcp`;
  const portUsed = await redirectPort(home, serverKey);
  const seed = new McpAuthProvider(home, serverKey, portUsed);
  seed.saveClientInformation({
    client_id: 'cli-exp',
    redirect_uris: [seed.redirectUrl],
  });
  seed.saveTokens({ access_token: 'tok-live', token_type: 'Bearer' });

  const manager = new McpManager(scratch(t), 5000, undefined, {
    home,
    openUrl: async () => {},
  });
  cleanup(t, () => manager.close());
  const entry = { remote: { type: 'http' as const, url: serverKey } };
  await manager.load(entry);
  assert.equal(manager.isConnected('remote'), true);

  await manager.reauthorizeServer('remote', entry, { scope: 'x' });
  await until(() =>
    (manager.status[0]?.error ?? '').startsWith('sign-in failed:'),
  );
  assert.match(manager.status[0]!.error, /expired/);
  assert.equal(manager.isConnected('remote'), true);
  assert.equal(manager.tools.length, 1);
  assert.equal(
    'required_scope' in (keptFor(home, serverKey) as Record<string, unknown>),
    false,
  );
});

test('C5-S1: re-authorization mark is bound to the server URL that answered 403, so switching URLs reconnects ordinarily and clears the mark and remembered scope', async (t) => {
  let portA = 0;
  let portB = 0;
  const baseA = () => `http://127.0.0.1:${portA}`;
  const baseB = () => `http://127.0.0.1:${portB}`;
  const validTokens = new Set(['tok-a1']);
  const authRequests: URL[] = [];
  const bRequests: Array<{ method: string; pathname: string }> = [];
  let rejectToolWithScope = false;
  let tokenSeq = 0;

  const srvA = createServer((req, res) => {
    const url = new URL(req.url ?? '/', baseA());
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            issuer: baseA(),
            authorization_endpoint: `${baseA()}/authorize`,
            token_endpoint: `${baseA()}/token`,
            registration_endpoint: `${baseA()}/register`,
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
          }),
        );
        return;
      }
      if (url.pathname === '/authorize') {
        authRequests.push(url);
        const redirect = new URL(url.searchParams.get('redirect_uri')!);
        redirect.searchParams.set('code', `code-${authRequests.length}`);
        redirect.searchParams.set('state', url.searchParams.get('state')!);
        redirect.searchParams.set('iss', baseA());
        res.writeHead(302, { location: redirect.href }).end();
        return;
      }
      if (url.pathname === '/token') {
        const tok = `tok-a-${++tokenSeq}`;
        validTokens.add(tok);
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            access_token: tok,
            token_type: 'Bearer',
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
        if (rpc.method === 'tools/call' && rejectToolWithScope) {
          res
            .writeHead(403, {
              'www-authenticate':
                'Bearer error="insufficient_scope", scope="x"',
            })
            .end();
          return;
        }
        const result =
          rpc.method === 'initialize'
            ? {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'srv-a', version: '1.0.0' },
              }
            : rpc.method === 'tools/list'
              ? {
                  tools: [
                    {
                      name: 'a_ping',
                      description: 'a_ping',
                      inputSchema: { type: 'object', properties: {} },
                    },
                  ],
                }
              : { content: [{ type: 'text', text: 'pong-a' }] };
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

  const srvB = createServer((req, res) => {
    const url = new URL(req.url ?? '/', baseB());
    bRequests.push({ method: req.method ?? 'GET', pathname: url.pathname });
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'POST' && url.pathname === '/mcp') {
        const rpc = JSON.parse(body) as { id?: unknown; method?: string };
        const result =
          rpc.method === 'initialize'
            ? {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'srv-b', version: '1.0.0' },
              }
            : rpc.method === 'tools/list'
              ? {
                  tools: [
                    {
                      name: 'b_ping',
                      description: 'b_ping',
                      inputSchema: { type: 'object', properties: {} },
                    },
                  ],
                }
              : { content: [{ type: 'text', text: 'pong-b' }] };
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

  await Promise.all([
    new Promise<void>((resolve) => srvA.listen(0, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => srvB.listen(0, '127.0.0.1', resolve)),
  ]);
  portA = (srvA.address() as { port: number }).port;
  portB = (srvB.address() as { port: number }).port;
  cleanupServer(t, srvA);
  cleanupServer(t, srvB);

  const home = scratch(t);
  const serverKeyA = `${baseA()}/mcp`;
  const serverKeyB = `${baseB()}/mcp`;
  const portUsed = await redirectPort(home, serverKeyA);
  const seed = new McpAuthProvider(home, serverKeyA, portUsed);
  seed.saveClientInformation({
    client_id: 'cli-a',
    redirect_uris: [seed.redirectUrl],
  });
  seed.saveTokens({ access_token: 'tok-a1', token_type: 'Bearer' });

  const manager = new McpManager(scratch(t), 5000, undefined, {
    home,
    openUrl: async (target) => {
      const parsed = new URL(target);
      const page = await fetch(parsed, { redirect: 'manual' });
      const loc = page.headers.get('location');
      if (loc) await fetch(loc);
    },
  });
  cleanup(t, () => manager.close());

  const context = {
    sessionId: 's-c5',
    signal: new AbortController().signal,
    approve: async () => 'once' as const,
    log: () => {},
  } as never;

  const entryA = { remote: { type: 'http' as const, url: serverKeyA } };
  await manager.load(entryA);
  assert.equal(manager.isConnected('remote'), true);

  // 1) Unchanged URL: after A marks the row REAUTHORIZATION_REQUIRED, reloading A starts scoped sign-in with scope=x.
  rejectToolWithScope = true;
  await assert.rejects(() => manager.tools[0]!.run({}, context));
  assert.equal(manager.status[0]!.error, REAUTHORIZATION_REQUIRED);
  rejectToolWithScope = false;
  await manager.reloadServer('remote', entryA);
  await until(
    () => manager.status[0]!.error === '' && manager.isConnected('remote'),
  );
  assert.equal(authRequests.length, 1);
  assert.equal(authRequests[0]!.searchParams.get('scope'), 'x');

  // 2) Changed URL: after A marks the row REAUTHORIZATION_REQUIRED, switching URL to B reconnects ordinarily without hitting A or sending discovery/register to B.
  rejectToolWithScope = true;
  await assert.rejects(() => manager.tools[0]!.run({}, context));
  assert.equal(manager.status[0]!.error, REAUTHORIZATION_REQUIRED);
  bRequests.length = 0;
  await manager.reloadServer('remote', {
    remote: { type: 'http' as const, url: serverKeyB },
  });
  assert.equal(manager.status[0]!.error, '');
  assert.equal(manager.isConnected('remote'), true);
  assert.equal(
    manager.tools.some((tool) => tool.name === 'mcp__remote__b_ping'),
    true,
  );
  assert.equal(authRequests.length, 1);
  assert.ok(bRequests.length > 0);
  assert.equal(
    bRequests.every((r) => r.method === 'POST' && r.pathname === '/mcp'),
    true,
  );

  // 3) Switching away also cleared A's remembered scope, so switching back to A on 401 does an ordinary sign-in without scope=x.
  validTokens.clear();
  rejectToolWithScope = false;
  await manager.reloadServer('remote', entryA);
  await until(
    () =>
      authRequests.length === 2 &&
      manager.status[0]!.error === '' &&
      manager.isConnected('remote'),
  );
  assert.equal(authRequests[1]!.searchParams.get('scope'), null);
});
