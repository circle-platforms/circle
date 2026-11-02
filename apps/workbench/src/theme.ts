import {
  buildDesktopPalette,
  GRADIENT_STOPS,
  type DesktopToken,
  setPalette,
} from '../../../src/ink/theme.ts';
import type { TextSize, Theme } from './model/types';
/** Interface and code text sizes in px for each preset; code is one step smaller. */
export const TEXT_SIZES: Record<TextSize, [number, number]> = {
  small: [13, 12],
  default: [14, 13],
  large: [15, 14],
  larger: [17, 16],
};
export const textSizes = Object.keys(TEXT_SIZES) as TextSize[];
// Compatibility names map to semantic slots, never to another colour table.
const aliases = {
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
} as const satisfies Record<string, DesktopToken>;

/** Browser tokens come only from Circle's palette, including translucent overlays. */
export function applyTheme(choice: Theme, size: TextSize = 'default') {
  const dark =
    choice === 'auto'
      ? matchMedia('(prefers-color-scheme: dark)').matches
      : choice === 'dark';
  const p = buildDesktopPalette(dark ? 'dark' : 'light');
  setPalette(p);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(p.desktop))
    root.style.setProperty('--' + name, value);
  for (const [name, token] of Object.entries(aliases))
    root.style.setProperty('--' + name, p.desktop[token]);
  const brand = [
    'brand-blue',
    'brand-violet',
    'brand-red',
    'brand-orange',
    'brand-blue',
  ] as const;
  const stops = GRADIENT_STOPS.map(
    ([at], index) => `${p.desktop[brand[index]!]} ${at * 100}%`,
  ).join(',');
  root.style.setProperty('--logo-gradient', `conic-gradient(${stops})`);
  const [ui, code] = TEXT_SIZES[size] ?? TEXT_SIZES.default;
  root.style.setProperty('--ui-size', ui + 'px');
  root.style.setProperty('--code-size', code + 'px');
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
}
