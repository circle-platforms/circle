import type {
  Message,
  Session,
  WorkbenchSnapshot,
  Workspace,
} from './types.ts';
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
export function sessionActivityAt(session: Session): string {
  let best = Number.NEGATIVE_INFINITY;
  let at = '';
  for (const message of session.messages) {
    const parsed = Date.parse(message.at);
    if (Number.isFinite(parsed) && parsed >= best) {
      best = parsed;
      at = message.at;
    }
  }
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
 * Project groups under recent, newest message first. The name breaks a tie.
 * Opening the folder does not move it.
 */
export function orderedProjects(
  workspaces: readonly Workspace[],
  sessions: readonly Session[],
): Workspace[] {
  const activity = (id: string) =>
    sessions
      .filter((session) => session.workspaceId === id && !session.archivedAt)
      .reduce(
        (value, session) =>
          Math.max(value, Date.parse(sessionActivityAt(session)) || 0),
        0,
      );
  return sidebarProjects(workspaces, sessions).sort(
    (a, b) => activity(b.id) - activity(a.id) || a.name.localeCompare(b.name),
  );
}

/** Newest sessions from every project and from no project. Archived and empty rows stay out. */
export function recentSessions(sessions: readonly Session[]): Session[] {
  const activity = (session: Session) =>
    Date.parse(sessionActivityAt(session)) || 0;
  return visibleSessions(sessions)
    .filter((session) => !session.archivedAt)
    .sort((a, b) => activity(b) - activity(a) || a.id.localeCompare(b.id));
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
