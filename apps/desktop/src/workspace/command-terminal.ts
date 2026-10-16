import { createServer, type Socket } from 'node:net';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type {
  CommandLauncher,
  CommandPtyRootExit,
  CommandPtyCompletion,
} from '../../../../src/command_process.js';
import type {
  TerminalManager,
  ManagedTerminalCommandHandle,
} from './terminal.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

export interface TerminalCommandLauncherOptions {
  terminals: TerminalManager;
  runtimeExecutable: string;
  supervisorPath: string;
  /** Trusted Registry epoch; never supplied by terminal RPC parameters. */
  executionEpoch?: string;
  /** Strict actual-session Registry control; no renderer-selected owner enters here. */
  stopExecution: (
    sessionId: string,
    executionId: string,
    reason: string,
  ) => Promise<unknown>;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
}

/**
 * One original PTY and actual command, with explicitly bounded process-group facts.
 * An escaped daemon is outside this group; it is never killed or called cleaned up.
 * Windows remains closed until its real JobObject transport is implemented.
 */
export function createTerminalCommandLauncher(
  options: TerminalCommandLauncherOptions,
): CommandLauncher {
  return async (request) => {
    if (process.platform === 'win32')
      throw Error(
        'managed command process-tree ownership is unavailable on Windows',
      );
    request.signal.throwIfAborted();
    const executionId = request.executionId,
      owner = request.origin.executionSessionId;
    const directory = await mkdtemp(join(tmpdir(), 'circle-command-'));
    await chmod(directory, 0o700);
    const path = join(directory, 'control.sock'),
      token = randomUUID();
    const started = deferred<{ pid: number; group: number }>(),
      actualRootExit = deferred<CommandPtyRootExit>(),
      groupEmpty = deferred<void>(),
      runFailure = deferred<never>();
    const rootExit = Promise.race([actualRootExit.promise, runFailure.promise]);
    void rootExit.catch(() => {});
    const completion: CommandPtyCompletion = {
      kind: 'pty-group',
      descendantCoverage: {
        state: 'unknown',
        reason: 'coverage-unavailable',
        observedAt: Date.now(),
      },
    };
    const coverageListeners = new Set<() => void>();
    const terminalReady = deferred<ManagedTerminalCommandHandle>();
    let socket: Socket | undefined,
      terminal: ManagedTerminalCommandHandle | undefined;
    let accepted = false,
      startSent = false,
      empty = false,
      armed = false,
      rootObserved = false;
    let failed: Error | undefined, controlFailure: Error | undefined;
    let group: number | undefined, commandPid: number | undefined;
    let stopping: Promise<void> | undefined,
      cleanup: Promise<void> | undefined,
      stateQueue = Promise.resolve();
    const fail = (message: string, controlUnknown = true) => {
      const error = Error(message);
      failed ??= error;
      started.reject(failed);
      runFailure.reject(failed);
      if (controlUnknown) {
        controlFailure ??= error;
        actualRootExit.reject(controlFailure);
        groupEmpty.reject(controlFailure);
      }
    };
    const record = () => {
      const state = { commandPid, completion: structuredClone(completion) };
      stateQueue = stateQueue.then(async () => {
        await (terminal ?? (await terminalReady.promise)).recordState(state);
      });
      void stateQueue.catch(() =>
        fail('managed command scope could not be persisted', false),
      );
      return stateQueue;
    };
    const observeRoot = (value: CommandPtyRootExit) => {
      if (rootObserved) return;
      rootObserved = true;
      completion.rootExit = { ...value, observedAt: Date.now() };
      actualRootExit.resolve(value);
      void record()
        .then(() => {
          if (socket && !socket.destroyed)
            socket.write(JSON.stringify({ kind: 'root-exit-ack' }) + '\n');
        })
        .catch(() => {});
    };
    const observeEmpty = () => {
      if (empty) return;
      empty = true;
      completion.controlledGroupEmpty = { observedAt: Date.now() };
      groupEmpty.resolve();
      void record()
        .then(() => {
          if (socket && !socket.destroyed)
            socket.write(JSON.stringify({ kind: 'group-empty-ack' }) + '\n');
        })
        .catch(() => {});
    };
    const observeCoverage = () => {
      if (completion.descendantCoverage.state === 'unmanaged') return;
      completion.descendantCoverage = {
        state: 'unmanaged',
        reason: 'outside-controlled-group',
        observedAt: Date.now(),
      };
      for (const listener of coverageListeners) {
        try {
          listener();
        } catch {
          /* A view does not own this command. */
        }
      }
      void record();
    };
    const clients = new Set<Socket>();
    const server = createServer((client) => {
      clients.add(client);
      client.once('close', () => clients.delete(client));
      if (socket) {
        client.destroy();
        return;
      }
      let input = '',
        authenticated = false;
      client.setEncoding('utf8');
      client.on('data', (part: string) => {
        input += part;
        if (Buffer.byteLength(input) > 64 * 1024) {
          client.destroy();
          if (authenticated) fail('private command control exceeded its limit');
          return;
        }
        for (let index; (index = input.indexOf('\n')) >= 0;) {
          const line = input.slice(0, index);
          input = input.slice(index + 1);
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line) as Record<string, unknown>;
          } catch {
            client.destroy();
            if (authenticated) fail('private command control was invalid');
            return;
          }
          if (!authenticated) {
            if (message.kind !== 'hello' || message.token !== token) {
              client.destroy();
              return;
            }
            authenticated = true;
            socket = client;
            if (request.signal.aborted) {
              client.write(JSON.stringify({ kind: 'stop' }) + '\n');
              continue;
            }
            const payload =
              JSON.stringify({ kind: 'start', command: request.command }) +
              '\n';
            if (Buffer.byteLength(payload) > 4 * 1024 * 1024) {
              fail(
                'approved command is too large for its private control pipe',
              );
              client.end();
              return;
            }
            startSent = true;
            client.write(payload);
            continue;
          }
          if (
            message.kind === 'started' &&
            Number.isSafeInteger(message.pid) &&
            Number(message.pid) > 0 &&
            Number.isSafeInteger(message.group) &&
            Number(message.group) > 0
          ) {
            commandPid = Number(message.pid);
            group = Number(message.group);
            accepted = true;
            started.resolve({ pid: commandPid, group });
            void record();
          } else if (
            message.kind === 'root-exit' &&
            Number.isInteger(message.exitCode) &&
            ['active', 'empty', 'unknown'].includes(
              String(message.controlledGroupAtExit),
            ) &&
            (message.signal === undefined ||
              (Number.isInteger(message.signal) &&
                Number(message.signal) >= 0 &&
                Number(message.signal) <= 128))
          ) {
            observeRoot({
              exitCode: Number(message.exitCode),
              controlledGroupAtExit:
                message.controlledGroupAtExit as CommandPtyRootExit['controlledGroupAtExit'],
              ...(message.signal === undefined
                ? {}
                : { signal: Number(message.signal) }),
            });
          } else if (message.kind === 'group-empty') observeEmpty();
          else if (message.kind === 'command-not-started')
            actualRootExit.reject(Error('actual command was not started'));
          else if (
            message.kind === 'coverage' &&
            message.state === 'unmanaged' &&
            message.reason === 'outside-controlled-group'
          )
            observeCoverage();
          else if (message.kind === 'group-kill-armed') armed = true;
          else if (message.kind === 'failure')
            fail(
              typeof message.reason === 'string'
                ? message.reason
                : 'controlled command failed',
              message.controlUnknown !== false,
            );
          else fail('private command control was out of sequence');
        }
      });
      client.on('error', () => {
        if (authenticated && !empty && !armed)
          fail('private command connection failed');
      });
      client.on('close', () => {
        if (authenticated && !empty && !armed)
          fail(
            'command control closed before controlled-group exit was confirmed',
          );
      });
    });
    const disposeControl = () =>
      (cleanup ??= (async () => {
        for (const client of clients) client.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      })());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, () => {
          server.off('error', reject);
          resolve();
        });
      });
      request.signal.throwIfAborted();
      terminal = await options.terminals.createManagedCommand({
        owner,
        sessionId: owner,
        executionId,
        executionEpoch: options.executionEpoch,
        toolCallId: request.origin.toolCallId,
        displayCommand: request.origin.displayCommand,
        completion,
        cwd: request.cwd,
        launch: {
          file: options.runtimeExecutable,
          args: [options.supervisorPath, path],
        },
        env: { ...request.env, CIRCLE_COMMAND_CONTROL_TOKEN: token },
        outputPath: request.outputPath,
        signal: request.signal,
        stop: (reason) => options.stopExecution(owner, executionId, reason),
      });
      const current = terminal;
      terminalReady.resolve(current);
      group ??= current.snapshot.pid;
      void record();
      void current.exited
        .then(async (exit) => {
          if (controlFailure) {
            await disposeControl();
            return;
          }
          if (empty) {
            if (!rootObserved)
              actualRootExit.reject(
                Error(
                  'actual command exit was not observed before PTY closure',
                ),
              );
            return;
          }
          if (
            armed &&
            exit.signal === 9 &&
            group !== undefined &&
            !(await groupAlive(group))
          ) {
            observeEmpty();
            // The wrapper's signal is not the actual command's wait status. Keep
            // rootExit unconfirmed if its authenticated exit message never arrived.
            if (!rootObserved)
              actualRootExit.reject(
                Error(
                  'actual command exit was not observed before forced group stop',
                ),
              );
            return;
          }
          fail(
            'PTY transport exited without confirmed controlled-group completion',
          );
        })
        .catch(() => fail('PTY command exit could not be verified'));
      const transportAndLogClosed = current.flushed.then(async () => {
        completion.transportAndLogClosed = { observedAt: Date.now() };
        await record();
        await disposeControl();
      });
      void transportAndLogClosed.catch(() => {});
      const stop = () =>
        (stopping ??= (async () => {
          // No persisted/reused PID is signalled: only the still-authenticated
          // supervisor can decide to signal its own original process group.
          if (!startSent) {
            await current.stopTransport();
            observeEmpty();
            actualRootExit.reject(Error('actual command was not started'));
          } else if (!empty) {
            if (!socket || socket.destroyed || controlFailure)
              throw (
                controlFailure ??
                Error(
                  'controlled command connection is unavailable; process state is unknown',
                )
              );
            socket.write(JSON.stringify({ kind: 'stop' }) + '\n');
            await bounded(
              groupEmpty.promise,
              options.stopTimeoutMs ?? 5000,
              'controlled command stop was not confirmed',
            );
          }
          await bounded(
            current.flushed,
            options.stopTimeoutMs ?? 5000,
            'original PTY output closure was not confirmed',
          );
          await stateQueue;
          await disposeControl();
        })());
      let pid: number | undefined;
      try {
        pid = (
          await withSignal(
            bounded(
              started.promise,
              options.readyTimeoutMs ?? 5000,
              'managed command startup was not confirmed',
            ),
            request.signal,
          )
        ).pid;
      } catch (error) {
        if (request.signal.aborted && !startSent) throw error;
        if (!request.signal.aborted) {
          const startupError =
            error instanceof Error
              ? error
              : Error('managed command startup failed');
          fail(startupError.message, false);
          let cleanupConfirmed = false;
          try {
            await stop();
            cleanupConfirmed = !startSent || rootObserved;
          } catch {
            fail('managed startup cleanup was not confirmed');
          }
          // A launcher may reject only after its actually allocated resource is
          // closed. Otherwise return its failed handle for Registry accounting.
          if (cleanupConfirmed) throw startupError;
          fail('actual command exit after failed startup was not confirmed');
        }
      }
      return {
        kind: 'pty-group',
        pid,
        terminal: { id: current.snapshot.id, epoch: current.snapshot.epoch },
        rootExit,
        controlledGroupEmpty: groupEmpty.promise,
        transportAndLogClosed,
        descendantCoverage: {
          snapshot: () => ({
            state: completion.descendantCoverage.state,
            ...(completion.descendantCoverage.reason
              ? { reason: completion.descendantCoverage.reason }
              : {}),
          }),
          subscribe: (changed) => {
            coverageListeners.add(changed);
            return () => coverageListeners.delete(changed);
          },
        },
        stop,
      };
    } catch (error) {
      terminalReady.reject(
        error instanceof Error
          ? error
          : Error('managed transport allocation failed'),
      );
      if (terminal) await terminal.stopTransport();
      await disposeControl();
      if (accepted)
        throw new AggregateError(
          [error],
          'managed startup failed after command acceptance',
        );
      throw error;
    }
  };
}

async function withSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

async function bounded<T>(
  promise: Promise<T>,
  timeout: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error(message)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function groupAlive(group: number): Promise<boolean> {
  const probe = spawn('/bin/ps', ['-A', '-o', 'pgid=,stat='], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  probe.stdout.setEncoding('utf8');
  probe.stdout.on('data', (part) => {
    output += part;
  });
  await bounded(
    new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.once('close', (code) =>
        code === 0
          ? resolve()
          : reject(Error('command-group inspection failed')),
      );
    }),
    2000,
    'command-group inspection timed out',
  ).catch((error) => {
    probe.kill();
    throw error;
  });
  return output.split('\n').some((line) => {
    const [pid, state] = line.trim().split(/\s+/);
    return Number(pid) === group && !state?.startsWith('Z');
  });
}
