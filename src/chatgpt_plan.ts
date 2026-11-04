// Sign in with ChatGPT plan usage for an open-source, locally hosted app, as OpenAI documents
// it: https://developers.openai.com/siwc/token-sharing-open-source. Circle registers a
// user-owned client once per ChatGPT account, keeps the issued client ID, and spends the
// user's plan through the public Responses API with the OAuth access token.
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { circleHome, ensureHome } from './paths.js';
import {
  isRecord,
  loadCredentials,
  withPrivateJsonLock,
  writePrivateJson,
} from './settings.js';

export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
export const MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage';
const PRODUCTION_ISSUER = 'https://auth.openai.com';
const REGISTRATION_CLIENT = 'dynamic_agent_client';
const AGENT_NAME = 'Circle';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const ACCOUNTS_FILE = 'chatgpt-accounts.json';
// Refresh this long before the hour-long access token ends.
const REFRESH_MARGIN_MS = 5 * 60_000;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const TERMINAL_REFRESH_CODES = [
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
];

/** The authorization server. Only checks point it elsewhere, at a local gateway. */
export function chatgptIssuer(env = process.env): string {
  return (env.CIRCLE_CHATGPT_ISSUER || PRODUCTION_ISSUER).replace(/\/+$/, '');
}

/** One saved ChatGPT account registration: its issued client and its tokens. */
export interface ChatGPTAccount {
  email: string;
  issuer: string;
  subject: string;
  client_id: string;
  ext_agent_host_id: string;
  /** Kept as `id_token_hint` for the next sign-in to this account. */
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  /** Milliseconds since the epoch. */
  expires_at?: number;
  earliest_refresh_at?: number;
  scopes: string[];
  saved_at: string;
}
interface AccountStore {
  version: 1;
  /** `subject client_id` of the account in use. */
  active?: string;
  accounts: ChatGPTAccount[];
}
const accountKey = (account: Pick<ChatGPTAccount, 'subject' | 'client_id'>) =>
  `${account.subject} ${account.client_id}`;
export const chatgptAccountsPath = (home = circleHome()) =>
  join(home, ACCOUNTS_FILE);

function readStore(home: string): AccountStore {
  const path = chatgptAccountsPath(home);
  if (!existsSync(path)) return { version: 1, accounts: [] };
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(raw) || !Array.isArray(raw.accounts))
    throw new Error(`${ACCOUNTS_FILE} is not a ChatGPT account list`);
  return raw as unknown as AccountStore;
}
function changeStore<T>(home: string, change: (store: AccountStore) => T): T {
  const path = chatgptAccountsPath(ensureHome(home));
  return withPrivateJsonLock(path, () => {
    const store = readStore(home);
    const result = change(store);
    writePrivateJson(path, store);
    return result;
  });
}
/** The account in use, if one is signed in. */
export function activeChatGPTAccount(
  home = circleHome(),
): ChatGPTAccount | undefined {
  const store = readStore(home);
  return store.accounts.find((account) => accountKey(account) === store.active);
}
/** What saved history may name the account by: opaque, and never a credential. */
export function chatgptIdentity(home = circleHome()): string {
  const account = activeChatGPTAccount(home);
  if (!account?.refresh_token)
    throw new ChatGPTSignInError(
      'not signed in to ChatGPT · /login or `circle --init` signs in again',
    );
  return `chatgpt ${account.issuer} ${accountKey(account)}`;
}

export class ChatGPTSignInError extends Error {}
/** Consent was declined, or the grant does not include ChatGPT plan use. */
export class ChatGPTPlanDisabled extends ChatGPTSignInError {}

/**
 * This machine's agent host ID, shared by the terminal and the desktop app (one host per
 * machine). Opaque, stable, never a credential.
 */
export function agentHostId(userHome = homedir(), env = process.env): string {
  const path =
    env.CIRCLE_AGENT_HOST_FILE || join(userHome, '.circle', 'agent-host-id');
  mkdirSync(dirname(path), { recursive: true });
  return withPrivateJsonLock(path, () => {
    if (existsSync(path)) {
      const saved = readFileSync(path, 'utf8').trim();
      if (/^urn:uuid:[0-9a-f-]{36}$/.test(saved)) return saved;
    }
    const id = `urn:uuid:${randomUUID()}`;
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, id + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
    return id;
  });
}

