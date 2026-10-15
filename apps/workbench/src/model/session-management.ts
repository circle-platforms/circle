import type { Message, Session, WorkbenchSnapshot, Workspace } from './types';

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
 * Folders in the sidebar. A group appears only when a session in it has
 * something to show. Opening a folder does not create a session, so the group
 * appears with the first message. The home project menu is separate and still
 * lists the folder.
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
