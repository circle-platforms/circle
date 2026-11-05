export function parseStrictJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  let at = 0;
  const space = () => {
    while (at < text.length && /\s/.test(text[at] ?? '')) at++;
  };
  const string = (needKey: boolean): string => {
    const start = at++;
    for (;;) {
      const quote = text.indexOf('"', at);
      let slashes = 0;
      for (let i = quote - 1; i > start && text.charCodeAt(i) === 92; i--)
        slashes++;
      at = quote + 1;
      if (slashes % 2 === 0)
        return needKey ? (JSON.parse(text.slice(start, at)) as string) : '';
    }
  };
  const value = (depth: number): void => {
    if (depth > 1024) throw new SyntaxError('JSON nesting limit');
    space();
    const ch = text[at];
    if (ch === '"') {
      string(false);
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
        const key = string(true);
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
  return parsed;
}
