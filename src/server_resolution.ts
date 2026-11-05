import { parseStrictJson } from './knowledge/strict-json.js';
import { validateAnswer } from './knowledge/protocol.js';

export const SYNC_V1_TEMPLATE_PREFIX = '/api/sync/v1';
export const DISCOVERY_PATH = '/.well-known/knowledge-sync';
const DISCOVERY_BYTES = 64 * 1024;

export interface McpToolUse {
  tool: string;
  argument: string;
  fixed?: Record<string, string | boolean>;
}
export interface ProtectedResourceMetadata {
  resource: string;
  resourceMetadata: string | null;
  bearerMethodsSupported: string[] | null;
}
export interface ServerDiscovery {
  source: 'document' | 'fallback';
  origin: string;
  syncBase: string;
  capabilities: readonly string[];
  localToolsBase: string;
  mcp: Readonly<Record<string, McpToolUse>>;
  authorization?: ProtectedResourceMetadata;
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
export function serverBaseUrl(url: string): string {
  const trimmed = trimSlashes(url.trim());
  return trimmed.endsWith('/mcp') ? trimmed.slice(0, -4) : trimmed;
}
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
    authorization?: {
      resource: string;
      resource_metadata?: string | null;
      resourceMetadata?: string | null;
      bearer_methods_supported?: string[] | null;
      bearerMethodsSupported?: string[] | null;
    };
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
  if (doc.mcp && sameEndpoint(doc.mcp.endpoint, entry))
    for (const [name, use] of Object.entries(doc.mcp.capabilities))
      mcp[name] = Object.freeze({
        tool: use.tool,
        argument: use.argument,
        ...(use.fixed ? { fixed: Object.freeze({ ...use.fixed }) } : {}),
      });
  const metaUrl =
    doc.authorization?.resource_metadata ??
    doc.authorization?.resourceMetadata ??
    null;
  const methods =
    doc.authorization?.bearer_methods_supported ??
    doc.authorization?.bearerMethodsSupported ??
    null;
  return Object.freeze({
    source: 'document',
    origin,
    syncBase: sameOrigin(v1.base_url),
    capabilities: Object.freeze([...v1.capabilities]),
    localToolsBase: sameOrigin(doc.local_tools.base_url),
    mcp: Object.freeze(mcp),
    ...(doc.authorization
      ? {
          authorization: Object.freeze({
            resource: sameOrigin(doc.authorization.resource),
            resourceMetadata: metaUrl ? sameOrigin(metaUrl) : null,
            bearerMethodsSupported: methods ? [...methods] : null,
          }),
        }
      : {}),
  });
}

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
