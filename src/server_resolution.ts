// Where a server that implements knowledge-sync v1 serves its parts, resolved from one MCP
// server entry. Local skills and knowledge sync both start here, so both read the same
// discovery document and treat a path prefix the same way. No product is named: any server
// that publishes `/.well-known/knowledge-sync` (RFC 8615) is used as it declares itself.
import { parseStrictJson } from './knowledge/strict-json.js';
import { validateAnswer } from './knowledge/protocol.js';

/** The relative sync route templates: fixed by the protocol, appended to the sync base. */
export const SYNC_V1_TEMPLATE_PREFIX = '/api/sync/v1';
export const DISCOVERY_PATH = '/.well-known/knowledge-sync';
const DISCOVERY_BYTES = 64 * 1024;

export interface McpToolUse {
  tool: string;
  argument: string;
  fixed?: Record<string, string | boolean>;
}
export interface ServerDiscovery {
  /** `document`: the server published a discovery document; `fallback`: it has none. */
  source: 'document' | 'fallback';
  /** The origin of the MCP entry, which the document's issuer must equal. */
  origin: string;
  /** Absolute sync base URL without a trailing slash. */
  syncBase: string;
  /** Sync capabilities the server advertises (none on fallback). */
  capabilities: readonly string[];
  /** Absolute base of the local-tools distribution, without a trailing slash. */
  localToolsBase: string;
  /** Which MCP tool and argument serve each named operation. */
  mcp: Readonly<Record<string, McpToolUse>>;
}
export class DiscoveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

const trimSlashes = (path: string): string => path.replace(/\/+$/, '');
/** The entry URL without its trailing `/mcp`: the base its path-relative parts live under. */
export function serverBaseUrl(url: string): string {
  const trimmed = trimSlashes(url.trim());
  return trimmed.endsWith('/mcp') ? trimmed.slice(0, -4) : trimmed;
}
/**
 * HTTPS anywhere, or HTTP only on loopback; never credentials, a query or a fragment.
 * `allowHttp` keeps an entry's own plain-HTTP scheme for callers that already send its
 * token there (local tools); sync never passes it.
 */
export function safeServerUrl(value: string, allowHttp = false): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['https:', 'http:'].includes(url.protocol) ||
    (url.protocol === 'http:' &&
      !allowHttp &&
      !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
  )
    throw Error(
      'server URL must be HTTPS or loopback HTTP without credentials',
    );
  return url;
}
const sameEndpoint = (a: string, b: string): boolean => {
  const left = new URL(a),
    right = new URL(b);
  return (
    left.origin === right.origin &&
    trimSlashes(left.pathname) === trimSlashes(right.pathname)
  );
};

/**
 * What a server without a discovery document is assumed to offer: plain v1 under the
 * entry's base, the local tools beside it, and the tool shapes earlier servers used.
 */
export function fallbackDiscovery(
  entry: string,
  allowHttp = false,
): ServerDiscovery {
  const url = safeServerUrl(entry, allowHttp),
    base = serverBaseUrl(url.href);
  return Object.freeze({
    source: 'fallback',
    origin: url.origin,
    syncBase: base + SYNC_V1_TEMPLATE_PREFIX,
    capabilities: Object.freeze([]),
    localToolsBase: base + '/local-tools',
    mcp: Object.freeze({
      'team-memory-read': {
        tool: 'get_nodes',
        argument: 'memory',
        fixed: { scope: 'team' },
      },
      'entry-share': { tool: 'upload_file', argument: 'share_entry' },
      'memory-share': { tool: 'upload_file', argument: 'memory_share' },
    }),
  });
}

