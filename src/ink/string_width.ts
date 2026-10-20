import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
export { stringWidth, stripAnsi };
export function truncate(
  text: string,
  width: number,
  fromLeft = false,
): string {
  const plain = stripAnsi(text);
  if (stringWidth(plain) <= width) return plain;
  if (width <= 0) return '';
  if (width === 1) return '…';
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
      plain,
    ),
  ].map((item) => item.segment);
  if (fromLeft) graphemes.reverse();
  let result = '';
  let used = 0;
  for (const glyph of graphemes) {
    const count = stringWidth(glyph);
    if (used + count > width - 1) break;
    result = fromLeft ? glyph + result : result + glyph;
    used += count;
  }
  return fromLeft ? '…' + result : result + '…';
}
const QUOTE_CLOSE: Record<string, string> = {
  '"': '"',
  "'": "'",
  '「': '」',
  '“': '”',
};

function glyphsOf(text: string): string[] {
  return [
    ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
  ].map((item) => item.segment);
}

interface Atom {
  text: string;
  gap: boolean;
}

// CJK and other wide glyphs are their own atoms, so a line can break between
// them. An ASCII run, and a quoted span that fits, stays whole.
function atoms(source: string, quotes: boolean): Atom[] {
  const glyphs = glyphsOf(source);
  const out: Atom[] = [];
  let index = 0;
  while (index < glyphs.length) {
    const glyph = glyphs[index]!;
    if (glyph === ' ' || glyph === '\t') {
      let text = '';
      while (
        index < glyphs.length &&
        (glyphs[index] === ' ' || glyphs[index] === '\t')
      ) {
        text += glyphs[index] === '\t' ? '    ' : ' ';
        index++;
      }
      out.push({ text, gap: true });
      continue;
    }
    const close = quotes ? QUOTE_CLOSE[glyph] : undefined;
    if (close) {
      let text = glyph;
      index++;
      while (index < glyphs.length && glyphs[index] !== close) {
        text += glyphs[index];
        index++;
      }
      if (index < glyphs.length) {
        text += glyphs[index];
        index++;
      }
      out.push({ text, gap: false });
      continue;
    }
    if (stringWidth(glyph) > 1) {
      out.push({ text: glyph, gap: false });
      index++;
      continue;
    }
    let text = '';
    while (index < glyphs.length) {
      const current = glyphs[index]!;
      if (
        current === ' ' ||
        current === '\t' ||
        stringWidth(current) > 1 ||
        (quotes && QUOTE_CLOSE[current])
      )
        break;
      text += current;
      index++;
    }
    out.push({ text, gap: false });
  }
  return out;
}

