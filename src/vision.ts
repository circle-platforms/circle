import { createHash } from 'node:crypto';
import { readMedia } from './media.js';
import { isRecord, type CircleSettings } from './settings.js';
import { isNetworkFailure, networkError, networkErrorReason } from './net.js';

/** A side vision model, as an OpenAI-compatible chat/completions endpoint. */
export interface VisionConnection {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** Tokens a description call spent, for the tool result's model-call record. */
export interface VisionUsage {
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

export interface VisionOptions {
  request?: typeof fetch;
  /** Injectable so a deadline test stays deterministic and fast. */
  timeoutMs?: number;
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {};
const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : 0;

/** How many pictures one description call may carry, as one message's attachments do. */
export const MAX_VISION_IMAGES = 8;
const MAX_TOTAL_BASE64 = 28 * 1024 * 1024;
const MAX_RESPONSE_CHARS = 2 * 1024 * 1024;
const CACHE_LIMIT = 64;
const DEFAULT_QUESTION =
  'Describe this picture factually for a coding agent: what it shows, any text in it, and its layout.';

/** `CIRCLE_VISION_TIMEOUT_MS`, whole milliseconds; the default is a minute. */
export function timeoutFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.CIRCLE_VISION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1000 ? Math.round(raw) : 60000;
}

function endpoint(connection: VisionConnection): URL {
  const url = new URL(connection.baseUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('invalid vision API base URL');
  url.pathname = url.pathname.replace(/\/+$/, '') + '/chat/completions';
  return url;
}

/**
 * The side vision model one run sees pictures with: `vision` in settings.json, each field
 * overridden by `CIRCLE_VISION_BASE_URL`, `CIRCLE_VISION_MODEL` and `CIRCLE_VISION_KEY`;
 * the key itself comes from credentials.json, by `api_key_ref` (`vision_key`). All three
 * parts must be there, or pictures stay with the model's own eyes.
 */
export function visionConnection(
  settings: CircleSettings,
  credentials: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): VisionConnection | undefined {
  const saved = isRecord(settings.vision)
    ? (settings.vision as CircleSettings['vision'])
    : { base_url: '', model: '', api_key_ref: 'vision_key' };
  const baseUrl = String(env.CIRCLE_VISION_BASE_URL || saved.base_url || '')
    .trim()
    .slice(0, 4096);
  const model = String(env.CIRCLE_VISION_MODEL || saved.model || '')
    .trim()
    .slice(0, 200);
  const apiKey = String(
    env.CIRCLE_VISION_KEY ||
      credentials[String(saved.api_key_ref || 'vision_key').slice(0, 200)] ||
      '',
  ).trim();
  if (!baseUrl || !model || !apiKey) return undefined;
  return { baseUrl, model, apiKey };
}

/**
 * Describes pictures through the configured side vision model. A picture is read the way
 * an attachment is, so a large PNG is scaled down first; a description is cached by the
 * pictures and the question, and failures come back as readable, redacted errors.
 */
export class VisionService {
  private readonly cache = new Map<string, string>();
  private readonly options: VisionOptions;
  constructor(options: VisionOptions = {}) {
    this.options = options;
  }
  async describe(
    connection: VisionConnection,
    paths: string[],
    question: string,
    signal: AbortSignal,
    onUsage?: (call: VisionUsage) => void,
  ): Promise<{ model: string; text: string }> {
    signal.throwIfAborted();
    if (!paths.length) throw new Error('no picture paths given');
    if (paths.length > MAX_VISION_IMAGES)
      throw new Error(
        `at most ${MAX_VISION_IMAGES} pictures go with one description call`,
      );
    const focus = question.trim();
    const prompt =
      (paths.length > 1
        ? `Describe each of these ${paths.length} pictures in order, headed by its file name. `
        : '') +
      (focus || DEFAULT_QUESTION) +
      ' Answer with the description only.';
    const media = [];
    let size = 0;
    for (const path of paths) {
      const { attachment } = await readMedia(path, signal);
      size += attachment.data.length;
      if (size > MAX_TOTAL_BASE64)
        throw new Error(
          'these pictures together carry more encoded bytes than one description call may',
        );
      media.push(attachment);
    }
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          connection.model,
          prompt,
          ...media.map((m) => m.sha256),
        ]),
      )
      .digest('hex');
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return { model: connection.model, text: cached };
    }
    const deadline = this.options.timeoutMs ?? timeoutFromEnv(process.env);
    const total = AbortSignal.any([signal, AbortSignal.timeout(deadline)]);
    const url = endpoint(connection);
    // A stop is the caller's and keeps its reason; the deadline says how long it waited,
    // before the answer starts and while it arrives alike
    const stopped = (): void => {
      signal.throwIfAborted();
      if (total.aborted)
        throw new Error(
          `vision model ${connection.model} on ${url.host} did not answer within ${Number((deadline / 1000).toFixed(1))} s (CIRCLE_VISION_TIMEOUT_MS)`,
        );
    };
    let response: Response;
    try {
      response = await (this.options.request ?? fetch)(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${connection.apiKey}`,
        },
        body: JSON.stringify({
          model: connection.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                ...media.map((item) => ({
                  type: 'image_url',
                  image_url: {
                    url: `data:${item.mime_type};base64,${item.data}`,
                  },
                })),
              ],
            },
          ],
          max_tokens: 2048,
        }),
        signal: total,
        redirect: 'error',
      });
    } catch (error) {
      stopped();
      throw new Error(
        `vision model ${connection.model} on ${url.host}: ${
          isNetworkFailure(error)
            ? networkError(error, connection.baseUrl).message
            : networkErrorReason(error)
        }`,
        { cause: error },
      );
    }
    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      stopped();
      throw new Error(
        `vision model ${connection.model} on ${url.host}: the answer broke off: ${networkErrorReason(error)}`,
        { cause: error },
      );
    }
    if (raw.length > MAX_RESPONSE_CHARS)
      throw new Error('vision model response exceeds 2 MiB');
    if (!response.ok) {
      // An HTML error page must not become a second failure
      let body: Json = {};
      try {
        body = record(JSON.parse(raw));
      } catch {
        /* The status line below stands without the body's detail. */
      }
      const error = record(body.error);
      const detail = [
        text(error.type),
        text(error.code),
        text(error.message),
        text(body.message),
      ]
        .filter(Boolean)
        .join(': ')
        .slice(0, 1000);
      throw new Error(
        `vision model http ${response.status}${detail ? `: ${detail}` : ''}`.replaceAll(
          connection.apiKey,
          '[redacted]',
        ),
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `vision model http ${response.status}: invalid JSON response`,
      );
    }
    const choices = record(parsed).choices;
    const choice = record(Array.isArray(choices) ? choices[0] : undefined);
    const message = record(choice.message);
    const described = (
      text(message.content) || text(message.reasoning_content)
    ).trim();
    if (!described)
      throw new Error(
        `vision model ${connection.model} returned no description`,
      );
    const usage = record(record(parsed).usage);
    onUsage?.({
      model: connection.model,
      usage: {
        input_tokens: count(usage.prompt_tokens),
        output_tokens: count(usage.completion_tokens),
      },
    });
    if (this.cache.size >= CACHE_LIMIT)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, described);
    return { model: connection.model, text: described };
  }
}
