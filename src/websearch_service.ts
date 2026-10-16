import { createHash } from 'node:crypto';
import { isNetworkFailure, networkError, networkErrorReason } from './net.js';
import { webSearch, type FetchFunction } from './websearch.js';
import {
  nativeWebSearch,
  nativeSearchCapability,
  NativeSearchUnsupported,
  type NativeSearchConnection,
  type NativeSearchResult,
  type NativeSearchUsage,
} from './native_websearch.js';

interface Capability {
  supported?: boolean;
  expires: number;
  cooldown: number;
  reason?: string;
  checking?: Promise<void>;
}
export interface SearchOptions {
  request?: FetchFunction;
  now?: () => number;
  /** Injectable budgets keep deadline tests deterministic and fast. */
  totalTimeout?: number;
  nativeTimeout?: number;
}
function aborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', cancel));
  });
}
function connectionKey(connection: NativeSearchConnection): string {
  const url = new URL(connection.baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, '');
  return createHash('sha256')
    .update(
      JSON.stringify([
        url.href,
        connection.protocol,
        connection.model,
        connection.apiKey,
      ]),
    )
    .digest('hex');
}
function diagnostic(
  error: unknown,
  connection: NativeSearchConnection,
  query: string,
): string {
  // Provider errors can echo their input, including a raw key or query outside a URL.
  const detail = networkErrorReason(error);
  const host = new URL(connection.baseUrl).host;
  // A 429 from the provider's search, including Zhipu code 1113, is a quota.
  // The raw body is not something a person can act on.
  const quota = /\bnative search http 429\b|\b1113\b/.test(detail);
  let message = quota
    ? 'search quota exceeded'
    : isNetworkFailure(error)
      ? networkError(error, connection.baseUrl).message
      : /\bhttp \d{3}\b/i.test(detail)
        ? `HTTP failure on ${host}: ${detail}`
        : `native search on ${host}: ${detail}`;
  for (const value of [connection.apiKey, query].filter(Boolean))
    message = message.replaceAll(value, '[redacted]');
  return message;
}
function resultText(
  result: NativeSearchResult,
  query: string,
  limit: number,
): string {
  const lines = [
    `Web search results for ${JSON.stringify(query)}:`,
    `Provider: ${result.provider}`,
    '',
  ];
  if (result.summary?.trim()) lines.push(result.summary.trim(), '');
  if (!result.results.length) lines.push('No results.');
  for (const [index, item] of result.results.slice(0, limit).entries()) {
    lines.push(`${index + 1}. ${item.title || item.url}`, `   ${item.url}`);
    if (item.snippet) lines.push(`   ${item.snippet}`);
    lines.push('');
  }
  // Bound what the model reads even if a provider ignores a requested result limit.
  return lines.join('\n').trimEnd().slice(0, 60000);
}
/** Runtime-owned state: never persists capabilities, queries or credentials. */
export class WebSearchService {
  private readonly capabilities = new Map<string, Capability>();
  private readonly now: () => number;
  constructor(private readonly options: SearchOptions = {}) {
    this.now = options.now ?? Date.now;
  }
  async search(
    connection: NativeSearchConnection | undefined,
    query: string,
    numResults: number,
    signal: AbortSignal,
    onUsage?: (call: NativeSearchUsage) => void,
  ): Promise<string> {
    signal.throwIfAborted();
    const text = query.trim();
    if (!text) throw new Error('query is required');
    const limit = Math.max(1, Math.min(10, Math.floor(numResults) || 5));
    const total = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.options.totalTimeout ?? 60000),
    ]);
    const request = this.options.request ?? fetch;
    let reason = '';
    if (connection) {
      const key = connectionKey(connection);
      let state = this.capabilities.get(key);
      if (!state) {
        // Connection/model churn must not retain credentials' fingerprints indefinitely.
        if (this.capabilities.size >= 128)
          this.capabilities.delete(this.capabilities.keys().next().value!);
        state = { expires: 0, cooldown: 0 };
        this.capabilities.set(key, state);
      }
      try {
        if (state.checking) await aborted(state.checking, total);
        total.throwIfAborted();
        if (state.expires <= this.now()) state.supported = undefined;
        if (state.supported === false || state.cooldown > this.now()) {
          reason = state.reason || 'native search unavailable';
        } else {
          let release: (() => void) | undefined;
          // Serialize the initial unknown capability check, not searches after validation.
          if (state.supported === undefined)
            state.checking = new Promise<void>((resolve) => {
              release = resolve;
            });
          const nativeSignal = AbortSignal.any([
            total,
            AbortSignal.timeout(this.options.nativeTimeout ?? 30000),
          ]);
          try {
            if (state.supported === undefined) {
              const hint = await nativeSearchCapability(
                connection,
                nativeSignal,
                request,
              );
              if (hint === 'unsupported')
                throw new NativeSearchUnsupported(
                  'native search is not supported by this model',
                );
            }
            const result = await nativeWebSearch(
              connection,
              text,
              limit,
              nativeSignal,
              request,
              onUsage,
            );
            nativeSignal.throwIfAborted();
            if (!result.executed)
              throw new Error('the endpoint did not execute native search');
            state.supported = true;
            state.expires = this.now() + 600000;
            state.cooldown = 0;
            state.reason = undefined;
            return resultText(result, text, limit);
          } catch (error) {
            total.throwIfAborted();
            const failure = nativeSignal.aborted ? nativeSignal.reason : error;
            reason = diagnostic(failure, connection, text);
            state.reason = reason;
            if (failure instanceof NativeSearchUnsupported) {
              state.supported = false;
              state.expires = this.now() + 600000;
            } else state.cooldown = this.now() + 30000;
          } finally {
            if (release) {
              state.checking = undefined;
              release();
            }
          }
        }
      } catch (error) {
        signal.throwIfAborted();
        throw error;
      }
    }
    try {
      const result = await webSearch(text, total, limit, request);
      return `Provider: DuckDuckGo${reason ? `\nNative search unavailable: ${reason}` : ''}\n\n${result}`;
    } catch (error) {
      signal.throwIfAborted();
      let fallback = networkErrorReason(
        new Error(error instanceof Error ? error.message : String(error)),
      );
      for (const value of [connection?.apiKey, text].filter(
        (item): item is string => Boolean(item),
      ))
        fallback = fallback.replaceAll(value, '[redacted]');
      throw new Error(
        reason ? `native search: ${reason}; ${fallback}` : fallback,
        { cause: error },
      );
    }
  }
}
