import { setTimeout } from 'node:timers/promises';

// A newly visible native view may not have published its first compositor frame yet, and a
// slow or busy machine, or a window behind others, takes longer: about two seconds in all.
export const CAPTURE_ATTEMPTS = 8;
/** A newly visible native view may not have published its first compositor frame yet. */
export async function captureFrame<T extends { isEmpty(): boolean }>(
  capture: () => Promise<T>,
  pause: (ms: number) => Promise<unknown> = setTimeout,
) {
  const retryErrors: string[] = [];
  for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS; attempt++) {
    try {
      const image = await capture();
      if (image.isEmpty()) throw Error('empty browser frame');
      return { image, attempts: attempt, retryErrors };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/UnknownVizError|^empty browser frame$/.test(message)) throw error;
      retryErrors.push(message);
      if (attempt === CAPTURE_ATTEMPTS)
        throw Error('browser frame unavailable: ' + retryErrors.join('; '), {
          cause: error,
        });
      await pause(Math.min(400, 50 * 2 ** (attempt - 1)));
    }
  }
  throw Error('browser frame unavailable');
}
