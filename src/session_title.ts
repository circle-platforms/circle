/** Room for a short title when a gateway still spends some of the cap thinking. */
export const TITLE_MAX_TOKENS = 512;

/** A title is one short phrase. Longer text is the model answering the user. */
export const TITLE_MAX_WORDS = 10;
export const TITLE_MAX_CHARS = 60;

const LATIN =
  /^(?:please|pls|plz|can you|could you|would you|i need you to|i want you to|i(?:'|’)d like you to|help me(?: to)?)\s*/i;
const CJK_LEAD = /^(?:帮我|请你|请|麻烦你|麻烦)\s*/;

/**
 * Han text has no spaces, so a word count never sees it. Six characters is a
 * short sentence (罗马帝国兴衰); a greeting such as 你好 stays on the fallback.
 */
const HAN = /[\u3400-\u9fff]/g;
export const TITLE_CJK_CHARS = 6;

/**
 * A side request is worth it once the prompt is a sentence. Four words covers
 * a short question such as "README.md what is this". A line of at least
 * TITLE_CJK_CHARS Han characters does too, even under 24 characters. A long
 * line with fewer words still qualifies. A greeting such as "hi" stays on
 * the fallback.
 */
export function titleWorthy(text: string): boolean {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return false;
  if (line.split(' ').length >= 4) return true;
  if ((line.match(HAN)?.length ?? 0) >= TITLE_CJK_CHARS) return true;
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
    /^(?:i cannot|i can't|sorry|unable)\b/i.test(title) ||
    assistantVoice(title) ||
    manySentences(title) ||
    title.split(/\s+/).length > TITLE_MAX_WORDS ||
    title.length > TITLE_MAX_CHARS
  )
    return undefined;
  return title;
}
