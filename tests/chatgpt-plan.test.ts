import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createHash,
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import {
  activeChatGPTAccount,
  agentHostId,
  chatgptAccessToken,
  chatgptAccountsPath,
  ChatGPTPlanDisabled,
  ChatGPTSignInError,
  signInWithChatGPT,
  signOutOfChatGPT,
  type SignInOptions,
} from '../src/chatgpt_plan.js';
import { GatewayModel } from '../src/model.js';
import { DEFAULT_CREDENTIAL_FILES } from '../src/file_patterns.js';
import { ApprovalPolicy, ApprovalStore } from '../src/approvals.js';
import { resolveEndpoint } from '../src/probe.js';
import {
  defaultSettings,
  loadCredentials,
  loadSettings,
  saveCredentials,
  saveSettings,
  trustFolder,
} from '../src/settings.js';
import { SetupCard, SetupFlow } from '../src/tui/setup_flow.js';
import { runLineInit, type LinePrompter } from '../src/line_setup.js';
import { headerRows } from '../src/tui/status_rows.js';
import type { Message, ModelRequest } from '../src/types.js';

function scratch(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'circle-chatgpt-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(key: KeyObject, claims: Record<string, unknown>, kid = 'k1') {
  const head = b64({ alg: 'RS256', kid, typ: 'JWT' });
  const body = b64(claims);
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(key).toString('base64url')}`;
}
type Body = Record<string, unknown>;
interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  form: URLSearchParams;
  headers: IncomingMessage['headers'];
  json?: Body;
}
/**
 * OpenAI's Sign in with ChatGPT endpoints and the plan's Responses route, as documented:
 * discovery, keys, dynamic registration, code and rotating refresh grants, revocation,
 * the account's model list and a Responses stream.
 */
async function openai(
  t: { after(fn: () => void | Promise<void>): void },
  options: {
    scope?: string;
    deny?: boolean;
    issuedClient?: string;
    respond?: (seen: Seen, res: ServerResponse) => boolean;
    nonce?: (nonce: string) => string;
  } = {},
) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: 'k1',
    alg: 'RS256',
  };
  const seen: Seen[] = [];
  const codes = new Map<
    string,
    { challenge: string; nonce: string; client: string; redirect: string }
  >();
  const state = {
    refresh: new Set<string>(),
    issued: 0,
    revoked: [] as string[],
    access: new Set<string>(),
  };
  let base = '';
  const server = createServer(async (req, res) => {
    let raw = Buffer.alloc(0);
    for await (const chunk of req) raw = Buffer.concat([raw, chunk]);
    const url = new URL(req.url ?? '/', base);
    const text =
      req.headers['content-encoding'] === 'zstd'
        ? zstdDecompressSync(raw).toString('utf8')
        : raw.toString('utf8');
    const entry: Seen = {
      method: req.method ?? '',
      path: url.pathname,
      query: url.searchParams,
      form: new URLSearchParams(
        req.headers['content-type']?.includes('form') ? text : '',
      ),
      headers: req.headers,
      ...(req.headers['content-type']?.includes('json') && text
        ? { json: JSON.parse(text) as Body }
        : {}),
    };
    seen.push(entry);
    if (options.respond?.(entry, res)) return;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const tokens = (client: string, nonce?: string) => {
      const n = ++state.issued;
      const access = `access-${n}`;
      const refresh = `refresh-${n}`;
      state.access.add(access);
      state.refresh.add(refresh);
      return {
        access_token: access,
        refresh_token: refresh,
        token_type: 'Bearer',
        expires_in: 3600,
        scope:
          options.scope ??
          'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        ...(nonce !== undefined
          ? {
              id_token: jwt(privateKey, {
                iss: base,
                aud: client,
                sub: 'user-1',
                email: 'person@example.com',
                nonce: options.nonce?.(nonce) ?? nonce,
                exp: Math.floor(Date.now() / 1000) + 3600,
              }),
            }
          : {}),
      };
    };
    if (url.pathname === '/.well-known/openid-configuration')
      return json(200, {
        issuer: base,
        jwks_uri: `${base}/jwks`,
        revocation_endpoint: `${base}/revoke`,
      });
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/api/accounts/authorize') {
      const q = url.searchParams;
      const redirect = new URL(q.get('redirect_uri')!);
      const fresh = q.get('client_id') === 'dynamic_agent_client';
      const client = fresh
        ? (options.issuedClient ?? 'oaiapp_issued')
        : q.get('client_id')!;
      if (options.deny) {
        redirect.searchParams.set('error', 'access_denied');
      } else {
        const code = `code-${seen.length}`;
        codes.set(code, {
          challenge: q.get('code_challenge')!,
          nonce: q.get('nonce')!,
          client,
          redirect: q.get('redirect_uri')!,
        });
        redirect.searchParams.set('code', code);
        if (fresh) redirect.searchParams.set('client_id', client);
      }
      redirect.searchParams.set('state', q.get('state')!);
      res.writeHead(302, { Location: redirect.href });
      return res.end();
    }
    if (url.pathname === '/api/accounts/oauth/token') {
      const form = entry.form;
      if (form.get('resource') !== 'https://api.openai.com/v1')
        return json(400, { error: 'invalid_target' });
      if (form.get('grant_type') === 'authorization_code') {
        const grant = codes.get(form.get('code')!);
        codes.delete(form.get('code')!);
        const challenge = createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url');
        if (
          !grant ||
          grant.challenge !== challenge ||
          grant.client !== form.get('client_id') ||
          grant.redirect !== form.get('redirect_uri')
        )
          return json(400, { error: 'invalid_grant' });
        return json(200, tokens(grant.client, grant.nonce));
      }
      if (form.get('grant_type') === 'refresh_token') {
        const presented = form.get('refresh_token')!;
        if (!state.refresh.has(presented))
          return json(400, { error: 'refresh_token_reused' });
        state.refresh.delete(presented);
        return json(200, tokens(form.get('client_id')!));
      }
    }
    if (url.pathname === '/revoke') {
      state.revoked.push(entry.form.get('token')!);
      state.refresh.delete(entry.form.get('token')!);
      res.writeHead(200);
      return res.end();
    }
    if (url.pathname === '/v1/models')
      return json(200, {
        models: [
          {
            slug: 'gpt-6.1-sol',
            display_name: 'Sol',
            visibility: 'list',
            supported_in_api: true,
          },
          {
            slug: 'internal',
            display_name: 'Hidden',
            visibility: 'hide',
            supported_in_api: true,
          },
        ],
      });
    if (url.pathname === '/v1/responses') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of [
        {
          type: 'response.output_text.delta',
          output_index: 0,
          item_id: 'm',
          delta: 'hello',
        },
        {
          type: 'response.completed',
          response: {
            id: 'r',
            model: 'gpt-6.1-sol',
            status: 'completed',
            usage: { input_tokens: 3, output_tokens: 1 },
          },
        },
      ])
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      return res.end();
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  /** The system browser: follows the authorization to the loopback callback. */
  const browser = async (url: string) => {
    const response = await fetch(url, { redirect: 'manual' });
    const location = response.headers.get('location');
    if (location) await fetch(location);
  };
  return { base, seen, state, browser, privateKey };
}
function signInOptions(
  gateway: { base: string; browser: (url: string) => Promise<void> },
  home: string,
  extra: Partial<SignInOptions> = {},
): SignInOptions {
  return {
    home,
    open: gateway.browser,
    env: {
      CIRCLE_CHATGPT_ISSUER: gateway.base,
      CIRCLE_AGENT_HOST_FILE: join(home, 'host-id'),
    },
    ...extra,
  };
}

test('a first sign-in registers a client for Circle, checks the ID token and the plan permission, and saves the account privately', async (t) => {
  const gateway = await openai(t);
  const home = scratch(t);
  const account = await signInWithChatGPT(signInOptions(gateway, home));
  const authorize = gateway.seen.find(
    (item) => item.path === '/api/accounts/authorize',
  )!;
  const q = authorize.query;
  assert.equal(q.get('client_id'), 'dynamic_agent_client');
  assert.equal(q.get('agent_name_hint'), 'Circle');
  assert.match(q.get('ext_agent_host_id')!, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(
    q.get('scope'),
    'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
  );
  assert.equal(q.get('resource'), 'https://api.openai.com/v1');
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.match(
    q.get('redirect_uri')!,
    /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
  );
  assert.ok(q.get('state') && q.get('nonce'));
  const exchange = gateway.seen.find(
    (item) => item.form.get('grant_type') === 'authorization_code',
  )!;
  assert.equal(exchange.form.get('client_id'), 'oaiapp_issued');
  assert.equal(exchange.form.get('redirect_uri'), q.get('redirect_uri'));
  assert.equal(account.client_id, 'oaiapp_issued');
  assert.equal(account.subject, 'user-1');
  assert.equal(account.email, 'person@example.com');
  assert.equal(account.ext_agent_host_id, q.get('ext_agent_host_id'));
  const path = chatgptAccountsPath(home);
  if (process.platform !== 'win32')
    assert.equal(statSync(path).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.accounts[0].refresh_token, 'refresh-1');
  assert.equal(activeChatGPTAccount(home)?.client_id, 'oaiapp_issued');
  // The model's tools may not read it by name, as they may not read credentials.json.
  assert.ok(DEFAULT_CREDENTIAL_FILES.includes('chatgpt-accounts.json'));
  const policy = new ApprovalPolicy(new ApprovalStore(scratch(t)), home);
  assert.equal(
    policy.review('execute', { command: 'cat ~/.circle/chatgpt-accounts.json' })
      .verdict,
    'DENY',
  );
  // The host ID stays the same for this machine.
  assert.equal(
    agentHostId(home, { CIRCLE_AGENT_HOST_FILE: join(home, 'host-id') }),
    account.ext_agent_host_id,
  );
});

test('signing in again reuses the issued client with hints, and a callback naming another client is refused', async (t) => {
  const gateway = await openai(t);
  const home = scratch(t);
  await signInWithChatGPT(signInOptions(gateway, home));
  await signInWithChatGPT(signInOptions(gateway, home));
  const second = gateway.seen.filter(
    (item) => item.path === '/api/accounts/authorize',
  )[1]!.query;
  assert.equal(second.get('client_id'), 'oaiapp_issued');
  assert.equal(second.get('agent_name_hint'), null);
  assert.ok(second.get('id_token_hint'));
  assert.equal(second.get('login_hint'), 'person@example.com');
  // A returning sign-in whose callback carries a different client.
  const rogue = await openai(t, {
    respond: (seen, res) => {
      if (seen.path !== '/api/accounts/authorize') return false;
      const redirect = new URL(seen.query.get('redirect_uri')!);
      redirect.searchParams.set('code', 'x');
      redirect.searchParams.set('client_id', 'oaiapp_other');
      redirect.searchParams.set('state', seen.query.get('state')!);
      res.writeHead(302, { Location: redirect.href });
      res.end();
      return true;
    },
  });
  await assert.rejects(
    signInWithChatGPT({
      ...signInOptions(rogue, home),
      env: {
        CIRCLE_CHATGPT_ISSUER: gateway.base,
        CIRCLE_AGENT_HOST_FILE: join(home, 'host-id'),
      },
      open: async (url) => rogue.browser(url.replace(gateway.base, rogue.base)),
    }),
    /different client/,
  );
});

test('a declined plan permission, or a grant without it, never reaches inference', async (t) => {
  const denied = await openai(t, { deny: true });
  const home = scratch(t);
  await assert.rejects(
    signInWithChatGPT(signInOptions(denied, home)),
    ChatGPTPlanDisabled,
  );
  assert.ok(!denied.seen.some((item) => item.path.endsWith('/oauth/token')));
  const narrow = await openai(t, {
    scope: 'openid profile email offline_access',
  });
  const other = scratch(t);
  await assert.rejects(
    signInWithChatGPT(signInOptions(narrow, other)),
    ChatGPTPlanDisabled,
  );
  // The registration stays for a later sign-in; its tokens do not.
  const kept = activeChatGPTAccount(other)!;
  assert.equal(kept.client_id, 'oaiapp_issued');
  assert.equal(kept.refresh_token, undefined);
  await assert.rejects(chatgptAccessToken(other), ChatGPTSignInError);
});

test('an ID token with the wrong nonce is refused', async (t) => {
  const gateway = await openai(t, { nonce: () => 'someone-else' });
  await assert.rejects(
    signInWithChatGPT(signInOptions(gateway, scratch(t))),
    /invalid ID token \(nonce\)/,
  );
});

test('the address the browser ended on can be pasted when it cannot reach this machine', async (t) => {
  const gateway = await openai(t);
  const home = scratch(t);
  let pasteIt: (text: string) => void = () => {};
  const pasted = new Promise<string>((resolve) => (pasteIt = resolve));
  const account = await signInWithChatGPT(
    signInOptions(gateway, home, {
      pasted,
      // The browser is elsewhere: it gets the redirect but cannot deliver it.
      open: async (url) => {
        const response = await fetch(url, { redirect: 'manual' });
        pasteIt(response.headers.get('location')!);
      },
    }),
  );
  assert.equal(account.client_id, 'oaiapp_issued');
});

test('refreshing rotates the refresh token once even when two requests need it at the same time', async (t) => {
  const gateway = await openai(t);
  const home = scratch(t);
  await signInWithChatGPT(signInOptions(gateway, home));
  const env = { CIRCLE_CHATGPT_ISSUER: gateway.base };
  const later = () => Date.now() + 3600_000; // the hour has passed
  const [first, second] = await Promise.all([
    chatgptAccessToken(home, env, later),
    chatgptAccessToken(home, env, later),
  ]);
  assert.equal(first, 'access-2');
  assert.equal(second, 'access-2');
  const refreshes = gateway.seen.filter(
    (item) => item.form.get('grant_type') === 'refresh_token',
  );
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0]!.form.get('client_id'), 'oaiapp_issued');
  assert.equal(refreshes[0]!.form.get('refresh_token'), 'refresh-1');
  assert.equal(refreshes[0]!.form.get('scope'), null);
  assert.equal(activeChatGPTAccount(home)?.refresh_token, 'refresh-2');
  // Fresh now: no request at all.
  assert.equal(await chatgptAccessToken(home, env), 'access-2');
  assert.equal(
    gateway.seen.filter(
      (item) => item.form.get('grant_type') === 'refresh_token',
    ).length,
    1,
  );
});

test('an unusable refresh token ends the sign-in and keeps the registration; a network failure keeps a token that still works', async (t) => {
  const gateway = await openai(t);
  const home = scratch(t);
  await signInWithChatGPT(signInOptions(gateway, home));
  gateway.state.refresh.clear(); // refresh-1 has been used elsewhere
  await assert.rejects(
    chatgptAccessToken(
      home,
      { CIRCLE_CHATGPT_ISSUER: gateway.base },
      () => Date.now() + 3600_000,
    ),
    /has ended \(refresh_token_reused\)/,
  );
  const kept = activeChatGPTAccount(home)!;
  assert.equal(kept.client_id, 'oaiapp_issued');
  assert.equal(kept.refresh_token, undefined);
  // Another home, signed in, whose token is near its end while the issuer is unreachable.
  const other = scratch(t);
  await signInWithChatGPT(signInOptions(gateway, other));
  const token = await chatgptAccessToken(
    other,
    { CIRCLE_CHATGPT_ISSUER: 'http://127.0.0.1:1' },
    () => Date.now() + 3600_000 - 60_000,
  );
  assert.equal(token, activeChatGPTAccount(other)!.access_token);
});

test('signing out revokes the renewable session, clears the tokens and keeps the client for next time', async (t) => {
  const gateway = await openai(t);
  const home = scratch(t);
  await signInWithChatGPT(signInOptions(gateway, home));
  const result = await signOutOfChatGPT(home, {
    CIRCLE_CHATGPT_ISSUER: gateway.base,
  });
  assert.deepEqual(result, { revoked: true });
  const revoke = gateway.seen.find((item) => item.path === '/revoke')!;
  assert.equal(revoke.form.get('token'), 'refresh-1');
  assert.equal(revoke.form.get('token_type_hint'), 'refresh_token');
  assert.equal(revoke.form.get('client_id'), 'oaiapp_issued');
  assert.equal(activeChatGPTAccount(home), undefined);
  const saved = JSON.parse(readFileSync(chatgptAccountsPath(home), 'utf8'));
  assert.equal(saved.accounts[0].client_id, 'oaiapp_issued');
  assert.equal(saved.accounts[0].refresh_token, undefined);
  assert.equal(saved.accounts[0].access_token, undefined);
});

function planModel(base: string, home: string) {
  const settings = defaultSettings();
  settings.auth = {
    ...settings.auth,
    protocol: 'chatgpt',
    base_url: base + '/v1',
    model: 'gpt-6.1-sol',
  };
  return new GatewayModel(settings, home, undefined, { wait: async () => {} });
}
const ask = (
  messages: Message[],
  extra: Partial<ModelRequest> = {},
): ModelRequest => ({
  system: 'you are circle',
  messages,
  tools: [],
  signal: new AbortController().signal,
  token: () => {},
  ...extra,
});

test('a plan request is compressed, carries the access token, groups tools in a namespace and sends no output cap', async (t) => {
  let turn = 0;
  const gateway = await openai(t, {
    respond: (seen, res) => {
      if (seen.path !== '/v1/responses' || turn++ > 0) return false;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of [
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc',
            call_id: 'call_1',
            namespace: 'circle',
            name: 'read_file',
            arguments: '{"file_path":"a"}',
          },
        },
        {
          type: 'response.completed',
          response: {
            id: 'r',
            status: 'completed',
            usage: { input_tokens: 2, output_tokens: 1 },
          },
        },
      ])
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
      return true;
    },
  });
  const home = scratch(t);
  await signInWithChatGPT(signInOptions(gateway, home));
  const model = planModel(gateway.base, home);
  const tool = {
    name: 'read_file',
    description: 'read a file',
    parameters: { type: 'object', properties: {} },
  } as unknown as ModelRequest['tools'][number];
  const user: Message = { id: 'u', role: 'user', content: 'read a' };
  const first = await model.complete(
    ask([user], { tools: [tool], maxTokens: 500 }),
  );
  assert.deepEqual(first.message.tool_calls, [
    { id: 'call_1', name: 'read_file', args: { file_path: 'a' } },
  ]);
  const requests = gateway.seen.filter((item) => item.path === '/v1/responses');
  assert.equal(requests[0]!.headers['content-encoding'], 'zstd');
  assert.equal(requests[0]!.headers.authorization, 'Bearer access-1');
  const body = requests[0]!.json!;
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.ok(!('max_output_tokens' in body));
  assert.deepEqual(body.tools, [
    {
      type: 'namespace',
      name: 'circle',
      description: "Circle's tools for this workspace.",
      tools: [
        {
          type: 'function',
          name: 'read_file',
          description: 'read a file',
          parameters: { type: 'object', properties: {} },
          strict: false,
        },
      ],
    },
  ]);
  await model.complete(
    ask(
      [
        user,
        first.message,
        { id: 't', role: 'tool', tool_call_id: 'call_1', content: 'text' },
      ],
      { tools: [tool] },
    ),
  );
  const replay =
    (requests.length,
    gateway.seen.filter((item) => item.path === '/v1/responses')[1]!.json!
      .input as Body[]);
  assert.deepEqual(
    replay.find((item) => item.type === 'function_call'),
    {
      type: 'function_call',
      call_id: 'call_1',
      namespace: 'circle',
      name: 'read_file',
      arguments: '{"file_path":"a"}',
    },
  );
});

test("history's reasoning scope follows the account, not the token that rotates", async (t) => {
  const gateway = await openai(t);
  const home = scratch(t);
  await signInWithChatGPT(signInOptions(gateway, home));
  const before = (
    await planModel(gateway.base, home).complete(
      ask([{ id: 'u', role: 'user', content: 'hi' }]),
    )
  ).message.thinking_scope;
  await chatgptAccessToken(
    home,
    { CIRCLE_CHATGPT_ISSUER: gateway.base },
    () => Date.now() + 3600_000,
  );
  const after = (
    await planModel(gateway.base, home).complete(
      ask([{ id: 'u', role: 'user', content: 'hi' }]),
    )
  ).message.thinking_scope;
  assert.ok(before);
  assert.equal(before, after);
  // Signed out: the model cannot start, and says how to sign in.
  await signOutOfChatGPT(home, { CIRCLE_CHATGPT_ISSUER: gateway.base });
  assert.throws(
    () => planModel(gateway.base, home),
    /not signed in to ChatGPT/,
  );
});

test('plan errors that a repeat cannot fix stop at once with what to do; temporary ones are retried', async (t) => {
  const plan: string[] = [];
  const gateway = await openai(t, {
    respond: (seen, res) => {
      if (seen.path !== '/v1/responses') return false;
      const next = plan.shift();
      if (next === 'limit') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'subscription_sharing_usage_limit_exceeded',
              message: 'limit',
            },
          }),
        );
        return true;
      }
      if (next === 'failed-limit') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const event = {
          type: 'response.failed',
          response: {
            id: 'r',
            status: 'failed',
            error: {
              code: 'subscription_sharing_usage_limit_exceeded',
              message: 'limit',
            },
          },
        };
        res.end(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        return true;
      }
      if (next === 'unavailable') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'subscription_sharing_usage_unavailable',
              message: 'later',
            },
          }),
        );
        return true;
      }
      if (next === 'admission') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'direct permission missing' }));
        return true;
      }
      return false;
    },
  });
  const home = scratch(t);
  await signInWithChatGPT(signInOptions(gateway, home));
  const count = () =>
    gateway.seen.filter((item) => item.path === '/v1/responses').length;
  const user: Message = { id: 'u', role: 'user', content: 'hi' };
  plan.push('limit');
  await assert.rejects(
    planModel(gateway.base, home).complete(ask([user])),
    /Usage limit reached .*Manage usage: https:\/\/chatgpt\.com\/settings\/usage/,
  );
  assert.equal(count(), 1);
  plan.push('failed-limit');
  await assert.rejects(
    planModel(gateway.base, home).complete(ask([user])),
    /Usage limit reached/,
  );
  assert.equal(count(), 2);
  plan.push('admission');
  await assert.rejects(
    planModel(gateway.base, home).complete(ask([user])),
    /did not accept this sign-in for plan use \(direct permission missing\)/,
  );
  assert.equal(count(), 3);
  plan.push('unavailable');
  const recovered = await planModel(gateway.base, home).complete(ask([user]));
  assert.equal(recovered.message.content, 'hello');
  assert.equal(count(), 5);
});

test('an ended sign-in says so instead of an SDK key failure', async (t) => {
  const gateway = await openai(t);
  const home = scratch(t);
  await signInWithChatGPT(signInOptions(gateway, home));
  const model = planModel(gateway.base, home);
  gateway.state.refresh.clear();
  // The token is near its end; the refresh finds the sign-in revoked.
  const saved = JSON.parse(readFileSync(chatgptAccountsPath(home), 'utf8'));
  saved.accounts[0].expires_at = Date.now();
  const { writeFileSync } = await import('node:fs');
  writeFileSync(chatgptAccountsPath(home), JSON.stringify(saved));
  const previous = process.env.CIRCLE_CHATGPT_ISSUER;
  process.env.CIRCLE_CHATGPT_ISSUER = gateway.base;
  t.after(() => {
    if (previous === undefined) delete process.env.CIRCLE_CHATGPT_ISSUER;
    else process.env.CIRCLE_CHATGPT_ISSUER = previous;
  });
  await assert.rejects(
    model.complete(ask([{ id: 'u', role: 'user', content: 'hi' }])),
    (error: unknown) =>
      error instanceof ChatGPTSignInError &&
      /\/login signs in again/.test(error.message),
  );
});

test("the account's model list keeps the models meant for a picker", async (t) => {
  const gateway = await openai(t);
  const found = await resolveEndpoint(gateway.base + '/v1', 'access-x', {
    protocol: 'chatgpt',
  });
  assert.equal(found.protocol, 'chatgpt');
  assert.deepEqual(found.models, ['gpt-6.1-sol']);
  assert.equal(gateway.seen.at(-1)!.headers.authorization, 'Bearer access-x');
});

test('setup signs in with ChatGPT, lists the account models and saves no key', async (t) => {
  const gateway = await openai(t);
  const home = scratch(t);
  saveCredentials({ api_key: 'earlier-key' }, home);
  const sign = (options: SignInOptions = {}) =>
    signInWithChatGPT({
      ...options,
      env: {
        CIRCLE_CHATGPT_ISSUER: gateway.base,
        CIRCLE_AGENT_HOST_FILE: join(home, 'host-id'),
      },
    });
  const flow = new SetupFlow(home, resolveEndpoint, sign, gateway.browser);
  const card = new SetupCard(flow);
  flow.chooseProvider('chatgpt');
  assert.equal(flow.step, 'signin');
  assert.equal(card.state().title, 'Continue with ChatGPT');
  flow.baseUrl = gateway.base + '/v1';
  let shownUrl = '';
  await flow.runSignIn(
    () =>
      (shownUrl =
        card
          .state()
          .lines?.map((line) => line.text)
          .join('\n') ?? ''),
  );
  assert.match(
    shownUrl,
    /\/api\/accounts\/authorize\?client_id=dynamic_agent_client/,
  );
  assert.equal(flow.step, 'model');
  assert.deepEqual(flow.models, ['gpt-6.1-sol']);
  flow.use('gpt-6.1-sol');
  assert.equal(flow.auth().protocol, 'chatgpt');
  assert.equal(flow.savesKey, false);
  // Line setup: the same sign-in, saved without touching the saved key.
  const lineHome = scratch(t);
  saveCredentials({ api_key: 'earlier-key' }, lineHome);
  const said: string[] = [];
  const answers = [String(2), '1']; // the ChatGPT plan provider, then the first model
  const io: LinePrompter = {
    ask: async () => answers.shift(),
    say: (text) => said.push(text),
    close: () => {},
  };
  const settings = await runLineInit(lineHome, io, {
    signIn: (options) =>
      signInWithChatGPT({
        ...options,
        env: {
          CIRCLE_CHATGPT_ISSUER: gateway.base,
          CIRCLE_AGENT_HOST_FILE: join(lineHome, 'host-id'),
        },
      }),
    open: gateway.browser,
    baseUrl: gateway.base + '/v1',
  });
  assert.ok(settings, said.join('\n'));
  assert.deepEqual(
    {
      protocol: settings.auth.protocol,
      model: settings.auth.model,
      base: settings.auth.base_url,
    },
    { protocol: 'chatgpt', model: 'gpt-6.1-sol', base: gateway.base + '/v1' },
  );
  assert.equal(loadSettings(lineHome).auth.protocol, 'chatgpt');
  assert.equal(loadCredentials(lineHome).api_key, 'earlier-key');
  assert.ok(
    said.some((line) => line.startsWith("You're using your ChatGPT plan")),
  );
  // Shown once per account.
  assert.ok(
    JSON.parse(readFileSync(chatgptAccountsPath(lineHome), 'utf8')).accounts[0]
      .welcomed,
  );
});

test('the header says when the ChatGPT plan is in use', () => {
  const rows = headerRows(
    {
      version: '1.0.0',
      model: 'gpt-6.1-sol',
      plan: true,
      workspace: '/tmp/w',
      connected: true,
    },
    120,
  );
  assert.match(rows[0]!, /gpt-6\.1-sol · Using ChatGPT plan/);
});

test('CLI runs a turn on the ChatGPT plan and stores no token in history', async (t) => {
  const gateway = await openai(t);
  const home = scratch(t);
  const workspace = scratch(t);
  await signInWithChatGPT(signInOptions(gateway, home));
  let settings = defaultSettings();
  settings.initialized = true;
  settings.auth = {
    ...settings.auth,
    protocol: 'chatgpt',
    base_url: gateway.base + '/v1',
    model: 'gpt-6.1-sol',
  };
  settings = trustFolder(settings, workspace);
  saveSettings(settings, home);
  const result = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', '-p', 'hi', workspace],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CIRCLE_HOME: home,
          CIRCLE_NO_MODELS_REFRESH: '1',
          CIRCLE_CHATGPT_ISSUER: gateway.base,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'hello\n');
  const request = gateway.seen.find((item) => item.path === '/v1/responses')!;
  assert.equal(request.headers.authorization, 'Bearer access-1');
  assert.equal(request.headers['content-encoding'], 'zstd');
  assert.ok(
    !existsSync(join(home, 'credentials.json')) ||
      !loadCredentials(home).api_key,
  );
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
  assert.match(stored, /hello/);
  assert.doesNotMatch(stored, /access-1|refresh-1/);
});
