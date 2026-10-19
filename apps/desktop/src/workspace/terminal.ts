import type { IPty } from 'node-pty';
import { hasNativePtyProcessExited, spawnPty } from './native-pty.ts';
import { ptyEnvironment, withTextLocale } from './pty-environment.ts';
import { randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  constants,
  type WriteStream,
} from 'node:fs';
import {
  mkdir,
  access,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  commandExecutionReceipt,
  type CommandPtyCompletion,
} from '../../../../src/command_process.js';

const exec = promisify(execFile);
const INPUT_LIMIT = 256 * 1024;
const OUTPUT_CHUNK = 8192;
const SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL']);

export type TerminalStatus =
  'running' | 'stopping' | 'exited' | 'failed' | 'interrupted';
export type TerminalSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';
export interface TerminalCommand {
  file: string;
  args?: string[];
}
export interface TerminalReadinessOptions {
  pattern?: string;
  port?: number;
  timeoutMs?: number;
}
export type ServiceState =
  | 'starting'
  | 'running'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'exited'
  | 'failed'
  | 'interrupted';

export interface TerminalSnapshot {
  id: string;
  owner: string;
  sessionId: string;
  epoch: string;
  cwd: string;
  shell: string;
  args: string[];
  label: string;
  pid?: number;
  cols: number;
  rows: number;
  status: TerminalStatus;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number;
  signal?: number;
  requestedSignal?: TerminalSignal;
  lastSequence: number;
  logPath: string;
  error?: string;
  /** Per-launch environment is kept in memory, never written to terminal history. */
  transientEnvironment?: boolean;
  restartOf?: string;
  kind: 'shell' | 'service';
  command?: TerminalCommand;
  /** Host-owned command identity. Expanded launch arguments are never retained. */
  managedCommand?: {
    executionId: string;
    /** Original Registry identity, required for read-only historical handoff. */
    executionEpoch?: string;
    toolCallId?: string;
    userShellId?: string;
    displayCommand?: string;
    ownership: 'pty-group';
    commandPid?: number;
    completion: CommandPtyCompletion;
  };
  serviceId?: string;
  serviceState?: ServiceState;
  exitReason?: string;
  readiness?: TerminalReadinessOptions & {
    state: 'waiting' | 'ready' | 'failed' | 'cancelled' | 'not-configured';
    matchedPattern?: boolean;
    portOpen?: boolean;
    readyAt?: string;
    error?: string;
  };
}

export interface TerminalEvent {
  terminalId: string;
  owner: string;
  sessionId: string;
  epoch: string;
  sequence: number;
  at: string;
  kind:
    | 'created'
    | 'data'
    | 'resized'
    | 'signalRequested'
    | 'exit'
    | 'error'
    | 'interrupted'
    | 'readiness'
    | 'ready'
    | 'commandState';
  data?: string;
  snapshot?: TerminalSnapshot;
}

export interface TerminalCreateOptions {
  owner: string;
  sessionId: string;
  cwd?: string;
  shell?: string;
  /** Shell startup flags only. Commands are written through the authorized input route. */
  args?: string[];
  cols?: number;
  rows?: number;
  label?: string;
  command?: TerminalCommand;
  readiness?: TerminalReadinessOptions;
  /** Trusted host launch environment; never forwarded from renderer parameters. */
  env?: Record<string, string | null>;
}

export interface TerminalManagerOptions {
  workspaceRoot: string;
  /** Private application data, never the workspace or the real Circle home in tests. */
  logRoot: string;
  shellAllowlist?: string[];
  env?: NodeJS.ProcessEnv;
  ringBytes?: number;
  eventHighWaterBytes?: number;
  maxActive?: number;
  stopGraceMs?: number;
}

/** Trusted host API only; the workspace RPC must never forward this structure. */
export interface ManagedTerminalCommandOptions {
  owner: string;
  sessionId: string;
  executionId: string;
  executionEpoch?: string;
  toolCallId?: string;
  userShellId?: string;
  displayCommand?: string;
  completion: CommandPtyCompletion;
  /** Trusted supervisor executable; expanded commands travel over its private control pipe. */
  launch: TerminalCommand;
  cwd: string;
  env: NodeJS.ProcessEnv;
  outputPath: string;
  signal: AbortSignal;
  /** Delegate a human Stop to the owning JobRegistry, without restarting it. */
  stop: (reason: string) => Promise<unknown>;
}

export interface ManagedTerminalCommandHandle {
  snapshot: TerminalSnapshot;
  exited: Promise<{ exitCode: number; signal?: number }>;
  flushed: Promise<void>;
  /** Trusted adapter facts only; this is never exposed as a workspace RPC. */
  recordState: (state: {
    commandPid?: number;
    completion: CommandPtyCompletion;
  }) => Promise<void>;
  /** Only the Registry's transport adapter may call this, to avoid delegation recursion. */
  stopTransport: () => Promise<void>;
}

interface ManagedCommand {
  source: NonNullable<TerminalSnapshot['managedCommand']>;
  outputPath: string;
  stop: ManagedTerminalCommandOptions['stop'];
  signal: AbortSignal;
  exit: (value: { exitCode: number; signal?: number }) => void;
  failure: Promise<never>;
  fail: (error: Error) => void;
}

export interface TerminalReplay {
  events: TerminalEvent[];
  nextSequence: number;
  hasMore: boolean;
  snapshot: TerminalSnapshot;
}

interface Entry {
  managed?: ManagedCommand;
  mirror?: WriteStream;
  snapshot: TerminalSnapshot;
  environment?: Record<string, string | null>;
  pty?: IPty;
  events?: WriteStream;
  output?: WriteStream;
  ring: TerminalEvent[];
  ringBytes: number;
  diskPaused: Set<WriteStream>;
  observerBytes: number;
  observerQueue: Promise<void>;
  paused: boolean;
  done: Promise<void>;
  resolveDone: () => void;
  persist: Promise<void>;
  ownedProcesses: Map<number, string>;
  eventBytes: number;
  offsets: Map<number, number>;
  readinessTail: string;
  readinessTimer?: NodeJS.Timeout;
  closing?: Promise<TerminalSnapshot>;
}

