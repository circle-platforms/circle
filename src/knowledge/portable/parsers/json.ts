// Adapted from Circle Hub (Apache-2.0); see provenance.json.
// json@1: any JSON document. Selectors: `p` (the whole value) and `p/<token>/...`, one segment per member name or array
// index (decimal, no leading zeros), as in a JSON Pointer. Member names that are empty strings cannot be addressed, and
// neither can a value whose selector would be longer than MAX_SELECTOR_LENGTH.
import {
  QUOTATION_UNITS,
  ParseSyntaxError,
  checkSize,
  effectiveLimits,
  selectorCharsError,
  type Fragment,
  type JsonValue,
  type ParsedDocument,
  type Parser,
  type ParseLimits,
  type ParseOptions,
  type QuotationSource,
  type QuotationUnit,
} from '../parser.js';
import {
  MAX_SELECTOR_LENGTH,
  selectorOf,
  selectorSegment,
  trySelectorSegments,
} from '../reference.js';
import { decodeUtf8 } from '../text-decoding.js';
import {
  inspectJson,
  isPlainObject,
  jsonErrorIndex,
  jsonText,
  jsonType,
} from './json-walk.js';

const KEY = 'json@1';
const LIMITS: Readonly<ParseLimits> = {
  maxBytes: 16 * 1024 * 1024,
  maxDepth: 128,
  maxNodes: 2_000_000,
};
const INDEX = /^(?:0|[1-9][0-9]{0,9})$/;

/** Value at a path of tokens (member names or decimal array indices), or undefined. */
export function valueAt(
  root: JsonValue,
  tokens: readonly string[],
): JsonValue | undefined {
  let current: JsonValue = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!INDEX.test(token)) return undefined;
      const index = Number(token);
      if (index >= current.length) return undefined;
      current = current[index]!;
    } else if (isPlainObject(current)) {
      if (!Object.hasOwn(current, token)) return undefined;
      current = (current as { [key: string]: JsonValue })[token]!;
    } else return undefined;
  }
  return current;
}

function parse(
  bytes: Uint8Array,
  options: ParseOptions = {},
): ParsedDocument<JsonValue> {
  const limits = effectiveLimits(LIMITS, options);
  checkSize(KEY, bytes, limits);
  const { text, offsets } = decodeUtf8(KEY, bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const index = jsonErrorIndex(error);
    throw new ParseSyntaxError(
      KEY,
      '不是有效的 JSON',
      index === null ? null : offsets.at(Math.min(index, text.length)),
      String((error as Error).message),
    );
  }
  const shape = inspectJson(KEY, parsed, limits.maxDepth, limits.maxNodes);
  const model = shape.value as JsonValue;

  // Encoded member names, once per distinct name.
  const encoded = new Map<string, string>();
  const segmentOf = (key: string): string => {
    let out = encoded.get(key);
    if (out === undefined) encoded.set(key, (out = selectorSegment(key)));
    return out;
  };
  /**
   * Visits every addressable value in document order with its selector, built from its parent's; a value whose
   * selector would be too long hides its subtree. `enter` returns false to skip a value's children.
   */
  const walk = (
    visit: (value: JsonValue, selector: string) => boolean | void,
    enter: (selector: string) => boolean = () => true,
  ): void => {
    const stack: Array<[JsonValue, string]> = [[model, 'p']];
    while (stack.length > 0) {
      const [value, selector] = stack.pop()!;
      if (visit(value, selector) === false) return;
      if (!enter(selector)) continue;
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) {
          const child = `${selector}/${i}`;
          if (child.length <= MAX_SELECTOR_LENGTH)
            stack.push([value[i]!, child]);
        }
      } else if (isPlainObject(value)) {
        const keys = Object.keys(value);
        for (let i = keys.length - 1; i >= 0; i--) {
          if (keys[i]! === '') continue;
          const child = `${selector}/${segmentOf(keys[i]!)}`;
          if (child.length <= MAX_SELECTOR_LENGTH)
            stack.push([
              (value as { [key: string]: JsonValue })[keys[i]!]!,
              child,
            ]);
        }
      }
    }
  };
  let selectorChars = 0;
  walk((_value, selector) => {
    if ((selectorChars += selector.length) > limits.maxSelectorChars)
      throw selectorCharsError(KEY, limits.maxSelectorChars);
  });

  const fragment = (selector: string, value: JsonValue): Fragment => ({
    selector,
    text: jsonText(value),
    byteRange: null,
    data: {
      type: jsonType(value),
      size: Array.isArray(value)
        ? value.length
        : isPlainObject(value)
          ? Object.keys(value).length
          : null,
    },
  });

  const document: ParsedDocument<JsonValue> & QuotationSource = {
    parser: KEY,
    model,
    locate(selector) {
      const segments = trySelectorSegments(selector);
      if (!segments || segments[0]! !== 'p') return null;
      const value = valueAt(model, segments.slice(1));
      if (value === undefined) return null;
      const canonical = selectorOf(segments);
      return canonical.length > MAX_SELECTOR_LENGTH
        ? null
        : fragment(canonical, value);
    },
    listSelectors(prefix = '', options = {}) {
      const limit = options.limit ?? Number.POSITIVE_INFINITY;
      const out: string[] = [];
      if (limit <= 0) return out;
      // Below a selector that neither starts with the prefix nor leads to it, nothing can match.
      const relevant = (selector: string): boolean =>
        prefix === '' ||
        selector.startsWith(prefix) ||
        prefix.startsWith(selector);
      walk((_value, selector) => {
        if (prefix === '' || selector.startsWith(prefix)) out.push(selector);
        return out.length < limit;
      }, relevant);
      return out;
    },
    summary() {
      return {
        parser: KEY,
        type: jsonType(model),
        values: shape.values,
        depth: shape.depth,
        nulRemoved: shape.nulRemoved,
        surrogatesReplaced: shape.surrogatesReplaced,
      };
    },
    [QUOTATION_UNITS]() {
      // Values only: the JSON text of an object or array is syntax, not document text, and would repeat its members.
      const units: QuotationUnit[] = [];
      walk((value, selector) => {
        if (value === null || typeof value !== 'object')
          units.push({
            selector,
            text: jsonText(value),
            byteRange: null,
            parent: -1,
            start: -1,
            end: -1,
          });
      });
      return { stream: '', units };
    },
  };
  return document;
}

export const jsonParser: Parser<JsonValue> = {
  id: 'json',
  version: 1,
  mediaTypes: ['application/json'],
  limits: LIMITS,
  parse,
};
