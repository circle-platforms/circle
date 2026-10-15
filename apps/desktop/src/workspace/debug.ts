import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

/** Content-Length framed DAP transport. A failed connection rejects every waiter. */
export class DapConnection extends EventEmitter {
  readonly initialized: Promise<void>;
  private buffer = Buffer.alloc(0);
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private socket: Socket,
    private reverse?: (command: string, args: any) => Promise<any>,
  ) {
    super();
    this.initialized = new Promise((resolve) =>
      this.once('initialized', () => resolve()),
    );
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parse();
    });
    socket.on('error', (e) => this.fail(e));
    socket.on('close', () => {
      this.fail(Error('debug adapter disconnected'));
      this.emit('closed');
    });
  }
  private send(message: Record<string, unknown>) {
    const body = Buffer.from(
      JSON.stringify({ seq: ++this.sequence, ...message }),
    );
    this.socket.write(
      Buffer.concat([
        Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
        body,
      ]),
    );
    return this.sequence;
  }
  request(command: string, args: Record<string, unknown> = {}): Promise<any> {
    const seq = this.sequence + 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(Error(`debug request timed out: ${command}`));
      }, 15000);
      this.pending.set(seq, { resolve, reject, timer });
      this.send({ type: 'request', command, arguments: args });
    });
  }
  private parse() {
    while (true) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const match = /Content-Length: (\d+)/i.exec(
        this.buffer.subarray(0, end).toString(),
      );
      if (!match || +match[1] > 16 * 1024 * 1024) {
        this.close();
        return;
      }
      const length = +match[1];
      if (this.buffer.length < end + 4 + length) return;
      const raw = this.buffer.subarray(end + 4, end + 4 + length);
      this.buffer = this.buffer.subarray(end + 4 + length);
      let message: any;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        this.close();
        return;
      }
      if (message.type === 'response') {
        const pending = this.pending.get(message.request_seq);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(message.request_seq);
          message.success
            ? pending.resolve(message.body ?? {})
            : pending.reject(Error(message.message ?? 'debug request failed'));
        }
      } else if (message.type === 'event')
        this.emit(message.event, message.body ?? {});
      else if (message.type === 'request') {
        Promise.resolve()
          .then(() => {
            if (!this.reverse)
              throw Error('debug adapter request is not supported');
            return this.reverse(message.command, message.arguments ?? {});
          })
          .then(
            (body) =>
              this.send({
                type: 'response',
                request_seq: message.seq,
                command: message.command,
                success: true,
                body,
              }),
            (e) =>
              this.send({
                type: 'response',
                request_seq: message.seq,
                command: message.command,
                success: false,
                message: String(e),
              }),
          );
      }
    }
  }
  private fail(e: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
  close() {
    this.fail(Error('debug connection closed'));
    this.socket.destroy();
  }
}

