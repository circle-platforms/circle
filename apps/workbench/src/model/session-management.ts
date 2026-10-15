import type { Session, WorkbenchSnapshot, Workspace } from './types';

/**
 * A session the sidebar and the session list should show. A click on new session
 * used to leave a row with the placeholder title and no messages; those stay hidden.
 */
export function sessionHasContent(session: Session): boolean {
  return (
    session.state === 'waiting' ||
    session.queue.length > 0 ||
    session.messages.some((message) => message.role !== 'notice') ||
    (session.title !== '' && session.title !== 'new session')
  );
}

/** Folders in the sidebar: opened projects stay, an empty no-project group does not. */
export function workspaceListed(
  workspace: Workspace,
  sessions: readonly Session[],
): boolean {
  const own = sessions.filter(
    (session) => session.workspaceId === workspace.id,
  );
  const visible = own.filter((session) => !session.archivedAt);
  if (workspace.kind === 'scratch') return visible.some(sessionHasContent);
  if (visible.some(sessionHasContent) || visible.length > 0) return true;
  return own.length === 0;
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
