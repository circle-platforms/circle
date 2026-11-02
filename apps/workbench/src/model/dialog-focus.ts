/** Radix focuses the first tab stop. In a dialog that is the close button. */
export function focusMarkedField(
  root: { querySelector(selector: string): { focus(): void } | null },
  event: { preventDefault(): void },
): boolean {
  const field = root.querySelector('[data-initial-focus]');
  if (!field) return false;
  event.preventDefault();
  field.focus();
  return true;
}

function placeFocus(node: HTMLElement) {
  node.focus({ focusVisible: true });
}
export function focusDialogField(
  content: HTMLElement,
  interacted?: HTMLElement | null,
) {
  // The fallback can run after a person already chose or typed in a field.
  // Keep that field and its selection rather than selecting the first input again.
  const marked = content.querySelector('[data-initial-focus]');
  const field = content.querySelector(
    'input:not([type="hidden"]), textarea, select',
  );
  const initial = marked ?? field;
  const active = document.activeElement;
  if (
    active instanceof HTMLElement &&
    content.contains(active) &&
    active.matches('input, textarea, select, [contenteditable="true"]') &&
    (active !== initial || active === interacted)
  )
    return;
  // A dialog can name the field that starts with the keyboard (search).
  if (marked instanceof HTMLElement) {
    placeFocus(marked);
    return;
  }
  if (
    field instanceof HTMLInputElement ||
    field instanceof HTMLTextAreaElement
  ) {
    placeFocus(field);
    // A rename box should start with the current name selected.
    if (field instanceof HTMLInputElement) field.select();
    return;
  }
  if (field instanceof HTMLSelectElement) {
    placeFocus(field);
    return;
  }
  const primary = content.querySelector('button.primary');
  if (primary instanceof HTMLButtonElement && !primary.disabled) {
    placeFocus(primary);
    return;
  }
  const button = [...content.querySelectorAll('button')].find(
    (item) =>
      item instanceof HTMLButtonElement &&
      !item.disabled &&
      item.getAttribute('aria-label') !== 'close dialog',
  );
  if (button instanceof HTMLButtonElement) placeFocus(button);
  else content.focus();
}