function hardWrap(text: string, columns: number): string[] {
  const lines: string[] = [];
  let line = '';
  let used = 0;
  for (const glyph of glyphsOf(text)) {
    const size = Math.max(stringWidth(glyph), 1);
    if (line && used + size > columns) {
      lines.push(line);
      line = '';
      used = 0;
    }
    line += glyph;
    used += size;
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

function layout(parts: Atom[], first: number, rest: number): string[] {
  const lines: string[] = [];
  let line = '';
  let used = 0;
  const limit = (): number => (lines.length === 0 ? first : rest);
  const commit = (): void => {
    lines.push(line.replace(/ +$/, ''));
    line = '';
    used = 0;
  };
  for (const part of parts) {
    if (part.gap) {
      if (!line) continue;
      const size = stringWidth(part.text);
      if (used + size > limit()) commit();
      else {
        line += part.text;
        used += size;
      }
      continue;
    }
    const size = stringWidth(part.text);
    if (line && used + size > limit()) commit();
    const room = limit();
    if (size > room) {
      const softer = atoms(part.text, false);
      const splittable =
        softer.length > 1 ||
        (softer.length === 1 && softer[0]!.text !== part.text);
      const chunks = splittable
        ? layout(softer, room, rest)
        : hardWrap(part.text, room);
      for (let at = 0; at < chunks.length; at++) {
        const chunk = chunks[at]!;
        if (at < chunks.length - 1) {
          if (line) commit();
          lines.push(chunk);
          continue;
        }
        if (line && used + stringWidth(chunk) > limit()) commit();
        line += chunk;
        used += stringWidth(chunk);
      }
      continue;
    }
    line += part.text;
    used += size;
  }
  lines.push(line.replace(/ +$/, ''));
  return lines;
}

// Opening marks stay with the next glyph. Closing marks stay with the previous one.
const OPEN_PUNCT = new Set([
  '（',
  '【',
  '「',
  '『',
  '《',
  '〈',
  '〖',
  '〔',
  '｛',
]);
const CLOSE_PUNCT = new Set([
  '）',
  '】',
  '」',
  '』',
  '》',
  '〉',
  '〗',
  '〕',
  '｝',
  '、',
  '。',
  '，',
  '．',
  '！',
  '？',
  '：',
  '；',
]);

function isHan(glyph: string): boolean {
  return /\p{Script=Han}/u.test(glyph);
}

/**
 * A line does not end on an opening mark or begin on a closing one, and a single
 * Han glyph is not left on a line of its own when the previous line can spare one.
 */
function kinsoku(lines: string[], first: number, rest: number): string[] {
  const rows = lines.map((line) => glyphsOf(line));
  const room = (index: number): number => (index === 0 ? first : rest);
  for (let pass = 0; pass < rows.length + 2; pass++) {
    let changed = false;
    for (let i = 0; i < rows.length - 1; i++) {
      const line = rows[i]!;
      const last = line[line.length - 1];
      if (last && OPEN_PUNCT.has(last) && line.length > 1) {
        line.pop();
        rows[i + 1]!.unshift(last);
        changed = true;
      }
    }
    for (let i = 1; i < rows.length; i++) {
      const line = rows[i]!;
      const glyph = line[0];
      if (glyph && CLOSE_PUNCT.has(glyph) && rows[i - 1]!.length) {
        line.shift();
        rows[i - 1]!.push(glyph);
        changed = true;
      }
    }
    for (let i = 1; i < rows.length; i++) {
      const line = rows[i]!;
      const prev = rows[i - 1]!;
      if (line.length !== 1 || !isHan(line[0]!)) continue;
      const steal = prev[prev.length - 1];
      if (!steal || prev.length < 2) continue;
      // A closing quote stays with the span it ends. The orphan stays instead.
      if ('」』”’'.includes(steal)) continue;
      if (!isHan(steal) && !CLOSE_PUNCT.has(steal) && !OPEN_PUNCT.has(steal))
        continue;
      if (stringWidth(steal + line[0]) > room(i)) continue;
      prev.pop();
      line.unshift(steal);
      changed = true;
    }
    if (!changed) break;
  }
  const kept = rows.filter((line) => line.length);
  return (kept.length ? kept : [[]]).map((line) => line.join(''));
}

/**
 * Wrap `text` to `width` columns. A line's own indent is kept, and later lines of
 * that paragraph are indented by at least `hang` columns, so a list continues
 * under its text. CJK breaks anywhere except an orphaned Han glyph. An ASCII run,
 * and a quoted span (`"…"`, `'…'`, `「…」`, `“…"`), stays whole unless it is wider
 * than the line. Opening punctuation does not end a line, and closing punctuation
 * does not start one.
 */
export function wrapHang(text: string, width: number, hang = 0): string[] {
  const columns = Math.max(1, width);
  const indent = Math.min(Math.max(0, hang), Math.max(0, columns - 1));
  const result: string[] = [];
  for (const source of stripAnsi(text).replace(/\t/g, '    ').split('\n')) {
    const lead = source.match(/^ */)?.[0].length ?? 0;
    const body = source.slice(lead);
    if (!body) {
      result.push('');
      continue;
    }
    const leadCols = Math.min(lead, Math.max(0, columns - 1));
    const cont = Math.min(Math.max(leadCols, indent), Math.max(0, columns - 1));
    const firstRoom = Math.max(1, columns - leadCols);
    const restRoom = Math.max(1, columns - cont);
    const laid = kinsoku(
      layout(atoms(body, true), firstRoom, restRoom),
      firstRoom,
      restRoom,
    );
    laid.forEach((line, index) => {
      result.push(
        (index === 0 ? ' '.repeat(leadCols) : ' '.repeat(cont)) + line,
      );
    });
  }
  return result;
}

export function wrap(text: string, width: number): string[] {
  return wrapHang(text, width, 0);
}

/** The first line is `prefix` plus the start of `body`. Later lines line up under `body`. */
export function hangingWrap(
  prefix: string,
  body: string,
  width: number,
): string[] {
  const columns = Math.max(1, width);
  if (!body) return wrap(prefix, columns);
  const head = stringWidth(prefix);
  if (head >= columns)
    return [...wrap(prefix, columns), ...wrap(body, columns)];
  const lines = wrap(body, columns - head);
  const indent = ' '.repeat(head);
  return lines.map((line, index) =>
    index === 0 ? prefix + line : indent + line,
  );
}

/** Columns a transcript notice can use. The marker takes three. */
export function noticeColumns(fallback = 80): number {
  const columns =
    typeof process !== 'undefined' && process.stdout?.columns
      ? process.stdout.columns
      : fallback;
  return Math.max(8, columns - 3);
}
export function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)));
}
// A row with colour codes cut to `width` columns: the codes are kept, `…` marks the cut and
// the colours are reset after it.
export function truncateStyled(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  if (width <= 0) return '';
  const code = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;
  let out = '';
  let used = 0;
  for (let index = 0; index < text.length;) {
    code.lastIndex = index;
    const found = code.exec(text);
    if (found) {
      out += found[0];
      index += found[0].length;
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(index)!);
    const size = stringWidth(char);
    if (used + size > width - 1) break;
    out += char;
    used += size;
    index += char.length;
  }
  return out + '…\x1b[0m';
}
