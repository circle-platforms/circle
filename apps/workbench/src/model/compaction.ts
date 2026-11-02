import {
  compactionUsage,
  type CompactionSnapshot,
} from '../../../../src/compaction';
import { t } from '../i18n';
import { formatTokens } from './format';

export function compactionStageText(state: CompactionSnapshot): string {
  if (state.stage === 'saving') return t('compacting');
  if (state.stage === 'recovering')
    return t('recovering {done}/{total}', { done: state.recoveries, total: 8 });
  const counts = {
    done: state.completed,
    total: Math.max(state.completed, state.total),
  };
  return state.stage === 'merging'
    ? t('merging {done}/{total}', counts)
    : t('compacting {done}/{total}', counts);
}
export function compactionOutcomeText(state: CompactionSnapshot): string {
  const unreported = state.unknownCalls
    ? ' · ' + t('some usage unreported')
    : '';
  const usage = state.trigger === 'tool' ? ' · ' + compactionUsage(state) : '';
  if (state.status === 'succeeded') {
    const values = {
      before: formatTokens(state.tokensBefore ?? 0),
      after: formatTokens(state.tokensAfter ?? 0),
      n: state.summarized ?? 0,
    };
    return (
      (state.trigger === 'tool'
        ? t('compacted · ~{before} → ~{after} · {n} messages', values)
        : t('auto-compacted · ~{before} → ~{after} · {n} messages', values)) +
      usage +
      unreported
    );
  }
  if (state.status === 'cancelled' || state.status === 'interrupted')
    return (
      t('compaction interrupted; completed parts saved') + usage + unreported
    );
  const ownErrors: Record<string, () => string> = {
    'request does not fit the model context budget': () =>
      t('request does not fit the model context budget'),
    'requested output exceeds the model output limit': () =>
      t('requested output exceeds the model output limit'),
    'requested output exceeds the endpoint limit': () =>
      t('requested output exceeds the endpoint limit'),
    'model context leaves no room for a usable summary': () =>
      t('model context leaves no room for a usable summary'),
    'model context cannot fit the summary instructions and one history fragment':
      () =>
        t(
          'model context cannot fit the summary instructions and one history fragment',
        ),
    'model context cannot fit the summary instructions': () =>
      t('model context cannot fit the summary instructions'),
    'summary did not shrink to its target': () =>
      t('summary did not shrink to its target'),
    'summary attempted to call a tool': () =>
      t('summary attempted to call a tool'),
    'summary was empty': () => t('summary was empty'),
    'conversation changed during compaction': () =>
      t('conversation changed during compaction'),
    'summary boundary is no longer on the active branch': () =>
      t('summary boundary is no longer on the active branch'),
    'summary history does not match raw conversation': () =>
      t('summary history does not match raw conversation'),
    'session changed in another process': () =>
      t('session changed in another process'),
  };
  const message =
    ownErrors[state.error ?? '']?.() ??
    (state.failureCode === 'context_limit'
      ? t('model context window exhausted; response incomplete')
      : state.failureCode === 'output_limit'
        ? t('model output limit reached; response incomplete')
        : state.failureCode === 'filtered'
          ? t('model response was filtered')
          : state.failureCode === 'missing_finish'
            ? t('model response ended without a complete finish signal')
            : state.failureCode === 'empty_response'
              ? t('model returned an empty response')
              : state.failureCode === 'paused'
                ? t('model response paused before completion')
                : state.failureCode === 'unknown_finish'
                  ? t('model response ended with an unknown finish reason')
                  : state.failureCode === 'repetition_stopped'
                    ? t(
                        'model response stopped after repeating; response incomplete',
                      )
                    : state.error === 'compaction recovery budget exhausted'
                      ? t('compaction recovery budget exhausted')
                      : (state.error ?? t('summary did not complete')));
  return (
    '✖ ' + t('compaction failed: {message}', { message }) + usage + unreported
  );
}
