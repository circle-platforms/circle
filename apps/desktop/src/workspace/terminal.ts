import { spawn as spawnPty, type IPty } from 'node-pty';
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
  restartOf?: string;
  kind: 'shell' | 'service';
  command?: TerminalCommand;
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
    | 'ready';
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

export interface TerminalReplay {
  events: TerminalEvent[];
  nextSequence: number;
  hasMore: boolean;
  snapshot: TerminalSnapshot;
}

interface Entry {
  snapshot: TerminalSnapshot;
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
  readonly #ready: Promise<void>;
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
  }

  async create(options: TerminalCreateOptions): Promise<TerminalSnapshot> {
    return this.#create(options);
  }

  async #create(
    options: TerminalCreateOptions,
    restart?: { serviceId?: string },
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
      if (readiness?.port && (await portOpen(readiness.port)))
        throw Error(`port ${readiness.port} is already in use`);
      const command = options.command
        ? await executable(options.command, cwd, {
            ...process.env,
            ...this.#options.env,
          })
        : undefined;
      const shell = command?.file ?? configuredShell;
      const args =
        command?.args ?? validateShellArgs(shell, options.args ?? []);
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
        ...(command
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
      entry.events = createWriteStream(join(folder, 'events.jsonl'), {
        flags: 'wx',
        mode: 0o600,
      });
      entry.output = createWriteStream(snapshot.logPath, {
        flags: 'wx',
        mode: 0o600,
      });
      this.#entries.set(id, entry);
      for (const stream of [entry.events, entry.output]) {
        stream.on('drain', () => {
          entry.diskPaused.delete(stream);
          this.#flow(entry);
        });
        stream.on('error', (error) => this.#logFailure(entry, error));
      }
      try {
        entry.pty = spawnPty(shell, args, {
          cwd,
          cols,
          rows,
          name: 'xterm-256color',
          env: { ...process.env, ...this.#options.env, TERM: 'xterm-256color' },
          handleFlowControl: false,
        });
        snapshot.pid = entry.pty.pid;
        this.#append(entry, 'created', undefined, true);
        entry.pty.onData((data) => {
          for (const part of chunks(data)) {
            this.#write(entry, entry.output, part);
            this.#append(entry, 'data', part);
            if (
              snapshot.readiness?.pattern &&
              snapshot.readiness.state === 'waiting'
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
        if (snapshot.readiness?.state === 'waiting')
          this.#startReadiness(entry);
        await this.#persist(entry);
        return clone(snapshot);
      } catch (error) {
        snapshot.status = 'failed';
        snapshot.error = error instanceof Error ? error.message : String(error);
        snapshot.exitedAt = new Date().toISOString();
        snapshot.exitReason = snapshot.error;
        if (snapshot.kind === 'service') snapshot.serviceState = 'failed';
        this.#append(entry, 'error', snapshot.error, true);
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
    if (!entry.pty) {
      await entry.done;
      if (entry.ownedProcesses.size && !(await untilStopped(entry, 50))) {
        await terminateOwnedTree(entry, 'SIGKILL');
        if (!(await untilStopped(entry, 3000)))
          throw Error('terminal child process stop has not been confirmed');
      }
      return clone(entry.snapshot);
    }
    if (entry.closing) return entry.closing;
    entry.closing = (async () => {
      await this.signal(owner, id, 'SIGTERM');
      if (!(await untilStopped(entry, this.#options.stopGraceMs ?? 1000))) {
        if (entry.pty) await this.signal(owner, id, 'SIGKILL');
        else await terminateOwnedTree(entry, 'SIGKILL');
        if (!(await untilStopped(entry, 3000)))
          throw Error('terminal stop has not been confirmed');
      }
      return clone(entry.snapshot);
    })();
    return entry.closing;
  }

  /** Restarts only the shell. Prior user input is deliberately not re-executed. */
  async restart(owner: string, id: string): Promise<TerminalSnapshot> {
    await this.#ready;
    const old = this.#get(owner, id).snapshot;
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
      },
      { serviceId: old.serviceId },
    );
    const entry = this.#get(owner, next.id);
    entry.snapshot.restartOf = id;
    await this.#persist(entry);
    return clone(entry.snapshot);
  }

  async list(owner: string): Promise<TerminalSnapshot[]> {
    await this.#ready;
    identity(owner, 'owner');
    return [...this.#entries.values()]
      .filter((entry) => entry.snapshot.owner === owner)
      .map((entry) => clone(entry.snapshot));
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
      if (!entry.pty || config.state !== 'waiting') return;
      const matchedPattern =
        !config.pattern ||
        config.matchedPattern === true ||
        entry.readinessTail.includes(config.pattern);
      const listening = !config.port || (await portOpen(config.port));
      if (!entry.pty || config.state !== 'waiting') return;
      const changed =
        config.matchedPattern !== matchedPattern ||
        config.portOpen !== listening;
      config.matchedPattern = matchedPattern;
      config.portOpen = listening;
      if (matchedPattern && listening) {
        config.state = 'ready';
        config.readyAt = new Date().toISOString();
        entry.snapshot.serviceState = 'ready';
        this.#append(entry, 'ready', undefined, true);
        await this.#persist(entry);
        return;
      }
      if (Date.now() >= deadline) {
        config.state = 'failed';
        config.error = `readiness checks did not finish within ${config.timeoutMs ?? 30000}ms`;
        entry.snapshot.serviceState = 'failed';
        this.#append(entry, 'readiness', undefined, true);
        await this.#persist(entry);
        return;
      }
      if (changed) {
        this.#append(entry, 'readiness', undefined, true);
        await this.#persist(entry);
      }
      entry.readinessTimer = setTimeout(() => {
        void poll().catch((error: unknown) => {
          if (!entry.pty) return;
          config.state = 'failed';
          config.error = error instanceof Error ? error.message : String(error);
          entry.snapshot.serviceState = 'failed';
          this.#append(entry, 'readiness', undefined, true);
        });
      }, 100);
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
    entry.snapshot.error = `terminal log could not be written: ${error.message}`;
    entry.snapshot.status = 'failed';
    entry.snapshot.exitReason = entry.snapshot.error;
    if (entry.snapshot.kind === 'service')
      entry.snapshot.serviceState = 'failed';
    // Disk failure must be visible and must not leave an unobservable process running.
    this.#append(entry, 'error', entry.snapshot.error, true);
    void terminateOwnedTree(entry, 'SIGKILL').catch(() => undefined);
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
      await Promise.all([end(entry.events), end(entry.output)]);
      await this.#persist(entry);
    } catch (error) {
      entry.snapshot.error =
        error instanceof Error ? error.message : String(error);
      entry.snapshot.status = 'failed';
    } finally {
      entry.resolveDone();
    }
  }
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
    // ConPTY's owning process is the only PID supplied; never accept arbitrary PIDs.
    await exec('taskkill', ['/pid', String(terminal.pid), '/T', '/F'], {
      windowsHide: true,
    }).catch((error: NodeJS.ErrnoException) => {
      if (entry.pty) throw error;
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
