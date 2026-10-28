import { t } from '../i18n/index.ts';

/** What a failed extension load says on screen. Paths stay as they are. */
export function extensionErrorText(error: string): string {
  const missing = /Cannot find module '([^']+)'/.exec(error);
  if (missing)
    return t('cannot find module {module}', { module: missing[1] ?? '' });
  return t('could not load the extension: {error}', { error });
}

/**
 * The name in the top bar. The sessions page has its own word; a plugin page keeps its
 * id. Every other page is a group of the settings dialog, which has no top bar of its own.
 */
export function shellPageTitle(page: string): string {
  return page === 'sessions' ? t('sessions') : page;
}
