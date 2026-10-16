import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPalette,
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
