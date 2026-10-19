import {
  plainPreview,
  shortSessionId,
} from '../../../../src/tui/session_label.ts';
import { t } from '../i18n/index.ts';
import type {
  AgentRecord,
  Message,
  Session,
  WorkbenchSnapshot,
  Workspace,
} from './types.ts';
import { sessionTitle } from './state.ts';
import { fullTime } from './time.ts';

/** User and assistant text the global search indexes. Tools and notices are not history. */
export function historyMessages(session: Session): Message[] {
  return session.messages.filter(
    (message) =>
      (message.role === 'user' || message.role === 'assistant') &&
      message.text.trim() !== '',
  );
}

/**
 * A session the sidebar, the session list, search and counts should show.
 * A row with the placeholder title and no messages is not one of these.
 */
export function sessionHasContent(session: Session): boolean {
  return (
    session.state === 'waiting' ||
    session.queue.length > 0 ||
    session.messages.some((message) => message.role !== 'notice') ||
    (session.title !== '' && session.title !== 'new session')
  );
}

/** Sessions Ctrl+K, the session list and counts may name. Placeholders are left out. */
export function visibleSessions(sessions: readonly Session[]): Session[] {
  return sessions.filter(sessionHasContent);
}

/**
 * A workspace that has a session worth showing. Opening a folder does not
 * create a session, so this becomes true with the first message. The home
 * project menu is separate and still lists every project folder.
 */
export function workspaceListed(
  workspace: Workspace,
  sessions: readonly Session[],
): boolean {
  return sessions.some(
    (session) =>
      session.workspaceId === workspace.id &&
      !session.archivedAt &&
      sessionHasContent(session),
  );
}

/**
 * Project groups under the recent list. A scratch workspace is not a group:
 * its sessions stay in recent and in search.
 */
export function sidebarProjects(
  workspaces: readonly Workspace[],
  sessions: readonly Session[],
): Workspace[] {
  return workspaces.filter(
    (workspace) =>
      workspace.kind !== 'scratch' && workspaceListed(workspace, sessions),
  );
}

/** How many recent rows show before "show more". Project groups keep their own count. */
export const RECENT_SHOWN = 5;
/**
 * When the session last had a message. Opening, selecting, or renaming does
 * not count: those do not change a message time.
 */
const parsedMessageTimes = new WeakMap<
  Message,
  { at: string; value: number }
>();
const messageActivity = new WeakMap<
  Session['messages'],
  { times: string[]; at: string }
>();

export function sessionActivityAt(session: Session): string {
  const messages = session.messages;
  const previous = messageActivity.get(messages);
  // Runtime snapshots use replacement arrays, but preview/custom callers can mutate
  // them. Validate every timestamp; array identity or the last message is not a version.
  if (
    previous &&
    previous.times.length === messages.length &&
    messages.every((message, index) => message.at === previous.times[index])
  )
    return previous.at || session.updatedAt;
  let best = Number.NEGATIVE_INFINITY;
  let at = '';
  const times: string[] = [];
  for (const message of messages) {
    const stamp = message.at;
    times.push(stamp);
    let cached = parsedMessageTimes.get(message);
    if (!cached || cached.at !== stamp) {
      cached = { at: stamp, value: Date.parse(stamp) };
      parsedMessageTimes.set(message, cached);
    }
    if (Number.isFinite(cached.value) && cached.value >= best) {
      best = cached.value;
      at = stamp;
    }
  }
  messageActivity.set(messages, { times, at });
  return at || session.updatedAt;
}

export type ActivityAge =
  | { kind: 'raw'; text: string }
  | { kind: 'just now' }
  | { kind: 'minutes'; n: number }
  | { kind: 'hours'; n: number }
  | { kind: 'days'; n: number };

/**
 * How long ago a message time is. A time that is not an instant stays as written.
 * The count rounds down, as the terminal's `4h` does for 4 hours 45 minutes:
 * `sessionAge` in `src/tui/slash_handlers.ts`.
 */
