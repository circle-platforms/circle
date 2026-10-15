import { t } from '../i18n/index.ts';

/**
 * The name shown for a folder. The no-project group is `unscoped` in stored
 * data (and `scratch` once that kind exists). Both read as the same words.
 */
export function workspaceLabel(workspace: {
  name: string;
  kind?: string;
}): string {
  if (workspace.kind === 'scratch' || workspace.name === 'unscoped')
    return t('work without a project');
  return workspace.name;
}
