// knowledgeTokens follows Circle Hub hub/records/space-index.ts; normalization is for search only.
import { wellFormedText } from './unicode.js';
export const MAX_INDEX_BYTES = 1024 * 1024;
/** Adjacent Unicode letters/numbers in each word; an isolated character retains its own token. */
export function knowledgeTokens(
  text: string,
  byteLimit = MAX_INDEX_BYTES,
): string[] {
  const out = new Set<string>();
  let bytes = 64;
  const add = (token: string) => {
    if (out.has(token)) return;
    bytes += Buffer.byteLength(token) + 4;
    if (bytes > byteLimit) throw new RangeError('knowledge search index limit');
    out.add(token);
  };
  for (const word of text
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}_]+/gu) ?? []) {
    let previous: string | undefined,
      paired = false;
    for (const char of word) {
      if (previous !== undefined) {
        add(previous + char);
        paired = true;
      }
      previous = char;
    }
    if (!paired) add(word);
  }
  return [...out].sort();
}
// FTS never receives user syntax or punctuation: every token is an ASCII hex term.
export const indexTerms = (tokens: string[]): string =>
  tokens.map((token) => 't' + Buffer.from(token).toString('hex')).join(' ');
export function searchExpression(query: string): string | null {
  if (!wellFormedText(query) || Buffer.byteLength(query) > 4096)
    throw new RangeError('knowledge query limit');
  const tokens = knowledgeTokens(query, 16_384);
  return tokens.length ? indexTerms(tokens).split(' ').join(' AND ') : null;
}
