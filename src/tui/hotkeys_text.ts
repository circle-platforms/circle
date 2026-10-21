import {
  hangingWrap,
  noticeColumns,
  pad,
  stringWidth,
} from '../ink/string_width.js';
import { t } from '../locale.js';
import { HOTKEY_ROWS } from './slash_commands.js';

/** Shortcuts with the description column measured in terminal cells, then hung. */
export function formatHotkeys(width = noticeColumns()): string {
  const rows = HOTKEY_ROWS.map((row) => ({
    key: row.key ? t(row.key) : '',
    text: t(row.text),
  }));
  const column = Math.max(0, ...rows.map((row) => stringWidth(row.key))) + 1;
  return [
    t('Keyboard shortcuts:'),
    ...rows.map((row) =>
      hangingWrap(`  ${pad(row.key, column)}`, row.text, width).join('\n'),
    ),
  ].join('\n');
}
