/** Which activity tab a selection should open: a task's row opens tasks.
 * Undefined leaves the tab the person already chose. Call this only when the
 * selection changes, not when they pick another tab afterwards. */
export function forcedActivityTab(input: {
  kind: string;
  selection: string;
}): 'tasks' | undefined {
  if (input.kind === 'activity' && input.selection.startsWith('task:'))
    return 'tasks';
  return undefined;
}
