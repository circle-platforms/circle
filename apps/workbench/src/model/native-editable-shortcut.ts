// Inputs that take typed text. A checkbox or a button keeps the window's keys.
const TEXT_INPUTS = new Set([
  '',
  'text',
  'search',
  'url',
  'email',
  'password',
  'tel',
  'number',
]);
type TextTarget = {
  kind: 'composer' | 'field' | 'owned';
  node: HTMLElement;
};
/** The text field a key event comes from, and whose it is. */
function textTarget(event: KeyboardEvent): TextTarget | undefined {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return undefined;
  // The code editor and the terminal own every key their helper textarea receives.
  if (target.closest('.monaco-editor, .native-terminal'))
    return { kind: 'owned', node: target };
  const editable =
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement &&
      TEXT_INPUTS.has(target.type.toLowerCase())) ||
    target.isContentEditable;
  if (!editable) return undefined;
  return {
    kind:
      target instanceof HTMLTextAreaElement && target.closest('.composer')
        ? 'composer'
        : 'field',
    node: target,
  };
}
function hasSelection(node: HTMLElement): boolean {
  if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement)
    return (
      node.selectionStart !== null && node.selectionStart !== node.selectionEnd
    );
  const selection = node.ownerDocument.getSelection();
  return (
    !!selection &&
    !selection.isCollapsed &&
    !!selection.anchorNode &&
    node.contains(selection.anchorNode)
  );
}
/**
 * Whether a key the conversation would take as one of Circle's actions is left to the
 * focused text field instead. The composer keeps Circle's keys, as the terminal's
 * input box does, apart from the platform's copy and undo and ctrl+d over text (delete
 * forward, as in the terminal). Any other text field, the code editor and the terminal
 * keep all their keys; only esc goes on to Circle from there.
 */
export function preserveNativeEditing(
  event: KeyboardEvent,
  action?: string,
): boolean {
  if (!action) return false;
  const field = textTarget(event);
  if (!field) return false;
  if (field.kind !== 'composer') return action !== 'interrupt';
  const key = event.key.toLowerCase();
  if (action === 'exit')
    return (field.node as HTMLTextAreaElement).value.length > 0;
  if (action !== 'clear' && action !== 'suspend') return false;
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  if (action === 'clear' && (key !== 'c' || event.shiftKey)) return false;
  if (action === 'suspend') return key === 'z';
  // Command+C is always the platform copy command. Control+C retains Circle's
  // clear action only when the composer has no selection to copy.
  if (event.metaKey) return true;
  return hasSelection(field.node);
}
