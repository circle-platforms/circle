import { t } from '../i18n/index.ts';

/** What a failed extension load says on screen. Paths stay as they are. */
export function extensionErrorText(error: string): string {
  const missing = /Cannot find module '([^']+)'/.exec(error);
  if (missing)
    return t('cannot find module {module}', { module: missing[1] ?? '' });
  return t('could not load the extension: {error}', { error });
}

/** The name in the top bar. A built-in page has its own word; a plugin page keeps its id. */
export function shellPageTitle(page: string): string {
  switch (page) {
    case 'sessions':
      return t('sessions');
    case 'models':
      return t('models');
    case 'skills':
      return t('skills');
    case 'commands':
      return t('commands');
    case 'mcp':
      return t('mcp servers');
    case 'extensions':
      return t('extensions');
    case 'tools':
      return t('tools');
    case 'approvals':
      return t('approvals');
    case 'settings':
      return t('settings');
    case 'help':
      return t('help');
    default:
      return page;
  }
}
