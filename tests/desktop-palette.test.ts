import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDesktopPalette,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  fallbackColors,
  GRADIENT_STOPS,
} from '../src/ink/theme.js';

test('desktop themes leave terminal defaults, fallback and brand stops unchanged', () => {
  const defaults = [
    ['#d6dee6', '#10151a'],
    ['#3c4148', '#f7f8fa'],
  ];
  const stops = [
    [0, [8, 148, 255]],
    [0.3, [201, 89, 221]],
    [0.65, [255, 46, 84]],
    [0.9, [255, 144, 4]],
    [1, [8, 148, 255]],
  ];
  for (const theme of ['light', 'dark'] as const) {
    buildDesktopPalette(theme);
    assert.deepEqual([DEFAULT_DARK, DEFAULT_LIGHT], defaults);
    assert.deepEqual(fallbackColors({}), defaults[0]);
    assert.deepEqual(fallbackColors({ COLORFGBG: '0;15' }), defaults[1]);
    assert.deepEqual(GRADIENT_STOPS, stops);
  }
});
