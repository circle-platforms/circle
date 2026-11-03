import type {
  KnowledgeSyncView,
  KnowledgeShareRefusal,
} from '../../../../src/knowledge/desktop-contract';
import { shownTime } from './time';
import { t } from '../i18n';
const text = (value: unknown): string =>
  typeof value === 'string' && value.trim().length > 0 ? value : '';
/** Any refusal the host passed on: the server's own explanation and fix, shown as given. */
export function knowledgeShareRefusal(
  value: unknown,
): KnowledgeShareRefusal | undefined {
  const refusal = (value as { shareRefusal?: unknown } | undefined)
    ?.shareRefusal as Record<string, unknown> | undefined;
  if (!refusal || typeof refusal !== 'object' || Array.isArray(refusal))
    return undefined;
  return {
    code: text(refusal.code) || 'REFUSED',
    message: text(refusal.message),
    fix: text(refusal.fix),
  };
}
/**
 * The server answered a share with a refusal it did not explain: the host reports that as
 * a generic failure, and the share dialog says so instead of guessing a reason.
 */
export function unexplainedShareRefusal(
  error: unknown,
): KnowledgeShareRefusal | undefined {
  const code = error instanceof Error ? error.message : String(error);
  return /knowledge-(share-rejected|remote-unavailable)/.test(code)
    ? { code: 'REFUSED', message: '', fix: '' }
    : undefined;
}
/** Whether a sync server connection is bound, whatever the server is. */
export function knowledgeServerBound(status?: KnowledgeSyncView): boolean {
  return status?.bound ?? Boolean(status?.server);
}
export function knowledgeStatusText(status?: KnowledgeSyncView): string {
  if (!knowledgeServerBound(status)) return t('sync server not connected');
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
/** The sidebar line: the state, then the bound connection's own name. */
export function knowledgeSyncLine(status?: KnowledgeSyncView): string {
  if (
    !knowledgeServerBound(status) ||
    !status?.server ||
    status.mode === 'local' ||
    status.condition === 'local'
  )
    return knowledgeStatusText(status);
  return !status.clearing && status.condition === 'synced'
    ? t('connected · {name}', { name: status.server })
    : knowledgeStatusText(status) + ' · ' + status.server;
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
    return t('switch to sync to server before sharing to the team');
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
/** A confirmation names its action, and its success notice says what was done. */
export function knowledgeActionWords(
  action: string,
  options: { enabling?: boolean; replaces?: boolean } = {},
): { confirm: string; done: string } {
  switch (action) {
    case 'share':
      return options.replaces
        ? { confirm: t('confirm replace'), done: t('shared to team') }
        : { confirm: t('confirm share to team'), done: t('shared to team') };
    case 'delete':
      return { confirm: t('confirm delete'), done: t('deleted') };
    case 'resolve':
      return { confirm: t('confirm replace'), done: t('conflict resolved') };
    case 'create-entry':
    case 'create-memory':
    case 'create-folder':
      return { confirm: t('confirm create'), done: t('created') };
    case 'move':
      return { confirm: t('confirm move'), done: t('moved') };
    case 'enabled':
    case 'pack-enabled':
      return options.enabling
        ? { confirm: t('confirm enable'), done: t('enabled') }
        : { confirm: t('confirm disable'), done: t('disabled') };
    case 'install':
      return { confirm: t('confirm install'), done: t('files installed') };
    case 'register-pack':
      return { confirm: t('confirm add'), done: t('manifest added') };
    case 'import':
      return { confirm: t('confirm import'), done: t('imported') };
    default:
      return { confirm: t('confirm save'), done: t('saved') };
  }
}
