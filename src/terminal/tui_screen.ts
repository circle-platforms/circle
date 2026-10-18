// A device's emulated screen, drawn as Circle's rows. Every colour comes from the
// palette's ANSI map in src/ink/theme.ts; nothing else may mint one. Rows obey the
// screen's rules: exactly the given display width, and nothing cached past a repaint.
import {
  palette,
  sgrJoin,
  terminalAnsiBg,
  terminalAnsiFg,
  terminalBgEatsText,
  terminalColorSlot,
  terminalFgOverBg,
} from '../ink/theme.js';
import { stringWidth } from '../ink/string_width.js';
import type { TerminalSession } from './sessions.js';

export interface TerminalScreenOptions {
  /** Display columns of the page's transcript area. */
  width: number;
  /** Rows to produce. */
  rows: number;
  /** The buffer line the first row shows; 0 is the oldest line kept. */
  from: number;
  /** Attached: the device's own cursor is drawn where it sits. */
  cursor?: boolean;
}

/** The SGR for one cell: colours from the palette map, attributes as the plain codes. */
function cellSgr(
  fgSlot: number,
  bgSlot: number,
  bold: boolean,
  faint: boolean,
  underline: boolean,
  inverse: string,
): string {
  const codes: string[] = [];
  if (bold) codes.push('\x1b[1m');
  if (faint) codes.push('\x1b[2m');
  if (underline) codes.push('\x1b[4m');
  if (inverse) codes.push('\x1b[' + inverse + 'm');
  if (fgSlot >= 0) codes.push(terminalAnsiFg(fgSlot));
  else if (bgSlot >= 0 && terminalBgEatsText(bgSlot))
    codes.push(terminalFgOverBg(bgSlot));
  if (bgSlot >= 0) codes.push(terminalAnsiBg(bgSlot));
  return codes.length ? sgrJoin(...codes) : '';
}

export function terminalScreenRows(
  session: TerminalSession,
  options: TerminalScreenOptions,
): string[] {
  const p = palette();
  const buffer = session.screen.buffer.active;
  const out: string[] = [];
  for (let line = 0; line < options.rows; line++) {
    const at = options.from + line;
    const row = buffer.getLine(at);
    if (!row) {
      out.push(' '.repeat(options.width));
      continue;
    }
    let text = '';
    let used = 0;
    let currentSgr = '';
    let run = '';
    const flush = () => {
      if (!run) return;
      text += currentSgr ? currentSgr + run + p.reset : run;
      run = '';
    };
    for (let x = 0; x < session.cols; x++) {
      const cell = row.getCell(x);
      if (!cell) break;
      const wide = cell.getWidth();
      if (wide === 0) continue; // the tail of a double-width character
      const chars = cell.getChars() || ' ';
      if (used + wide > options.width) break; // narrower screen than device
      const sgr = cellSgr(
        terminalColorSlot(cell.getFgColorMode(), cell.getFgColor()),
        terminalColorSlot(cell.getBgColorMode(), cell.getBgColor()),
        cell.isBold() !== 0,
        cell.isDim() !== 0,
        cell.isUnderline() !== 0,
        options.cursor === true &&
          at === buffer.baseY + buffer.cursorY &&
          x === buffer.cursorX
          ? cell.isInverse()
            ? '27'
            : '7'
          : cell.isInverse()
            ? '7'
            : '',
      );
      if (sgr !== currentSgr) {
        flush();
        currentSgr = sgr;
      }
      run += chars;
      used += wide;
    }
    flush();
    // The row is never short: the rest of the line reads as screen background
    text += ' '.repeat(Math.max(0, options.width - used));
    out.push(text);
  }
  return out;
}

/** How many buffer lines exist, for the page's scroll bounds. */
export function terminalScreenLines(session: TerminalSession): number {
  return session.screen.buffer.active.length;
}
