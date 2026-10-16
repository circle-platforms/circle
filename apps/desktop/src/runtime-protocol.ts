import type { WorkbenchSnapshot } from '../../workbench/src/model/types';

export type RuntimeCommandName =
  | 'workspace-service'
  | 'state'
  | 'prompt'
  | 'abort'
  | 'clear-queue'
  | 'background'
  | 'new-session'
  | 'begin-session'
  | 'select-session'
  | 'delete-session'
  | 'rename-session'
  | 'archive-session'
  | 'archive-workspace'
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
  | 'set-default-workspace'
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
  | 'edit-queued'
  | 'remove-queued'
  | 'save-command'
  | 'save-secret'
  | 'remove-secret'
  | 'create-skill';

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
  /** Cursor of the separate token channel included in this authoritative snapshot. */
  tokenStream?: { epoch: string; seq: number };
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
/** Streaming-only chunks never carry the full conversation history. */
export interface RuntimeTokenDelta {
  epoch: string;
  seq: number;
  baseSeq: number;
  sessionId: string;
  streamId: string;
  parentId: string | null;
  text?: string;
  thinking?: string;
  at: string;
  turn?: WorkbenchSnapshot['sessions'][number]['turn'];
}
export const runtimeCommands = new Set<RuntimeCommandName>([
  'workspace-service',
  'state',
  'prompt',
  'abort',
  'clear-queue',
  'background',
  'new-session',
  'begin-session',
  'select-session',
  'delete-session',
  'rename-session',
  'archive-session',
  'archive-workspace',
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
  'set-default-workspace',
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
  'edit-queued',
  'remove-queued',
  'save-command',
  'save-secret',
  'remove-secret',
  'create-skill',
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
