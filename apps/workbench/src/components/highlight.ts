export interface HighlightToken {
  kind: 'plain' | 'comment' | 'string' | 'number' | 'keyword';
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
    'self',
  ],
  sql: [
    'select',
    'from',
    'where',
    'and',
    'or',
    'insert',
    'into',
    'values',
    'update',
    'set',
    'delete',
    'join',
    'left',
    'right',
    'on',
    'group',
    'by',
    'order',
    'limit',
    'as',
    'create',
    'table',
  ],
  css: [
    'color',
    'background',
    'display',
    'flex',
    'grid',
    'margin',
    'padding',
    'border',
    'font',
    'width',
    'height',
  ],
  html: [
    'html',
    'head',
    'body',
    'div',
    'span',
    'script',
    'style',
    'class',
    'id',
  ],
};

const ALIAS: Record<string, string> = {
  javascript: 'js',
  jsx: 'js',
  typescript: 'js',
  ts: 'js',
  tsx: 'js',
  mjs: 'js',
  cjs: 'js',
  python: 'py',
  py: 'py',
  bash: 'sh',
  sh: 'sh',
  shell: 'sh',
  zsh: 'sh',
  json: 'js',
  go: 'go',
  golang: 'go',
  rust: 'rust',
  rs: 'rust',
  sql: 'sql',
  css: 'css',
  html: 'html',
  xml: 'html',
};

function hashComment(language: string): boolean {
  return ['py', 'sh'].includes(ALIAS[language] ?? language);
}

/** A small highlighter for fenced blocks: comments, strings, numbers and keywords. */
export function highlight(code: string, language = ''): HighlightToken[] {
  const words = new Set(WORDS[ALIAS[language.toLowerCase()] ?? ''] ?? []);
  const hash = hashComment(language.toLowerCase());
  const out: HighlightToken[] = [];
  let i = 0;
  const push = (kind: HighlightToken['kind'], text: string) => {
    if (!text) return;
    const last = out.at(-1);
    if (last?.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  while (i < code.length) {
    const rest = code.slice(i);
    if (rest.startsWith('//') && !hash) {
      const end = rest.indexOf('\n');
      const text = end < 0 ? rest : rest.slice(0, end);
      push('comment', text);
      i += text.length;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      const text = end < 0 ? rest : rest.slice(0, end + 2);
      push('comment', text);
      i += text.length;
      continue;
    }
    if (hash && rest[0] === '#' && (i === 0 || code[i - 1] === '\n')) {
      const end = rest.indexOf('\n');
      const text = end < 0 ? rest : rest.slice(0, end);
      push('comment', text);
      i += text.length;
      continue;
    }
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      let j = 1;
      while (j < rest.length) {
        if (rest[j] === '\\') {
          j += 2;
          continue;
        }
        if (rest[j] === quote) {
          j += 1;
          break;
        }
        if (rest[j] === '\n' && quote !== '`') break;
        j += 1;
      }
      push('string', rest.slice(0, j));
      i += j;
      continue;
    }
    const number = /^(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)/.exec(rest);
    if (number && (i === 0 || /[^A-Za-z0-9_$]/.test(code[i - 1] ?? ''))) {
      push('number', number[0]);
      i += number[0].length;
      continue;
    }
    const word = /^[A-Za-z_][\w$]*/.exec(rest);
    if (word) {
      push(words.has(word[0]) ? 'keyword' : 'plain', word[0]);
      i += word[0].length;
      continue;
    }
    push('plain', rest[0]!);
    i += 1;
  }
  return out;
}
