import { desktopHost } from '../host';
import type {
  WorkspaceService,
  WorkspaceServiceEvent,
} from '../../../desktop/src/workspace-protocol';

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

export function subscribeWorkspace(
  listener: (event: WorkspaceServiceEvent) => void,
): () => void {
  return desktopHost()?.onWorkspaceEvent?.(listener) ?? (() => {});
}
