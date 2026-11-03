import { SYNC_PROTOCOL, validateAnswer } from './protocol.js';
import { parseStrictJson } from './strict-json.js';
import { sha256 } from './canonical.js';
import { wellFormedText } from './unicode.js';
import {
  DiscoveryError,
  fallbackDiscovery,
  safeServerUrl,
  SYNC_V1_TEMPLATE_PREFIX,
  type ServerDiscovery,
} from '../server_resolution.js';

/** JCS request identity, deliberately without editable-object text normalization. */
export function requestJson(value: unknown, depth = 0): string {
  if (depth > 64) throw Error('sync request depth');
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return '[' + value.map((v) => requestJson(v, depth + 1)).join(',') + ']';
  if (
    value &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ':' +
            requestJson((value as Record<string, unknown>)[k], depth + 1),
        )
        .join(',') +
      '}'
    );
  throw Error('invalid sync request');
}
export const operationDigest = (
  route: string,
  session: string | null,
  body: unknown,
): string =>
  sha256(
    requestJson(
      session === null
        ? {
            path: SYNC_PROTOCOL.routes[route]!.path,
            ...(route === 'mode' ? { request: body } : { batch: body }),
          }
        : route === 'upload'
          ? { path: SYNC_PROTOCOL.routes[route]!.path, session, batch: body }
          : { path: SYNC_PROTOCOL.routes[route]!.path, session, request: body },
    ),
  );
