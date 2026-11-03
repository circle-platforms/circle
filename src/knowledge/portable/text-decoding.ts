// Adapted from Circle Hub (Apache-2.0); see provenance.json.
// Text decoding with exact byte offsets: strict UTF-8 or single-byte charsets, BOM handling and NUL removal.
import { isUtf8 } from 'node:buffer';
import { ParseEncodingError, mediaTypeCharset } from './parser.js';

/** Charsets the text parsers decode with exact byte offsets. */
export type TextCharset =
  | 'utf-8'
  | 'iso-8859-1'
  | 'windows-1252'
  | 'us-ascii'
  | 'utf-16le'
  | 'utf-16be'
  | 'gb18030'
  | 'gbk'
  | 'big5';

export interface DecodedText {
  text: string;
  charset: TextCharset;
  /** Bytes of a stripped byte order mark. */
  bom: number;
  offsets: ByteOffsets;
}

// WHATWG Encoding Standard labels of windows-1252 (browsers decode ISO-8859-1 and ASCII labels this way).
const WINDOWS_1252_LABELS = new Set([
  'ansi_x3.4-1968',
  'ascii',
  'cp1252',
  'cp819',
  'csisolatin1',
  'ibm819',
  'iso-8859-1',
  'iso-ir-100',
  'iso8859-1',
  'iso88591',
  'iso_8859-1',
  'iso_8859-1:1987',
  'l1',
  'latin1',
  'us-ascii',
  'windows-1252',
  'x-cp1252',
]);
const UTF8_LABELS = new Set([
  'utf-8',
  'utf8',
  'unicode-1-1-utf-8',
  'unicode11utf8',
  'unicode20utf8',
  'x-unicode20utf8',
]);

export function isUtf8Label(label: string): boolean {
  return UTF8_LABELS.has(label.toLowerCase());
}

export function isWindows1252Label(label: string): boolean {
  return WINDOWS_1252_LABELS.has(label.toLowerCase());
}

/** Byte offset of the first invalid UTF-8 sequence (RFC 3629), or -1 when the bytes are valid. */
export function firstInvalidUtf8(bytes: Uint8Array): number {
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i]!;
    if (b < 0x80) {
      i++;
      continue;
    }
    let need: number;
    let min: number;
    if (b >= 0xc2 && b <= 0xdf) {
      need = 1;
      min = 0x80;
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      min = 0x800;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      min = 0x10000;
    } else return i;
    let cp = b & (0x3f >> need);
    for (let k = 1; k <= need; k++) {
      const c = bytes[i + k]!;
      if (c === undefined || (c & 0xc0) !== 0x80) return i;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return i;
    i += need + 1;
  }
  return -1;
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Strict UTF-8: a leading BOM is stripped, any invalid sequence is a typed error carrying its byte offset. */
export function decodeUtf8(parser: string, bytes: Uint8Array): DecodedText {
  const bom =
    bytes.length >= 3 &&
    bytes[0]! === 0xef &&
    bytes[1]! === 0xbb &&
    bytes[2]! === 0xbf
      ? 3
      : 0;
  const body = bom ? bytes.subarray(bom) : bytes;
  if (!isUtf8(body)) {
    const at = Math.max(0, firstInvalidUtf8(body)) + bom;
    throw new ParseEncodingError(
      parser,
      `不是有效的 UTF-8（第 ${at} 字节起）`,
      at,
    );
  }
  const text = UTF8_DECODER.decode(body);
  return {
    text,
    charset: 'utf-8',
    bom,
    offsets: new ByteOffsets(text, true, bom),
  };
}

/** One byte per character: true ISO-8859-1, WHATWG windows-1252, or US-ASCII (bytes above 0x7F rejected). */
export function decodeSingleByte(
  parser: string,
  bytes: Uint8Array,
  charset: 'iso-8859-1' | 'windows-1252' | 'us-ascii',
): DecodedText {
  let text: string;
  if (charset === 'windows-1252') {
    text = new TextDecoder('windows-1252').decode(bytes);
  } else {
    if (charset === 'us-ascii') {
      const at = bytes.findIndex((b) => b > 0x7f);
      if (at >= 0)
        throw new ParseEncodingError(
          parser,
          `声明为 US-ASCII，但第 ${at} 字节不是 ASCII`,
          at,
        );
    }
    text = Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).toString('latin1');
  }
  return { text, charset, bom: 0, offsets: new ByteOffsets(text, false, 0) };
}

/** BOM precedence for text-like sources; XML additionally checks declaration consistency. */
export function bomCharset(
  bytes: Uint8Array,
): 'utf-8' | 'utf-16le' | 'utf-16be' | null {
  if (bytes[0]! === 0xff && bytes[1]! === 0xfe) return 'utf-16le';
  if (bytes[0]! === 0xfe && bytes[1]! === 0xff) return 'utf-16be';
  if (bytes[0]! === 0xef && bytes[1]! === 0xbb && bytes[2]! === 0xbf)
    return 'utf-8';
  return null;
}