/** Accepts a parsed `knowledge-sync-discovery@1` for the entry; unknown members are ignored. */
export function parseDiscovery(
  value: unknown,
  entry: string,
  allowHttp = false,
): ServerDiscovery {
  try {
    validateAnswer('knowledge-sync-discovery@1', value);
  } catch {
    throw new DiscoveryError(
      'discovery document is not knowledge-sync-discovery@1',
      false,
    );
  }
  const doc = value as {
    issuer: string;
    sync: {
      versions: { version: string; base_url: string; capabilities: string[] }[];
    };
    local_tools: { base_url: string };
    mcp?: { endpoint: string; capabilities: Record<string, McpToolUse> };
  };
  const origin = safeServerUrl(entry, allowHttp).origin;
  const sameOrigin = (url: string): string => {
    const parsed = safeServerUrl(url, allowHttp);
    if (parsed.origin !== origin)
      throw new DiscoveryError(
        'discovery document names another origin',
        false,
      );
    return trimSlashes(parsed.href);
  };
  if (trimSlashes(new URL(doc.issuer).href) !== origin)
    throw new DiscoveryError(
      'discovery issuer is not the requested origin',
      false,
    );
  const v1 = doc.sync.versions.find((v) => v.version === 'v1');
  if (!v1)
    throw new DiscoveryError('server offers no knowledge-sync v1', false);
  const mcp: Record<string, McpToolUse> = {};
  // A mapping is for the endpoint it names; another endpoint's tools are not this entry's.
  if (doc.mcp && sameEndpoint(doc.mcp.endpoint, entry))
    for (const [name, use] of Object.entries(doc.mcp.capabilities))
      mcp[name] = Object.freeze({
        tool: use.tool,
        argument: use.argument,
        ...(use.fixed ? { fixed: Object.freeze({ ...use.fixed }) } : {}),
      });
  return Object.freeze({
    source: 'document',
    origin,
    syncBase: sameOrigin(v1.base_url),
    capabilities: Object.freeze([...v1.capabilities]),
    localToolsBase: sameOrigin(doc.local_tools.base_url),
    mcp: Object.freeze(mcp),
  });
}

/**
 * Reads the discovery document from the entry's origin, without credentials. A server that
 * answers 404 or 410 has none and gets the fallback; any other failure is an error, never a
 * silent fallback, so a server that does publish one is not driven at guessed paths.
 */
export async function discoverServer(
  entry: string,
  options: {
    fetcher?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
    allowHttp?: boolean;
  } = {},
): Promise<ServerDiscovery> {
  const allowHttp = options.allowHttp ?? false;
  const origin = safeServerUrl(entry, allowHttp).origin;
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(options.timeoutMs ?? 15000),
  ]);
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(origin + DISCOVERY_PATH, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal,
    });
  } catch {
    options.signal?.throwIfAborted();
    throw new DiscoveryError('discovery document unavailable', true);
  }
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    return fallbackDiscovery(entry, allowHttp);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new DiscoveryError(
      `discovery document unavailable (HTTP ${response.status})`,
      response.status >= 500 || response.status === 429,
    );
  }
  if (Number(response.headers.get('content-length')) > DISCOVERY_BYTES) {
    await response.body?.cancel();
    throw new DiscoveryError('discovery document too large', false);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > DISCOVERY_BYTES)
          throw new DiscoveryError('discovery document too large', false);
        chunks.push(part.value);
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof DiscoveryError) throw error;
      throw new DiscoveryError('discovery document unavailable', true);
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  if (
    !/^application\/(?:[\w.+-]+\+)?json(?:;|$)/i.test(
      response.headers.get('content-type') ?? '',
    )
  )
    throw new DiscoveryError('discovery document is not JSON', false);
  let value: unknown;
  try {
    value = parseStrictJson(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        Buffer.concat(chunks),
      ),
    );
  } catch {
    throw new DiscoveryError('discovery document is not JSON', false);
  }
  return parseDiscovery(value, entry, allowHttp);
}

/**
 * The tool call that serves a declared MCP operation: the argument member holds the caller's
 * members and the server's fixed ones, and a fixed member always wins.
 */
export function mcpOperation(
  discovery: Pick<ServerDiscovery, 'mcp'>,
  capability: string,
  members: Record<string, unknown>,
): { tool: string; args: Record<string, unknown> } | null {
  const use = discovery.mcp[capability];
  if (!use) return null;
  return {
    tool: use.tool,
    args: { [use.argument]: { ...members, ...(use.fixed ?? {}) } },
  };
}
