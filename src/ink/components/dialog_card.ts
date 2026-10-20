import { uiText } from '../../locale.js';
import { palette, statusLight, sgrJoin, type Palette } from '../theme.js';
import { stringWidth, truncate } from '../string_width.js';
import { terminalText } from './markdown_renderer.js';
import { loopFrame } from './loop_frame.js';
/** How a row of a card is coloured; resolved against the palette at every paint. */
export type CardTone =
  'em' | 'text' | 'dim' | 'warn' | 'err' | 'added' | 'removed' | 'faint';
export interface CardLine {
  text: string;
  tone?: CardTone;
  /** Content, such as a command: drawn as written, never translated. */
  verbatim?: boolean;
  /** A status row of parts in their own tones (`for ` dim, a URL as text): one row, cut
   * with "…" when it does not fit, never wrapped. `text` is then not drawn. */
  segments?: [string, CardTone][];
}
/** The type tint of a card's title and body: the colour of the tool that asks. */
export type CardTint = 'read_bg' | 'write_bg' | 'think_bg' | 'agent_bg';
export interface DialogState {
  title: string;
  body: string;
  options: string[];
  focus: number;
  input?: string;
  /** Grapheme index of the cursor in `input`. Omitted: the cursor sits at the end. */
  inputCursor?: number;
  masked?: boolean;
  /** Dim in the empty input row: what an empty enter does (`enter keeps …`). */
  placeholder?: string;
  /** Body rows in their own tones; drawn instead of `body` when given. */
  lines?: CardLine[];
  /**
   * How many leading body lines are the thing being allowed (a command, a path).
   * A short card keeps those, start and end, and folds the preview before them.
   */
  anchor?: number;
  /** Per option: the key column ('' = its number). */
  optionKeys?: string[];
  /** Per option: dim text after the label. */
  optionNotes?: string[];
  /** Per option of a multi-select question: ticked or not. */
  marks?: (boolean | undefined)[];
  /** Rows under the menu: warnings, a typed answer. */
  notes?: CardLine[];
  /** The options as a searched list (setup's models): no key column, each note in a column
   * of its own, a long label cut rather than wrapped. */
  keyless?: boolean;
  /** A dim row under the options, such as `(3/24)`. */
  position?: string;
  tint?: CardTint;
  /** The title's lamp: `wait` (your turn, the default) or `running` (Circle is busy: setup
   * looking for models). A running card's frame is faint instead of yellow. */
  lamp?: 'wait' | 'running';
}
/** What a card does with a key: `undefined` took it (or swallowed it), `pass` leaves it to the session. */
export type CardResult<T> = { answer: T } | 'pass' | undefined;
/** A blocking question in the frame (approval, question, secret): keys in, an answer out. */
export interface Card<T> {
  state(): DialogState;
  handle(key: string, char: string): CardResult<T>;
  paste(text: string): void;
}
/** Printable input for a card's own input row (no control keys, no newlines). */
export function printable(key: string, char: string): string {
  if (!char || key.startsWith('ctrl+') || key.startsWith('alt+')) return '';
  if (['enter', 'tab', 'shift+enter', 'backspace', 'escape'].includes(key))
    return '';
  return terminalText(char).replace(/\n/g, '');
}
function graphemes(text: string): string[] {
  return [
    ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
  ].map((item) => item.segment);
}
/** Wrap by display width: Latin words break at spaces, CJK anywhere. */
export function wrapWords(text: string, width: number): string[] {
  if (width <= 0 || stringWidth(text) <= width) return [text];
  const lines: string[] = [];
  let current: string[] = [];
  let used = 0;
  let lastSpace = -1;
  for (const glyph of graphemes(text)) {
    const count = stringWidth(glyph);
    if (glyph === ' ' && used + count > width) {
      lines.push(current.join('').trimEnd()); // the space is the break
      current = [];
      used = 0;
      lastSpace = -1;
      continue;
    }
    if (used + count > width) {
      if (
        lastSpace > 0 &&
        /^[\x20-\x7e]$/.test(glyph) &&
        current.length - lastSpace < width * 0.4
      ) {
        lines.push(current.slice(0, lastSpace).join('').trimEnd());
        current = current.slice(lastSpace + 1);
      } else {
        lines.push(current.join(''));
        current = [];
      }
      used = stringWidth(current.join(''));
      lastSpace = -1;
    }
    current.push(glyph);
    used += count;
    if (glyph === ' ') lastSpace = current.length - 1;
  }
  if (current.length) lines.push(current.join(''));
  const kept = lines.filter((line) => line.trim());
  return kept.length ? kept : [''];
}
function tone(p: Palette, name: CardTone | undefined): string {
  return name === 'em'
    ? p.em
    : name === 'dim'
      ? p.dim
      : name === 'warn'
        ? p.yellow
        : name === 'err' || name === 'removed'
          ? p.red
          : name === 'added'
            ? p.green
            : name === 'faint'
              ? p.faint
              : p.text;
}
/** Segments in order, cut at `width` with "…", padded with the background to the full width. */
function compose(width: number, segments: [string, string][], bg = ''): string {
  const p = palette();
  let out = '';
  let used = 0;
  for (const [raw, sgr] of segments) {
    const room = width - used;
    if (room <= 0) break;
    const text = stringWidth(raw) > room ? truncate(raw, room) : raw;
    used += stringWidth(text);
    const code = bg ? sgrJoin(bg, sgr) : sgr;
    out += (code || p.reset) + text;
  }
  if (used < width) out += (bg || p.reset) + ' '.repeat(width - used);
  return out + p.reset;
}
/**
 * The card's rows inside the frame, each `width` columns wide: title with the waiting lamp,
 * body, a blank row, the options with their key column, notes, and the input row.
 * Grid: marker column 1 (lamp, key), text column 3. When the rows do not fit in `maxRows`,
 * only the body is cut, and it says how much; the title and the options always stay.
 */
