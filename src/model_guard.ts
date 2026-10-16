import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { ModelRequest, ModelResponse, ModelNotice } from './types.js';
import { RepetitionMonitor } from './text_repetition.js';
import { isRecord } from './settings.js';
import { isCertificateError } from './net.js';
export type RetryKind =
  'rate_limit' | 'server' | 'network' | 'timeout' | 'inband';
export interface RetryBudget {
  maxRetries: number;
  /** No retry starts this long after the first request; 0 for no such limit. */
  deadlineMs: number;
  initialMs: number;
  capMs: number;
  jitter: number;
}
export const BUDGETS: Record<RetryKind, RetryBudget> = {
  rate_limit: {
    maxRetries: 5,
    deadlineMs: 600000,
    initialMs: 2000,
    capMs: 120000,
    jitter: 0.1,
  },
  server: {
    maxRetries: 6,
    deadlineMs: 300000,
    initialMs: 2000,
    capMs: 30000,
    jitter: 0.1,
  },
  network: {
    maxRetries: 6,
    deadlineMs: 300000,
    initialMs: 3000,
    capMs: 30000,
    jitter: 0,
  },
  // A slow endpoint, not a broken one: up to 10 tries however long each takes, and each
  // waits longer for the answer to start and for content (TIMEOUT_GROWTH)
  timeout: {
    maxRetries: 10,
    deadlineMs: 0,
    initialMs: 2000,
    capMs: 30000,
    jitter: 0.1,
  },
  inband: {
    maxRetries: 3,
    deadlineMs: 120000,
    initialMs: 2000,
    capMs: 30000,
    jitter: 0.1,
  },
};
export function envFlag(name: string): boolean {
  return !['0', 'false', 'off', 'no'].includes(
    (process.env[name] || '1').trim().toLowerCase(),
  );
}
/** The request and stall timeouts grow this many times at most over the timeout retries. */
export const TIMEOUT_GROWTH = 8;
/** A model request that ran out of retries: the last error, and how many were made. */
export class RetriesExhausted extends Error {
  constructor(
    readonly last: unknown,
    readonly retries: number,
  ) {
    super(
      `${last instanceof Error ? last.message : String(last)} (gave up after ${retries} ${retries === 1 ? 'retry' : 'retries'})`,
      { cause: last },
    );
    this.name = 'RetriesExhausted';
  }
}
export class StreamStalled extends Error {
  constructor(milliseconds: number) {
    super(`no content from the model for ${Math.round(milliseconds / 1000)}s`);
    this.name = 'StreamStalled';
  }
}
export class TextRepetitionLoop extends Error {
  constructor(
    readonly period: number,
    readonly answered: boolean,
  ) {
    super(`model output is looping on a ${period}-token block`);
    this.name = 'TextRepetitionLoop';
  }
}
export class MissingFinish extends Error {
  constructor(
    readonly partial: ModelResponse,
    readonly output: boolean,
  ) {
    super('model stream ended without a finish signal');
    this.name = 'MissingFinish';
  }
}
function record(error: unknown): Record<string, unknown> {
  return error !== null && typeof error === 'object'
    ? (error as Record<string, unknown>)
    : {};
}
function statusOf(error: unknown): number | undefined {
  const item = record(error);
  const value = item.status ?? item.status_code;
  return typeof value === 'number' ? value : undefined;
}
/** The HTTP status an error carries, or the first one in its causes. */
export function httpStatus(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  for (
    let current = error;
    current && !seen.has(current);
    current = record(current).cause
  ) {
    seen.add(current);
    const status = statusOf(current);
    if (status !== undefined) return status;
  }
  return undefined;
}
function bodies(error: unknown): Record<string, unknown>[] {
  const item = record(error);
  const result: Record<string, unknown>[] = [item];
  for (const root of ['error', 'body'])
    if (isRecord(item[root])) {
      const value = item[root];
      result.push(value);
      if (isRecord(value.error)) result.push(value.error);
    }
  return result;
}
// The SDKs' errors keep the name `Error`: their class is in the constructor's name
const TIMEOUT_NAMES =
  /^(?:APIConnectionTimeoutError|APITimeoutError|TimeoutError|ConnectTimeout|ReadTimeout|WriteTimeout|PoolTimeout|TimeoutException|ConnectTimeoutError|HeadersTimeoutError|BodyTimeoutError)$/;
