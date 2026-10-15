/** Room for a short title when a gateway still spends some of the cap thinking. */
export const TITLE_MAX_TOKENS = 512;

/**
 * A title is one short topic. Longer text is the model answering the user.
 * English stops at six words. Chinese stops at twelve characters. Sixty
 * characters is the hard ceiling either way.
 */
export const TITLE_MAX_WORDS = 6;
export const TITLE_MAX_CJK = 12;
export const TITLE_MAX_CHARS = 60;

/** A fragment from an older build can be longer than a topic title. */
const STALE_TITLE_WORDS = 10;
const STALE_TITLE_CHARS = 60;

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
 * A side request is worth it at three units, counted together. Each CJK
 * character is one unit and each other word is one: "what is TCP" is three,
 * "解释 React hooks" and "什么是 Rust" are four. A greeting or acknowledgement
 * such as "hi", "thanks", or "你好" stays as typed, and so does a prompt of
 * two units or fewer ("hi there").
 */
export function titleWorthy(text: string): boolean {
  const { line } = counted(text);
  if (!line || isAck(line)) return false;
  return titleUnits(line) >= 3;
}

/**
 * Why this prompt does not get a title request. `prompt too short` stays
 * quiet: the caller logs it only when debugging. Any other reason is shown
 * as `title failed · <reason>`. Undefined means the request should be sent.
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
  // A title may start with 你 or 我 ("你好世界", "我的 Go 程序"). Only the
  // phrases an assistant uses when it answers instead of naming.
  return /我无法|我不能|请提供|请你提供|你可以|您可以|对不起|抱歉/.test(title);
}

/**
 * "Creating hello.txt" reads as work already under way. A rejected tool call
 * must not be titled as if it finished.
 */
const READS_AS_DONE =
  /^(?:creating|writing|debugging|refactoring|implementing|adding|fixing|building|generating|analyzing|analysing|making|updating|editing|deleting|removing|installing)\b|^(?:created|wrote|added|fixed|built|generated|implemented|refactored|updated|deleted|removed|installed)\b|^(?:setting up)\b|^(?:正在|已经|已完成|已创建|已写)/i;

/**
 * "hello.txt creation request" stays. A bare topic with "request" stuck on
 * ("尾递归解释请求", "Rate limiting request") does not.
 */
const ACTION_REQUEST =
  /\b(?:creation|create|write|edit|delete|fix|implement|add|update|refactor|remove)\s+request$/i;
const ACTION_REQUEST_CJK =
  /(?:创建|编写|写入|修改|删除|修复|实现|新增|添加)请求$/;

function cjkCount(text: string): number {
  return text.match(CJK_CHAR)?.length ?? 0;
}

