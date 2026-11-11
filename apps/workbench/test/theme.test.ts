import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  contrastRatio,
  cssColorHex,
  palette,
  rgbToHex,
  setPalette,
  type RGB,
} from '../../../src/ink/theme.ts';
import { applyTheme, TEXT_SIZES } from '../src/theme.ts';
import type { Theme, TextSize } from '../src/model/types.ts';

type Token = { name: string; value: Record<'dark' | 'light', string> };
const design = JSON.parse(
  readFileSync(
    new URL(
      '../../../docs/design/circle-design-system/tokens.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { color: { tokens: Token[] }; shadow: { tokens: Token[] } };
const designTokens = [...design.color.tokens, ...design.shadow.tokens];
function expected(name: string, theme: 'dark' | 'light'): string {
  const token = designTokens.find((item) => item.name === name);
  assert.ok(token, name);
  const value = token.value[theme];
  return value.startsWith('{') ? expected(value.slice(1, -1), theme) : value;
}

// Observe actual writes, including reuse of the same root after a theme switch.
function withRoot(
  run: (
    root: {
      values: Map<string, string>;
      style: {
        setProperty: (name: string, value: string) => void;
        colorScheme: string;
      };
      dataset: Record<string, string>;
    },
    system: { dark: boolean },
  ) => void,
) {
  const saved = palette();
  const system = { dark: false };
  const root = {
    values: new Map<string, string>(),
    style: {
      setProperty(name: string, value: string) {
        root.values.set(name, value);
      },
      colorScheme: '',
    },
    dataset: {} as Record<string, string>,
  };
  const previous = ['document', 'matchMedia'].map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  Object.defineProperty(globalThis, 'document', {
    value: { documentElement: root },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'matchMedia', {
    value: (query: string) => {
      assert.equal(query, '(prefers-color-scheme: dark)');
      return { matches: system.dark };
    },
    configurable: true,
  });
  try {
    run(root, system);
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    setPalette(saved);
  }
}
function themeTokens(choice: Theme, size: TextSize = 'default') {
  const values = new Map<string, string>();
  withRoot((root) => {
    applyTheme(choice, size);
    for (const [name, value] of root.values) values.set(name, value);
  });
  return values;
}
function channels(value: string): [number, number, number, number] {
  if (value.startsWith('#'))
    return [
      ...value
        .slice(1)
        .match(/../g)!
        .map((channel) => parseInt(channel, 16)),
      1,
    ] as [number, number, number, number];
  const parts = value.match(/\d*\.?\d+/g)!.map(Number);
  return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
}
function composite(overlay: string, ground: string): string {
  const [r, g, b, alpha] = channels(overlay);
  const background = channels(ground);
  return rgbToHex(
    [r, g, b].map((v, i) => v * alpha + background[i]! * (1 - alpha)) as RGB,
  );
}

// Independent contract: names are pinned here, colours are read from the design document.
const aliases: Record<string, string> = {
  bg: 'surface-1',
  fg: 'text-primary',
  sidebar: 'surface-0',
  drawer: 'surface-2',
  surface: 'surface-2',
  popover: 'surface-3',
  input: 'surface-sunken',
  hover: 'surface-hover',
  active: 'surface-pressed',
  border: 'line-hairline',
  'control-border': 'line-control',
  secondary: 'text-secondary',
  muted: 'text-tertiary',
  subtle: 'surface-sunken',
  accent: 'area-knowledge',
  violet: 'area-workflow',
  attention: 'area-task',
  call: 'area-workflow',
  positive: 'status-pass',
  'positive-text': 'status-pass-text',
  negative: 'status-fail',
  'negative-text': 'status-fail-text',
  'read-bg': 'status-info-bg',
  'write-bg': 'status-pass-bg',
  'think-bg': 'surface-2',
  'agent-bg': 'surface-2',
  'added-bg': 'status-pass-bg',
  'removed-bg': 'status-fail-bg',
};
for (const theme of ['dark', 'light'] as const) {
  test(
    theme + ': every exported colour and shadow matches the design tokens',
    () => {
      const values = themeTokens(theme);
      const mappings = [
        ...designTokens.map(({ name }) => [name, name]),
        ...Object.entries(aliases),
      ];
      for (const [name, token] of mappings) {
        const actual = values.get('--' + name)!;
        assert.ok(actual, name);
        if (token!.startsWith('shadow-'))
          assert.equal(
            actual.replaceAll(' ', ''),
            expected(token!, theme).replaceAll(' ', ''),
          );
        else
          assert.deepEqual(
            channels(actual),
            channels(expected(token!, theme)),
            name,
          );
      }
      // New exported names must acquire a design assertion, too.
      assert.deepEqual(
        [...values.keys()].sort(),
        [
          ...new Set([
            ...mappings.map(([name]) => '--' + name),
            '--logo-gradient',
            '--composer-stops',
            '--ui-size',
            '--code-size',
          ]),
        ].sort(),
      );
      const stops = [
        'brand-blue',
        'brand-violet',
        'brand-red',
        'brand-orange',
        'brand-blue',
      ].map(
        (name, i) =>
          expected(name, theme) + ' ' + [0, 30, 65, 90, 100][i] + '%',
      );
      assert.equal(
        values.get('--logo-gradient'),
        'conic-gradient(' + stops.join(',') + ')',
      );
      // The ring round the composer while a turn works turns the same colours, from an
      // angle of its own, so it takes the stops alone.
      assert.equal(values.get('--composer-stops'), stops.join(','));
    },
  );

  test(
    theme + ': text, control lines and focus contrast on their actual surfaces',
    () => {
      const values = themeTokens(theme);
      for (const ground of [
        'surface-0',
        'surface-1',
        'surface-2',
        'surface-3',
        'surface-sunken',
      ]) {
        const base = values.get('--' + ground)!;
        const surfaces = [
          [base, false, false],
          [composite(values.get('--hover')!, base), true, false],
          [composite(values.get('--active')!, base), true, true],
        ] as const;
        for (const [surface, overlay, selected] of surfaces) {
          for (const text of ['fg', 'secondary', 'muted']) {
            const token = text === 'muted' && overlay ? 'secondary' : text;
            const ratio = contrastRatio(values.get('--' + token)!, surface);
            assert.ok(
              ratio >= 4.5,
              theme + ': ' + text + ' on ' + ground + ' = ' + ratio,
            );
          }
          for (const line of ['control-border', 'focus-ring']) {
            const token = selected ? 'focus-ring' : line;
            const ratio = contrastRatio(values.get('--' + token)!, surface);
            assert.ok(
              ratio >= 3,
              theme + ': ' + line + ' on ' + ground + ' = ' + ratio,
            );
          }
        }
        // Trust and status words need text colours, not the independently exported dots.
        for (const state of ['pass', 'fail', 'warn', 'info']) {
          const text = values.get('--status-' + state + '-text')!;
          // Sunken surfaces contain inputs, not tinted status labels. Standalone
          // status/trust words still have to read on that ground.
          const surfaces =
            ground === 'surface-sunken'
              ? [base]
              : [
                  base,
                  composite(values.get('--status-' + state + '-bg')!, base),
                ];
          for (const surface of surfaces) {
            assert.ok(
              contrastRatio(text, surface) >= 4.5,
              theme + ': ' + state + ' text on ' + ground,
            );
          }
        }
      }
      assert.ok(
        contrastRatio(
          values.get('--text-inverse')!,
          values.get('--inverse-surface')!,
        ) >= 4.5,
      );
      for (const state of ['pass', 'fail'])
        assert.notEqual(
          values.get('--status-' + state),
          values.get('--status-' + state + '-text'),
        );
    },
  );
}

test('light composer brand frames meet 3:1 against the outer main surface', () => {
  const values = themeTokens('light');
  const ground = values.get('--surface-1')!;
  const blue = contrastRatio(values.get('--brand-blue')!, ground);
  const orange = contrastRatio(values.get('--brand-orange')!, ground);
  // Decision 93 review: the adjacent outer ground is white; text also names the state.
  assert.ok(blue >= 3 && orange >= 3);
  assert.equal(blue.toFixed(2), '3.14');
  assert.equal(orange.toFixed(2), '3.12');
});

test('auto re-evaluates the system and explicit themes replace every prior value', () => {
  withRoot((root, system) => {
    for (const [choice, systemDark, resolved] of [
      ['auto', true, 'dark'],
      ['auto', false, 'light'],
      ['dark', false, 'dark'],
      ['light', true, 'light'],
    ] as const) {
      system.dark = systemDark;
      applyTheme(choice);
      assert.equal(root.dataset.theme, resolved);
      assert.equal(root.style.colorScheme, resolved);
      for (const { name } of designTokens)
        assert.equal(root.values.get('--' + name), expected(name, resolved));
      assert.equal(palette().fg_hex, expected('text-primary', resolved));
      assert.equal(palette().bg_hex, expected('surface-1', resolved));
    }
  });
});

test('all four interface and code sizes survive theme changes', () => {
  withRoot((root) => {
    for (const theme of ['dark', 'light'] as const)
      for (const [size, [ui, code]] of Object.entries(TEXT_SIZES)) {
        applyTheme(theme, size as TextSize);
        assert.equal(root.values.get('--ui-size'), ui + 'px');
        assert.equal(root.values.get('--code-size'), code + 'px');
      }
  });
});

test('native editors preserve the alpha of every translucent theme token', () => {
  for (const theme of ['dark', 'light'] as const) {
    const values = themeTokens(theme);
    for (const [name, value] of values) {
      if (!value.startsWith('rgba(')) continue;
      const [r, g, b, alpha] = channels(value);
      assert.equal(
        cssColorHex(value),
        rgbToHex([r, g, b]) +
          Math.round(alpha * 255)
            .toString(16)
            .padStart(2, '0'),
        name,
      );
    }
    assert.equal(cssColorHex(values.get('--fg')!), values.get('--fg'));
  }
  assert.equal(cssColorHex('rgb(17 19 22 / 0.08)'), '#11131614');
  assert.equal(cssColorHex('not a colour'), undefined);
});

test('status words use text slots while dots retain their own slots', () => {
  const root = new URL('../src/', import.meta.url);
  const walk = (folder: URL): string[] =>
    readdirSync(folder, { withFileTypes: true }).flatMap((entry): string[] => {
      const path = new URL(
        entry.name + (entry.isDirectory() ? '/' : ''),
        folder,
      );
      return entry.isDirectory()
        ? walk(path)
        : entry.name.endsWith('.css')
          ? [readFileSync(path, 'utf8')]
          : [];
    });
  for (const css of walk(root))
    assert.doesNotMatch(
      css,
      /(?:^|[;{]\s*)color:\s*var\(--(?:positive|negative)\)/m,
    );
  const app = readFileSync(
    new URL('../src/styles/app.css', import.meta.url),
    'utf8',
  );
  assert.match(app, /\.status-trusted\s*\{[^}]*color: var\(--positive-text\)/);
  assert.match(
    app,
    /\.status-trusted i\s*\{[^}]*background: var\(--positive\)/,
  );
  assert.match(app, /:hover,[^{}]*\{\s*--muted: var\(--text-secondary\)/);
  assert.match(app, /:active,[^{}]*\{\s*--control-border: var\(--focus-ring\)/);
});
