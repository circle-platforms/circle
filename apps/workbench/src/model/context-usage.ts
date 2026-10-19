import { contextPercent, formatTokens, formatWindow } from './format';
import type { Session } from './types';

export interface ContextUsage {
  /** How full the window is after the last answer; null while either number is unknown. */
  percent: number | null;
  /** Orange from 70% and red from 90%. */
  level: '' | 'high' | 'full';
  /** `14.1k / 128.0k`, the tokens in the window after the last answer of the model's
   * window; `N/A` for what the endpoint did not say. */
  fill: string;
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
  const fill =
    meters && meters.contextInput !== null
      ? `${formatTokens(meters.contextInput)} / ${meters.contextWindow ? formatWindow(meters.contextWindow) : 'N/A'}`
      : 'N/A';
  return {
    percent,
    level,
    fill,
    cost: meters?.cost ?? 'N/A',
    cache,
  };
}