function stripAsides(title: string): string {
  return title
    .replace(/\s*[（(][^）)]*[）)]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimTemplatedRequest(title: string): string {
  if (ACTION_REQUEST.test(title) || ACTION_REQUEST_CJK.test(title))
    return title;
  return title.replace(/(?:\s+request|请求)$/i, '').trim();
}

function overTitleCap(title: string): boolean {
  if (cjkCount(title) > TITLE_MAX_CJK || title.length > TITLE_MAX_CHARS)
    return true;
  const words = title.split(/\s+/).filter(Boolean);
  if (cjkCount(title) === 0) return words.length > TITLE_MAX_WORDS;
  const latin = words.filter((word) => word.replace(CJK_CHAR, '').length > 0);
  return latin.length > TITLE_MAX_WORDS;
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
  title = trimTemplatedRequest(
    stripAsides(title.replace(/[。．.]+$/g, '').trim()),
  );
  if (
    !title ||
    /[()（）]/.test(title) ||
    /^\d+$/.test(title) ||
    /^(?:i cannot|i can't|sorry|unable)\b/i.test(title) ||
    assistantVoice(title) ||
    manySentences(title) ||
    READS_AS_DONE.test(title) ||
    overTitleCap(title)
  )
    return undefined;
  return title;
}

/**
 * Letters and digits only, so "What is TCP?" and "what is TCP" are the same
 * title. A noun phrase such as "TCP overview" is not.
 */
function foldTitle(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The candidate is the prompt, or its short typed title, with only case or
 * punctuation changed.
 */
export function echoesPrompt(title: string, prompt: string): boolean {
  const folded = foldTitle(title);
  if (!folded) return false;
  if (folded === foldTitle(prompt)) return true;
  const fallback = foldTitle(fallbackTitle(prompt));
  return Boolean(fallback) && folded === fallback;
}

/**
 * The second title request. The first reply restated the user's words.
 */
export function titleRetrySystem(system: string): string {
  return `${system}\n\nThe previous title only changed capitalization or punctuation. That is not a title. Reply with a short noun phrase for the topic, such as "TCP overview". Do not repeat the user's sentence.`;
}

/**
 * What the model returned, or why it is not a title. A number fragment is its
 * own reason: the fallback already has the full number. A case or punctuation
 * copy of the prompt is `echoes prompt`: the caller retries once, then keeps
 * the short title.
 */
export function acceptGeneratedTitle(
  content: string,
  prompt: string,
): { title?: string; reason: string } {
  const title = sanitizeGeneratedTitle(content);
  const cleaned = content
    .split('\n')
    .map((row) => row.trim())
    .find(Boolean)
    ?.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '')
    .replace(/[。．.]+$/g, '')
    .trim();
  const fragment = (title ?? cleaned ?? '').trim();
  if (
    fragment &&
    isNumberFragment(fragment, prompt) &&
    fragment.length <= TITLE_MAX_CHARS &&
    fragment.split(/\s+/).length <= TITLE_MAX_WORDS
  )
    return { reason: 'number fragment' };
  if (fragment && echoesPrompt(fragment, prompt))
    return { reason: 'echoes prompt' };
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
    line.length <= STALE_TITLE_CHARS &&
    line.split(/\s+/).length <= STALE_TITLE_WORDS &&
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
    line.length <= STALE_TITLE_CHARS &&
    line.split(/\s+/).length <= STALE_TITLE_WORDS
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

function templatedRequest(title: string): boolean {
  if (ACTION_REQUEST.test(title) || ACTION_REQUEST_CJK.test(title))
    return false;
  return /(?:请求|\srequest)$/i.test(title);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Drop a leading please / 请 so a stored cut can match the saved prompt. */
function leadStripped(text: string): string {
  let line = foldTitle(text);
  for (let pass = 0; pass < 3; pass++) {
    const next = line.replace(LATIN, '').trim();
    if (!next || next === line) break;
    line = next;
  }
  return line.replace(CJK_LEAD, '').trim() || line;
}

/** Long enough to be a cut of a sentence, not a one-word greeting. */
function substantialCut(text: string): boolean {
  return text.split(' ').length >= 2 || cjkCount(text) >= 4 || text.length >= 8;
}

/**
 * `left` is a strict prefix of `right`: a long cut, or a short stub of a
 * prompt that is worth titling.
 */
function prefixCut(left: string, right: string, worthy: boolean): boolean {
  if (!left || !right || left.length >= right.length || !right.startsWith(left))
    return false;
  return substantialCut(left) || worthy;
}

/**
 * The title is the start of a longer prompt, including a cut that lands inside
 * a word (`hiFib demo` from `hiFib demonstration…`, or the first words of a
 * sentence). Compared after case and punctuation are folded, and again with a
 * leading please / 请 removed. The other way counts when the prompt is a real
 * sentence and the title continues it inside a word (`…in two` stored as
 * `…in twosentences`). `hi` inside `higher order functions` does not: `hi` is
 * not that sentence.
 */
function fragmentOf(title: string, prompt: string): boolean {
  const worthy = titleWorthy(prompt);
  const pairs = [
    [oneLine(title), oneLine(prompt)],
    [foldTitle(title), foldTitle(prompt)],
    [leadStripped(title), leadStripped(prompt)],
  ];
  for (const [left, right] of pairs) {
    if (prefixCut(left, right, worthy)) return true;
    if (
      substantialCut(right) &&
      left.length > right.length &&
      left.startsWith(right) &&
      !left.slice(right.length).startsWith(' ')
    )
      return true;
  }
  return false;
}

/**
 * `hi` + `Fib demo` stored as `hiFib demo`: the first message is glued to
 * more text at a capital letter, whether or not a later message still has
 * that tail.
 */
function gluedExtension(title: string, first: string): boolean {
  const line = oneLine(title);
  const head = oneLine(first);
  if (!head || line.length <= head.length) return false;
  if (line.slice(0, head.length).toLowerCase() !== head.toLowerCase())
    return false;
  const prev = line[head.length - 1] ?? '';
  const next = line[head.length] ?? '';
  return /[\p{Ll}\p{N}]/u.test(prev) && /\p{Lu}/u.test(next);
}

/**
 * The title is several user messages stuck together, in order, from the first.
 * A title that is only the first message is not one of these.
 */
function gluedTitle(title: string, parts: string[]): boolean {
  if (parts.length < 2) return false;
  const first = parts[0]!;
  let tight = first;
  let spaced = first;
  for (let index = 1; index < parts.length; index++) {
    const part = parts[index]!;
    tight += part;
    spaced = `${spaced} ${part}`;
    if (title === tight || title === spaced) return true;
    const folded = foldTitle(title);
    const foldedTight = foldTitle(tight);
    const foldedSpaced = foldTitle(spaced);
    if (
      folded &&
      ((foldedTight &&
        (folded === foldedTight || foldedTight.startsWith(folded))) ||
        (foldedSpaced &&
          (folded === foldedSpaced || foldedSpaced.startsWith(folded)))) &&
      folded.length > foldTitle(first).length
    )
      return true;
    if (title.length <= first.length || !title.startsWith(first)) continue;
    if (fragmentOf(title, tight) || fragmentOf(title, spaced)) return true;
  }
  return false;
}

/**
 * Ask again for a title that is still the trimmed first message, a prefix or
 * cut of that message, several user messages stuck together, or a line that
 * reads as work already done. A greeting as short as the message is left
 * alone. The caller leaves a name the person chose alone. `later` is the
 * user's following messages, one each.
 */
export function titleNeedsRefresh(
  title: string,
  source: string,
  later: readonly string[] = [],
): boolean {
  const line = oneLine(title);
  const prompts = [source, ...later].map(oneLine).filter(Boolean);
  const prompt = prompts[0] ?? '';
  if (!line || !prompt) return false;
  // `hiFib demo` is `hi` glued to a later turn. A cut such as
  // `please explain to me briefly in two` still matches once case,
  // punctuation, and a leading please are folded away.
  if (gluedExtension(line, prompt) || fragmentOf(line, prompt)) return true;
  const joined = prompts.join(' ');
  if (!titleWorthy(prompt) && !(prompts.length > 1 && titleWorthy(joined)))
    return false;
  if (titleWorthy(prompt)) {
    if (line === fallbackTitle(prompt)) return true;
    if (/[()（）]/.test(line) || line.includes('@')) return true;
    if (READS_AS_DONE.test(line) || /(?:…|\.\.\.)$/.test(line)) return true;
    if (templatedRequest(line)) return true;
    if (fragmentOf(line, prompt)) return true;
  }
  return prompts.length > 1 && gluedTitle(line, prompts);
}

type StoredUser = {
  role: string;
  content?: string;
  display?: string;
  internal?: string;
};

/**
 * What the person wrote, one line per message. When the shown line is a cut of
 * the stored prompt, the stored prompt is kept: a title such as
 * `please explain to me briefly in two` is that cut.
 */
export function userPrompts(messages: StoredUser[]): string[] {
  const prompts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user' || message.internal) continue;
    const content = oneLine(message.content ?? '');
    const display = oneLine(message.display ?? '');
    let text = display || content;
    if (content && display && content !== display) {
      const longer = content.length >= display.length ? content : display;
      const shorter = longer === content ? display : content;
      text =
        content.startsWith(display) ||
        display.startsWith(content) ||
        fragmentOf(shorter, longer)
          ? longer
          : display;
    } else text = content || display;
    if (text) prompts.push(text);
  }
  return prompts;
}

/** The first thing the person wrote, which a stale title is rebuilt from. */
export function firstUserSource(messages: StoredUser[]): string {
  return userPrompts(messages)[0] ?? '';
}
