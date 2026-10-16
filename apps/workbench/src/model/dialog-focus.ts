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
