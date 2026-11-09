// The MCP authorization on Circle's side (OAuth 2.1 with PKCE, through the official SDK's client). A server reached by
// URL that answers 401 with its resource metadata is authorized in the system browser; Circle keeps what that gave it,
// the client registration, the tokens and the port of its loopback redirect, per server in mcp-auth.json under the
// Circle home (0600). Nothing here belongs to one server: any server that follows the specification is authorized the
// same way. A server whose entry already sends a credential header is not authorized this way; its header is used.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import lockfile from 'proper-lockfile';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureHome } from './paths.js';
import { DEVICE_CODE_GRANT, deviceEndpoint } from './mcp_device.js';
import { abortable } from './watch.js';
import { refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthTokensSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  isRecord,
  readJson,
  writePrivateJson,
  withPrivateJsonLock,
} from './settings.js';

export const MCP_AUTH_FILE = 'mcp-auth.json';
/** How long Circle waits for the browser to come back from a server's authorization page. */
export const AUTHORIZATION_WAIT_MS = 10 * 60 * 1000;

interface Kept {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discovery?: OAuthDiscoveryState;
  /** The loopback port the client was registered with: its redirect URI names it. */
  port?: number;
  /** Opaque authorization identity: refresh preserves it; a new sign-in replaces it. */
  grant_id?: string;
  expires_at?: number;
  direct_fingerprint?: string;
  direct_id?: string;
}

export const mcpAuthPath = (home: string): string => join(home, MCP_AUTH_FILE);

function loadAll(home: string): Record<string, Kept> {
  let raw: unknown;
  try {
    raw = readJson(mcpAuthPath(home));
  } catch {
    return {};
  }
  return isRecord(raw) && isRecord(raw.servers)
    ? (raw.servers as Record<string, Kept>)
    : {};
}

function change(
  home: string,
  server: string,
  next: (kept: Kept) => Kept,
): void {
  ensureHome(home);
  withPrivateJsonLock(mcpAuthPath(home), () => {
    const all = loadAll(home);
    const value = next(all[server] ?? {});
    if (Object.values(value).every((part) => part === undefined))
      delete all[server];
    else all[server] = value;
    writePrivateJson(mcpAuthPath(home), { servers: all });
  });
}

/** What Circle keeps for a server, read fresh: another Circle may have signed in meanwhile. */
export const keptFor = (home: string, server: string): Kept =>
  loadAll(home)[server] ?? {};

/** Forgets a server's authorization: the next connection signs in again. */
export function forgetAuthorization(home: string, server: string): void {
  change(home, server, () => ({}));
}

/**
 * Signs out of a server: its tokens are revoked at the revocation endpoint its metadata names (RFC 7009), then its
 * authorization is forgotten. A revocation that fails or that the server does not offer still forgets it here; the
 * answer says whether the server took every revocation.
 */
export async function revokeAuthorization(
  home: string,
  server: string,
  fetcher: FetchLike = fetch,
): Promise<boolean> {
  const kept = keptFor(home, server);
  const endpoint = (
    kept.discovery?.authorizationServerMetadata as
      Record<string, unknown> | undefined
  )?.revocation_endpoint;
  const tokens = [
    ...(kept.tokens?.refresh_token
      ? [['refresh_token', kept.tokens.refresh_token]]
      : []),
    ...(kept.tokens?.access_token
      ? [['access_token', kept.tokens.access_token]]
      : []),
  ];
  let revoked = typeof endpoint === 'string' && tokens.length > 0;
  if (typeof endpoint === 'string')
    for (const [hint, token] of tokens) {
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: token!,
          token_type_hint: hint!,
          ...(kept.client?.client_id
            ? { client_id: kept.client.client_id }
            : {}),
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
      if (!response?.ok) revoked = false;
    }
  forgetAuthorization(home, server);
  return revoked;
}

function listenable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * The loopback port of a server's redirect: the one its client was registered with while it can still be listened
 * on, else a new one, and then the registration is dropped, since a server may hold its client to the exact address.
 */
export async function redirectPort(
  home: string,
  server: string,
): Promise<number> {
  const kept = keptFor(home, server).port;
  if (kept && (await listenable(kept))) return kept;
  const port = await freePort();
  change(home, server, (current) => ({
    ...current,
    port,
    client: undefined,
  }));
  return port;
}

