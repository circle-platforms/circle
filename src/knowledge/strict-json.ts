// Adapted from Circle Hub contracts/src/sync-json.ts (Apache-2.0); see the pinned provenance manifest.
/** JSON.parse validates syntax; this pass additionally refuses duplicate object members. */
export function parseStrictJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  let at = 0;
  const space = () => {
    while (at < text.length && /\s/.test(text[at] ?? '')) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const ch = text[at++];
      if (ch === '\\') at++;
      else if (ch === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    throw new SyntaxError('unterminated JSON string');
  };
  const value = (depth: number): void => {
    if (depth > 1024) throw new SyntaxError('JSON nesting limit');
    space();
    const ch = text[at];
    if (ch === '"') {
      string();
      return;
    }
    if (ch === '{') {
      at++;
      space();
      const seen = new Set<string>();
      if (text[at] === '}') {
        at++;
        return;
      }
      for (;;) {
        space();
        const key = string();
        if (seen.has(key)) throw new SyntaxError('duplicate JSON member');
        seen.add(key);
        space();
        at++;
        value(depth + 1);
        space();
        if (text[at++] === '}') return;
      }
    }
    if (ch === '[') {
      at++;
      space();
      if (text[at] === ']') {
        at++;
        return;
      }
      for (;;) {
        value(depth + 1);
        space();
        if (text[at++] === ']') return;
      }
    }
    while (at < text.length && !/[\s,}\]]/.test(text[at]!)) at++;
  };
  value(0);
  space();
  if (at !== text.length) throw new SyntaxError('trailing JSON input');
  return parsed;
}
