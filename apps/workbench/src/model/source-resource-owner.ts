/** Resource ownership is supplied by the host's agent projection, never inferred
 * from a filename or from the selected parent conversation. */
export interface SourceResourceOwner {
  sessionId: string;
  workspaceId: string;
  readOnly: boolean;
}
export function agentSourceOwner(agent: {
  id: string;
  workspaceId?: unknown;
  resourceSessionId?: unknown;
  readOnly?: unknown;
}): SourceResourceOwner | null {
  return typeof agent.workspaceId === 'string' &&
    agent.workspaceId.length > 0 &&
    typeof agent.resourceSessionId === 'string' &&
    agent.resourceSessionId.length > 0 &&
    agent.resourceSessionId === agent.id &&
    typeof agent.readOnly === 'boolean'
    ? {
        sessionId: agent.resourceSessionId,
        workspaceId: agent.workspaceId,
        readOnly: agent.readOnly,
      }
    : null;
}