interface Discovery {
  jwks_uri: string;
  revocation_endpoint?: string;
}
async function discovery(issuer: string): Promise<Discovery> {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new ChatGPTSignInError(
      `ChatGPT sign-in configuration failed (${response.status})`,
    );
  const body = (await response.json()) as Discovery;
  if (typeof body.jwks_uri !== 'string')
    throw new ChatGPTSignInError('ChatGPT sign-in configuration has no keys');
  return body;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  earliest_refresh_at?: number;
}
class TokenEndpointError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
async function tokenRequest(
  issuer: string,
  form: Record<string, string>,
): Promise<TokenResponse> {
  const response = await fetch(`${issuer}/api/accounts/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* Not JSON: the status says what happened. */
  }
  if (!response.ok) {
    const error = isRecord(body.error) ? body.error : body;
    const code = String(
      (isRecord(error) && (error.code ?? error.error)) ?? body.error ?? '',
    );
    throw new TokenEndpointError(
      response.status,
      code,
      `ChatGPT token request failed (${response.status}${code ? ` ${code}` : ''})`,
    );
  }
  if (typeof body.access_token !== 'string')
    throw new ChatGPTSignInError('ChatGPT returned no access token');
  return body as unknown as TokenResponse;
}

const base64url = (bytes: Buffer) => bytes.toString('base64url');
function decodePart(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(
    Buffer.from(part, 'base64url').toString('utf8'),
  );
  if (!isRecord(value)) throw new Error('not a JSON object');
  return value;
}
/** Check an ID token's RS256 signature against the issuer's keys, then its claims. */
export async function verifyIdToken(
  token: string,
  expected: {
    issuer: string;
    clientId: string;
    nonce: string;
    jwksUri: string;
  },
  now = Date.now(),
): Promise<Record<string, unknown>> {
  const fail = (why: string) =>
    new ChatGPTSignInError(`ChatGPT returned an invalid ID token (${why})`);
  const parts = token.split('.');
  if (parts.length !== 3) throw fail('format');
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodePart(parts[0]!);
    payload = decodePart(parts[1]!);
  } catch {
    throw fail('format');
  }
  if (header.alg !== 'RS256') throw fail('algorithm');
  const response = await fetch(expected.jwksUri, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw fail(`keys ${response.status}`);
  const keys = ((await response.json()) as { keys?: unknown[] }).keys ?? [];
  const jwk = keys.find(
    (key) => isRecord(key) && key.kid === header.kid && key.kty === 'RSA',
  );
  if (!jwk) throw fail('unknown key');
  const valid = verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key: jwk as never, format: 'jwk' }),
    Buffer.from(parts[2]!, 'base64url'),
  );
  if (!valid) throw fail('signature');
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== expected.issuer) throw fail('issuer');
  if (!audience.includes(expected.clientId)) throw fail('audience');
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now)
    throw fail('expired');
  if (payload.nonce !== expected.nonce) throw fail('nonce');
  if (typeof payload.sub !== 'string' || !payload.sub.trim())
    throw fail('subject');
  return payload;
}

/** What a sign-in shows while it waits: the address to open, and how to finish by hand. */
export interface SignInProgress {
  url: string;
  /** The loopback address the browser returns to. */
  redirect: string;
}
export interface SignInOptions {
  home?: string;
  userHome?: string;
  /** Opens the system browser; a failure leaves the URL for the person to open. */
  open?: (url: string) => Promise<void>;
  progress?: (state: SignInProgress) => void;
  /**
   * The address the browser ended on, pasted by the person when it could not reach this
   * machine (a remote shell). Raced with the loopback callback.
   */
  pasted?: Promise<string>;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}
interface Callback {
  code?: string;
  state?: string;
  error?: string;
  client_id?: string;
}
function callbackFrom(url: URL): Callback {
  const get = (name: string) => url.searchParams.get(name) ?? undefined;
  return {
    code: get('code'),
    state: get('state'),
    error: get('error_description') ?? get('error'),
    client_id: get('client_id'),
  };
}
const PAGE = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;margin:3rem"><h1>${title}</h1><p>${text}</p></body>`;

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string')
        reject(new Error('no loopback port'));
      else resolve(address.port);
    });
  });
}

/**
 * Sign in with ChatGPT: register a client for a new account (or reuse the saved one for
 * the account in use), validate the ID token and the plan permission, and save the
 * account as the one in use. Throws `ChatGPTPlanDisabled` when plan use was not granted;
 * the registration is still kept, so enabling it later reuses the client.
 */
