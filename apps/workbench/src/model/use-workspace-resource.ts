import { useCallback, useSyncExternalStore } from 'react';
import type { WorkspaceService } from '../../../desktop/src/workspace-protocol';
import { WorkspaceStreamStore } from './workspace-stream-store';
import { workspaceStreamFor } from './workspace-client';

/** Subscribe only after the complete workspace journal has been ingested. */
export function useWorkspaceResource(
  workspaceId: string,
  sessionId: string,
  service: WorkspaceService,
  resourceId: string,
) {
  const store = workspaceStreamFor(workspaceId);
  const key = WorkspaceStreamStore.resourceKey({
    workspaceId,
    sessionId,
    service,
    resourceId,
  });
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(key, listener),
    [store, key],
  );
  const snapshot = useCallback(() => store.snapshot(key), [store, key]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
