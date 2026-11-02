// The MCP authorization on Circle's side (OAuth 2.1 with PKCE, through the official SDK's client). A server reached by
// URL that answers 401 with its resource metadata is authorized in the system browser; Circle keeps what that gave it,
// the client registration, the tokens and the port of its loopback redirect, per server in mcp-auth.json under the
// Circle home (0600). Nothing here belongs to one server: any server that follows the specification is authorized the
// same way. A server whose entry already sends a credential header is not authorized this way; its header is used.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { isRecord, readJson, writePrivateJson } from './settings.js';

export const MCP_AUTH_FILE = 'mcp-auth.json';
/** How long Circle waits for the browser to come back from a server's authorization page. */
export const AUTHORIZATION_WAIT_MS = 10 * 60 * 1000;

interface Kept {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discovery?: OAuthDiscoveryState;
  /** The loopback port the client was registered with: its redirect URI names it. */
  port?: number;
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
  const all = loadAll(home);
  const value = next(all[server] ?? {});
  if (Object.values(value).every((part) => part === undefined))
    delete all[server];
  else all[server] = value;
  writePrivateJson(mcpAuthPath(home), { servers: all });
}

/** What Circle keeps for a server, read fresh: another Circle may have signed in meanwhile. */
export const keptFor = (home: string, server: string): Kept =>
  loadAll(home)[server] ?? {};

/** Forgets a server's authorization: the next connection signs in again. */
export function forgetAuthorization(home: string, server: string): void {
  change(home, server, () => ({}));
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
    return {
      client_name: host ? `Circle on ${host}` : 'Circle',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
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
    return keptFor(this.home, this.server).tokens;
  }
  saveTokens(tokens: OAuthTokens): void {
    change(this.home, this.server, (kept) => ({ ...kept, tokens }));
  }
  redirectToAuthorization(url: URL): void {
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
      ...(scope === 'all' || scope === 'tokens' ? { tokens: undefined } : {}),
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
