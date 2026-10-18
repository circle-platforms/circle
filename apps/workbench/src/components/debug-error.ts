import { t } from '../i18n';

/** The debug panel's error line. A missing program names the file. */
export function shownDebugError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const missing = /debug target is missing: ([\s\S]+)$/.exec(message);
  if (missing)
    return t('debug target is missing: {path}', { path: missing[1] ?? '' });
  if (message.includes('developer tools are off'))
    return t('developer tools are off');
  return String(error);
}
