/** Editable MCP argv text is data, never a shell program. Double quoted words use
 * JSON escaping so that the text produced here has a lossless inverse. Ordinary
 * and single quoted CLI words remain accepted for existing hand-written entries. */
export function formatMcpArguments(args: readonly string[]): string {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
    throw Error('MCP arguments must be strings');
  return args.map((arg) => JSON.stringify(arg)).join(' ');
}

export function parseMcpArguments(input: string): string[] {
  const value = input.trim();
  if (!value) return [];
  // A JSON array is also convenient when pasting argv from a tool configuration.
  if (value.startsWith('[')) {
    let args: unknown;
    try {
      args = JSON.parse(value);
    } catch {
      throw Error('invalid MCP arguments JSON array');
    }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
      throw Error('MCP arguments JSON array must contain only strings');
    return args;
  }
  const args: string[] = [];
  let word = '',
    started = false,
    cursor = 0;
  while (cursor < value.length) {
    const char = value[cursor]!;
    if (/\s/.test(char)) {
      if (started) {
        args.push(word);
        word = '';
        started = false;
      }
      cursor++;
      continue;
    }
    started = true;
    if (char === '"') {
      const start = cursor++;
      let closed = false;
      while (cursor < value.length) {
        if (value[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (value[cursor++] === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) throw Error('unterminated double quote in MCP arguments');
      try {
        word += JSON.parse(value.slice(start, cursor)) as string;
      } catch {
        throw Error('invalid escape in MCP argument; use JSON string escaping');
      }
    } else if (char === "'") {
      const end = value.indexOf("'", cursor + 1);
      if (end < 0) throw Error('unterminated single quote in MCP arguments');
      word += value.slice(cursor + 1, end);
      cursor = end + 1;
    } else if (
      char === '\\' &&
      cursor + 1 < value.length &&
      /[\s'"\\]/.test(value[cursor + 1]!)
    ) {
      word += value[cursor + 1];
      cursor += 2;
    } else {
      word += char;
      cursor++;
    }
  }
  if (started) args.push(word);
  return args;
}
