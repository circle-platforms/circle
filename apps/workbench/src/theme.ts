import {
  buildPalette,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  hexToRgb,
  mix,
  palette,
  setPalette,
} from '../../../src/ink/theme';
import type { TextSize, Theme } from './model/types';
/** Interface and code text sizes in px for each preset; code is one step smaller. */
export const TEXT_SIZES: Record<TextSize, [number, number]> = {
  small: [13, 12],
  default: [14, 13],
  large: [15, 14],
  larger: [17, 16],
};
export const textSizes = Object.keys(TEXT_SIZES) as TextSize[];
/** Browser tokens are derived from Circle's existing palette, never a second color table. */
export function applyTheme(choice: Theme, size: TextSize = 'default') {
  const dark =
    choice === 'auto'
      ? matchMedia('(prefers-color-scheme: dark)').matches
      : choice === 'dark';
  setPalette(buildPalette(...(dark ? DEFAULT_DARK : DEFAULT_LIGHT)));
  const p = palette();
  const rgb = (color: string) => `rgb(${hexToRgb(color).join(' ')})`;
  const values: Record<string, string> = {
    bg: p.bg_hex,
    fg: p.fg_hex,
    sidebar: mix(p.bg_hex, p.fg_hex, 0.035),
    surface: mix(p.bg_hex, p.fg_hex, 0.045),
    hover: mix(p.bg_hex, p.fg_hex, 0.085),
    active: mix(p.bg_hex, p.fg_hex, 0.12),
    border: mix(p.bg_hex, p.fg_hex, 0.15),
    secondary: mix(p.fg_hex, p.bg_hex, 0.22),
    muted: mix(p.fg_hex, p.bg_hex, 0.39),
    subtle: mix(p.bg_hex, p.fg_hex, 0.025),
    'read-bg': p.read_bg_hex,
    'write-bg': p.write_bg_hex,
    'think-bg': p.think_bg_hex,
    'agent-bg': p.agent_bg_hex,
  };
  const root = document.documentElement;
  for (const [key, value] of Object.entries(values))
    root.style.setProperty('--' + key, rgb(value));
  root.style.setProperty(
    '--accent',
    `rgb(${p.rainbow_stops[0]![1].join(' ')})`,
  );
  root.style.setProperty(
    '--negative',
    `rgb(${p.rainbow_stops[2]![1].join(' ')})`,
  );
  const stop = (index: number) =>
    `rgb(${p.rainbow_stops[index]![1].join(' ')})`;
  const stops = p.rainbow_stops
    .map(([at, value]) => `rgb(${value.join(' ')}) ${at * 100}%`)
    .join(',');
  root.style.setProperty('--logo-gradient', `conic-gradient(${stops})`);
  // Plan mode's colour, for the composer frame and the mode word
  root.style.setProperty('--violet', stop(1));
  root.style.setProperty('--call', rgb(p.call_hex));
  // Your turn: the terminal's frame is yellow; the app takes the rainbow's orange, which
  // the palette has already darkened to read on a light background.
  root.style.setProperty('--attention', stop(3));
  const hex = (index: number) =>
    '#' +
    p.rainbow_stops[index]![1].map((value) =>
      value.toString(16).padStart(2, '0'),
    ).join('');
  root.style.setProperty('--removed-bg', rgb(mix(p.bg_hex, hex(2), 0.16)));
  root.style.setProperty('--added-bg', rgb(p.write_bg_hex));
  const [ui, code] = TEXT_SIZES[size] ?? TEXT_SIZES.default;
  root.style.setProperty('--ui-size', ui + 'px');
  root.style.setProperty('--code-size', code + 'px');
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
}
