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
  | 'set-mode'
  | 'configure'
  | 'probe-connection'
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
  | 'save-command'
  | 'save-secret'
  | 'remove-secret';

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
  'set-mode',
  'configure',
  'probe-connection',
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
  'save-secret',
  'remove-secret',
]);

// A message carries its pictures and PDFs as base64, up to 20 MiB each in the core: room for
// a few full-size ones together. Every other command is small.
export const MAX_PROMPT_PAYLOAD = 64_000_000;
export const MAX_COMMAND_PAYLOAD = 5_000_000;
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
    JSON.stringify(command.payload).length >
      (command.name === 'prompt' ? MAX_PROMPT_PAYLOAD : MAX_COMMAND_PAYLOAD)
  )
    throw Error(
      command.name === 'prompt'
        ? 'the message and its files are over 64 MB; remove some pictures or PDFs'
        : 'invalid runtime payload',
    );
  return command;
}
