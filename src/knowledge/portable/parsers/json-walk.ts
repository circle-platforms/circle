import { wellFormedText } from '../../unicode.js';
// Adapted from Circle Hub (Apache-2.0); see provenance.json.
// Iterative checks on a parsed JSON value: depth and value-count limits, and text that can be stored: U+0000 is removed
// from strings and unpaired surrogates (from escapes such as \ud83d) are replaced by U+FFFD; member names with either are
// refused, since changing a name could merge two members.
import {
  ParseEncodingError,
  ParseSyntaxError,
  depthError,
  nodesError,
  type JsonValue,
} from '../parser.js';

export interface JsonShape {
  /** The value with every string cleaned (containers are cleaned in place). */
  value: unknown;
  /** Nesting depth of arrays and objects; a scalar or a flat container has depth 1. */
  depth: number;
  values: number;
  nulRemoved: number;
  /** Unpaired surrogates replaced by U+FFFD. */
  surrogatesReplaced: number;
}

export function isPlainObject(
  value: unknown,
): value is { [key: string]: unknown } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** UTF-16 index hinted by a V8 JSON.parse error message ("at position N"), or null. */
export function jsonErrorIndex(error: unknown): number | null {
  const match =
    error instanceof Error ? /at position (\d+)/.exec(error.message) : null;
  return match ? Number(match[1]!) : null;
}

function surrogates(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) count++;
  }
  return count;
}

/** Walks the value without recursion and cleans its strings. Throws the parser's typed errors. */
export function inspectJson(
  parser: string,
  root: unknown,
  maxDepth: number,
  maxValues: number,
): JsonShape {
  let nulRemoved = 0;
  let surrogatesReplaced = 0;
  const clean = (text: string): string => {
    let out = text;
    if (out.includes('\u0000')) {
      const stripped = out.replaceAll('\u0000', '');
      nulRemoved += out.length - stripped.length;
      out = stripped;
    }
    if (!wellFormedText(out)) {
      surrogatesReplaced += surrogates(out);
      out = (out as string & { toWellFormed(): string }).toWellFormed();
    }
    return out;
  };
  const needsCleaning = (text: string): boolean =>
    text.includes('\u0000') || !wellFormedText(text);
  if (root === null || typeof root !== 'object') {
    return {
      value: typeof root === 'string' ? clean(root) : root,
      depth: 1,
      values: 1,
      nulRemoved,
      surrogatesReplaced,
    };
  }
  const stack: Array<[object, number]> = [[root, 1]];
  let depth = 0;
  let values = 0;
  while (stack.length > 0) {
    const [value, level] = stack.pop()!;
    values++;
    if (level > maxDepth) throw depthError(parser, maxDepth);
    if (level > depth) depth = level;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item: unknown = value[i]!;
        if (item !== null && typeof item === 'object')
          stack.push([item, level + 1]);
        else {
          values++;
          if (typeof item === 'string' && needsCleaning(item))
            value[i]! = clean(item);
        }
      }
    } else {
      const record = value as { [key: string]: unknown };
      for (const key of Object.keys(record)) {
        if (key.includes('\u0000'))
          throw new ParseSyntaxError(
            parser,
            'JSON 成员名里含有 NUL 字符，无法保存',
          );
        if (!wellFormedText(key))
          throw new ParseEncodingError(
            parser,
            'JSON 成员名里有不成对的代理字符（如 \\ud83d 转义），不是有效的文字',
          );
        const item = record[key]!;
        if (item !== null && typeof item === 'object')
          stack.push([item, level + 1]);
        else {
          values++;
          if (typeof item === 'string' && needsCleaning(item))
            record[key]! = clean(item);
        }
      }
    }
    if (values + stack.length > maxValues) throw nodesError(parser, maxValues);
  }
  return { value: root, depth, values, nulRemoved, surrogatesReplaced };
}

/** Text of a JSON value as a fragment: strings as they are, everything else as compact JSON. */
export function jsonText(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** RFC 8259 type name of a value. */
export function jsonType(value: JsonValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