/**
 * A workspace-owned PTY service. The trusted host supplies owner/session identity;
 * renderer input must not be allowed to choose another owner. This service has no
 * relationship to an Agent turn, so switching or reloading renderer views does not
 * pause a shell. Agent-originated input still needs the host's approval route.
 */
export class TerminalManager {
  readonly #options: TerminalManagerOptions;
  readonly #onEvent: (event: TerminalEvent) => void | Promise<void>;
  readonly #entries = new Map<string, Entry>();
  readonly #observers = new Set<(event: TerminalEvent) => void>();
  readonly #ready: Promise<void>;
  #settled = false;
  #workspaceRoot = '';
  #shells: string[] = [];
  #disposed = false;
  #creating = 0;

  constructor(
    options: TerminalManagerOptions,
    onEvent: (event: TerminalEvent) => void | Promise<void>,
  ) {
    this.#options = options;
    this.#onEvent = onEvent;
    this.#ready = this.#initialize();
    void this.#ready.then(
      () => (this.#settled = true),
      () => {},
    );
  }

  /**
   * Trusted host code only (the runtime's terminal-tab tools), never the workspace RPC:
   * every event as it is appended, in order. An observer must not throw or change it.
   */
  observe(listener: (event: TerminalEvent) => void): () => void {
    this.#observers.add(listener);
    return () => this.#observers.delete(listener);
  }