/** Circle as an OAuth client of one MCP server, for the SDK's transports. */
export class McpAuthProvider implements OAuthClientProvider {
  /** The authorization page the SDK asked to open, when it asked. */
  authorizationUrl: URL | undefined;
  #verifier = '';
  #state = '';
  #observedGrant?: string;
  #observedAccess?: string;
  #refreshGrant?: string;
  #refreshFailed = false;
  constructor(
    readonly home: string,
    readonly server: string,
    readonly port: number,
  ) {}
  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}/callback`;
  }
  get clientMetadata(): OAuthClientMetadata {
    const host = (hostname().split('.')[0] ?? '').slice(0, 60);
    // The SDK keeps the server's metadata before it registers: the device code is asked for only where it is offered
    const device = deviceEndpoint(keptFor(this.home, this.server).discovery)
      ? [DEVICE_CODE_GRANT]
      : [];
    return {
      client_name: host ? `Circle on ${host}` : 'Circle',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token', ...device],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state(): string {
    this.#state = randomBytes(24).toString('base64url');
    return this.#state;
  }
  /** The state the redirect must bring back. */
  get expectedState(): string {
    return this.#state;
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return keptFor(this.home, this.server).client;
  }
  saveClientInformation(client: OAuthClientInformationMixed): void {
    change(this.home, this.server, (kept) => ({ ...kept, client }));
  }
  tokens(): OAuthTokens | undefined {
    const kept = oauthMcpGrant(this.home, this.server);
    this.#observedAccess = kept.tokens?.access_token;
    this.#observedGrant = kept.grant_id;
    return kept.tokens;
  }
  saveTokens(tokens: OAuthTokens): void {
    if (this.#refreshGrant) {
      change(this.home, this.server, (kept) => {
        if (
          kept.grant_id !== this.#refreshGrant ||
          kept.tokens?.access_token !== tokens.access_token
        )
          throw new McpLoginRequired();
        return { ...kept, tokens };
      });
      return;
    }
    const interactive = !!this.authorizationUrl;
    this.authorizationUrl = undefined;
    change(this.home, this.server, (kept) => ({
      ...kept,
      tokens,
      grant_id:
        !interactive && kept.tokens?.access_token === tokens.access_token
          ? (kept.grant_id ?? randomUUID())
          : randomUUID(),
      expires_at:
        tokens.expires_in === undefined
          ? undefined
          : Date.now() + tokens.expires_in * 1000,
    }));
  }
  redirectToAuthorization(url: URL): void {
    if (this.#refreshFailed) throw new McpLoginRequired();
    this.#refreshGrant = undefined;
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string): void {
    this.#verifier = verifier;
  }
  codeVerifier(): string {
    if (!this.#verifier) throw new Error('no sign-in is under way');
    return this.#verifier;
  }
  invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): void {
    if (scope === 'verifier') {
      this.#verifier = '';
      return;
    }
    change(this.home, this.server, (kept) => ({
      ...kept,
      ...(scope === 'all' || scope === 'client' ? { client: undefined } : {}),
      ...(scope === 'all' || scope === 'tokens'
        ? { tokens: undefined, grant_id: undefined, expires_at: undefined }
        : {}),
      ...(scope === 'all' || scope === 'discovery'
        ? { discovery: undefined }
        : {}),
    }));
  }
  saveDiscoveryState(discovery: OAuthDiscoveryState): void {
    change(this.home, this.server, (kept) => ({ ...kept, discovery }));
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    return keptFor(this.home, this.server).discovery;
  }
  /** SDK transports and the background client share this single refresh boundary. */
  authorizedFetch(
    fetcher: FetchLike = fetch,
    lifetime?: AbortSignal,
  ): FetchLike {
    return async (url, init) => {
      const form =
        init?.body instanceof URLSearchParams
          ? init.body
          : typeof init?.body === 'string'
            ? new URLSearchParams(init.body)
            : null;
      if (
        init?.method?.toUpperCase() !== 'POST' ||
        form?.get('grant_type') !== 'refresh_token'
      )
        return fetcher(url, init);
      const state = keptFor(this.home, this.server),
        endpoint =
          state.discovery?.authorizationServerMetadata?.token_endpoint ??
          (state.discovery?.authorizationServerUrl
            ? new URL('/token', state.discovery.authorizationServerUrl).href
            : undefined);
      if (
        !endpoint ||
        String(new URL(String(url))) !== String(new URL(endpoint))
      )
        throw new McpLoginRequired();
      const observed = this.#observedGrant ?? state.grant_id;
      let token: OAuthTokens;
      try {
        token = await sharedRefresh(
          this.home,
          this.server,
          observed,
          this.#observedAccess ?? state.tokens?.access_token,
          form.get('refresh_token')!,
          async (current, active) => {
            const body = new URLSearchParams(form);
            body.set('refresh_token', current.refresh_token!);
            const response = await fetcher(url, {
              ...init,
              body,
              redirect: 'error',
              signal: active,
            });
            if (!response.ok) throw new McpLoginRequired();
            const tokens = OAuthTokensSchema.parse(await response.json());
            return {
              ...current,
              ...tokens,
              refresh_token: tokens.refresh_token ?? current.refresh_token,
            };
          },
          lifetime && init?.signal
            ? AbortSignal.any([lifetime, init.signal])
            : (lifetime ?? init?.signal ?? undefined),
        );
      } catch (error) {
        this.#refreshFailed = true;
        throw new McpLoginRequired();
      }
      // The SDK still validates the response and stores its issuer stamp. Never return our private bookkeeping.
      this.#refreshGrant = observed;
      const { issuer: ignored, ...wire } = token;
      return new Response(JSON.stringify(wire), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
      });
    };
  }
  async backgroundToken(
    signal: AbortSignal,
    rejected?: string,
  ): Promise<string> {
    signal.throwIfAborted();
    let kept = keptFor(this.home, this.server);
    if (
      !kept.tokens ||
      !kept.grant_id ||
      kept.tokens.token_type.toLowerCase() !== 'bearer'
    )
      throw new McpLoginRequired();
    if (rejected && kept.tokens.access_token !== rejected)
      return kept.tokens.access_token;
    if (
      !rejected &&
      (kept.expires_at === undefined || kept.expires_at > Date.now() + 30000)
    )
      return kept.tokens.access_token;
    const discovery = kept.discovery,
      client = kept.client,
      issuer = discovery?.authorizationServerUrl;
    if (
      !discovery ||
      !client ||
      !issuer ||
      !kept.tokens.refresh_token ||
      (kept.tokens.issuer && kept.tokens.issuer !== issuer)
    )
      throw new McpLoginRequired();
    const resource = new URL(
      discovery.resourceMetadata?.resource ?? this.server,
    );
    if (resource.origin !== new URL(this.server).origin)
      throw new McpLoginRequired();
    const endpoint = new URL(
      discovery.authorizationServerMetadata?.token_endpoint ?? '/token',
      issuer,
    );
    if (
      endpoint.username ||
      endpoint.password ||
      (endpoint.protocol !== 'https:' &&
        !(
          endpoint.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
        ))
    )
      throw new McpLoginRequired();
    this.#observedGrant = kept.grant_id;
    this.#observedAccess = kept.tokens.access_token;
    const tokens = await refreshAuthorization(issuer, {
      metadata: discovery.authorizationServerMetadata,
      clientInformation: client,
      refreshToken: kept.tokens.refresh_token,
      resource,
      fetchFn: this.authorizedFetch(fetch, signal),
    });
    signal.throwIfAborted();
    kept = keptFor(this.home, this.server);
    if (!kept.tokens || kept.tokens.access_token !== tokens.access_token)
      throw new McpLoginRequired();
    return tokens.access_token;
  }
}

export class McpLoginRequired extends Error {
  constructor() {
    super('MCP sign-in is required');
  }
}
interface RefreshFlight {
  promise: Promise<OAuthTokens>;
  controller: AbortController;
  users: Set<symbol>;
  settled: boolean;
}
const refreshes = new Map<string, RefreshFlight>();
async function sharedRefresh(
  home: string,
  server: string,
  grant: string | undefined,
  access: string | undefined,
  refresh: string,
  exchange: (current: OAuthTokens, signal: AbortSignal) => Promise<OAuthTokens>,
  signal?: AbortSignal,
): Promise<OAuthTokens> {
  signal?.throwIfAborted();
  const key =
    join(
      realpathSync(ensureHome(home)),
      createHash('sha256').update(server).digest('hex'),
    ) +
    ':' +
    grant;
  let flight = refreshes.get(key);
  if (!flight) {
    const controller = new AbortController(),
      active = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
    const promise = (async () => {
      const path = join(
        realpathSync(home),
        'mcp-refresh-' + createHash('sha256').update(server).digest('hex'),
      );
      let release: (() => Promise<void>) | undefined;
      while (!release) {
        active.throwIfAborted();
        try {
          release = await lockfile.lock(path, {
            realpath: false,
            stale: 30000,
            update: 5000,
            onCompromised: () => controller.abort(new McpLoginRequired()),
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ELOCKED')
            throw new McpLoginRequired();
          await delay(25, undefined, { signal: active });
        }
      }
      try {
        active.throwIfAborted();
        const kept = keptFor(home, server);
        if (!grant || kept.grant_id !== grant || !kept.tokens?.refresh_token)
          throw new McpLoginRequired();
        if (
          kept.tokens.access_token !== access ||
          kept.tokens.refresh_token !== refresh
        )
          return kept.tokens;
        const before = kept.tokens.access_token,
          tokens = await exchange(kept.tokens, active);
        active.throwIfAborted();
        change(home, server, (current) => {
          if (
            current.grant_id !== grant ||
            current.tokens?.access_token !== before
          )
            throw new McpLoginRequired();
          return {
            ...current,
            tokens,
            expires_at:
              tokens.expires_in === undefined
                ? undefined
                : Date.now() + tokens.expires_in * 1000,
          };
        });
        return tokens;
      } finally {
        await release();
      }
    })();
    flight = { promise, controller, users: new Set(), settled: false };
    refreshes.set(key, flight);
    const current = flight;
    void promise
      .finally(() => {
        current.settled = true;
        if (refreshes.get(key) === current) refreshes.delete(key);
      })
      .catch(() => {});
  }
  const user = Symbol();
  flight.users.add(user);
  try {
    const tokens = await (signal
      ? abortable(flight.promise, signal)
      : flight.promise);
    if (keptFor(home, server).grant_id !== grant) throw new McpLoginRequired();
    return tokens;
  } finally {
    flight.users.delete(user);
    if (!flight.users.size && !flight.settled)
      flight.controller.abort(Error('MCP refresh has no remaining callers'));
  }
}
/** Upgrade legacy saved grants without guessing an account from a token value. */
export function oauthMcpGrant(home: string, server: string): Kept {
  let kept = keptFor(home, server);
  if (kept.tokens && !kept.grant_id) {
    change(home, server, (current) => ({
      ...current,
      ...(current.tokens && !current.grant_id
        ? { grant_id: randomUUID() }
        : {}),
    }));
    kept = keptFor(home, server);
  }
  return kept;
}
export function currentDirectMcpGrant(
  home: string,
  server: string,
  bearer: string,
): string | undefined {
  const kept = keptFor(home, server);
  return kept.direct_fingerprint ===
    createHash('sha256').update(bearer).digest('hex')
    ? kept.direct_id
    : undefined;
}
/** Direct Bearer replacement changes the opaque binding; token fingerprints stay only in the private auth file. */
export function directMcpGrant(
  home: string,
  server: string,
  bearer: string,
): string {
  let id = '';
  change(home, server, (kept) => {
    const fingerprint = createHash('sha256').update(bearer).digest('hex');
    id =
      kept.direct_fingerprint === fingerprint && kept.direct_id
        ? kept.direct_id
        : randomUUID();
    return { ...kept, direct_fingerprint: fingerprint, direct_id: id };
  });
  return id;
}

const page = (text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Circle</title><p>${text}</p>\n`;

