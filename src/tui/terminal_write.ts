import type { Readable, Writable } from 'node:stream';

/** How long leaving waits for the terminal to answer what it was asked. */
export const SETTLE_MS = 500;

/**
 * Reads what the terminal still owes before the shell gets it back (the colours asked for at
 * start, for one), which the shell would otherwise take as typed text: asks for the primary
 * device attributes, which a terminal answers after everything asked before, and reads up to
 * that answer or `timeoutMs`. Resolves true when the answer came.
 */
export function settleTerminalInput(
  input: Pick<Readable, 'on' | 'off'>,
  output: { write(text: string): unknown },
  timeoutMs = SETTLE_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let tail = '';
    const finish = (answered: boolean): void => {
      clearTimeout(timer);
      input.off('data', read);
      resolve(answered);
    };
    const read = (data: string | Buffer): void => {
      const text = tail + String(data);
      if (/\x1b\[\?[\d;]*c/.test(text)) finish(true);
      // The answer can come in pieces: keep what may hold its start.
      else tail = text.slice(-64);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    input.on('data', read);
    output.write('\x1b[c');
  });
}

/** Flush stdout, including its asynchronous Windows TTY writes and errors. */
export function flushTerminalWrite(
  output: Writable,
  text: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    const remove = () => output.off('error', failed);
    output.once('error', failed);
    try {
      output.write(text, (error) => {
        if (error) {
          reject(error);
          // Writable also emits error after its failed callback. Keep the
          // listener for that event; an already-destroyed stream may emit none.
          setImmediate(remove);
        } else {
          remove();
          resolve();
        }
      });
    } catch (error) {
      setImmediate(remove);
      reject(error);
    }
  });
}
