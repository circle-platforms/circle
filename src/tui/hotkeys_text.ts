import {
  hangingWrap,
  noticeColumns,
  pad,
  stringWidth,
} from '../ink/string_width.js';
import { HOTKEY_ROWS } from './slash_commands.js';

/** Shortcuts with the description column measured in terminal cells, then hung. */
export function formatHotkeys(width = noticeColumns()): string {
  const column =
    Math.max(0, ...HOTKEY_ROWS.map((row) => stringWidth(row.key))) + 1;
  return [
    'Keyboard shortcuts:',
    ...HOTKEY_ROWS.map((row) =>
      hangingWrap(`  ${pad(row.key, column)}`, row.text, width).join('\n'),
    ),
  ].join('\n');
}
