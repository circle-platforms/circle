import type {
  Attachment,
  Effort,
  SessionMode,
  Workspace,
} from '../model/types';

/**
 * Projects the home menu can choose. The default circle workspace is one of
 * them. `scratch` is only the place a conversation goes when the person is
 * not working in a project, and it is not a choice in the list.
 */
export function homeProjects(workspaces: readonly Workspace[]): Workspace[] {
  return workspaces
    .filter((item) => item.kind !== 'scratch')
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Which project the home composer is aimed at.
 * `null` means the route did not name one, so the current conversation's
 * project is used. `''` means the person chose to work without a project.
 * A scratch id is that same choice: the sidebar's + on that group.
 */
export function selectedHomeProject(
  workspaces: readonly Workspace[],
  sessions: readonly { id: string; workspaceId: string }[],
  activeSessionId: string,
  requestedId: string | null,
): Workspace | undefined {
  if (requestedId === '') return undefined;
  if (requestedId) {
    const requested = workspaces.find((item) => item.id === requestedId);
    if (!requested || requested.kind === 'scratch') return undefined;
    return requested;
  }
  const active = sessions.find((session) => session.id === activeSessionId);
  const projects = homeProjects(workspaces);
  return (
    projects.find((item) => item.id === active?.workspaceId) ?? projects[0]
  );
}

/** `null` is the explicit no-project choice. Omit the id to keep the current project. */
export function homePath(workspaceId?: string | null) {
  if (workspaceId === null) return '/home?workspace=';
  if (workspaceId) return `/home?workspace=${encodeURIComponent(workspaceId)}`;
  return '/home';
}

/** What the home composer was holding when the person left it. */
export type HomeComposerMemory = {
  text: string;
  attachments: Attachment[];
  model: string;
  effort: Effort;
  mode: SessionMode;
  /** `null` is working without a project. */
  projectId: string | null;
};

let composerMemory: HomeComposerMemory | null = null;

export function homeComposerMemory(): HomeComposerMemory | null {
  return composerMemory ? structuredClone(composerMemory) : null;
}

/** Keep the home composer until its message is sent. */
export function rememberHomeComposer(next: HomeComposerMemory) {
  composerMemory = structuredClone(next);
}

export function forgetHomeComposer() {
  composerMemory = null;
}

/**
 * Which project id the home route should resolve.
 * An explicit route wins. Otherwise a remembered choice, including none.
 */
export function homeProjectRequest(
  requestedId: string | null,
  remembered: { projectId: string | null } | null,
): string | null {
  if (requestedId !== null) return requestedId;
  if (!remembered) return null;
  return remembered.projectId ?? '';
}

/**
 * Open the home composer and focus its message box. A second click while home
 * is already showing still focuses it: the route does not remount.
 */
export function openHome(
  navigate: (
    to: string,
    options?: {
      replace?: boolean;
      state?: { focusComposer: number };
    },
  ) => void,
  current: string,
  workspaceId?: string | null,
) {
  const to = homePath(workspaceId);
  navigate(to, {
    state: { focusComposer: Date.now() },
    replace: current === to,
  });
}
