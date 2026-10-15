/** Room for a short title when a gateway still spends some of the cap thinking. */
export const TITLE_MAX_TOKENS = 512;

/** A title is one short phrase. Longer text is the model answering the user. */
export const TITLE_MAX_WORDS = 10;
export const TITLE_MAX_CHARS = 60;

const CJK_CHAR = /[\u3400-\u9fff]/g;

/**
 * The whole prompt is a greeting or an acknowledgement, not a question.
 * "what is TCP" is not one of these. Trailing punctuation is ignored.
 */
const ACK =
  /^(?:hi|hello|hey|yo|hiya|howdy|ok|okay|k|thanks|thank you|thx|ty|thanks a lot|thank you so much|thanks so much|thank you very much|thanks very much|cheers|bye|goodbye|good morning|good afternoon|good evening|good night|you'?re welcome|no problem|got it|noted|你好|你好啊|你好呀|您好|您好啊|嗨|嗨啊|谢谢|谢谢啊|谢谢啦|感谢|多谢|谢谢你|好的|好的呀|嗯|哦|收到|收到啦)$/i;

function counted(text: string): { line: string; cjk: number; words: number } {
  const line = text.replace(/\s+/g, ' ').trim();
  const cjk = line.match(CJK_CHAR)?.length ?? 0;
  const rest = line.replace(CJK_CHAR, ' ').replace(/\s+/g, ' ').trim();
  return { line, cjk, words: rest ? rest.split(' ').length : 0 };
}

function isAck(line: string): boolean {
  return ACK.test(line.replace(/[.!?。！？~…]+$/u, '').trim());
}

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
 * How many words a line is. Each CJK character counts as one: a sentence such
 * as "请用大约200字介绍一下罗马帝国的兴衰" has no spaces, so a whitespace count
 * sees one word and used to skip the title request.
 */
export function titleUnits(text: string): number {
  const { line, cjk, words } = counted(text);
  if (!line) return 0;
  return cjk + words;
}

/**
 * A side request is worth it at three combined units. Each CJK character is
 * one unit and each other word is one, so "解释 React hooks" and "what is
 * TCP" both ask. Two units stay as typed ("hi there"). A greeting or
 * acknowledgement stays as typed even at three units ("你好啊", "thanks").
 */
export function titleWorthy(text: string): boolean {
  const { line } = counted(text);
  if (!line || isAck(line)) return false;
  return titleUnits(line) >= 3;
}

/**
 * Why this prompt does not get a title request. Callers show it as
 * `title failed · <reason>`. Undefined means the request should be sent.
 */
export function titleSkipReason(
  prompt: string,
  sideRequests: boolean | undefined,
): string | undefined {
  if (!titleWorthy(prompt)) return 'prompt too short';
  if (!sideRequests) return 'model has no side request';
  return undefined;
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
 * `stricter` is the one retry after a title that only repeated the question.
 * The reminder stays outside `<conversation>` so it is an instruction, not data.
 */
export function titleConversation(text: string, stricter = false): string {
  const body = `<conversation>\n${text.slice(0, 2000)}\n</conversation>`;
  if (!stricter) return body;
  return `${body}\nDo not return the question itself, even re-cased, with a question mark, or with the words reordered. Reply with a short noun phrase such as "TCP overview" or "Rust intro".`;
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
  // A title may start with 你 or 我 ("你好世界", "我的 Go 程序"). Only the
  // phrases an assistant uses when it answers instead of naming.
  return /我无法|我不能|请提供|请你提供|你可以|您可以|对不起|抱歉/.test(title);
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

const QUESTION_WORD = /^(?:what|how|why|when|where|who|which)\b/;
const CJK_QUESTION = /什么|为何|为什么|怎么|如何|哪/;

function stripPunct(text: string): string {
  return text.replace(/[\p{P}\p{S}]/gu, '');
}

/** Case, spacing, and punctuation folded so "What is TCP?" matches "what is TCP". */
function foldedTitle(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u3000\u00a0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function compactTitle(text: string): string {
  return stripPunct(foldedTitle(text)).replace(/\s+/g, '');
}

/** Latin words stay whole. Each Han character is its own token. */
function titleTokens(text: string): string[] {
  const plain = foldedTitle(text).replace(/[\p{P}\p{S}]/gu, ' ');
  return [...plain.matchAll(/[a-z0-9]+|[\u3400-\u9fff]/g)].map(
    (match) => match[0],
  );
}

function sameTokens(left: string[], right: string[]): boolean {
  if (left.length === 0 || left.length !== right.length) return false;
  const count = new Map<string, number>();
  for (const token of left) count.set(token, (count.get(token) ?? 0) + 1);
  for (const token of right) {
    const n = count.get(token);
    if (!n) return false;
    if (n === 1) count.delete(token);
    else count.set(token, n - 1);
  }
  return count.size === 0;
}

/**
 * A question, so a reordering of its words is still the question
 * ("what is TCP" → "TCP what is"). "解释 React hooks" is not one: a reordered
 * noun phrase such as "React hooks 解释" is a real title.
 */
function questionShaped(prompt: string): boolean {
  const line = foldedTitle(prompt);
  if (!line) return false;
  if (/[?？]\s*$/.test(line)) return true;
  if (QUESTION_WORD.test(line)) return true;
  return CJK_QUESTION.test(line);
}

/**
 * The candidate is the prompt again: only case, spacing, punctuation, or a
 * reordering of a question. "TCP overview" is not an echo of "what is TCP".
 */
export function echoesPrompt(title: string, prompt: string): boolean {
  const left = compactTitle(title);
  const right = compactTitle(prompt);
  if (!left || !right) return false;
  if (left === right) return true;
  if (!questionShaped(prompt)) return false;
  return sameTokens(titleTokens(title), titleTokens(prompt));
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

/**
 * What the model returned, or why it is not a title. A number fragment is its
 * own reason: the fallback already has the full number.
 */
export function acceptGeneratedTitle(
  content: string,
  prompt: string,
): { title?: string; reason: string } {
  const line = content
    .split('\n')
    .map((row) => row.trim())
    .find(Boolean)
    ?.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '')
    .trim();
  // Before the trailing-"?" rule, so "what is TCP?" is an echo, not "not a title".
  if (line && echoesPrompt(line, prompt)) return { reason: 'echoes prompt' };
  const title = sanitizeGeneratedTitle(content);
  const cleaned = line?.replace(/[。．.]+$/g, '').trim();
  const fragment = (title ?? cleaned ?? '').trim();
  if (
    fragment &&
    isNumberFragment(fragment, prompt) &&
    fragment.length <= TITLE_MAX_CHARS &&
    fragment.split(/\s+/).length <= TITLE_MAX_WORDS
  )
    return { reason: 'number fragment' };
  if (!title) return { reason: content.trim() ? 'not a title' : 'empty title' };
  return { title, reason: '' };
}

const REASONING_TITLE =
  /^the user (?:is|wants|asked|has)\b|\bgenerate a title\b/i;

/** Cheap filter before reading a session's messages. */
export function mightBeStaleTitle(title: string): boolean {
  const line = title.trim();
  if (!line) return false;
  if (REASONING_TITLE.test(line) || /^\d+$/.test(line)) return true;
  return (
    line.length <= TITLE_MAX_CHARS &&
    line.split(/\s+/).length <= TITLE_MAX_WORDS &&
    /\d/.test(line)
  );
}

/**
 * A title saved by an older build: reasoning text, or a bare number such as
 * `150`. The caller replaces it with `fallbackTitle` of the first message.
 */
export function staleGeneratedTitle(title: string, source: string): boolean {
  const line = title.trim();
  if (!line) return false;
  if (REASONING_TITLE.test(line) || /^\d+$/.test(line)) return true;
  return (
    isNumberFragment(line, source) &&
    line.length <= TITLE_MAX_CHARS &&
    line.split(/\s+/).length <= TITLE_MAX_WORDS
  );
}

/** The fallback to store, when `title` is reasoning text or a number fragment. */
export function repairedTitle(
  title: string,
  source: string,
): string | undefined {
  if (!staleGeneratedTitle(title, source)) return undefined;
  const next = fallbackTitle(source);
  return next && next !== title.trim() ? next : undefined;
}

/** The first thing the person wrote, which a stale title is rebuilt from. */
export function firstUserSource(
  messages: {
    role: string;
    content?: string;
    display?: string;
    internal?: string;
  }[],
): string {
  const message = messages.find(
    (item) => item.role === 'user' && !item.internal,
  );
  return (message?.display || message?.content || '').trim();
}
