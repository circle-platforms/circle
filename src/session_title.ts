const LATIN =
  /^(?:please|pls|plz|can you|could you|would you|i need you to|i want you to|i(?:'|’)d like you to|help me(?: to)?)\s*/i;
const CJK_LEAD = /^(?:帮我|请你|请|麻烦你|麻烦)\s*/;

/**
 * A side request is worth it once the prompt is a sentence. Four words covers
 * a short question such as "README.md what is this". A long line with fewer
 * words, including CJK without spaces, still qualifies. A greeting such as
 * "hi" stays on the fallback.
 */
export function titleWorthy(text: string): boolean {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return false;
  if (line.split(' ').length >= 4) return true;
  return line.length >= 24;
}

/** A title for the sidebar when the model has not named the session yet. */
export function fallbackTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  // The sidebar shows this before the model answers. Drop the @ sigil and
  // keep the filename, so the placeholder does not flash as @README.md.
  const bare = line
    .replace(/(^|\s)@+(?=\S)/g, '$1')
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
  if (cjk >= 4) return title.slice(0, 22);
  const words = title.split(' ').slice(0, 7).join(' ');
  const cut = words.length <= 42 ? words : title.slice(0, 42);
  return cut.replace(/[,:;，、]\s*$/, '').trim() || title.slice(0, 42);
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
  if (!title || /^(?:i cannot|i can't|sorry|unable)\b/i.test(title))
    return undefined;
  if (title.length <= 50) return title;
  const sliced = title.slice(0, 50);
  const cjk = title.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  if (cjk >= 4) return sliced.trim();
  const boundary = sliced.lastIndexOf(' ');
  return (boundary > 20 ? sliced.slice(0, boundary) : sliced).trim();
}
