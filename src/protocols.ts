/**
 * The request shapes a connection can speak. `responses` is OpenAI's Responses API
 * (`/responses`): the same keys, base URL and `/models` list as `openai`, a different
 * request and stream.
 */
export const PROTOCOLS = ['openai', 'anthropic', 'responses'] as const;
export type Protocol = (typeof PROTOCOLS)[number];
export function isProtocol(value: unknown): value is Protocol {
  return (PROTOCOLS as readonly unknown[]).includes(value);
}
/** The API family that owns the keys, model list, base URL rules and model profiles. */
export function apiFamily(protocol: string): 'openai' | 'anthropic' {
  return protocol === 'anthropic' ? 'anthropic' : 'openai';
}
