/**
 * The request shapes a connection to a URL can speak. `responses` is OpenAI's Responses API
 * (`/responses`): the same keys, base URL and `/models` list as `openai`, a different
 * request and stream.
 */
export const PROTOCOLS = ['openai', 'anthropic', 'responses'] as const;
/**
 * A ChatGPT plan, signed in with ChatGPT: the Responses API at `api.openai.com/v1` with an
 * OAuth access token and the plan route's request rules. Chosen as a provider, never as
 * the kind of API behind a typed URL.
 */
export const CHATGPT_PROTOCOL = 'chatgpt';
export type Protocol = (typeof PROTOCOLS)[number] | typeof CHATGPT_PROTOCOL;
export function isProtocol(value: unknown): value is Protocol {
  return (
    (PROTOCOLS as readonly unknown[]).includes(value) ||
    value === CHATGPT_PROTOCOL
  );
}
/** The API family that owns the keys, model list, base URL rules and model profiles. */
export function apiFamily(protocol: string): 'openai' | 'anthropic' {
  return protocol === 'anthropic' ? 'anthropic' : 'openai';
}
/** Requests in the Responses API's shape. */
export function speaksResponses(protocol: string): boolean {
  return protocol === 'responses' || protocol === CHATGPT_PROTOCOL;
}
