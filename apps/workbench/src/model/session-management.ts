import type { Message, Session, WorkbenchSnapshot, Workspace } from './types';
import { fullTime, shownTime } from './time';

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

/** Newest sessions from every project and from no project. Archived and empty rows stay out. */
export function recentSessions(sessions: readonly Session[]): Session[] {
  return visibleSessions(sessions)
    .filter((session) => !session.archivedAt)
    .sort(
      (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
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
 * and when the session was last updated. The row itself shows only the title.
 */
export function recentDetails(
  session: Session,
  workspaces: readonly Workspace[],
  now = new Date(),
): { project?: string; relative: string; absolute?: string } {
  const relative = shownTime(session.updatedAt, now);
  const absolute = fullTime(session.updatedAt);
  return {
    project: projectTag(session, workspaces),
    relative,
    absolute: absolute && absolute !== relative ? absolute : undefined,
  };
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
