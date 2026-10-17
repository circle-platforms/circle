/** Native editors own their copy/undo commands; terminal clear/suspend stay elsewhere. */
export function preserveNativeEditing(
  event: KeyboardEvent,
  action?: string,
): boolean {
  if (action !== 'clear' && action !== 'suspend') return false;
  const key = event.key.toLowerCase();
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  if (action === 'clear' && (key !== 'c' || event.shiftKey)) return false;
  if (action === 'suspend' && key !== 'z') return false;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  const editor = target.closest('.monaco-editor, .native-terminal');
  if (editor) return true;
  const editable =
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement ||
    target.isContentEditable;
  if (!editable) return false;
  if (action === 'suspend') return true;
  // Command+C is always the platform copy command. Control+C retains Circle's
  // clear action only when the plain composer has no selection to copy.
  if (event.metaKey) return true;
  if (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement
  )
    return (
      target.selectionStart !== null &&
      target.selectionStart !== target.selectionEnd
    );
  const selection = target.ownerDocument.getSelection();
  return (
    !!selection &&
    !selection.isCollapsed &&
    !!selection.anchorNode &&
    target.contains(selection.anchorNode)
  );
}
