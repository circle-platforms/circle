/**
 * Where the overview and the work drawer sit beside the conversation. The overview is
 * a column of its own, fixed in width, next to the conversation; the drawer opens beside
 * it and is the one the person drags. When the conversation would be squeezed too far,
 * the overview steps aside, and comes back when there is room again.
 */
export const OVERVIEW_WIDTH = 380;
/** The narrowest the conversation is left, in pixels. */
export const MIN_CONVERSATION = 420;
export const MIN_DRAWER = 290;
/** The sidebar's width: what folding it gives to the workspace. */
export const SIDEBAR_WIDTH = 252;
/** Extra room the overview needs to come back, so it does not flicker at the edge. */
export const RESTORE_MARGIN = 24;

/** Widths a mode opens at, before the person has moved them. */
const OPENING_WIDTH: Record<string, number> = {
  files: 300,
  'files:open': 760,
  agents: 300,
  'agents:open': 760,
};
const OTHER_WIDTH = 536;

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
 * Whether the overview has room beside the conversation, and the drawer if one is
 * open. One that is already showing needs only the room; one that stepped aside needs a
 * little more before it returns.
 */
export function overviewFits(input: {
  group: number;
  /** A drawer is open, and its width. */
  drawer: number | null;
  showing: boolean;
}): boolean {
  const need =
    MIN_CONVERSATION +
    OVERVIEW_WIDTH +
    (input.drawer ?? 0) +
    (input.showing ? 0 : RESTORE_MARGIN);
  return input.group >= need;
}

/**
 * The person asks for the overview while it has stepped aside: the drawer gives way
 * to make room, as far as it can, and closes when it cannot.
 */
export function makeRoomForOverview(input: {
  group: number;
  drawer: number | null;
}): { drawer: number | null } {
  if (input.drawer === null) return { drawer: null };
  const room = drawerRoom(input.group, true);
  return room >= MIN_DRAWER
    ? { drawer: Math.min(input.drawer, room) }
    : { drawer: null };
}

/** How wide the right-hand column is: the overview if shown, and the drawer if open. */
export function clusterWidth(input: {
  overviewShown: boolean;
  drawer: number | null;
}): number {
  return (input.overviewShown ? OVERVIEW_WIDTH : 0) + (input.drawer ?? 0);
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
