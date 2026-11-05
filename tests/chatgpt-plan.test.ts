import assert from 'node:assert/strict';
import { test } from 'node:test';
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
import type { Message, ModelRequest } from '../src/types.js';
import { footerRow } from '../src/tui/status_rows.js';
import { ModelCatalog } from '../src/model_catalog.js';
import stripAnsi from 'strip-ansi';
import { openai, type Body } from './chatgpt-fixture.js';

function scratch(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'circle-chatgpt-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
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

test('a ChatGPT plan reply carries no price, and the terminal footer shows no cost', async (t) => {
  const gateway = await openai(t);
  const home = scratch(t);
  await signInWithChatGPT(signInOptions(gateway, home));
  const model = planModel(gateway.base, home);
  const reply = await model.complete(
    ask([{ id: 'u', role: 'user', content: 'hi' }]),
  );
  // The same model on the same host has a price as an API connection, none as a plan.
  const catalog = new ModelCatalog(scratch(t), {
    env: { CIRCLE_NO_MODELS_REFRESH: '1' },
  });
  const on = (protocol: string) =>
    catalog.facts('gpt-5', {
      auth: {
        protocol,
        base_url: 'https://api.openai.com/v1',
        model: 'gpt-5',
        api_key_ref: '',
      },
      models: {},
    }).rates;
  assert.ok(on('responses')?.input);
  assert.equal(on('chatgpt'), undefined);
  assert.equal(reply.message.cost?.amount, null);
  assert.equal(reply.message.cost?.currency, '');
  assert.equal(model.modelFacts.rates, undefined);
  const footer = stripAnsi(
    footerRow(
      { usage: reply.usage, costText: '', contextWindow: 1000 },
      '',
      120,
    ),
  );
  assert.doesNotMatch(footer, /\$|N\/A|cost/);
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
  // Signed out: the connection still starts (a runtime must not stop over it), and its
  // first request says how to sign in, without reaching the plan route.
  await signOutOfChatGPT(home, { CIRCLE_CHATGPT_ISSUER: gateway.base });
  const signedOut = planModel(gateway.base, home);
  const asked = gateway.seen.filter(
    (item) => item.path === '/v1/responses',
  ).length;
  await assert.rejects(
    signedOut.complete(ask([{ id: 'u', role: 'user', content: 'hi' }])),
    (error: unknown) =>
      error instanceof ChatGPTSignInError &&
      /not signed in to ChatGPT/.test(error.message),
  );
  assert.equal(
    gateway.seen.filter((item) => item.path === '/v1/responses').length,
    asked,
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
  // No special notice: the plan is a connection like any other (owner's decision).
  assert.ok(!said.some((line) => /ChatGPT plan\b.*use|using your/i.test(line)));
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
  const stored = storedHistory(home);
  assert.match(stored, /hello/);
  assert.doesNotMatch(stored, /access-1|refresh-1/);
});

/** Every row of the checkpoint database, as text, read with a connection closed before
 * returning: Windows cannot remove a folder holding an open database. */
function storedHistory(home: string): string {
  const db = new DatabaseSync(join(home, 'circle.sqlite'), { readOnly: true });
  try {
    return (
      db.prepare('SELECT * FROM sqlite_master').all() as {
        name: string;
        type: string;
      }[]
    )
      .filter((row) => row.type === 'table')
      .flatMap((row) => db.prepare(`SELECT * FROM "${row.name}"`).all())
      .map((row) => JSON.stringify(row))
      .join('\n');
  } finally {
    db.close();
  }
}
