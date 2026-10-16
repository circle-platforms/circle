import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
/** One real local Node process. The fixture implements the same command function
 * for one-shot CLI and IPC; this adapter only replaces process startup overhead. */
export async function startNodeCliFixture(script: string) {
  const child = spawn(process.execPath, [script, '--ipc'], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env },
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const pending = new Map<
    string,
    {
      resolve: (value: string) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => resolve()),
  );
  const fail = (error: Error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  child.on('error', fail);
  child.on('close', () => fail(Error(`fixture process closed: ${stderr}`)));
  child.on('message', (message: any) => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.code === 0) request.resolve(String(message.stdout));
    else
      request.reject(
        Object.assign(
          Error(String(message.stderr || 'fixture command failed')),
          {
            code: message.code,
            stdout: message.stdout,
            stderr: message.stderr,
          },
        ),
      );
  });
  let closePromise: Promise<void> | undefined;
  const close = () =>
    (closePromise ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    })());
  return {
    pid: child.pid,
    get exited() {
      return child.exitCode !== null || child.signalCode !== null;
    },
    call(args: string[], cwd: string): Promise<string> {
      return new Promise((resolve, reject) => {
        if (!child.connected) {
          reject(Error('fixture IPC is closed'));
          return;
        }
        const id = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error('fixture command timed out'));
        }, 120000);
        pending.set(id, { resolve, reject, timer });
        child.send({ id, args, cwd }, (error) => {
          if (error) {
            const request = pending.get(id);
            pending.delete(id);
            clearTimeout(timer);
            request?.reject(error);
          }
        });
      });
    },
    close,
  };
}
