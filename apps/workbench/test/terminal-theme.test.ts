import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPalette,
  buildDesktopPalette,
  contrastRatio,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  palette,
  setPalette,
} from '../../../src/ink/theme.ts';
import { terminalTheme } from '../src/model/terminal-theme.ts';

test('opening a terminal works with Circle five-stop gradients in both themes', () => {
  const previous = palette();
  try {
    for (const colors of [DEFAULT_DARK, DEFAULT_LIGHT]) {
      const source = buildPalette(...colors);
      assert.equal(
        source.rainbow_stops.length,
        5,
        'regression fixture uses the real brand gradient',
      );
      setPalette(source);
      const theme = terminalTheme();
      for (const value of Object.values(theme))
        assert.match(value, /^#[\da-f]{6}$/i);
      assert.ok(contrastRatio(theme.foreground!, theme.background!) >= 4.5);
      assert.ok(contrastRatio(theme.cursor!, theme.cursorAccent!) >= 4.5);
      assert.notEqual(theme.selectionBackground, theme.background);
      assert.equal(theme.background, source.bg_hex);
      assert.equal(theme.foreground, source.fg_hex);
    }
  } finally {
    setPalette(previous);
  }
});

test('embedded terminal colours follow the desktop palette through both theme switches', () => {
  const previous = palette();
  try {
    for (const choice of ['dark', 'light', 'dark'] as const) {
      const source = buildDesktopPalette(choice);
      setPalette(source);
      const theme = terminalTheme();
      assert.equal(theme.foreground, source.desktop['text-primary']);
      assert.equal(theme.background, source.desktop['surface-1']);
      assert.equal(theme.cursor, theme.foreground);
      assert.equal(theme.cursorAccent, theme.background);
      assert.ok(contrastRatio(theme.cursor!, theme.cursorAccent!) >= 4.5);
      assert.notEqual(theme.selectionBackground, theme.background);
      // Content ANSI colours remain xterm defaults, not the brand gradient.
      assert.equal(theme.red, undefined);
      assert.equal(theme.blue, undefined);
    }
  } finally {
    setPalette(previous);
  }
});
