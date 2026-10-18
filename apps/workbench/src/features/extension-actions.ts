/** Bundled extensions the desktop applies as soon as the switch is saved. */
export function extensionAppliesImmediately(name: string): boolean {
  return name === 'github' || name === 'developer';
}

export type ExtensionActionPhase =
  | 'saving'
  | 'waiting'
  | 'reload'
  | 'complete'
  | 'preview'
  | 'save-error'
  | 'load-error';

export interface ExtensionAction {
  target: boolean;
  revision: number;
  phase: ExtensionActionPhase;
  error?: string;
  reloaded?: boolean;
}

export interface ExtensionSnapshotRow {
  enabled: boolean;
  error?: string;
  view?: unknown;
}

export function phaseAfterExtensionSave(
  mode: 'preview' | 'live',
  name: string,
  target: boolean,
): ExtensionActionPhase {
  if (mode === 'preview') return 'preview';
  if (target && !extensionAppliesImmediately(name)) return 'reload';
  return 'waiting';
}

/**
 * Reconcile one in-flight switch with a snapshot.
 * `'keep'` leaves the action as it is. A returned action replaces it.
 * A disagreeing snapshot after completion goes back to waiting, so the
 * switch stays on the choice the person made instead of the stale row.
 */
export function reconcileExtensionAction(
  name: string,
  action: ExtensionAction,
  extension: ExtensionSnapshotRow | undefined,
): ExtensionAction | 'keep' {
  if (!extension) return 'keep';
  if (
    action.phase !== 'waiting' &&
    action.phase !== 'complete' &&
    action.phase !== 'load-error'
  )
    return 'keep';
  const provider = (extension.view as { provider?: string } | undefined)
    ?.provider;
  if (action.phase === 'complete') {
    if (extension.enabled !== action.target)
      return { ...action, phase: 'waiting' };
    if (
      !action.target ||
      (!extension.error &&
        (!extensionAppliesImmediately(name) || provider === name))
    )
      return 'keep';
    if (!extension.error) return { ...action, phase: 'waiting' };
  }
  if (action.target && extension.enabled && extension.error) {
    if (action.phase === 'load-error' && action.error === extension.error)
      return 'keep';
    return { ...action, phase: 'load-error', error: extension.error };
  }
  const loaded =
    action.target &&
    extension.enabled &&
    !extension.error &&
    (extensionAppliesImmediately(name) ? provider === name : !!action.reloaded);
  if ((!action.target && !extension.enabled && !extension.view) || loaded)
    return { ...action, phase: 'complete' };
  return 'keep';
}