export async function signInWithChatGPT(
  options: SignInOptions = {},
): Promise<ChatGPTAccount> {
  const home = options.home ?? circleHome();
  const env = options.env ?? process.env;
  const issuer = chatgptIssuer(env);
  const hostId = agentHostId(options.userHome, env);
  const saved = activeChatGPTAccount(home);
  const returning = saved?.issuer === issuer ? saved : undefined;
  const config = await discovery(issuer);
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(32));
  const nonce = base64url(randomBytes(32));
  let settle: (value: {
    callback: Callback;
    reply?: (ok: boolean, text: string) => void;
  }) => void = () => {};
  const received = new Promise<{
    callback: Callback;
    reply?: (ok: boolean, text: string) => void;
  }>((resolve) => (settle = resolve));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/auth/callback') {
      response.writeHead(404).end();
      return;
    }
    settle({
      callback: callbackFrom(url),
      reply: (ok, text) =>
        response
          .writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html' })
          .end(PAGE(ok ? 'Signed in to Circle' : 'Sign-in failed', text)),
    });
  });
  const port = await listen(server);
  try {
    const redirect = `http://127.0.0.1:${port}/auth/callback`;
    const params = new URLSearchParams({
      client_id: returning?.client_id ?? REGISTRATION_CLIENT,
      ...(returning ? {} : { agent_name_hint: AGENT_NAME }),
      ext_agent_host_id: hostId,
      ...(returning?.id_token ? { id_token_hint: returning.id_token } : {}),
      ...(returning?.email ? { login_hint: returning.email } : {}),
      response_type: 'code',
      redirect_uri: redirect,
      scope: SCOPES,
      resource: CHATGPT_RESOURCE,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });
    const url = `${issuer}/api/accounts/authorize?${params}`;
    options.progress?.({ url, redirect });
    void options.open?.(url).catch(() => {
      /* The URL is shown; the person opens it. */
    });
    void options.pasted?.then(
      (text) => {
        try {
          const pastedUrl = new URL(text.trim());
          if (pastedUrl.pathname === '/auth/callback')
            settle({ callback: callbackFrom(pastedUrl) });
        } catch {
          /* Not the address; the loopback callback may still come. */
        }
      },
      () => {},
    );
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new ChatGPTSignInError('ChatGPT sign-in timed out')),
        SIGN_IN_TIMEOUT_MS,
      );
      timer.unref();
      options.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new ChatGPTSignInError('ChatGPT sign-in cancelled'));
        },
        { once: true },
      );
    });
    const { callback, reply } = await Promise.race([received, timeout]);
    try {
      if (callback.state !== state)
        throw new ChatGPTSignInError('ChatGPT sign-in returned another state');
      if (callback.error)
        throw callback.error === 'access_denied' ||
          /denied|declined/i.test(callback.error)
          ? new ChatGPTPlanDisabled(
              'ChatGPT plan use was not allowed · sign in again to allow it, or use an API key',
            )
          : new ChatGPTSignInError(`ChatGPT sign-in failed: ${callback.error}`);
      if (!callback.code)
        throw new ChatGPTSignInError('ChatGPT sign-in returned no code');
      // A reauthorization keeps its client; a different one is another registration.
      if (
        returning &&
        callback.client_id &&
        callback.client_id !== returning.client_id
      )
        throw new ChatGPTSignInError(
          'ChatGPT returned a different client than this account · sign in again',
        );
      const clientId = returning?.client_id ?? callback.client_id;
      if (!clientId)
        throw new ChatGPTSignInError(
          'ChatGPT sign-in did not return a client ID · sign in again',
        );
      const tokens = await tokenRequest(issuer, {
        grant_type: 'authorization_code',
        client_id: clientId,
        code: callback.code,
        code_verifier: verifier,
        redirect_uri: redirect,
        resource: CHATGPT_RESOURCE,
      });
      if (!tokens.id_token)
        throw new ChatGPTSignInError('ChatGPT returned no ID token');
      const claims = await verifyIdToken(tokens.id_token, {
        issuer,
        clientId,
        nonce,
        jwksUri: config.jwks_uri,
      });
      if (returning && claims.sub !== returning.subject)
        throw new ChatGPTSignInError(
          'ChatGPT signed in another account than the one in use · sign out first',
        );
      const scopes = (tokens.scope ?? '').split(/\s+/).filter(Boolean);
      const account: ChatGPTAccount = {
        email: typeof claims.email === 'string' ? claims.email : '',
        issuer,
        subject: String(claims.sub),
        client_id: clientId,
        ext_agent_host_id: hostId,
        id_token: tokens.id_token,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type ?? 'Bearer',
        expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        ...(typeof tokens.earliest_refresh_at === 'number'
          ? { earliest_refresh_at: tokens.earliest_refresh_at * 1000 }
          : {}),
        scopes,
        saved_at: new Date().toISOString(),
      };
      const enabled = scopes.includes(PLAN_SCOPE);
      changeStore(home, (store) => {
        store.accounts = store.accounts.filter(
          (item) => accountKey(item) !== accountKey(account),
        );
        // Without plan permission the registration is kept, without usable tokens.
        store.accounts.push(
          enabled
            ? account
            : {
                ...account,
                access_token: undefined,
                refresh_token: undefined,
              },
        );
        store.active = accountKey(account);
      });
      if (!enabled)
        throw new ChatGPTPlanDisabled(
          'ChatGPT plan use was not allowed · sign in again to allow it, or use an API key',
        );
      reply?.(true, 'You can close this tab and return to Circle.');
      return account;
    } catch (error) {
      reply?.(false, error instanceof Error ? error.message : String(error));
      throw error;
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

async function withAccountLock<T>(
  home: string,
  operation: () => Promise<T>,
): Promise<T> {
  // Its own lock: the account file's writes take theirs inside this one.
  const path = chatgptAccountsPath(ensureHome(home)) + '.refresh';
  const release = await lockfile.lock(path, {
    realpath: false,
    stale: 30_000,
    update: 5_000,
    retries: { retries: 100, minTimeout: 20, maxTimeout: 250 },
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

/**
 * A current access token for the account in use. Refreshes are serialized across every
 * Circle process sharing this home, so a rotating refresh token is never used twice.
 */
export async function chatgptAccessToken(
  home = circleHome(),
  env = process.env,
  now = () => Date.now(),
): Promise<string> {
  const fresh = (account?: ChatGPTAccount) =>
    account?.access_token &&
    (account.expires_at ?? 0) - now() > REFRESH_MARGIN_MS
      ? account.access_token
      : undefined;
  const current = activeChatGPTAccount(home);
  const ready = fresh(current);
  if (ready) return ready;
  return withAccountLock(home, async () => {
    // Another process may have refreshed while this one waited.
    const account = activeChatGPTAccount(home);
    const refreshed = fresh(account);
    if (refreshed) return refreshed;
    if (!account?.refresh_token)
      throw new ChatGPTSignInError(
        'not signed in to ChatGPT · /login or `circle --init` signs in again',
      );
    const usable =
      account.access_token && (account.expires_at ?? 0) > now()
        ? account.access_token
        : undefined;
    if (
      usable &&
      account.earliest_refresh_at &&
      now() < account.earliest_refresh_at
    )
      return usable;
    let tokens: TokenResponse;
    try {
      tokens = await tokenRequest(chatgptIssuer(env), {
        grant_type: 'refresh_token',
        client_id: account.client_id,
        refresh_token: account.refresh_token,
        resource: CHATGPT_RESOURCE,
      });
    } catch (error) {
      if (
        error instanceof TokenEndpointError &&
        (TERMINAL_REFRESH_CODES.includes(error.code) ||
          error.code === 'invalid_client')
      ) {
        // An unusable refresh token: clear the tokens, keep the registration.
        changeStore(home, (store) => {
          const saved = store.accounts.find(
            (item) => accountKey(item) === accountKey(account),
          );
          if (saved) {
            delete saved.access_token;
            delete saved.refresh_token;
            delete saved.expires_at;
          }
        });
        throw new ChatGPTSignInError(
          `ChatGPT sign-in has ended (${error.code}) · /login signs in again`,
        );
      }
      // A network or server failure: the old token serves while it lasts.
      if (usable) return usable;
      throw error;
    }
    changeStore(home, (store) => {
      const saved = store.accounts.find(
        (item) => accountKey(item) === accountKey(account),
      );
      if (!saved) return;
      saved.access_token = tokens.access_token;
      if (tokens.refresh_token) saved.refresh_token = tokens.refresh_token;
      saved.expires_at = now() + (tokens.expires_in ?? 3600) * 1000;
      if (typeof tokens.earliest_refresh_at === 'number')
        saved.earliest_refresh_at = tokens.earliest_refresh_at * 1000;
      else delete saved.earliest_refresh_at;
      if (tokens.scope)
        saved.scopes = tokens.scope.split(/\s+/).filter(Boolean);
      saved.saved_at = new Date(now()).toISOString();
    });
    return tokens.access_token;
  });
}

/**
 * Sign out of the account in use: revoke its renewable session, then clear its tokens.
 * The registration and this host's ID stay for a later sign-in.
 */
export async function signOutOfChatGPT(
  home = circleHome(),
  env = process.env,
  wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ revoked: boolean }> {
  const account = activeChatGPTAccount(home);
  let revoked = !account?.refresh_token;
  if (account?.refresh_token) {
    for (let attempt = 0; attempt < 3 && !revoked; attempt++) {
      if (attempt) await wait(500 * 2 ** attempt);
      try {
        const { revocation_endpoint } = await discovery(
          account.issuer || chatgptIssuer(env),
        );
        if (!revocation_endpoint) break;
        const response = await fetch(revocation_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: account.refresh_token,
            token_type_hint: 'refresh_token',
            client_id: account.client_id,
          }).toString(),
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) revoked = true;
        else if (response.status < 500) break;
      } catch {
        /* A network failure: try again, then sign out locally. */
      }
    }
  }
  if (account)
    changeStore(home, (store) => {
      const saved = store.accounts.find(
        (item) => accountKey(item) === accountKey(account),
      );
      if (saved) {
        delete saved.access_token;
        delete saved.refresh_token;
        delete saved.expires_at;
        delete saved.earliest_refresh_at;
      }
      delete store.active;
    });
  return { revoked };
}

/** The account's model catalog: the slugs meant for a picker, in the server's order. */
export async function chatgptModels(
  baseUrl: string,
  token: string,
  timeout = 15_000,
): Promise<string[]> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`http ${response.status}`);
  const body = (await response.json()) as { models?: unknown };
  if (!Array.isArray(body.models)) throw new Error('invalid model list');
  return body.models.flatMap((model) =>
    isRecord(model) &&
    typeof model.slug === 'string' &&
    model.visibility === 'list' &&
    model.supported_in_api !== false
      ? [model.slug]
      : [],
  );
}

