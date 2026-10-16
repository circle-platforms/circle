import type { RuntimeExtension } from './types';
import { t } from '../i18n';

/** Only Circle's typed GitHub enum is interface text. Custom status is content. */
export function extensionStatusText(extension: RuntimeExtension): string {
  const text = extension.status?.text ?? '';
  const view = extension.view as
    { provider?: unknown; state?: unknown } | undefined;
  if (
    extension.name !== 'github' ||
    extension.scope !== 'bundled' ||
    view?.provider !== 'github' ||
    view.state !== text
  )
    return text;
  switch (view.state) {
    case 'disconnected':
      return t('GitHub login required');
    case 'connected':
      return t('GitHub connected');
    case 'authorizing':
      return t('waiting for GitHub authorization');
    case 'error':
      return t('GitHub connection error');
    default:
      return text;
  }
}
