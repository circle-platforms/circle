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
  // The worker names the copy; a reviewer only reads it.
  const workers = owners.filter((agent) => agent.task?.role !== 'reviewer');
  const names = [
    ...new Set(
      (workers.length ? workers : owners)
        .map((agent) => agent.name.trim())
        .filter((name) => !!name && !GENERATED_TASK_DIRECTORY.test(name)),
    ),
  ];
  // The generated folder name and the worktree are internals: say whose
  // isolated copy of the project this is.
  return names.length
    ? t('isolated copy for {name}', { name: names.join(', ') })
    : t('isolated task copy');
}
