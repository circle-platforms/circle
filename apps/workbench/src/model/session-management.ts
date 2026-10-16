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
 * Project groups under recent, newest message first. The name breaks a tie.
 * Opening the folder does not move it.
 */
export function orderedProjects(
  workspaces: readonly Workspace[],
  sessions: readonly Session[],
): Workspace[] {
  const projects = sidebarProjects(workspaces, sessions);
  const activity = new Map(projects.map((project) => [project.id, 0]));
  for (const session of sessions) {
    if (session.archivedAt || !activity.has(session.workspaceId)) continue;
    activity.set(
      session.workspaceId,
      Math.max(
        activity.get(session.workspaceId)!,
        Date.parse(sessionActivityAt(session)) || 0,
      ),
    );
  }
  return projects.sort(
    (a, b) =>
      activity.get(b.id)! - activity.get(a.id)! || a.name.localeCompare(b.name),
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