export function cardRows(
  dialog: DialogState,
  width: number,
  maxRows?: number,
): string[] {
  const p = palette();
  width = Math.max(10, width); // the frame's narrowest inside
  const tint = dialog.tint ? p[dialog.tint] : '';
  const lamp = statusLight(dialog.lamp ?? 'wait');
  const lampCode = lamp.slice(0, lamp.indexOf('●'));
  // The title wraps. A single cut would hide the end of a long tool name.
  const title = terminalText(uiText(dialog.title)).replace(/\n/g, ' ');
  const titleRoom = Math.max(4, width - 4);
  const head = wrapWords(title, titleRoom).map((part, index) =>
    compose(
      width,
      index === 0
        ? [
            [' ', ''],
            ['●', lampCode],
            [' ', ''],
            [part, p.em],
          ]
        : [
            ['    ', ''],
            [part, p.em],
          ],
      tint,
    ),
  );
  const lines: CardLine[] =
    dialog.lines ??
    dialog.body.split('\n').map((text) => ({ text, tone: 'text' as const }));
  let body: string[] = [];
  const anchoredRow: boolean[] = [];
  const pushBody = (row: string, anchored: boolean) => {
    body.push(row);
    anchoredRow.push(anchored);
  };
  const anchorCount = Math.max(0, dialog.anchor ?? 0);
  lines.forEach((line, source) => {
    const anchored = source < anchorCount;
    if (line.segments) {
      pushBody(
        compose(
          width,
          [
            ['   ', ''],
            ...line.segments.map(([text, name]): [string, string] => [
              terminalText(
                name === 'added' || name === 'removed' ? text : uiText(text),
              ).replace(/\n/g, ' '),
              tone(p, name),
            ]),
          ],
          tint,
        ),
        anchored,
      );
      return;
    }
    const bodyText =
      line.verbatim || line.tone === 'added' || line.tone === 'removed'
        ? line.text
        : uiText(line.text);
    for (const part of wrapWords(terminalText(bodyText), width - 4))
      pushBody(
        compose(
          width,
          [
            ['   ', ''],
            [part, tone(p, line.tone)],
          ],
          tint,
        ),
        anchored,
      );
  });
  const menu: string[] = [];
  if (dialog.options.length) menu.push(compose(width, []));
  if (dialog.keyless) menu.push(...keylessRows(dialog, width));
  const keys = dialog.options.map(
    (_, index) => dialog.optionKeys?.[index] || String(index + 1),
  );
  const keyWidth = Math.max(1, ...keys.map((key) => stringWidth(key)));
  (dialog.keyless ? [] : dialog.options).forEach((option, index) => {
    const ticked = dialog.marks?.[index];
    const mark = ticked === undefined ? '' : ticked ? '[x] ' : '[ ] ';
    const label = terminalText(uiText(option)).replace(/\n/g, ' ');
    const note = terminalText(
      uiText(dialog.optionNotes?.[index] ?? ''),
    ).replace(/\n/g, ' ');
    // label and note wrap as one text (an option is never cut); the note is dimmed by offset
    const full = label + (note ? ` — ${note}` : '');
    const parts = wrapWords(
      full,
      Math.max(8, width - 3 - keyWidth - stringWidth(mark)),
    );
    const focused = index === dialog.focus;
    const on = sgrJoin(p.sel_bg, p.em);
    let consumed = 0; // label glyphs used by earlier rows
    const labelLength = graphemes(label).length;
    parts.forEach((part, row) => {
      const glyphs = graphemes(part);
      const cut = Math.max(0, labelLength - consumed);
      consumed += glyphs.length + (row < parts.length - 1 ? 1 : 0); // a break drops one space
      const lead =
        row === 0 ? keys[index]!.padEnd(keyWidth) : ' '.repeat(keyWidth);
      const segments: [string, string][] = [
        [' ', ''],
        [lead, focused ? '' : p.dim],
        [' ', ''],
        [row === 0 ? mark : ' '.repeat(mark.length), ticked ? p.green : ''],
        [glyphs.slice(0, cut).join(''), focused ? '' : p.text],
        [glyphs.slice(cut).join(''), focused ? '' : p.dim],
      ];
      menu.push(
        compose(
          width,
          segments.map(([text, sgr]) => [text, focused && !sgr ? on : sgr]),
          focused ? p.sel_bg : '',
        ),
      );
    });
  });
  if (dialog.position && dialog.options.length)
    menu.push(
      compose(width, [
        ['   ', ''],
        [dialog.position, p.dim],
      ]),
    );
  const notes: string[] = [];
  for (const line of dialog.notes ?? [])
    for (const part of wrapWords(
      terminalText(
        line.tone === 'added' || line.tone === 'removed'
          ? line.text
          : uiText(line.text),
      ),
      width - 4,
    ))
      notes.push(
        compose(width, [
          ['   ', ''],
          [part, tone(p, line.tone)],
        ]),
      );
  // the input row is the frame's last row, under the notes (a menu's own input row,
  // "Reject and explain", is the last option, so it stays right under it)
  const input: string[] = [];
  if (dialog.input !== undefined) {
    const glyphs = graphemes(
      dialog.masked
        ? '•'.repeat(graphemes(dialog.input).length)
        : terminalText(dialog.input).replace(/\n/g, ' '),
    );
    const at = dialog.masked
      ? glyphs.length
      : Math.max(
          0,
          Math.min(dialog.inputCursor ?? glyphs.length, glyphs.length),
        );
    const shown =
      glyphs.slice(0, at).join('') + '▏' + glyphs.slice(at).join('');
    // the input row under the body or a searched list, one blank row apart
    if (!dialog.options.length || dialog.keyless) menu.push(compose(width, []));
    input.push(
      compose(width, [
        [' ', ''],
        ['›', p.blue],
        [' ', ''],
        [truncate(shown, width - 4, true), p.text],
        [
          glyphs.length ? '' : terminalText(uiText(dialog.placeholder ?? '')),
          p.dim,
        ],
      ]),
    );
  }
  if (maxRows !== undefined) {
    const room = maxRows - 1 - menu.length - notes.length - input.length; // what is left for the body
    if (body.length > Math.max(1, room)) {
      const slots = Math.max(1, room - 1);
      const fold = (hidden: number) =>
        compose(
          width,
          [
            ['   ', ''],
            [`… +${hidden} lines`, p.dim],
          ],
          tint,
        );
      const kept = body.filter((_, index) => anchoredRow[index]);
      const preview = body.filter((_, index) => !anchoredRow[index]);
      // No command to protect: keep the start, as before.
      if (!anchorCount || !kept.length) {
        body = [...body.slice(0, slots), fold(body.length - slots)];
      } else if (kept.length <= slots) {
        const shown = preview.slice(0, slots - kept.length);
        const hidden = body.length - kept.length - shown.length;
        body = hidden ? [...kept, ...shown, fold(hidden)] : [...kept, ...shown];
      } else if (slots === 1) {
        // One row left: the end of a command is the part a cut used to hide.
        body = [fold(body.length - 1), kept.at(-1)!];
      } else {
        const tailCount = Math.max(1, Math.floor(slots / 2));
        const headCount = slots - tailCount;
        const head = kept.slice(0, headCount);
        const tail = kept.slice(kept.length - tailCount);
        body = [
          ...head,
          fold(body.length - head.length - tail.length),
          ...tail,
        ];
      }
    }
  }
  return [...head, ...body, ...menu, ...notes, ...input];
}
/**
 * The options as a list inside the card (setup's models): the label at the text column, the
 * note in a column of its own, the focused row painted whole. Long labels are cut.
 */
