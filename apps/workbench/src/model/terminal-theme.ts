import { mix, palette, type Palette } from '../../../../src/ink/theme';
import type { ITheme } from '@xterm/xterm';

/** Brand gradient stops are not an ANSI palette. Let xterm render content ANSI
 * colors; only the terminal's interface surfaces follow Circle's live palette. */
export function terminalTheme(source: Palette = palette()): ITheme {
  return {
    background: source.bg_hex,
    foreground: source.fg_hex,
    cursor: source.fg_hex,
    cursorAccent: source.bg_hex,
    selectionBackground: mix(source.bg_hex, source.fg_hex, 0.24),
  };
}