const TIMEOUT_CODES = [
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
];
const NETWORK_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
];
function tlsFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (
    let current: unknown = error;
    current && !seen.has(current);
    current = record(current).cause
  ) {
    seen.add(current);
    if (/^ERR_(?:SSL|TLS)_/.test(String(record(current).code ?? '')))
      return true;
  }
  return false;
}
export function errorKind(error: unknown): RetryKind | undefined {
  if (error instanceof StreamStalled) return 'timeout';
  if (error instanceof TextRepetitionLoop || error instanceof MissingFinish)
    return undefined;
  // A certificate the system does not trust, or TLS spoken to a plain HTTP port, fails the
  // same way every time
  if (isCertificateError(error) || tlsFailure(error)) return undefined;
  const status = statusOf(error);
  const codes = bodies(error)
    .flatMap((item) => [item.code, item.type])
    .filter((value) => typeof value === 'string')
    .map((value) => String(value).toLowerCase());
  if (
    status === 402 ||
    codes.some((code) =>
      [
        'insufficient_quota',
        'quota_exceeded',
        'billing',
        'credit_balance',
      ].some((quota) => code.includes(quota)),
    )
  )
    return undefined;
  if (status === 429) return 'rate_limit';
  // 524 is Cloudflare's: the origin took too long
  if (status === 408 || status === 504 || status === 524) return 'timeout';
  if (status === 409 || (status !== undefined && status >= 500))
    return 'server';
  if (status === 400 && codes.includes('bad_response_status_code'))
    return 'server';
  if (status !== undefined && status !== 200) return undefined;
  // The error and its causes: a timeout anywhere in them makes it one
  const chain: { names: string[]; code: string }[] = [];
  const seen = new Set<unknown>();
  for (
    let current: unknown = error;
    current && !seen.has(current);
    current = record(current).cause
  ) {
    seen.add(current);
    const item = record(current);
    chain.push({
      names: [
        String(item.name ?? ''),
        String((current as object).constructor?.name ?? ''),
      ],
      code: String(item.code ?? ''),
    });
  }
  if (
    chain.some(
      (item) =>
        item.names.some((name) => TIMEOUT_NAMES.test(name)) ||
        TIMEOUT_CODES.includes(item.code),
    )
  )
    return 'timeout';
  if (
    chain.some(
      (item) =>
        item.names.includes('APIConnectionError') ||
        NETWORK_CODES.includes(item.code),
    )
  )
    return 'network';
  if (
    chain[0]?.names.includes('APIError') &&
    (status === undefined || status === 200)
  )
    return 'inband';
  return undefined;
}
export function retryAfterMs(
  error: unknown,
  now = Date.now(),
): number | undefined {
  const item = record(error);
  const headers = item.headers ?? record(item.response).headers;
  const get = (name: string): string | undefined => {
    if (headers instanceof Headers) return headers.get(name) ?? undefined;
    if (isRecord(headers)) {
      const value = headers[name] ?? headers[name.toLowerCase()];
      return value === undefined ? undefined : String(value);
    }
    return undefined;
  };
  const ms = get('retry-after-ms');
  if (ms !== undefined && Number.isFinite(Number(ms)))
    return Math.max(100, Number(ms));
  const raw = get('retry-after');
  if (raw !== undefined) {
    if (Number.isFinite(Number(raw))) return Math.max(100, Number(raw) * 1000);
    const date = Date.parse(raw);
    if (Number.isFinite(date) && date > now) return Math.max(100, date - now);
  }
  const match = String(item.message || error).match(
    /(?:try again|retry(?:ing)?)(?: in| after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?)/i,
  );
  if (!match) return undefined;
  const unit = match[2]!.toLowerCase();
  return Math.max(
    100,
    Number(match[1]) *
      (unit === 'ms' || unit.startsWith('milli')
        ? 1
        : unit === 'm' || unit.startsWith('minute')
          ? 60000
          : 1000),
  );
}
export function backoffMs(
  kind: RetryKind,
  attempt: number,
  error?: unknown,
  random = Math.random,
  budgets = BUDGETS,
): number {
  const budget = budgets[kind];
  const hinted = retryAfterMs(error);
  if (hinted !== undefined) return Math.min(budget.capMs, hinted);
  const base = Math.min(
    budget.capMs,
    budget.initialMs * 2 ** Math.max(0, attempt),
  );
  return Math.max(
    100,
    Math.min(budget.capMs, base * (1 + (random() * 2 - 1) * budget.jitter)),
  );
}
/** A rejected historical block is not an unsupported thinking setting. */
export function isThinkingSignatureError(error: unknown): boolean {
  if (statusOf(error) !== 400) return false;
  const text = String(record(error).message || error);
  return /invalid\s+[`'"]?signature[`'"]?\s+in\s+[`'"]?(?:redacted_)?thinking[`'"]?\s+block/i.test(
    text,
  );
}
export function rejectedParameters(error: unknown): string[] {
  if (isThinkingSignatureError(error)) return [];
  if (![400, 422].includes(statusOf(error) ?? 0)) return [];
  const text = String(record(error).message || error).toLowerCase();
  if (
    ![
      'invalid',
      'not permitted',
      'unknown parameter',
      'unsupported',
      'unexpected',
      'allowed:',
      'unrecognized',
      'supported values',
      'not supported',
    ].some((marker) => text.includes(marker))
  )
    return [];
  const explicit = bodies(error)
    .map((item) => item.param)
    .find((value) => typeof value === 'string' && value.trim());
  const parameter =
    typeof explicit === 'string' ? explicit.trim().toLowerCase() : undefined;
  const display = /\bthinking(?:\.(?:adaptive|enabled))?\.display\b/;
  // A precise nested rejection can refine a coarse parent parameter, while an
  // explicit rejection of another field remains authoritative.
  if (
    (parameter !== undefined && display.test(parameter)) ||
    ((parameter === undefined || parameter === 'thinking') &&
      display.test(text))
  )
    return ['thinking.display'];
  if (parameter) return [parameter];
  const match = text.match(
    /\bthe\s+([a-z_][a-z0-9_.-]*)\s+(?:parameter|argument)\b/,
  );
  if (match) return [match[1]!];
  return [
    'betas',
    'anthropic-beta',
    'reasoning_effort',
    'output_config',
    'effort',
    'reasoning',
    'thinking',
    'budget_tokens',
    'stream_options',
    'parallel_tool_calls',
  ].filter((name) => text.includes(name));
}
export interface GuardOptions {
  budgets?: Record<RetryKind, RetryBudget>;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
  stallMs?: number;
}
const REPEAT_REMINDERS = [
  'You have been repeating the same text without progress. Stop and take a different approach: produce a small useful piece, call the intended tool now, or state the blocker. Do not repeat the text.',
  'You are still repeating yourself. Abandon the current plan. State what you were trying to produce and why you could not start, then do the smallest useful piece.',
];
export class ModelGuard {
  readonly downgrades = new Map<string, string>();
  constructor(
    readonly dropParameter: (parameter: string) => boolean,
    readonly options: GuardOptions = {},
  ) {}
  async execute(
    request: ModelRequest,
    handler: (request: ModelRequest) => Promise<ModelResponse>,
  ): Promise<ModelResponse> {
    const counts = new Map<RetryKind, number>();
    const now = this.options.now ?? Date.now;
    const started = now();
    const budgets = this.options.budgets ?? BUDGETS;
    let drops = 0;
    let repeats = 0;
    let current = request;
    const notice = (event: ModelNotice): void => {
      try {
        request.notice?.(event);
      } catch {
        /* A display subscriber cannot stop recovery. */
      }
    };
    while (true) {
      request.signal.throwIfAborted();
      const controller = new AbortController();
      const signal = AbortSignal.any([request.signal, controller.signal]);
      let yielded = false;
      let answered = false;
      const monitor = envFlag('CIRCLE_LLM_REPEAT_GUARD')
        ? new RepetitionMonitor()
        : undefined;
      const fromEnv =
        Number(process.env.CIRCLE_LLM_STALL_TIMEOUT || 180) * 1000;
      // A stream silent after a timeout gets longer too: a model that thinks without
      // streaming it, behind a gateway that sends keep-alives, may need it
      const stallMs =
        (this.options.stallMs ??
          (Number.isFinite(fromEnv) ? fromEnv : 180000)) *
        (current.timeoutScale ?? 1);
      let timer: NodeJS.Timeout | undefined;
      const arm = (): void => {
        if (timer) clearTimeout(timer);
        if (stallMs > 0)
          timer = setTimeout(
            () => controller.abort(new StreamStalled(stallMs)),
            stallMs,
          );
      };
      const guarded: ModelRequest = {
        ...current,
        signal,
        progress: (kind) => {
          if (kind === 'connected') {
            arm();
            current.progress?.(kind);
            return;
          }
          yielded = true;
          if (kind !== 'keepalive') {
            if (kind === 'tool' || kind === 'text') answered = true;
            arm();
          }
          current.progress?.(kind);
        },
        token: (text, thinking) => {
          yielded = true;
          if (text) {
            answered ||= !thinking;
            arm();
          }
          const period = monitor?.feed(text);
          if (period) throw new TextRepetitionLoop(period, answered);
          current.token(text, thinking);
        },
      };
      try {
        return await handler(guarded);
      } catch (original) {
        request.signal.throwIfAborted();
        const error = controller.signal.aborted
          ? controller.signal.reason
          : original;
        if (error instanceof TextRepetitionLoop) {
          if (error.answered || repeats >= 2) throw error;
          current = {
            ...current,
            messages: [
              ...current.messages,
              {
                id: randomUUID(),
                role: 'user',
                content:
                  '<system-reminder>\n' +
                  REPEAT_REMINDERS[repeats++] +
                  '\n</system-reminder>',
                internal: 'model-retry',
              },
            ],
          };
          notice({
            event: 'repeat_retry',
            attempt: repeats,
            period: error.period,
          });
          continue;
        }
        if (error instanceof MissingFinish) {
          // A completed transport with no provider finish is evidence for the
          // harness to classify, not a network retry or a successful answer.
          notice({ event: 'missing_finish', truncated: error.output });
          return error.partial;
        }
        const kind = errorKind(error);
        // A timeout or a dropped connection is sent again even after part of the answer
        // came (a proxy's own timeout drops it): nothing of that part is kept
        if (yielded && kind !== 'timeout' && kind !== 'network') throw error;
        if (!yielded && drops < 4) {
          let dropped = false;
          for (const parameter of rejectedParameters(error))
            if (this.dropParameter(parameter)) {
              drops++;
              this.downgrades.set(
                parameter,
                `rejected by the endpoint (${statusOf(error)})`,
              );
              notice({
                event: 'param_dropped',
                param: parameter,
                status: statusOf(error),
              });
              dropped = true;
              break;
            }
          if (dropped) continue;
        }
        if (!kind) throw error;
        const attempts = counts.get(kind) ?? 0;
        const budget = budgets[kind];
        if (
          attempts >= budget.maxRetries ||
          (budget.deadlineMs > 0 && now() - started >= budget.deadlineMs)
        )
          throw attempts ? new RetriesExhausted(error, attempts) : error;
        const waitMs = backoffMs(
          kind,
          attempts,
          error,
          this.options.random,
          budgets,
        );
        counts.set(kind, attempts + 1);
        // Each timeout doubles how long the next request waits for the answer to start
        if (kind === 'timeout')
          current = {
            ...current,
            timeoutScale: Math.min(TIMEOUT_GROWTH, 2 ** (attempts + 1)),
          };
        notice({
          event: 'retry',
          kind,
          attempt: attempts + 1,
          max: budget.maxRetries,
          wait_ms: waitMs,
        });
        try {
          await (
            this.options.wait ??
            (async (milliseconds, signal) => {
              await delay(milliseconds, undefined, { signal });
            })
          )(waitMs, request.signal);
        } catch (error) {
          request.signal.throwIfAborted();
          throw error;
        }
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort();
      }
    }
  }
}
