import { storedGitHubStatusNotice } from '../../../../src/runtime_notice';
import type { HookNotice } from '../../../../src/hooks';
import type { Message, WorkbenchSnapshot } from './types';
import { t } from '../i18n';

/** Circle's own failure words. What a hook or a program wrote stays as it was written. */
function hookReason(reason: string | undefined): string {
  const text = reason?.trim() ?? '';
  if (!text) return '';
  // The words of the format before this one, in conversations from then
  if (text === 'hook timed out') return t('hook timed out');
  if (text === 'hook output is not JSON') return t('hook output is not JSON');
  const old = /^hook exited (\d+)$/.exec(text);
  if (old?.[1]) return t('hook exited {code}', { code: old[1] });
  const timed = /^timed out after ([\d.]+)s$/.exec(text);
  if (timed?.[1])
    return t('hook timed out after {seconds}s', { seconds: timed[1] });
  const exited = /^exited (\S+?)(?:: (.*))?$/s.exec(text);
  if (exited?.[1])
    return (
      t('hook exited {code}', { code: exited[1] }) +
      (exited[2] ? `: ${exited[2]}` : '')
    );
  const unreadable = /^output is not JSON(?:: (.*))?$/s.exec(text);
  if (unreadable)
    return (
      t('hook output is not JSON') + (unreadable[1] ? `: ${unreadable[1]}` : '')
    );
  return text;
}

/** The transcript line for a hook. The hook's own reason is not translated. */
export function formatHookNotice(notice: HookNotice): string {
  // A project hooks file's approval card, skipped in a conversation from before hooks ran on folder trust
  if ((notice as { kind: string }).kind === 'changed')
    return (
      t('project hooks need approval') +
      (notice.name ? ` · ${notice.name}` : '')
    );
  // What the hook wrote for the person (`user_message`) goes in place of its reason
  const reason = hookReason(notice.message || notice.reason);
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
    case 'message':
      return t('hook {name}', { name: notice.name ?? t('hook') }) + tail;
    case 'blocked':
      return (
        (notice.tool === 'prompt'
          ? t('hook blocked the message')
          : notice.tool === 'compaction'
            ? t('hook blocked the compaction')
            : t('hook blocked stop')) + tail
      );
    case 'stopped':
      return t('hook stopped the turn') + tail;
    case 'limit':
      return (
        t('hook stop limit reached') + (notice.name ? ` · ${notice.name}` : '')
      );
    case 'failed':
      return t('hook failed') + (notice.name ? ` · ${notice.name}` : '') + tail;
    case 'active':
      return t('hooks active · {count}', { count: notice.count ?? 0 }) + tail;
    case 'untrusted':
      return t('project hooks need a trusted folder');
    default:
      // A notice of a kind this window does not know yet, such as a project hooks file's approval in an older
      // conversation: its own words, as stored
      return notice.name ?? notice.reason ?? t('hook');
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

/** The notice for a desktop runtime that stopped: why, its exit code, and
 * whether it is starting again. Undefined while it runs. A runtime Circle ended
 * because it stopped handling files has no code worth saying: it is the kill's. */
export function runtimeStoppedNotice(
  runtime: WorkbenchSnapshot['runtime'],
): string | undefined {
  const stopped = runtime?.connected === false ? runtime.stopped : undefined;
  if (!stopped) return undefined;
  const what =
    stopped.reason === 'out-of-memory'
      ? t('Circle runtime ran out of memory')
      : stopped.reason === 'crashed'
        ? t('Circle runtime crashed')
        : stopped.reason === 'stalled'
          ? t('Circle runtime stopped handling files')
          : t('Circle runtime exited');
  const code = stopped.reason === 'stalled' ? '' : ` (${stopped.code})`;
  return `${what}${code} · ${
    stopped.restarting ? t('restarting…') : t('restart it from the sidebar')
  }`;
}
