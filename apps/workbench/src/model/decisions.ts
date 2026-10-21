import { t } from '../i18n/index.ts';
import { requestReason } from './reasons.ts';

/** A recorded approval as the page shows it: the tool, then why it asked. */
export function recordedTitle(item: {
  title: string;
  kind?: string;
  target?: string;
  tool?: string;
  reason?: string;
}): string {
  if (item.kind === 'hooks')
    return [t('project hooks need approval'), item.target]
      .filter(Boolean)
      .join(' · ');
  if (item.tool && item.reason)
    return `${item.tool} · ${requestReason(item.reason)}`;
  const parts = item.title.split(' · ');
  if (parts.length === 2 && parts[0] && parts[1])
    return `${parts[0]} · ${requestReason(parts[1])}`;
  return item.title;
}

/** The stored answer (`approve`, `always`, `reject: …`) in interface words. */
export function recordedDecision(decision?: string, kind?: string): string {
  if (!decision) return '';
  if (kind === 'hooks')
    return decision === 'approve'
      ? t('approve these hooks')
      : decision === 'skip'
        ? t('skip')
        : recordedDecision(decision);
  if (decision === 'approve') return t('allow once');
  if (decision === 'always') return t('allow for this session');
  if (decision === 'reject') return t('reject');
  if (decision === 'prefix') return t('allow command prefix');
  if (decision === 'cancelled') return t('cancelled');
  if (decision.startsWith('reject: '))
    return `${t('reject')}: ${decision.slice('reject: '.length)}`;
  return decision;
}
