/** Native workspace services have their own streams, independent of chat snapshots. */
export type WorkspaceService =
  | 'inputs'
  | 'operations'
  | 'events'
  | 'documents'
  | 'terminal'
  | 'git'
  | 'tasks'
  | 'delivery'
  | 'pulls';

export interface WorkspaceServiceRequest {
  service: WorkspaceService;
  method: string;
  params?: Record<string, unknown>;
}

export interface WorkspaceServiceEvent {
  workspaceId: string;
  sessionId: string;
  service: WorkspaceService;
  resourceId: string;
  epoch: string;
  seq: number;
  at: string;
  cursor?: { offset: number; seq: number };
  sourceSeq?: number;
  sourceEpoch?: string;
  data: Record<string, unknown>;
}

const methods: Record<WorkspaceService, ReadonlySet<string>> = {
  inputs: new Set(['list', 'resolve']),
  operations: new Set(['list', 'review']),
  events: new Set(['replay']),
  documents: new Set([
    'read',
    'save',
    'applyEdits',
    'refresh',
    'resolveSource',
  ]),
  terminal: new Set([
    'resolveCommand',
    'command',
    'create',
    'restart',
    'write',
    'resize',
    'signal',
    'close',
    'list',
    'replay',
  ]),
  // The window reads Git; staging, committing, pushing and merging are Circle's, in the
  // conversation, so the window cannot ask for them.
  git: new Set([
    'status',
    'snapshot',
    'changes',
    'diff',
    'branches',
    'history',
    'commitDiff',
  ]),
  tasks: new Set([
    'enqueue',
    'adoptProposal',
    'list',
    'start',
    'cancel',
    'retry',
    'events',
    'settings',
    'createIntegration',
    'mergeCandidates',
    'review',
    'reject',
    'artifacts',
    'readArtifact',
  ]),
  // Publishing a pull request is Circle's, through the GitHub tools or the create-pr skill.
  delivery: new Set(['status', 'checks', 'logs', 'login']),
  pulls: new Set(['overview', 'failedLog']),
};

export function validateWorkspaceRequest(
  value: unknown,
): WorkspaceServiceRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('invalid workspace service request');
  const request = value as WorkspaceServiceRequest;
  if (
    !Object.hasOwn(methods, request.service) ||
    typeof request.method !== 'string' ||
    !methods[request.service].has(request.method)
  )
    throw Error('unknown workspace service operation');
  if (
    request.params !== undefined &&
    (!request.params ||
      typeof request.params !== 'object' ||
      Array.isArray(request.params))
  )
    throw Error('invalid workspace service parameters');
  return request;
}