  /** `list`, for a caller that cannot wait: nothing before the service is ready. */
  listNow(owner: string): TerminalSnapshot[] {
    if (!this.#settled) return [];
    identity(owner, 'owner');
    return byStart(
      [...this.#entries.values()]
        .filter((entry) => entry.snapshot.owner === owner)
        .map((entry) => clone(entry.snapshot)),
    );
  }

  /**
   * Trusted host only: a terminal's newest output still in memory, about `maxLength`
   * characters, with the sequence it ends at and when its last part arrived. Later
   * output comes to the observers from the next sequence on.
   */
  recentOutput(
    owner: string,
    id: string,
    maxLength: number,
  ): { data: string; sequence: number; at?: string } | undefined {
    const entry = this.#entries.get(id);
    if (!this.#settled || !entry || entry.snapshot.owner !== owner) return;
    const parts: string[] = [];
    let size = 0;
    let at: string | undefined;
    for (let index = entry.ring.length - 1; index >= 0; index--) {
      const event = entry.ring[index]!;
      if (event.kind !== 'data' || !event.data) continue;
      at ??= event.at;
      size += event.data.length;
      if (size > maxLength && parts.length) break;
      parts.unshift(event.data);
    }
    return { data: parts.join(''), sequence: entry.snapshot.lastSequence, at };
  }

  async create(options: TerminalCreateOptions): Promise<TerminalSnapshot> {
    return this.#create(options);
  }

  async createManagedCommand(
    options: ManagedTerminalCommandOptions,
  ): Promise<ManagedTerminalCommandHandle> {
    options.signal.throwIfAborted();
    identity(options.executionId, 'execution');
    if (options.executionEpoch !== undefined)
      identity(options.executionEpoch, 'execution epoch');
    if (options.toolCallId !== undefined)
      identity(options.toolCallId, 'tool call');
    if (options.userShellId !== undefined)
      identity(options.userShellId, 'human command');
    if (options.toolCallId && options.userShellId)
      throw Error('a managed command cannot have both tool and human origins');
    if (
      options.displayCommand !== undefined &&
      typeof options.displayCommand !== 'string'
    )
      throw Error('invalid command display');
    const safeCompletion = (completion: CommandPtyCompletion) => {
      const receipt = commandExecutionReceipt({
        executionId: options.executionId,
        epoch: '',
        ownerSessionId: options.owner,
        executionSessionId: options.sessionId,
        status: 'starting',
        started: 0,
        outputPath: '',
        completion,
      });
      if (!receipt) throw Error('invalid managed command completion scope');
      return receipt.completion;
    };
    let exit!: ManagedCommand['exit'];
    const exited = new Promise<{ exitCode: number; signal?: number }>(
      (resolve) => {
        exit = resolve;
      },
    );
    let fail!: ManagedCommand['fail'];
    const failure = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    void failure.catch(() => {});
    const source: ManagedCommand['source'] = {
      executionId: options.executionId,
      executionEpoch: options.executionEpoch,
      toolCallId: options.toolCallId,
      userShellId: options.userShellId,
      displayCommand: options.displayCommand,
      ownership: 'pty-group',
      completion: safeCompletion(options.completion),
    };
    const managed: ManagedCommand = {
      source,
      outputPath: options.outputPath,
      stop: options.stop,
      signal: options.signal,
      exit,
      failure,
      fail,
    };
    const snapshot = await this.#create(
      {
        owner: options.owner,
        sessionId: options.sessionId,
        cwd: options.cwd,
        env: Object.fromEntries(
          Object.entries(options.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        label: 'command',
      },
      undefined,
      { managed, launch: options.launch },
    );
    const owner = options.owner;
    const entry = this.#get(owner, snapshot.id);
    const id = snapshot.id;
    return {
      snapshot,
      exited,
      flushed: Promise.race([
        failure,
        entry.done.then(async () => {
          await drainObserver(entry);
          if (entry.snapshot.error) throw Error(entry.snapshot.error);
        }),
      ]),
      stopTransport: async () => {
        await this.#closeTransport(owner, id);
      },
      recordState: async (state) => {
        if (state.commandPid !== undefined) {
          if (!Number.isSafeInteger(state.commandPid) || state.commandPid <= 0)
            throw Error('invalid managed command process identity');
          entry.snapshot.managedCommand!.commandPid = state.commandPid;
        }
        entry.snapshot.managedCommand!.completion = safeCompletion(
          state.completion,
        );
        if (
          entry.events &&
          !entry.events.writableEnded &&
          !entry.events.destroyed
        )
          this.#append(entry, 'commandState', undefined, true);
        await this.#persist(entry);
      },
    };
  }

  async #create(
    options: TerminalCreateOptions,
    restart?: { serviceId?: string },
    managedLaunch?: { managed: ManagedCommand; launch: TerminalCommand },
  ): Promise<TerminalSnapshot> {
    await this.#ready;
    if (this.#disposed) throw Error('terminal manager is closed');
    identity(options.owner, 'owner');
    identity(options.sessionId, 'session');
    const active = [...this.#entries.values()].filter(
      (entry) => entry.pty,
    ).length;
    if (active + this.#creating >= (this.#options.maxActive ?? 32))
      throw Error('too many active terminals');
    this.#creating++;
    try {
      const cwd = await realpath(
        options.cwd
          ? resolve(this.#workspaceRoot, options.cwd)
          : this.#workspaceRoot,
      );
      const rel = relative(this.#workspaceRoot, cwd);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw Error('terminal directory is outside the granted workspace');
      if (!(await stat(cwd)).isDirectory())
        throw Error('terminal directory is not a folder');
      const configuredShell = options.shell ?? this.#shells[0];
      if (!configuredShell || !this.#shells.includes(configuredShell))
        throw Error('shell is not allowed');
      if (
        options.command &&
        (options.shell !== undefined || options.args !== undefined)
      )
        throw Error('choose either a service command or a shell');
      if (!options.command && options.readiness)
        throw Error('readiness checks need a service command');
      const readiness = validateReadiness(options.readiness);
      const environment = validateEnvironment(options.env);
      const effectiveEnvironment = ptyEnvironment(
        process.platform,
        process.env,
        this.#options.env,
        environment,
      );
      effectiveEnvironment.TERM = 'xterm-256color';
      withTextLocale(effectiveEnvironment, process.platform);
      if (readiness?.port && (await portOpen(readiness.port)))
        throw Error(`port ${readiness.port} is already in use`);
      const command =
        options.command || managedLaunch
          ? await executable(
              managedLaunch?.launch ?? options.command!,
              cwd,
              effectiveEnvironment,
            )
          : undefined;
      const shell = command?.file ?? configuredShell;
      const actualArgs =
        command?.args ?? validateShellArgs(shell, options.args ?? []);
      const args = managedLaunch ? [] : actualArgs;
      const cols = dimension(options.cols ?? 80);
      const rows = dimension(options.rows ?? 24);
      const label = options.label ?? basename(shell);
      if (
        typeof label !== 'string' ||
        label.length > 200 ||
        /[\x00-\x1f]/.test(label)
      )
        throw Error('invalid terminal label');
      if (this.#disposed) throw Error('terminal manager is closed');
      const id = randomUUID();
      const folder = join(this.#options.logRoot, id);
      await mkdir(folder, { mode: 0o700 });
      const snapshot: TerminalSnapshot = {
        id,
        owner: options.owner,
        sessionId: options.sessionId,
        epoch: randomUUID(),
        cwd,
        shell,
        args,
        label,
        cols,
        rows,
        status: 'running',
        startedAt: new Date().toISOString(),
        lastSequence: 0,
        logPath: join(folder, 'output.log'),
        kind: command ? 'service' : 'shell',
        ...(managedLaunch
          ? { managedCommand: clone(managedLaunch.managed.source) }
          : {}),
        ...(environment ? { transientEnvironment: true } : {}),
        ...(command && !managedLaunch
          ? ({
              command,
              serviceId: restart?.serviceId ?? randomUUID(),
              serviceState: readiness ? 'starting' : 'running',
              readiness: {
                ...readiness,
                state: readiness ? 'waiting' : 'not-configured',
              },
            } as const)
          : {}),
      };
      const entry = makeEntry(snapshot);
      entry.managed = managedLaunch?.managed;
      entry.environment = environment;
      entry.events = createWriteStream(join(folder, 'events.jsonl'), {
        flags: 'wx',
        mode: 0o600,
      });
      entry.output = createWriteStream(snapshot.logPath, {
        flags: 'wx',
        mode: 0o600,
      });
      if (entry.managed)
        entry.mirror = createWriteStream(entry.managed.outputPath, {
          flags: 'a',
          mode: 0o600,
        });
      this.#entries.set(id, entry);
      for (const stream of [entry.events, entry.output, entry.mirror].filter(
        (stream): stream is WriteStream => !!stream,
      )) {
        stream.on('drain', () => {
          entry.diskPaused.delete(stream);
          this.#flow(entry);
        });
        stream.on('error', (error) => this.#logFailure(entry, error));
      }
      let exitHooked = false;
      try {
        if (entry.managed)
          await Promise.all(
            [entry.events, entry.output, entry.mirror].map(opened),
          );
        entry.managed?.signal.throwIfAborted();
        entry.pty = spawnPty(
          shell,
          actualArgs,
          {
            cwd,
            cols,
            rows,
            name: 'xterm-256color',
            env: effectiveEnvironment,
            handleFlowControl: false,
          },
          (error) => this.#transportFailure(entry, error),
        );
        snapshot.pid = entry.pty.pid;
        this.#append(entry, 'created', undefined, true);
        entry.pty.onData((data) => {
          for (const part of chunks(data)) {
            this.#write(entry, entry.output, part);
            this.#write(entry, entry.mirror, part);
            this.#append(entry, 'data', part);
            if (
              snapshot.readiness?.pattern &&
              (snapshot.readiness.state === 'waiting' ||
                snapshot.readiness.state === 'failed')
            ) {
              const combined = entry.readinessTail + part;
              if (combined.includes(snapshot.readiness.pattern))
                snapshot.readiness.matchedPattern = true;
              entry.readinessTail = combined.slice(-16384);
            }
          }
        });
        entry.pty.onExit((exit) => {
          entry.pty = undefined;
          snapshot.status = snapshot.error ? 'failed' : 'exited';
          snapshot.exitCode = exit.exitCode;
          if (exit.signal) snapshot.signal = exit.signal;
          snapshot.exitedAt = new Date().toISOString();
          snapshot.exitReason = exit.signal
            ? `signal ${exit.signal}`
            : `exit ${exit.exitCode}`;
          entry.managed?.exit(exit);
          if (snapshot.kind === 'service') {
            snapshot.serviceState =
              snapshot.requestedSignal === 'SIGTERM' ||
              snapshot.requestedSignal === 'SIGKILL' ||
              (snapshot.requestedSignal === 'SIGINT' &&
                (exit.signal === 2 ||
                  exit.exitCode === 130 ||
                  exit.exitCode === 0))
                ? 'stopped'
                : exit.exitCode || exit.signal
                  ? 'failed'
                  : 'exited';
            if (snapshot.readiness?.state === 'waiting') {
              snapshot.readiness.state =
                snapshot.serviceState === 'stopped' ? 'cancelled' : 'failed';
              if (snapshot.serviceState !== 'stopped')
                snapshot.readiness.error = `process ended before readiness: ${snapshot.exitReason}`;
            }
          }
          this.#append(entry, 'exit', undefined, true);
          void this.#finish(entry);
        });
        exitHooked = true;
        if (snapshot.readiness?.state === 'waiting')
          this.#startReadiness(entry);
        await this.#persist(entry);
        return clone(snapshot);
      } catch (error) {
        snapshot.status = 'failed';
        snapshot.error = entry.managed
          ? 'managed command transport could not be initialized'
          : error instanceof Error
            ? error.message
            : String(error);
        snapshot.exitedAt = new Date().toISOString();
        snapshot.exitReason = snapshot.error;
        if (snapshot.kind === 'service') snapshot.serviceState = 'failed';
        // An allocated transport must be returned to its Registry so startup
        // persistence failure cannot strand a process outside its stop owner.
        if (entry.managed && entry.pty) {
          this.#append(entry, 'error', snapshot.error, true);
          entry.managed.fail(Error(snapshot.error));
          return clone(snapshot);
        }
        try {
          this.#append(entry, 'error', snapshot.error, true);
        } catch {}
        // A spawned shell is stopped here; if its exit is unconfirmed the entry
        // keeps its pty so releaseSession and dispose still close it.
        const pty = entry.pty;
        if (pty) {
          const exited = exitHooked
            ? undefined
            : new Promise<void>((resolve) =>
                pty.onExit(() => {
                  entry.pty = undefined;
                  resolve();
                }),
              );
          await terminateOwnedTree(entry, 'SIGKILL').catch(() => undefined);
          if (exited) await Promise.race([exited, delay(3000)]);
          else if (await untilStopped(entry, 3000)) throw error;
        }
        await this.#finish(entry);
        throw error;
      }
    } finally {
      this.#creating--;
    }
  }

  async write(
    owner: string,
    id: string,
    data: string,
  ): Promise<TerminalSnapshot> {
    await this.#ready;
    const entry = this.#get(owner, id, true);
    if (entry.snapshot.status !== 'running')
      throw Error('terminal is stopping');
    if (typeof data !== 'string' || Buffer.byteLength(data) > INPUT_LIMIT)
      throw Error('terminal input is too large');
    entry.pty!.write(data);
    return clone(entry.snapshot);
  }

  async resize(
    owner: string,
    id: string,
    cols: number,
    rows: number,
  ): Promise<TerminalSnapshot> {
    await this.#ready;
    const entry = this.#get(owner, id, true);
    cols = dimension(cols);
    rows = dimension(rows);
    entry.pty!.resize(cols, rows);
    entry.snapshot.cols = cols;
    entry.snapshot.rows = rows;
    this.#append(entry, 'resized', undefined, true);
    await this.#persist(entry);
    return clone(entry.snapshot);
  }

  async signal(
    owner: string,
    id: string,
    signal: TerminalSignal,
  ): Promise<TerminalSnapshot> {
    await this.#ready;
    const entry = this.#get(owner, id, true);
    if (!SIGNALS.has(signal)) throw Error('invalid terminal signal');
    if (entry.managed && signal !== 'SIGINT') {
      await entry.managed.stop('user');
      return clone(entry.snapshot);
    }
    entry.snapshot.requestedSignal = signal;
    if (signal !== 'SIGINT') {
      entry.snapshot.status = 'stopping';
      if (entry.snapshot.kind === 'service')
        entry.snapshot.serviceState = 'stopping';
    }
    this.#append(entry, 'signalRequested', signal, true);
    if (signal === 'SIGINT') {
      // The terminal driver delivers Ctrl+C to the foreground process group. Sending
      // SIGINT only to the shell PID leaves its active command running.
      entry.pty!.write('\x03');
    } else {
      await terminateOwnedTree(entry, signal);
    }
    await this.#persist(entry);
    return clone(entry.snapshot);
  }

  /** Resolves after a real exit and log flush, never merely after requesting stop. */
  async close(owner: string, id: string): Promise<TerminalSnapshot> {
    await this.#ready;
    const entry = this.#get(owner, id);
    if (entry.managed) {
      await entry.managed.stop('user');
      return clone(entry.snapshot);
    }
    return this.#closeTransport(owner, id);
  }

  async #closeTransport(owner: string, id: string): Promise<TerminalSnapshot> {
    await this.#ready;
    const entry = this.#get(owner, id);
    if (!entry.pty) {
      await entry.done;
      if (entry.ownedProcesses.size && !(await untilStopped(entry, 50))) {
        await terminateOwnedTree(entry, 'SIGKILL');
        if (!(await untilStopped(entry, 3000)))
          throw Error('terminal child process stop has not been confirmed');
      }
      await drainObserver(entry);
      return clone(entry.snapshot);
    }
    if (entry.closing) return entry.closing;
    entry.closing = (async () => {
      if (entry.managed) {
        entry.snapshot.requestedSignal = 'SIGTERM';
        entry.snapshot.status = 'stopping';
        this.#append(entry, 'signalRequested', 'SIGTERM', true);
        await terminateOwnedTree(entry, 'SIGTERM');
      } else await this.signal(owner, id, 'SIGTERM');
      if (!(await untilStopped(entry, this.#options.stopGraceMs ?? 1000))) {
        if (entry.pty && !entry.managed)
          await this.signal(owner, id, 'SIGKILL');
        else await terminateOwnedTree(entry, 'SIGKILL');
        if (!(await untilStopped(entry, 3000)))
          throw Error('terminal stop has not been confirmed');
      }
      await drainObserver(entry);
      return clone(entry.snapshot);
    })();
    return entry.closing;
  }

  /** Restarts only the shell. Prior user input is deliberately not re-executed. */
  async restart(owner: string, id: string): Promise<TerminalSnapshot> {
    await this.#ready;
    const previous = this.#get(owner, id);
    const old = previous.snapshot;
    if (old.managedCommand)
      throw Error(
        'managed commands must be started by their original task; restart would execute a new command',
      );
    if (old.transientEnvironment && !previous.environment)
      throw Error(
        'per-launch environment is unavailable after restart; relaunch from its debugger or task',
      );
    await this.close(owner, id);
    const next = await this.#create(
      {
        owner,
        sessionId: old.sessionId,
        cwd: old.cwd,
        ...(old.kind === 'service'
          ? {
              command: old.command,
              readiness:
                old.readiness && old.readiness.state !== 'not-configured'
                  ? {
                      pattern: old.readiness.pattern,
                      port: old.readiness.port,
                      timeoutMs: old.readiness.timeoutMs,
                    }
                  : undefined,
            }
          : { shell: old.shell, args: old.args }),
        cols: old.cols,
        rows: old.rows,
        label: old.label,
        env: previous.environment,
      },
      { serviceId: old.serviceId },
    );
    const entry = this.#get(owner, next.id);
    entry.snapshot.restartOf = id;
    await this.#persist(entry);
    return clone(entry.snapshot);
  }

  /** Terminals that are running, stopping or still hold a live pty after a failed start. */
  async activeIds(owner: string): Promise<string[]> {
    await this.#ready;
    identity(owner, 'owner');
    return [...this.#entries.values()]
      .filter(
        (entry) =>
          entry.snapshot.owner === owner &&
          (!!entry.pty ||
            ['running', 'stopping'].includes(entry.snapshot.status)),
      )
      .map((entry) => entry.snapshot.id);
  }

  /** Oldest first, by when each started: the order tabs are numbered in. */
  async list(owner: string): Promise<TerminalSnapshot[]> {
    await this.#ready;
    identity(owner, 'owner');
    return byStart(
      [...this.#entries.values()]
        .filter((entry) => entry.snapshot.owner === owner)
        .map((entry) => clone(entry.snapshot)),
    );
  }

  async replay(
    owner: string,
    id: string,
    afterSequence = 0,
    limit = 256,
  ): Promise<TerminalReplay> {
    await this.#ready;
    const entry = this.#get(owner, id);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      throw Error('invalid terminal replay cursor');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000)
      throw Error('invalid terminal replay limit');
    await flush(entry.events);
    const events: TerminalEvent[] = [];
    let hasMore = false;
    let bytes = 0;
    const first = entry.ring[0]?.sequence;
    if (first !== undefined && afterSequence >= first - 1) {
      for (const event of entry.ring) {
        if (event.sequence <= afterSequence) continue;
        if (events.length >= limit || bytes > 1024 * 1024) {
          hasMore = true;
          break;
        }
        events.push(clone(event));
        bytes += size(event);
      }
    } else {
      let start = 0;
      for (const [sequence, offset] of entry.offsets)
        if (sequence <= afterSequence + 1 && offset > start) start = offset;
      let offset = start;
      const input = createReadStream(
        join(this.#options.logRoot, id, 'events.jsonl'),
        { encoding: 'utf8', start },
      );
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          const lineOffset = offset;
          offset += Buffer.byteLength(line) + 1;
          let event: TerminalEvent;
          try {
            event = JSON.parse(line) as TerminalEvent;
          } catch {
            continue;
          }
          if ((event.sequence - 1) % 128 === 0)
            checkpoint(entry, event.sequence, lineOffset);
          if (event.sequence <= afterSequence) continue;
          if (events.length >= limit || bytes > 1024 * 1024) {
            hasMore = true;
            break;
          }
          events.push(event);
          bytes += size(event);
        }
      } finally {
        lines.close();
        input.destroy();
      }
    }
    return {
      events,
      nextSequence: events.at(-1)?.sequence ?? afterSequence,
      hasMore,
      snapshot: clone(entry.snapshot),
    };
  }

  /** Views unsubscribe without disposing. Only the application/service owner calls this. */
  async dispose(): Promise<void> {
    await this.#ready;
    this.#disposed = true;
    while (this.#creating) await delay(5);
    const results = await Promise.allSettled(
      [...this.#entries.values()].map((entry) =>
        this.close(entry.snapshot.owner, entry.snapshot.id),
      ),
    );
    const errors = results.filter((result) => result.status === 'rejected');
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason),
        'some terminals did not stop',
      );
  }

  async #initialize(): Promise<void> {
    this.#workspaceRoot = await realpath(this.#options.workspaceRoot);
    await mkdir(this.#options.logRoot, { recursive: true, mode: 0o700 });
    this.#shells = this.#options.shellAllowlist ?? defaultShells();
    if (
      !this.#shells.length ||
      this.#shells.some((shell) => !isAbsolute(shell))
    )
      throw Error('allowed shells must be absolute paths');
    for (const folder of await readdir(this.#options.logRoot, {
      withFileTypes: true,
    })) {
      if (!folder.isDirectory() || !/^[a-f0-9-]{36}$/.test(folder.name))
        continue;
      try {
        const snapshot = JSON.parse(
          await readFile(
            join(this.#options.logRoot, folder.name, 'metadata.json'),
            'utf8',
          ),
        ) as TerminalSnapshot;
        if (snapshot.id !== folder.name || typeof snapshot.owner !== 'string')
          continue;
        snapshot.kind ??= 'shell';
        const entry = makeEntry(snapshot);
        const eventFile = await open(
          join(this.#options.logRoot, folder.name, 'events.jsonl'),
          'r',
        );
        try {
          const length = (await eventFile.stat()).size;
          entry.eventBytes = length;
          const tail = Buffer.alloc(Math.min(length, 128 * 1024));
          await eventFile.read(tail, 0, tail.length, length - tail.length);
          for (const final of tail
            .toString('utf8')
            .split('\n')
            .filter(Boolean)
            .reverse()) {
            try {
              const event = JSON.parse(final) as TerminalEvent;
              if (Number.isSafeInteger(event.sequence))
                snapshot.lastSequence = event.sequence;
              break;
            } catch {
              /* A crash can leave a partial last line. */
            }
          }
        } finally {
          await eventFile.close();
        }
        entry.resolveDone();
        // Previous-process PTYs cannot be safely reattached. Keep their complete
        // logs, mark their state unknown/interrupted and never replay side effects.
        if (snapshot.status === 'running' || snapshot.status === 'stopping') {
          snapshot.status = 'interrupted';
          snapshot.error =
            'application restarted; terminal process state is not confirmed';
          snapshot.pid = undefined;
          snapshot.exitReason = snapshot.error;
          if (snapshot.kind === 'service')
            snapshot.serviceState = 'interrupted';
        }
        this.#entries.set(snapshot.id, entry);
      } catch {
        /* An incomplete creation has no restorable terminal. */
      }
    }
  }

  #startReadiness(entry: Entry): void {
    const config = entry.snapshot.readiness!;
    const deadline = Date.now() + (config.timeoutMs ?? 30000);
    const poll = async () => {
      if (!entry.pty || !['waiting', 'failed'].includes(config.state)) return;
      const matchedPattern =
        !config.pattern ||
        config.matchedPattern === true ||
        entry.readinessTail.includes(config.pattern);
      const listening = !config.port || (await portOpen(config.port));
      if (!entry.pty || !['waiting', 'failed'].includes(config.state)) return;
      const changed =
        config.matchedPattern !== matchedPattern ||
        config.portOpen !== listening;
      config.matchedPattern = matchedPattern;
      config.portOpen = listening;
      if (matchedPattern && listening) {
        config.state = 'ready';
        delete config.error;
        config.readyAt = new Date().toISOString();
        entry.snapshot.serviceState = 'ready';
        this.#append(entry, 'ready', undefined, true);
        await this.#persist(entry);
        return;
      }
      if (Date.now() >= deadline && config.state === 'waiting') {
        config.state = 'failed';
        config.error = `readiness checks did not finish within ${config.timeoutMs ?? 30000}ms`;
        entry.snapshot.serviceState = 'failed';
        this.#append(entry, 'readiness', undefined, true);
        await this.#persist(entry);
      } else if (changed) {
        this.#append(entry, 'readiness', undefined, true);
        await this.#persist(entry);
      }
      if (!entry.pty) return;
      entry.readinessTimer = setTimeout(
        () => {
          void poll().catch((error: unknown) => {
            if (!entry.pty) return;
            config.state = 'failed';
            config.error =
              error instanceof Error ? error.message : String(error);
            entry.snapshot.serviceState = 'failed';
            this.#append(entry, 'readiness', undefined, true);
          });
        },
        config.state === 'failed' ? 1000 : 100,
      );
      entry.readinessTimer.unref();
    };
    void poll().catch((error: unknown) =>
      this.#logFailure(
        entry,
        error instanceof Error ? error : Error(String(error)),
      ),
    );
  }

  #get(owner: string, id: string, running = false): Entry {
    identity(owner, 'owner');
    const entry = this.#entries.get(id);
    if (!entry || entry.snapshot.owner !== owner)
      throw Error('terminal not found');
    if (running && !entry.pty) throw Error('terminal is not running');
    return entry;
  }

  #append(
    entry: Entry,
    kind: TerminalEvent['kind'],
    data?: string,
    withSnapshot = false,
  ): void {
    const s = entry.snapshot;
    const event: TerminalEvent = {
      terminalId: s.id,
      owner: s.owner,
      sessionId: s.sessionId,
      epoch: s.epoch,
      sequence: ++s.lastSequence,
      at: new Date().toISOString(),
      kind,
      ...(data !== undefined ? { data } : {}),
      ...(withSnapshot ? { snapshot: clone(s) } : {}),
    };
    const line = JSON.stringify(event) + '\n';
    if ((event.sequence - 1) % 128 === 0)
      checkpoint(entry, event.sequence, entry.eventBytes);
    entry.eventBytes += Buffer.byteLength(line);
    this.#write(entry, entry.events, line);
    entry.ring.push(event);
    for (const observe of this.#observers) {
      try {
        observe(event);
      } catch {
        /* An observer's failure cannot stop a shell or its log. */
      }
    }
    entry.ringBytes += size(event);
    const budget = Math.max(
      OUTPUT_CHUNK * 4,
      this.#options.ringBytes ?? 1024 * 1024,
    );
    while (entry.ringBytes > budget && entry.ring.length > 1)
      entry.ringBytes -= size(entry.ring.shift()!);
    const bytes = size(event);
    entry.observerBytes += bytes;
    entry.observerQueue = entry.observerQueue
      .then(async () => {
        try {
          await this.#onEvent(clone(event));
        } catch {
          /* An absent/reloading view cannot kill its shell. */
        }
      })
      .finally(() => {
        entry.observerBytes -= bytes;
        this.#flow(entry);
      });
    this.#flow(entry);
  }

  #write(entry: Entry, stream: WriteStream | undefined, data: string): void {
    if (!stream || stream.destroyed || stream.writableEnded) return;
    if (!stream.write(data)) entry.diskPaused.add(stream);
    this.#flow(entry);
  }

  #flow(entry: Entry): void {
    if (!entry.pty) return;
    const pause =
      entry.diskPaused.size > 0 ||
      entry.observerBytes > (this.#options.eventHighWaterBytes ?? 256 * 1024);
    if (pause === entry.paused) return;
    entry.paused = pause;
    try {
      pause ? entry.pty.pause() : entry.pty.resume();
    } catch {
      /* May race an actual exit. */
    }
  }

  #logFailure(entry: Entry, error: Error): void {
    if (entry.snapshot.error) return;
    entry.snapshot.error = entry.managed
      ? 'managed command output could not be written'
      : `terminal log could not be written: ${error.message}`;
    entry.snapshot.status = 'failed';
    entry.snapshot.exitReason = entry.snapshot.error;
    if (entry.snapshot.kind === 'service')
      entry.snapshot.serviceState = 'failed';
    // Disk failure must be visible and must not leave an unobservable process running.
    this.#append(entry, 'error', entry.snapshot.error, true);
    if (entry.managed) entry.managed.fail(Error(entry.snapshot.error));
    else void terminateOwnedTree(entry, 'SIGKILL').catch(() => undefined);
  }

  #transportFailure(entry: Entry, error: Error): void {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = entry.managed
      ? `managed command transport failed${code ? ` (${code})` : ''}`
      : `terminal transport failed${code ? ` (${code})` : ''}: ${error.message}`;
    if (entry.snapshot.error) return;
    entry.snapshot.error = reason;
    entry.snapshot.status = 'failed';
    entry.snapshot.exitReason = reason;
    if (entry.snapshot.kind === 'service')
      entry.snapshot.serviceState = 'failed';
    this.#append(entry, 'error', reason, true);
    // Even during shutdown, retain the original failure. Actual onExit and
    // output persistence remain the only confirmation that this process stopped.
    void this.#persist(entry).catch((failure) =>
      this.#logFailure(entry, failure),
    );
    if (entry.managed) entry.managed.fail(Error(reason));
    else if (entry.pty)
      void terminateOwnedTree(entry, 'SIGKILL').catch((failure) => {
        this.#append(
          entry,
          'error',
          `terminal cleanup failed: ${String(failure)}`,
          true,
        );
        void this.#persist(entry).catch(() => undefined);
      });
  }

  #persist(entry: Entry): Promise<void> {
    const text = JSON.stringify(entry.snapshot, null, 2) + '\n';
    const path = join(
      this.#options.logRoot,
      entry.snapshot.id,
      'metadata.json',
    );
    entry.persist = entry.persist
      .catch(() => undefined)
      .then(async () => {
        const temp = `${path}.${randomUUID()}.tmp`;
        await writeFile(temp, text, { mode: 0o600 });
        await rename(temp, path);
      });
    return entry.persist;
  }

  async #finish(entry: Entry): Promise<void> {
    clearTimeout(entry.readinessTimer);
    try {
      await Promise.all([
        end(entry.events),
        end(entry.output),
        end(entry.mirror),
      ]);
      await this.#persist(entry);
    } catch (error) {
      entry.snapshot.error = entry.managed
        ? 'managed command output flush failed'
        : error instanceof Error
          ? error.message
          : String(error);
      entry.snapshot.status = 'failed';
      entry.managed?.fail(Error('managed command output flush failed'));
    } finally {
      entry.resolveDone();
    }
  }
}

/** A stopped PTY can still have durable consumer events queued behind disk I/O. */
async function drainObserver(entry: Entry): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entry.observerQueue,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Error(
                'terminal event delivery did not finish after process exit',
              ),
            ),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function opened(stream?: WriteStream): Promise<void> {
  if (!stream || !stream.pending) return;
  await new Promise<void>((resolve, reject) => {
    const open = () => {
      stream.off('error', error);
      resolve();
    };
    const error = (failure: Error) => {
      stream.off('open', open);
      reject(failure);
    };
    stream.once('open', open);
    stream.once('error', error);
  });
}

