/**
 * Overview and drawer modes share the right pane beside the conversation. A mode
 * replaces overview until it closes; document modes can still be widened or seen whole.
 */
export const OVERVIEW_WIDTH = 380;
/** The narrowest the conversation is left, in pixels. */
export const MIN_CONVERSATION = 420;
export const MIN_DRAWER = 300;
/** The sidebar's width: what folding it gives to the workspace. */
export const SIDEBAR_WIDTH = 232;
/** Extra room the overview needs to come back, so it does not flicker at the edge. */
export const RESTORE_MARGIN = 24;

/** Widths a mode opens at, before the person has moved them. */
const OPENING_WIDTH: Record<string, number> = {
  files: 380,
  'files:open': 760,
  agents: 380,
  'agents:open': 760,
};
const OTHER_WIDTH = 380;

/** Files and subagents are a list until one is opened, then a document beside the list. */
export function drawerKey(mode: string, opened: boolean): string {
  return opened && (mode === 'files' || mode === 'agents')
    ? `${mode}:open`
    : mode;
}

export function openingWidth(key: string): number {
  return OPENING_WIDTH[key] ?? OTHER_WIDTH;
}

/** The widest a drawer can be and still leave the conversation its room. */
export function drawerRoom(group: number, overviewShown: boolean): number {
  return group - MIN_CONVERSATION - (overviewShown ? OVERVIEW_WIDTH : 0);
}

export function clampDrawer(
  width: number,
  group: number,
  overviewShown: boolean,
): number {
  return Math.max(
    MIN_DRAWER,
    Math.min(width, drawerRoom(group, overviewShown)),
  );
}

/**
 * Whether overview can occupy the right pane. A mode takes precedence; an overview
 * that stepped aside needs a little extra room before it returns.
 */
export function overviewFits(input: {
  group: number;
  /** A drawer is open, and its width. */
  drawer: number | null;
  showing: boolean;
}): boolean {
  // Overview and a mode share the third pane; they never form a fourth column.
  if (input.drawer !== null) return false;
  const need =
    MIN_CONVERSATION + OVERVIEW_WIDTH + (input.showing ? 0 : RESTORE_MARGIN);
  return input.group >= need;
}

/** A mode and overview never add up to a fourth column, even during a state transition. */
export function clusterWidth(input: {
  overviewShown: boolean;
  drawer: number | null;
}): number {
  return input.drawer ?? (input.overviewShown ? OVERVIEW_WIDTH : 0);
}

/**
 * A drawer made for a document (a file or a subagent that is open) wants more than the
 * workspace has beside the conversation. When folding the sidebar gives it the room, the
 * sidebar folds, as the window would otherwise have to take the room from the conversation.
 */
export function sidebarMustFold(input: {
  group: number;
  /** The width the document drawer wants. */
  drawer: number;
  sidebarShown: boolean;
  /** What folding the sidebar gives, as it is drawn now. */
  sidebar?: number;
}): boolean {
  if (!input.sidebarShown) return false;
  const need = MIN_CONVERSATION + input.drawer;
  return (
    input.group < need && input.group + (input.sidebar ?? SIDEBAR_WIDTH) >= need
  );
}
