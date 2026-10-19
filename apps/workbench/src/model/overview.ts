import type { PullRequestOverview } from '../../../desktop/src/workspace/pulls-types';
import { planComplete } from '../../../../src/plan_state';
import { agentState, isAgentActive } from './activity';
import { sidebarTasks, type SidebarTask } from './session-management';
import type { AgentRecord, Interaction, Session, Todo } from './types';

/**
 * A subagent's title is `<type>: <what Circle sent it to do>`, and its name and
 * description both hold that title; the two read apart. A task keeps its own name.
 */
export function agentLabel(
  agent: Pick<AgentRecord, 'name' | 'description' | 'task'>,
): { name: string; detail: string } {
  const tidy = (value: string) => value.replace(/\s+/g, ' ').trim();
  if (agent.task) return { name: agent.name, detail: '' };
  const match = /^([\w.-]+): (.+)$/s.exec(agent.name);
  if (match) return { name: match[1]!, detail: tidy(match[2]!) };
  const detail =
    agent.description && agent.description !== agent.name
      ? tidy(agent.description)
      : '';
  return { name: agent.name, detail };
}

export interface OverviewProgress {
  plan: { done: number; total: number; current: Todo | undefined } | null;
  /** Subagents that are working or waiting for the person; finished ones are not "in progress". */
  agents: AgentRecord[];
  /** Tasks that are queued, working, waiting, or need the person's review. */
  tasks: SidebarTask[];
}

const TASK_IN_PROGRESS = new Set([
  'queued',
  'preparing',
  'running',
  'waiting',
  'cancelling',
  'needs_review',
]);

/** What the "in progress" card lists for one conversation. */
export function overviewProgress(
  session: Pick<Session, 'id' | 'todos'>,
  sessions: readonly Session[],
  agents: readonly AgentRecord[],
): OverviewProgress {
  const todos = session.todos ?? [];
  // A plan whose every step is done has no step under way: it is not in progress, as
  // the terminal hides it too. Its steps stay in the session.
  const plan =
    todos.length && !planComplete(todos)
      ? {
          done: todos.filter((todo) => todo.status === 'completed').length,
          total: todos.length,
          current:
            todos.find((todo) => todo.status === 'running') ??
            todos.find((todo) => todo.status === 'pending'),
        }
      : null;
  return {
    plan,
    agents: agents.filter(
      (agent) =>
        agent.sessionId === session.id && !agent.task && isAgentActive(agent),
    ),
    tasks: (sidebarTasks(sessions, agents).get(session.id) ?? []).filter(
      (task) => TASK_IN_PROGRESS.has(agentState(task.agent)),
    ),
  };
}

/** The request an agent is waiting on, so its row can show what it asked to do. */
export function pendingFor(
  agentId: string,
  interactions: readonly Interaction[],
): Interaction | undefined {
  return interactions.find(
    (item) => item.status === 'pending' && item.origin?.agent === agentId,
  );
}

export type ChangeLetter = 'M' | 'A' | 'D';

/** The files this conversation changed, for the outputs card and the files' marks. */
export function outputRows(
  changes: Session['changes'],
  root?: string,
): { path: string; name: string; folder: string; letter: ChangeLetter }[] {
  return (changes ?? []).map((change) => {
    const path = relativeTo(change.path, root);
    const parts = path.split(/[\\/]/);
    return {
      path,
      name: parts.at(-1) ?? path,
      folder: parts.slice(0, -1).join('/'),
      letter:
        change.kind === 'added' ? 'A' : change.kind === 'deleted' ? 'D' : 'M',
    };
  });
}

/**
 * A path as the workspace names it. Both slashes are read alike, and a Windows path is
 * compared without regard to case (its drive letter may be either), so a Windows path
 * under a Windows root still comes out relative. What is not inside the root comes back
 * with its own letters.
 */
export function relativeTo(path: string, root?: string): string {
  const target = path.replaceAll('\\', '/');
  if (!root) return target;
  const base = root.replaceAll('\\', '/').replace(/\/+$/, '') + '/';
  const windows = /^[a-z]:/i.test(target) || /^[a-z]:/i.test(base);
  const inside = windows
    ? target.toLowerCase().startsWith(base.toLowerCase())
    : target.startsWith(base);
  return inside ? target.slice(base.length) : target;
}

export type PullRequestAction = 'create' | 'update';

/**
 * The one button the changes card has. A branch without an open pull request offers
 * to create one when it has anything to put in it; a branch with one offers to bring
 * it up to date when something is not on GitHub yet. On the default branch the work is
 * what is not committed or not pushed, and the create-pr skill moves it to a branch of
 * its own first. A detached HEAD has no branch to offer.
 */
export function pullRequestAction(
  overview: PullRequestOverview | undefined,
): PullRequestAction | null {
  if (!overview || overview.access !== 'ready') return null;
  const { git, current } = overview;
  if (!git.branch) return null;
  if (git.branch === git.defaultBranch)
    return git.files > 0 || git.unpushed > 0 ? 'create' : null;
  if (current) return git.files > 0 || git.unpushed > 0 ? 'update' : null;
  return git.files > 0 || git.ahead > 0 ? 'create' : null;
}
