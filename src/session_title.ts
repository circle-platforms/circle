/** A title for the sidebar when the model has not named the session yet. */
export function fallbackTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  const stripped = line
    .replace(
      /^(?:please|pls|plz|can you|could you|would you|帮我|请你|请|麻烦你|麻烦)\s*/i,
      '',
    )
    .trim();
  const title = stripped || line;
  if (title.length <= 42) return title;
  const sentence = title.split(/[。！？.!?]/)[0]!.trim();
  if (sentence.length >= 8 && sentence.length <= 42) return sentence;
  const cjk = title.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  if (cjk >= 4) return title.slice(0, 22);
  const words = title.split(' ').slice(0, 7).join(' ');
  const cut = words.length <= 42 ? words : title.slice(0, 42);
  return cut.replace(/[,:;，、]\s*$/, '').trim() || title.slice(0, 42);
}

function thinkPattern(): RegExp {
  return /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
}
/** A line of chain-of-thought, not a title. GLM often puts the title on the last line. */
const REASONING_LINE =
  /^(?:the user (?:wants|asked|is asking|message|said)\b|i (?:need|should|will|think)\b|i['’]m\b|let me\b|let's\b|first[, ]|looking at\b|we need\b|用户(?:想|希望|要求|问)|我(?:需要|先|来)|首先|让我)/i;

function cleanTitleLine(line: string): string | undefined {
  let title = line
    .replace(/^["'“”‘’«»*]+|["'“”‘’«»*]+$/g, '')
    .replace(/^(?:title|标题)\s*[:：]\s*/i, '')
    .trim();
  title = title.replace(/^["'“”‘’«»*]+|["'“”‘’«»*]+$/g, '').trim();
  title = title.replace(/[。．.]+$/g, '').trim();
  if (!title || title.length > 50) return undefined;
  if (/^(?:i cannot|i can't|sorry|unable)\b/i.test(title)) return undefined;
  if (REASONING_LINE.test(title)) return undefined;
  if (/[,:;，、：]$/.test(title)) return undefined;
  return title;
}
function lastAcceptedLine(text: string): string | undefined {
  const lines = text
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const title = cleanTitleLine(line);
    if (title) return title;
    const sentences = line.split(/(?<=[。！？.!?])\s+/).filter(Boolean);
    for (let s = sentences.length - 1; s >= 0; s--) {
      const fromSentence = cleanTitleLine(sentences[s]!);
      if (fromSentence) return fromSentence;
    }
  }
  return undefined;
}

/** Keep a model title only when it is one short line and not a refusal. */
export function sanitizeGeneratedTitle(text: string): string | undefined {
  const line = text
    .replace(thinkPattern(), '\n')
    .split('\n')
    .map((row) => row.trim())
    .find(Boolean);
  if (!line) return undefined;
  let title = line.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '').trim();
  title = title.replace(/^(?:title|标题)\s*[:：]\s*/i, '').trim();
  title = title.replace(/[。．.]+$/g, '').trim();
  if (!title || /^(?:i cannot|i can't|sorry|unable)\b/i.test(title))
    return undefined;
  if (REASONING_LINE.test(title)) return undefined;
  if (title.length <= 50) return title;
  const sliced = title.slice(0, 50);
  const cjk = title.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  if (cjk >= 4) return sliced.trim();
  const boundary = sliced.lastIndexOf(' ');
  return (boundary > 20 ? sliced.slice(0, boundary) : sliced).trim();
}

/**
 * The title a side request actually returned. A visible line wins. GLM-5.3 often
 * finishes a short call with a thinking block and no text block, or wraps the
 * title in `<think>` and leaves the text empty; the title is the last short line.
 */
export function titleFromModelReply(
  content: string,
  thinking = '',
): string | undefined {
  const visible = sanitizeGeneratedTitle(content);
  if (visible) return visible;
  const buried = [...content.matchAll(thinkPattern())]
    .map((match) => match[1] ?? '')
    .join('\n');
  return lastAcceptedLine(buried) ?? lastAcceptedLine(thinking);
}
