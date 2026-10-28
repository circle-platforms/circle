/** The session ⋯ tip. Keyboard focus shows it, including after the pointer
 * has left the sidebar. A scroll dismisses it (`scrollClosed`). */
export function sessionMenuTipOpen(input: {
  keyboardOwns: boolean;
  menuFocused: boolean;
  editing: boolean;
  menuOpen: boolean;
  scrollClosed: boolean;
  inView: boolean;
}): boolean {
  return (
    input.keyboardOwns &&
    input.menuFocused &&
    !input.editing &&
    !input.menuOpen &&
    !input.scrollClosed &&
    input.inView
  );
}

/** Leaving the sidebar closes the hover card. It is not a scroll, so the
 * focused ⋯ tip stays open. */
export function afterSidebarPointerLeave(scrollClosed: boolean): {
  suppressCard: true;
  scrollClosed: boolean;
} {
  return { suppressCard: true, scrollClosed };
}

/** Moving onto the controls above the session list closes the hover card.
 * It is not a scroll and does not blur the row, so a focused ⋯ tip stays open. */
export function afterSidebarChromeMove(scrollClosed: boolean): {
  suppressCard: true;
  scrollClosed: boolean;
  blurRow: false;
} {
  return { suppressCard: true, scrollClosed, blurRow: false };
}

/** Whether the session card may cover the page. A page change or a press
 * outside the sidebar sets `suppressed` until the pointer actually moves. */
export function sessionCardVisible(input: {
  renaming: boolean;
  editing: boolean;
  menuOpen: boolean;
  keyboardOwns: boolean;
  suppressed: boolean;
  hovered: boolean;
  focused: boolean;
  /** The pointer is not on any row. */
  pointerIdle: boolean;
}): boolean {
  if (
    input.renaming ||
    input.editing ||
    input.menuOpen ||
    input.keyboardOwns ||
    input.suppressed
  )
    return false;
  return input.hovered || (input.focused && input.pointerIdle);
}

/** The pointer is over the sidebar controls above the session list. */
export function pointerOnSidebarChrome(target: EventTarget | null): boolean {
  return (
    !!target &&
    typeof Element !== 'undefined' &&
    target instanceof Element &&
    !!target.closest('.sidebar-primary, .sidebar-search, .brand')
  );
}

/**
 * A control whose tip is open runs its action on the pointer press.
 * The click after that press is the same action. A click with no press,
 * such as Enter on the focused control, still runs.
 */
export function runControlAction(input: {
  kind: 'press' | 'click';
  button: number;
  actedOnPress: boolean;
}): boolean {
  if (input.kind === 'press') return input.button === 0;
  return !input.actedOnPress;
}

/** A press opens its row only when it lands on that row.
 * `detail` 0 is a keyboard activation, which has no pointer position. */
export function shouldOpenSession(input: {
  button: number;
  detail: number;
  clientX: number;
  clientY: number;
  targetInside: boolean;
  rect: { left: number; top: number; right: number; bottom: number } | null;
}): boolean {
  if (input.button !== 0 || !input.targetInside) return false;
  if (input.detail === 0) return true;
  const rect = input.rect;
  if (!rect) return true;
  return (
    input.clientX >= rect.left &&
    input.clientX <= rect.right &&
    input.clientY >= rect.top &&
    input.clientY <= rect.bottom
  );
}

/** Select the whole rename field. Setting scrollLeft after the range clears
 * the selection in Chromium, so the scroll happens first and the range is
 * put back if that scroll collapsed it. */
export function selectRenameText(input: {
  focus: (options?: { preventScroll?: boolean }) => void;
  value: string;
  scrollLeft: number;
  selectionStart: number | null;
  selectionEnd: number | null;
  setSelectionRange: (start: number, end: number) => void;
}): void {
  input.focus({ preventScroll: true });
  const end = input.value.length;
  input.scrollLeft = 0;
  input.setSelectionRange(0, end);
  if (input.selectionStart !== 0 || input.selectionEnd !== end)
    input.setSelectionRange(0, end);
}
