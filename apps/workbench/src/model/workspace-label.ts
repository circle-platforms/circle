import type { AgentRecord, Workspace } from './types';
import { t } from '../i18n';
const GENERATED_TASK_DIRECTORY = /^[a-f0-9]{24}-\d+$/i;
/** Only an actual projected task owner can identify a generated workspace.
 * Ordinary user folders, paths, permissions and session routes remain unchanged. */
export function workspaceLabel(
  workspace: Pick<Workspace, 'name'> & Partial<Pick<Workspace, 'id' | 'kind'>>,
  agents: AgentRecord[] = [],
): string {
  if (workspace.kind === 'scratch' || workspace.name === 'unscoped')
    return t('work without a project');
  if (!GENERATED_TASK_DIRECTORY.test(workspace.name)) return workspace.name;
  const owners = agents.filter(
    (agent) =>
      agent.workspaceId === workspace.id &&
      agent.resourceSessionId === agent.id &&
      !!agent.task,
  );
  if (!owners.length) return workspace.name;
  const names = [
    ...new Set(
      owners
        .map((agent) => agent.name.trim())
        .filter((name) => !!name && !GENERATED_TASK_DIRECTORY.test(name)),
    ),
  ];
  return names.length
    ? t('agent workspace: {name}', { name: names.join(', ') })
    : t('agent workspace');
}
