// Connecting a Circle Hub by its address, for the bundled Hub extension. Nothing here signs in: the Hub is an ordinary
// MCP server entry named HUB_SERVER, and its sign-in is the MCP authorization of any server (mcp_loader.ts), by device
// code where the Hub offers it. This only finds the Hub's MCP endpoint from what a person typed, and writes, or removes,
// that entry. No address is built in: there is none until a person types one.
import { isRecord, type CircleSettings } from './settings.js';
import { mcpServer } from './mcp_config.js';

/** The name of the MCP server entry the Hub extension keeps. */
export const HUB_SERVER = 'Hub';
/** The port a Circle Hub listens on unless it is told another (circle-hub's DEFAULT_PORT). */
export const HUB_PORT = 7420;
/** How long finding a Hub at an address may take. */
const FIND_TIMEOUT_MS = 10_000;

export class HubAddressError extends Error {}

/**
 * The addresses to try for what a person typed: as typed when it names http or https, otherwise https first and then
 * http, since a Hub on an internal address often serves plain HTTP. A path of `/` or `/mcp` is the Hub itself. An
 * address without a port is tried at its scheme's own port and then at the Hub's, HUB_PORT, so the Hub's IP address
 * alone finds it.
 */
export function hubCandidates(typed: string): URL[] {
  const value = typed.trim();
  if (!value || value.length > 2048 || /\s/.test(value))
    throw new HubAddressError('type the address of a Circle Hub');
  const schemed = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  const raw = schemed ? [value] : [`https://${value}`, `http://${value}`];
  const origins = raw.map((candidate) => {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new HubAddressError('that is not a web address');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new HubAddressError(
        'a Hub address starts with https:// or http://',
      );
    if (url.username || url.password)
      throw new HubAddressError(
        'a Hub address carries no user name or password',
      );
    if (url.search || url.hash)
      throw new HubAddressError('a Hub address has no query or fragment');
    if (url.pathname !== '/' && url.pathname !== '/mcp')
      throw new HubAddressError('type the Hub address without a path');
    return new URL(url.origin);
  });
  // A port typed, or a scheme's own that is the Hub's, leaves nothing more to try
  if (origins.some((url) => url.port !== '')) return origins;
  return [
    ...origins,
    ...origins.map((url) => {
      const withPort = new URL(url.href);
      withPort.port = String(HUB_PORT);
      return withPort;
    }),
  ];
}

/** The MCP endpoint a Hub's discovery names, when it is on the Hub's own origin. */
function sameOrigin(raw: unknown, origin: URL): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const url = new URL(raw);
    return url.origin === origin.origin ? url.href : undefined;
  } catch {
    return undefined;
  }
}

async function json(
  url: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  const response = await fetcher(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal,
  }).catch(() => undefined);
  if (!response?.ok) return undefined;
  const body: unknown = await response.json().catch(() => undefined);
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

