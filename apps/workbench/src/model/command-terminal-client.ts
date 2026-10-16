import type {
  CommandTerminalAction,
  CommandTerminalAvailable,
  CommandTerminalCapabilities,
  CommandTerminalCommandReply,
  CommandTerminalTarget,
  CommandTerminalUnavailable,
} from '../command-terminal-target';
import { workspaceCall } from './workspace-client';
import { t } from '../i18n';
export interface CommandTerminalView {
  viewSessionId: string;
  requestId: number;
  resolved: CommandTerminalAvailable;
}
export function commandTerminalUnavailable(
  reason: CommandTerminalUnavailable['reason'],
): string {
  return reason === 'not-native'
    ? t('this command has no interactive terminal')
    : reason === 'stale' || reason === 'ambiguous'
      ? t('command terminal source changed; open it again')
      : t('command terminal is no longer available');
}
export function sameCommandTerminal(
  left: CommandTerminalTarget,
  right: CommandTerminalTarget,
): boolean {
  return (
    left.executionId === right.executionId &&
    left.epoch === right.epoch &&
    left.executionSessionId === right.executionSessionId &&
    left.toolCallId === right.toolCallId &&
    left.terminal.id === right.terminal.id &&
    left.terminal.epoch === right.terminal.epoch
  );
}
export type TerminalRequest = <T>(
  method: string,
  params?: Record<string, unknown>,
) => Promise<T>;
export function commandTerminalRequest(
  viewSessionId: string,
  target: CommandTerminalTarget,
  update: (capabilities: CommandTerminalCapabilities) => void,
): TerminalRequest {
  return async <T>(method: string, params: Record<string, unknown> = {}) => {
    const actions: CommandTerminalAction['action'][] = [
      'list',
      'replay',
      'write',
      'resize',
      'signal',
      'close',
    ];
    if (!actions.some((action) => action === method))
      throw Error(t('managed commands cannot be restarted'));
    const { id, ...payload } = params;
    if (id !== undefined && id !== target.terminal.id)
      throw Error(t('command terminal source changed; open it again'));
    const reply = await workspaceCall<CommandTerminalCommandReply<T>>(
      viewSessionId,
      'terminal',
      'command',
      { target, action: method, params: payload },
    );
    if (!reply.available) {
      update({ read: true, input: false, stop: false, addToDraft: false });
      throw Error(commandTerminalUnavailable(reply.reason));
    }
    if (!sameCommandTerminal(target, reply.target))
      throw Error(t('command terminal source changed; open it again'));
    update(reply.capabilities);
    return reply.value;
  };
}
