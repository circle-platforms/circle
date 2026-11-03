import type {
  KnowledgeSyncView,
  KnowledgeShareRefusal,
} from '../../../../src/knowledge/desktop-contract';
import { shownTime } from './time';
import { t } from '../i18n';
export function knowledgeShareRefusal(
  value: unknown,
): KnowledgeShareRefusal | undefined {
  const refusal = (
    value as { shareRefusal?: KnowledgeShareRefusal } | undefined
  )?.shareRefusal;
  return refusal?.code === 'SHARE_UPLOAD_UNSIGNED' &&
    typeof refusal.message === 'string' &&
    typeof refusal.fix === 'string'
    ? refusal
    : undefined;
}
export function knowledgeHubBound(status?: KnowledgeSyncView): boolean {
  return status?.bound ?? Boolean(status?.server);
}
export function knowledgeStatusText(status?: KnowledgeSyncView): string {
  if (!knowledgeHubBound(status)) return t('Hub not connected');
  if (!status?.server) return t('only on this device');
  if (status.clearing) return t('waiting for cleanup');
  if (status.condition === 'local') return t('only on this device');
  switch (status.condition) {
    case 'synced':
      return t('synced');
    case 'pending':
    case 'paused':
      return t('waiting to sync');
    case 'offline':
      return t('cannot connect');
    case 'login-required':
      return t('sign in required');
    case 'conflicted':
      return t('conflicts');
    default:
      return t('sync incomplete');
  }
}
export function knowledgeError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code.includes('knowledge-preview-unavailable'))
    return t('knowledge requires the desktop runtime');
  if (code.includes('knowledge-changed'))
    return t('knowledge changed; reload and try again');
  if (code.includes('knowledge-credential-rejected'))
    return t('this content contains credentials or could not be inspected');
  if (code.includes('knowledge-limit'))
    return t('this content exceeds the knowledge or memory limit');
  if (code.includes('knowledge-read-only'))
    return t('finish the turn in an editable conversation first');
  if (code.includes('knowledge-preview-expired'))
    return t('this preview expired; check again before confirming');
  if (code.includes('knowledge-share-local'))
    return t('switch to Sync to Hub before sharing to the team');
  if (code.includes('knowledge-share-waiting'))
    return t('sync this version before sharing to the team');
  if (code.includes('knowledge-share-unverified'))
    return t('the source must be verified before sharing to the team');
  if (code.includes('knowledge-configured-credential'))
    return t(
      'update this MCP connection’s secret or header, then select it again',
    );
  if (code.includes('knowledge-resolve-first'))
    return t('resolve the conflict before changing this item');
  if (code.includes('knowledge-share-rejected'))
    return t('the team share was not accepted; check its sources and retry');
  return t('knowledge could not be opened; reload and try again');
}

/** Display hierarchy only; the host's slash path remains an opaque navigation value. */
export function knowledgeLocation(
  path: string,
  scope: 'personal' | 'team' | 'shared',
  inspector = false,
): string {
  const parts = path.split('/').filter(Boolean);
  if (!parts.length && !inspector) return '';
  return [
    scope === 'personal'
      ? t('mine')
      : scope === 'team'
        ? t('team')
        : t('shared with me'),
    ...parts,
  ].join(' › ');
}
export function knowledgeUpdated(at?: string | null, now = new Date()): string {
  if (!at || Number.isNaN(Date.parse(at))) return t('update time unknown');
  return new Date(at).toDateString() === now.toDateString()
    ? t('updated today at {time}', { time: shownTime(at, now) })
    : t('last changed {time}', { time: shownTime(at, now) });
}
