// Adapted from Circle Hub (Apache-2.0); see provenance.json.
// text@1: plain text as numbered lines. Selectors: `l/<n>` (line n, 1-based) and `l/<a>-<b>` (lines a to b inclusive, a < b).
import {
  QUOTATION_UNITS,
  checkSize,
  effectiveLimits,
  nodesError,
  type Fragment,
  type ParsedDocument,
  type Parser,
  type ParseLimits,
  type ParseOptions,
  type QuotationSource,
  type QuotationUnit,
} from '../parser.js';
import { selectorOf, trySelectorSegments } from '../reference.js';
import {
  countNul,
  decodeDeclared,
  removeNul,
  splitLines,
} from '../text-decoding.js';

const KEY = 'text@1';
const LIMITS: Readonly<ParseLimits> = {
  maxBytes: 16 * 1024 * 1024,
  maxDepth: 1,
  maxNodes: 1_000_000,
};
const LINE = /^[1-9][0-9]{0,8}$/;

export type TextModel = {
  charset: string;
  lines: string[];
  nulRemoved: number;
  /** Exact source text only when its UTF-8 encoding reproduces the original bytes, BOM and NUL included. */
  raw_utf8?: string;
};

function parse(
  bytes: Uint8Array,
  options: ParseOptions = {},
): ParsedDocument<TextModel> {
  const limits = effectiveLimits(LIMITS, options);
  checkSize(KEY, bytes, limits);
  const decoded = decodeDeclared(KEY, bytes, options.mediaType);
  const { text, offsets } = decoded;
  const split = splitLines(text, limits.maxNodes);
  if (split === null) throw nodesError(KEY, limits.maxNodes);
  const { starts, ends } = split;
  const lines = starts.map((start, i) =>
    removeNul(text.slice(start, ends[i]!)),
  );
  const model: TextModel = {
    charset: decoded.charset,
    lines,
    nulRemoved: countNul(text),
  };
  if (decoded.charset === 'utf-8') {
    const original = Buffer.from(bytes).toString('utf8');
    if (Buffer.from(original, 'utf8').equals(Buffer.from(bytes)))
      model.raw_utf8 = original;
  }

  // The lines joined with LF: the text of `l/1-<n>`, and every line is a slice of it.
  let joined: { text: string; at: Int32Array } | null = null;
  const stream = (): { text: string; at: Int32Array } => {
    if (joined) return joined;
    const at = new Int32Array(lines.length + 1);
    for (let i = 0; i < lines.length; i++)
      at[i + 1]! = at[i]! + lines[i]!.length + 1;
    return (joined = { text: lines.join('\n'), at });
  };
  const fragment = (from: number, to: number): Fragment => {
    const shared = stream();
    return {
      selector: selectorOf(['l', from === to ? String(from) : `${from}-${to}`]),
      text: shared.text.slice(shared.at[from - 1]!, shared.at[to]! - 1),
      byteRange: [offsets.at(starts[from - 1]!), offsets.at(ends[to - 1]!)],
      data: { line: from, lines: to - from + 1 },
    };
  };

  const document: ParsedDocument<TextModel> & QuotationSource = {
    parser: KEY,
    model,
    locate(selector) {
      const segments = trySelectorSegments(selector);
      if (!segments || segments.length !== 2 || segments[0]! !== 'l')
        return null;
      const dash = segments[1]!.indexOf('-');
      const a = dash < 0 ? segments[1]! : segments[1]!.slice(0, dash);
      const b = dash < 0 ? a : segments[1]!.slice(dash + 1);
      if (!LINE.test(a) || !LINE.test(b)) return null;
      const from = Number(a);
      const to = Number(b);
      if (dash >= 0 && from >= to) return null;
      if (to > lines.length) return null;
      return fragment(from, to);
    },
    listSelectors(prefix = '', options = {}) {
      const out: string[] = [];
      const limit = options.limit ?? Number.POSITIVE_INFINITY;
      for (let n = 1; n <= lines.length && out.length < limit; n++) {
        const selector = `l/${n}`;
        if (selector.startsWith(prefix)) out.push(selector);
      }
      return out;
    },
    summary() {
      return {
        parser: KEY,
        charset: decoded.charset,
        bytes: bytes.length,
        lines: lines.length,
        nulRemoved: model.nulRemoved,
      };
    },
    [QUOTATION_UNITS]() {
      // The whole text first, so that a quotation across a line break resolves to it; then every line inside it.
      const shared = stream();
      const units: QuotationUnit[] = [];
      const whole = lines.length >= 2 ? 0 : -1;
      if (whole === 0) {
        units.push({
          selector: `l/1-${lines.length}`,
          text: shared.text,
          byteRange: [
            offsets.at(starts[0]!),
            offsets.at(ends[lines.length - 1]!),
          ],
          parent: -1,
          start: 0,
          end: shared.text.length,
        });
      }
      for (let n = 1; n <= lines.length; n++) {
        const start = shared.at[n - 1]!;
        const end = shared.at[n]! - 1;
        units.push({
          selector: `l/${n}`,
          text: shared.text.slice(start, end),
          byteRange: [offsets.at(starts[n - 1]!), offsets.at(ends[n - 1]!)],
          parent: whole,
          start,
          end,
        });
      }
      return { stream: shared.text, units };
    },
  };
  return document;
}

export const textParser: Parser<TextModel> = {
  id: 'text',
  version: 1,
  mediaTypes: ['text/plain', 'text/*'],
  limits: LIMITS,
  parse,
};