function makeEntry(snapshot: TerminalSnapshot): Entry {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return {
    snapshot,
    ring: [],
    ringBytes: 0,
    diskPaused: new Set(),
    observerBytes: 0,
    observerQueue: Promise.resolve(),
    paused: false,
    done,
    resolveDone,
    persist: Promise.resolve(),
    ownedProcesses: new Map(),
    eventBytes: 0,
    offsets: new Map([[1, 0]]),
    readinessTail: '',
  };
}
function checkpoint(entry: Entry, sequence: number, offset: number): void {
  entry.offsets.set(sequence, offset);
  if (entry.offsets.size > 8192)
    entry.offsets.delete(entry.offsets.keys().next().value!);
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
/** Oldest first; two that started in the same millisecond keep their order. */
function byStart(snapshots: TerminalSnapshot[]): TerminalSnapshot[] {
  return snapshots
    .map((snapshot, index) => ({ snapshot, index }))
    .sort(
      (a, b) =>
        (a.snapshot.startedAt < b.snapshot.startedAt
          ? -1
          : a.snapshot.startedAt > b.snapshot.startedAt
            ? 1
            : 0) || a.index - b.index,
    )
    .map(({ snapshot }) => snapshot);
}
function size(event: TerminalEvent): number {
  return Buffer.byteLength(JSON.stringify(event));
}
function identity(value: string, name: string): void {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 200 ||
    /[\x00-\x1f]/.test(value)
  )
    throw Error(`invalid terminal ${name}`);
}
function dimension(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000)
    throw Error('invalid terminal dimensions');
  return value;
}
function defaultShells(): string[] {
  if (process.platform === 'win32')
    return [process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'];
  return process.platform === 'darwin'
    ? ['/bin/zsh', '/bin/bash', '/bin/sh']
    : ['/bin/bash', '/bin/sh'];
}
function validateShellArgs(shell: string, args: string[]): string[] {
  const name = basename(shell).toLowerCase();
  const flags =
    name === 'cmd.exe'
      ? ['/d', '/q']
      : name.includes('powershell') || name === 'pwsh.exe'
        ? ['-NoLogo', '-NoProfile']
        : name === 'zsh'
          ? ['-l', '-i', '-f']
          : name === 'bash'
            ? ['-l', '-i', '--noprofile', '--norc']
            : ['-l', '-i'];
  if (
    !Array.isArray(args) ||
    args.length > 8 ||
    args.some((arg) => !flags.includes(arg))
  )
    throw Error('only shell startup flags are allowed');
  return [...args];
}
function* chunks(data: string): Generator<string> {
  for (let offset = 0; offset < data.length;) {
    let end = Math.min(offset + OUTPUT_CHUNK, data.length);
    if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--;
    yield data.slice(offset, end);
    offset = end;
  }
}
async function flush(stream?: WriteStream): Promise<void> {
  if (!stream || stream.writableEnded || stream.destroyed) return;
  await new Promise<void>((resolve, reject) => {
    stream.write('', (error) => (error ? reject(error) : resolve()));
  });
}
async function end(stream?: WriteStream): Promise<void> {
  if (!stream || stream.destroyed || stream.writableFinished) return;
  await new Promise<void>((resolve, reject) => {
    stream.once('error', reject);
    stream.end(resolve);
  });
}
async function untilStopped(entry: Entry, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  do {
    const processes = await processTable();
    const alive = [...entry.ownedProcesses].some(([pid, startedAt]) => {
      const current = processes.get(pid);
      return current?.startedAt === startedAt && !current.state.startsWith('Z');
    });
    if (!entry.pty && !alive) {
      await entry.done;
      return true;
    }
    await delay(25);
  } while (Date.now() < deadline);
  return false;
}
async function terminateOwnedTree(
  entry: Entry,
  signal: 'SIGTERM' | 'SIGKILL',
): Promise<void> {
  const terminal = entry.pty;
  if (process.platform === 'win32') {
    if (!terminal) return;
    if (hasNativePtyProcessExited(terminal)) {
      if (!(await untilStopped(entry, 3000)))
        throw Error(
          'native terminal exited but its final output closure is unconfirmed',
        );
      return;
    }
    // ConPTY's owning process is the only PID supplied; never accept arbitrary PIDs.
    await exec('taskkill', ['/pid', String(terminal.pid), '/T', '/F'], {
      windowsHide: true,
    }).catch(async (error: NodeJS.ErrnoException) => {
      // The debugger may have ended it between the native-exit check and
      // taskkill. Success still requires its actual onExit and flushed logs.
      if (entry.pty === terminal && !(await untilStopped(entry, 3000)))
        throw error;
    });
    return;
  }
  // Interactive shells give foreground and background jobs their own process groups.
  // Capture descendants while the owned shell is alive, then stop leaves before the
  // shell. This avoids both orphaning jobs and killing an unrelated process group.
  const processes = await processTable();
  const children = new Map<number, number[]>();
  for (const [pid, process] of processes) {
    children.set(process.parent, [
      ...(children.get(process.parent) ?? []),
      pid,
    ]);
  }
  const ordered: number[] = [];
  const walk = (pid: number) => {
    for (const child of children.get(pid) ?? []) walk(child);
    ordered.push(pid);
  };
  if (terminal && entry.pty === terminal) {
    walk(terminal.pid);
    for (const pid of ordered) {
      const current = processes.get(pid);
      if (current) entry.ownedProcesses.set(pid, current.startedAt);
    }
  }
  for (const [pid, startedAt] of entry.ownedProcesses) {
    const current = processes.get(pid);
    if (current?.startedAt !== startedAt || current.state.startsWith('Z'))
      continue;
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}

async function processTable(): Promise<
  Map<number, { parent: number; startedAt: string; state: string }>
> {
  if (process.platform === 'win32') return new Map();
  const { stdout } = await exec(
    '/bin/ps',
    ['-A', '-o', 'pid=,ppid=,lstart=,stat='],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  const result = new Map<
    number,
    { parent: number; startedAt: string; state: string }
  >();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s*$/.exec(line);
    if (match)
      result.set(Number(match[1]), {
        parent: Number(match[2]),
        startedAt: match[3]!,
        state: match[4]!,
      });
  }
  return result;
}

function validateEnvironment(
  input?: Record<string, string | null>,
): Record<string, string | null> | undefined {
  if (input === undefined) return;
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw Error('invalid terminal environment');
  const entries = Object.entries(input);
  if (
    entries.length > 1024 ||
    entries.some(
      ([name, value]) =>
        !name ||
        /[=\0]/.test(name) ||
        name.length > 1024 ||
        (value !== null &&
          (typeof value !== 'string' ||
            value.includes('\0') ||
            value.length > 1024 * 1024)),
    )
  )
    throw Error('invalid terminal environment');
  return Object.fromEntries(entries);
}

function validateReadiness(
  options?: TerminalReadinessOptions,
): TerminalReadinessOptions | undefined {
  if (options === undefined) return;
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw Error('invalid readiness checks');
  if (
    options.pattern !== undefined &&
    (typeof options.pattern !== 'string' ||
      !options.pattern ||
      options.pattern.length > 512)
  )
    throw Error('invalid readiness pattern');
  if (
    options.port !== undefined &&
    (!Number.isSafeInteger(options.port) ||
      options.port < 1 ||
      options.port > 65535)
  )
    throw Error('invalid readiness port');
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 300000)
  )
    throw Error('invalid readiness timeout');
  if (!options.pattern && !options.port)
    throw Error('choose a readiness pattern or port');
  return { ...options, timeoutMs: options.timeoutMs ?? 30000 };
}
async function portOpen(port: number): Promise<boolean> {
  const results = await Promise.all(
    ['127.0.0.1', '::1'].map((host) => probeLoopback(host, port)),
  );
  return results.some(Boolean);
}
async function probeLoopback(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(150, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
async function executable(
  command: TerminalCommand,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ file: string; args: string[] }> {
  if (
    !command ||
    typeof command.file !== 'string' ||
    !command.file.trim() ||
    command.file.length > 4096 ||
    command.file.includes('\0')
  )
    throw Error('invalid service executable');
  const args = command.args ?? [];
  if (
    !Array.isArray(args) ||
    args.length > 256 ||
    args.some(
      (arg) =>
        typeof arg !== 'string' || arg.length > 65536 || arg.includes('\0'),
    )
  )
    throw Error('invalid service arguments');
  const paths =
    isAbsolute(command.file) ||
    command.file.includes('/') ||
    command.file.includes('\\')
      ? [resolve(cwd, command.file)]
      : (env.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((folder) => resolve(folder, command.file));
  for (const path of paths) {
    for (const candidate of process.platform === 'win32'
      ? [path, path + '.exe', path + '.cmd']
      : [path]) {
      try {
        const file = await realpath(candidate);
        if (!(await stat(file)).isFile()) continue;
        await access(file, constants.X_OK);
        if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
          // npm's Windows shim is a batch file, not a CreateProcess executable.
          // Run its actual JS entry through Node instead of interpolating cmd text.
          const npm = basename(file)
            .replace(/\.(cmd|bat)$/i, '')
            .toLowerCase();
          if (npm !== 'npm' && npm !== 'npx')
            throw Error('batch services need an executable command');
          const cli = join(
            dirname(file),
            'node_modules',
            'npm',
            'bin',
            npm === 'npm' ? 'npm-cli.js' : 'npx-cli.js',
          );
          await access(cli);
          const node = await executable(
            { file: 'node', args: [cli, ...args] },
            cwd,
            env,
          );
          return node;
        }
        return { file, args: [...args] };
      } catch (error) {
        if (!(error as NodeJS.ErrnoException).code) throw error;
      }
    }
  }
  throw Error(`service executable was not found: ${command.file}`);
}