export function legacyCharset(label: string): TextCharset | null {
  try {
    const name = new TextDecoder(label).encoding;
    if (
      name === 'utf-16le' ||
      name === 'utf-16be' ||
      name === 'gb18030' ||
      name === 'gbk' ||
      name === 'big5'
    )
      return name;
  } catch {
    /* Unsupported labels are reported by the caller. */
  }
  return null;
}

// ICU accepts a few legacy single-byte extensions (notably Big5 0x80/0xff). Learn them from the same decoder.
const legacySingleBytes = new Map<TextCharset, ReadonlySet<number>>();
function singleByteCodes(charset: TextCharset): ReadonlySet<number> {
  const cached = legacySingleBytes.get(charset);
  if (cached) return cached;
  const codes = new Set<number>();
  const decoder = new TextDecoder(charset, { fatal: true, ignoreBOM: true });
  for (let byte = 0x80; byte <= 0xff; byte++) {
    try {
      decoder.decode(Uint8Array.of(byte));
      codes.add(byte);
    } catch {
      /* A lead byte requires a following sequence. */
    }
  }
  legacySingleBytes.set(charset, codes);
  return codes;
}

/** A byte sequence's width; the fatal decoder validates its actual mapping. */
function sequenceWidth(
  bytes: Uint8Array,
  at: number,
  charset: TextCharset,
): number {
  if (charset === 'utf-16le' || charset === 'utf-16be') {
    const word =
      charset === 'utf-16le'
        ? bytes[at]! | (bytes[at + 1]! << 8)
        : (bytes[at]! << 8) | bytes[at + 1]!;
    return word >= 0xd800 && word <= 0xdbff ? 4 : 2;
  }
  if (bytes[at]! < 0x80 || singleByteCodes(charset).has(bytes[at]!)) return 1;
  return (charset === 'gb18030' || charset === 'gbk') &&
    bytes[at + 1]! >= 0x30 &&
    bytes[at + 1]! <= 0x39
    ? 4
    : 2;
}

/** Find the first invalid sequence in bounded chunks, then refine only the failing chunk. */
function invalidSequence(bytes: Uint8Array, charset: TextCharset): number {
  const decoder = new TextDecoder(charset, { fatal: true, ignoreBOM: true });
  for (let start = 0; start < bytes.length;) {
    let end = start;
    while (end < bytes.length && end - start < 16384)
      end += sequenceWidth(bytes, end, charset);
    end = Math.min(end, bytes.length);
    try {
      decoder.decode(bytes.subarray(start, end));
    } catch {
      for (let at = start; at < end; at += sequenceWidth(bytes, at, charset)) {
        try {
          decoder.decode(
            bytes.subarray(
              at,
              Math.min(end, at + sequenceWidth(bytes, at, charset)),
            ),
          );
        } catch {
          return at;
        }
      }
      return start;
    }
    start = end;
  }
  return 0;
}

/** Strict platform decoding with a map from decoded UTF-16 indices to original sequence boundaries. */
export function decodeEncoding(
  parser: string,
  bytes: Uint8Array,
  charset: TextCharset,
): DecodedText {
  if (charset === 'utf-8') return decodeUtf8(parser, bytes);
  if (
    charset === 'iso-8859-1' ||
    charset === 'windows-1252' ||
    charset === 'us-ascii'
  )
    return decodeSingleByte(parser, bytes, charset);
  const marker = bomCharset(bytes);
  const bom = marker === charset && charset.startsWith('utf-16') ? 2 : 0;
  if (charset.startsWith('utf-16') && !bom)
    throw new ParseEncodingError(
      parser,
      `${charset} 缺少字节序标记（第 0 字节）`,
      0,
    );
  const body = bytes.subarray(bom);
  const decoder = new TextDecoder(charset, { fatal: true, ignoreBOM: true });
  let text: string;
  try {
    text = decoder.decode(body);
  } catch {
    const at = bom + invalidSequence(body, charset);
    throw new ParseEncodingError(
      parser,
      `不是有效的 ${charset}（第 ${at} 字节起）`,
      at,
    );
  }
  const positions = new Uint32Array(text.length + 1);
  let index = 0;
  for (let at = 0; at < body.length;) {
    const width = sequenceWidth(body, at, charset);
    // Four Big5 pairs can expand to two code points; use the platform decoder mapping rather than assuming ICU data.
    const pointer =
      charset === 'big5' && width === 2
        ? (body[at]! - 0x81) * 157 +
          body[at + 1]! -
          (body[at + 1]! < 0x7f ? 0x40 : 0x62)
        : -1;
    const units =
      pointer === 1133 ||
      pointer === 1135 ||
      pointer === 1164 ||
      pointer === 1166
        ? decoder.decode(body.subarray(at, at + width)).length
        : text.codePointAt(index)! > 0xffff
          ? 2
          : 1;
    for (let unit = 0; unit < units; unit++) positions[index++]! = bom + at;
    at += width;
  }
  positions[text.length]! = bytes.length;
  return {
    text,
    charset,
    bom,
    offsets: new ByteOffsets(text, false, 0, positions),
  };
}

