import { createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  CommandLauncher,
  CommandPtyCompletion,
  CommandPtyRootExit,
} from '../../../../src/command_process.js';
import type { TerminalCommandLauncherOptions } from './command-terminal.ts';
import { loadWindowsJobApi, WindowsCommandJob } from './windows-command-job.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
async function bounded<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** Windows Job membership is explicit and does not upgrade descendant coverage. */
export function createWindowsTerminalCommandLauncher(
  options: TerminalCommandLauncherOptions,
): CommandLauncher {
  return async (request) => {
    request.signal.throwIfAborted();
    const job = new WindowsCommandJob(await loadWindowsJobApi());
    const token = randomUUID(),
      path = `\\\\.\\pipe\\circle-command-${randomUUID()}`;
    const ready = deferred<number>(),
      root = deferred<CommandPtyRootExit>(),
      empty = deferred<void>(),
      failure = deferred<never>();
    const completion: CommandPtyCompletion = {
      kind: 'pty-group',
      descendantCoverage: {
        state: 'unknown',
        reason: 'coverage-unavailable',
        observedAt: Date.now(),
      },
    };
    const clients = new Set<Socket>();
    let client: Socket | undefined,
      terminal:
        | Awaited<
            ReturnType<
              TerminalCommandLauncherOptions['terminals']['createManagedCommand']
            >
          >
        | undefined;
    let initialized = false,
      rootObserved = false,
      rootAcknowledged = false,
      wrapperExited = false,
      finishing = false,
      failed: Error | undefined,
      disposed = false;
    let startedPid: number | undefined,
      queue = Promise.resolve(),
      stopping: Promise<void> | undefined;
    const terminalReady = deferred<NonNullable<typeof terminal>>();
    const record = () => {
      const value = {
        commandPid: startedPid,
        completion: structuredClone(completion),
      };
      queue = queue.then(async () => {
        await (terminal ?? (await terminalReady.promise)).recordState(value);
      });
      void queue.catch(() => fail('Windows command scope persistence failed'));
      return queue;
    };
    const fail = (message: string) => {
      failed ??= Error(message);
      ready.reject(failed);
      failure.reject(failed);
    };
    const send = (value: unknown) => {
      if (!client || client.destroyed)
        throw Error('Windows command private control is unavailable');
      client.write(JSON.stringify(value) + '\n');
    };
    const markEmpty = () => {
      if (completion.controlledGroupEmpty) return;
      completion.controlledGroupEmpty = { observedAt: Date.now() };
      empty.resolve();
      void record();
    };
    const finishControl = async () => {
      if (disposed) return;
      disposed = true;
      for (const socket of clients) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      job.dispose();
    };
    const server = createServer((socket) => {
      clients.add(socket);
      socket.once('close', () => clients.delete(socket));
      let authenticated = false,
        buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (part: string) => {
        buffer += part;
        if (Buffer.byteLength(buffer) > 65536) {
          socket.destroy();
          if (authenticated) fail('Windows command control limit exceeded');
          return;
        }
        for (let index; (index = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          try {
            const message = JSON.parse(line) as Record<string, unknown>;
            if (!authenticated) {
              if (
                client ||
                message.kind !== 'hello' ||
                message.token !== token ||
                !Number.isSafeInteger(message.pid)
              ) {
                socket.destroy();
                return;
              }
              authenticated = true;
              client = socket;
              // Wait for the actual ConPTY identity, never trust a renderer PID.
              void terminalReady.promise
                .then((current) => {
                  if (failed || request.signal.aborted)
                    throw Error(
                      'Windows command cancelled before Job assignment',
                    );
                  job.assignWrapper({
                    pid: current.snapshot.pid!,
                    authenticatedPid: Number(message.pid),
                    executable: options.runtimeExecutable,
                    launchedAfter,
                  });
                  if (failed || request.signal.aborted)
                    throw Error(
                      'Windows command cancelled before command start',
                    );
                  initialized = true;
                  send({
                    kind: 'start',
                    command: request.command,
                    env: request.env,
                  });
                })
                .catch((error) => {
                  fail(
                    error instanceof Error
                      ? error.message
                      : 'Windows command Job assignment failed',
                  );
                });
              continue;
            }
            if (
              message.kind === 'started' &&
              initialized &&
              Number.isSafeInteger(message.pid) &&
              Number(message.pid) > 0
            ) {
              startedPid = Number(message.pid);
              ready.resolve(startedPid);
              void record();
            } else if (
              message.kind === 'root-exit' &&
              initialized &&
              !rootObserved &&
              Number.isInteger(message.exitCode)
            ) {
              const members = job.members();
              rootObserved = true;
              const value: CommandPtyRootExit = {
                exitCode: Number(message.exitCode),
                controlledGroupAtExit: members.some(
                  (id) => id !== terminal!.snapshot.pid,
                )
                  ? 'active'
                  : 'empty',
              };
              completion.rootExit = { ...value, observedAt: Date.now() };
              root.resolve(value);
              void record()
                .then(() => {
                  send({ kind: 'root-exit-ack' });
                  rootAcknowledged = true;
                })
                .catch(() =>
                  fail('Windows actual command exit acknowledgement failed'),
                );
            } else if (message.kind === 'failure')
              fail('Windows command supervisor failed');
            else throw Error('Windows command control was out of sequence');
          } catch (error) {
            fail(
              error instanceof Error
                ? error.message
                : 'Windows command control failed',
            );
          }
        }
      });
      socket.on('error', () => {
        if (authenticated && !finishing)
          fail('Windows command control connection failed');
      });
      socket.on('close', () => {
        if (authenticated && !finishing)
          fail('Windows command control closed before ownership completed');
      });
    });
    const launchedAfter = Date.now();
    let monitor: Promise<void> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, () => {
          server.off('error', reject);
          resolve();
        });
      });
      // Only the trusted supervisor starts before Job assignment. No Node preload.
      const supervisorEnv: NodeJS.ProcessEnv = {
        ...request.env,
        CIRCLE_COMMAND_CONTROL_TOKEN: token,
      };
      for (const key of Object.keys(supervisorEnv))
        if (
          ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(
            key.toUpperCase(),
          )
        )
          delete supervisorEnv[key];
      supervisorEnv.NODE_OPTIONS = '';
      supervisorEnv.NODE_PATH = '';
      terminal = await options.terminals.createManagedCommand({
        owner: request.origin.executionSessionId,
        sessionId: request.origin.executionSessionId,
        executionId: request.executionId,
        executionEpoch: options.executionEpoch,
        toolCallId: request.origin.toolCallId,
        displayCommand: request.origin.displayCommand,
        completion,
        cwd: request.cwd,
        launch: {
          file: options.runtimeExecutable,
          args: [options.supervisorPath, path],
        },
        env: supervisorEnv,
        outputPath: request.outputPath,
        signal: request.signal,
        stop: (reason) =>
          options.stopExecution(
            request.origin.executionSessionId,
            request.executionId,
            reason,
          ),
      });
      terminalReady.resolve(terminal);
      const current = terminal;
      void current.exited
        .then(() => {
          wrapperExited = true;
          if (!rootObserved)
            fail('Windows actual command exit was not observed');
        })
        .catch(() => fail('Windows supervisor exit could not be observed'));
      monitor = (async () => {
        while (!disposed) {
          if (initialized) {
            const members = job.members();
            if (members.length === 0) {
              markEmpty();
              return;
            }
            if (rootAcknowledged && !finishing && job.onlyWrapper()) {
              finishing = true;
              send({ kind: 'finish' });
            }
          }
          await delay(25);
        }
      })();
      void monitor.catch(() =>
        fail('Windows Job membership could not be observed'),
      );
      const io = current.flushed.then(async () => {
        if (!wrapperExited) await current.exited;
        if (initialized) {
          await bounded(
            (async () => {
              while (job.members().length) await delay(25);
            })(),
            options.stopTimeoutMs ?? 5000,
            'Windows Job is not empty after PTY closure',
          );
          markEmpty();
        }
        completion.transportAndLogClosed = { observedAt: Date.now() };
        await record();
        await finishControl();
      });
      void io.catch(() => fail('Windows original PTY/log closure failed'));
      const stop = () =>
        (stopping ??= (async () => {
          if (disposed) return;
          finishing = true;
          if (initialized) {
            if (!rootObserved) {
              try {
                send({ kind: 'stop' });
                await bounded(
                  root.promise,
                  options.stopTimeoutMs ?? 5000,
                  'Windows actual command stop exit was not observed',
                );
                await queue;
              } catch (error) {
                fail(
                  error instanceof Error
                    ? error.message
                    : 'Windows actual command stop exit unknown',
                );
              }
            }
            // Flush the actual fact and ACK even when Stop races an already seen exit.
            try {
              await queue;
            } catch {
              fail('Windows actual command exit persistence failed');
            }
            // Retained Job handle, not process IDs. Failure never fabricates root exit.
            if (!disposed && !completion.controlledGroupEmpty) job.terminate();
            await bounded(
              empty.promise,
              options.stopTimeoutMs ?? 5000,
              'Windows Job termination was not confirmed',
            );
          } else {
            send({ kind: 'abort-before-start' });
          }
          await bounded(
            io,
            options.stopTimeoutMs ?? 5000,
            'Windows original PTY output closure was not confirmed',
          );
          if (failed) throw failed;
        })());
      try {
        const onAbort = () =>
          ready.reject(Error('Windows command startup cancelled'));
        request.signal.addEventListener('abort', onAbort, { once: true });
        try {
          await bounded(
            ready.promise,
            options.readyTimeoutMs ?? 5000,
            'Windows managed command startup was not confirmed',
          );
        } finally {
          request.signal.removeEventListener('abort', onAbort);
        }
      } catch (error) {
        fail(
          error instanceof Error
            ? error.message
            : 'Windows command startup failed',
        );
        if (!initialized) {
          // No command was granted. The fixed supervisor exits itself on control
          // loss/watchdog; never signal a PID whose identity was not authenticated.
          try {
            send({ kind: 'abort-before-start' });
          } catch {}
          try {
            await bounded(
              io,
              options.stopTimeoutMs ?? 5000,
              'unassigned Windows supervisor closure was not confirmed',
            );
            if (wrapperExited) {
              await finishControl();
              throw error;
            }
          } catch (cleanupError) {
            if (disposed && wrapperExited) throw error;
            fail(
              cleanupError instanceof Error
                ? cleanupError.message
                : 'unassigned supervisor state unknown',
            );
          }
        } else {
          try {
            await stop();
          } catch {}
        }
        // Return failed allocated handle: Registry must retain unknown resources.
      }
      return {
        kind: 'pty-group',
        pid: startedPid,
        terminal: { id: current.snapshot.id, epoch: current.snapshot.epoch },
        rootExit: Promise.race([root.promise, failure.promise]),
        controlledGroupEmpty: empty.promise,
        transportAndLogClosed: io,
        descendantCoverage: {
          snapshot: () => ({
            state: 'unknown',
            reason: 'coverage-unavailable',
          }),
          subscribe: () => () => {},
        },
        stop,
      };
    } catch (error) {
      terminalReady.reject(
        error instanceof Error
          ? error
          : Error('Windows managed PTY allocation failed'),
      );
      job.dispose();
      for (const socket of clients) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
  };
}
