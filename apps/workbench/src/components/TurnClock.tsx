import { useEffect, useState } from 'react';
import type { Session } from '../model/types';
import { formatBusyElapsed, formatTokens } from '../model/format';
import { t } from '../i18n';

// What a retry is for (src/tui/turn_status.ts RETRY_CAUSE), then `3/10`.
const RETRIES: Record<string, () => string> = {
  timeout: () => t('timeout'),
  'network error': () => t('network error'),
  'server error': () => t('server error'),
  'rate limited': () => t('rate limited'),
  'endpoint error': () => t('endpoint error'),
  error: () => t('error'),
};
const VERBS: Record<string, () => string> = {
  thinking: () => t('thinking'),
  considering: () => t('considering'),
  analyzing: () => t('analyzing'),
  brewing: () => t('brewing'),
  pondering: () => t('pondering'),
  cogitating: () => t('cogitating'),
  reflecting: () => t('reflecting'),
  processing: () => t('processing'),
  evaluating: () => t('evaluating'),
  examining: () => t('examining'),
};
function retryText(retry: string) {
  const match = retry.match(/^(.*) (\d+\/\d+)$/);
  if (!match) return retry;
  const cause = RETRIES[match[1]!]?.() ?? match[1]!;
  return t('retrying {cause} {attempt}', { cause, attempt: match[2]! });
}

/**
 * How long the turn under way has run, and the tokens its finished requests reported
 * (`12.4s · ↓ 1.9k tokens`), on its tools' row as Claude's desktop application shows it.
 * Time spent waiting for you is left out.
 */
export function TurnClock({ turn }: { turn: NonNullable<Session['turn']> }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 160);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, now - turn.startedAt - turn.waited) / 1000;
  return (
    <span className="turn-clock" aria-live="off" data-testid="turn-clock">
      {[
        ...(turn.verb ? [VERBS[turn.verb.toLowerCase()]?.() ?? turn.verb] : []),
        ...(turn.retry ? [retryText(turn.retry)] : []),
        formatBusyElapsed(seconds),
        // An endpoint gives a request's tokens when it ends: none until then
        ...(turn.tokens
          ? [t('↓ {tokens} tokens', { tokens: formatTokens(turn.tokens) })]
          : []),
      ].join(' · ')}
    </span>
  );
}
