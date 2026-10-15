/** A title is one short phrase. Longer text is the model answering the user. */
export const TITLE_MAX_WORDS = 10;
export const TITLE_MAX_CHARS = 60;

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

/**
 * The title call must not look like a user turn. glm-5.3 otherwise answers the
 * prompt ("I don't see any README.md… Could you paste") instead of naming it.
 */
export function titleConversation(text: string): string {
  return `<conversation>\n${text.slice(0, 2000)}\n</conversation>`;
}

/**
 * The model talking to the person, rather than naming the topic. "Fix your
 * login page" stays: "your" in a task is not the assistant asking for more.
 */
function assistantVoice(title: string): boolean {
  if (
    /^(?:i(?=\s|'|’)|i'm\b|i've\b|i'll\b|i'd\b|i am\b|we(?=\s|'|’)|we're\b|let me\b|sorry\b|unable\b|you(?=\s|'|’)|could you\b|can you\b|would you\b)/i.test(
      title,
    )
  )
    return true;
  if (
    /\b(?:could you|can you|would you|let me|i don't|i do not|i can't|i cannot|i'm\b|i am\b)\b/i.test(
      title,
    )
  )
    return true;
  if (/\byour\s+(?:message|question|request|prompt|text)\b/i.test(title))
    return true;
  return /^(?:我|你|您|抱歉|对不起|无法)/.test(title);
}

/** `README.md` is one token. `Login bug. Write tests` is two sentences. */
function manySentences(title: string): boolean {
  const masked = title
    .replace(/\b\d+(?:\.\d+)+\b/g, '0')
    .replace(/\b(?:[A-Za-z]\.){2,}/g, 'A')
    .replace(/\b[\w-]+\.[A-Za-z0-9]{1,8}\b/g, 'file');
  const parts = masked
    .split(/[.!?。！？]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 1;
}

/** Keep a model title only when it is one short phrase and not a reply. */
export function sanitizeGeneratedTitle(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((row) => row.trim())
    .find(Boolean);
  if (!line) return undefined;
  let title = line.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '').trim();
  if (/[?？]\s*$/.test(title) || /<\/?conversation\b/i.test(title))
    return undefined;
  title = title.replace(/[。．.]+$/g, '').trim();
  if (
    !title ||
    /^\d+$/.test(title) ||
    /^(?:i cannot|i can't|sorry|unable)\b/i.test(title) ||
    assistantVoice(title) ||
    manySentences(title) ||
    title.split(/\s+/).length > TITLE_MAX_WORDS ||
    title.length > TITLE_MAX_CHARS
  )
    return undefined;
  return title;
}
