// The upgrade notice under the welcome, in the terminal's current palette.
import { palette } from '../ink/theme.js';
import { wrap } from '../ink/string_width.js';
import type { NoticeLocale, WhatsNewNotice } from '../whats_new.js';

/** Rows for the notice, without a trailing blank. Colours come from the palette. */
export function whatsNewRows(
  notice: WhatsNewNotice,
  locale: NoticeLocale,
  width: number,
): string[] {
  const p = palette();
  const room = Math.max(8, width - 2);
  const paint = (text: string, style: string) =>
    wrap(text, room).map((line) => ` ${style}${line}${p.reset}`);
  const rows = [...paint(notice.title[locale], p.em), ''];
  for (const item of notice.items)
    rows.push(...paint(item[locale], p.text), '');
  rows.push(
    ...paint(`${notice.linkLabel[locale]} ${notice.link}`, p.dim),
    ...paint(`esc · ${notice.dismiss[locale]}`, p.faint),
  );
  return rows;
}
