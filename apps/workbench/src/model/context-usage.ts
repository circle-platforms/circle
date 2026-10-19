import { contextPercent, formatTokens, formatWindow } from './format';
import type { Session } from './types';

export interface ContextUsage {
  /** How full the window is after the last answer; null while either number is unknown. */
  percent: number | null;
  /** Orange from 70% and red from 90%. */
  level: '' | 'high' | 'full';
  /** `12.3k / 128.0k (10%)`, or `N/A` where the endpoint did not say. */
  context: string;
  /** `↑ 12.3k · ↓ 1.2k`, the terminal footer's pair. */
  tokens: string;
  cost: string;
  /** `N/A` when the endpoint did not report any cache use. */
  cache: string;
}

/** The context numbers of the terminal's footer, for whoever shows them. */
export function contextUsage(session: Pick<Session, 'meters'>): ContextUsage {
  const meters = session.meters;
  const percent = contextPercent(meters?.contextInput, meters?.contextWindow);
  const level =
    percent === null
      ? ''
      : percent >= 90
        ? 'full'
        : percent >= 70
          ? 'high'
          : '';
  const cache =
    meters?.cache ??
    (meters && meters.input
      ? `${((Math.min(meters.cacheRead, meters.input) / meters.input) * 100).toFixed(1)}%`
      : 'N/A');
  const context =
    meters && meters.contextInput !== null
      ? meters.contextWindow
        ? `${formatTokens(meters.contextInput)} / ${formatWindow(meters.contextWindow)} (${Math.round(percent ?? 0)}%)`
        : `${formatTokens(meters.contextInput)} / N/A`
      : 'N/A';
  return {
    percent,
    level,
    context,
    tokens: meters
      ? `↑ ${meters.inputUnknown ? 'N/A' : formatTokens(meters.input)} · ↓ ${formatTokens(meters.output)}`
      : 'N/A',
    cost: meters?.cost ?? 'N/A',
    cache,
  };
}
