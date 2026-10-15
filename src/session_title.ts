const LATIN =
  /^(?:please|pls|plz|can you|could you|would you|i need you to|i want you to|i(?:'|’)d like you to|help me(?: to)?)\s*/i;
const CJK_LEAD = /^(?:帮我|请你|请|麻烦你|麻烦)\s*/;

/** A cut that does not end in the middle of `1500`. */
function cutChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  if (/\d/.test(text[end - 1] ?? '') && /\d/.test(text[end] ?? '')) {
    while (end < text.length && /\d/.test(text[end] ?? '')) end++;
  }
  return text.slice(0, end);
}

/** A title for the sidebar when the model has not named the session yet. */
export function fallbackTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  // `@README.md` points at a file. It is not the subject, short titles included.
  const bare = line
    .replace(/(^|\s)@[^\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let stripped = bare;
  for (let pass = 0; pass < 3; pass++) {
    const next = stripped.replace(LATIN, '').trim();
    if (next === stripped) break;
    stripped = next;
  }
  // One CJK prefix only: 请帮我看一下 stays 帮我看一下.
  stripped = stripped.replace(CJK_LEAD, '').trim();
  const title = stripped || bare || line;
  if (title.length <= 42) return title;
  const sentence = title.split(/[。！？.!?]/)[0]!.trim();
  if (sentence.length >= 8 && sentence.length <= 42) return sentence;
  const cjk = title.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  if (cjk >= 4) return cutChars(title, 22);
  const words = title.split(' ').slice(0, 7).join(' ');
  const cut = words.length <= 42 ? words : cutChars(title, 42);
  return cut.replace(/[,:;，、]\s*$/, '').trim() || cutChars(title, 42);
}

/**
 * `150` is not a session title, and neither is a cut of a longer number in the
 * prompt (`150` from `1500`). A pure digit string is always a fragment.
 */
export function isNumberFragment(title: string, source: string): boolean {
  const line = title.trim();
  if (!line) return false;
  if (/^\d+$/.test(line)) return true;
  for (const run of line.match(/\d+/g) ?? []) {
    if (new RegExp(`(?:^|\\D)${run}\\d`).test(source)) return true;
  }
  return false;
}

/** Keep a model title only when it is one short line and not a refusal. */
export function sanitizeGeneratedTitle(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((row) => row.trim())
    .find(Boolean);
  if (!line) return undefined;
  let title = line.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '').trim();
  title = title.replace(/[。．.]+$/g, '').trim();
  if (
    !title ||
    /^\d+$/.test(title) ||
    /^(?:i cannot|i can't|sorry|unable)\b/i.test(title)
  )
    return undefined;
  if (title.length <= 50) return title;
  const sliced = cutChars(title, 50);
  const cjk = title.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  if (cjk >= 4) return sliced.trim();
  const boundary = sliced.lastIndexOf(' ');
  return (boundary > 20 ? sliced.slice(0, boundary) : sliced).trim();
}
