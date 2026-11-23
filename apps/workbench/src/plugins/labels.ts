import { t } from '../i18n/index.ts';

export function extensionErrorText(error: string): string {
  const missing = /Cannot find module '([^']+)'/.exec(error);
  if (missing)
    return t('cannot find module {module}', { module: missing[1] ?? '' });
  return t('could not load the extension: {error}', { error });
}

const SHELL_PAGE_TITLES: Record<string, () => string> = {
  'remote-bot': () => t('my bot'),
  sessions: () => t('sessions'),
  knowledge: () => t('knowledge'),
  memory: () => t('memory'),
  workflows: () => t('workflows'),
};

export function shellPageTitle(page: string): string {
  return SHELL_PAGE_TITLES[page]?.() ?? page;
}
