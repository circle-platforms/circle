/** Which activity tab a selection or a debug-file request should open.
 * Undefined leaves the tab the person already chose. Call this only when the
 * selection or the request changes, not when they pick another tab afterwards. */
export function forcedActivityTab(input: {
  kind: string;
  selection: string;
  showDebug: boolean;
  hasSourceRequest: boolean;
}): 'tasks' | 'debug' | undefined {
  if (input.kind !== 'activity') return undefined;
  if (input.selection.startsWith('task:')) return 'tasks';
  if (
    input.showDebug &&
    (input.selection === 'debug' || input.hasSourceRequest)
  )
    return 'debug';
  return undefined;
}

/** Leave the debug tab when the developer extension is off. */
export function activityTabWhenDebugHidden(
  kind: string,
  showDebug: boolean,
  tab: string,
): 'original' | undefined {
  if (kind === 'activity' && !showDebug && tab === 'debug') return 'original';
  return undefined;
}
