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
export interface CommandProcessHandle {
  pid?: number;
  terminal?: { id: string; epoch: string };
  shellExit: Promise<CommandExit>;
  /** Resolves only after the owned tree exits and the original output file flushes. */
  settled: Promise<void>;
  /** Execute the Registry's stop decision; confirm owned exit and log closure. */
  stop(reason: string): Promise<void>;
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
}

export interface CommandProcessOptions {
  commandLauncher?: CommandLauncher;
  onExecution?: (execution: CommandExecution) => void;
}
