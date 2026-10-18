import { storedGitHubStatusNotice } from '../../../../src/runtime_notice';
import type { HookNotice } from '../../../../src/hooks';
import type { Message } from './types';
import { t } from '../i18n';

/** Circle's own failure words. A reason the hook wrote stays as it wrote it. */
function hookReason(reason: string | undefined): string {
  const text = reason?.trim() ?? '';
  if (!text) return '';
  if (text === 'hook timed out') return t('hook timed out');
  if (text === 'hook output is not JSON') return t('hook output is not JSON');
  const exited = /^hook exited (\d+)$/.exec(text);
  if (exited?.[1]) return t('hook exited {code}', { code: exited[1] });
  return text;
}

/** The transcript line for a hook. The hook's own reason is not translated. */
export function formatHookNotice(notice: HookNotice): string {
  const reason = hookReason(notice.reason);
  const tail = reason ? ` · ${reason}` : '';
  switch (notice.kind) {
    case 'denied':
      return t('hook denied {tool}', { tool: notice.tool ?? t('tool') }) + tail;
    case 'asked':
      return t('hook asked {tool}', { tool: notice.tool ?? t('tool') }) + tail;
    case 'allowed':
      return (
        t('hook allowed {tool}', { tool: notice.tool ?? t('tool') }) + tail
      );
    case 'output':
      return t('hook {name}', { name: notice.name ?? t('hook') }) + tail;
    case 'blocked':
      return t('hook blocked stop') + tail;
    case 'limit':
      return (
        t('hook stop limit reached') + (notice.name ? ` · ${notice.name}` : '')
      );
    case 'failed':
      return t('hook failed') + (notice.name ? ` · ${notice.name}` : '') + tail;
    case 'active':
      return t('hooks active · {count}', { count: notice.count ?? 0 }) + tail;
    case 'untrusted':
      return t('project hooks need trust');
  }
}
/** Translate only a persisted host-authored enum; identical content stays content. */
export function formatRuntimeNotice(
  message: Pick<Message, 'role' | 'text' | 'runtimeNotice' | 'hookNotice'>,
): string {
  const notice =
    message.role === 'notice' &&
    storedGitHubStatusNotice(message.text, message.runtimeNotice);
  if (message.role === 'notice' && message.hookNotice)
    return formatHookNotice(message.hookNotice);
  if (!notice) return message.text;
  switch (notice.state) {
    case 'connected':
      return t('GitHub connected');
    case 'disconnected':
      return t('GitHub disconnected');
    case 'authorizing':
      return t('GitHub authorization in progress');
    case 'error':
      return t('GitHub connection error');
  }
}
