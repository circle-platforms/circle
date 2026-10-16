import { storedGitHubStatusNotice } from '../../../../src/runtime_notice';
import type { Message } from './types';
import { t } from '../i18n';
/** Translate only a persisted host-authored enum; identical content stays content. */
export function formatRuntimeNotice(
  message: Pick<Message, 'role' | 'text' | 'runtimeNotice'>,
): string {
  const notice =
    message.role === 'notice' &&
    storedGitHubStatusNotice(message.text, message.runtimeNotice);
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
