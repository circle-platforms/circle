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

const blank = (glyph: string | undefined): boolean =>
  glyph === ' ' || glyph === '\t';
const wide = (glyph: string | undefined): boolean =>
  glyph !== undefined && stringWidth(glyph) > 1;
const wordGlyph = (glyph: string | undefined): boolean =>
  glyph !== undefined && /^[\p{L}\p{N}_]/u.test(glyph) && !wide(glyph);

/**
 * Where the quote that opens at `index` closes, or -1 when it does not open one.
 * `「…」` and `“…”` need only their closer. A straight `'` or `"` opens only at the
 * start of a word and closes at the end of one, so the apostrophe in `don't` or
 * `Circle's` is part of its word.
 */
function quoteEnd(glyphs: string[], index: number): number {
  const close = QUOTE_CLOSE[glyphs[index]!];
  if (!close) return -1;
  if (close !== glyphs[index]) {
    const end = glyphs.indexOf(close, index + 1);
    return end;
  }
  const before = glyphs[index - 1];
  if (
    (before !== undefined &&
      !blank(before) &&
      !wide(before) &&
      !'([{<'.includes(before)) ||
    glyphs[index + 1] === undefined ||
    blank(glyphs[index + 1])
  )
    return -1;
  for (let end = index + 2; end < glyphs.length; end++)
    if (
      glyphs[end] === close &&
      !blank(glyphs[end - 1]) &&
      !wordGlyph(glyphs[end + 1])
    )
      return end;
  return -1;
}

// CJK and other wide glyphs are their own atoms, so a line can break between
// them. An ASCII run, and a quoted span that fits, stays whole. Atoms that touch
// without a space and without a wide glyph between them are one word: a line
// never breaks between `"hi"` and the `.` after it.
function atoms(source: string, quotes: boolean): Atom[] {
  const glyphs = glyphsOf(source);
  const out: Atom[] = [];
  const push = (text: string): void => {
    const last = out[out.length - 1];
    if (
      last &&
      !last.gap &&
      !wide(glyphsOf(last.text).at(-1)) &&
      !wide(glyphsOf(text)[0])
    )
      last.text += text;
    else out.push({ text, gap: false });
  };
  let index = 0;
  while (index < glyphs.length) {
    const glyph = glyphs[index]!;
    if (blank(glyph)) {
      let text = '';
      while (index < glyphs.length && blank(glyphs[index])) {
        text += glyphs[index] === '\t' ? '    ' : ' ';
        index++;
      }
      out.push({ text, gap: true });
      continue;
    }
    const end = quotes ? quoteEnd(glyphs, index) : -1;
    if (end > index) {
      push(glyphs.slice(index, end + 1).join(''));
      index = end + 1;
      continue;
    }
    if (wide(glyph)) {
      out.push({ text: glyph, gap: false });
      index++;
      continue;
    }
    let text = '';
    while (index < glyphs.length) {
      const current = glyphs[index]!;
      if (
        blank(current) ||
        wide(current) ||
        (quotes && text && quoteEnd(glyphs, index) > index)
      )
        break;
      text += current;
      index++;
    }
    push(text);
  }
  return out;
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
  const queue = [...parts];
  while (queue.length) {
    const part = queue.shift()!;
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
    if (size > limit()) {
      // Wider than a whole line. A quoted span flows like the words in it.
      const softer = atoms(part.text, false);
      if (softer.length > 1) {
        queue.unshift(...softer);
        continue;
      }
      // One long word starts its own line and is cut where each line ends.
      if (line) commit();
      for (const glyph of glyphsOf(part.text)) {
        const width = Math.max(stringWidth(glyph), 1);
        if (line && used + width > limit()) commit();
        line += glyph;
        used += width;
      }
      continue;
    }
    if (line && used + size > limit()) commit();
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

function lineWidth(glyphs: string[]): number {
  return stringWidth(glyphs.join(''));
}

/**
 * A line does not end on an opening mark or begin on a closing one, and a single
 * Han glyph is not left on a line of its own when the previous line can spare one.
 * A closer that would start a line takes the previous glyph with it. A trailing
 * closer may stick out by its own width; anything wider is given to the next line.
 */
function kinsoku(lines: string[], first: number, rest: number): string[] {
  const rows = lines.map((line) => glyphsOf(line));
  const room = (index: number): number => (index === 0 ? first : rest);
  const ensure = (index: number): string[] => {
    while (rows.length <= index) rows.push([]);
    return rows[index]!;
  };
  for (let pass = 0; pass < 8; pass++) {
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
    for (let i = 0; i < rows.length; i++) {
      const line = rows[i]!;
      while (lineWidth(line) > room(i) && line.length > 1) {
        const tail = line[line.length - 1]!;
        if (
          CLOSE_PUNCT.has(tail) &&
          lineWidth(line) - room(i) <= stringWidth(tail)
        )
          break;
        const glyph = line.pop()!;
        const next = ensure(i + 1);
        next.unshift(glyph);
        changed = true;
        if (next[0] && CLOSE_PUNCT.has(next[0]) && line.length)
          next.unshift(line.pop()!);
      }
    }
    for (let i = 1; i < rows.length; i++) {
      const line = rows[i]!;
      const prev = rows[i - 1]!;
      while (line[0] && CLOSE_PUNCT.has(line[0]) && prev.length) {
        const before = prev[prev.length - 1]!;
        if (prev.length >= 2 && lineWidth([before, ...line]) <= room(i)) {
          prev.pop();
          line.unshift(before);
          changed = true;
          continue;
        }
        prev.push(line.shift()!);
        changed = true;
        break;
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
      if (CLOSE_PUNCT.has(steal)) {
        const before = prev[prev.length - 2];
        if (!before || prev.length < 3) continue;
        if (stringWidth(before + steal + line[0]) > room(i)) continue;
        prev.pop();
        prev.pop();
        line.unshift(steal);
        line.unshift(before);
        changed = true;
        continue;
      }
      if (!isHan(steal) && !OPEN_PUNCT.has(steal)) continue;
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
 * under its text. CJK breaks anywhere except an orphaned Han glyph. Other text
 * breaks at spaces only. A word, and a quoted span (`"…"`, `'…'`, `「…」`, `“…”`),
 * stays whole unless it is wider than the line; a span that is wider flows from
 * where the line is. A straight quote opens a span only at the start of a word, so
 * the apostrophe in `don't` is part of its word. Opening punctuation does not end a
 * line, and closing punctuation does not start one.
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