export interface DebugOptions {
  workspaceRoot: string;
  /** Adapter host; packaged Electron is valid with ELECTRON_RUN_AS_NODE. */
  nodeExecutable: string;
  /** Real Node runtime for the debuggee; Electron may ignore its bootloader options. */
  runtimeExecutable?: string;
  adapterPath: string;
  emit?: (snapshot: DebugSnapshot) => void;
  runInTerminal?: (args: {
    args: string[];
    cwd: string;
    env?: Record<string, string | null>;
  }) => Promise<{ processId: number; shellProcessId?: number }>;
}
export interface DebugSnapshot {
  status: 'idle' | 'starting' | 'running' | 'paused' | 'stopped' | 'failed';
  threadId?: number;
  pauseId?: number;
  reason?: string;
  output: string;
  breakpoints: Record<string, any[]>;
  adapterPid?: number;
}
export class WorkspaceDebugService {
  private adapter?: ChildProcess;
  private dap?: DapConnection;
  private target?: DapConnection;
  private generation = 0;
  private launched = false;
  private resumeEntry = false;
  private connections = new Set<DapConnection>();
  private state: DebugSnapshot = {
    status: 'idle',
    output: '',
    breakpoints: {},
  };
  private emptyArgument?: string;
  constructor(private options: DebugOptions) {}
  snapshot() {
    return structuredClone(this.state);
  }
  private publish(patch: Partial<DebugSnapshot>) {
    Object.assign(this.state, patch);
    this.options.emit?.(this.snapshot());
  }
  private async file(input: unknown) {
    if (typeof input !== 'string') throw Error('source path is required');
    const root = await realpath(this.options.workspaceRoot);
    const resolved = await realpath(path.resolve(root, input));
    if (resolved !== root && !resolved.startsWith(root + path.sep))
      throw Error('debug source is outside the workspace');
    if (!(await stat(resolved)).isFile())
      throw Error('debug source must be a file');
    return resolved;
  }
  private async start() {
    if (this.adapter) throw Error('a debug session is already running');
    const generation = ++this.generation;
    this.publish({
      status: 'starting',
      output: '',
      reason: undefined,
      threadId: undefined,
    });
    try {
      const adapter = (this.adapter = spawn(
        this.options.nodeExecutable,
        [this.options.adapterPath, '0', '127.0.0.1'],
        {
          cwd: this.options.workspaceRoot,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ));
      const port = await new Promise<number>((resolve, reject) => {
        let text = '';
        const timer = setTimeout(
          () => reject(Error('debug adapter did not start')),
          10000,
        );
        const cleanup = () => {
          clearTimeout(timer);
          adapter.stdout?.off('data', data);
          adapter.off('error', error);
          adapter.off('exit', exit);
        };
        const error = (e: Error) => {
          cleanup();
          reject(e);
        };
        const exit = () =>
          error(Error('debug adapter exited before listening'));
        const data = (chunk: Buffer) => {
          text += chunk.toString();
          const m =
            /listening (?:on|at).*?:(\d+)/i.exec(text) ??
            /listening at port (\d+)/i.exec(text);
          if (m) {
            cleanup();
            resolve(+m[1]);
          }
        };
        adapter.stdout!.on('data', data);
        adapter.once('error', error);
        adapter.once('exit', exit);
      });
      if (generation !== this.generation) throw Error('debug launch cancelled');
      const socket = await new Promise<Socket>((resolve, reject) => {
        const s = connect(port, '127.0.0.1', () => resolve(s));
        s.once('error', reject);
      });
      const makeConnection = (socket: Socket): DapConnection => {
        const connection = new DapConnection(socket, async (command, args) => {
          if (command === 'startDebugging') {
            const childSocket = await new Promise<Socket>((resolve, reject) => {
              const s = connect(port, '127.0.0.1', () => resolve(s));
              s.once('error', reject);
            });
            const child = makeConnection(childSocket);
            this.target = child;
            const initialized = child.initialized;
            await child.request('initialize', {
              clientID: 'circle',
              adapterID: 'pwa-node',
              pathFormat: 'path',
              linesStartAt1: true,
              columnsStartAt1: true,
              supportsRunInTerminalRequest: !!this.options.runInTerminal,
            });
            const launched = child.request(
              args.configuration.request ?? 'attach',
              args.configuration,
            );
            await Promise.race([initialized, launched]);
            for (const [source, breakpoints] of Object.entries(
              this.state.breakpoints,
            ))
              await child.request('setBreakpoints', {
                source: { path: source },
                breakpoints: breakpoints.map((b) => ({ line: b.line })),
              });
            await child.request('configurationDone');
            await launched;
            return {};
          }
          if (command === 'runInTerminal' && this.options.runInTerminal)
            return this.options.runInTerminal({
              ...args,
              args: args.args.map((value: string) =>
                value === this.emptyArgument ? '' : value,
              ),
            });
          throw Error(`unsupported debug adapter request: ${command}`);
        });
        this.connections.add(connection);
        connection.on('output', (body) => {
          if (generation !== this.generation) return;
          if (body.category !== 'telemetry')
            this.publish({
              output: (this.state.output + (body.output ?? '')).slice(
                -1024 * 1024,
              ),
            });
        });
        connection.on('breakpoint', (body) => {
          if (generation !== this.generation) return;
          const b = body.breakpoint;
          if (!b) return;
          for (const [source, rows] of Object.entries(this.state.breakpoints)) {
            const index = rows.findIndex(
              (row) =>
                row.id === b.id ||
                (row.line === b.line &&
                  (!b.source?.path || b.source.path === source)),
            );
            if (index >= 0) rows[index] = { ...rows[index], ...b };
          }
          this.publish({});
        });
        connection.on('stopped', async (body) => {
          if (generation !== this.generation) return;
          const resumeEntry = body.reason === 'entry' && this.resumeEntry;
          this.resumeEntry = false;
          if (resumeEntry) {
            try {
              for (const [source, breakpoints] of Object.entries(
                this.state.breakpoints,
              ))
                await connection.request('setBreakpoints', {
                  source: { path: source },
                  breakpoints: breakpoints.map((b) => ({ line: b.line })),
                });
              await connection.request('continue', { threadId: body.threadId });
            } catch (e) {
              this.publish({ status: 'failed', reason: String(e) });
            }
            return;
          }
          this.publish({
            status: 'paused',
            pauseId: (this.state.pauseId ?? 0) + 1,
            threadId: body.threadId,
            reason: body.reason,
          });
        });
        connection.on('continued', () => {
          if (generation === this.generation)
            this.publish({ status: 'running', reason: undefined });
        });
        connection.on('terminated', () => {
          if (generation === this.generation)
            this.publish({ status: 'stopped' });
        });
        connection.on('closed', () => {
          if (generation === this.generation && this.state.status !== 'stopped')
            this.publish({
              status: 'failed',
              reason: 'debug adapter disconnected',
            });
        });
        return connection;
      };
      const dap = (this.dap = makeConnection(socket));
      adapter.on('exit', () => {
        if (this.adapter === adapter) {
          this.adapter = undefined;
          this.dap?.close();
          this.dap = undefined;
        }
      });
      await dap.request('initialize', {
        clientID: 'circle',
        adapterID: 'pwa-node',
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsRunInTerminalRequest: !!this.options.runInTerminal,
        supportsVariableType: true,
      });
      this.publish({ adapterPid: adapter.pid });
      return dap;
    } catch (e) {
      if (generation !== this.generation) throw e;
      await this.stop();
      this.publish({ status: 'failed', reason: String(e) });
      throw e;
    }
  }
  async handle(method: string, params: Record<string, any> = {}): Promise<any> {
    if (method === 'snapshot') return this.snapshot();
    if (method === 'stop') {
      await this.stop();
      return this.snapshot();
    }
    if (method === 'launch' || method === 'attach') {
      if (this.adapter && ['stopped', 'failed'].includes(this.state.status))
        await this.stop();
      const program =
        method === 'launch' ? await this.file(params.program) : undefined;
      if (
        method === 'attach' &&
        (!Number.isInteger(params.port) ||
          params.port < 1 ||
          params.port > 65535)
      )
        throw Error('a local Node inspector port is required');
      if (
        params.args !== undefined &&
        (!Array.isArray(params.args) ||
          params.args.some((a: unknown) => typeof a !== 'string'))
      )
        throw Error('program arguments must be strings');
      this.launched = method === 'launch';
      this.resumeEntry = method === 'launch' && params.stopOnEntry !== true;
      this.options.workspaceRoot = await realpath(this.options.workspaceRoot);
      const dap = await this.start();
      const generation = this.generation;
      try {
        const initialized = dap.initialized;
        const launchArgs: string[] = Array.isArray(params.args)
          ? params.args
          : [];
        // js-debug 1.140 filters empty configuration.args before spawning.
        // Keep terminal argv literal with a private one-run placeholder; the
        // internal console fallback uses runtimeArgs, which retains empties.
        this.emptyArgument = `circle-empty-argument-${randomUUID()}`;
        const internalEmptyArgs =
          !this.options.runInTerminal && launchArgs.includes('');
        const launch = dap.request(method, {
          type: 'pwa-node',
          request: method,
          name: 'circle project',
          cwd: this.options.workspaceRoot,
          program: internalEmptyArgs ? undefined : program,
          args: internalEmptyArgs
            ? []
            : launchArgs.map((value) =>
                value === '' ? this.emptyArgument! : value,
              ),
          ...(internalEmptyArgs
            ? { runtimeArgs: [program, ...launchArgs] }
            : {}),
          runtimeExecutable:
            this.options.runtimeExecutable ?? this.options.nodeExecutable,
          env: { ELECTRON_RUN_AS_NODE: '1' },
          console: this.options.runInTerminal
            ? 'integratedTerminal'
            : 'internalConsole',
          sourceMaps: true,
          pauseForSourceMap: true,
          __workspaceFolder: this.options.workspaceRoot,
          autoAttachChildProcesses: false,
          outFiles: [path.join(this.options.workspaceRoot, '**/*.js')],
          ...(method === 'attach'
            ? { port: params.port, address: '127.0.0.1' }
            : { stopOnEntry: true }),
        });
        await Promise.race([initialized, launch]);
        for (const [source, breakpoints] of Object.entries(
          this.state.breakpoints,
        ))
          await dap.request('setBreakpoints', {
            source: { path: source },
            breakpoints: breakpoints.map((b) => ({ line: b.line })),
          });
        await dap.request('configurationDone');
        await launch;
        if (this.state.status === 'starting')
          this.publish({ status: 'running' });
        return this.snapshot();
      } catch (e) {
        if (generation === this.generation) {
          await this.stop();
          this.publish({ status: 'failed', reason: String(e) });
        }
        throw e;
      }
    }
    if (method === 'setBreakpoints') {
      const source = await this.file(params.path);
      const lines = params.lines;
      if (
        !Array.isArray(lines) ||
        lines.some((n) => !Number.isInteger(n) || n < 1)
      )
        throw Error('breakpoint lines must be positive integers');
      const result = this.dap
        ? await (this.target ?? this.dap).request(method, {
            source: { path: source },
            breakpoints: lines.map((line) => ({ line })),
          })
        : {
            breakpoints: lines.map((line) => ({
              line,
              verified: false,
              source: { path: source },
            })),
          };
      this.state.breakpoints[source] = result.breakpoints;
      this.publish({});
      return result;
    }
    const allowed = [
      'threads',
      'stackTrace',
      'scopes',
      'variables',
      'next',
      'stepIn',
      'stepOut',
      'continue',
      'pause',
      'evaluate',
    ];
    if (!allowed.includes(method))
      throw Error(`unknown debug method: ${method}`);
    if (!this.dap) throw Error('no debug session is running');
    const args = { ...params };
    if (
      ['next', 'stepIn', 'stepOut', 'continue', 'pause', 'stackTrace'].includes(
        method,
      )
    ) {
      args.threadId ??= this.state.threadId;
      if (args.threadId === undefined) {
        const result = await (this.target ?? this.dap).request('threads');
        args.threadId = result.threads?.[0]?.id;
        if (args.threadId === undefined)
          throw Error('no debug thread is ready');
      }
    }
    return (this.target ?? this.dap).request(method, args);
  }
  async stop() {
    this.generation++;
    this.resumeEntry = false;
    this.publish({
      status: 'stopped',
      threadId: undefined,
      adapterPid: undefined,
    });
    const dap = this.dap;
    this.dap = undefined;
    const target = this.target;
    this.target = undefined;
    if (target) {
      try {
        await Promise.race([
          target.request('disconnect', { terminateDebuggee: this.launched }),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      } catch {}
    }
    if (dap) {
      try {
        await Promise.race([
          dap.request('disconnect', { terminateDebuggee: this.launched }),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      } catch {}
    }
    for (const connection of this.connections) connection.close();
    this.connections.clear();
    const adapter = this.adapter;
    this.adapter = undefined;
    if (adapter && !adapter.killed) {
      adapter.kill();
      await new Promise<void>((resolve) => {
        if (adapter.exitCode !== null || adapter.signalCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          adapter.kill('SIGKILL');
          resolve();
        }, 1000);
        adapter.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
  async dispose() {
    await this.stop();
  }
}
