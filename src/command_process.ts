/** Trusted execution identity; notification ownership can belong to a parent. */
export interface CommandOrigin {
  executionSessionId: string;
  toolCallId?: string;
  /** Optional raw-argument display after the Runtime's known-secret redaction. */
  displayCommand?: string;
  secretNames?: string[];
}

export interface CommandExit {
  exitCode: number;
  signal?: number;
  /** Verified remaining owned descendants, not merely a pending log flush. */
  remainingProcesses: boolean;
}

/** No native dependency: the desktop can supply a PTY-backed implementation. */
export interface CommandOwnedTreeProcessHandle {
  /** Omission preserves the original complete-owned-tree contract. */
  kind?: 'owned-tree';
  pid?: number;
  terminal?: { id: string; epoch: string };
  shellExit: Promise<CommandExit>;
  /** Resolves only after the owned tree exits and the original output file flushes. */
  settled: Promise<void>;
  /** Execute the Registry's stop decision; confirm owned exit and log closure. */
  stop(reason: string): Promise<void>;
}

export interface CommandDescendantCoverage {
  /** Neither value claims that arbitrary descendants are enclosed. */
  state: 'unknown' | 'unmanaged';
  reason?: 'outside-controlled-group' | 'coverage-unavailable';
}

export interface CommandPtyRootExit {
  exitCode: number;
  signal?: number;
  /** A group observation, never the legacy remaining-owned-descendants flag. */
  controlledGroupAtExit: 'active' | 'empty' | 'unknown';
}

export interface CommandPtyGroupProcessHandle {
  kind: 'pty-group';
  pid?: number;
  terminal?: { id: string; epoch: string };
  rootExit: Promise<CommandPtyRootExit>;
  /** The actual PTY transport and original output log have both closed/flushed. */
  transportAndLogClosed: Promise<void>;
  /** Only the controlled process group, with no inference about outside daemons. */
  controlledGroupEmpty: Promise<void>;
  descendantCoverage: {
    snapshot(): CommandDescendantCoverage;
    subscribe(changed: () => void): () => void;
  };
  /** Confirm only this controlled group's stop; retain outside coverage separately. */
  stop(reason: string): Promise<void>;
}

export type CommandProcessHandle =
  CommandOwnedTreeProcessHandle | CommandPtyGroupProcessHandle;

export interface CommandPtyCompletion {
  kind: 'pty-group';
  rootExit?: CommandPtyRootExit & { observedAt: number };
  transportAndLogClosed?: { observedAt: number };
  controlledGroupEmpty?: { observedAt: number };
  descendantCoverage: CommandDescendantCoverage & { observedAt: number };
}

/** Private launch input. Command, environment and paths must never be serialized. */
export interface CommandLaunchRequest {
  executionId: string;
  origin: CommandOrigin;
  notificationOwner: {
    sessionId: string;
    parent?: string;
    startedBy?: 'model' | 'user';
  };
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  outputPath: string;
  signal: AbortSignal;
}
export type CommandLauncher = (
  // Startup failure must clean any allocated process before rejecting. After
  // spawning, returning its owned handle lets the Registry await cancellation.
  request: CommandLaunchRequest,
) => Promise<CommandProcessHandle>;

/** Public projection: never includes expanded command, environment or real paths. */
export interface CommandExecution {
  executionId: string;
  epoch: string;
  ownerSessionId: string;
  executionSessionId: string;
  toolCallId?: string;
  displayCommand?: string;
  status: 'starting' | 'running' | 'background' | 'done' | 'failed' | 'stopped';
  started: number;
  jobId?: string;
  pid?: number;
  terminal?: { id: string; epoch: string };
  outputPath: string;
  exitCode?: number;
  reason?: string;
  /** Explicit group facts do not turn command completion into a full-tree claim. */
  completion?: CommandPtyCompletion;
}

/** Persisted tool/job history omits command text, paths, environment and raw errors. */
export interface CommandExecutionReceipt {
  executionId: string;
  epoch: string;
  ownerSessionId: string;
  executionSessionId: string;
  toolCallId?: string;
  status: CommandExecution['status'];
  started: number;
  jobId?: string;
  pid?: number;
  terminal?: { id: string; epoch: string };
  exitCode?: number;
  completion: CommandPtyCompletion;
}

export function commandExecutionReceipt(
  execution: CommandExecution | undefined,
): CommandExecutionReceipt | undefined {
  if (execution?.completion?.kind !== 'pty-group') return;
  return {
    executionId: execution.executionId,
    epoch: execution.epoch,
    ownerSessionId: execution.ownerSessionId,
    executionSessionId: execution.executionSessionId,
    toolCallId: execution.toolCallId,
    status: execution.status,
    started: execution.started,
    jobId: execution.jobId,
    pid: execution.pid,
    terminal: execution.terminal
      ? { id: execution.terminal.id, epoch: execution.terminal.epoch }
      : undefined,
    exitCode: execution.exitCode,
    completion: {
      kind: 'pty-group',
      ...(execution.completion.rootExit
        ? {
            rootExit: {
              exitCode: execution.completion.rootExit.exitCode,
              signal: execution.completion.rootExit.signal,
              controlledGroupAtExit:
                execution.completion.rootExit.controlledGroupAtExit,
              observedAt: execution.completion.rootExit.observedAt,
            },
          }
        : {}),
      ...(execution.completion.transportAndLogClosed
        ? {
            transportAndLogClosed: {
              observedAt: execution.completion.transportAndLogClosed.observedAt,
            },
          }
        : {}),
      ...(execution.completion.controlledGroupEmpty
        ? {
            controlledGroupEmpty: {
              observedAt: execution.completion.controlledGroupEmpty.observedAt,
            },
          }
        : {}),
      descendantCoverage: {
        state: execution.completion.descendantCoverage.state,
        reason: execution.completion.descendantCoverage.reason,
        observedAt: execution.completion.descendantCoverage.observedAt,
      },
    },
  };
}

/** Provider-only facts: the stored/displayed tool output remains unchanged. */
export function commandExecutionModelContent(message: {
  content: string;
  commandExecutions?: CommandExecutionReceipt[];
}): string {
  if (!message.commandExecutions?.length) return message.content;
  const receipts = message.commandExecutions.flatMap((receipt) => {
    const safe = commandExecutionReceipt({ ...receipt, outputPath: '' });
    return safe ? [safe] : [];
  });
  return receipts.length
    ? message.content +
        '\n\n<circle-command-execution-scope>\n' +
        JSON.stringify(receipts) +
        '\n</circle-command-execution-scope>'
    : message.content;
}

export interface CommandProcessOptions {
  commandLauncher?: CommandLauncher;
  onExecution?: (execution: CommandExecution) => void;
}