export function activityAge(at: string, now = new Date()): ActivityAge {
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return { kind: 'raw', text: at };
  const minutes = Math.floor(Math.max(0, now.getTime() - parsed) / 60000);
  if (minutes < 1) return { kind: 'just now' };
  if (minutes < 60) return { kind: 'minutes', n: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { kind: 'hours', n: hours };
  return { kind: 'days', n: Math.floor(hours / 24) };
}

/**
 * Project groups under recent, in name order. Recent already lists what is new,
 * so a message does not jump a folder above the others.
 */
export function orderedProjects(
  workspaces: readonly Workspace[],
  sessions: readonly Session[],
): Workspace[] {
  return sidebarProjects(workspaces, sessions).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/**
 * The project folders the sidebar groups, plus one more: a project whose home
 * composer is open with no session yet. A new session aims its project before it
 * exists, and deleting a folder's last session leaves the home open on it; in both
 * the folder stays on the bar, awaiting the first message.
 */
export function projectFolders(
  workspaces: readonly Workspace[],
  sessions: readonly Session[],
  aimedId: string | null,
): Workspace[] {
  const listed = orderedProjects(workspaces, sessions);
  if (!aimedId || listed.some((item) => item.id === aimedId)) return listed;
  const aimed = workspaces.find(
    (item) => item.id === aimedId && item.kind !== 'scratch',
  );
  return aimed ? [...listed, aimed] : listed;
}

/**
 * Where the app goes after a session was deleted: the session the runtime moved
 * to when it holds a conversation, else the home composer aimed at the deleted
 * session's project. An auto-made empty session is never a destination: the
 * person is drafting, and the first message reuses it.
 */
export function afterDeleteRoute(
  sessions: readonly Session[],
  activeSessionId: string,
  deletedWorkspaceId: string,
): { kind: 'session'; id: string } | { kind: 'home'; workspaceId: string } {
  const active = sessions.find((item) => item.id === activeSessionId);
  if (active && sessionHasContent(active))
    return { kind: 'session', id: active.id };
  return { kind: 'home', workspaceId: deletedWorkspaceId };
}

/**
 * A task the sidebar folds under the conversation that started it: the
 * worker's conversation, with its reviewer kept out of sight. `sessionIds`
 * holds every conversation of the task, so a request waiting in the reviewer
 * still marks the task.
 */
export interface SidebarTask {
  session: Session;
  agent: AgentRecord;
  sessionIds: string[];
}

/**
 * Which top conversation each task conversation belongs to. A task is an
 * agent with a task record whose own session is the child; its `sessionId`
 * is the conversation that started it. A chain of tasks resolves to its top
 * conversation. A task whose owner is gone or archived is not folded, so it
 * stays reachable in the sidebar.
 */
export function taskOwners(
  sessions: readonly Session[],
  agents: readonly AgentRecord[],
): Map<string, string> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const direct = new Map<string, string>();
  for (const agent of agents) {
    if (
      !agent.task ||
      agent.resourceSessionId !== agent.id ||
      agent.sessionId === agent.id ||
      !byId.has(agent.id) ||
      !byId.has(agent.sessionId)
    )
      continue;
    direct.set(agent.id, agent.sessionId);
  }
  const owners = new Map<string, string>();
  for (const child of direct.keys()) {
    let owner = direct.get(child)!;
    const seen = new Set([child]);
    while (direct.has(owner) && !seen.has(owner)) {
      seen.add(owner);
      owner = direct.get(owner)!;
    }
    if (seen.has(owner) || byId.get(owner)?.archivedAt) continue;
    owners.set(child, owner);
  }
  return owners;
}

/** Sessions that stand on their own in recent and in folders: task conversations fold under their owner. */
export function topLevelSessions(
  sessions: readonly Session[],
  agents: readonly AgentRecord[],
): Session[] {
  const owners = taskOwners(sessions, agents);
  return sessions.filter((session) => !owners.has(session.id));
}

/**
 * Folders that only hold task conversations: a task's own copy of the project. They are
 * reached through the task, never listed as projects of their own.
 */
export function taskWorkspaceIds(
  sessions: readonly Session[],
  agents: readonly AgentRecord[],
): Set<string> {
  const owners = taskOwners(sessions, agents);
  const tasks = new Set<string>();
  const own = new Set<string>();
  for (const session of sessions)
    (owners.has(session.id) ? tasks : own).add(session.workspaceId);
  for (const id of own) tasks.delete(id);
  return tasks;
}

/**
 * The tasks under each top conversation, one entry per task: the worker's
 * conversation, or the reviewer's when no worker is listed. Archived and
 * empty task conversations stay out. Newest activity first.
 */
export function sidebarTasks(
  sessions: readonly Session[],
  agents: readonly AgentRecord[],
): Map<string, SidebarTask[]> {
  const owners = taskOwners(sessions, agents);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const tasks = new Map<string, Map<string, SidebarTask>>();
  for (const agent of agents) {
    const owner = owners.get(agent.id);
    const session = byId.get(agent.id);
    if (!owner || !session || !agent.task) continue;
    if (session.archivedAt || !sessionHasContent(session)) continue;
    const group = tasks.get(owner) ?? new Map<string, SidebarTask>();
    tasks.set(owner, group);
    const key = `${agent.sessionId}\n${agent.task.id}`;
    const known = group.get(key);
    if (!known) {
      group.set(key, { session, agent, sessionIds: [session.id] });
      continue;
    }
    known.sessionIds.push(session.id);
    // The worker names the task; a retry's newer worker replaces the older one.
    const knownReviewer = known.agent.task?.role === 'reviewer';
    const reviewer = agent.task.role === 'reviewer';
    if (
      (knownReviewer && !reviewer) ||
      (knownReviewer === reviewer &&
        (Date.parse(sessionActivityAt(session)) || 0) >
          (Date.parse(sessionActivityAt(known.session)) || 0))
    ) {
      known.session = session;
      known.agent = agent;
    }
  }
  const activity = (task: SidebarTask) =>
    Date.parse(sessionActivityAt(task.session)) || 0;
  return new Map(
    [...tasks].map(([owner, group]) => [
      owner,
      [...group.values()].sort(
        (a, b) =>
          activity(b) - activity(a) || a.session.id.localeCompare(b.session.id),
      ),
    ]),
  );
}

/** Newest sessions from every project and from no project. Archived and empty rows stay out. */
export function recentSessions(sessions: readonly Session[]): Session[] {
  const visible = visibleSessions(sessions).filter(
    (session) => !session.archivedAt,
  );
  const activity = new Map(
    visible.map((session) => [
      session,
      Date.parse(sessionActivityAt(session)) || 0,
    ]),
  );
  return visible.sort(
    (a, b) => activity.get(b)! - activity.get(a)! || a.id.localeCompare(b.id),
  );
}

/** The folder name for a recent row's hover. A session that is not in a project has none. */
export function projectTag(
  session: Session,
  workspaces: readonly Workspace[],
): string | undefined {
  const workspace = workspaces.find((item) => item.id === session.workspaceId);
  if (!workspace || workspace.kind === 'scratch') return undefined;
  return workspace.name;
}

/**
 * What a recent row says on hover or focus: the folder, when there is one,
 * how long since the last message, and that instant in full. The row itself
 * shows only the title.
 */
export function recentDetails(
  session: Session,
  workspaces: readonly Workspace[],
  now = new Date(),
): { project?: string; age: ActivityAge; absolute?: string } {
  const at = sessionActivityAt(session);
  const age = activityAge(at, now);
  return {
    project: projectTag(session, workspaces),
    age,
    absolute: age.kind === 'raw' ? undefined : fullTime(at),
  };
}

/** A deletion is under way. One whose cleanup failed waits for the session to be deleted
 * again, which retries the cleanup. */
export function deletionUnderWay(session: Session): boolean {
  return session.lifecycle === 'deleting' && !session.deletionFailed;
}

/**
 * Why archive is unavailable, or nothing when it can be archived.
 * A running turn, a pending question and a live job each say so.
 */
export function archiveBlockReason(
  snapshot: WorkbenchSnapshot,
  session: Session,
): string | undefined {
  if (session.archivedAt) return undefined;
  if (session.lifecycle === 'deleting')
    return t('this session is being deleted');
  if (session.occupied) return t('open in another terminal; view only');
  if (session.state === 'waiting') return t('stop the turn before archiving');
  if (
    snapshot.interactions.some(
      (item) => item.sessionId === session.id && item.status === 'pending',
    )
  )
    return t('answer the pending request first');
  if (
    snapshot.jobs.some(
      (job) =>
        job.sessionId === session.id &&
        ['running', 'waiting'].includes(job.state),
    )
  )
    return t('stop the running job first');
  return undefined;
}

/** A shared title gains the start of the reply, or the short id, as /resume does. */
export function disambiguatedSessionTitle(
  session: Session,
  sessions: readonly Session[],
): string {
  const title = sessionTitle(session.title);
  const duplicates = sessions.filter(
    (item) => !item.archivedAt && sessionTitle(item.title) === title,
  );
  if (duplicates.length < 2) return title;
  const hint = (item: Session): string => {
    const reply = item.messages.find(
      (message) => message.role === 'assistant' && message.text.trim(),
    );
    const snippet = plainPreview(reply?.text ?? '');
    return snippet
      ? `${title} · ${snippet}`
      : `${title} · ${shortSessionId(item.id)}`;
  };
  const mine = hint(session);
  const shared = duplicates.filter((item) => hint(item) === mine).length;
  return shared < 2 ? mine : `${title} · ${shortSessionId(session.id)}`;
}

export function canArchiveSession(
  snapshot: WorkbenchSnapshot,
  session: Session,
): boolean {
  return (
    session.lifecycle !== 'deleting' &&
    !session.occupied &&
    session.state !== 'waiting' &&
    !snapshot.interactions.some(
      (item) => item.sessionId === session.id && item.status === 'pending',
    ) &&
    !snapshot.jobs.some(
      (job) =>
        job.sessionId === session.id &&
        ['running', 'waiting'].includes(job.state),
    )
  );
}

export function workspaceSessions(
  snapshot: WorkbenchSnapshot,
  workspaceId: string,
  archived = false,
): Session[] {
  return snapshot.sessions.filter(
    (session) =>
      session.workspaceId === workspaceId &&
      Boolean(session.archivedAt) === archived,
  );
}
