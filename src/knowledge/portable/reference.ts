// Selector codecs adapted from Circle Hub (Apache-2.0).
const MAX_REFERENCE_LENGTH = 8192,
  MAX_SEGMENTS = 256;
export const MAX_SELECTOR_LENGTH = 4096;
// Loose input to normalizeReference may exceed the canonical limit by surrounding white space and redundant escapes.
const MAX_LOOSE_LENGTH = MAX_REFERENCE_LENGTH + 1024;

/** Malformed reference text. Carries the registered code a caller sees for a reference that cannot be resolved. */
export class ReferenceSyntaxError extends Error {
  readonly code: 'REFERENCE_UNRESOLVED' = 'REFERENCE_UNRESOLVED';
  readonly fix: string = 'check the reference';
  readonly input: string;
  /** UTF-16 index in `input` where the problem starts. */
  readonly position: number;
  constructor(message: string, input: string, position: number) {
    super(message);
    this.name = 'ReferenceSyntaxError';
    this.input = input;
    this.position = position;
  }
}

// Characters that never appear raw in a selector segment, path segment or pointer: the escape character, controls,
// format characters (zero-width and bidi marks) and every separator or space character.
const ALWAYS_ENCODED = /^[%\p{Cc}\p{Cf}\p{Z}]$/u;
type Part = 'selector' | 'path' | 'pointer';
// Characters that are structural in a part and so must be escaped inside it.
const STRUCTURAL: Record<Part, string> = {
  selector: '/:',
  path: '/@',
  pointer: '#',
};

const DIGEST = /^[0-9a-f]{64}$/;
const PARSER_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAJOR = /^(?:0|[1-9][0-9]{0,8})$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,15})$/;
const ENCODER = new TextEncoder();
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function mustEncode(ch: string, part: Part): boolean {
  return ALWAYS_ENCODED.test(ch) || STRUCTURAL[part]!.includes(ch);
}

function hex2(byte: number): string {
  return byte.toString(16).toUpperCase().padStart(2, '0');
}

function codePointLabel(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Percent-encodes exactly the characters that must be escaped in the part; everything else stays raw (IRI style). */
function encodePart(value: string, part: Part, input: string): string {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff)
      throw new ReferenceSyntaxError(
        `含有不成对的代理字符 ${codePointLabel(cp)}，不能写进引用`,
        input,
        0,
      );
    if (mustEncode(ch, part)) {
      for (const byte of ENCODER.encode(ch)) out += `%${hex2(byte)}`;
    } else out += ch;
  }
  return out;
}

/** Strict decoding of canonical text: escapes are upper-case, valid UTF-8 and only used where required. */
function decodePart(
  text: string,
  part: Part,
  input: string,
  offset: number,
): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) === 0x25) {
      const start = i;
      const bytes: number[] = [];
      while (i < text.length && text.charCodeAt(i) === 0x25) {
        const pair = text.slice(i + 1, i + 3);
        if (!/^[0-9A-F]{2}$/.test(pair)) {
          const message = /^[0-9a-fA-F]{2}$/.test(pair)
            ? '百分号转义要用大写十六进制'
            : '百分号转义不完整：% 后面要跟两位十六进制';
          throw new ReferenceSyntaxError(message, input, offset + i);
        }
        bytes.push(Number.parseInt(pair, 16));
        i += 3;
      }
      let decoded: string;
      try {
        decoded = STRICT_UTF8.decode(Uint8Array.from(bytes));
      } catch {
        throw new ReferenceSyntaxError(
          '百分号转义不是有效的 UTF-8',
          input,
          offset + start,
        );
      }
      for (const ch of decoded) {
        if (!mustEncode(ch, part)) {
          throw new ReferenceSyntaxError(
            `字符 ${codePointLabel(ch.codePointAt(0)!)} 不需要转义，规范写法里直接写出`,
            input,
            offset + start,
          );
        }
      }
      out += decoded;
      continue;
    }
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (cp >= 0xd800 && cp <= 0xdfff)
      throw new ReferenceSyntaxError(
        `含有不成对的代理字符 ${codePointLabel(cp)}`,
        input,
        offset + i,
      );
    if (mustEncode(ch, part)) {
      throw new ReferenceSyntaxError(
        `字符 ${codePointLabel(cp)} 必须写成百分号转义（UTF-8，大写十六进制）`,
        input,
        offset + i,
      );
    }
    out += ch;
    i += ch.length;
  }
  return out;
}

/** Decodes '/'-separated non-empty segments; throws on any non-canonical text. */
function decodeSegments(
  text: string,
  part: 'selector' | 'path',
  input: string,
  offset: number,
): string[] {
  const raw = text.split('/');
  if (raw.length > MAX_SEGMENTS)
    throw new ReferenceSyntaxError(
      `段数超过上限 ${MAX_SEGMENTS}`,
      input,
      offset,
    );
  const out: string[] = [];
  let at = offset;
  for (const segment of raw) {
    if (segment === '')
      throw new ReferenceSyntaxError(
        part === 'selector' ? '片段定位里有空段' : '路径里有空段',
        input,
        at,
      );
    out.push(decodePart(segment, part, input, at));
    at += segment.length + 1;
  }
  return out;
}

function encodeSegments(
  segments: readonly string[],
  part: 'selector' | 'path',
  input: string,
): string {
  if (segments.length > MAX_SEGMENTS)
    throw new ReferenceSyntaxError(`段数超过上限 ${MAX_SEGMENTS}`, input, 0);
  return segments
    .map((segment) => {
      if (typeof segment !== 'string' || segment === '')
        throw new ReferenceSyntaxError(
          part === 'selector' ? '片段定位里有空段' : '路径里有空段',
          input,
          0,
        );
      return encodePart(segment, part, input);
    })
    .join('/');
}

/** Selector text from decoded segments (each segment non-empty). */
export function selectorOf(segments: readonly string[]): string {
  if (segments.length === 0)
    throw new ReferenceSyntaxError('片段定位不能为空', '', 0);
  return encodeSegments(segments, 'selector', segments.join('/'));
}

/** Decoded segments of canonical selector text; throws ReferenceSyntaxError when the text is not canonical. */
export function selectorSegments(selector: string): string[] {
  if (selector === '')
    throw new ReferenceSyntaxError('片段定位不能为空', selector, 0);
  return decodeSegments(selector, 'selector', selector, 0);
}

/** Like selectorSegments but returns null instead of throwing; parsers use it inside locate(). */
export function trySelectorSegments(selector: string): string[] | null {
  if (
    typeof selector !== 'string' ||
    selector === '' ||
    selector.length > MAX_REFERENCE_LENGTH
  )
    return null;
  try {
    return decodeSegments(selector, 'selector', selector, 0);
  } catch (error) {
    if (error instanceof ReferenceSyntaxError) return null;
    throw error;
  }
}

/** Like selectorOf but returns null for segments that cannot be written (empty, unpaired surrogates). */
export function trySelector(segments: readonly string[]): string | null {
  try {
    return selectorOf(segments);
  } catch (error) {
    if (error instanceof ReferenceSyntaxError) return null;
    throw error;
  }
}

/** Canonical selector text of one segment, for parsers building selectors piece by piece. */
export function selectorSegment(segment: string): string {
  return encodeSegments([segment], 'selector', segment);
}
