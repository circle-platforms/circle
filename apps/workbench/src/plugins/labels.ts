import { t } from '../i18n';

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
