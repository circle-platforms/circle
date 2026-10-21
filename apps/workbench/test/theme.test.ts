import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contrastRatio,
  palette,
  rgbToHex,
  setPalette,
  type RGB,
} from '../../../src/ink/theme.ts';
import { applyTheme } from '../src/theme.ts';

// applyTheme writes CSS variables on the document: a stand-in collects them.
function themeTokens(choice: 'light' | 'dark'): Map<string, string> {
  const tokens = new Map<string, string>();
  const root = {
    style: {
      setProperty: (name: string, value: string) => tokens.set(name, value),
      colorScheme: '',
    },
    dataset: {} as Record<string, string>,
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    value: { documentElement: root },
    configurable: true,
  });
  try {
    applyTheme(choice);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete (globalThis as { document?: unknown }).document;
  }
  return tokens;
}
const hex = (value: string) =>
  rgbToHex(value.match(/\d+/g)!.slice(0, 3).map(Number) as RGB);

test('the trusted green reads at 4.5:1 on every ground of both desktop themes', () => {
  const saved = palette();
  try {
    for (const choice of ['light', 'dark'] as const) {
      const tokens = themeTokens(choice);
      const positive = hex(tokens.get('--positive')!);
      for (const ground of ['--bg', '--surface', '--sidebar', '--drawer']) {
        const ratio = contrastRatio(positive, hex(tokens.get(ground)!));
        assert.ok(
          ratio >= 4.5,
          `${choice}: --positive ${positive} on ${ground} is ${ratio.toFixed(2)}:1`,
        );
      }
    }
  } finally {
    setPalette(saved);
  }
});
