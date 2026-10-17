/** A host-resolved original execution; opening it must never launch a command. */
interface CommandTerminalIdentity {
  executionId: string;
  /** The original JobRegistry run epoch, independent from the terminal epoch. */
  epoch: string;
  executionSessionId: string;
  terminal: { id: string; epoch: string };
}
export type CommandTerminalTarget = CommandTerminalIdentity &
  (
    | { toolCallId: string; origin?: never; userShellId?: never }
    | { origin: 'user-shell'; userShellId: string; toolCallId?: never }
  );

export interface CommandTerminalCapabilities {
  read: true;
  input: boolean;
  stop: boolean;
  /** False when a parent displays a child's terminal. Copy remains available. */
  addToDraft: boolean;
}

export interface CommandTerminalUnavailable {
  available: false;
  reason: 'not-native' | 'not-found' | 'ambiguous' | 'stale' | 'unavailable';
}

export interface CommandTerminalAvailable {
  available: true;
  target: CommandTerminalTarget;
  capabilities: CommandTerminalCapabilities;
  /** Host-owned subscription index only; this value never grants file access. */
  workspaceId: string;
}

export type CommandTerminalResolution =
  CommandTerminalUnavailable | CommandTerminalAvailable;

/** workspaceCall(viewSessionId, 'terminal', 'resolveCommand', request). */
export type CommandTerminalResolveRequest = {
  sourceSessionId: string;
} & (
  | { toolCallId: string; userShellId?: never }
  | { userShellId: string; toolCallId?: never }
);

/** No create/restart action exists: this route can address only the original PTY. */
export type CommandTerminalAction =
  | { action: 'list'; params?: Record<string, never> }
  | {
      action: 'replay';
      params?: { afterSequence?: number; limit?: number };
    }
  | { action: 'write'; params: { data: string } }
  | { action: 'resize'; params: { cols: number; rows: number } }
  | {
      action: 'signal';
      params: { signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' };
    }
  | { action: 'close'; params?: Record<string, never> };

/** workspaceCall(viewSessionId, 'terminal', 'command', request). */
export type CommandTerminalCommandRequest = CommandTerminalAction & {
  target: CommandTerminalTarget;
};

/** The host rechecks the complete target and current capabilities for every action. */
export type CommandTerminalCommandReply<T = unknown> =
  CommandTerminalUnavailable | (CommandTerminalAvailable & { value: T });
