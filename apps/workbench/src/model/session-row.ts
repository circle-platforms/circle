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
