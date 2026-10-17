import fs from 'node:fs';
import lockfile from 'proper-lockfile';

export class InputHistoryIoError extends Error {
  readonly code?: string;
  constructor(
    readonly stage: string,
    cause: unknown,
  ) {
    const code = (cause as NodeJS.ErrnoException)?.code;
    super(`input history ${stage} failed${code ? ` (${code})` : ''}`, {
      cause,
    });
    this.name = 'InputHistoryIoError';
    this.code = code;
  }
}
/** Retry only short filesystem sharing conflicts, never corrupt data, missing paths or capacity failures. */
export function historyFileOperation<T>(stage: string, operation: () => T): T {
  const deadline = Date.now() + 250;
  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      const sharing = ['EPERM', 'EACCES', 'EBUSY'].includes(
        String((error as NodeJS.ErrnoException).code),
      );
      if (!sharing || attempt >= 8 || Date.now() >= deadline)
        throw new InputHistoryIoError(stage, error);
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        Math.min(2 ** attempt, 32, Math.max(0, deadline - Date.now())),
      );
    }
  }
}
// proper-lockfile's synchronous adapter calls these methods for both acquisition and
// release. Windows may temporarily deny directory replacement/removal while another
// filesystem observer holds a handle; release needs the same bounded treatment.
const lockFs = { ...fs };
for (const method of [
  'mkdirSync',
  'statSync',
  'utimesSync',
  'rmdirSync',
  'realpathSync',
] as const)
  Object.defineProperty(lockFs, method, {
    value: (...args: unknown[]) =>
      historyFileOperation(`lock ${method.replace('Sync', '')}`, () =>
        Reflect.apply(fs[method], fs, args),
      ),
  });
export function withInputHistoryLock<T>(path: string, operation: () => T): T {
  const deadline = Date.now() + 5000;
  let release: (() => void) | undefined;
  while (!release) {
    try {
      release = lockfile.lockSync(path, {
        fs: lockFs,
        realpath: false,
        stale: 30000,
        update: 5000,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A sharing conflict raised by the lock call itself is as transient as one from
      // the wrapped primitives; those already spent their own bounded retries.
      const sharing =
        !(error instanceof InputHistoryIoError) &&
        ['EPERM', 'EACCES', 'EBUSY'].includes(String(code));
      if ((code !== 'ELOCKED' && !sharing) || Date.now() >= deadline)
        throw error instanceof InputHistoryIoError
          ? error
          : new InputHistoryIoError('lock', error);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    release();
  }
}