export function decodeDeclared(
  parser: string,
  bytes: Uint8Array,
  mediaType: string | undefined,
): DecodedText {
  const marker = bomCharset(bytes);
  if (marker) return decodeEncoding(parser, bytes, marker);
  const label = mediaTypeCharset(mediaType);
  if (label === null || isUtf8Label(label)) return decodeUtf8(parser, bytes);
  if (isWindows1252Label(label))
    return decodeSingleByte(parser, bytes, 'windows-1252');
  const charset = legacyCharset(label);
  if (charset) return decodeEncoding(parser, bytes, charset);
  throw new ParseEncodingError(parser, '不支持所声明的字符编码', 0);
}

/** Maps UTF-16 indices of a decoded string to byte offsets in the original bytes. */
export class ByteOffsets {
  readonly #text: string;
  readonly #utf8: boolean;
  readonly #base: number;
  #checkpoints: Float64Array | null = null;
  readonly #positions: Uint32Array | null;

  constructor(
    text: string,
    utf8: boolean,
    base: number,
    positions: Uint32Array | null = null,
  ) {
    this.#positions = positions;
    this.#text = text;
    this.#utf8 = utf8;
    this.#base = base;
  }

  /** Byte offset of the character at `index` (or of the end when index equals the length). */
  at(index: number): number {
    if (this.#positions) return this.#positions[index]!;
    if (!this.#utf8) return this.#base + index;
    const text = this.#text;
    const checkpoints = (this.#checkpoints ??= buildCheckpoints(text));
    const block = index >> 10;
    let offset = checkpoints[block]!;
    for (let i = block << 10; i < index; i++)
      offset += unitBytes(text.charCodeAt(i));
    return this.#base + offset;
  }
}

function unitBytes(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xd800 && code <= 0xdfff) return 2;
  return 3;
}

function buildCheckpoints(text: string): Float64Array {
  const blocks = (text.length >> 10) + 1;
  const out = new Float64Array(blocks + 1);
  let offset = 0;
  for (let i = 0; i < text.length; i++) {
    if ((i & 1023) === 0) out[i >> 10]! = offset;
    offset += unitBytes(text.charCodeAt(i));
  }
  if ((text.length & 1023) === 0) out[text.length >> 10]! = offset;
  return out;
}

/** Unicode White_Space: tabs and line breaks (U+0009-U+000D, NEL, LS, PS), spaces, NBSP and the ideographic space U+3000. */
export function isWhiteSpace(code: number): boolean {
  if (code <= 0x20) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  if (code < 0x85) return false;
  return (
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** Removes U+0000 (PostgreSQL text and jsonb refuse it); the original bytes stay intact in the object store. */
export function removeNul(text: string): string {
  return text.includes('\u0000') ? text.replaceAll('\u0000', '') : text;
}

export function countNul(text: string): number {
  let count = 0;
  for (
    let i = text.indexOf('\u0000');
    i >= 0;
    i = text.indexOf('\u0000', i + 1)
  )
    count++;
  return count;
}

/** UTF-8 length of a string as TextEncoder would encode it. */
export function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Line structure of a decoded text: content start and end of each line, terminators CRLF, LF or CR. */
export interface Lines {
  starts: number[];
  ends: number[];
}

/** Splits into lines; a terminator at the very end does not open an extra empty line. Returns null when `max` is exceeded. */
export function splitLines(text: string, max: number): Lines | null {
  const starts: number[] = [];
  const ends: number[] = [];
  if (text.length === 0) return { starts, ends };
  const breaks = /\r\n|\r|\n/g;
  let start = 0;
  for (
    let match = breaks.exec(text);
    match !== null;
    match = breaks.exec(text)
  ) {
    starts.push(start);
    ends.push(match.index);
    if (starts.length > max) return null;
    start = match.index + match[0]!.length;
  }
  if (start < text.length) {
    starts.push(start);
    ends.push(text.length);
    if (starts.length > max) return null;
  }
  return { starts, ends };
}

const XML_LATIN1_LABELS = new Set([
  'iso-8859-1',
  'iso8859-1',
  'iso_8859-1',
  'latin1',
  'latin-1',
  'l1',
  'iso-ir-100',
  'cp819',
  'ibm819',
  'csisolatin1',
]);
const XML_ASCII_LABELS = new Set([
  'us-ascii',
  'ascii',
  'ansi_x3.4-1968',
  'iso646-us',
  'us',
  'cp367',
  'ibm367',
  'csascii',
]);

function xmlCharsetOf(
  label: string,
  from: string,
): Exclude<TextCharset, 'windows-1252'> {
  if (isUtf8Label(label)) return 'utf-8';
  if (XML_LATIN1_LABELS.has(label)) return 'iso-8859-1';
  if (XML_ASCII_LABELS.has(label)) return 'us-ascii';
  const legacy = legacyCharset(label);
  if (legacy) return legacy as Exclude<TextCharset, 'windows-1252'>;
  throw new ParseEncodingError('xml@1', `XML ${from} 使用了不支持的编码`, 0);
}

export function detectXmlCharset(
  bytes: Uint8Array,
  mediaType: string | undefined,
): Exclude<TextCharset, 'windows-1252'> {
  const marker = bomCharset(bytes);
  const bom = marker === 'utf-8' ? 3 : marker ? 2 : 0;
  const parameter = mediaTypeCharset(mediaType);
  const given =
    parameter === null
      ? null
      : xmlCharsetOf(parameter, '媒体类型的 charset 参数');
  const head = marker?.startsWith('utf-16')
    ? new TextDecoder(marker).decode(bytes.subarray(0, 1024))
    : Buffer.from(
        bytes.buffer,
        bytes.byteOffset + bom,
        Math.min(1024, bytes.byteLength - bom),
      ).toString('latin1');
  const declaration = /^<\?xml[ \t\r\n][^>]*?\?>/.exec(head);
  const declared = declaration
    ? /[ \t\r\n]encoding[ \t\r\n]*=[ \t\r\n]*(["'])([A-Za-z][A-Za-z0-9._-]*)\1/.exec(
        declaration[0]!,
      )
    : null;
  const label = declared ? declared[2]!.toLowerCase() : null;
  if (marker) {
    const agrees = (value: string): boolean =>
      (value.toLowerCase() === 'utf-16' && marker.startsWith('utf-16')) ||
      xmlCharsetOf(value.toLowerCase(), '编码声明') === marker;
    if (parameter !== null && !agrees(parameter))
      throw new ParseEncodingError(
        'xml@1',
        'XML 字节序标记与媒体类型编码不一致',
        0,
      );
    if (label !== null && !agrees(label))
      throw new ParseEncodingError(
        'xml@1',
        'XML 字节序标记与 XML 编码声明不一致',
        0,
      );
    return marker as Exclude<TextCharset, 'windows-1252'>;
  }
  if (given !== null) return given;
  return label === null ? 'utf-8' : xmlCharsetOf(label, 'XML 声明');
}

/** The decoded text of XML bytes, by the same charset rules as xml@1 (the whole-file text of an XML source). */
export function decodeXmlText(
  bytes: Uint8Array,
  mediaType: string | undefined,
): string {
  const charset = detectXmlCharset(bytes, mediaType);
  return decodeEncoding('xml@1', bytes, charset).text;
}

function metaCharset(bytes: Uint8Array): string | null {
  const head = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    Math.min(1024, bytes.byteLength),
  ).toString('latin1');
  const match =
    /<meta\b[^>]*?\bcharset[ \t\n\f\r]*=[ \t\n\f\r]*["']?[ \t\n\f\r]*([A-Za-z0-9._:-]+)/i.exec(
      head,
    );
  return match ? match[1]!.toLowerCase() : null;
}

/** The decoded text of HTML bytes, by the same charset rules as html@1 (the whole-file text of an HTML source). */
export function decodeHtmlText(
  bytes: Uint8Array,
  mediaType: string | undefined,
): string {
  const marker = bomCharset(bytes);
  if (marker) return decodeEncoding('html@1', bytes, marker).text;
  const parameter = mediaTypeCharset(mediaType);
  let label =
    parameter ??
    metaCharset(bytes) ??
    (isUtf8(bytes) ? 'utf-8' : 'windows-1252');
  if (parameter === null && label.startsWith('utf-16')) label = 'utf-8';
  if (isUtf8Label(label)) {
    return decodeUtf8('html@1', bytes).text;
  }
  if (isWindows1252Label(label)) {
    return decodeSingleByte('html@1', bytes, 'windows-1252').text;
  }
  const legacy = legacyCharset(label);
  if (legacy) return decodeEncoding('html@1', bytes, legacy).text;
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    throw new ParseEncodingError(
      'html@1',
      parameter === null
        ? 'HTML <meta> 声明了不支持的字符编码'
        : 'HTML 媒体类型 charset 声明了不支持的字符编码',
      null,
      label,
    );
  }
  return decoder.decode(bytes);
}
