import { t } from '../i18n/index.ts';

/** What a failed extension load says on screen. Paths stay as they are. */
export function extensionErrorText(error: string): string {
  const missing = /Cannot find module '([^']+)'/.exec(error);
  if (missing)
    return t('cannot find module {module}', { module: missing[1] ?? '' });
  return t('could not load the extension: {error}', { error });
}

/** The name in the top bar. A built-in page has its own word; a plugin page uses its title. */
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
      return platformTitle(page);
  }
}

/** Sidebar and search names for the hub pages. Unknown ids stay as written. */
export function platformTitle(id: string, fallback = id): string {
  switch (id) {
    case 'hub':
      return t('hub');
    case 'knowledge':
      return t('knowledge');
    case 'work':
      return t('work');
    case 'execution':
      return t('execution');
    case 'methods':
      return t('methods');
    default:
      return fallback;
  }
}

/** Descriptions shown on the extensions page for the paired hub pages. */
export function platformDescription(id: string): string | undefined {
  switch (id) {
    case 'hub':
      return t(
        'Hand work to a hub and follow it: the interface half of the bundled hub extension.',
      );
    case 'knowledge':
      return t(
        "each task's source, artifacts and evidence, by revision and SHA-256, and the server's own check.",
      );
    case 'work':
      return t(
        'tasks as the server holds them: their phase, what they wait on, and approvals bound to an input revision.',
      );
    case 'execution':
      return t(
        "operations the server's workers ran for these tasks, with the worker and fencing token that held the lease.",
      );
    case 'methods':
      return t(
        "the server's capability packs, at the versions it runs. Hand one a file of this workspace.",
      );
    default:
      return undefined;
  }
}