/** The MCP endpoint of the Hub at `origin`, as findHub says, or undefined when no Hub answers there. */
async function hubAt(
  origin: URL,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<string | undefined> {
  const discovery = await json(
    new URL('/.well-known/knowledge-sync', origin).href,
    fetcher,
    signal,
  );
  const mcp = discovery?.mcp as Record<string, unknown> | undefined;
  const endpoint =
    discovery?.schema === 'knowledge-sync-discovery@1'
      ? sameOrigin(mcp?.endpoint, origin)
      : undefined;
  if (endpoint) return endpoint;
  const resource = await json(
    new URL('/.well-known/oauth-protected-resource/mcp', origin).href,
    fetcher,
    signal,
  );
  return sameOrigin(resource?.resource, origin);
}

/**
 * The MCP endpoint of the Hub at `typed`. A Hub publishes it in its knowledge-sync discovery
 * (`/.well-known/knowledge-sync`, `mcp.endpoint`); a server that answers only the protected-resource metadata of its
 * `/mcp` (RFC 9728) is taken by that. Anything else is not a Hub. Every candidate address is asked at once, so one that
 * never answers costs no more than the wait for the others; the first of them in hubCandidates' order that is a Hub
 * is the one taken.
 */
export async function findHub(
  typed: string,
  fetcher: typeof fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(FIND_TIMEOUT_MS),
): Promise<string> {
  const candidates = hubCandidates(typed);
  const answers = candidates.map((origin) => hubAt(origin, fetcher, signal));
  for (const answer of answers) {
    const endpoint = await answer;
    if (endpoint) return endpoint;
  }
  signal.throwIfAborted();
  const origins = candidates.map((url) => url.origin);
  throw new HubAddressError(
    `no Circle Hub answers at ${origins.length > 1 ? origins.slice(0, -1).join(', ') + ' or ' + origins.at(-1) : origins[0]}`,
  );
}

/** The Hub entry's endpoint in `settings`, if there is one. */
export function hubEndpoint(settings: CircleSettings): string | undefined {
  const url = mcpServer(settings.mcpServers, HUB_SERVER)?.url;
  return typeof url === 'string' && url ? url : undefined;
}

/**
 * The placeholders the Hub entry names (mcp_placeholders.ts): a Hub's own skills write the Hub's endpoint and token as
 * `%HUB_URL%` and `%HUB_TOKEN%`, so a program they run reaches the Hub with the person's own sign-in.
 */
export const HUB_PLACEHOLDERS = { url: 'HUB_URL', token: 'HUB_TOKEN' } as const;

function sameEndpoint(existingUrl: unknown, nextEndpoint: string): boolean {
  if (typeof existingUrl !== 'string') return false;
  try {
    return new URL(existingUrl).href === new URL(nextEndpoint).href;
  } catch {
    return false;
  }
}

/** The MCP entry of a Hub at this endpoint, saved under HUB_SERVER: the one the desktop's Hub page and `/hub` save. */
export function hubEntry(
  endpoint: string,
  headers?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'http',
    url: endpoint,
    enabled: true,
    placeholders: { ...HUB_PLACEHOLDERS },
    ...(headers ? { headers: { ...headers } } : {}),
  };
}
/**
 * Puts the Hub entry for `endpoint` into `settings` (as saveSettingsChange changes them), under HUB_SERVER in
 * `mcpServers`, and keeps the extension on.
 */
export function addHub(settings: CircleSettings, endpoint: string): void {
  const existing = settings.mcpServers
    ? mcpServer(settings.mcpServers, HUB_SERVER)
    : undefined;
  const headers =
    existing &&
    sameEndpoint(existing.url, endpoint) &&
    isRecord(existing.headers)
      ? existing.headers
      : undefined;
  settings.mcpServers = {
    ...settings.mcpServers,
    [HUB_SERVER]: hubEntry(endpoint, headers),
  };
  settings.extensions = {
    ...settings.extensions,
    hub: { ...settings.extensions.hub, enabled: true },
  };
}

/** Takes the Hub entry out of `settings`. */
export function removeHub(settings: CircleSettings): void {
  const { [HUB_SERVER]: _hub, ...rest } = settings.mcpServers;
  settings.mcpServers = rest;
}

/**
 * Gives a Hub entry written before the entry named its placeholders (by hand, or by Circle 1.16) the placeholders
 * addHub writes, while the Hub extension is on; a Hub entry that names its own is left as it is. True when it changed
 * `settings`.
 */
export function keepHubPlaceholders(settings: CircleSettings): boolean {
  if (settings.extensions.hub?.enabled !== true) return false;
  const hub = mcpServer(settings.mcpServers, HUB_SERVER);
  if (!hub || hub.placeholders !== undefined) return false;
  settings.mcpServers = {
    ...settings.mcpServers,
    [HUB_SERVER]: { ...hub, placeholders: { ...HUB_PLACEHOLDERS } },
  };
  return true;
}
