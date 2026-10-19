/** Native workspace services have their own streams, independent of chat snapshots. */
export type WorkspaceService =
  | 'inputs'
  | 'operations'
  | 'events'
  | 'documents'
  | 'terminal'
  | 'git'
  | 'language'
  | 'debug'
  | 'tasks'
  | 'delivery';

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
  git: new Set([
    'status',
    'snapshot',
    'applyPatch',
    'conflictContinue',
    'conflictAbort',
    'diff',
    'stage',
    'unstage',
    'applyHunk',
    'discard',
    'commit',
    'push',
    'branches',
    'history',
    'commitDiff',
    'continueMerge',
    'abortMerge',
  ]),
  language: new Set(['open', 'change', 'close', 'request']),
  debug: new Set([
    'output',
    'start',
    'snapshot',
    'launch',
    'attach',
    'setBreakpoints',
    'stackTrace',
    'breakpoints',
    'threads',
    'stack',
    'scopes',
    'variables',
    'next',
    'stepIn',
    'stepOut',
    'continue',
    'pause',
    'stop',
    'list',
    'evaluate',
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
    'artifacts',
    'readArtifact',
  ]),
  delivery: new Set([
    'status',
    'publish',
    'checks',
    'logs',
    'retry',
    'login',
    'ready',
  ]),
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
