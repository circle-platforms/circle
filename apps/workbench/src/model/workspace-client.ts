import { desktopHost } from '../host';
import { presentHostError } from './host-error';
import type {
  WorkspaceService,
  WorkspaceServiceEvent,
} from '../../../desktop/src/workspace-protocol';
import {
  WorkspaceStreamStore,
  type WorkspaceStreamEvent,
} from './workspace-stream-store';
import {
  WorkspaceStreamRegistry,
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
  if (!reply.ok)
    throw Error(presentHostError(reply.error ?? 'workspace operation failed'));
  return reply.data as T;
}
const listeners = new Set<(event: WorkspaceServiceEvent) => void>();
const errorListeners = new Set<(error: unknown) => void>();
let registry: WorkspaceStreamRegistry | undefined;
let connectedHost: ReturnType<typeof desktopHost>;
const stores = new Map<string, WorkspaceStreamStore>();
const checkpointTimers = new Map<string, ReturnType<typeof setTimeout>>();
const checkpointKey = (id: string) =>
  `circle-workspace-stream-checkpoint-v1:${id}`;

export function workspaceStreamFor(workspaceId: string): WorkspaceStreamStore {
  let store = stores.get(workspaceId);
  if (store) return store;
  store = new WorkspaceStreamStore();
  stores.set(workspaceId, store);
  try {
    const value = sessionStorage.getItem(checkpointKey(workspaceId));
    const checkpoint = value ? JSON.parse(value) : null;
    const ownWorkspace =
      checkpoint &&
      Array.isArray(checkpoint.resources) &&
      checkpoint.resources.every(
        (resource: { events?: WorkspaceStreamEvent[] }) =>
          Array.isArray(resource.events) &&
          resource.events.every((event) => event.workspaceId === workspaceId),
      );
    if (value && (!ownWorkspace || !store.restore(checkpoint)))
      sessionStorage.removeItem(checkpointKey(workspaceId));
  } catch {
    /* unavailable cache means authoritative replay from zero */
  }
  const target = store;
  store.subscribeCursor(() => {
    if (checkpointTimers.has(workspaceId)) return;
    checkpointTimers.set(
      workspaceId,
      setTimeout(() => {
        checkpointTimers.delete(workspaceId);
        try {
          sessionStorage.setItem(
            checkpointKey(workspaceId),
            JSON.stringify(target.checkpoint()),
          );
        } catch {
          try {
            sessionStorage.removeItem(checkpointKey(workspaceId));
          } catch {
            /* durable replay remains authoritative */
          }
        }
      }, 1000),
    );
  });
  return store;
}
function streamRegistry() {
  const host = desktopHost();
  if (!host?.onWorkspaceEvent) return;
  if (registry && connectedHost === host) return registry;
  registry?.close();
  connectedHost = host;
  const report = (error: unknown) => {
    for (const listener of errorListeners) listener(error);
  };
  registry = new WorkspaceStreamRegistry(
    {
      listen: (receive) =>
        host.onWorkspaceEvent!((event) =>
          receive(event as WorkspaceStreamEvent),
        ),
      replay: async (_workspaceId, sessionId, after, limit) =>
        workspaceCall<WorkspaceReplayPage>(
          sessionId,
          'events' as WorkspaceService,
          'replay',
          { after, limit },
        ),
    },
    workspaceStreamFor,
    (event) => {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          report(error);
        }
      }
    },
    report,
  );
  return registry;
}
/** A known session authorizes replay of its workspace. Background workspace
 * connections remain alive; only their own journal identity routes live events. */
export function connectWorkspaceStreams(
  workspaceId: string,
  sessionId: string,
  onError: (error: unknown) => void = () => {},
) {
  errorListeners.add(onError);
  void streamRegistry()?.connect(workspaceId, sessionId).catch(onError);
  return () => {
    errorListeners.delete(onError);
  };
}
/** Consumers observe accepted events after per-journal ingestion, then select
 * session/resource. Never filter session before advancing a workspace cursor. */
export function subscribeWorkspace(
  listener: (event: WorkspaceServiceEvent) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
