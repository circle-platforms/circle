import { SYNC_PROTOCOL, validateSync } from './protocol.js';
import { parseStrictJson } from './strict-json.js';
import { sha256 } from './canonical.js';

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
export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly state?: unknown,
    readonly retryAfterSeconds = 0,
  ) {
    super(`knowledge sync request failed: ${code}`);
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
  constructor(
    server: string,
    private readonly token: (signal: AbortSignal) => Promise<string>,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const url = new URL(server);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
        ))
    )
      throw Error(
        'sync requires HTTPS or loopback HTTP without URL credentials',
      );
    this.origin = url.origin;
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
    const path = def.path.replace('{id}', options.id ?? '');
    const url = new URL(path, this.origin);
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
      validateSync('personal-sync-error@1', value);
      const error = value as {
        code: string;
        state?: unknown;
        retry_after_seconds?: number;
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
      );
    }
    if (
      !/^application\/json(?:;|$)/i.test(
        response.headers.get('content-type') ?? '',
      )
    )
      throw new TypeError('invalid sync response media type');
    if (options.schema) validateSync(options.schema, value);
    return value as T;
  }
}
