import { desktopHost } from '../host';
import type {
  WorkspaceService,
  WorkspaceServiceEvent,
} from '../../../desktop/src/workspace-protocol';
import {
  WorkspaceStreamStore,
  type WorkspaceStreamEvent,
} from './workspace-stream-store';
import {
  WorkspaceStreamConnection,
  type WorkspaceReplayPage,
} from './workspace-stream-connection';

/** Target identity is captured by the caller; switching the UI cannot reroute it. */
export async function workspaceCall<T>(
  sessionId: string,
  service: WorkspaceService,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const host = desktopHost();
  if (!host) throw Error('native workspace services are not connected');
  const reply = await host.runtimeCommand({
    id: crypto.randomUUID(),
    name: 'workspace-service',
    sessionId,
    payload: { service, method, params },
  });
  if (!reply.ok) throw Error(reply.error ?? 'workspace operation failed');
  return reply.data as T;
}
export const workspaceStreams = new WorkspaceStreamStore();
const listeners = new Set<(event: WorkspaceServiceEvent) => void>();
let connection: WorkspaceStreamConnection | undefined;
let activeOwner = 0;
const CHECKPOINT = 'circle-workspace-stream-checkpoint-v1';
let restored = false;
let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
function restoreCheckpoint() {
  if (restored) return;
  restored = true;
  try {
    const value = sessionStorage.getItem(CHECKPOINT);
    if (value && !workspaceStreams.restore(JSON.parse(value)))
      sessionStorage.removeItem(CHECKPOINT);
  } catch {
    /* unavailable storage falls back to authoritative replay from zero */
  }
}
workspaceStreams.subscribeCursor(() => {
  if (checkpointTimer) return;
  checkpointTimer = setTimeout(() => {
    checkpointTimer = undefined;
    try {
      sessionStorage.setItem(
        CHECKPOINT,
        JSON.stringify(workspaceStreams.checkpoint()),
      );
    } catch {
      try {
        sessionStorage.removeItem(CHECKPOINT);
      } catch {
        /* replay remains authoritative */
      }
    }
  }, 1000);
});

/** Called by the app once for its selected trusted session. Switching session
 * changes replay authorization, while the global journal/store identity remains. */
export function connectWorkspaceStreams(
  sessionId: string,
  onError: (error: unknown) => void = () => {},
) {
  const host = desktopHost();
  if (!host?.onWorkspaceEvent) return () => {};
  restoreCheckpoint();
  const owner = ++activeOwner;
  connection?.stop();
  connection = new WorkspaceStreamConnection(
    workspaceStreams,
    {
      listen: (receive) =>
        host.onWorkspaceEvent!((event) =>
          receive(event as WorkspaceStreamEvent),
        ),
      replay: async (after, limit) => {
        // 'events' is a protocol service in the integrated desktop bridge.
        return workspaceCall<WorkspaceReplayPage>(
          sessionId,
          'events' as WorkspaceService,
          'replay',
          { after, limit },
        );
      },
    },
    (event) => {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          onError(error);
        }
      }
    },
    onError,
  );
  void connection.start().catch(onError);
  return () => {
    if (owner === activeOwner) {
      connection?.stop();
      connection = undefined;
    }
  };
}

/** Consumers observe only accepted, deduplicated events after global ingestion. */
export function subscribeWorkspace(
  listener: (event: WorkspaceServiceEvent) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