function keylessRows(dialog: DialogState, width: number): string[] {
  const p = palette();
  const notes = dialog.options.map((_, index) =>
    terminalText(dialog.optionNotes?.[index] ?? '').replace(/\n/g, ' '),
  );
  const room = Math.max(
    8,
    width - 6 - Math.max(0, ...notes.map((note) => stringWidth(note))),
  );
  const labels = dialog.options.map((option) => {
    const label = terminalText(option).replace(/\n/g, ' ');
    return stringWidth(label) > room ? truncate(label, room) : label;
  });
  const nameWidth =
    Math.max(0, ...labels.map((label) => stringWidth(label))) + 3;
  return labels.map((label, index) => {
    const gap = ' '.repeat(Math.max(0, nameWidth - stringWidth(label)));
    return index === dialog.focus
      ? compose(
          width,
          [[`   ${label}${gap}${notes[index]}`, sgrJoin(p.sel_bg, p.em)]],
          p.sel_bg,
        )
      : compose(width, [
          ['   ', ''],
          [label + gap, p.text],
          [notes[index]!, p.dim],
        ]);
  });
}
/**
 * The card in its frame: still and yellow, because it is your turn; faint while the card
 * only says what Circle is doing (its lamp is `running`). The mode word keeps its corner.
 */
export function dialogRows(
  dialog: DialogState,
  width: number,
  height: number,
  mode: { word?: string; sgr?: string } = {},
): string[] {
  const p = palette();
  width = Math.max(12, width);
  const inner = cardRows(dialog, width - 2, Math.max(3, height - 2));
  const frame = loopFrame(width, {
    border: dialog.lamp === 'running' ? p.faint : p.yellow,
    mode: mode.word,
    modeSgr: mode.sgr,
  });
  return [
    frame.top,
    ...inner.map((row) => frame.left + row + frame.right),
    frame.bottom,
  ];
}
