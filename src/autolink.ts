// Fullwidth forms and CJK punctuation. GFM autolinks stop at ASCII punctuation
// and then keep going through these, so `http://127.0.0.1:7410，用户` becomes
// one link. An autolink stops at the first of these.
const FULLWIDTH_PUNCTUATION =
  /[\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]/;

/** Split a visible autolink at fullwidth punctuation. `rest` is what follows. */
export function splitAutolink(shown: string): { url: string; rest: string } {
  if (!/^(?:https?:\/\/|www\.)/i.test(shown)) return { url: shown, rest: '' };
  const at = shown.search(FULLWIDTH_PUNCTUATION);
  if (at <= 0) return { url: shown, rest: '' };
  return { url: shown.slice(0, at), rest: shown.slice(at) };
}