/**
 * What a ChatGPT plan failure tells the person, for the codes OpenAI documents a recovery
 * for; undefined for anything else, which keeps its own message.
 */
export function planFailureMessage(
  records: Record<string, unknown>[],
  status?: number,
): string | undefined {
  const field = (name: string) =>
    records
      .map((row) => row[name])
      .find((value): value is string => typeof value === 'string' && !!value);
  const code = field('code') ?? '';
  const param = field('param');
  if (code === 'subscription_sharing_usage_limit_exceeded')
    return `Usage limit reached · your ChatGPT plan, or Circle's limit within it · Manage usage: ${MANAGE_USAGE_URL}`;
  if (code === 'subscription_sharing_user_not_eligible')
    return 'ChatGPT plan usage is not available for this account or workspace · /login can use an API key instead';
  if (
    code === 'subscription_sharing_unsupported_capability' ||
    code === 'subscription_sharing_route_not_supported'
  )
    return `The ChatGPT plan route does not take part of this request${param ? ` (${param})` : ''}`;
  if (code === 'subscription_sharing_invalid_user')
    return 'ChatGPT could not validate this account · /login signs in again';
  if (code.startsWith('chatpass_v2_'))
    return 'ChatGPT did not authorize this request for Circle · /login signs in again';
  // Admission before a stream opens can answer `{"detail": …}` without an error code.
  const detail = field('detail');
  if (!code && status === 401)
    return `ChatGPT did not accept this sign-in for plan use${detail ? ` (${detail})` : ''} · /login signs in again`;
  if (!code && status === 403 && detail)
    return `ChatGPT refused the request: ${detail}`;
  return undefined;
}

/** The bearer credential for the saved connection: its API key, or a ChatGPT access token. */
export async function connectionKey(
  settings: { auth: { protocol: string; api_key_ref: string } },
  home = circleHome(),
): Promise<string> {
  if (settings.auth.protocol === 'chatgpt') return chatgptAccessToken(home);
  const credentials = loadCredentials(home);
  return credentials[settings.auth.api_key_ref] || credentials.api_key || '';
}
