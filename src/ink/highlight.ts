import { palette, sgrJoin } from './theme.js';

export type HighlightKind =
  'plain' | 'comment' | 'string' | 'number' | 'keyword';
export interface HighlightToken {
  kind: HighlightKind;
  text: string;
}

const WORDS: Record<string, string[]> = {
  js: [
    'const',
    'let',
    'var',
    'function',
    'return',
    'if',
    'else',
    'for',
    'while',
    'class',
    'new',
    'import',
    'export',
    'from',
    'async',
    'await',
    'try',
    'catch',
    'throw',
    'typeof',
    'of',
    'in',
    'break',
    'continue',
    'switch',
    'case',
    'default',
    'true',
    'false',
    'null',
    'undefined',
  ],
  py: [
    'def',
    'return',
    'if',
    'elif',
    'else',
    'for',
    'while',
    'class',
    'import',
    'from',
    'as',
    'try',
    'except',
    'raise',
    'with',
    'yield',
    'lambda',
    'pass',
    'break',
    'continue',
    'True',
    'False',
    'None',
    'and',
    'or',
    'not',
    'in',
    'is',
  ],
  sh: [
    'if',
    'then',
    'else',
    'fi',
    'for',
    'in',
    'do',
    'done',
    'while',
    'case',
    'esac',
    'function',
    'return',
    'echo',
    'exit',
  ],
  go: [
    'func',
    'return',
    'if',
    'else',
    'for',
    'range',
    'package',
    'import',
    'var',
    'const',
    'type',
    'struct',
    'interface',
    'go',
    'defer',
    'select',
    'case',
    'switch',
    'break',
    'continue',
    'nil',
    'true',
    'false',
  ],
  rust: [
    'fn',
    'let',
    'mut',
    'return',
    'if',
    'else',
    'for',
    'while',
    'loop',
    'match',
    'struct',
    'enum',
    'impl',
    'use',
    'pub',
    'mod',
    'async',
    'await',
    'true',
    'false',
  ],
};

const BUILTINS: Record<string, string[]> = {
  js: [
    'console',
    'Math',
    'JSON',
    'parseInt',
    'parseFloat',
    'Number',
    'String',
    'Boolean',
    'Array',
    'Object',
    'Date',
    'Map',
    'Set',
    'Promise',
    'setTimeout',
    'document',
  ],
  py: [
    'print',
    'len',
    'range',
    'str',
    'int',
    'list',
    'dict',
    'set',
    'tuple',
    'open',
    'isinstance',
    'enumerate',
    'zip',
    'map',
    'filter',
    'sum',
    'min',
    'max',
    'abs',
  ],
  sh: ['cd', 'export', 'set', 'unset', 'source', 'printf'],
  go: ['println', 'print', 'make', 'len', 'cap', 'append', 'panic'],
  rust: ['println', 'print', 'vec', 'format', 'Some', 'None', 'Ok', 'Err'],
};

const ALIAS: Record<string, keyof typeof WORDS> = {
  js: 'js',
  javascript: 'js',
  jsx: 'js',
  ts: 'js',
  tsx: 'js',
  typescript: 'js',
  mjs: 'js',
  cjs: 'js',
  py: 'py',
  python: 'py',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  shell: 'sh',
  go: 'go',
  golang: 'go',
  rs: 'rust',
  rust: 'rust',
};

/** Which keyword list a fence language uses, if this highlighter knows it. */
export function highlightLanguage(language: string): string | undefined {
  const name = language.trim().toLowerCase().split(/\s+/)[0] ?? '';
  return ALIAS[name];
}

/** One line of source, split into the kinds a terminal can colour. */
export function highlightTokens(
  language: string,
  line: string,
): HighlightToken[] {
  const family = highlightLanguage(language);
  if (!family) return [{ kind: 'plain', text: line }];
  const words = new Set(WORDS[family]);
  const tokens: HighlightToken[] = [];
  const push = (kind: HighlightKind, text: string): void => {
    if (text) tokens.push({ kind, text });
  };
  let index = 0;
  const hash = family === 'py' || family === 'sh';
  while (index < line.length) {
    const rest = line.slice(index);
    if (rest.startsWith('//') && family !== 'py' && family !== 'sh') {
      push('comment', rest);
      break;
    }
    if (hash && rest.startsWith('#')) {
      push('comment', rest);
      break;
    }
    const quote = /^(['"`])(?:\\.|(?!\1)[\s\S])*\1?/.exec(rest);
    if (quote) {
      push('string', quote[0]);
      index += quote[0].length;
      continue;
    }
    const number = /^\b\d[\d_]*(?:\.[\d_]+)?\b/.exec(rest);
    if (number) {
      push('number', number[0]);
      index += number[0].length;
      continue;
    }
    const word = /^\b[A-Za-z_][A-Za-z0-9_]*\b/.exec(rest);
    if (word) {
      const call = /^\s*\(/.test(rest.slice(word[0].length));
      const builtin = (BUILTINS[family] ?? []).includes(word[0]);
      push(
        words.has(word[0]) || call || builtin ? 'keyword' : 'plain',
        word[0],
      );
      index += word[0].length;
      continue;
    }
    push('plain', rest[0]!);
    index += 1;
  }
  return tokens;
}

/** The same line with palette colours. Call it while painting: colours follow the theme. */
export function highlightLine(language: string, line: string): string {
  const p = palette();
  const color: Record<HighlightKind, string> = {
    plain: '',
    comment: p.dim,
    string: p.green,
    number: p.yellow,
    keyword: p.blue,
  };
  let out = '';
  let style = '';
  for (const token of highlightTokens(language, line)) {
    const next = color[token.kind];
    if (next !== style) {
      style = next;
      out += p.reset + p.panel_bg + p.text + (style ? sgrJoin(style) : '');
    }
    out += token.text;
  }
  return out;
}