/**
 * Listens on the loopback port for the browser's redirect: `ready` once listening, `code` the code it brings, after
 * checking that it brings back the state of this sign-in. A refusal (`error`) with that state ends the wait; anything
 * else gets a page and is ignored. The wait ends after `waitMs`, or when `signal` aborts.
 */
export function startRedirect(
  port: number,
  state: () => string,
  signal: AbortSignal,
  waitMs = AUTHORIZATION_WAIT_MS,
): { ready: Promise<void>; code: Promise<string> } {
  let listening!: () => void;
  const ready = new Promise<void>((resolve) => (listening = resolve));
  const code = new Promise<string>((resolve, reject) => {
    let done = false;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        response.writeHead(404).end();
        return;
      }
      const ours = state() !== '' && url.searchParams.get('state') === state();
      const given = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const answer = (status: number, text: string) =>
        response
          .writeHead(status, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            // A kept-alive connection would take the browser's next sign-in to this listener after it closed
            connection: 'close',
          })
          .end(page(text));
      if (ours && given) {
        answer(200, 'Circle is signed in. You can close this window.');
        finish(() => resolve(given));
      } else if (ours && error) {
        answer(
          200,
          'The sign-in was not completed. You can close this window.',
        );
        finish(() =>
          reject(
            new Error(
              `the server refused the sign-in (${/^[a-z_]{1,40}$/.test(error) ? error : 'error'})`,
            ),
          ),
        );
      } else {
        answer(400, 'This is not the sign-in Circle is waiting for.');
      }
    });
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new Error('the sign-in was not completed in time')),
        ),
      waitMs,
    );
    const abort = () =>
      finish(() => reject(new Error('the sign-in was cancelled')));
    // The answer to the browser goes out first (it closes its connection); every other connection ends with the wait
    function finish(then: () => void): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      server.close();
      server.closeIdleConnections();
      listening();
      then();
    }
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    server.once('error', (error) => finish(() => reject(error)));
    server.listen(port, '127.0.0.1', () => listening());
  });
  return { ready, code };
}
