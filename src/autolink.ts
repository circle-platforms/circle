// Fullwidth punctuation and CJK letters. GFM autolinks stop at ASCII punctuation
// and then keep going through these, so `http://127.0.0.1:7410，用户` and
// `https://example.com页面` become one link. An autolink stops at the first of
// these. An opening `(` that never closes inside what remains is not part of
// the URL either: `https://example.com("Example Domain" 页面)` stops at `(`.
const STOPS_AUTOLINK =
  /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]/;

/** Index of an unmatched `(`, or -1 when every `(` in `text` has its `)`. */
function unmatchedOpen(text: string): number {
  let depth = 0;
  let open = -1;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '(') {
      if (depth === 0) open = index;
      depth++;
    } else if (char === ')' && depth > 0) {
      depth--;
      if (depth === 0) open = -1;
    }
  }
  return depth > 0 ? open : -1;
}

/** Split a visible autolink. `rest` is what follows the URL. */
export function splitAutolink(shown: string): { url: string; rest: string } {
  if (!/^(?:https?:\/\/|www\.)/i.test(shown)) return { url: shown, rest: '' };
  let end = shown.length;
  const at = shown.search(STOPS_AUTOLINK);
  if (at > 0) end = at;
  const paren = unmatchedOpen(shown.slice(0, end));
  if (paren > 0) end = paren;
  if (end >= shown.length || end <= 0) return { url: shown, rest: '' };
  return { url: shown.slice(0, end), rest: shown.slice(end) };
}
