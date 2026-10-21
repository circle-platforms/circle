import type { Writable } from 'node:stream';

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