/** Where the account holder confirms a purge the server would not run on a token alone. */
export interface PurgeConfirmation {
  url: string;
  expiresAt: string;
}
export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly state?: unknown,
    readonly retryAfterSeconds = 0,
    /** The server's own text for people (capability `error-detail`), shown as it came. */
    readonly detail?: string,
    readonly confirmation?: PurgeConfirmation,
  ) {
    super(`knowledge sync request failed: ${code}`);
  }
  /** A code this client has no handling for: a generic failure of that one request. */
  get unknownCode(): boolean {
    return !SYNC_PROTOCOL.codes.includes(this.code);
  }
}
/** Server text for people: one bounded, well-formed string, or nothing. */
export function serverDetail(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 2000 &&
    wellFormedText(value)
    ? value
    : undefined;
}
function confirmationOf(value: unknown): PurgeConfirmation | undefined {
  const v = value as { url?: unknown; expires_at?: unknown } | undefined;
  if (
    !v ||
    typeof v.url !== 'string' ||
    typeof v.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(v.expires_at))
  )
    return undefined;
  try {
    const url = new URL(v.url);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return undefined;
    return { url: url.href, expiresAt: v.expires_at };
  } catch {
    return undefined;
  }
}
export interface SyncTransport {
  request<T>(
    route: string,
    options: {
      id?: string;
      query?: Record<string, string>;
      body?: unknown;
      schema?: string;
      signal: AbortSignal;
    },
  ): Promise<T>;
}
export class SyncHttp implements SyncTransport {
  readonly origin: string;
  private resolved?: ServerDiscovery;
  private resolving?: Promise<ServerDiscovery>;
  /**
   * `discover` finds the sync base: the bound server's discovery document. Without it the
   * fixed v1 paths under the server's base are used, as for a server that has none.
   */
  constructor(
    readonly server: string,
    private readonly token: (signal: AbortSignal) => Promise<string>,
    private readonly fetcher: typeof fetch = fetch,
    private readonly discover?: (
      signal: AbortSignal,
    ) => Promise<ServerDiscovery>,
  ) {
    try {
      this.origin = safeServerUrl(server).origin;
    } catch {
      throw Error(
        'sync requires HTTPS or loopback HTTP without URL credentials',
      );
    }
    if (!discover) this.resolved = fallbackDiscovery(server);
  }
  /** What the server said of itself, once it was read. */
  get discovery(): ServerDiscovery | undefined {
    return this.resolved;
  }
  async resolve(signal: AbortSignal): Promise<ServerDiscovery> {
    if (this.resolved) return this.resolved;
    this.resolving ??= this.discover!(signal).finally(() => {
      this.resolving = undefined;
    });
    try {
      this.resolved = await this.resolving;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof DiscoveryError && error.retryable)
        throw new SyncHttpError(
          0,
          'SOURCE_RETRYABLE',
          undefined,
          0,
          error.message,
        );
      throw new TypeError(
        error instanceof Error ? error.message : 'discovery document invalid',
      );
    }
    return this.resolved;
  }
  async request<T>(
    route: string,
    options: {
      id?: string;
      query?: Record<string, string>;
      body?: unknown;
      schema?: string;
      signal: AbortSignal;
    },
  ): Promise<T> {
    const def = SYNC_PROTOCOL.routes[route];
    if (!def) throw Error('unknown sync route');
    if (options.id !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(options.id))
      throw Error('invalid sync route identity');
    if (!def.path.startsWith(SYNC_V1_TEMPLATE_PREFIX + '/'))
      throw Error('unknown sync route template');
    const discovery = await this.resolve(options.signal);
    // The template stays fixed relative to the base the server named (section 2).
    const url = new URL(
      discovery.syncBase +
        def.path
          .slice(SYNC_V1_TEMPLATE_PREFIX.length)
          .replace('{id}', options.id ?? ''),
    );
    if (url.origin !== this.origin) throw Error('sync base changed origin');
    for (const [k, v] of Object.entries(options.query ?? {}))
      url.searchParams.set(k, v);
    const bearer = await this.token(options.signal);
    options.signal.throwIfAborted();
    if (!bearer || /[\r\n]/.test(bearer))
      throw Error('sync bearer unavailable');
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: def.method,
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: 'application/json',
          'cache-control': 'no-store',
          ...(options.body === undefined
            ? {}
            : { 'content-type': 'application/json' }),
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: options.signal,
      });
    } catch {
      options.signal.throwIfAborted();
      throw new SyncHttpError(0, 'SOURCE_RETRYABLE');
    }
    // Bound streamed bytes, not just an untrusted Content-Length header.
    const maximum = 16 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > maximum) {
      await response.body?.cancel();
      throw new RangeError('sync response byte limit');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (!response.body) throw new TypeError('sync response missing');
    const reader = response.body.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > maximum) throw new RangeError('sync response byte limit');
        chunks.push(part.value);
      }
    } catch (error) {
      options.signal.throwIfAborted();
      if (error instanceof RangeError) throw error;
      throw new SyncHttpError(0, 'SOURCE_RETRYABLE');
    } finally {
      await reader.cancel().catch(() => {});
    }
    let value: unknown;
    try {
      value = parseStrictJson(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          Buffer.concat(chunks),
        ),
      );
    } catch {
      throw new TypeError('invalid sync JSON response');
    }
    if (!response.ok) {
      // An error from a newer server may carry members and codes this client does not know.
      validateAnswer('personal-sync-error@1', value);
      const error = value as {
        code: string;
        state?: unknown;
        retry_after_seconds?: number;
        detail?: unknown;
        confirmation?: unknown;
      };
      const header = response.headers.get('retry-after');
      const seconds = header
        ? /^\d+$/.test(header)
          ? Number(header)
          : Math.max(0, Math.ceil((Date.parse(header) - Date.now()) / 1000))
        : 0;
      throw new SyncHttpError(
        response.status,
        error.code,
        error.state,
        Math.max(
          error.retry_after_seconds ?? 0,
          Number.isFinite(seconds) ? seconds : 0,
        ),
        serverDetail(error.detail),
        error.code === 'SYNC_PURGE_CONFIRMATION_REQUIRED'
          ? confirmationOf(error.confirmation)
          : undefined,
      );
    }
    if (
      !/^application\/json(?:;|$)/i.test(
        response.headers.get('content-type') ?? '',
      )
    )
      throw new TypeError('invalid sync response media type');
    if (options.schema) validateAnswer(options.schema, value);
    return value as T;
  }
}
