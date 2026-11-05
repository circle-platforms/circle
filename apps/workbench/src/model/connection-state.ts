import type { WorkbenchSnapshot } from './types';

export type ConnectionState =
  'preview' | 'restarting' | 'stopped' | 'ready' | 'not-configured';

/** Whether the runtime behind the window can take a turn, as its status light shows it. */
export function connectionState(
  mode: string,
  snapshot: Pick<WorkbenchSnapshot, 'runtime'>,
): ConnectionState {
  if (mode !== 'live') return 'preview';
  if (!snapshot.runtime?.connected)
    return snapshot.runtime?.stopped?.restarting ? 'restarting' : 'stopped';
  return snapshot.runtime.configured ? 'ready' : 'not-configured';
}
