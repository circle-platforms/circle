import type { WorkbenchSnapshot } from '../../workbench/src/model/types';

export type RuntimeCommandName =
  | 'state'
  | 'prompt'
  | 'abort'
  | 'clear-queue'
  | 'background'
  | 'new-session'
  | 'select-session'
  | 'delete-session'
  | 'rename-session'
  | 'fork'
  | 'clone'
  | 'select-branch'
  | 'label-branch'
  | 'set-model'
  | 'set-effort'
  | 'set-plan-mode'
  | 'set-auto'
  | 'configure'
  | 'logout'
  | 'trust'
  | 'save-settings'
  | 'reload'
  | 'answer'
  | 'compact'
  | 'export'
  | 'import'
  | 'stop-job'
  | 'revoke-approval'
  | 'open-workspace'
  | 'load-skill'
  | 'close'
  | 'custom-command'
  | 'init'
  | 'write-file'
  | 'share'
  | 'unshare'
  | 'launch-options'
  | 'check-update'
  | 'discover-models'
  | 'shell'
  | 'remove-queued'
  | 'save-command';

export interface RuntimeCommand {
  id: string;
  name: RuntimeCommandName;
  sessionId?: string;
  payload: Record<string, unknown>;
}
export interface RuntimeReply {
  id: string;
  ok: boolean;
  error?: string;
  data?: unknown;
}
export interface RuntimeUpdate {
  seq: number;
  connected: boolean;
  snapshot: WorkbenchSnapshot;
  event?: {
    kind: string;
    sessionId: string;
    payload: Record<string, unknown>;
    runId?: string;
    eventSeq?: number;
    at?: string;
    parentRunId?: string;
  };
  error?: string;
}
export const runtimeCommands = new Set<RuntimeCommandName>([
  'state',
  'prompt',
  'abort',
  'clear-queue',
  'background',
  'new-session',
  'select-session',
  'delete-session',
  'rename-session',
  'fork',
  'clone',
  'select-branch',
  'label-branch',
  'set-model',
  'set-effort',
  'set-plan-mode',
  'set-auto',
  'configure',
  'logout',
  'trust',
  'save-settings',
  'reload',
  'answer',
  'compact',
  'export',
  'import',
  'stop-job',
  'revoke-approval',
  'open-workspace',
  'load-skill',
  'close',
  'custom-command',
  'init',
  'write-file',
  'share',
  'unshare',
  'launch-options',
  'check-update',
  'discover-models',
  'shell',
  'remove-queued',
  'save-command',
]);

export function validateRuntimeCommand(value: unknown): RuntimeCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('invalid runtime command');
  const command = value as RuntimeCommand;
  if (
    typeof command.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(command.id) ||
    !runtimeCommands.has(command.name)
  )
    throw Error('invalid runtime command');
  if (
    command.sessionId !== undefined &&
    (typeof command.sessionId !== 'string' || command.sessionId.length > 200)
  )
    throw Error('invalid session identity');
  if (
    !command.payload ||
    typeof command.payload !== 'object' ||
    Array.isArray(command.payload) ||
    JSON.stringify(command.payload).length > 5_000_000
  )
    throw Error('invalid runtime payload');
  return command;
}
